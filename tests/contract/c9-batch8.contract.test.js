// Real-Postgres contract test for the cycle-9 broad scan, Batch 8 — Per-sistant
// behaviour, plus the two Perfin categorize / detection items:
//  - F52: saving a task with its due date unchanged keeps the month-end
//    anchor; a changed date clears it
//  - F55: a skipped instance is not a completion (/api/stats), a snoozed task's
//    next instance steps from the date before the snooze, and a recurring
//    task with no rule is neither rolled nightly nor impossible to complete
//  - F53: a profile save with the same text keeps the fit scores; changed
//    text clears them
//  - F56: a todo made from a secret note carries no note text
//  - F54: a past-due scheduled email is reported while SMTP isn't set up
//  - F27: the review write and a rename-rule delete on the real schema, a
//    manual bill's non-string name refused, the stale sweeps leaving an
//    already-inactive row's updated_at alone
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const supertest = require("supertest");
const { SKIP, ROOT, perfinDb, persistentDb, perfinApp, persistentApp } = require("./_setup");

describe("cycle-9 Batch 8 on real Postgres", { skip: SKIP }, () => {
  let psPool, pfPool, psApp, pfApp, today, helpers;
  const ps = (s, p) => psPool.query(s, p);
  const pf = (s, p) => pfPool.query(s, p);
  const plus = (ymd, days) => new Date(Date.parse(ymd + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  const todo = async (id) => (await ps("SELECT * FROM todos WHERE id = $1", [id])).rows[0];
  const savedSmtp = process.env.SMTP_HOST;

  before(async () => {
    psPool = await persistentDb("c9_batch8");
    pfPool = await perfinDb("c9_batch8");
    psApp = persistentApp(psPool);
    pfApp = perfinApp();
    helpers = require(path.join(ROOT, "apps/per-sistant/helpers"));
    today = require(path.join(ROOT, "apps/per-sistant/routes/health")).todayStr();
    delete process.env.SMTP_HOST;
  });
  after(async () => {
    if (savedSmtp === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = savedSmtp;
    if (psPool) await psPool.end();
    if (pfPool) await pfPool.end();
  });

  // ------------------------------------------------------------------ F52
  it("F52: an edit that keeps the due date keeps the anchor; a new date clears it", async () => {
    const id = (await ps(
      `INSERT INTO todos (title, due_date, recurring, recurrence_rule, recurrence_interval, recurrence_anchor_day)
       VALUES ('Pay rent', '2027-02-28', true, 'monthly', 1, 31) RETURNING id`)).rows[0].id;
    // What the edit dialog sends for a title change: every field, the due date included.
    const r = await supertest(psApp).patch("/api/todos/" + id)
      .send({ title: "Pay the rent", due_date: "2027-02-28", recurring: true, recurrence_rule: "monthly", recurrence_interval: 1 }).expect(200);
    assert.equal(r.body.recurrence_anchor_day, 31);
    assert.equal((await todo(id)).title, "Pay the rent");
    const moved = await supertest(psApp).patch("/api/todos/" + id).send({ due_date: "2027-03-05" }).expect(200);
    assert.equal(moved.body.recurrence_anchor_day, null);
    assert.equal(moved.body.due_date, "2027-03-05");
  });

  // ------------------------------------------------------------------ F55
  it("F55: a skip is not a completion; a real completion is", async () => {
    const done0 = Number((await supertest(psApp).get("/api/stats").expect(200)).body.todos.done);
    const a = (await supertest(psApp).post("/api/todos").send({ title: "Water plants", due_date: today, recurring: true, recurrence_rule: "weekly" }).expect(200)).body;
    const skipped = (await supertest(psApp).post(`/api/todos/${a.id}/skip-recurring`).expect(200)).body;
    const row = await todo(a.id);
    assert.deepEqual([row.completed, row.completed_at, row.skipped, row.skipped_count], [true, null, true, 1]);
    assert.equal(Number((await supertest(psApp).get("/api/stats").expect(200)).body.todos.done), done0, "a skip isn't done");
    assert.equal(skipped.next.due_date, plus(today, 7));
    // The next instance, completed for real, counts.
    await supertest(psApp).post(`/api/todos/${skipped.next.id}/complete-recurring`).expect(200);
    assert.equal(Number((await supertest(psApp).get("/api/stats").expect(200)).body.todos.done), done0 + 1);
    // Skipping twice (a double tap) is refused, and undo doesn't treat a skip as a completion.
    await supertest(psApp).post(`/api/todos/${a.id}/skip-recurring`).expect(400);
    await supertest(psApp).post(`/api/todos/${a.id}/undo-complete-recurring`).send({ next_id: skipped.next.id }).expect(400);
  });

  it("F55: a snoozed task's next instance steps from the date before the snooze", async () => {
    const a = (await supertest(psApp).post("/api/todos").send({ title: "Team report", due_date: today, recurring: true, recurrence_rule: "weekly" }).expect(200)).body;
    const snoozed = (await supertest(psApp).post(`/api/todos/${a.id}/snooze`).send({ until: plus(today, 2) }).expect(200)).body;
    assert.deepEqual([snoozed.due_date, snoozed.snoozed_from], [plus(today, 2), today]);
    // A second snooze keeps the ORIGINAL date.
    const again = (await supertest(psApp).post(`/api/todos/${a.id}/snooze`).send({ until: plus(today, 3) }).expect(200)).body;
    assert.equal(again.snoozed_from, today);
    const done = (await supertest(psApp).post(`/api/todos/${a.id}/complete-recurring`).expect(200)).body;
    assert.equal(done.next.due_date, plus(today, 7), "one week from the original day — not from the snoozed one");
    assert.equal(done.next.snoozed_from, null);

    // A monthly task: the snooze stores the chain's day of month, so the snoozed day never becomes the anchor.
    const m = (await supertest(psApp).post("/api/todos").send({ title: "Rent", due_date: "2027-01-31", recurring: true, recurrence_rule: "monthly" }).expect(200)).body;
    const ms = (await supertest(psApp).post(`/api/todos/${m.id}/snooze`).send({ until: "2027-02-03" }).expect(200)).body;
    assert.deepEqual([ms.recurrence_anchor_day, ms.snoozed_from, ms.due_date], [31, "2027-01-31", "2027-02-03"]);
    assert.equal(helpers.ymdLocal(helpers.nextDueAfter(await todo(m.id), "2027-02-03")), "2027-02-28");
    // An explicit new due date is a new schedule: the pre-snooze date goes with the anchor.
    const edited = (await supertest(psApp).patch("/api/todos/" + m.id).send({ due_date: "2027-02-10" }).expect(200)).body;
    assert.deepEqual([edited.snoozed_from, edited.recurrence_anchor_day], [null, null]);
  });

  it("F55: a recurring task with no rule is not rolled nightly and can be completed", async () => {
    const id = (await ps("INSERT INTO todos (title, due_date, recurring, recurrence_rule) VALUES ('Odd one', $1, true, NULL) RETURNING id", [plus(today, -3)])).rows[0].id;
    const before = Number((await ps("SELECT count(*) AS n FROM todos WHERE title = 'Odd one'")).rows[0].n);
    await helpers.rollMissedRecurring(psPool, today);
    await helpers.rollMissedRecurring(psPool, today);
    assert.equal(Number((await ps("SELECT count(*) AS n FROM todos WHERE title = 'Odd one'")).rows[0].n), before, "no copy made");
    assert.equal((await todo(id)).completed, false);
    const out = (await supertest(psApp).post(`/api/todos/${id}/complete-recurring`).expect(200)).body;
    assert.equal(out.next, null);
    const row = await todo(id);
    assert.equal(row.completed, true);
    assert.ok(row.completed_at);
    // A recurring task WITH a rule that is overdue is still rolled (and marked missed).
    const r = (await ps("INSERT INTO todos (title, due_date, recurring, recurrence_rule) VALUES ('Daily walk', $1, true, 'daily') RETURNING id", [plus(today, -2)])).rows[0].id;
    assert.equal((await helpers.rollMissedRecurring(psPool, today)).rolled, 1);
    assert.equal((await todo(r)).missed, true);
  });

  // ------------------------------------------------------------------ F53
  it("F53: the same profile text keeps the fit scores; changed text clears them", async () => {
    await supertest(psApp).patch("/api/job-profile").send({ resume_text: "Ten years of Go", preferences_text: "Remote, staff level" }).expect(200);
    const listing = (await ps(
      `INSERT INTO job_listings (content_hash, title, company, status, fit_score, fit_rationale, trust_score)
       VALUES ('c9b8-hash', 'Staff Engineer', 'Globex', 'new', 82, 'Strong match', 90) RETURNING id`)).rows[0].id;
    // The page's save: both text fields unchanged, plus the other fields.
    const same = await supertest(psApp).patch("/api/job-profile")
      .send({ preferences_text: "Remote, staff level", resume_text: "Ten years of Go", remote_pref: "remote", locations: ["NYC"], min_salary: 150000 }).expect(200);
    assert.equal(same.body.rescore_needed, false);
    assert.equal(Number(same.body.min_salary), 150000);
    assert.ok(!("prev_resume_text" in same.body));
    assert.equal((await ps("SELECT fit_score FROM job_listings WHERE id = $1", [listing])).rows[0].fit_score, 82);
    const changed = await supertest(psApp).patch("/api/job-profile").send({ resume_text: "Ten years of Go and Rust", preferences_text: "Remote, staff level" }).expect(200);
    assert.equal(changed.body.rescore_needed, true);
    assert.equal((await ps("SELECT fit_score FROM job_listings WHERE id = $1", [listing])).rows[0].fit_score, null);
  });

  // ------------------------------------------------------------------ F56
  it("F56: a todo made from a secret note carries no note text; a normal note's does", async () => {
    const secret = (await supertest(psApp).post("/api/notes").send({ content: "The safe code is 99-12-45", sensitivity: "secret" }).expect(200)).body;
    const t = (await supertest(psApp).post(`/api/notes/${secret.id}/create-todo`).send({}).expect(200)).body;
    assert.deepEqual([t.title, t.description], ["Secret note", null]);
    assert.equal(Number((await ps("SELECT count(*) AS n FROM entity_links WHERE source_type = 'note' AND source_id = $1 AND target_id = $2", [secret.id, t.id])).rows[0].n), 1);
    assert.equal(Number((await ps("SELECT count(*) AS n FROM todos WHERE title LIKE '%99-12-45%' OR description LIKE '%99-12-45%'")).rows[0].n), 0);
    const priv = (await supertest(psApp).post("/api/notes").send({ title: "Therapy", content: "Session notes", sensitivity: "private" }).expect(200)).body;
    const pt = (await supertest(psApp).post(`/api/notes/${priv.id}/create-todo`).send({}).expect(200)).body;
    assert.deepEqual([pt.title, pt.description], ["Therapy", null]);
    const normal = (await supertest(psApp).post("/api/notes").send({ content: "Buy milk and eggs" }).expect(200)).body;
    const nt = (await supertest(psApp).post(`/api/notes/${normal.id}/create-todo`).send({}).expect(200)).body;
    assert.deepEqual([nt.title, nt.description], ["Buy milk and eggs", "Buy milk and eggs"]);
  });

  // ------------------------------------------------------------------ F54
  it("F54: a past-due scheduled email is reported while email sending isn't set up", async () => {
    const check = async () => (await supertest(psApp).get("/api/notifications/check").expect(200)).body;
    assert.equal((await check()).notifications.find((n) => n.id === "smtp-not-configured"), undefined, "nothing waiting yet");
    await ps(`INSERT INTO emails (recipient_email, subject, body, status, scheduled_at)
              VALUES ('me@example.com', 'Weekly digest', 'x', 'scheduled', now() - interval '2 days'),
                     ('me@example.com', 'Later', 'x', 'scheduled', now() + interval '2 days'),
                     ('me@example.com', 'A draft', 'x', 'draft', NULL)`);
    const body = await check();
    const n = body.notifications.find((x) => x.id === "smtp-not-configured");
    assert.equal(n.type, "email_failed");
    assert.match(n.title, /^1 scheduled email is waiting since \d{4}-\d{2}-\d{2} — email sending isn't set up \(SMTP_HOST\)$/);
    assert.equal(body.counts.email_waiting, 1);
    process.env.SMTP_HOST = "smtp.example";
    try {
      assert.equal((await check()).notifications.find((x) => x.id === "smtp-not-configured"), undefined, "the sender takes them once SMTP is set");
    } finally { delete process.env.SMTP_HOST; }
  });

  // ------------------------------------------------------------------ F27
  it("F27: the review write, a rename-rule delete and a manual bill's name on the real schema", async () => {
    const acct = (await supertest(pfApp).post("/api/accounts/manual").send({ name: "C9B8 Cash", type: "depository" }).expect(200)).body;
    const txn = (await supertest(pfApp).post("/api/transactions/manual")
      .send({ account_id: acct.account_id, amount: 4.5, date: today, merchant_name: "Blue Bottle" }).expect(200)).body;
    const tid = txn.transaction_id;

    const review = await supertest(pfApp).post("/api/categorize/review").send({ transaction_id: tid, category: "Food & Drink", create_rule: true }).expect(200);
    assert.equal(review.body.rule_created, true);
    assert.equal((await pf("SELECT user_category FROM transactions WHERE transaction_id = $1", [tid])).rows[0].user_category, "Food & Drink");
    assert.deepEqual((await pf("SELECT category, match_type, is_active FROM categorization_rules WHERE merchant_pattern = 'Blue Bottle'")).rows,
      [{ category: "Food & Drink", match_type: "exact", is_active: true }]);
    // Re-pointing the merchant deactivates the first rule in the same write.
    await supertest(pfApp).post("/api/categorize/review").send({ transaction_id: tid, category: "Shopping", create_rule: true }).expect(200);
    assert.deepEqual((await pf("SELECT category, is_active FROM categorization_rules WHERE merchant_pattern = 'Blue Bottle' ORDER BY category")).rows,
      [{ category: "Food & Drink", is_active: false }, { category: "Shopping", is_active: true }]);
    await supertest(pfApp).post("/api/categorize/review").send({ transaction_id: "no-such-txn", category: "Shopping", create_rule: true }).expect(404);

    const rule = (await supertest(pfApp).post("/api/merchant-rename-rules").send({ merchant_pattern: "Blue Bottle", rename_to: "Blue Bottle Coffee" }).expect(200)).body;
    assert.equal((await pf("SELECT user_merchant_name FROM transactions WHERE transaction_id = $1", [tid])).rows[0].user_merchant_name, "Blue Bottle Coffee");
    const del = await supertest(pfApp).delete("/api/merchant-rename-rules/" + rule.rule.id).expect(200);
    assert.equal(del.body.reverted, 1);
    assert.deepEqual((await pf("SELECT user_merchant_name, user_merchant_rule_id FROM transactions WHERE transaction_id = $1", [tid])).rows[0],
      { user_merchant_name: null, user_merchant_rule_id: null });
    assert.equal(Number((await pf("SELECT count(*) AS n FROM merchant_rename_rules")).rows[0].n), 0);
    await supertest(pfApp).delete("/api/merchant-rename-rules/" + rule.rule.id).expect(404);

    const bill = (await supertest(pfApp).post("/api/manual-bills").send({ name: "Water", amount: 40, due_day: 12, cadence: "monthly", category: "utility" })).body;
    assert.ok(bill.id, "the bill was created");
    await supertest(pfApp).patch("/api/manual-bills/" + bill.id).send({ name: 123 }).expect(400);
    await supertest(pfApp).patch("/api/manual-bills/" + bill.id).send({ name: "   " }).expect(400);
    assert.equal((await pf("SELECT name FROM manual_bills WHERE id = $1", [bill.id])).rows[0].name, "Water");
    assert.equal((await supertest(pfApp).patch("/api/manual-bills/" + bill.id).send({ name: " Water & sewer " }).expect(200)).body.name, "Water & sewer");
  });

  it("F27: the stale sweeps deactivate a live stale row and leave an inactive one's updated_at alone", async () => {
    await pf(`INSERT INTO detected_subscriptions (merchant_key, display_name, amount, cadence_days, first_seen, last_charged, next_expected, is_active, updated_at)
              VALUES ('old gym', 'Old Gym', 30, 30, '2024-01-01', '2024-06-01', '2024-07-01', false, '2025-01-01T00:00:00Z'),
                     ('old mag', 'Old Mag', 9, 30, '2024-01-01', '2024-06-01', '2024-07-01', true, '2025-01-01T00:00:00Z')`);
    await pf(`INSERT INTO recurring_transfers (merchant_key, display_name, amount, cadence_days, first_seen, last_transferred, next_expected, is_active, updated_at)
              VALUES ('old zelle', 'Old Zelle', 100, 30, '2024-01-01', '2024-06-01', '2024-07-01', false, '2025-01-01T00:00:00Z'),
                     ('old ach', 'Old ACH', 50, 30, '2024-01-01', '2024-06-01', '2024-07-01', true, '2025-01-01T00:00:00Z')`);
    await require("../../scripts/detect-subscriptions").detectSubscriptions(pfPool);
    await require("../../scripts/detect-transfers").detectRecurringTransfers(pfPool);
    const subs = Object.fromEntries((await pf("SELECT merchant_key, is_active, (updated_at = '2025-01-01T00:00:00Z') AS untouched FROM detected_subscriptions WHERE merchant_key LIKE 'old %'")).rows.map((r) => [r.merchant_key, r]));
    assert.deepEqual([subs["old gym"].is_active, subs["old gym"].untouched], [false, true]);
    assert.deepEqual([subs["old mag"].is_active, subs["old mag"].untouched], [false, false]);
    const trs = Object.fromEntries((await pf("SELECT merchant_key, is_active, (updated_at = '2025-01-01T00:00:00Z') AS untouched FROM recurring_transfers WHERE merchant_key LIKE 'old %'")).rows.map((r) => [r.merchant_key, r]));
    assert.deepEqual([trs["old zelle"].is_active, trs["old zelle"].untouched], [false, true]);
    assert.deepEqual([trs["old ach"].is_active, trs["old ach"].untouched], [false, false]);
  });
});
