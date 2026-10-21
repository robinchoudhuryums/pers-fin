// ============================================================================
// Every-page smoke (cycle-7 F137): load each page of both apps in a real
// browser and fail on an uncaught page error or a 5xx response. The unit suite
// pinned page source with regexes, so four page-killing bugs shipped green —
// the Rent page dying once a utility existed (F87), /accounts/:id/history
// 500ing (F88), the nav badge + bell never loading (F90) and the sixth-toast
// infinite loop (F89). Each has a targeted check below.
// ============================================================================
const { test, expect } = require("@playwright/test");

const PIN = process.env.E2E_SHELL_PIN || "246810";
// Log in ONCE and reuse the session: a fresh login per test lands on the
// Per-sistant dashboard (~15 API calls) every time, which alone tripped
// Per-sistant's 200-requests/15-min limiter part-way through the run before
// the limiter was skipped under the shell (F123).
let sessionCookies = [];

// Known, already-filed gaps this smoke tolerates (each with its finding). Keep
// it shrinking: remove an entry when its fix lands.
const KNOWN_GAPS = {
  // Cycle-7 follow-on (found by this smoke): with no ANTHROPIC_API_KEY the
  // review page's automatic POST /api/ai/review-summary answers 500 (callAI
  // throws → serverError) instead of a 501. Production has a key.
  "/per-sistant/review": /^500 .*\/per-sistant\/api\/ai\/review-summary$/,
};
function unexpected(pagePath, problems) {
  const allow = KNOWN_GAPS[pagePath];
  return allow ? problems.filter((p) => !allow.test(p)) : problems;
}

async function loginWithPin(page, pin) {
  await page.goto("/login");
  await expect(page.locator("#pin-pad .pin-key").first()).toBeVisible();
  for (const d of String(pin)) await page.locator('.pin-key[data-digit="' + d + '"]').click();
  await page.locator('.pin-key[data-action="go"]').click();
  await page.waitForURL(/\/per-sistant/);
}

// Collect what would make a page "broken": an uncaught exception, or a server
// error. 501 is expected (no AI key / push keys in the e2e environment).
function watch(page) {
  const problems = [];
  page.on("pageerror", (err) => problems.push("pageerror: " + err.message));
  page.on("response", (res) => {
    if (res.status() >= 500 && res.status() !== 501) problems.push(res.status() + " " + res.url());
  });
  return problems;
}

const PERFIN_PAGES = ["/perfin/dashboard", "/perfin/subscriptions", "/perfin/transactions", "/perfin/calendar",
  "/perfin/goals", "/perfin/budgets", "/perfin/housing", "/perfin/settings", "/perfin/accounts"];
const PERSISTENT_PAGES = ["/per-sistant/", "/per-sistant/today", "/per-sistant/todos", "/per-sistant/emails",
  "/per-sistant/notes", "/per-sistant/knowledge", "/per-sistant/health", "/per-sistant/jobs",
  "/per-sistant/contacts", "/per-sistant/calendar", "/per-sistant/review", "/per-sistant/analytics",
  "/per-sistant/settings"];

test.describe("every page loads cleanly", () => {
  let manualAccountId = null;

  test.beforeAll(async ({ browser }) => {
    // Seed what makes the broken paths reachable: a configured utility (F87)
    // and a manual account to open the history page for (F88). page.request
    // shares the signed-in cookie; JSON bodies satisfy Perfin's CSRF check.
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginWithPin(page, PIN);
    sessionCookies = await context.cookies();
    const cfg = await page.request.patch("/perfin/api/housing/config", {
      data: { enabled: true, payee_name: "E2E Landlord", rent_amount: 1500, rent_due_day: 1,
        utilities: [{ label: "Electricity", cadence_months: 1, due_day: 15 }] },
    });
    expect(cfg.status(), await cfg.text()).toBe(200);
    const acct = await page.request.post("/perfin/api/accounts/manual", {
      data: { name: "E2E Cash", institution_name: "Wallet", type: "depository", current_balance: 120 },
    });
    expect(acct.status(), await acct.text()).toBe(200);
    manualAccountId = (await acct.json()).id;
    await context.close();
  });

  test.beforeEach(async ({ context }) => { await context.addCookies(sessionCookies); });

  for (const pagePath of [...PERFIN_PAGES, ...PERSISTENT_PAGES]) {
    test(`${pagePath} has no page errors or 5xx`, async ({ page }) => {
      const problems = watch(page);
      const res = await page.goto(pagePath);
      expect(res.status(), pagePath).toBeLessThan(400);
      await page.waitForLoadState("networkidle");
      const left = unexpected(pagePath, problems);
      expect(left, left.join("\n")).toEqual([]);
    });
  }

  test("account history renders (F88)", async ({ page }) => {
    const problems = watch(page);
    const res = await page.goto(`/perfin/accounts/${manualAccountId}/history?source=linked`);
    expect(res.status()).toBe(200);
    await expect(page.locator("#account-title")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the Rent page shows the configured utility row (F87)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/housing");
    await expect(page.locator(".hz-util-row .hz-u-label").first()).toHaveValue("Electricity");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the nav loads the sync badge settings and the unread count (F90) and the logo (F93)", async ({ page }) => {
    const seen = { settings: false, notifications: false, logo: 0 };
    page.on("response", (res) => {
      const u = res.url();
      if (u.includes("/perfin/api/settings")) seen.settings = true;
      if (u.includes("/perfin/api/notifications?limit=20")) seen.notifications = true;
      if (u.endsWith("/perfin/logo.svg")) seen.logo = res.status();
    });
    await page.goto("/perfin/budgets");
    await page.waitForLoadState("networkidle");
    expect(seen.settings, "nav sync badge fetched /api/settings").toBe(true);
    expect(seen.notifications, "bell fetched the unread count").toBe(true);
    expect(seen.logo, "nav logo mask loads under /perfin").toBe(200);
  });

  test("a burst of toasts caps at five without hanging the tab (F89)", async ({ page }) => {
    await page.goto("/perfin/budgets");
    const visible = await page.evaluate(() => {
      for (let i = 1; i <= 8; i++) window.showMsg("toast " + i, true);
      return document.querySelectorAll("#toast-stack .toast:not(.toast-leaving)").length;
    });
    expect(visible).toBe(5);
  });

  test("the offline page's Retry works and its logo loads under the shell CSP (F92)", async ({ page }) => {
    const problems = watch(page);
    const cspErrors = [];
    page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
    await page.goto("/perfin/offline.html");
    await expect(page.locator("#offline-retry")).toBeVisible();
    expect(await page.locator("#offline-logo").evaluate((img) => img.naturalWidth > 0)).toBe(true);
    await Promise.all([page.waitForEvent("load"), page.locator("#offline-retry").click()]);
    expect(cspErrors, cspErrors.join("\n")).toEqual([]);
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
