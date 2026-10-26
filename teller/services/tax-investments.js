// ============================================================================
// Investment tax data for the year-end tax package (roadmap T3.3 K1)
// ============================================================================
// Reads investment_transactions (every Plaid investment transaction, written by
// syncAllPlaidInvestmentFlows) and derives, for one calendar year:
//
//   realizedGains(txns, { year })  — PURE. FIFO lots per (account, security):
//     a buy adds a lot at cost = amount (Plaid's sign: positive when cash is
//     debited — fees included); an in-kind transfer IN adds a lot of UNKNOWN cost
//     and date; a sell takes shares FIFO; a transfer OUT removes shares FIFO
//     without a sale. A sale in `year` reports proceeds (-amount), cost basis,
//     gain and term (short ≤ 1 year / long / mixed / unknown). Shares sold beyond
//     the known lots, or from an unknown-cost lot, make the basis and gain NULL —
//     never 0 (the BSI-5 rule) — with basis_coverage partial | none. A security
//     with a split / merger / spin off / stock distribution anywhere in its
//     history is flagged corporate_action (lots aren't adjusted). Cancelled rows
//     are dropped. An ESTIMATE: the broker's 1099-B is authoritative.
//   investmentIncome(rows, accounts)  — PURE. Dividends (qualified / not),
//     interest, capital-gain distributions and tax withheld per taxable account.
//   retirementDistributions(rows, accounts) — PURE. Withdrawals from
//     tax-advantaged accounts (a 1099-R may come).
//   getInvestmentTaxData(pool, year) — the query + the three above.
//
// Tax-advantaged accounts (TAX_ADVANTAGED, by investment_accounts.account_type —
// Plaid's subtype) are kept out of gains and investment income. Only
// Plaid-linked accounts have transactions; Teller-linked and manual investment
// accounts show balances only. No AI anywhere here.
// ============================================================================

// Plaid investment-account subtypes (plus this app's underscored spellings,
// normalised by accountTaxAdvantaged) whose gains / income aren't taxed year
// by year.
const TAX_ADVANTAGED = new Set([
  "401a", "401k", "403b", "457b", "529", "ira", "roth", "roth ira", "roth 401k",
  "sep ira", "simple ira", "sarsep", "keogh", "hsa", "pension", "retirement",
  "profit sharing plan", "thrift savings plan", "education savings account",
  "health reimbursement arrangement", "non-taxable brokerage account",
  "fixed annuity", "variable annuity", "other annuity",
  "rrsp", "rrif", "tfsa", "resp", "rdsp", "lira", "lif", "lrif", "lrsp", "prif", "rlif", "qshr",
  "sipp", "isa", "cash isa",
]);

function accountTaxAdvantaged(accountType) {
  const t = String(accountType || "").toLowerCase().replace(/_/g, " ").trim();
  return TAX_ADVANTAGED.has(t);
}

const BUY_TYPES = new Set(["buy"]);
const SELL_TYPES = new Set(["sell"]);
const CORPORATE_ACTIONS = new Set(["split", "merger", "spin off", "stock distribution"]);
const DIVIDEND_SUBTYPES = new Set(["dividend", "qualified dividend", "non-qualified dividend"]);
const INTEREST_SUBTYPES = new Set(["interest"]);
const CAP_GAIN_LONG = new Set(["long-term capital gain"]);
const CAP_GAIN_SHORT = new Set(["short-term capital gain"]);
const TAX_WITHHELD = new Set(["tax withheld", "non-resident tax"]);
const DISTRIBUTION_SUBTYPES = new Set(["withdrawal", "distribution"]);
const EPS = 1e-9;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;
const ymd = (d) => (d == null ? null : String(d instanceof Date ? d.toISOString() : d).slice(0, 10));

// Held MORE than one year → long term: the sale date is after the acquisition
// date's anniversary. A Feb 29 acquisition compares against "<y>-02-29", which
// sorts between Feb 28 and Mar 1, so Mar 1 is its first long-term day.
function isLongTerm(acquired, sold) {
  if (!acquired || !sold) return null;
  const y = Number(acquired.slice(0, 4)) + 1;
  return sold > `${y}-${acquired.slice(5)}`;
}

function securityKey(t) {
  return String(t.investment_account_id) + "|" + (t.security_id || t.ticker || t.security_name || t.name || "?");
}

// Same-day order: shares coming in (buys, transfers in) before shares going
// out, so a same-day buy + sell isn't read as a sale beyond known lots.
function sortForLots(rows) {
  const inbound = (t) => BUY_TYPES.has(t.type) || (t.type === "transfer" && num(t.quantity) > 0) ? 0 : 1;
  return rows.slice().sort((a, b) => {
    const da = ymd(a.txn_date), db = ymd(b.txn_date);
    if (da !== db) return da < db ? -1 : 1;
    const ia = inbound(a), ib = inbound(b);
    if (ia !== ib) return ia - ib;
    return String(a.plaid_investment_transaction_id || a.id || "").localeCompare(String(b.plaid_investment_transaction_id || b.id || ""));
  });
}

function dropCancelled(rows) {
  const cancelled = new Set(rows.map((t) => t.cancel_transaction_id).filter(Boolean));
  return rows.filter((t) => t.type !== "cancel" && !cancelled.has(t.plaid_investment_transaction_id));
}

// Take `qty` shares FIFO from `lots`; returns the parts taken
// ({ qty, cost|null, date|null }) and the quantity no lot covered.
function takeFifo(lots, qty) {
  const parts = [];
  let left = qty;
  while (left > EPS && lots.length) {
    const lot = lots[0];
    const take = Math.min(lot.qty, left);
    parts.push({ qty: take, cost: lot.cost == null ? null : (lot.cost * take) / lot.qty, date: lot.date });
    if (lot.cost != null) lot.cost -= (lot.cost * take) / lot.qty;
    lot.qty -= take;
    left -= take;
    if (lot.qty <= EPS) lots.shift();
  }
  return { parts, uncovered: left > EPS ? left : 0 };
}

function realizedGains(txns, { year } = {}) {
  const yearStr = year == null ? null : String(year);
  const rows = sortForLots(dropCancelled((txns || []).map((t) => ({
    ...t,
    type: String(t.type || "").toLowerCase(),
    subtype: t.subtype == null ? null : String(t.subtype).toLowerCase(),
  }))));
  const lots = new Map();
  const flagged = new Set();
  const sales = [];
  for (const t of rows) {
    if (t.subtype && CORPORATE_ACTIONS.has(t.subtype)) flagged.add(securityKey(t));
  }
  for (const t of rows) {
    const key = securityKey(t);
    if (!lots.has(key)) lots.set(key, []);
    const book = lots.get(key);
    const qty = Math.abs(num(t.quantity));
    const date = ymd(t.txn_date);
    if (BUY_TYPES.has(t.type)) {
      if (qty > EPS) book.push({ qty, cost: Math.abs(num(t.amount)), date });
    } else if (SELL_TYPES.has(t.type)) {
      if (t.subtype === "sell short" || qty <= EPS) continue; // shorts aren't modelled
      const { parts, uncovered } = takeFifo(book, qty);
      if (!yearStr || !date || date.slice(0, 4) !== yearStr) continue;
      const proceeds = Math.abs(num(t.amount));
      const unknownQty = uncovered + parts.filter((p) => p.cost == null).reduce((s, p) => s + p.qty, 0);
      const knownParts = parts.filter((p) => p.cost != null);
      const knownBasis = knownParts.reduce((s, p) => s + p.cost, 0);
      const basis = unknownQty > EPS ? null : round2(knownBasis);
      const terms = new Set(knownParts.map((p) => (isLongTerm(p.date, date) ? "long" : "short")));
      let term = "unknown";
      if (unknownQty <= EPS) term = terms.size === 1 ? [...terms][0] : terms.size > 1 ? "mixed" : "unknown";
      // A mixed sale is split by its share of each term (proceeds pro rata).
      const termSplit = { short: { proceeds: 0, basis: 0 }, long: { proceeds: 0, basis: 0 } };
      if (basis != null) {
        for (const p of knownParts) {
          const k = isLongTerm(p.date, date) ? "long" : "short";
          termSplit[k].proceeds += (proceeds * p.qty) / qty;
          termSplit[k].basis += p.cost;
        }
      }
      sales.push({
        date,
        investment_account_id: t.investment_account_id,
        account_name: t.account_name || null,
        security_id: t.security_id || null,
        ticker: t.ticker || null,
        security_name: t.security_name || t.name || null,
        quantity: Math.round(qty * 1e6) / 1e6,
        proceeds: round2(proceeds),
        cost_basis: basis,
        gain: basis == null ? null : round2(proceeds - basis),
        term,
        basis_coverage: unknownQty <= EPS ? "full" : unknownQty >= qty - EPS ? "none" : "partial",
        corporate_action: flagged.has(key),
        _split: termSplit,
      });
    } else if (t.type === "transfer") {
      if (t.subtype && CORPORATE_ACTIONS.has(t.subtype)) continue; // flagged, lots untouched
      if (qty <= EPS) continue;
      if (num(t.quantity) > 0) book.push({ qty, cost: null, date: null }); // in-kind in: unknown cost
      else takeFifo(book, qty); // in-kind out: shares leave, no sale
    }
  }
  const totals = {
    short: { proceeds: 0, cost_basis: 0, gain: 0, count: 0 },
    long: { proceeds: 0, cost_basis: 0, gain: 0, count: 0 },
    unknown: { proceeds: 0, count: 0 },
  };
  for (const s of sales) {
    if (s.cost_basis == null) {
      totals.unknown.proceeds += s.proceeds;
      totals.unknown.count += 1;
    } else {
      for (const k of ["short", "long"]) {
        const part = s._split[k];
        if (part.proceeds <= 0 && part.basis <= 0) continue;
        totals[k].proceeds += part.proceeds;
        totals[k].cost_basis += part.basis;
        totals[k].gain += part.proceeds - part.basis;
        totals[k].count += 1;
      }
    }
    delete s._split;
  }
  for (const k of ["short", "long"]) {
    for (const f of ["proceeds", "cost_basis", "gain"]) totals[k][f] = round2(totals[k][f]);
  }
  totals.unknown.proceeds = round2(totals.unknown.proceeds);
  return {
    sales,
    totals,
    corporate_action_securities: [...flagged].length,
  };
}

// Investment income per taxable account for `year` (rows already filtered to
// the year). Plaid credits cash with a NEGATIVE amount; income is reported
// positive. Reinvestment rows are buys (lots), not income — the cash dividend
// row is the income.
function investmentIncome(rows, accounts) {
  const byAccount = new Map();
  const blank = (a) => ({
    investment_account_id: a.id, account_name: a.name, institution: a.institution,
    account_type: a.account_type,
    dividends: 0, qualified_dividends: 0, interest: 0,
    capital_gain_distributions_long: 0, capital_gain_distributions_short: 0, tax_withheld: 0,
  });
  for (const t of rows) {
    const a = accounts.get(t.investment_account_id);
    if (!a || a.tax_advantaged) continue;
    const sub = String(t.subtype || "").toLowerCase();
    const amt = -num(t.amount);
    let field = null;
    if (DIVIDEND_SUBTYPES.has(sub)) field = "dividends";
    else if (INTEREST_SUBTYPES.has(sub)) field = "interest";
    else if (CAP_GAIN_LONG.has(sub)) field = "capital_gain_distributions_long";
    else if (CAP_GAIN_SHORT.has(sub)) field = "capital_gain_distributions_short";
    else if (TAX_WITHHELD.has(sub)) field = "tax_withheld";
    if (!field) continue;
    if (!byAccount.has(a.id)) byAccount.set(a.id, blank(a));
    const rec = byAccount.get(a.id);
    // Tax withheld is cash OUT (positive amount): report it positive too.
    rec[field] += field === "tax_withheld" ? Math.abs(num(t.amount)) : amt;
    if (sub === "qualified dividend") rec.qualified_dividends += amt;
  }
  const list = [...byAccount.values()].map((r) => {
    for (const k of Object.keys(r)) if (typeof r[k] === "number" && k !== "investment_account_id") r[k] = round2(r[k]);
    return r;
  });
  const sum = (k) => round2(list.reduce((s, r) => s + r[k], 0));
  return {
    accounts: list,
    totals: {
      dividends: sum("dividends"), qualified_dividends: sum("qualified_dividends"), interest: sum("interest"),
      capital_gain_distributions_long: sum("capital_gain_distributions_long"),
      capital_gain_distributions_short: sum("capital_gain_distributions_short"),
      tax_withheld: sum("tax_withheld"),
    },
  };
}

// Cash leaving a tax-advantaged account in `year` (withdrawals /
// distributions) — what a 1099-R reports. Rows already filtered to the year.
function retirementDistributions(rows, accounts) {
  const out = [];
  for (const t of rows) {
    const a = accounts.get(t.investment_account_id);
    if (!a || !a.tax_advantaged) continue;
    if (String(t.type || "").toLowerCase() !== "cash") continue;
    if (!DISTRIBUTION_SUBTYPES.has(String(t.subtype || "").toLowerCase())) continue;
    out.push({
      date: ymd(t.txn_date), investment_account_id: a.id, account_name: a.name,
      institution: a.institution, account_type: a.account_type, amount: round2(Math.abs(num(t.amount))),
    });
  }
  return { distributions: out, total: round2(out.reduce((s, d) => s + d.amount, 0)) };
}

function validTaxYear(year) {
  return Number.isInteger(year) && year >= 2000 && year <= 9999;
}

async function getInvestmentTaxData(pool, year) {
  if (!validTaxYear(year)) throw new Error("year must be an integer");
  const next = `${year + 1}-01-01`;
  const [accts, txns] = await Promise.all([
    pool.query(
      `SELECT id, name, institution, account_type, is_active
       FROM investment_accounts
       WHERE id IN (SELECT DISTINCT investment_account_id FROM investment_transactions)`
    ),
    // Every row before the year ends: earlier buys are the lots a sale this
    // year draws on.
    pool.query(
      `SELECT plaid_investment_transaction_id, investment_account_id, txn_date::text AS txn_date,
              type, subtype, security_id, ticker, security_name, security_type,
              quantity, price, amount, fees, name, cancel_transaction_id
       FROM investment_transactions
       WHERE txn_date < $1::date
       ORDER BY txn_date, plaid_investment_transaction_id`,
      [next]
    ),
  ]);
  const accounts = new Map();
  for (const a of accts.rows) {
    accounts.set(a.id, { ...a, tax_advantaged: accountTaxAdvantaged(a.account_type) });
  }
  const yearStr = String(year);
  const all = txns.rows.map((t) => ({ ...t, account_name: (accounts.get(t.investment_account_id) || {}).name || null }));
  const taxable = all.filter((t) => {
    const a = accounts.get(t.investment_account_id);
    return a && !a.tax_advantaged;
  });
  const inYear = dropCancelled(all).filter((t) => String(t.txn_date).slice(0, 4) === yearStr);
  return {
    year,
    accounts: [...accounts.values()].map((a) => ({
      id: a.id, name: a.name, institution: a.institution, account_type: a.account_type,
      tax_advantaged: a.tax_advantaged,
    })),
    realized_gains: realizedGains(taxable, { year }),
    investment_income: investmentIncome(inYear, accounts),
    retirement: retirementDistributions(inYear, accounts),
    earliest_transaction_date: all.length ? String(all[0].txn_date).slice(0, 10) : null,
  };
}

module.exports = {
  TAX_ADVANTAGED, accountTaxAdvantaged, isLongTerm,
  realizedGains, investmentIncome, retirementDistributions, getInvestmentTaxData, validTaxYear,
};
