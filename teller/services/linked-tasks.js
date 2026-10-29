// Linked tasks — Perfin's side (roadmap T2.4). Perfin owns the facts, so it
// works out which Per-sistant tasks should be open right now; Per-sistant's
// services/linked-tasks.js stores them (X2b wires the two together). Pure
// reads: nothing here writes to either database.
//
// computeLinkedTasks(pool, cfg, today) → { ok_kinds, desired, retain, errors }
//   desired  [{ key, title, description, url, due_date, priority }] — the
//            tasks that should be open, keyed '<app>:<kind>:<id>'
//   retain   keys still open in Perfin but past the window that creates a
//            task (an unpaid manual bill older than 30 days) — an open task
//            stays open, nothing new is created (cycle-8 F17)
//   ok_kinds the kinds whose source was read this run; only these may close
//            tasks (a failed query must never read as "resolved")
//   errors   [{ kind, error }] — a fixed sentence per failed source
// Each source runs in its own try/catch. cfg = { sources, bill_lead_days }
// (user_settings.linked_tasks_*); a source switched off is not read at all.
// Task shape (decision 6): category finance and a short horizon are set by
// Per-sistant; source_url is a path inside Perfin ('/housing') that the task
// chip joins with Perfin's mount.
const { todayStr } = require("./financial-queries");
const { manualBillOccurrences } = require("./cadence");

const APP = "perfin";
// Settings key → task kind (the second segment of the key).
const SOURCES = {
  still_charging: "still-charging",
  housing: "housing",
  utility_amount: "utility-amount",
  bills: "bill",
  tax_documents: "tax-doc", // roadmap T3.3 K2
};
const SOURCE_KEYS = Object.keys(SOURCES);
// Decision 5: manual bills are off by default — an autopaid bill nobody marks
// paid would leave its task open.
// Roadmap T3.3 K2 (decision 6): missing tax forms are on by default — the
// whole feature still waits for linked_tasks_enabled.
const DEFAULT_SOURCES = { still_charging: true, housing: true, utility_amount: true, bills: false, tax_documents: true };
const BILL_OVERDUE_DAYS = 30;

const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The stored sources map over the defaults (a missing key keeps its default).
function effectiveSources(raw) {
  const out = { ...DEFAULT_SOURCES };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of SOURCE_KEYS) if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  return out;
}

// Rent & utilities due: one task per period that has unpaid items, inside the
// payment-due window (housing.rentReminderOpen — the reminder's own rule) or
// overdue; next month's rent once its window opens before its row exists
// (nextRentInLeadWindow, as the reminder does — F43). Payee-scoped.
async function housingTasks(pool, hcfg, today) {
  const housing = require("../routes/housing");
  const r = await pool.query(
    `SELECT period, label, amount FROM payee_obligations
      WHERE status = 'unpaid' AND payee = $1 AND amount IS NOT NULL
      ORDER BY period, category, label`,
    [hcfg.payee_name]
  );
  const byPeriod = new Map();
  for (const row of r.rows) {
    if (!byPeriod.has(row.period)) byPeriod.set(row.period, []);
    byPeriod.get(row.period).push({ label: row.label, amount: parseFloat(row.amount) });
  }
  const next = hcfg.rent_amount > 0 ? housing.nextRentInLeadWindow(hcfg, today) : null;
  if (next && !byPeriod.has(next.period)) {
    const ex = await pool.query(
      `SELECT (EXISTS (SELECT 1 FROM payee_obligations WHERE period = $1 AND category = 'rent')
            OR EXISTS (SELECT 1 FROM payee_obligation_skips WHERE period = $1 AND category = 'rent')) AS has`,
      [next.period]
    );
    if (!(ex.rows[0] && ex.rows[0].has)) byPeriod.set(next.period, [{ label: "Rent", amount: hcfg.rent_amount }]);
  }
  const out = [];
  for (const [period, items] of byPeriod) {
    if (!housing.rentReminderOpen(period, hcfg, today)) continue;
    const due = housing.periodDueDate(period, hcfg.rent_due_day);
    const total = items.reduce((s, i) => s + i.amount, 0);
    const label = housing.periodLabel(period);
    out.push({
      key: `${APP}:housing:${period}`,
      title: clip(`Pay ${hcfg.payee_name} for ${label}`, 300),
      description: clip(`${money(total)} owed: ${items.map((i) => i.label + " " + money(i.amount)).join(", ")}. Record the payment on Perfin's Rent page.`, 2000),
      url: "/housing",
      due_date: due,
      priority: today > due ? "urgent" : "high",
    });
  }
  return out;
}

// A utility bill that should have arrived but has no amount yet (the
// missing-amount reminder's rule, housing.utilityAmountDue). Due on the day
// the bill was due — a fixed date, so the task can show as overdue.
async function utilityAmountTasks(pool, hcfg, today) {
  const housing = require("../routes/housing");
  const r = await pool.query(
    `SELECT id, label, period, due_day FROM payee_obligations
      WHERE status = 'pending_amount' AND payee = $1 ORDER BY period, id`,
    [hcfg.payee_name]
  );
  return r.rows.filter((o) => housing.utilityAmountDue(o, today)).map((o) => ({
    key: `${APP}:utility-amount:${o.id}`,
    title: clip(`Enter the ${o.label} amount for ${housing.periodLabel(o.period)}`, 300),
    description: "The bill should have arrived — add its amount on Perfin's Rent page.",
    url: "/housing#pending",
    due_date: housing.periodDueDate(o.period, o.due_day),
    priority: "medium",
  }));
}

// The first day of the month a value (a DATE / timestamp, or 'YYYY-MM-DD…')
// falls in — read like cadence.parseYmd reads a bill's created_at.
function monthStartOf(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-01`;
  const s = String(v || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s + "-01" : null;
}

// Manual bills: every occurrence from 30 days ago to `lead` days ahead
// (manualBillOccurrences — the calendar's own placement rule) without a
// bill_payments row for that date gets a task. An unpaid occurrence OLDER than
// that window is still unpaid, so its key is retained, not dropped: dropping
// it closed the task as completed on day 31 (cycle-8 F17). → { desired, retain }
async function billTasks(pool, leadDays, today) {
  const from = addDays(today, -BILL_OVERDUE_DAYS);
  const to = addDays(today, leadDays);
  const bills = await pool.query(
    "SELECT id, name, amount, due_day, cadence, created_at FROM manual_bills WHERE is_active = true ORDER BY id"
  );
  if (!bills.rows.length) return { desired: [], retain: [] };
  const starts = bills.rows.map((b) => monthStartOf(b.created_at)).filter(Boolean).sort();
  const earliest = starts[0] && starts[0] < from ? starts[0] : from;
  const paid = await pool.query(
    `SELECT bill_id, paid_date::text AS paid_date FROM bill_payments
      WHERE bill_source = 'manual' AND paid_date BETWEEN $1 AND $2`,
    [earliest, to]
  );
  const paidSet = new Set(paid.rows.map((p) => p.bill_id + "|" + p.paid_date));
  const out = [];
  const retain = [];
  const beforeWindow = addDays(from, -1);
  for (const b of bills.rows) {
    const start = monthStartOf(b.created_at);
    if (start && start <= beforeWindow) {
      for (const date of manualBillOccurrences(b, start, beforeWindow)) {
        if (!paidSet.has(b.id + "|" + date)) retain.push(`${APP}:bill:${b.id}:${date}`);
      }
    }
    for (const date of manualBillOccurrences(b, from, to)) {
      if (paidSet.has(b.id + "|" + date)) continue;
      out.push({
        key: `${APP}:bill:${b.id}:${date}`,
        title: clip(`Pay ${b.name}`, 300),
        description: `${money(parseFloat(b.amount))} due ${date}. Mark it paid on Perfin's bill calendar.`,
        url: "/calendar",
        due_date: date,
        priority: date < today ? "high" : "medium",
      });
    }
  }
  return { desired: out, retain };
}

// Tax forms that haven't arrived (roadmap T3.3 K2, decision 6): an open
// checklist row (not received, not dismissed) whose expected_by has passed.
// Marking it received or dismissed — or deleting a manual one — drops it from
// the set, which closes the task.
async function taxDocumentTasks(pool, today) {
  const r = await pool.query(
    `SELECT id, tax_year, form, issuer, expected_by::text AS expected_by FROM tax_documents
      WHERE received_at IS NULL AND dismissed_at IS NULL
        AND expected_by IS NOT NULL AND expected_by < $1::date
      ORDER BY expected_by, id`,
    [today]
  );
  return r.rows.map((d) => {
    const form = d.form === "other" ? "tax form" : d.form;
    return {
      key: `${APP}:tax-doc:${d.id}`,
      title: clip(`Find your ${d.tax_year} ${form}${d.issuer ? " from " + d.issuer : ""}`, 300),
      description: `It usually arrives by ${d.expected_by}. Mark it received (or dismiss it) on Perfin's Tax page.`,
      url: "/tax#documents",
      due_date: d.expected_by,
      priority: "medium",
    };
  });
}

async function computeLinkedTasks(pool, cfg = {}, today = todayStr()) {
  const sources = effectiveSources(cfg.sources);
  const lead = Number.isInteger(cfg.bill_lead_days) && cfg.bill_lead_days >= 0 && cfg.bill_lead_days <= 14 ? cfg.bill_lead_days : 3;
  const result = { ok_kinds: [], desired: [], retain: [], errors: [] };
  const run = async (key, fn) => {
    if (!sources[key]) return;
    const kind = SOURCES[key];
    try {
      const got = await fn();
      if (Array.isArray(got)) result.desired.push(...got);
      else { result.desired.push(...got.desired); result.retain.push(...(got.retain || [])); }
      result.ok_kinds.push(kind);
    } catch (e) {
      console.error(`linked tasks: ${kind} source failed:`, e.message);
      result.errors.push({ kind, error: "Could not read this source." });
    }
  };

  // Housing config read once for both housing sources; a failed read fails both.
  let hcfg = null;
  if (sources.housing || sources.utility_amount) {
    try { hcfg = await require("../routes/housing").getConfig(pool); }
    catch (e) {
      console.error("linked tasks: housing config read failed:", e.message);
      for (const key of ["housing", "utility_amount"]) {
        if (sources[key]) result.errors.push({ kind: SOURCES[key], error: "Could not read the Rent & Utilities settings." });
      }
    }
  }
  const ledgerOn = hcfg && hcfg.enabled && hcfg.payee_name;
  if (hcfg) {
    // A ledger that isn't set up has nothing due — read as resolved.
    await run("housing", () => (ledgerOn ? housingTasks(pool, hcfg, today) : []));
    await run("utility_amount", () => (ledgerOn ? utilityAmountTasks(pool, hcfg, today) : []));
  }
  await run("bills", () => billTasks(pool, lead, today));
  await run("tax_documents", () => taxDocumentTasks(pool, today));
  return result;
}

// ---------------------------------------------------------------------------
// The runner (roadmap T2.4 X2b): compute, then reconcile Per-sistant's linked
// tasks through ITS module (services/linked-tasks.js there — lazy, only when
// the shell wired its pool). Only kinds read this run (ok_kinds) may close
// tasks; a source switched off is neither read nor closed, so its tasks stay
// as they are. Single-flight: a call during a run makes it go round once more
// (the data it was called about may postdate the running computation) and
// shares its promise. While the switch is off, the settings are read once a
// local day (invalidate() from PATCH /api/settings).
// The hourly tick (scheduled: true) runs once a local day (cycle-8 F21): every
// write that can change a task already kicks a refresh, so between those the
// only change is the date moving a window. After a clean run (status ok) the
// tick is a no-op — no read of either database — until the next local day, a
// kick, Run now or invalidate(); a partial run is retried the next hour.
// ---------------------------------------------------------------------------
const SYNC_ERROR = "Could not update the tasks in Per-sistant.";
let _disabledDay = null;
let _freshDay = null;
let _running = null;
let _again = false;

function invalidate() { _disabledDay = null; _freshDay = null; }
function isRunning() { return !!_running; }

function defaultPersistentPool() {
  try { return require("../routes/persistent").getEmbeddedPersistentPool(); }
  catch (e) { console.error("linked tasks: Per-sistant pool lookup failed:", e.message); return null; }
}

function persistentLinkedTasks() {
  return require("../../apps/per-sistant/services/linked-tasks");
}

async function readSettings(pool) {
  const r = await pool.query("SELECT linked_tasks_enabled, linked_tasks_sources, linked_tasks_bill_lead_days FROM user_settings WHERE id = 1");
  const s = r.rows[0] || {};
  return { enabled: !!s.linked_tasks_enabled, sources: effectiveSources(s.linked_tasks_sources), bill_lead_days: s.linked_tasks_bill_lead_days };
}

async function runOnce(pool, persistentPool, today, deps) {
  if (_disabledDay === today) return { status: "disabled", ran: false };
  const cfg = await readSettings(pool);
  if (!cfg.enabled) { _disabledDay = today; return { status: "disabled", ran: false }; }
  const compute = deps.compute || computeLinkedTasks;
  const sync = deps.sync || ((p, args) => persistentLinkedTasks().syncLinkedTasks(p, args));
  const computed = await compute(pool, cfg, today);
  const errors = [...computed.errors];
  let counts = { created: 0, updated: 0, closed: 0, reopened: 0, skipped: 0 };
  try {
    counts = { ...counts, ...(await sync(persistentPool, { app: APP, kinds: computed.ok_kinds, desired: computed.desired, retain: computed.retain || [] })) };
  } catch (e) {
    console.error("linked tasks: Per-sistant sync failed:", e.message);
    errors.push({ kind: null, error: SYNC_ERROR });
  }
  const state = { at: new Date().toISOString(), desired: computed.desired.length, ...counts, errors };
  try {
    await pool.query("UPDATE user_settings SET linked_tasks_state = $1 WHERE id = 1", [JSON.stringify(state)]);
  } catch (e) { console.error("linked tasks: state write failed:", e.message); }
  _freshDay = errors.length ? null : today;
  return { status: errors.length ? "partial" : "ok", ran: true, ...state };
}

// → { status: 'no_persistent' | 'disabled' | 'fresh' | 'ok' | 'partial', ran, … }
// (Not `async`: a call during a run gets the running promise itself.)
function runLinkedTasks(pool, persistentPool = defaultPersistentPool(), { today = todayStr(), deps = {}, scheduled = false } = {}) {
  if (!persistentPool) return Promise.resolve({ status: "no_persistent", ran: false });
  if (scheduled && !_running && _freshDay === today) return Promise.resolve({ status: "fresh", ran: false });
  if (_running) { _again = true; return _running; }
  _running = (async () => {
    try {
      let result;
      do {
        _again = false;
        result = await runOnce(pool, persistentPool, today, deps);
      } while (_again);
      return result;
    } finally { _running = null; }
  })();
  return _running;
}

// Fire-and-forget refresh after a write that can resolve or reopen a task
// (a housing payment, an obligation, a bill payment). Never throws or rejects;
// a failure is logged. kick() is what routes call — it also survives a
// refreshSoon that throws (the route's response never depends on it).
function refreshSoon(reason) {
  const pool = require("./database").pool;
  Promise.resolve()
    .then(() => module.exports.runLinkedTasks(pool))
    .catch((e) => console.error(`linked tasks refresh (${reason}) failed:`, e.message));
}
function kick(reason) {
  try { module.exports.refreshSoon(reason); }
  catch (e) { console.error(`linked tasks refresh (${reason}) failed:`, e.message); }
}

// The still-charging event (decision 2): one task per (subscription, charge),
// created when the watchdog's alert was logged, never closed by a sync. No-op
// unless the switch and the source are on and the shell wired Per-sistant.
// The item a still-charging alert is about: its linked task's key without the
// app prefix — also the watchdog push's item (cycle-8 E3d), one definition.
function stillChargingItem(sub) {
  const txn = String(sub.transaction_id || "").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120) || "charge";
  return `still-charging:${sub.id}:${txn}`;
}

async function ensureStillChargingTask(pool, sub, { persistentPool = defaultPersistentPool(), deps = {} } = {}) {
  if (!persistentPool) return { status: "no_persistent", created: false };
  const cfg = await readSettings(pool);
  if (!cfg.enabled || !cfg.sources.still_charging) return { status: "disabled", created: false };
  const ensure = deps.ensure || ((p, args) => persistentLinkedTasks().ensureLinkedTask(p, args));
  const r = await ensure(persistentPool, { app: APP, task: {
    key: `${APP}:${stillChargingItem(sub)}`,
    title: clip(`Check ${sub.display_name} — charged ${money(sub.charged)} after you cancelled`, 300),
    description: `A ${money(sub.charged)} charge on ${sub.charged_on} matches ${sub.display_name}, which you marked cancelled. Check with the merchant — the cancellation may not have gone through.`,
    url: "/subscriptions",
    due_date: null,
    priority: "high",
  } });
  return { status: r.error ? "invalid" : "ok", created: !!r.created, id: r.id || null };
}

module.exports = {
  computeLinkedTasks, taxDocumentTasks, effectiveSources, SOURCES, SOURCE_KEYS, DEFAULT_SOURCES, APP,
  runLinkedTasks, refreshSoon, kick, invalidate, isRunning, ensureStillChargingTask, stillChargingItem, SYNC_ERROR,
  _reset() { _disabledDay = null; _freshDay = null; _running = null; _again = false; },
};
