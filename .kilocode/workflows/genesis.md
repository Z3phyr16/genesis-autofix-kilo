You are working through QA findings from Genesis (our OpenProject tracker at genesis.nerp.ph) and fixing them in THIS solution. The codebase is everything in the `.sln`, not just this git repository: projects, shared libraries and folders under the `.sln` folder count even when they live in a different repo.

Usage: `/genesis.md fix all` | `/genesis.md fix <id> [<id>...]` | `/genesis.md list`. Add `retry` to also retry findings that failed before. The arguments are whatever the user typed after the workflow name.

The Genesis tool is `node scripts/genesis.mjs`. Settings are read from `.env.genesis` automatically. Use ONLY these commands to talk to Genesis:

| Command | What it does |
|---|---|
| `node scripts/genesis.mjs list` | every finding of yours except Passed and Ready for Testing: id, status, project, subject |
| `node scripts/genesis.mjs fetch <id>` | downloads the finding to `.genesis/<id>/`: `FINDING.md` + screenshots |
| `node scripts/genesis.mjs solution` | every project the `.sln` builds, including other repos, with its folder and repo, plus the folders searched |
| `node scripts/genesis.mjs search <regex>` | searches file names and contents across the whole solution, including nested and gitignored repos |
| `node scripts/genesis.mjs build` | builds the solution (the .sln is auto-detected), prints `BUILD OK` or the errors |
| `node scripts/genesis.mjs ready <id> --file .genesis/<id>/RESULT.md` | sets the finding from any status except Passed → Ready for Testing, with RESULT.md as the comment for QA |
| `node scripts/verify.mjs <id>` | opens the running app with Playwright and runs `.genesis/<id>/verify.mjs`; prints Confirmed / Does NOT match / Could not run / No test |

## What to do

- `list` → run `list` and show the result as a table. Stop.
- `fix <id> ...` → do the procedure below for each id given.
- `fix all` (or no arguments) → run `list`, then do the procedure for every finding, one at a time, without stopping to ask. Skip a finding if `.genesis/<id>/RESULT.md` already exists and starts with `NOT FIXED`, unless the arguments contain `retry`.

## Procedure for one finding

1. `node scripts/genesis.mjs fetch <id>`, then read `.genesis/<id>/FINDING.md`. If its status is Passed or Ready for Testing, mark it ⏭ Skipped and move on. If its status is anything other than New, read the `History` section closely: comments may narrow down the problem or say what was already tried, and part of the fix may already be in the code.
2. Open every image in `.genesis/<id>/` with `read_file`. External links (videos, Google Drive) cannot be opened; work from the text and images.
3. Decide whether this finding belongs to this solution. Run `node scripts/genesis.mjs solution`, then look for the code with `node scripts/genesis.mjs search <regex>`. Use it rather than `search_files` or `list_files` to locate code, because those skip gitignored folders and can miss a nested repo. The `Project` line and the `MODULE:` path (e.g. "Analytics > Dashboard", "Master Data > Role > Dashboard Selection") are menu paths in the app; search for those pages, labels, component names and routes (`@page "..."`). Never rule code out because it is in another repo or a shared library. Record NOT FIXED (wrong project) only if several searches with different terms find nothing, and list those terms in RESULT.md.
4. Find the root cause, following the code into any project in the solution. Findings can be:
   - **UI** (layout, fonts, colors, tables): usually the `.razor` markup, its scoped `.razor.css`, or shared styles under `wwwroot/`. Prefer the component's scoped CSS unless the issue is app-wide.
   - **Functional** (missing widgets/data, wrong behaviour, validation, IDs like `B-FUN-…`): trace from the page's `.razor` / `.razor.cs` into the services, view models, APIs or queries it uses.

   Read enough code to understand it before editing.
5. **Write the test BEFORE you edit any code.** From the finding text and screenshots only (not from your planned fix), write `.genesis/<id>/verify.mjs`. It checks what QA said was wrong, so it tests the problem, not your solution. Format:

```js
export default {
  auth: true,                              // false for login / sign up / forgot-password pages
  mobile: true,                            // only when the finding is about mobile
  viewport: { width: 390, height: 844 },   // mobile: 390x844. desktop: omit (1366x768)
  async run({ page, base, check, h }) {
    await page.goto(base + "/the/route");  // the real route, from the @page directive
    await h.ready();                       // waits for Blazor / network to settle

    // ONE check per thing the finding says was wrong, named in plain words
    await check("Header logo is visible and not cut off", async () => {
      await h.inViewport(page.locator("header img.logo"), "header logo");
    });
    await check("No sideways scrolling on mobile", () => h.noHorizontalScroll());
  },
};
```

   Helpers on `h`: `ready()`, `visible(loc,msg)`, `hidden(loc,msg)`, `inViewport(loc,msg)`, `noHorizontalScroll()`, `text(loc)`, `css(loc,prop)`, `count(loc)`, `equal(actual,expected,msg)`, `assert(cond,msg)`. Anything else is plain Playwright on `page`. A throw inside `check` is recorded as a failed check and the run continues. Good checks: the missing element/text/column/badge is present; computed font-size/color/weight equals what the finding expects; nothing overflows the mobile screen; the validation message shows; the table has the expected columns. When the finding gives wording or numbers, test those exact values. Use the real routes, ids and classes you found in the `.razor` files. If the finding can only be judged by eye (video only, vague, or it needs database data or a user role you don't have), don't invent a weak test: write `.genesis/<id>/verify/NO-SPEC.md` with the reason.
6. Make the smallest correct fix that follows the existing conventions of the codebase. Don't refactor or touch unrelated code, don't add packages, never run git, and never edit the user's other uncommitted work. If the file you need to edit isn't inside a project listed by `solution`, the build can't confirm the change and the app may be using a packaged copy: don't edit it, and record NOT FIXED with the file and the change it needs.
7. Run `node scripts/genesis.mjs build`. If it fails because of your change, fix it (at most 3 attempts). If it still fails, undo all your edits for this finding and record NOT FIXED (build).
8. Run `node scripts/verify.mjs <id>` (it starts the app by itself from the fresh build, if the app isn't already running; if it says the app is unreachable, stop and tell the user). Then:
   - `Confirmed` → continue.
   - `Could not run` because of the test (wrong route, selector not found, spec crash): open `.genesis/<id>/verify/error.png` with `read_file`, fix the TEST and re-run, at most 2 times. Never loosen a check just to get a pass.
   - `Does NOT match`: open `.genesis/<id>/verify/fail-*.png` with `read_file`. If the page really still shows the problem, improve the fix (steps 6 to 8, at most 2 more attempts). If the screenshot shows your check looked at the wrong element, correct the test once. If it still does not match, record `NOT VERIFIED: <failed check>` as the first line of RESULT.md and do NOT mark it Ready; leave the code as it is so the user can look at it.
   - `No test` (you wrote NO-SPEC.md): continue, but the RESULT.md comment must say `⚠ Not auto-verified: <reason>` so QA knows to check it by hand.
9. Write `.genesis/<id>/RESULT.md`:
   - **If fixed and Confirmed**, it is the comment QA will see, so write it for a tester in 2–6 short lines: what was wrong, what changed (files), how to verify. Start with `✅ Fixed:` and end with `Verified automatically with Playwright.`
   - **If fixed but not auto-verifiable**, same, but start with `✅ Fixed (⚠ not auto-verified):`.
   - **If not fixed or not verified**, the first line is `NOT FIXED: <reason>` or `NOT VERIFIED: <failed check>`, plus what a developer would need.
10. **Only if the build passed AND the result is Confirmed (or No test):** `node scripts/genesis.mjs ready <id> --file .genesis/<id>/RESULT.md`. Never change the status of a finding that is NOT FIXED or NOT VERIFIED; it keeps its current status.

Be honest: if you aren't confident the change actually fixes what QA reported, treat it as NOT FIXED rather than marking it ready. Never write a test that is easy to pass, and never mark a finding ready when its Playwright result is `Does NOT match`.

## At the end

Print a summary table: `#id | subject | Result`, with the findings that did NOT hold up listed first. Result is one of: `✅ Fixed and verified → Ready for Testing`, `✅ Fixed (⚠ not auto-verified) → Ready for Testing`, `❌ Does NOT match: <failed check>`, `❌ Not fixed (reason)`, `⏭ Skipped`. If a status change fails (for example 422), say so on that row. Screenshots are in `.genesis/<id>/verify/`.

Then print a commit message in a code block, with one line for every finding fixed in this run, saying what was actually changed. List only findings that are Fixed and verified (or fixed, not auto-verifiable), never the ones that did not match, and don't add a `Co-Authored-By` line or any other attribution. If nothing was fixed, say so instead of printing a message.

```
fix: resolve Genesis QA findings

- #<id> <subject>: <what was fixed>
- #<id> <subject>: <what was fixed>
```

If the fixes touch more than one repo (see the `repo:` column of `solution`), print one commit message per repo, each labelled with the repo's folder and listing only that repo's fixes.

For findings that did NOT match, also list the files that were changed for them, so the user can review or revert those edits before committing.

Then remind the user that the changes are uncommitted: they should run the app, check the fixed pages, and commit using that message in each repo that changed.
