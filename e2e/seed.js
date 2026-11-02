// ============================================================================
// E2E seed (cycle-7 G2) — data for every page to render and every control to
// act on. Goes through the apps' OWN routes (page.request carries the signed-in
// shell cookie; JSON bodies / X-Requested-With satisfy both apps' CSRF checks),
// so a seed that fails is itself a finding. The one exception is the Job Radar
// listing: listings only arrive from the external boards, so it is inserted
// straight into the scratch Per-sistant database.
// ============================================================================
const { Client } = require("pg");

const { dbUrl } = require("./helpers");
const HDR = { "X-Requested-With": "XMLHttpRequest" };
function ymd(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function call(req, method, url, opts, expectOk = true) {
  const res = await req[method](url, { headers: HDR, ...opts });
  if (expectOk && !res.ok()) throw new Error(`seed ${method.toUpperCase()} ${url} → ${res.status()} ${await res.text()}`);
  return res.ok() ? res.json().catch(() => ({})) : null;
}

async function seedPerfin(req) {
  const out = {};
  await call(req, "patch", "/perfin/api/housing/config", {
    data: { enabled: true, payee_name: "E2E Landlord", rent_amount: 1500, rent_due_day: 1,
      utilities: [{ label: "Electricity", cadence_months: 1, due_day: 15 }] },
  });
  await call(req, "post", "/perfin/api/housing/generate", { data: {} });

  const acct = await call(req, "post", "/perfin/api/accounts/manual", {
    data: { name: "E2E Cash", institution_name: "Wallet", type: "depository", current_balance: 120 },
  });
  out.manualAccountId = acct.id;
  const accounts = await call(req, "get", "/perfin/api/accounts", {});
  const cash = (Array.isArray(accounts) ? accounts : accounts.accounts || []).find((a) => a.id === acct.id);
  await call(req, "post", "/perfin/api/transactions/manual", {
    data: { account_id: cash ? cash.account_id : acct.account_id, amount: 12.5, date: ymd(-2), merchant_name: "Corner Cafe", category: "Food & Dining" },
  });

  // A generic CSV: three charges and a refund (a negative row). Its own
  // "E2E Card" account is created by the import.
  const csv = "Date,Description,Amount\n" +
    `${ymd(-20)},GROCER MARKET,84.20\n` +
    `${ymd(-12)},HARDWARE STORE,46.00\n` +
    `${ymd(-10)},HARDWARE STORE RETURN,-16.00\n` +
    `${ymd(-5)},STREAMFLIX,15.49\n` +
    `${ymd(-4)},E2E DELETED SHOP,9.99\n`;
  await call(req, "post", "/perfin/api/import-csv", {
    multipart: {
      file: { name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
      account_label: "E2E Card",
      positive_means: "charges",
    },
  });
  const txns = await call(req, "get", "/perfin/api/transactions?months=3&limit=50", {});
  const list = Array.isArray(txns) ? txns : txns.transactions || [];
  // GET /api/transactions names the display merchant `merchant`.
  const merchantOf = (t) => t.merchant || t.merchant_name || t.name || "";
  const grocer = list.find((t) => /GROCER/i.test(merchantOf(t)));
  if (!grocer) throw new Error("seed: the GROCER row to split was not imported");
  await call(req, "post", `/perfin/api/transactions/${encodeURIComponent(grocer.transaction_id || grocer.id)}/splits`, {
    data: { splits: [
      { amount: 60.2, category: "Groceries", notes: "food" },
      { amount: 24, category: "Home", notes: "cleaning" },
    ] },
  });

  // One deleted transaction (roadmap T2.5): Settings → Sync Health lists it
  // under "Deleted transactions" with a Restore button.
  const deleted = list.find((t) => /E2E DELETED SHOP/i.test(merchantOf(t)));
  if (!deleted) throw new Error("seed: the CSV row to delete was not imported");
  await call(req, "delete", `/perfin/api/transactions/${encodeURIComponent(deleted.transaction_id || deleted.id)}`, {});

  // A Plaid-free tax year (roadmap T3.3 K4): a paycheck and a pharmacy charge on
  // their own CSV account, and a hand-added form on the year's checklist.
  const taxYear = Number(ymd(-3).slice(0, 4));
  const taxCsv = "Date,Description,Amount\n" +
    `${ymd(-3)},ACME PAYROLL DIRECT DEP,-2000.00\n` +
    `${ymd(-3)},CITY PHARMACY,42.10\n`;
  await call(req, "post", "/perfin/api/import-csv", {
    multipart: {
      file: { name: "e2e-tax.csv", mimeType: "text/csv", buffer: Buffer.from(taxCsv) },
      account_label: "E2E Checking",
      positive_means: "charges",
    },
  });
  await call(req, "post", "/perfin/api/tax/documents", { data: { year: taxYear, form: "1099-NEC", issuer: "E2E Client" } });
  out.taxYear = taxYear;

  await call(req, "post", "/perfin/api/budgets", { data: { category: "Groceries", monthly_limit: 300, rollover_enabled: true } });
  await call(req, "post", "/perfin/api/goals", { data: { name: "Emergency fund", type: "savings", target_amount: 5000, current_amount: 750, monthly_contribution: 200 } });
  await call(req, "post", "/perfin/api/subscriptions", { data: { name: "Streamflix", amount: 15.49, cadence_days: 30 } });
  await call(req, "post", "/perfin/api/credit-scores", { data: { score: 742, score_type: "fico", source: "e2e" } });
  return out;
}

async function seedPersistent(req) {
  for (const sensitivity of ["normal", "private", "secret"]) {
    await call(req, "post", "/per-sistant/api/notes", { data: { title: `E2E ${sensitivity} note`, content: `A ${sensitivity} note for the browser sweep.`, sensitivity } });
  }
  const habit = await call(req, "post", "/per-sistant/api/habits", { data: { name: "Walk", kind: "boolean", schedule: "daily" } });
  const habitId = habit.id || (habit.habit && habit.habit.id);
  for (const d of [ymd(-2), ymd(-1)]) await call(req, "post", `/per-sistant/api/habits/${habitId}/log`, { data: { date: d } });
  const todo = await call(req, "post", "/per-sistant/api/todos", { data: { title: "E2E task with subtasks", priority: "high", horizon: "short", due_date: ymd(1) } });
  const todoId = todo.id || (todo.todo && todo.todo.id);
  for (const t of ["First step", "Second step"]) await call(req, "post", `/per-sistant/api/todos/${todoId}/subtasks`, { data: { title: t } });

  // Job Radar: no route creates a listing (they come from the boards).
  const db = new Client({ connectionString: dbUrl("persistent_e2e") });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO job_listings (source_id, source_job_id, content_hash, title, company, location, remote,
                                 apply_url, apply_domain, description, fit_score, fit_rationale, trust_score, legitimacy)
       VALUES ((SELECT id FROM job_sources ORDER BY id LIMIT 1), 'e2e-1', 'e2e-hash-1', 'Staff Engineer', 'Example Co',
               'Remote', true, 'https://jobs.example.com/1', 'example.com', 'A seeded listing.', 82, 'Matches the profile.', 80, 'real')
       ON CONFLICT (content_hash) DO NOTHING`
    );
    // Linked tasks (roadmap T2.4): written by services/linked-tasks.js, never
    // by a route — one rent task kept in step with Perfin's Rent page.
    await db.query(
      `INSERT INTO todos (title, priority, horizon, category, due_date, source_app, source_key, source_url, source_snapshot)
       VALUES ('E2E pay rent', 'high', 'short', 'finance', $1::date, 'perfin', 'perfin:housing:e2e', '/housing',
               jsonb_build_object('title', 'E2E pay rent', 'description', NULL, 'due_date', $1::text, 'priority', 'high'))
       ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`, [ymd(2)]
    );
  } finally { await db.end(); }
}

// Seed once per run (cycle-8 E5a): pages.spec.js and behaviour.spec.js both
// call this; a second seedPerfin would duplicate "E2E Cash", the goal and the
// subscription and its 1099-NEC POST would 409. The marker is the "E2E Cash"
// manual account; a later call reads back what the first one returned. Files
// run one at a time (workers: 1), so two calls never race.
async function ensureSeeded(req) {
  const accounts = await call(req, "get", "/perfin/api/accounts", {});
  const list = Array.isArray(accounts) ? accounts : accounts.accounts || [];
  const cash = list.find((a) => a.name === "E2E Cash" && a.is_manual);
  if (cash) return { manualAccountId: cash.id, taxYear: Number(ymd(-3).slice(0, 4)) };
  const out = await seedPerfin(req);
  await seedPersistent(req);
  return out;
}

module.exports = { seedPerfin, seedPersistent, ensureSeeded };
