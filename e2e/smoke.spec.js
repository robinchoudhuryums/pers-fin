// ============================================================================
// Browser smokes — login, both apps' core pages, calendar feed gating.
// ============================================================================
const { test, expect } = require("@playwright/test");

const PIN = process.env.E2E_SHELL_PIN || "246810";

test("unauthenticated visit redirects to the PIN login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('input[name="pin"]')).toBeVisible();
});

test("wrong PIN shows an error and does not authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="pin"]', "000000");
  await page.locator('form[action="/login"] button[type="submit"], form[action="/login"] input[type="submit"]').first().click();
  await expect(page.locator("body")).toContainText(/incorrect pin/i);
});

test("correct PIN lands directly in Per-sistant (landing skipped by default)", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="pin"]', PIN);
  await page.locator('form[action="/login"] button[type="submit"], form[action="/login"] input[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/per-sistant/);
  await expect(page.locator(".sidebar-brand")).toContainText(/per-sistant/i);
});

test.describe("authenticated", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.fill('input[name="pin"]', PIN);
    await page.locator('form[action="/login"] button[type="submit"], form[action="/login"] input[type="submit"]').first().click();
    await page.waitForURL(/\/per-sistant/);
  });

  test("Perfin dashboard renders its chrome and sections", async ({ page }) => {
    await page.goto("/perfin/dashboard");
    await expect(page.locator(".topnav .logo")).toContainText(/perfin/i);
    await expect(page.locator('button#nav-notif-bell')).toBeVisible();
    await expect(page.locator('h2:has-text("Monthly Spending")')).toBeAttached();
    await expect(page.locator('[data-collapse-key="categories"]')).toBeAttached();
  });

  test("Activity page renders the transaction surface", async ({ page }) => {
    await page.goto("/perfin/transactions");
    await expect(page.locator("h1")).toContainText(/transactions/i);
    await expect(page.locator("table.txn-compact")).toBeAttached();
    await expect(page.locator("#result-count")).toContainText(/transactions found/i, { timeout: 15000 });
  });

  test("landing tile picker is still reachable at /", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('a.tile[href="/per-sistant"]')).toBeVisible();
  });

  test("Per-sistant todos page renders", async ({ page }) => {
    await page.goto("/per-sistant/todos");
    await expect(page.locator(".sidebar-nav")).toContainText(/to-dos/i);
  });
});

test("calendar feed is off without CALENDAR_FEED_TOKEN (404, no auth leak)", async ({ request }) => {
  const res = await request.get("/calendar.ics?token=anything");
  expect(res.status()).toBe(404);
});
