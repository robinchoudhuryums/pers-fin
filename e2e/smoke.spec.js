// ============================================================================
// Browser smokes — login, both apps' core pages, calendar feed gating.
// ============================================================================
const { test, expect } = require("@playwright/test");

const PIN = process.env.E2E_SHELL_PIN || "246810";

// The shell login now uses a numeric keypad (text input + Continue are hidden
// by progressive enhancement). Drive the pad: tap each digit's key, then "Go".
async function loginWithPin(page, pin) {
  await page.goto("/login");
  await expect(page.locator("#pin-pad .pin-key").first()).toBeVisible();
  for (const d of String(pin)) {
    await page.locator('.pin-key[data-digit="' + d + '"]').click();
  }
  await page.locator('.pin-key[data-action="go"]').click();
}

test("unauthenticated visit redirects to the PIN login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  // The keypad is the visible credential entry (the text input is hidden by JS).
  await expect(page.locator("#pin-pad")).toBeVisible();
});

test("wrong PIN shows an error and does not authenticate", async ({ page }) => {
  await loginWithPin(page, "000000");
  await expect(page.locator("body")).toContainText(/incorrect pin/i);
});

test("correct PIN lands directly in Per-sistant (landing skipped by default)", async ({ page }) => {
  await loginWithPin(page, PIN);
  await expect(page).toHaveURL(/\/per-sistant/);
  await expect(page.locator(".sidebar-brand")).toContainText(/per-sistant/i);
});

test.describe("authenticated", () => {
  test.beforeEach(async ({ page }) => {
    await loginWithPin(page, PIN);
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
