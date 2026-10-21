// ============================================================================
// E2E seed (cycle-7 G2) — data for every page to render and every control to
// act on. Goes through the apps' OWN routes (page.request carries the signed-in
// shell cookie; JSON bodies / X-Requested-With satisfy both apps' CSRF checks),
// so a seed that fails is itself a finding. The one exception is the Job Radar
// listing: listings only arrive from the external boards, so it is inserted
// straight into the scratch Per-sistant database.
// ============================================================================
const { Client } = require("pg");

const ADMIN_URL = process.env.E2E_DATABASE_URL || "postgres://postgres:ci@localhost:5432/postgres";
const HDR = { "X-Requested-With": "XMLHttpRequest" };

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return u.toString();
}
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
    `${ymd(-5)},STREAMFLIX,15.49\n`;
  await call(req, "post", "/perfin/api/import-csv", {
    multipart: {
      file: { name: "e2e.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
      account_label: "E2E Card",
      positive_means: "charges",
    },
  });
  const txns = await call(req, "get", "/perfin/api/transactions?months=3&limit=50", {});
  const list = Array.isArray(txns) ? txns : txns.transactions || [];
  const grocer = list.find((t) => /GROCER/i.test(t.merchant_name || t.name || ""));
  if (grocer) {
    await call(req, "post", `/perfin/api/transactions/${encodeURIComponent(grocer.transaction_id || grocer.id)}/splits`, {
      data: { splits: [
        { amount: 60.2, category: "Groceries", notes: "food" },
        { amount: 24, category: "Home", notes: "cleaning" },
      ] },
    });
  }

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
  } finally { await db.end(); }
}

module.exports = { seedPerfin, seedPersistent };
