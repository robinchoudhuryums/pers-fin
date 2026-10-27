// The year-end tax package (roadmap T3.3 K3, decisions 8-9): everything a
// return needs from Perfin's data for one calendar year, computed on request
// and never stored. Each figure has ONE definition, shared with the screen or
// export that already shows it:
//   - income            financial-queries.getIncomeForYear (INCOME_PREDICATE +
//                       INCOME_AMOUNT — a shared account's deposit at your share);
//   - investment income, realized gains, retirement distributions
//                       tax-investments.getInvestmentTaxData (FIFO, labelled
//                       approximate; tax-advantaged accounts kept out of gains
//                       and income);
//   - deductions        financial-queries.getTaxDeductionReport — also behind
//                       GET /api/export/tax-report (taxReportCsv is that
//                       route's CSV, so deductions.csv is byte-identical);
//   - rent paid         housing.getHousingPayments — also behind the landlord
//                       export (housingPaymentsCsv likewise);
//   - documents         tax-documents.listTaxDocuments (the K2 checklist).
// Every section is fail-soft: a failing read gives that section
// { ok: false, error: <a fixed sentence> } and the others still render.
// Nothing here is sent to an AI model. Every CSV text cell goes through csvText
// (the formula guard, INV-83) and every date through csvDate.

const { todayStr, getIncomeForYear, getTaxDeductionReport } = require("./financial-queries");
const { csvText: q, csvDate } = require("./csv-export");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fixed = (n) => (n == null || n === "" || !isFinite(Number(n)) ? "" : Number(n).toFixed(2));

const DISCLAIMER = "For informational purposes only — not tax advice. Consult a tax professional before filing.";

const NOTES = [
  DISCLAIMER,
  "Figures come from the transactions and accounts Perfin has seen; they cross-check your W-2s and 1099s, they don't replace them.",
  "Income is the app's figure: a deposit on a shared account counts at your share, and income is recognised by keyword and the bank's category.",
  "Realized gains are an estimate: first-in-first-out over the purchases Perfin has stored (Plaid serves about 24 months). A sale without a known purchase cost has no basis or gain. Your broker's 1099-B is the authority.",
  "Corporate actions (splits, mergers, spin-offs) aren't applied to purchases — a flagged security's gains should be checked against the 1099-B. Wash sales aren't detected.",
  "Retirement and other tax-advantaged accounts are kept out of gains and investment income; their withdrawals are listed separately.",
  "Only Plaid-linked investment accounts have transactions; Teller-linked and manual investment accounts show balances only.",
  "Deductions are keyword matches on your transactions, not a tax determination.",
  "The documents checklist's dates are the usual deadlines, not guarantees.",
];

// The fixed sentence each section reports when its read fails.
const SECTION_ERRORS = {
  income: "Could not read the year's income.",
  investments: "Could not read the year's investment transactions.",
  deductions: "Could not read the year's deduction transactions.",
  rent_paid: "Could not read the year's rent and utility payments.",
  documents: "Could not read the tax documents checklist.",
};

const SECTION_ORDER = [
  "income", "investment_income", "realized_gains", "retirement",
  "deductions", "rent_paid", "documents",
];

const TITLES = {
  overview: "Overview",
  income: "Income",
  investment_income: "Investment income",
  realized_gains: "Realized gains (estimate)",
  retirement: "Retirement distributions",
  deductions: "Deductions",
  rent_paid: "Rent and utilities paid",
  documents: "Tax documents",
  notes: "Notes",
};

async function attempt(name, error, fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    console.error(`tax package: ${name} failed:`, e && e.message);
    return { ok: false, error };
  }
}

// → the package object (see the module header). deps lets a test swap any
// reader; the defaults are the shared definitions.
async function gatherTaxPackage(pool, year, deps = {}) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("year must be an integer");
  const today = deps.today || todayStr();
  const income = deps.getIncomeForYear || getIncomeForYear;
  const investments = deps.getInvestmentTaxData || require("./tax-investments").getInvestmentTaxData;
  const deductions = deps.getTaxDeductionReport || getTaxDeductionReport;
  const housing = deps.getHousingPayments || ((y, db) => require("../routes/housing").getHousingPayments(y, db));
  const documents = deps.listTaxDocuments || require("./tax-documents").listTaxDocuments;

  // One investment read feeds three sections; if it fails, all three say so.
  // (Wrapped so a synchronous throw becomes a rejection; the three attempts
  // below attach their handlers in this same tick.)
  const invP = (async () => investments(pool, year))();

  const [inc, invIncome, gains, retirement, ded, rent, docs] = await Promise.all([
    attempt("income", SECTION_ERRORS.income, async () => {
      const r = await income(pool, year);
      return {
        total: round2(r.total),
        by_kind: {
          wages: round2(r.by_kind && r.by_kind.wages), interest: round2(r.by_kind && r.by_kind.interest),
          dividends: round2(r.by_kind && r.by_kind.dividends), other: round2(r.by_kind && r.by_kind.other),
        },
        by_source: r.by_source || [],
        by_month: r.by_month || [],
      };
    }),
    attempt("investment_income", SECTION_ERRORS.investments, async () => {
      const r = (await invP).investment_income || {};
      return { accounts: r.accounts || [], totals: r.totals || {} };
    }),
    attempt("realized_gains", SECTION_ERRORS.investments, async () => {
      const inv = await invP;
      const r = inv.realized_gains || {};
      const sales = r.sales || [];
      const coverage = { full: 0, partial: 0, none: 0 };
      for (const s of sales) if (coverage[s.basis_coverage] != null) coverage[s.basis_coverage] += 1;
      return {
        sales,
        totals: r.totals || {},
        coverage,
        corporate_action_securities: r.corporate_action_securities || 0,
        earliest_transaction_date: inv.earliest_transaction_date || null,
      };
    }),
    attempt("retirement", SECTION_ERRORS.investments, async () => {
      const inv = await invP;
      const r = inv.retirement || {};
      return {
        distributions: r.distributions || [],
        total: round2(r.total),
        accounts: (inv.accounts || []).filter((a) => a.tax_advantaged),
      };
    }),
    attempt("deductions", SECTION_ERRORS.deductions, async () => {
      const rows = await deductions(pool, year);
      const byCategory = {};
      for (const d of rows) byCategory[d.category] = round2((byCategory[d.category] || 0) + parseFloat(d.amount));
      return {
        rows,
        by_category: byCategory,
        total: round2(rows.reduce((s, d) => s + parseFloat(d.amount), 0)),
        count: rows.length,
      };
    }),
    attempt("rent_paid", SECTION_ERRORS.rent_paid, async () => {
      const r = await housing(year, pool);
      return { payee: r.payee, total: round2(r.total), payments: r.payments || [] };
    }),
    attempt("documents", SECTION_ERRORS.documents, async () => {
      const rows = await documents(pool, year, today);
      const counts = { received: 0, dismissed: 0, overdue: 0, waiting: 0 };
      for (const d of rows) if (counts[d.state] != null) counts[d.state] += 1;
      return { documents: rows, counts };
    }),
  ]);

  const sections = {
    income: inc, investment_income: invIncome, realized_gains: gains, retirement,
    deductions: ded, rent_paid: rent, documents: docs,
  };
  const t = invIncome.ok ? invIncome.totals : {};
  const g = gains.ok ? gains.totals : {};
  const overview = {
    year,
    income_total: inc.ok ? inc.total : null,
    investment_income_total: invIncome.ok
      ? round2((t.dividends || 0) + (t.interest || 0) + (t.capital_gain_distributions_long || 0) + (t.capital_gain_distributions_short || 0))
      : null,
    realized_gain_known: gains.ok ? round2(((g.short && g.short.gain) || 0) + ((g.long && g.long.gain) || 0)) : null,
    sales_without_basis: gains.ok ? (g.unknown && g.unknown.count) || 0 : null,
    retirement_distributions_total: retirement.ok ? retirement.total : null,
    deductions_total: ded.ok ? ded.total : null,
    rent_paid_total: rent.ok ? rent.total : null,
    documents_open: docs.ok ? docs.counts.overdue + docs.counts.waiting : null,
    documents_overdue: docs.ok ? docs.counts.overdue : null,
    sections_failed: SECTION_ORDER.filter((k) => !sections[k].ok),
  };
  return {
    year,
    generated_on: today,
    disclaimer: DISCLAIMER,
    overview,
    ...sections,
    notes: NOTES.slice(),
  };
}

// ---------------------------------------------------------------------------
// CSV — one file per section
// ---------------------------------------------------------------------------

// The deduction report's CSV — GET /api/export/tax-report's body, byte for
// byte (that route calls this), so deductions.csv equals the export.
function taxReportCsv(rows) {
  const header = "Tax Year,Date,Merchant,Amount,Category,Type,Notes,Confirmed\n";
  const body = rows.map(d =>
    `${d.tax_year},${csvDate(d.txn_date)},` +
    `${q(d.merchant)},` +
    `${d.amount},${q(d.category)},${q(d.deduction_type)},` +
    `${q(d.notes)},${d.is_confirmed}`
  ).join("\n");
  const byCategory = {};
  for (const d of rows) {
    if (!byCategory[d.category]) byCategory[d.category] = 0;
    byCategory[d.category] += parseFloat(d.amount);
  }
  const grandTotal = rows.reduce((s, d) => s + parseFloat(d.amount), 0);
  const summary = "\n\nSUMMARY BY CATEGORY\nCategory,Total\n" +
    Object.entries(byCategory).map(([cat, total]) => `${q(cat)},${total.toFixed(2)}`).join("\n") +
    `\n\nGRAND TOTAL,${grandTotal.toFixed(2)}`;
  return header + body + summary;
}

const errorCsv = (s) => `Error\n${q(s.error)}\n`;
const lines = (header, rows) => header + "\n" + rows.map((r) => r.join(",")).join("\n") + (rows.length ? "\n" : "");

function incomeCsv(s) {
  if (!s.ok) return errorCsv(s);
  const src = s.by_source.map((r) => [
    q(r.source), q(r.kind), q(r.institution), fixed(r.total), r.count == null ? "" : Number(r.count),
    csvDate(r.first_date), csvDate(r.last_date),
  ]);
  src.push(["", "", q("TOTAL"), fixed(s.total), "", "", ""]);
  return lines("Source,Kind,Institution,Total,Deposits,First Deposit,Last Deposit", src) +
    "\n" + lines("Month,Total", s.by_month.map((m) => [q(m.month), fixed(m.total)]));
}

function investmentIncomeCsv(s) {
  if (!s.ok) return errorCsv(s);
  const cols = ["dividends", "qualified_dividends", "interest", "capital_gain_distributions_long", "capital_gain_distributions_short", "tax_withheld"];
  const rows = s.accounts.map((a) => [q(a.account_name), q(a.institution), q(a.account_type), ...cols.map((c) => fixed(a[c]))]);
  rows.push([q("TOTAL"), "", "", ...cols.map((c) => fixed(s.totals[c]))]);
  return lines("Account,Institution,Account Type,Dividends,Qualified Dividends,Interest,Capital Gain Distributions (Long),Capital Gain Distributions (Short),Tax Withheld", rows);
}

function realizedGainsCsv(s) {
  if (!s.ok) return errorCsv(s);
  const rows = s.sales.map((x) => [
    csvDate(x.date), q(x.account_name), q(x.ticker), q(x.security_name),
    x.quantity == null ? "" : Number(x.quantity), fixed(x.proceeds), fixed(x.cost_basis), fixed(x.gain),
    q(x.term), q(x.basis_coverage), x.corporate_action ? "true" : "false",
  ]);
  const tot = s.totals || {};
  for (const k of ["short", "long"]) {
    const t = tot[k] || {};
    rows.push(["", q(k === "short" ? "TOTAL SHORT-TERM" : "TOTAL LONG-TERM"), "", "", "", fixed(t.proceeds), fixed(t.cost_basis), fixed(t.gain), "", "", ""]);
  }
  const u = tot.unknown || {};
  rows.push(["", q("TOTAL UNKNOWN BASIS"), "", "", "", fixed(u.proceeds), "", "", "", "", ""]);
  return lines("Date,Account,Ticker,Security,Quantity,Proceeds,Cost Basis,Gain,Term,Basis Coverage,Corporate Action", rows);
}

function retirementCsv(s) {
  if (!s.ok) return errorCsv(s);
  const rows = s.distributions.map((d) => [csvDate(d.date), q(d.account_name), q(d.institution), q(d.account_type), fixed(d.amount)]);
  rows.push(["", q("TOTAL"), "", "", fixed(s.total)]);
  return lines("Date,Account,Institution,Account Type,Amount", rows);
}

function rentPaidCsv(s, year) {
  if (!s.ok) return errorCsv(s);
  const { housingPaymentsCsv } = require("../routes/housing");
  // The raw (unrounded) total is what the landlord export sums; the rounded one
  // prints the same to two decimals.
  return housingPaymentsCsv({ year, total: s.total, payments: s.payments });
}

function documentsCsv(s) {
  if (!s.ok) return errorCsv(s);
  return lines("Form,Issuer,Usually Arrives By,Received,Dismissed,State,Origin,Notes",
    s.documents.map((d) => [
      q(d.form), q(d.issuer), csvDate(d.expected_by), csvDate(d.received_at), csvDate(d.dismissed_at),
      q(d.state), q(d.origin), q(d.notes),
    ]));
}

function deductionsCsv(s) {
  return s.ok ? taxReportCsv(s.rows) : errorCsv(s);
}

// ---------------------------------------------------------------------------
// PDF — one document, a section per heading, the disclaimer on the first and
// last page. pdfkit, as the existing exports use. → Promise<Buffer>.
// ---------------------------------------------------------------------------

const money = (n) => (n == null ? "—" : (Number(n) < 0 ? "-$" : "$") + Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function renderPackagePdf(pkg) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: { Title: `Perfin tax package ${pkg.year}`, Creator: "Perfin" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const heading = (key) => {
      doc.moveDown(0.8);
      doc.fontSize(14).fillColor("#b07d3e").text(TITLES[key]);
      doc.outline.addItem(TITLES[key]);
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor("#222222");
    };
    const line = (s) => doc.fontSize(10).fillColor("#222222").text(s);
    const muted = (s) => doc.fontSize(9).fillColor("#666666").text(s);
    const failed = (s) => { if (!s.ok) { muted(s.error); return true; } return false; };
    const list = (items, fn, max = 200) => {
      items.slice(0, max).forEach((x) => line(fn(x)));
      if (items.length > max) muted(`… and ${items.length - max} more (see the CSV files in the ZIP).`);
    };

    doc.fontSize(20).fillColor("#b07d3e").text(`Tax package ${pkg.year}`, { align: "center" });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#666666").text(`Prepared by Perfin on ${pkg.generated_on}`, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor("#444444").text(DISCLAIMER, { align: "center" });

    const o = pkg.overview;
    heading("overview");
    line(`Income: ${money(o.income_total)}`);
    line(`Investment income: ${money(o.investment_income_total)}`);
    line(`Realized gains with a known basis (estimate): ${money(o.realized_gain_known)}` +
      (o.sales_without_basis ? ` — ${o.sales_without_basis} sale(s) without a basis` : ""));
    line(`Retirement distributions: ${money(o.retirement_distributions_total)}`);
    line(`Deductions found: ${money(o.deductions_total)}`);
    line(`Rent and utilities paid: ${money(o.rent_paid_total)}`);
    line(`Tax documents still open: ${o.documents_open == null ? "—" : o.documents_open}` +
      (o.documents_overdue ? ` (${o.documents_overdue} past their usual date)` : ""));
    if (o.sections_failed.length) muted(`Not available: ${o.sections_failed.map((k) => TITLES[k]).join(", ")}.`);

    heading("income");
    if (!failed(pkg.income)) {
      const k = pkg.income.by_kind;
      line(`Total ${money(pkg.income.total)} — wages ${money(k.wages)}, interest ${money(k.interest)}, dividends ${money(k.dividends)}, other ${money(k.other)}`);
      list(pkg.income.by_source, (s) => `${s.source} (${s.kind}${s.institution ? ", " + s.institution : ""}): ${money(s.total)}`);
      muted("A deposit on a shared account counts at your share.");
    }

    heading("investment_income");
    if (!failed(pkg.investment_income)) {
      const t = pkg.investment_income.totals;
      if (!pkg.investment_income.accounts.length) line("None recorded.");
      list(pkg.investment_income.accounts, (a) =>
        `${a.account_name || "Account"}${a.institution ? " (" + a.institution + ")" : ""}: dividends ${money(a.dividends)} (qualified ${money(a.qualified_dividends)}), interest ${money(a.interest)}, capital-gain distributions ${money((a.capital_gain_distributions_long || 0) + (a.capital_gain_distributions_short || 0))}, tax withheld ${money(a.tax_withheld)}`);
      if (pkg.investment_income.accounts.length) line(`Total dividends ${money(t.dividends)}, interest ${money(t.interest)}, tax withheld ${money(t.tax_withheld)}`);
    }

    heading("realized_gains");
    if (!failed(pkg.realized_gains)) {
      const g = pkg.realized_gains;
      const tot = g.totals || {};
      muted("An estimate — first-in-first-out over the purchases Perfin has stored. Your broker's 1099-B is the authority.");
      line(`Short term: proceeds ${money(tot.short && tot.short.proceeds)}, gain ${money(tot.short && tot.short.gain)}`);
      line(`Long term: proceeds ${money(tot.long && tot.long.proceeds)}, gain ${money(tot.long && tot.long.gain)}`);
      if (tot.unknown && tot.unknown.count) line(`Without a known basis: ${tot.unknown.count} sale(s), proceeds ${money(tot.unknown.proceeds)}`);
      if (g.corporate_action_securities) muted(`${g.corporate_action_securities} security(ies) had a corporate action — check those gains against the 1099-B.`);
      list(g.sales, (s) => `${s.date}  ${s.ticker || s.security_name || "Security"}  ${s.quantity} sold  proceeds ${money(s.proceeds)}  basis ${money(s.cost_basis)}  gain ${money(s.gain)}  ${s.term}`);
    }

    heading("retirement");
    if (!failed(pkg.retirement)) {
      if (!pkg.retirement.distributions.length) line("None recorded.");
      list(pkg.retirement.distributions, (d) => `${d.date}  ${d.account_name || "Account"}${d.account_type ? " (" + d.account_type + ")" : ""}  ${money(d.amount)}`);
      if (pkg.retirement.distributions.length) line(`Total ${money(pkg.retirement.total)}`);
    }

    heading("deductions");
    if (!failed(pkg.deductions)) {
      for (const [cat, total] of Object.entries(pkg.deductions.by_category)) line(`${cat}: ${money(total)}`);
      line(`Total ${money(pkg.deductions.total)} across ${pkg.deductions.count} transaction(s)`);
      muted("Keyword matches on your transactions — the full list is deductions.csv.");
    }

    heading("rent_paid");
    if (!failed(pkg.rent_paid)) {
      if (!pkg.rent_paid.payments.length) line("None recorded.");
      list(pkg.rent_paid.payments, (p) => `${p.paid_date}  ${money(parseFloat(p.amount))}${p.memo ? "  " + p.memo : ""}`);
      if (pkg.rent_paid.payments.length) line(`Total paid to ${pkg.rent_paid.payee}: ${money(pkg.rent_paid.total)}`);
    }

    heading("documents");
    if (!failed(pkg.documents)) {
      if (!pkg.documents.documents.length) line("No documents on the checklist.");
      list(pkg.documents.documents, (d) => `${d.form}${d.issuer ? " — " + d.issuer : ""}: ${d.state}${d.expected_by ? " (usually arrives by " + d.expected_by + ")" : ""}`);
    }

    heading("notes");
    for (const n of pkg.notes) muted("• " + n);
    doc.moveDown(1);
    doc.fontSize(9).fillColor("#444444").text(DISCLAIMER, { align: "center" });
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// ZIP — summary.pdf + a CSV per section + package.json
// ---------------------------------------------------------------------------

const ZIP_FILES = [
  "summary.pdf", "deductions.csv", "income.csv", "investment_income.csv",
  "realized_gains.csv", "retirement.csv", "rent_paid.csv", "documents.csv", "package.json",
];

function packageCsvFiles(pkg) {
  return {
    "deductions.csv": deductionsCsv(pkg.deductions),
    "income.csv": incomeCsv(pkg.income),
    "investment_income.csv": investmentIncomeCsv(pkg.investment_income),
    "realized_gains.csv": realizedGainsCsv(pkg.realized_gains),
    "retirement.csv": retirementCsv(pkg.retirement),
    "rent_paid.csv": rentPaidCsv(pkg.rent_paid, pkg.year),
    "documents.csv": documentsCsv(pkg.documents),
  };
}

async function buildPackageZip(pkg, { date = new Date() } = {}) {
  const { createZip } = require("./zip-store");
  const pdf = await renderPackagePdf(pkg);
  const csv = packageCsvFiles(pkg);
  const files = ZIP_FILES.map((name) => ({
    name,
    data: name === "summary.pdf" ? pdf : name === "package.json" ? JSON.stringify(pkg, null, 2) + "\n" : csv[name],
  }));
  return createZip(files, { date });
}

module.exports = {
  DISCLAIMER, NOTES, SECTION_ERRORS, SECTION_ORDER, TITLES, ZIP_FILES,
  gatherTaxPackage, taxReportCsv, packageCsvFiles,
  incomeCsv, investmentIncomeCsv, realizedGainsCsv, retirementCsv, rentPaidCsv, documentsCsv, deductionsCsv,
  renderPackagePdf, buildPackageZip,
};
