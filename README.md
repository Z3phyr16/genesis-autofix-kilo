# /genesis.md: fix Genesis findings with Kilo Code

A Kilo Code workflow that pulls your Genesis findings (except **Passed** and **Ready for Testing**), writes a Playwright test from what QA reported, fixes the code, builds the solution, and runs the test in the real app. Only when the test passes is the finding set to **Ready for Testing**, with a note for QA. It never commits or pushes.

## Setup (once)

**1. Copy into your repo root** (the folder with your `.sln`):

```
YourRepo/
├── .kilocode/workflows/
│   ├── genesis.md           ← /genesis.md
│   └── genesis-verify.md    ← /genesis-verify.md
├── .kilocodeignore          ← hides .env.genesis from Kilo
├── scripts/genesis.mjs      ← talks to Genesis, searches and builds the .sln
├── scripts/verify.mjs       ← runs the Playwright checks
├── qa/login.mjs             ← logs in to your app
├── .env.genesis
└── YourSolution.sln
```

**2. Create `.env.genesis`** from `.env.example`:

```dotenv
GENESIS_TOKEN=your-token
GENESIS_URL=https://genesis.nerp.ph
VERIFY_BASE_URL=https://localhost:7291
VERIFY_START_CMD=dotnet run --project path\to\Web.csproj --no-build
VERIFY_USER=test-account
VERIFY_PASS=...
```

Use a TEST account. If the repo has more than one `.sln`, add `BUILD_CMD=dotnet build "path\to\Main.sln"`.

**3. Playwright:** `npm i -D playwright`, then `npx playwright install chromium`, then edit the 3 selectors in `qa/login.mjs`.

**4. Kilo auto-approve:** in Kilo Code settings → Auto-Approve, enable read/write and add these allowed commands:

```
node scripts/genesis.mjs
node scripts/verify.mjs
```

Do not allow `git`, so Kilo can't commit or push.

**5. `.gitignore`:** `.env.genesis` and `.genesis/` (already included).

## Use

In the Kilo Code chat:

| Type                        | What happens                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `/genesis.md list`          | shows your open findings                                       |
| `/genesis.md fix all`       | fixes them one by one                                          |
| `/genesis.md fix 3739 3740` | fixes these findings                                           |
| `/genesis.md fix all retry` | also retries findings that failed before                       |
| `/genesis-verify.md [ids]`  | re-tests already-fixed findings, never changes code or Genesis |

Leave the app stopped before `fix all` so it starts fresh from the new build.

At the end you get a result table and a commit message per repo. Review the changes and commit yourself.

## Results

| Result                                              | Genesis                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ✅ Fixed and verified                               | Ready for Testing, "Verified automatically with Playwright"                                   |
| ✅ Fixed, no test possible (video only, needs data) | Ready for Testing, "⚠ Not auto-verified"                                                      |
| ❌ Does NOT match / Not fixed                       | status unchanged; reason in `.genesis/<id>/RESULT.md`, screenshots in `.genesis/<id>/verify/` |

The agent can't watch videos. If QA only attaches a video, ask them to add a screenshot or a sentence.

## Re-check without the agent

```powershell
node scripts/verify.mjs                # every finding whose RESULT.md says "Fixed"
node scripts/verify.mjs 7641 7642      # only these
node scripts/verify.mjs --headed 7641  # watch the browser
```

Report: `.genesis/verify-report.md`.
