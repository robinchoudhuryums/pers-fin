// The year-end tax documents checklist (roadmap T3.3 K2, decision 5). Which
// forms should arrive for a tax year, from the year's own data:
//   - W-2      per payroll source (getIncomeForYear kind 'wages');
//   - 1099-INT per institution with ≥ $10 of interest (bank interest from
//              getIncomeForYear, brokerage interest from investment_transactions);
//   - 1099-DIV per taxable brokerage with ≥ $10 of dividends + capital-gain
//              distributions;
//   - 1099-B   per taxable brokerage with a sale in the year;
//   - 1099-R   per tax-advantaged account with a distribution;
//   - 1098 / 1098-E / 1098-T when the deduction rows (getTaxDeductionTransactions)
//              have mortgage interest / student loan interest / tuition.
// A suggestion is inserted ON CONFLICT DO NOTHING on (tax_year, form,
// LOWER(issuer)), so a row the user received, dismissed or added by hand stays
// exactly as they left it. Nothing is stored beyond the checklist rows and
// nothing is sent to an AI model (decision 11).
const { todayStr, getIncomeForYear, getTaxDeductionTransactions } = require("./financial-queries");

const FORMS = [
  "W-2", "1099-INT", "1099-DIV", "1099-B", "1099-R", "1099-NEC", "1099-MISC",
  "1099-K", "1099-G", "1098", "1098-E", "1098-T", "1095", "other",
];
const MIN_INTEREST = 10;
const MIN_DIVIDENDS = 10;
const MAX_ISSUER = 200;
const MAX_NOTES = 1000;

// Decision 1: an integer year from 2000 to the current APP_TIMEZONE year (a
// number, or a string of digits); anything else is null → the route's 400.
function parseTaxYear(raw, today = todayStr()) {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  return y >= 2000 && y <= Number(today.slice(0, 4)) ? y : null;
}

// The usual deadline ("usually arrives by"): Jan 31 of the next year, Feb 15
// for a 1099-B.
function expectedBy(year, form) {
  return form === "1099-B" ? `${year + 1}-02-15` : `${year + 1}-01-31`;
}

function cleanIssuer(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, MAX_ISSUER);
}

const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The 1098-family rules read the deduction rows by phrase (the deduction
// report's own TAX_KEYWORD_GROUPS words); the first rule that matches wins.
const DEDUCTION_FORMS = [
  { form: "1098-E", re: /\bstudent loan interest\b/i, what: "student loan interest" },
  { form: "1098", re: /\bmortgage interest\b/i, what: "mortgage interest" },
  { form: "1098-T", re: /\btuition\b/i, what: "tuition" },
];

// One entry per (form, issuer), case-insensitive; the first issuer spelling
// wins. `amount` sums into the entry (used for the thresholds and the reason).
function collector() {
  const map = new Map();
  return {
    add(form, issuer, amount = 0, extra = {}) {
      const name = cleanIssuer(issuer);
      const key = form + "\u0000" + name.toLowerCase();
      const e = map.get(key);
      if (e) { e.amount += amount; e.count += 1; return e; }
      const entry = { form, issuer: name, amount, count: 1, ...extra };
      map.set(key, entry);
      return entry;
    },
    values: () => [...map.values()],
  };
}

// → { suggestions: [{ form, issuer, expected_by, reason }], errors: [{ source, error }] }.
// Each data source is read in isolation: a failing one adds a fixed sentence
// to errors and its forms are skipped, never guessed.
async function computeSuggestions(pool, year, deps = {}) {
  const income = deps.getIncomeForYear || getIncomeForYear;
  const deductions = deps.getTaxDeductionTransactions || getTaxDeductionTransactions;
  const investments = deps.getInvestmentTaxData || require("./tax-investments").getInvestmentTaxData;
  const out = [];
  const errors = [];
  const fail = (source, e, error) => {
    console.error(`tax documents: ${source} read failed:`, e.message);
    errors.push({ source, error });
  };

  // Interest per institution from both the bank side and the brokerage side.
  // A brokerage cash sweep can appear on both (a Plaid brokerage is in
  // linked_accounts AND has investment transactions), so the larger of the two
  // counts per institution rather than their sum.
  const bankInterest = new Map();
  const brokerInterest = new Map();
  const interestNames = new Map();
  const noteInterest = (map, issuer, amt) => {
    const name = cleanIssuer(issuer);
    if (!name) return;
    const k = name.toLowerCase();
    if (!interestNames.has(k)) interestNames.set(k, name);
    map.set(k, (map.get(k) || 0) + amt);
  };

  try {
    const inc = await income(pool, year);
    const wages = collector();
    for (const s of inc.by_source || []) {
      if (s.kind === "wages" && Number(s.total) > 0) wages.add("W-2", s.source, Number(s.total));
      if (s.kind === "interest" && Number(s.total) > 0) noteInterest(bankInterest, s.institution || s.source, Number(s.total));
    }
    for (const w of wages.values()) {
      if (!w.issuer) continue;
      out.push({ form: "W-2", issuer: w.issuer, reason: `${money(w.amount)} of pay from ${w.issuer} in ${year}.` });
    }
  } catch (e) { fail("income", e, "Could not read the year's income."); }

  try {
    const inv = await investments(pool, year);
    const acct = new Map((inv.accounts || []).map((a) => [a.id, a]));
    const issuerOf = (id, fallback) => {
      const a = acct.get(id);
      return cleanIssuer((a && (a.institution || a.name)) || fallback || "");
    };
    const divs = collector();
    for (const a of (inv.investment_income && inv.investment_income.accounts) || []) {
      const issuer = issuerOf(a.investment_account_id, a.account_name);
      const d = (Number(a.dividends) || 0) + (Number(a.capital_gain_distributions_long) || 0) + (Number(a.capital_gain_distributions_short) || 0);
      if (d > 0 && issuer) divs.add("1099-DIV", issuer, d);
      if (Number(a.interest) > 0) noteInterest(brokerInterest, issuer, Number(a.interest));
    }
    for (const d of divs.values()) {
      if (d.amount >= MIN_DIVIDENDS) out.push({ form: "1099-DIV", issuer: d.issuer, reason: `${money(d.amount)} of dividends and distributions in ${year}.` });
    }
    const sales = collector();
    for (const s of (inv.realized_gains && inv.realized_gains.sales) || []) {
      const issuer = issuerOf(s.investment_account_id, s.account_name);
      if (issuer) sales.add("1099-B", issuer, Number(s.proceeds) || 0);
    }
    for (const s of sales.values()) {
      out.push({ form: "1099-B", issuer: s.issuer, reason: `${s.count} sale${s.count === 1 ? "" : "s"} in ${year} (${money(s.amount)} of proceeds).` });
    }
    const dists = collector();
    for (const d of (inv.retirement && inv.retirement.distributions) || []) {
      const issuer = cleanIssuer(d.institution || d.account_name || issuerOf(d.investment_account_id));
      if (issuer) dists.add("1099-R", issuer, Number(d.amount) || 0);
    }
    for (const d of dists.values()) {
      out.push({ form: "1099-R", issuer: d.issuer, reason: `${money(d.amount)} withdrawn from a retirement account in ${year}.` });
    }
  } catch (e) { fail("investments", e, "Could not read the year's investment transactions."); }

  for (const [k, name] of interestNames) {
    const amt = Math.max(bankInterest.get(k) || 0, brokerInterest.get(k) || 0);
    if (amt >= MIN_INTEREST) out.push({ form: "1099-INT", issuer: name, reason: `${money(amt)} of interest in ${year}.` });
  }

  try {
    const rows = await deductions(pool, year);
    const found = collector();
    for (const r of rows || []) {
      const rule = DEDUCTION_FORMS.find((f) => f.re.test(String(r.merchant || "")));
      if (rule) found.add(rule.form, r.merchant, Number(r.amount) || 0, { what: rule.what });
    }
    for (const f of found.values()) {
      if (!f.issuer) continue;
      out.push({ form: f.form, issuer: f.issuer, reason: `${money(f.amount)} of ${f.what} paid in ${year}.` });
    }
  } catch (e) { fail("deductions", e, "Could not read the year's deduction transactions."); }

  return {
    suggestions: out.map((s) => ({ ...s, expected_by: expectedBy(year, s.form) })),
    errors,
  };
}

const COLUMNS = `id, tax_year, form, issuer, expected_by::text AS expected_by, received_at::text AS received_at,
  dismissed_at, origin, notes, created_at, updated_at`;

// The checklist for a year, in form order then issuer, each row with its
// state: received / dismissed / overdue (open past expected_by) / waiting.
async function listTaxDocuments(pool, year, today = todayStr()) {
  const r = await pool.query(`SELECT ${COLUMNS} FROM tax_documents WHERE tax_year = $1`, [year]);
  const order = new Map(FORMS.map((f, i) => [f, i]));
  return r.rows
    .map((d) => ({
      ...d,
      state: d.received_at ? "received" : d.dismissed_at ? "dismissed"
        : d.expected_by && d.expected_by < today ? "overdue" : "waiting",
    }))
    .sort((a, b) => (order.get(a.form) ?? 99) - (order.get(b.form) ?? 99)
      || String(a.issuer).toLowerCase().localeCompare(String(b.issuer).toLowerCase()));
}

// Insert every suggestion that isn't on the list yet → { added, suggestions,
// errors }. The reasons are returned, not stored (the checklist keeps only the
// row; the user's notes are theirs).
async function suggestTaxDocuments(pool, year, deps = {}) {
  const { suggestions, errors } = await computeSuggestions(pool, year, deps);
  let added = 0;
  for (const s of suggestions) {
    const r = await pool.query(
      `INSERT INTO tax_documents (tax_year, form, issuer, expected_by, origin)
       VALUES ($1, $2, $3, $4::date, 'suggested')
       ON CONFLICT (tax_year, form, (LOWER(issuer))) DO NOTHING
       RETURNING id`,
      [year, s.form, s.issuer, s.expected_by]
    );
    if (r.rows.length) added += 1;
  }
  return { added, suggestions, errors };
}

module.exports = {
  FORMS, MIN_INTEREST, MIN_DIVIDENDS, MAX_ISSUER, MAX_NOTES, COLUMNS,
  parseTaxYear, expectedBy, cleanIssuer, computeSuggestions, listTaxDocuments, suggestTaxDocuments,
};
