#!/usr/bin/env node
/**
 * verify.mjs — runs one Playwright check-file per Genesis finding and reports which fixes
 * really hold up in the running app. It NEVER changes a finding's status in Genesis and
 * never touches your code: it only records results.
 *
 * Usage:
 *   node scripts/verify.mjs                 → every finding whose .genesis/<id>/RESULT.md starts with "✅ Fixed"
 *   node scripts/verify.mjs 7641 7642       → only these findings
 *   node scripts/verify.mjs --headed 7641   → watch the browser
 *
 * Per finding it looks for  .genesis/<id>/verify.mjs  (written by Kilo via /genesis.md or /genesis-verify.md).
 *
 * Settings (.env.genesis):
 *   VERIFY_BASE_URL     default https://localhost:7291
 *   VERIFY_START_CMD    optional, e.g.  dotnet run --project src/Web/Web.csproj --no-build
 *                       (started only if the app isn't already running, stopped at the end)
 *   VERIFY_USER / VERIFY_PASS   test account used by qa/login.mjs
 *
 * Needs:  npm i -D playwright   and   npx playwright install chromium
 *
 * Results: console + .genesis/verify-report.md + .genesis/verify-report.json
 *          screenshots in .genesis/<id>/verify/
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GEN = path.join(ROOT, ".genesis");

// ---- settings from .env.genesis (same rules as genesis.mjs) ----
for (const file of [path.join(process.cwd(), ".env.genesis"), path.join(ROOT, ".env.genesis")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  break;
}
const BASE = (process.env.VERIFY_BASE_URL || "https://localhost:7291").replace(/\/$/, "");
const START = process.env.VERIFY_START_CMD || "";
const CHECK_TIMEOUT = 10_000;
const SPEC_TIMEOUT = 90_000;

// ---- args ----
const args = process.argv.slice(2);
const headed = args.includes("--headed");
let ids = args.filter((a) => !a.startsWith("--")).flatMap((a) => a.split(",")).map((a) => a.replace("#", "").trim()).filter(Boolean);
if (!ids.length) ids = fixedIds();

function fixedIds() {
  if (!fs.existsSync(GEN)) return [];
  return fs.readdirSync(GEN, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .filter((e) => {
      try { return /^\s*✅\s*Fixed/.test(fs.readFileSync(path.join(GEN, e.name, "RESULT.md"), "utf8")); } catch { return false; }
    })
    .map((e) => e.name)
    .sort((a, b) => a - b);
}

function meta(id) {
  const dir = path.join(GEN, id);
  let subject = "(no FINDING.md — run: node scripts/genesis.mjs fetch " + id + ")";
  let code = "";
  try { subject = fs.readFileSync(path.join(dir, "FINDING.md"), "utf8").split(/\r?\n/)[0].replace(/^#\s*Genesis\s*#\d+\s*[—-]\s*/, ""); } catch {}
  try { code = fs.readFileSync(path.join(dir, "RESULT.md"), "utf8").split(/\r?\n/)[0].slice(0, 60); } catch {}
  return { subject, code };
}

// ---- app lifecycle ----
function reachable() {
  return new Promise((resolve) => {
    const lib = BASE.startsWith("https") ? https : http;
    const req = lib.request(BASE, { method: "GET", rejectUnauthorized: false, timeout: 4000 }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

let appProc = null;
async function ensureApp() {
  if (await reachable()) return;
  if (!START) throw new Error(`The app isn't reachable at ${BASE}. Start it first, or set VERIFY_START_CMD (and VERIFY_BASE_URL) in .env.genesis.`);
  console.log(`Starting app: ${START}`);
  appProc = spawn(START, { shell: true, cwd: ROOT, stdio: "ignore", detached: process.platform !== "win32" });
  for (let i = 0; i < 90; i++) {
    if (await reachable()) { console.log(`App is up at ${BASE}`); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`App did not come up at ${BASE} within 3 minutes.`);
}
function stopApp() {
  if (!appProc?.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(appProc.pid), "/T", "/F"]);
    else process.kill(-appProc.pid);
  } catch {}
}

// ---- helpers handed to every spec ----
function makeHelpers(page) {
  const h = {
    assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); },
    equal(actual, expected, msg) {
      if (actual !== expected) throw new Error(`${msg || "values differ"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    /** Blazor-friendly "page is ready": network quiet and no reconnect banner. */
    async ready() {
      await page.waitForLoadState("load");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForFunction(() => !document.querySelector("#components-reconnect-modal.components-reconnect-show, .components-reconnect-show"), null, { timeout: CHECK_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(300);
    },
    async visible(locator, msg) {
      const n = await locator.count();
      h.assert(n > 0, `${msg || "element"} not found`);
      h.assert(await locator.first().isVisible(), `${msg || "element"} exists but is not visible`);
    },
    async hidden(locator, msg) {
      h.assert(!(await locator.count()) || !(await locator.first().isVisible()), `${msg || "element"} should not be visible`);
    },
    async text(locator) { return ((await locator.first().innerText()) || "").trim(); },
    async css(locator, prop) { return locator.first().evaluate((el, p) => getComputedStyle(el)[p], prop); },
    /** true page-wide sideways scrolling is the classic mobile-layout bug */
    async noHorizontalScroll(msg) {
      // compare with the configured screen width: on emulated phones window.innerWidth grows with the content
      const iw = page.viewportSize().width;
      const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
      h.assert(sw <= iw + 1, `${msg || "page scrolls sideways"} (content ${sw}px wide, screen ${iw}px)`);
    },
    /** element fully inside the screen width (not cut off) */
    async inViewport(locator, msg) {
      await h.visible(locator, msg);
      const b = await locator.first().boundingBox();
      const iw = page.viewportSize().width;
      h.assert(b && b.x >= -1 && b.x + b.width <= iw + 1, `${msg || "element"} is cut off (x=${Math.round(b?.x)}, width=${Math.round(b?.width)}, screen=${iw})`);
    },
    async count(locator) { return locator.count(); },
  };
  return h;
}

// ---- login, once per run ----
let authPromise = null;
function getAuthState(browser) {
  authPromise ??= (async () => {
    const loginFile = path.join(ROOT, "qa", "login.mjs");
    if (!fs.existsSync(loginFile)) throw new Error("qa/login.mjs is missing");
    const { login } = await import(pathToFileURL(loginFile).href);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    try {
      await login(page, BASE, { user: process.env.VERIFY_USER, pass: process.env.VERIFY_PASS });
      const file = path.join(GEN, "auth.json");
      await ctx.storageState({ path: file });
      return file;
    } finally { await ctx.close(); }
  })();
  return authPromise;
}

// ---- run one finding ----
async function runOne(browser, id) {
  const dir = path.join(GEN, id);
  const out = path.join(dir, "verify");
  for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f !== "NO-SPEC.md") fs.rmSync(path.join(out, f), { force: true });
  fs.mkdirSync(out, { recursive: true });
  const m = meta(id);
  const base = { id, subject: m.subject, code: m.code, checks: [], evidence: [], notes: [] };

  const specFile = path.join(dir, "verify.mjs");
  if (!fs.existsSync(specFile)) {
    let why = "no verify.mjs for this finding (run /genesis-verify)";
    try { why = fs.readFileSync(path.join(dir, "verify", "NO-SPEC.md"), "utf8").trim().split(/\r?\n/).slice(0, 2).join(" ").slice(0, 200) || why; } catch {}
    return { ...base, verdict: "NO_SPEC", detail: why };
  }

  let spec;
  try { spec = (await import(pathToFileURL(specFile).href + "?t=" + Date.now())).default; }
  catch (e) { return { ...base, verdict: "ERROR", detail: "verify.mjs doesn't load: " + firstLine(e.message) }; }
  if (!spec || typeof spec.run !== "function") return { ...base, verdict: "ERROR", detail: "verify.mjs must export default { run(ctx) {...} }" };

  let ctx, page;
  try {
    const needsAuth = spec.auth !== false;
    const storageState = needsAuth ? await getAuthState(browser) : undefined;
    ctx = await browser.newContext({
      viewport: spec.viewport || { width: 1366, height: 768 },
      isMobile: !!spec.mobile, hasTouch: !!spec.mobile,
      ignoreHTTPSErrors: true, storageState,
    });
    page = await ctx.newPage();
    page.setDefaultTimeout(CHECK_TIMEOUT);

    const consoleErrors = [], failedRequests = [];
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 160)); });
    page.on("response", (r) => { if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.url().slice(0, 100)}`); });

    const h = makeHelpers(page);
    let shot = 0;
    const check = async (name, fn) => {
      try { await fn(); base.checks.push({ name, ok: true }); }
      catch (e) {
        const file = path.join(out, `fail-${++shot}.png`);
        await page.screenshot({ path: file, fullPage: true }).catch(() => {});
        base.checks.push({ name, ok: false, error: firstLine(e.message), shot: path.relative(ROOT, file) });
      }
    };

    let timer;
    await Promise.race([
      spec.run({ page, base: BASE, check, h }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`spec took longer than ${SPEC_TIMEOUT / 1000}s`)), SPEC_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));

    const after = path.join(out, "after.png");
    await page.screenshot({ path: after, fullPage: true }).catch(() => {});
    base.evidence.push(path.relative(ROOT, after));
    if (consoleErrors.length) base.notes.push(`${consoleErrors.length} console error(s), e.g. ${consoleErrors[0]}`);
    if (failedRequests.length) base.notes.push(`${failedRequests.length} server error response(s), e.g. ${failedRequests[0]}`);
  } catch (e) {
    if (page) await page.screenshot({ path: path.join(out, "error.png"), fullPage: true }).catch(() => {});
    return { ...base, verdict: "ERROR", detail: "Could not run: " + firstLine(e.message) };
  } finally { await ctx?.close(); }

  if (!base.checks.length) return { ...base, verdict: "ERROR", detail: "The spec ran but made no checks, so it proves nothing" };
  const failed = base.checks.filter((c) => !c.ok);
  return failed.length
    ? { ...base, verdict: "FAIL", detail: failed.map((c) => `${c.name} → ${c.error}`).join(" | ") }
    : { ...base, verdict: "PASS", detail: `${base.checks.length} check(s) passed` };
}

const firstLine = (s = "") => String(s).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300) ?? "";

// ---- report ----
const ICON = { PASS: "✅ Confirmed", FAIL: "❌ Does NOT match", ERROR: "⚠ Could not run", NO_SPEC: "➖ No test" };

function report(results) {
  const by = (v) => results.filter((r) => r.verdict === v);
  const lines = [];
  const stamp = new Date().toLocaleString();
  lines.push(`# Genesis fix verification — ${stamp}`, "", `App: ${BASE}`, "");
  lines.push(`**${by("PASS").length} confirmed · ${by("FAIL").length} do not match · ${by("ERROR").length} could not run · ${by("NO_SPEC").length} no test**`, "");
  lines.push("| # | Subject | Code fix | Playwright | Details |", "|---|---|---|---|---|");
  for (const r of [...by("FAIL"), ...by("ERROR"), ...by("PASS"), ...by("NO_SPEC")]) {
    lines.push(`| ${r.id} | ${r.subject} | ${r.code || "-"} | ${ICON[r.verdict]} | ${(r.detail || "").replace(/\|/g, "\\|")} |`);
  }
  for (const r of by("FAIL")) {
    lines.push("", `### ❌ #${r.id} ${r.subject}`);
    for (const c of r.checks) lines.push(`- ${c.ok ? "✅" : "❌"} ${c.name}${c.ok ? "" : ` — ${c.error}  (screenshot: ${c.shot})`}`);
  }
  const notes = results.filter((r) => r.notes?.length);
  if (notes.length) { lines.push("", "### Heads-up (not failures)"); for (const r of notes) lines.push(`- #${r.id}: ${r.notes.join("; ")}`); }
  fs.writeFileSync(path.join(GEN, "verify-report.md"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(GEN, "verify-report.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
}

function printSummary(results) {
  const by = (v) => results.filter((r) => r.verdict === v);
  const show = (title, list, withDetail) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})`);
    for (const r of list) {
      console.log(`  #${r.id}  ${r.subject}`);
      if (withDetail) for (const c of r.checks.filter((c) => !c.ok)) console.log(`        ✗ ${c.name} — ${c.error}`);
      if (withDetail && r.verdict !== "FAIL") console.log(`        ${r.detail}`);
    }
  };
  console.log("\n================ VERIFICATION RESULT ================");
  show("❌ DOES NOT MATCH THE FIX — look at these", by("FAIL"), true);
  show("⚠ COULD NOT RUN — spec or app problem", by("ERROR"), true);
  show("➖ NO TEST WRITTEN", by("NO_SPEC"), false);
  show("✅ CONFIRMED FIXED", by("PASS"), false);
  console.log(`\nReport: ${path.relative(process.cwd(), path.join(GEN, "verify-report.md"))}`);
}

// ---- main ----
async function main() {
  if (!ids.length) { console.log("Nothing to verify. No .genesis/<id>/RESULT.md starting with '✅ Fixed' was found; pass ids: node scripts/verify.mjs 7641 7642"); return 0; }
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("Playwright isn't installed. Run:  npm i -D playwright  &&  npx playwright install chromium"); return 2; }

  await ensureApp();
  const browser = await chromium.launch({ headless: !headed });
  const results = [];
  try {
    for (const id of ids) {
      process.stdout.write(`#${id} ... `);
      const r = await runOne(browser, id);
      console.log(ICON[r.verdict]);
      results.push(r);
      try { fs.writeFileSync(path.join(GEN, id, "verify", "result.json"), JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2)); } catch {}
    }
  } finally { await browser.close(); }

  fs.mkdirSync(GEN, { recursive: true });
  report(results);
  printSummary(results);
  return results.every((r) => r.verdict === "PASS") ? 0 : 1;
}

main().then((c) => { stopApp(); process.exit(c); }).catch((e) => { console.error(e.message); stopApp(); process.exit(2); });
process.on("SIGINT", () => { stopApp(); process.exit(130); });
