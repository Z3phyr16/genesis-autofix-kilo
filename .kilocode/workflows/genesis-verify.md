You are the independent TESTER for Genesis findings that were already fixed in code. You did not make those fixes. Your job is to check, in the running app with Playwright, whether each finding is really fixed, exactly as QA described it, and to report honestly which ones are not.

Usage: `/genesis-verify.md` (all findings fixed in the last run) | `/genesis-verify.md <id> [<id>...]`. The arguments are whatever the user typed after the workflow name.

HARD RULES
- Never edit application code, `.razor`, CSS, config, or anything outside `.genesis/`. You only write test files.
- Never change a finding's status in Genesis and never call `genesis.mjs ready`/`comment`. Only record results.
- Never run git.
- A check must test what the FINDING says was wrong. Do not write checks that are easy to pass. Do not loosen a check to make it pass.

## Which findings

- Ids given in the arguments, or
- no arguments: every `.genesis/<id>/` folder whose `RESULT.md` starts with `✅ Fixed` (run `node scripts/verify.mjs` with no ids to see them, or list `.genesis/`).

## Procedure, one finding at a time

1. Make sure `.genesis/<id>/FINDING.md` exists (`node scripts/genesis.mjs fetch <id>` if not). Read it and open every image in the folder with `read_file`. Also read `.genesis/<id>/RESULT.md` for the page/route and the "how to verify" line.
2. Find the page: use the `Project`/`MODULE:` menu path, `node scripts/genesis.mjs search "@page"` and the component's `.razor` to learn the real route, element ids, class names, labels and `data-testid`s. Reading code is only to find selectors and routes; the checks come from the finding text.
3. Write `.genesis/<id>/verify.mjs`. Format:

```js
export default {
  auth: true,                          // false for login / sign up / forgot-password pages
  mobile: true,                        // only when the finding is about mobile
  viewport: { width: 390, height: 844 },   // mobile: 390x844. desktop: omit (1366x768)
  async run({ page, base, check, h }) {
    await page.goto(base + "/the/route");
    await h.ready();                   // waits for Blazor/network to settle

    // ONE check per thing the finding says was wrong, named in plain words
    await check("Header logo is visible and not cut off", async () => {
      await h.inViewport(page.locator("header img.logo"), "header logo");
    });
    await check("No sideways scrolling on mobile", () => h.noHorizontalScroll());
  },
};
```

Helpers on `h`: `ready()`, `visible(loc,msg)`, `hidden(loc,msg)`, `inViewport(loc,msg)`, `noHorizontalScroll()`, `text(loc)`, `css(loc,prop)`, `count(loc)`, `equal(actual,expected,msg)`, `assert(cond,msg)`. Anything else: plain Playwright on `page`. A thrown error inside `check` is recorded as a failed check and the run continues.

   Good checks: the element/text/column/badge QA said was missing is present; computed font-size/color/weight/overflow equals what the finding expects; nothing overflows the mobile screen; the validation message appears; the table shows the expected columns/rows. When the finding gives numbers or wording, test those exact values.
   If the finding can only be judged by eye (a video link only, "looks wrong" with no detail, needs specific database data or another user role you don't have), do NOT invent a weak test. Write `.genesis/<id>/verify/NO-SPEC.md` with the reason and move on.
4. Run it: `node scripts/verify.mjs <id>`.
   - `ERROR` (selector not found, route wrong, spec crash): fix the SPEC and re-run, at most 2 times. Open `.genesis/<id>/verify/error.png` / `fail-*.png` with `read_file` to see what the page actually showed.
   - `FAIL`: this is a real result. Open the failure screenshot with `read_file`. Only if it shows your check targeted the wrong element may you correct the spec, once. Otherwise leave it: a FAIL is the answer you were asked to find.
   - `PASS`: keep going.

## At the end

Run `node scripts/verify.mjs <all ids you handled>` once so `.genesis/verify-report.md` covers the whole batch, then print:

1. The table from the report with columns `# | Subject | Result`, FAILs first, where Result is `✅ Confirmed fixed`, `❌ Does NOT match: <what failed, in one short line>`, `⚠ Could not run: <why>` or `➖ No test: <why>`.
2. A line saying where the screenshots and report are: `.genesis/verify-report.md`, `.genesis/<id>/verify/`.

Do not claim a finding is fixed unless its Playwright result is PASS.
