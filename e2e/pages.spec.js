// ============================================================================
// Every-page smoke (cycle-7 F137): load each page of both apps in a real
// browser and fail on an uncaught page error or a 5xx response. The unit suite
// pinned page source with regexes, so four page-killing bugs shipped green —
// the Rent page dying once a utility existed (F87), /accounts/:id/history
// 500ing (F88), the nav badge + bell never loading (F90) and the sixth-toast
// infinite loop (F89). Each has a targeted check below.
//
// Cycle-7 G2 (Batch 20): the pages render SEEDED data (e2e/seed.js — accounts,
// a refund and a split, budget, goal, subscription, housing, credit score;
// notes in each privacy tier, a habit with logs, a todo with subtasks, a Job
// Radar listing), a console.error fails a page like a page error, and a CLICK
// SWEEP presses every visible, enabled control that isn't destructive
// (data-e2e-skip, or a delete / send / sign-out style label) and fails on a page
// error, console error or non-501 5xx it triggers.
// ============================================================================
const { test, expect } = require("@playwright/test");
const { seedPerfin, seedPersistent } = require("./seed");

const PIN = process.env.E2E_SHELL_PIN || "246810";
// Log in ONCE and reuse the session: a fresh login per test lands on the
// Per-sistant dashboard (~15 API calls) every time, which alone tripped
// Per-sistant's 200-requests/15-min limiter part-way through the run before
// the limiter was skipped under the shell (F123).
let sessionCookies = [];

// Known, already-filed gaps this smoke tolerates (each with its finding). Keep
// it shrinking: remove an entry when its fix lands.
const KNOWN_GAPS = {
  // (empty — the Review page's review-summary 500 was fixed in roadmap T1.5:
  // AI routes answer 501 without a key and the page skips the call.)
};
function unexpected(pagePath, problems, gaps = KNOWN_GAPS) {
  const allow = gaps[pagePath];
  return allow ? problems.filter((p) => !allow.test(p)) : problems;
}

// What the click sweep turned up (cycle-7 G2), per page — each a filed
// follow-on, tolerated here until fixed. Keep it shrinking.
const SWEEP_KNOWN_GAPS = {
  ...KNOWN_GAPS,
};

async function loginWithPin(page, pin) {
  await page.goto("/login");
  await expect(page.locator("#pin-pad .pin-key").first()).toBeVisible();
  for (const d of String(pin)) await page.locator('.pin-key[data-digit="' + d + '"]').click();
  await page.locator('.pin-key[data-action="go"]').click();
  await page.waitForURL(/\/per-sistant/);
}

// Collect what would make a page "broken": an uncaught exception, or a server
// error. 501 is expected (no AI key / push keys in the e2e environment).
// A console.error counts too (G2) — except the browser's own "Failed to load
// resource" line, which the response check above already judges (a 501 is
// expected; a 4xx is often the right answer to a sweep click).
function watch(page, label = () => "") {
  const problems = [];
  page.on("pageerror", (err) => problems.push(label() + "pageerror: " + err.message));
  page.on("response", (res) => {
    if (res.status() >= 500 && res.status() !== 501) problems.push(label() + res.status() + " " + res.url());
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/^Failed to load resource/.test(text)) return;
    problems.push(label() + "console.error: " + text);
  });
  return problems;
}

// A control the sweep must never press: marked data-e2e-skip (the static
// destructive buttons; the microphone buttons — a headless browser has no mic,
// so the permission is refused; Teller Connect, which loads Teller's own SDK
// from teller.io), or labelled like one (row-level Delete / Remove /
// Unlink buttons are built at runtime).
const DESTRUCTIVE = /\b(delete|remove|unlink|send|empty|sign out|log ?out|reset|purge|disconnect|archive|trash|revoke|cancel subscription|mark settled)\b/i;
const SWEEP_SELECTOR = "button, [role=button], [role=checkbox], [role=tab], summary";
const SWEEP_MAX = 80;

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => { /* a long poll can keep the network busy */ });
}

// Press every sweepable control once, coming back to the page (and closing any
// dialog it opened) between presses. Returns the labels pressed.
async function clickSweep(page, pagePath, setCurrent) {
  page.on("dialog", (d) => d.dismiss().catch(() => { /* already handled */ }));
  await page.goto(pagePath);
  await settle(page);
  const total = Math.min(await page.locator(SWEEP_SELECTOR).count(), SWEEP_MAX);
  const pressed = [];
  for (let i = 0; i < total; i++) {
    const el = page.locator(SWEEP_SELECTOR).nth(i);
    if (!(await el.count())) break;
    const info = await el.evaluate((e) => ({
      skip: !!e.closest("[data-e2e-skip]"),
      text: ((e.innerText || "") + " " + (e.getAttribute("aria-label") || "") + " " + (e.title || "")).trim().replace(/\s+/g, " ").slice(0, 60),
      visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
      disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true",
    })).catch(() => null);
    if (!info || !info.visible || info.disabled || info.skip || DESTRUCTIVE.test(info.text)) continue;
    setCurrent(info.text || "#" + i);
    const clicked = await el.click({ timeout: 1500 }).then(() => true, () => false);
    if (!clicked) continue;
    pressed.push(info.text);
    await settle(page);
    // Back to a clean page: close a dialog / drawer, or return if it navigated.
    await page.keyboard.press("Escape").catch(() => { /* page gone */ });
    const here = new URL(page.url());
    if (here.pathname !== new URL(pagePath, here.origin).pathname) {
      await page.goto(pagePath);
      await settle(page);
    }
  }
  setCurrent("");
  return pressed;
}

const PERFIN_PAGES = ["/perfin/dashboard", "/perfin/subscriptions", "/perfin/transactions", "/perfin/calendar",
  "/perfin/goals", "/perfin/budgets", "/perfin/housing", "/perfin/settings", "/perfin/accounts", "/perfin/tax"];
const PERSISTENT_PAGES = ["/per-sistant/", "/per-sistant/today", "/per-sistant/todos", "/per-sistant/emails",
  "/per-sistant/notes", "/per-sistant/knowledge", "/per-sistant/health", "/per-sistant/jobs",
  "/per-sistant/contacts", "/per-sistant/search", "/per-sistant/calendar", "/per-sistant/review", "/per-sistant/analytics",
  "/per-sistant/settings"];

test.describe("every page loads cleanly", () => {
  let manualAccountId = null;
  let taxYear = null;

  test.beforeAll(async ({ browser }) => {
    // Seed through the apps' own routes (e2e/seed.js) — incl. a configured
    // utility (F87) and a manual account to open the history page for (F88).
    // page.request shares the signed-in cookie.
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginWithPin(page, PIN);
    sessionCookies = await context.cookies();
    const seeded = await seedPerfin(page.request);
    manualAccountId = seeded.manualAccountId;
    taxYear = seeded.taxYear;
    await seedPersistent(page.request);
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

  for (const pagePath of [...PERFIN_PAGES, ...PERSISTENT_PAGES]) {
    test(`${pagePath} click sweep`, async ({ page }) => {
      test.setTimeout(180000);
      let current = "";
      const problems = watch(page, () => (current ? "[" + current + "] " : ""));
      const pressed = await clickSweep(page, pagePath, (c) => { current = c; });
      expect(pressed.length, "the sweep pressed something").toBeGreaterThan(0);
      test.info().annotations.push({ type: "pressed", description: pressed.length + " controls" });
      const left = unexpected(pagePath, problems, SWEEP_KNOWN_GAPS);
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

  test("the dashboard opens on the Summary card and Needs attention (design D3)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/dashboard");
    const cards = page.locator("#dash-summary-cards");
    await expect(cards).not.toHaveAttribute("aria-busy", "true");
    await expect(cards.locator(".dash-summary-card")).toHaveCount(3);
    await expect(cards.locator(".skel")).toHaveCount(0);
    await expect(cards).toContainText("Net worth");
    await expect(cards).toContainText("Spent vs budget");
    await expect(cards).toContainText("Lowest cash, next 30 days");
    await expect(page.locator("#dash-summary-error")).toBeHidden();
    // The seeded ledger owes rent: its item links to the Rent page through the mount.
    const rent = page.locator("#dash-attention-body a", { hasText: /^Owed to / });
    await expect(rent).toHaveAttribute("href", "/perfin/housing");
    await rent.click();
    await expect(page).toHaveURL(/\/perfin\/housing$/);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the Cash Flow section lists what the forecast holds and saves a setting (cycle-8 E1b)", async ({ page }) => {
    const problems = watch(page);
    // The Subscriptions page's click sweep presses Dismiss on the seeded
    // subscription earlier in the run; bring it back so it is a projected bill.
    const subs = (await (await page.request.get("/perfin/api/subscriptions?filter=all")).json()).subscriptions || [];
    const sf = subs.find((x) => x.display_name === "Streamflix");
    expect(sf, "the seeded subscription").toBeTruthy();
    if (sf.is_dismissed) expect((await page.request.patch(`/perfin/api/subscriptions/${sf.id}/undismiss`, { headers: { "X-Requested-With": "XMLHttpRequest" } })).ok()).toBe(true);
    await page.goto("/perfin/dashboard");
    const wrap = page.locator("#cashflow-items-wrap");
    await expect(wrap).toBeVisible();
    await wrap.locator("summary").click();
    const items = page.locator("#cashflow-items");
    // The seeded subscription is a projected bill with its own setting.
    const sel = items.getByLabel("Forecast setting for Streamflix");
    await expect(sel).toHaveValue("auto");
    await sel.selectOption("ignore");
    await expect(items).toContainText("You left it out");
    await expect(items.getByLabel("Forecast setting for Streamflix")).toHaveValue("ignore");
    // Put it back so the other checks see the seeded forecast.
    await items.getByLabel("Forecast setting for Streamflix").selectOption("auto");
    await expect(items).not.toContainText("You left it out");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the landing tiles carry their status lines (design D7)", async ({ page }) => {
    test.setTimeout(75000);
    const problems = watch(page);
    // The seeded ledger owes rent; the line comes from the dashboard summary.
    // A line is kept 30 s (cycle-8 F33), so a visit from another spec before the
    // seed finished can show the old one — reload until the cache has turned over.
    await expect(async () => {
      await page.goto("/");
      await expect(page.locator('a.tile[href="/perfin"] .tile-status')).toContainText(/\$[\d,]+\.\d\d owed to /, { timeout: 2000 });
    }).toPass({ timeout: 60000, intervals: [2000, 5000, 10000] });
    await expect(page.locator('a.tile[href="/per-sistant"] .tile-status')).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("on a phone the first screen is the summary; the pyramid starts collapsed and opens (design D4)", async ({ page }) => {
    const problems = watch(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/perfin/dashboard");
    await page.evaluate(() => { try { localStorage.removeItem("perfin_collapse_pyramid"); } catch (_) {} });
    await page.reload();
    const cards = page.locator("#dash-summary-cards .dash-summary-card");
    await expect(cards.first()).toBeVisible();
    const top = await cards.first().boundingBox();
    expect(top.y).toBeLessThan(844);
    const pyramid = page.locator(".wellness-section");
    await expect(pyramid).toHaveClass(/collapsed/);
    await expect(page.locator("#pyramid-switcher")).toBeHidden();
    const pyrBox = await pyramid.boundingBox();
    expect(pyrBox.y).toBeGreaterThan(844);
    // Opening it once keeps it open on the next load.
    await page.locator("#pyramid-title").click();
    await expect(page.locator("#pyramid-switcher")).toBeVisible();
    const sw = await page.locator("#pyramid-switcher").evaluate((el) => ({ wrap: getComputedStyle(el).flexWrap, overflow: getComputedStyle(el).overflowX }));
    expect(sw).toEqual({ wrap: "nowrap", overflow: "auto" });
    await page.reload();
    await expect(page.locator(".wellness-section")).not.toHaveClass(/collapsed/);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the Rent page shows the configured utility row (F87)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/housing");
    await expect(page.locator(".hz-util-row .hz-u-label").first()).toHaveValue("Electricity");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("search finds a seeded Perfin transaction and Perfin's nav links to it (T2.4 X3b)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/dashboard");
    const navLink = page.locator("#nav-search-link");
    await expect(navLink).toHaveAttribute("href", "/per-sistant/search");
    await navLink.click();
    await expect(page).toHaveURL(/\/per-sistant\/search$/);
    await expect(page.locator("#search-page-input")).toBeFocused();
    await page.goto("/per-sistant/search?q=" + encodeURIComponent("Corner Cafe"));
    await expect(page.locator("#search-page-input")).toHaveValue("Corner Cafe");
    const hit = page.locator("#search-page-results a.result-item", { hasText: "Corner Cafe" });
    await expect(hit).toHaveAttribute("href", /^\/perfin\/transactions\?q=Corner%20Cafe&month=\d{4}-\d{2}$/);
    await expect(hit.locator(".result-type")).toHaveText("transaction · Perfin");
    await hit.click();
    await expect(page).toHaveURL(/\/perfin\/transactions\?q=Corner%20Cafe/);
    await expect(page.locator("#search-input")).toHaveValue("Corner Cafe");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("a linked task shows its Perfin chip on the To-Dos page and in the edit modal (T2.4 X1b)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/per-sistant/todos");
    const row = page.locator(".todo-item[data-id]", { hasText: "E2E pay rent" });
    const chip = row.locator("a.linked-chip");
    await expect(chip).toHaveAttribute("href", "/perfin/housing");
    await expect(chip).toHaveAttribute("aria-label", "Open in Perfin: E2E pay rent");
    await row.locator('[data-action="edit"]').click();
    await expect(page.locator("#f-linked")).toBeVisible();
    await expect(page.locator("#f-linked a.linked-chip")).toHaveAttribute("href", "/perfin/housing");
    await page.locator("#modal-close-x").click();
    await chip.click();
    await expect(page).toHaveURL(/\/perfin\/housing$/);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("Settings deep links land on their sections; the index on a desktop, Jump to on a phone (design D5)", async ({ page }) => {
    const problems = watch(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const id of ["sync-health", "deleted-transactions", "recent-errors"]) {
      await page.goto("/perfin/settings#" + id);
      const target = page.locator("#" + id);
      // It lands near the top of the screen once the page settles (the sections
      // above fill in as their loads answer; the page lands on it again).
      await expect.poll(async () => {
        const box = await target.boundingBox();
        return box && box.y >= -2 && box.y < 200;
      }, { timeout: 5000 }).toBe(true);
      if (id === "deleted-transactions") await expect(target).toHaveAttribute("open", "");
      await expect(page.locator('#settings-index-list a[data-group="group-sync"]')).toHaveAttribute("aria-current", "true");
    }
    const index = page.locator("#settings-index");
    await expect(index).toBeVisible();
    await expect(index.locator("a")).toHaveText(["Appearance & Dashboard", "Security", "AI", "Alerts & Notifications",
      "Sync & Connections", "Planning", "Data & Exports"]);
    await expect(page.locator("#settings-jump")).toBeHidden();
    // The index stays on screen while the page scrolls.
    await page.locator("#group-data").scrollIntoViewIfNeeded();
    const idxBox = await index.boundingBox();
    expect(idxBox.y).toBeGreaterThanOrEqual(0);
    expect(idxBox.y).toBeLessThan(100);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/perfin/settings");
    await expect(index).toBeHidden();
    const jump = page.getByLabel("Jump to");
    await expect(jump).toBeVisible();
    await jump.selectOption({ label: "Planning" });
    await expect(page).toHaveURL(/#group-planning$/);
    await expect.poll(async () => {
      const box = await page.locator("#group-planning").boundingBox();
      return box && box.y >= -2 && box.y < 200;
    }, { timeout: 5000 }).toBe(true);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("a deleted transaction is listed in Settings and Restore brings it back (T2.5 U2)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/settings");
    const section = page.locator("#deleted-transactions");
    await expect(section.locator("#deleted-transactions-count")).toHaveText(/^\(\d+\+?\)$/);
    await section.locator("summary").click();
    const row = section.locator("li", { hasText: "E2E DELETED SHOP" });
    await expect(row).toContainText("$9.99");
    await row.getByRole("button", { name: /^Restore E2E DELETED SHOP/ }).click();
    await expect(page.locator("#toast-stack .toast", { hasText: "Transaction restored." })).toBeVisible();
    await expect(row).toHaveCount(0);
    await page.goto("/perfin/transactions?q=" + encodeURIComponent("E2E DELETED SHOP"));
    await expect(page.locator("#txn-body")).toContainText("E2E DELETED SHOP");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the Tax page shows the year's package, takes a form and downloads the ZIP (T3.3 K4)", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/perfin/tax?year=" + taxYear);
    await expect(page.locator("#tax-year")).toHaveValue(String(taxYear));
    const sections = page.locator("#tax-sections");
    for (const key of ["overview", "income", "investment_income", "realized_gains", "retirement", "deductions", "rent_paid"]) {
      await expect(sections.locator(`[data-section="${key}"]`)).toBeVisible();
    }
    await expect(sections.locator('[data-section="income"]')).toContainText("$2,000.00");
    await expect(sections.locator('[data-section="deductions"]')).toContainText("medical");
    await expect(page.locator("#documents-list")).toContainText("1099-NEC from E2E Client");

    // Add a form through the page, then mark it received.
    const issuer = "E2E Tax " + Date.now();
    await page.locator("#doc-form").selectOption("1099-MISC");
    await page.locator("#doc-issuer").fill(issuer);
    await page.locator("#doc-add").click();
    const row = page.locator("#documents-list li", { hasText: "1099-MISC from " + issuer });
    await expect(row.locator(".doc-state")).toHaveText(/Waiting|Overdue/);
    await row.getByRole("button", { name: "Mark the 1099-MISC from " + issuer + " received" }).click();
    await expect(row.locator(".doc-state")).toHaveText("Received");

    await expect(page.locator("#tax-zip-link")).toHaveAttribute("href", `/perfin/api/tax/package?year=${taxYear}&format=zip`);
    const zip = await page.request.get(`/perfin/api/tax/package?year=${taxYear}&format=zip`);
    expect(zip.status()).toBe(200);
    expect(zip.headers()["content-type"]).toBe("application/zip");
    expect((await zip.body()).slice(0, 2).toString()).toBe("PK");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("the top nav is the same single row on every Perfin page at desktop width (design D1)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const boxes = {};
    for (const p of ["/perfin/dashboard", "/perfin/budgets", "/perfin/accounts", "/perfin/settings", "/perfin/tax"]) {
      await page.goto(p);
      const box = await page.locator("nav.topnav").boundingBox();
      const logo = await page.locator("nav.topnav .logo").boundingBox();
      const bell = await page.locator("#nav-notif-bell").boundingBox();
      // One row: the logo and the bell share a line (a wrapped nav put them rows apart).
      expect(Math.abs((logo.y + logo.height / 2) - (bell.y + bell.height / 2)), p + " logo and bell on one line").toBeLessThan(12);
      boxes[p] = { x: Math.round(box.x), width: Math.round(box.width), height: Math.round(box.height) };
    }
    const first = boxes["/perfin/dashboard"];
    expect(first.height, "one row (20px padding around a ~40px row)").toBeLessThanOrEqual(90);
    for (const [p, b] of Object.entries(boxes)) expect(b, p).toEqual(first);
  });

  test("a fresh boot logs no attachments-migration error (design D1)", async ({ page }) => {
    const res = await page.request.get("/perfin/api/errors?all=1&limit=100");
    expect(res.status()).toBe(200);
    const { errors } = await res.json();
    const hits = errors.filter((e) => /attachment migrate/i.test(e.message || ""));
    expect(hits, JSON.stringify(hits)).toEqual([]);
  });

  test("a toast's Undo button closes it and runs its action (T2.5 U2)", async ({ page }) => {
    await page.goto("/perfin/transactions");
    await page.evaluate(() => {
      window.__undone = 0;
      window.showMsg("Transaction deleted.", true, { action: { label: "Undo", run: () => { window.__undone++; } } });
    });
    const toast = page.locator("#toast-stack .toast", { hasText: "Transaction deleted." });
    await toast.getByRole("button", { name: "Undo" }).click();
    expect(await page.evaluate(() => window.__undone)).toBe(1);
    await expect(toast).toHaveCount(0);
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
