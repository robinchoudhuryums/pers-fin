// ============================================================================
// Behaviour tests (cycle-8 E5, ST4 — .cycle/plan-e5-behaviour-tests.md).
//
// The click sweep in pages.spec.js presses every control and fails only on a
// page error, a console error or a 5xx — a Save that writes nothing, or a
// toggle the server ignores, passes it. Each test here does one key action the
// way a person would, then checks
//   (a) the page shows the new state,
//   (b) the API agrees,
//   (c) a reload still shows it,
// and puts the state back — through the page's own undo when the app has one
// (checked the same way), else through the API.
//
// Each test acts only on rows it created under a unique "E5 … <tag>" name, so
// seed.js's names and figures (rent owed, the tax year's income, the seeded
// subscription) that pages.spec.js asserts are never touched. Files run one at
// a time (workers: 1), so the click sweep never presses these rows mid-test.
// ============================================================================
const { test, expect } = require("@playwright/test");
const { Client } = require("pg");
const { ensureSeeded } = require("./seed");
const { loginWithPin, watch, apiJson, apiSend, ymd, HDR, dbUrl } = require("./helpers");

test.describe.configure({ mode: "serial" });

let sessionCookies = [];
let walletAccountId = null; // linked_accounts.account_id of this file's own manual account

// A short unique suffix per test, so a rerun never meets an older row.
function tagOf() { return String(Date.now()).slice(-7) + Math.floor(Math.random() * 90 + 10); }

// A manual (cash) expense on this file's wallet account, dated today. It has a
// category unless asked otherwise, so it never crowds the 8-row Review queue
// (test 4's uncategorized row must be in it, on a rerun too).
async function cashRow(req, merchant, extra = {}) {
  return apiSend(req, "post", "/perfin/api/transactions/manual", {
    account_id: walletAccountId, amount: 17.25, date: ymd(0), merchant_name: merchant, category: "Shopping", ...extra,
  });
}

// GET /api/transactions/search?q= → its transactions.
async function searchTxns(req, q) {
  return (await apiJson(req, "/perfin/api/transactions/search?q=" + encodeURIComponent(q))).transactions || [];
}

// A generic CSV of one charge imported under its own account label.
async function importCsvRow(req, label, date, merchant, amount) {
  const res = await req.post("/perfin/api/import-csv", {
    headers: HDR,
    multipart: {
      file: { name: "e5.csv", mimeType: "text/csv", buffer: Buffer.from(`Date,Description,Amount\n${date},${merchant},${amount}\n`) },
      account_label: label,
      positive_means: "charges",
    },
  });
  if (!res.ok()) throw new Error(`import ${label} → ${res.status()} ${await res.text()}`);
}

function toast(page, text) {
  return page.locator("#toast-stack .toast", { hasText: text }).first();
}

// Settings fills every control from GET /api/settings in one synchronous step
// (the widget switches among them) — waiting for them means a later change
// can't be overwritten by that first load.
async function openSettings(page) {
  await page.goto("/perfin/settings");
  await expect(page.locator('#widget-toggles input[data-widget="charts"]')).toBeAttached();
}
const settingsOf = (req) => apiJson(req, "/perfin/api/settings");

// The one row in Perfin's database no route can create: a notification is only
// written by sendToAll from a job or a sync (E5b, plan decision 2).
async function perfinDb(fn) {
  const db = new Client({ connectionString: dbUrl("perfin_e2e") });
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}

test.describe("key actions change what they say they change", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginWithPin(page);
    sessionCookies = await context.cookies();
    await ensureSeeded(page.request);
    // This file's own manual account (reused across runs against one server).
    const accounts = await apiJson(page.request, "/perfin/api/accounts");
    const list = Array.isArray(accounts) ? accounts : accounts.accounts || [];
    let wallet = list.find((a) => a.name === "E5 Wallet" && a.is_manual);
    if (!wallet) {
      await apiSend(page.request, "post", "/perfin/api/accounts/manual",
        { name: "E5 Wallet", institution_name: "E5", type: "depository", current_balance: 50 });
      const again = await apiJson(page.request, "/perfin/api/accounts");
      wallet = (Array.isArray(again) ? again : again.accounts || []).find((a) => a.name === "E5 Wallet" && a.is_manual);
    }
    walletAccountId = wallet.account_id;
    await context.close();
  });

  test.beforeEach(async ({ context }) => { await context.addCookies(sessionCookies); });

  // 1 ─────────────────────────────────────────────────────────────────────────
  test("Activity: renaming a merchant and adding a note sticks, and clearing them restores the bank's name", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const original = `E5 Cafe ${t}`;
    const renamed = `E5 Bistro ${t}`;
    const note = `E5 note ${t}`;
    await cashRow(page.request, original);

    await page.goto("/perfin/transactions?q=" + t);
    const body = page.locator("#txn-body");
    await expect(body).toContainText(original);
    await body.locator("tr", { hasText: original }).getByRole("button", { name: "Edit" }).click();
    await page.locator("#edit-merchant").fill(renamed);
    await page.locator("#edit-notes").fill(note);
    await page.locator("#edit-save").click();
    await expect(toast(page, "Transaction updated.")).toBeVisible();
    // (a) the list re-reads: the row carries the new name.
    await expect(body.locator("tr", { hasText: renamed })).toHaveCount(1);
    await expect(body).not.toContainText(original);
    // (b) the API agrees.
    const [row] = await searchTxns(page.request, t);
    expect(row.merchant).toBe(renamed);
    expect(row.user_notes).toBe(note);
    // (c) after a reload, the name and (in the dialog) the note.
    await page.reload();
    await body.locator("tr", { hasText: renamed }).getByRole("button", { name: "Edit" }).click();
    await expect(page.locator("#edit-merchant")).toHaveValue(renamed);
    await expect(page.locator("#edit-notes")).toHaveValue(note);
    // Put back through the dialog: clearing the name returns the bank's own.
    await page.locator("#edit-merchant").fill("");
    await page.locator("#edit-notes").fill("");
    await page.locator("#edit-save").click();
    await expect(body.locator("tr", { hasText: original })).toHaveCount(1);
    const [back] = await searchTxns(page.request, t);
    expect(back.merchant).toBe(original);
    expect(back.user_notes).toBeNull();
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  test("Activity: marking a charge reimbursed shows the badge, persists, and unmarking removes it", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const merchant = `E5 Taxi ${t}`;
    await cashRow(page.request, merchant);

    await page.goto("/perfin/transactions?q=" + t);
    const row = page.locator("#txn-body tr", { hasText: merchant });
    await expect(row).not.toContainText("REIMBURSED");
    await row.getByRole("button", { name: "Edit" }).click();
    await page.locator("#edit-reimbursed").check();
    await page.locator("#edit-save").click();
    await expect(toast(page, "Transaction updated.")).toBeVisible();
    await expect(row).toContainText("REIMBURSED");
    expect((await searchTxns(page.request, t))[0].is_reimbursed).toBe(true);
    await page.reload();
    await expect(row).toContainText("REIMBURSED");
    // Put back through the dialog.
    await row.getByRole("button", { name: "Edit" }).click();
    await expect(page.locator("#edit-reimbursed")).toBeChecked();
    await page.locator("#edit-reimbursed").uncheck();
    await page.locator("#edit-save").click();
    await expect(row).not.toContainText("REIMBURSED");
    expect((await searchTxns(page.request, t))[0].is_reimbursed).toBe(false);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  test("Activity: deleting a duplicate tombstones it, and the toast's Undo brings it back", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const merchant = `E5 DUP ${t}`;
    // The same charge on two accounts — the duplicate finder's pair.
    await importCsvRow(page.request, `E5 Dup A ${t}`, ymd(-6), merchant, "23.45");
    await importCsvRow(page.request, `E5 Dup B ${t}`, ymd(-6), merchant, "23.45");

    await page.goto("/perfin/transactions");
    const card = page.locator("#dup-list .dup-card", { hasText: merchant });
    await expect(card).toHaveCount(1);
    const del = card.getByRole("button", { name: "Delete #1" });
    const deletedId = await del.getAttribute("data-id");
    page.once("dialog", (d) => d.accept());
    await del.click();
    // (a) the toast offers Undo and the pair is gone from the finder.
    const t1 = toast(page, "Transaction deleted.");
    await expect(t1).toBeVisible();
    await expect(card).toHaveCount(0);
    // (b) the API lists the tombstone, and only one copy is left.
    const deleted = await apiJson(page.request, "/perfin/api/deleted-transactions?limit=200");
    expect(deleted.items.map((i) => i.transaction_id)).toContain(deletedId);
    expect(await searchTxns(page.request, merchant)).toHaveLength(1);
    // Undo, through the toast.
    await t1.getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, "Transaction restored.")).toBeVisible();
    await expect(card).toHaveCount(1);
    const after = await apiJson(page.request, "/perfin/api/deleted-transactions?limit=200");
    expect(after.items.map((i) => i.transaction_id)).not.toContain(deletedId);
    expect(await searchTxns(page.request, merchant)).toHaveLength(2);
    // (c) after a reload the pair is listed again.
    await page.reload();
    await expect(card).toHaveCount(1);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  test("Dashboard: Review Uncategorized's Apply files the row and leaves no rule when Remember is off", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const merchant = `E5 Kiosk ${t}`;
    await cashRow(page.request, merchant, { category: null }); // uncategorized, newest first in the queue

    await page.goto("/perfin/dashboard");
    const list = page.locator("#review-queue-list");
    const select = list.getByLabel("Category for " + merchant);
    await expect(select).toBeVisible();
    const txnId = await select.getAttribute("data-cat-select");
    const apply = list.locator(`[data-cat-apply="${txnId}"]`);
    await expect(apply).toBeDisabled(); // no suggestion → choose first (design D1)
    await select.selectOption("Shopping");
    await expect(list.locator(`[data-cat-rule="${txnId}"]`)).not.toBeChecked();
    await apply.click();
    // (a) the row leaves the queue.
    await expect(select).toHaveCount(0);
    // (b) the category is the user's, and no rule was made for the merchant.
    const [row] = await searchTxns(page.request, t);
    expect(row.category).toBe("Shopping");
    const rules = await apiJson(page.request, "/perfin/api/categorization-rules");
    const ruleList = Array.isArray(rules) ? rules : rules.rules || [];
    expect(ruleList.filter((r) => r.merchant_pattern === merchant)).toEqual([]);
    const queue = await apiJson(page.request, "/perfin/api/categorize/review-queue?limit=50");
    expect(queue.transactions.map((q) => q.transaction_id)).not.toContain(txnId);
    // (c) not back after a reload. (Its own row — nothing to put back.)
    await page.reload();
    await expect(page.locator("#review-queue-list").getByLabel("Category for " + merchant)).toHaveCount(0);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  test("Calendar: marking a manual bill paid records the payment, and pressing it again removes it", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const name = `E5 Bill ${t}`;
    const bill = await apiSend(page.request, "post", "/perfin/api/manual-bills",
      { name, amount: 31, due_day: 15, cadence: "monthly", category: "other" });
    const billId = bill.id || (bill.bill && bill.bill.id);
    const month = ymd(0).slice(0, 7);
    const date = month + "-15";
    const [year, mon] = month.split("-").map(Number);
    const payments = async () => (await apiJson(page.request, `/perfin/api/bill-payments?year=${year}&month=${mon}`))
      .filter((p) => p.bill_source === "manual" && Number(p.bill_id) === Number(billId));

    try {
      await page.goto("/perfin/calendar");
      const ev = page.locator(`#cal-grid button.cal-event[data-source="manual"][data-bid="${billId}"][data-date="${date}"]`);
      await expect(ev).toHaveAttribute("aria-pressed", "false");
      await ev.click();
      await expect(toast(page, "Marked paid")).toBeVisible();
      // (a) pressed, struck through.
      await expect(ev).toHaveAttribute("aria-pressed", "true");
      await expect(ev).toHaveClass(/\bpaid\b/);
      // (b) one payment for that day, at the bill's amount.
      const paid = await payments();
      expect(paid).toHaveLength(1);
      expect(String(paid[0].paid_date).slice(0, 10)).toBe(date);
      expect(Number(paid[0].paid_amount)).toBe(31);
      // (c) still paid after a reload.
      await page.reload();
      await expect(ev).toHaveAttribute("aria-pressed", "true");
      // Put back by pressing it again.
      await ev.click();
      await expect(toast(page, "Marked unpaid")).toBeVisible();
      await expect(ev).toHaveAttribute("aria-pressed", "false");
      expect(await payments()).toEqual([]);
    } finally {
      await apiSend(page.request, "delete", `/perfin/api/manual-bills/${billId}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  test("Budgets: a budget added to roll over says so, Stop rollover turns it off, and Delete removes it", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const category = `E5 Budget ${t}`;
    // GET /api/budgets is getBudgetStatus's array.
    const budgetOf = async () => (await apiJson(page.request, "/perfin/api/budgets")).find((b) => b.category === category);

    await page.goto("/perfin/budgets");
    await page.locator("#toggle-form-btn").click();
    await page.locator("#b-category").fill(category);
    await page.locator("#b-limit").fill("120");
    await page.locator("#b-rollover").check();
    await page.locator("#save-budget-btn").click();
    await expect(toast(page, "Budget added.")).toBeVisible();
    const card = page.locator(".budget-card", { hasText: category });
    // (a) the card, with its badge.
    await expect(card).toContainText("Rolls over");
    await expect(card).toContainText("$120.00");
    // (b) the API.
    let b = await budgetOf();
    expect(b.rollover_enabled).toBe(true);
    expect(Number(b.monthly_limit)).toBe(120);
    // (c) after a reload.
    await page.reload();
    await expect(card).toContainText("Rolls over");
    // Stop rollover on the card.
    await card.getByRole("button", { name: "Stop rollover" }).click();
    await expect(card).not.toContainText("Rolls over");
    await expect(card.getByRole("button", { name: "Roll over unused" })).toBeVisible();
    b = await budgetOf();
    expect(b.rollover_enabled).toBe(false);
    await page.reload();
    await expect(card).not.toContainText("Rolls over");
    // Put back: Delete on the card.
    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(card).toHaveCount(0);
    expect(await budgetOf()).toBeUndefined();
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  test("Rent: recording a payment lowers the balance owed, and the payment's Undo puts it back", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const label = `E5 Fee ${t}`;
    const ledger = () => apiJson(page.request, "/perfin/api/housing/ledger");
    const before = Number((await ledger()).balance);
    const ob = await apiSend(page.request, "post", "/perfin/api/housing/obligations",
      { label, period: ymd(0).slice(0, 7), amount: 77, category: "other" });
    const owed = before + 77;
    const money = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    try {
      await page.goto("/perfin/housing");
      const summary = page.locator("#hz-summary");
      await expect(summary).toContainText(money(owed));
      // Pay just this item.
      await page.locator(`#hz-obligations input.hz-pick[data-id="${ob.id}"]`).check();
      await page.locator("#hz-record-btn").click();
      await expect(page.locator("#hz-pay-amount")).toHaveValue("77");
      await page.locator("#hz-pay-confirm").click();
      await expect(toast(page, "Payment recorded.")).toBeVisible();
      // (a) the balance drops and the payment is listed.
      await expect(summary).toContainText(money(before));
      const payment = page.locator("#hz-payments .hz-row", { hasText: label });
      await expect(payment).toContainText("$77.00");
      // (b) the ledger agrees.
      let l = await ledger();
      expect(Number(l.balance)).toBeCloseTo(before, 2);
      expect(l.obligations.find((o) => o.id === ob.id).status).toBe("paid");
      // (c) after a reload.
      await page.reload();
      await expect(summary).toContainText(money(before));
      await expect(payment).toHaveCount(1);
      // Undo the payment on the page.
      page.once("dialog", (d) => d.accept());
      await payment.locator(".hz-pay-del").click();
      await expect(toast(page, "Payment undone.")).toBeVisible();
      await expect(summary).toContainText(money(owed));
      await expect(payment).toHaveCount(0);
      l = await ledger();
      expect(Number(l.balance)).toBeCloseTo(owed, 2);
      expect(l.obligations.find((o) => o.id === ob.id).status).toBe("unpaid");
    } finally {
      // Its own item — removed so the seeded rent owed is what pages.spec sees.
      await apiSend(page.request, "delete", `/perfin/api/housing/obligations/${ob.id}`);
    }
    expect(Number((await ledger()).balance)).toBeCloseTo(before, 2);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 8 ─────────────────────────────────────────────────────────────────────────
  test("Subscriptions: Cancel marks it cancelled, and Restore brings it back", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const name = `E5 Sub ${t}`;
    const sub = await apiSend(page.request, "post", "/perfin/api/subscriptions", { name, amount: 4.99, cadence_days: 30 });
    const subId = sub.id || (sub.subscription && sub.subscription.id);
    const subOf = async () => ((await apiJson(page.request, "/perfin/api/subscriptions?filter=all")).subscriptions || [])
      .find((s) => Number(s.id) === Number(subId));

    try {
      await page.goto("/perfin/subscriptions");
      const row = page.locator("#subs-body tr, tbody tr", { hasText: name }).first();
      await expect(row).toBeVisible();
      page.once("dialog", (d) => d.accept());
      await row.getByRole("button", { name: "Cancel" }).click();
      await expect(toast(page, "Subscription marked as cancelled.")).toBeVisible();
      // (a) gone from Active; under Cancelled with its badge and Restore.
      await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0);
      await page.locator("#filter-select").selectOption("cancelled");
      const cancelled = page.locator("tbody tr", { hasText: name });
      await expect(cancelled).toContainText("CANCELLED");
      // (b) the API.
      expect((await subOf()).cancelled_at).toBeTruthy();
      // (c) after a reload.
      await page.reload();
      await page.locator("#filter-select").selectOption("cancelled");
      await expect(cancelled).toContainText("CANCELLED");
      // Restore on the page.
      await cancelled.getByRole("button", { name: "Restore" }).click();
      await expect(page.locator("#filter-select")).toHaveValue("cancelled");
      await expect(cancelled).toHaveCount(0);
      expect((await subOf()).cancelled_at).toBeNull();
      await page.locator("#filter-select").selectOption("active");
      await expect(page.locator("tbody tr", { hasText: name }).getByRole("button", { name: "Cancel" })).toBeVisible();
    } finally {
      // Its own manual subscription — dismissed so it stays out of the forecast.
      await apiSend(page.request, "patch", `/perfin/api/subscriptions/${subId}/dismiss`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 9 ─────────────────────────────────────────────────────────────────────────
  test("Dashboard: a logged credit score becomes the current one, and removing it brings the earlier one back", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const source = `E5 Bureau ${t}`;
    const scores = async () => (await apiJson(page.request, "/perfin/api/credit-scores?limit=12")).scores || [];
    let id = null;
    try {
      await page.goto("/perfin/dashboard");
      const widget = page.locator("#credit-score-widget");
      await widget.locator("#cs-score-input").fill("611");
      await widget.locator("#cs-type-input").selectOption("other");
      await widget.locator("#cs-source-input").fill(source);
      await widget.getByRole("button", { name: "Log score" }).click();
      await expect(widget.locator("#cs-status")).toHaveText("Logged ✓");
      // (a) the widget re-reads: 611 is the current score and the form is cleared.
      await expect(widget.locator("#credit-score-current")).toHaveText("611");
      await expect(widget.locator("#cs-score-input")).toHaveValue("");
      // (b) the API: the newest entry, with its type and source.
      const [latest] = await scores();
      expect(latest).toMatchObject({ score: 611, score_type: "other", source });
      id = latest.id;
      // (c) after a reload.
      await page.reload();
      await expect(page.locator("#credit-score-current")).toHaveText("611");
    } finally {
      // Its own entry — removed so the seeded score is current again.
      if (id) await apiSend(page.request, "delete", `/perfin/api/credit-scores/${id}`);
    }
    const after = await scores();
    expect(after.find((s) => s.source === source)).toBeUndefined();
    await page.reload();
    await expect(page.locator("#credit-score-current")).toHaveText(after.length ? String(after[0].score) : "");
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 10 ────────────────────────────────────────────────────────────────────────
  test("Settings: switching the theme applies it, stores it, and survives a reload without the local copy", async ({ page }) => {
    const problems = watch(page);
    const start = (await settingsOf(page.request)).theme || "dark";
    const other = start === "dark" ? "light" : "dark";
    const html = page.locator("html");
    await openSettings(page);
    await expect(page.locator("#theme-select")).toHaveValue(start);
    try {
      await page.locator("#theme-select").selectOption(other);
      await expect(toast(page, "Setting saved.")).toBeVisible();
      // (a) the page switches at once.
      await expect(html).toHaveAttribute("data-theme", other);
      // (b) the API.
      expect((await settingsOf(page.request)).theme).toBe(other);
      // (c) a reload with the browser's copy gone still comes back in it —
      // the stored setting, not localStorage, decides.
      await page.evaluate(() => localStorage.removeItem("perfin-theme"));
      await openSettings(page);
      await expect(html).toHaveAttribute("data-theme", other);
      await expect(page.locator("#theme-select")).toHaveValue(other);
      // Put back through the page.
      await page.locator("#theme-select").selectOption(start);
      await expect(html).toHaveAttribute("data-theme", start);
      await expect.poll(async () => (await settingsOf(page.request)).theme).toBe(start);
    } finally {
      if ((await settingsOf(page.request)).theme !== start) await apiSend(page.request, "patch", "/perfin/api/settings", { theme: start });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 11 ────────────────────────────────────────────────────────────────────────
  test("Settings: switching a dashboard widget off hides it on the dashboard, and on again shows it", async ({ page }) => {
    const problems = watch(page);
    const box = page.locator('#widget-toggles input[data-widget="charts"]');
    const charts = page.locator(".charts-grid").first();
    const widgetsOf = async () => (await settingsOf(page.request)).dashboard_widgets || {};
    expect((await widgetsOf()).charts).not.toBe(false);
    try {
      await openSettings(page);
      await expect(box).toBeChecked();
      await box.uncheck();
      await expect(toast(page, "Setting saved.")).toBeVisible();
      await expect(box).not.toBeChecked(); // a saved switch stays where it was put
      // (b) the API.
      await expect.poll(async () => (await widgetsOf()).charts).toBe(false);
      // (a) the dashboard hides the section.
      await page.goto("/perfin/dashboard");
      await expect(charts).toHaveClass(/\bwidget-off\b/);
      await expect(charts).toBeHidden();
      // (c) after a reload, on both pages.
      await page.reload();
      await expect(charts).toBeHidden();
      await openSettings(page);
      await expect(box).not.toBeChecked();
      // Put back through the page.
      await box.check();
      await expect.poll(async () => (await widgetsOf()).charts).toBe(true);
      await expect(box).toBeChecked();
      await page.goto("/perfin/dashboard");
      await expect(charts).toBeVisible();
      await expect(charts).not.toHaveClass(/\bwidget-off\b/);
    } finally {
      const w = await widgetsOf();
      if (w.charts === false) await apiSend(page.request, "patch", "/perfin/api/settings", { dashboard_widgets: { ...w, charts: true } });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 12 ────────────────────────────────────────────────────────────────────────
  test("Settings: a switch whose save is refused goes back, and one that saves stays (F38)", async ({ page }) => {
    const problems = watch(page);
    const stored = async () => (await settingsOf(page.request)).insight_emails_enabled !== false;
    const start = await stored();
    const input = page.locator("#insight-email-toggle");
    // The checkbox is visually hidden inside its slider; a person clicks the slider.
    const slider = page.locator("label.toggle", { has: input });
    const expectChecked = (on) => (on ? expect(input).toBeChecked() : expect(input).not.toBeChecked());
    try {
      await openSettings(page);
      await expectChecked(start);
      // Refused: the server answers the PATCH with a 400.
      let refused = 0;
      await page.route("**/perfin/api/settings", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        refused++;
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "E5 refused this save" }) });
      });
      await slider.click();
      await expect(toast(page, "E5 refused this save")).toBeVisible();
      expect(refused).toBe(1);
      // (a) the switch shows what is stored again; (b) nothing changed on the server.
      await expectChecked(start);
      expect(await stored()).toBe(start);
      await page.unroute("**/perfin/api/settings");

      // Saved: it stays flipped, the API agrees, a reload shows it.
      await slider.click();
      await expect(toast(page, "Setting saved.")).toBeVisible();
      await expectChecked(!start);
      expect(await stored()).toBe(!start);
      await openSettings(page);
      await expectChecked(!start);
      // Put back through the page.
      await slider.click();
      await expectChecked(start);
      await expect.poll(stored).toBe(start);
    } finally {
      if ((await stored()) !== start) await apiSend(page.request, "patch", "/perfin/api/settings", { insight_emails_enabled: start });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  // 13 ────────────────────────────────────────────────────────────────────────
  test("Bell: Mark all read clears the unread badge, in the API and after a reload", async ({ page }) => {
    const problems = watch(page);
    const t = tagOf();
    const title = `E5 bell ${t}`;
    const id = await perfinDb(async (db) => (await db.query(
      `INSERT INTO notification_log (type, title, body, data, is_read) VALUES ('e5-test', $1, 'A behaviour-test notification.', '{}'::jsonb, false) RETURNING id`,
      [title])).rows[0].id);
    const unread = async () => (await apiJson(page.request, "/perfin/api/notifications?unread=true&limit=50"));
    try {
      await page.goto("/perfin/goals");
      const bell = page.locator("#nav-notif-bell");
      const badge = page.locator("#nav-notif-count");
      await expect(badge).toBeVisible();
      await expect(bell).toHaveAttribute("aria-label", /unread/);
      await bell.click();
      const item = page.locator(`#notif-list [data-nid="${id}"]`);
      await expect(item).toHaveAttribute("aria-label", new RegExp(title + ", unread"));
      await page.locator("#notif-mark-all").click();
      // (a) the badge goes and the open list re-renders the row as read.
      await expect(badge).toBeHidden();
      await expect(bell).toHaveAttribute("aria-label", "Notifications");
      await expect(item).not.toHaveAttribute("aria-label", /unread/);
      // (b) the API: the row is read (no longer in the unread list).
      expect((await unread()).notifications.find((n) => Number(n.id) === Number(id))).toBeUndefined();
      // (c) after a reload.
      await page.reload();
      await expect(page.locator("#nav-notif-bell")).toHaveAttribute("aria-label", "Notifications");
      await expect(page.locator("#nav-notif-count")).toBeHidden();
    } finally {
      // Its own row — removed (the others it marked read stay read).
      await perfinDb((db) => db.query("DELETE FROM notification_log WHERE id = $1", [id]));
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
