// Finance results for Per-sistant's search (roadmap T2.4 X3a). Under the
// unified shell GET /api/search also looks in Perfin's database — READ-ONLY
// through the shell-wired perfinPool (INV-25 / INV-35, never an HTTP
// self-fetch): transactions (display merchant, the user's notes, category —
// the 10 newest, at the user's share), active subscriptions, manual bills,
// goals and account names. Standalone (no perfinPool) there is no finance
// group and no Perfin query. Each query is fail-soft: a failing one drops its
// results and the request logs once; the Per-sistant results are unaffected.
//
// A result: { group: 'finance', app: 'perfin', type, id, title, description,
// url } — url is a path inside Perfin ('/goals'); the page joins it with
// Perfin's mount (window.LINKED_APP_BASES), like a linked task's chip.

const LIMIT = 10;

const money = (n) => {
  const v = Number(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const join = (parts) => parts.filter(Boolean).join(" · ");

// The canonical shared-card share (INV-48 — imported, never re-typed). Lazy:
// only reached when the shell wired perfinPool, so Perfin's modules exist.
function splitAmount() {
  return require("../../../teller/services/financial-queries").SPLIT_AMOUNT;
}

const DISPLAY_MERCHANT = "COALESCE(t.user_merchant_name, t.merchant_name, t.name)";
const CATEGORY = "COALESCE(t.user_category, t.category[1])";

function transactionSql() {
  return `SELECT t.transaction_id, t.date::text AS date, ${DISPLAY_MERCHANT} AS merchant,
      ${CATEGORY} AS category, t.amount, ${splitAmount()} AS share, t.is_reimbursed, t.pending
    FROM transactions t
    LEFT JOIN linked_accounts la ON la.account_id = t.account_id
    WHERE ${DISPLAY_MERCHANT} ILIKE $1 OR t.user_notes ILIKE $1 OR ${CATEGORY} ILIKE $1
    ORDER BY t.date DESC, t.id DESC
    LIMIT ${LIMIT}`;
}

const SUBSCRIPTION_SQL = `SELECT id, display_name, amount, cadence_days, next_expected::text AS next_expected
    FROM detected_subscriptions
    WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL
      AND (display_name ILIKE $1 OR merchant_key ILIKE $1)
    ORDER BY display_name
    LIMIT ${LIMIT}`;

const BILL_SQL = `SELECT id, name, amount, due_day, cadence, category
    FROM manual_bills
    WHERE is_active = true AND (name ILIKE $1 OR category ILIKE $1)
    ORDER BY name
    LIMIT ${LIMIT}`;

const GOAL_SQL = `SELECT id, name, target_amount, target_date::text AS target_date
    FROM financial_goals
    WHERE is_active = true AND (name ILIKE $1 OR notes ILIKE $1)
    ORDER BY name
    LIMIT ${LIMIT}`;

// Linked accounts minus the Plaid brokerage phantom (the getNetWorth dedupe —
// its investment_accounts row is listed instead), plus investment accounts.
const ACCOUNT_SQL = `SELECT * FROM (
      SELECT la.id, 'linked' AS source, la.name, la.type, la.mask
      FROM linked_accounts la
      WHERE (la.name ILIKE $1 OR la.official_name ILIKE $1 OR la.institution_name_manual ILIKE $1)
        AND NOT EXISTS (SELECT 1 FROM investment_accounts ia WHERE ia.plaid_account_id = la.account_id AND ia.is_active)
      UNION ALL
      SELECT ia.id, 'investment' AS source, ia.name, ia.account_type AS type, ia.mask
      FROM investment_accounts ia
      WHERE ia.is_active AND (ia.name ILIKE $1 OR ia.institution ILIKE $1)
    ) a
    ORDER BY name
    LIMIT ${LIMIT}`;

const base = (type, id, title, description, url) => ({ group: "finance", app: "perfin", type, id, title, description, url });

function transactionResult(r) {
  const share = Number(r.share);
  const amount = Number(r.amount);
  const shareNote = share !== amount ? `your share of ${money(amount)}` : null;
  const month = typeof r.date === "string" ? r.date.slice(0, 7) : null;
  const url = "/transactions?q=" + encodeURIComponent(r.merchant || "") + (month ? "&month=" + month : "");
  return base("transaction", r.transaction_id, r.merchant || "Transaction",
    join([money(share), shareNote, r.date, r.category, r.is_reimbursed ? "reimbursed" : null, r.pending ? "pending" : null]), url);
}
function subscriptionResult(r) {
  return base("subscription", r.id, r.display_name,
    join([`${money(r.amount)} every ${r.cadence_days} days`, r.next_expected ? `next ${r.next_expected}` : null]), "/subscriptions");
}
function billResult(r) {
  return base("bill", r.id, r.name, join([`${money(r.amount)} ${r.cadence}`, `due day ${r.due_day}`, r.category]), "/calendar");
}
function goalResult(r) {
  return base("goal", r.id, r.name, join([`target ${money(r.target_amount)}`, r.target_date ? `by ${r.target_date}` : null]), "/goals");
}
function accountResult(r) {
  return base("account", `${r.source}:${r.id}`, r.name, join([r.type, r.mask ? "··" + r.mask : null]),
    `/accounts/${r.id}/history?source=${r.source}`);
}

const QUERIES = [
  ["transactions", transactionSql, transactionResult],
  ["subscriptions", () => SUBSCRIPTION_SQL, subscriptionResult],
  ["bills", () => BILL_SQL, billResult],
  ["goals", () => GOAL_SQL, goalResult],
  ["accounts", () => ACCOUNT_SQL, accountResult],
];

// pattern: the already-escaped ILIKE pattern ('%…%'). Never throws.
async function searchFinance(perfinPool, pattern) {
  if (!perfinPool) return [];
  // .then() so a throw while building the SQL is a failed query, not a rejection.
  const settled = await Promise.allSettled(QUERIES.map(([, sql]) => Promise.resolve().then(() => perfinPool.query(sql(), [pattern]))));
  const out = [];
  const failed = [];
  settled.forEach((s, i) => {
    const [name, , toResult] = QUERIES[i];
    if (s.status === "fulfilled") out.push(...s.value.rows.map(toResult));
    else failed.push(name);
  });
  if (failed.length) {
    const first = settled.find((s) => s.status === "rejected");
    console.error(`finance search: ${failed.join(", ")} failed:`, first.reason && first.reason.message);
  }
  return out;
}

module.exports = { searchFinance, transactionSql, SUBSCRIPTION_SQL, BILL_SQL, GOAL_SQL, ACCOUNT_SQL, LIMIT };
