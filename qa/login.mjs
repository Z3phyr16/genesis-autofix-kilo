// Edit this ONE file so it logs in to YOUR app. verify.mjs calls it once per run
// and reuses the session for every finding that needs a signed-in user.
//
// `page` is a Playwright page, `base` is VERIFY_BASE_URL,
// user/pass come from VERIFY_USER / VERIFY_PASS in .env.genesis.
export async function login(page, base, { user, pass }) {
  if (!user || !pass) throw new Error("Set VERIFY_USER and VERIFY_PASS in .env.genesis (a test account)");

  await page.goto(base + "/login");
  await page.waitForLoadState("networkidle").catch(() => {});

  // Adjust these selectors to your login form:
  await page.locator('input[type="email"], input[name*="user" i], input[id*="user" i]').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.locator('button[type="submit"]').first().click();

  // Logged in = we left the login page
  await page.waitForURL((u) => !/\/login/i.test(u.pathname), { timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}
