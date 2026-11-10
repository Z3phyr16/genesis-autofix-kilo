#!/usr/bin/env node
/**
 * genesis.mjs — tiny client for Genesis (OpenProject API v3).
 * No dependencies; needs Node 18+.
 *
 * Env:
 *   GENESIS_URL      default https://genesis.nerp.ph
 *   GENESIS_TOKEN    API token (My account → Access tokens)   [required]
 *
 * It works on every finding assigned to you except "Passed" and "Ready for Testing". The
 * only status change it can ever make is from any other status to "Ready for Testing"
 * (when you run `ready`).
 *
 * Settings are read from .env.genesis in the repo root (or the environment).
 *
 * Commands (used by Kilo Code via /genesis.md, or by you):
 *   list                         → your findings in every project, except Passed and Ready for Testing
 *   poll                         → same, as JSON
 *   fetch <id> [outDir]          → writes <outDir>/<id>/FINDING.md + screenshots (default .genesis)
 *   solution                     → every project the .sln builds (even from other repos) and the folders searched
 *   search <regex>               → case-insensitive search of file names and contents across the whole solution
 *   build                        → auto-detects the .sln and runs dotnet build (BUILD_CMD overrides)
 *   ready <id> [--file f | "comment"]  → any status except Passed → "Ready for Testing" + comment for QA
 *   comment <id> [--file f | "text"]   → adds a comment only
 *   projects / statuses          → list Genesis projects / statuses
 */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// Load .env.genesis (doesn't override variables already set)
for (const file of [path.join(process.cwd(), ".env.genesis"), path.join(ROOT, ".env.genesis")]) {
  if (!fss.existsSync(file)) continue;
  for (const line of fss.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  break;
}

const BASE = (process.env.GENESIS_URL || "https://genesis.nerp.ph").replace(/\/$/, "");
const TOKEN = process.env.GENESIS_TOKEN;
const READY = "Ready for Testing";
const EXCLUDED = ["Passed", READY];

const [cmd, ...args] = process.argv.slice(2);
const OFFLINE = ["build", "solution", "search"].includes(cmd);

if (!TOKEN && !OFFLINE) {
  console.error("GENESIS_TOKEN is not set. Create one in Genesis: My account → Access tokens → API.");
  process.exit(2);
}

const AUTH = "Basic " + Buffer.from(`apikey:${TOKEN}`).toString("base64");

async function api(urlPath, { method = "GET", body, raw = false } = {}) {
  const url = urlPath.startsWith("http") ? urlPath : BASE + urlPath;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
      Accept: "application/hal+json, application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${url} → ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  }
  return raw ? res : res.json();
}

async function getStatuses() {
  const data = await api("/api/v3/statuses");
  return data._embedded.elements.map((s) => ({ id: s.id, name: s.name, href: s._links.self.href }));
}

async function findStatus(name) {
  const all = await getStatuses();
  const hit = all.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`Unknown status "${name}". Available: ${all.map((s) => s.name).join(", ")}`);
  return hit;
}

const isExcluded = (name) => EXCLUDED.some((n) => n.toLowerCase() === name.toLowerCase());

// Findings assigned to you, across all projects: every one except EXCLUDED. Genesis returns results in pages.
async function findFindings() {
  const statuses = await getStatuses();
  const excluded = statuses.filter((s) => isExcluded(s.name));
  const missing = EXCLUDED.filter((n) => !excluded.some((s) => s.name.toLowerCase() === n.toLowerCase()));
  if (missing.length) throw new Error(`Status "${missing.join('", "')}" not found. Available: ${statuses.map((s) => s.name).join(", ")}`);

  const filters = [
    { assignee: { operator: "=", values: ["me"] } },
    { status: { operator: "!", values: excluded.map((s) => String(s.id)) } },
  ];
  const found = [];
  for (let offset = 1; ; offset++) {
    const qs = new URLSearchParams({ filters: JSON.stringify(filters), pageSize: "100", offset: String(offset), sortBy: JSON.stringify([["id", "asc"]]) });
    const data = await api(`/api/v3/work_packages?${qs}`);
    const page = data._embedded.elements;
    found.push(...page);
    if (!page.length || found.length >= data.total) return found;
  }
}

async function poll() {
  const out = (await findFindings()).map((wp) => ({
    id: wp.id,
    subject: wp.subject,
    status: wp._links.status?.title,
    project: wp._links.project?.title,
    updatedAt: wp.updatedAt,
  }));
  console.log(JSON.stringify(out, null, 2));
}

async function listProjects() {
  const all = (await api(`/api/v3/projects?${new URLSearchParams({ pageSize: "500" })}`))._embedded.elements;
  console.log(all.map((p) => `${p.id}\t${p.name}`).join("\n"));
}

// Description comes as markdown mixed with HTML — make it plain readable text
function cleanText(raw = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, "[image: $1]")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeName(name) {
  return name.replace(/[^\w.\-]+/g, "_");
}

async function fetchFinding(id, outDir = ".genesis") {
  const wp = await api(`/api/v3/work_packages/${id}`);
  const dir = path.join(outDir, String(id));
  await fs.mkdir(dir, { recursive: true });

  const description = cleanText(wp.description?.raw || "");

  // Screenshots / attachments (+ any images pasted into the description)
  const att = await api(`/api/v3/work_packages/${id}/attachments`);
  const list = (att._embedded?.elements || []).map((a) => ({
    id: a.id, name: a.fileName || "file", created: a.createdAt,
    href: a._links?.downloadLocation?.href || `/api/v3/attachments/${a.id}/content`,
  }));
  for (const m of (wp.description?.raw || "").matchAll(/\/api\/v3\/attachments\/(\d+)\/content/g)) {
    if (!list.some((a) => String(a.id) === m[1])) list.push({ id: m[1], name: "inline.png", created: "", href: m[0] });
  }
  const files = [];
  for (const a of list) {
    try {
      const res = await api(a.href, { raw: true });
      const fname = `${a.id}_${safeName(a.name)}`;
      await fs.writeFile(path.join(dir, fname), Buffer.from(await res.arrayBuffer()));
      files.push({ file: fname, created: a.created });
    } catch (e) {
      console.error(`warning: couldn't download attachment ${a.id}: ${e.message.split("\n")[0]}`);
    }
  }

  // Links the agent can't open (videos, Google Drive, etc.)
  const links = [...description.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0])
    .filter((u) => !u.startsWith(BASE));

  // Comments / status history (QA feedback lives here)
  const acts = await api(`/api/v3/work_packages/${id}/activities`);
  const history = (acts._embedded?.elements || [])
    .map((a) => {
      const changes = (a.details || []).map((d) => d.raw).filter((r) => /^Status|^Assignee/.test(r));
      const comment = a.comment?.raw?.trim();
      if (!changes.length && !comment) return null;
      return `- ${a.createdAt.slice(0, 10)}: ${[...changes, comment ? `Comment: ${comment}` : ""].filter(Boolean).join("; ")}`;
    })
    .filter(Boolean);

  const md = `# Genesis #${wp.id} — ${wp.subject}

- Status: ${wp._links.status?.title ?? "?"}
- Type: ${wp._links.type?.title ?? "?"}
- Project: ${wp._links.project?.title ?? "?"}
- Priority: ${wp._links.priority?.title ?? "?"}
- Link: ${BASE}/work_packages/${wp.id}

## Description

${description || "(no description)"}

## Screenshots / attachments (in this folder)

${files.length ? files.map((f) => `- ${f.file}${f.created ? ` (added ${f.created.slice(0, 10)})` : ""}`).join("\n") : "(none)"}
${links.length ? `
## External links (videos / drives — NOT viewable, rely on the text above)

${links.map((u) => `- ${u}`).join("\n")}
` : ""}
## History

${history.join("\n") || "(none)"}
`;
  await fs.writeFile(path.join(dir, "FINDING.md"), md);
  console.log(dir);
}

async function markReady(id, comment) {
  const status = await findStatus(READY);
  const wp = await api(`/api/v3/work_packages/${id}`); // fresh lockVersion
  const current = wp._links.status?.title ?? "";
  if (current.toLowerCase() === READY.toLowerCase()) { console.log(`#${id}: already ${READY}`); return; }
  if (isExcluded(current)) throw new Error(`#${id} is "${current}" — not changing it.`);
  await api(`/api/v3/work_packages/${id}`, {
    method: "PATCH",
    body: { lockVersion: wp.lockVersion, _links: { status: { href: status.href } } },
  });
  console.log(`#${id}: ${wp._links.status?.title} → ${status.name}`);
  if (comment) await addComment(id, comment);
}

async function addComment(id, text) {
  await api(`/api/v3/work_packages/${id}/activities`, {
    method: "POST",
    body: { comment: { raw: text } },
  });
  console.log(`#${id}: comment added`);
}

// ---------- solution ----------
const SKIP_DIR = /^(\.|bin$|obj$|node_modules$|packages$)/i;
const isSln = (name) => /\.slnx?$/i.test(name);

function findFiles(dir, test, depth) {
  const out = [];
  let entries = [];
  try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isFile() && test(e.name)) out.push(path.join(dir, e.name));
  if (out.length || depth === 0) return out;
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIR.test(e.name)) out.push(...findFiles(path.join(dir, e.name), test, depth - 1));
  }
  return out;
}

// BUILD_CMD's .sln if it names one, else any .sln below this folder, else the nearest one above it
function findSolutions() {
  const named = process.env.BUILD_CMD?.match(/"([^"]+\.slnx?)"|([^\s"]+\.slnx?)/i);
  if (named) return [path.resolve(ROOT, named[1] || named[2])];
  const below = findFiles(ROOT, isSln, 3);
  if (below.length) return below;
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const here = findFiles(dir, isSln, 0);
    if (here.length) return here;
    if (dir === path.dirname(dir)) return [];
  }
}

const resolveFrom = (file, rel) => path.resolve(path.dirname(file), rel.replace(/\\/g, "/"));

// Projects listed in the solutions, plus everything they reference through <ProjectReference>
function solutionProjects(slns) {
  const queue = [];
  for (const sln of slns) {
    const text = fss.readFileSync(sln, "utf8");
    const listed = [
      ...text.matchAll(/^\s*Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm),
      ...text.matchAll(/<Project\s[^>]*Path="([^"]+)"/g),
    ];
    for (const m of listed) if (/\.\w*proj$/i.test(m[1])) queue.push(resolveFrom(sln, m[1]));
  }
  const seen = new Set();
  while (queue.length) {
    const project = queue.shift();
    if (seen.has(project)) continue;
    seen.add(project);
    let text = "";
    try { text = fss.readFileSync(project, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/<ProjectReference\s[^>]*Include="([^"]+)"/g)) {
      if (!m[1].includes("$(")) queue.push(resolveFrom(project, m[1]));
    }
  }
  return [...seen];
}

function repoOf(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fss.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === path.dirname(dir)) return "(no git repo)";
  }
}

// The .sln folders, this folder, and any project folder outside them
function searchRoots(slns, projects) {
  const dirs = [...new Set([ROOT, ...[...slns, ...projects].map((f) => path.dirname(f))])];
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  return dirs.filter((d) => !dirs.some((other) => inside(other, d)));
}

function solution() {
  const slns = findSolutions();
  const projects = solutionProjects(slns);
  console.log(`Solution: ${slns.join(", ") || "(none found)"}`);
  console.log(`\nSearched folders:\n${searchRoots(slns, projects).map((d) => `  ${d}`).join("\n")}`);
  console.log(`\nProjects (${projects.length}):`);
  for (const p of projects) {
    console.log(`  ${path.basename(p)}\t${path.dirname(p)}\trepo: ${repoOf(p)}${fss.existsSync(p) ? "" : "\tMISSING ON DISK"}`);
  }
}

function* walk(dir) {
  let entries = [];
  try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // also keeps .env.genesis out of the results
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) yield* walk(full); }
    else if (e.isFile()) yield full;
  }
}

// Unlike Grep and Glob, this ignores .gitignore, so nested and ignored repos are included
function search(pattern) {
  if (!pattern) { console.error("Usage: genesis.mjs search <regex>"); return 1; }
  const re = new RegExp(pattern, "i");
  const slns = findSolutions();
  const roots = searchRoots(slns, solutionProjects(slns));
  const MAX = 200;
  let hits = 0;
  console.log(`Searching: ${roots.join(", ")}`);
  for (const root of roots) {
    for (const file of walk(root)) {
      const name = path.basename(file);
      if (/\.min\.|\.map$/i.test(name)) continue;
      const found = [];
      if (re.test(name)) found.push(`${file}  (file name)`);
      let buf = Buffer.alloc(0);
      try { if (fss.statSync(file).size <= 1024 * 1024) buf = fss.readFileSync(file); } catch { /* unreadable: skip */ }
      if (!buf.includes(0)) {
        buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
          if (re.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      for (const line of found) {
        console.log(line);
        if (++hits >= MAX) { console.log(`Stopped at ${MAX} matches; use a narrower pattern.`); return 0; }
      }
    }
  }
  console.log(hits ? `\n${hits} match(es).` : "No matches.");
  return 0;
}

// ---------- build ----------
function build() {
  let cmdline = process.env.BUILD_CMD;
  if (cmdline === undefined) {
    const slns = findSolutions();
    if (slns.length > 1) {
      console.error(`Several solutions found — add BUILD_CMD to .env.genesis, e.g. BUILD_CMD=dotnet build "${path.relative(ROOT, slns[0])}"\n${slns.map((s) => "  " + path.relative(ROOT, s)).join("\n")}`);
      return 1;
    }
    cmdline = slns.length ? `dotnet build "${slns[0]}" --nologo -v q` : "";
  }
  if (!cmdline) { console.log("No .sln found and no BUILD_CMD set — nothing to build."); return 0; }
  console.log(`> ${cmdline}`);
  const r = spawnSync(cmdline, { shell: true, cwd: ROOT, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split(/\r?\n/);
  if (r.status === 0) { console.log("BUILD OK"); return 0; }
  const errors = out.filter((l) => /\berror\b/i.test(l));
  console.log((errors.length ? [...new Set(errors)].slice(0, 40) : out.slice(-60)).join("\n"));
  console.log("BUILD FAILED");
  return 1;
}

// "--file path" lets the agent pass a long multi-line comment without shell-quoting problems
function textArg(rest, fallback) {
  const i = rest.indexOf("--file");
  if (i !== -1) return fss.readFileSync(rest[i + 1], "utf8").trim();
  return rest.join(" ").trim() || fallback;
}

async function list() {
  const els = await findFindings();
  if (!els.length) { console.log("No matching findings assigned to you."); return; }
  console.log(els.map((wp) => `#${wp.id}\t${wp._links.status?.title}\t[${wp._links.project?.title}]\t${wp.subject}`).join("\n"));
  console.log(`\n${els.length} finding(s).`);
}

try {
  switch (cmd) {
    case "list": await list(); break;
    case "poll": await poll(); break;
    case "fetch": await fetchFinding(args[0], args[1]); break;
    case "ready": await markReady(args[0], textArg(args.slice(1), "✅ Fixed, ready for QA retest.")); break;
    case "comment": await addComment(args[0], textArg(args.slice(1), "")); break;
    case "solution": solution(); break;
    case "search": process.exitCode = search(args.join(" ")); break;
    case "build": process.exitCode = build(); break;
    case "statuses": console.log(JSON.stringify(await getStatuses(), null, 2)); break;
    case "projects": await listProjects(); break;
    default:
      console.error("Usage: genesis.mjs list | fetch <id> | solution | search <regex> | build | ready <id> [--file f | text] | comment <id> [--file f | text] | projects | statuses");
      process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
