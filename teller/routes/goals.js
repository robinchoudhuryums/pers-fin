// ============================================================================
// Routes: Financial Goals, Net Worth Snapshots, Context Export
// ============================================================================

const express = require("express");
const router = express.Router();
const { pool } = require("../services/database");
const { zipToState } = require("../data/reference-data");

// GET /api/goals
router.get("/api/goals", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM financial_goals WHERE is_active = true ORDER BY target_date ASC NULLS LAST");
    const goals = result.rows.map(g => {
      const target = parseFloat(g.target_amount);
      const current = parseFloat(g.current_amount);
      const monthly = parseFloat(g.monthly_contribution || 0);
      const rate = parseFloat(g.interest_rate || 0) / 100 / 12;
      const pct = target > 0 ? Math.round((current / target) * 100) : 0;
      const remaining = Math.max(0, target - current);
      let months_to_goal = null;
      if (monthly > 0 && remaining > 0) {
        if (rate > 0) {
          let bal = current; let m = 0;
          while (bal < target && m < 1200) { bal = bal * (1 + rate) + monthly; m++; }
          months_to_goal = m;
        } else {
          months_to_goal = Math.ceil(remaining / monthly);
        }
      }
      return { ...g, percent_complete: pct, remaining, months_to_goal,
        estimated_date: months_to_goal ? new Date(Date.now() + months_to_goal * 30.44 * 86400000).toISOString().split("T")[0] : null };
    });
    res.json(goals);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/goals
router.post("/api/goals", async (req, res) => {
  const { name, type, target_amount, current_amount, monthly_contribution, target_date, interest_rate, notes } = req.body;
  if (!name || !target_amount) return res.status(400).json({ error: "name and target_amount are required" });
  const parsedTarget = parseFloat(target_amount);
  const parsedCurrent = parseFloat(current_amount || 0);
  const parsedMonthly = parseFloat(monthly_contribution || 0);
  const parsedRate = parseFloat(interest_rate || 0);
  if (isNaN(parsedTarget) || parsedTarget <= 0) return res.status(400).json({ error: "target_amount must be a positive number" });
  if (isNaN(parsedCurrent) || parsedCurrent < 0) return res.status(400).json({ error: "current_amount must be non-negative" });
  if (isNaN(parsedMonthly) || parsedMonthly < 0) return res.status(400).json({ error: "monthly_contribution must be non-negative" });
  if (isNaN(parsedRate) || parsedRate < 0 || parsedRate > 100) return res.status(400).json({ error: "interest_rate must be between 0 and 100" });
  try {
    const result = await pool.query(
      `INSERT INTO financial_goals (name, type, target_amount, current_amount, monthly_contribution, target_date, interest_rate, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, type || "savings", parsedTarget, parsedCurrent, parsedMonthly, target_date || null, parsedRate, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/goals/:id
router.patch("/api/goals/:id", async (req, res) => {
  const ALLOWED_FIELDS = new Set(["name", "type", "target_amount", "current_amount", "monthly_contribution", "target_date", "interest_rate", "notes", "is_active"]);
  const updates = []; const values = []; let idx = 1;
  for (const f of ALLOWED_FIELDS) {
    if (req.body[f] !== undefined) { updates.push(`"${f}" = $` + idx++); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: "No valid fields" });
  updates.push("updated_at = now()");
  values.push(req.params.id);
  try {
    const result = await pool.query("UPDATE financial_goals SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *", values);
    if (!result.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/goals/:id
router.delete("/api/goals/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM financial_goals WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/net-worth/snapshot
router.post("/api/net-worth/snapshot", async (_req, res) => {
  try {
    const [accounts, investments] = await Promise.all([
      pool.query("SELECT name, type, available_balance, current_balance FROM linked_accounts WHERE available_balance IS NOT NULL OR current_balance IS NOT NULL"),
      pool.query("SELECT name, account_type, balance FROM investment_accounts WHERE is_active = true AND balance != 0"),
    ]);
    let totalAssets = 0, totalLiabilities = 0;
    const breakdown = { accounts: [], investments: [] };
    for (const a of accounts.rows) {
      if (a.type === "credit") {
        const owed = parseFloat(a.current_balance || 0);
        totalLiabilities += owed;
        breakdown.accounts.push({ name: a.name, type: a.type, amount: -owed });
      } else {
        const bal = parseFloat(a.available_balance || a.current_balance || 0);
        totalAssets += bal;
        breakdown.accounts.push({ name: a.name, type: a.type, amount: bal });
      }
    }
    for (const inv of investments.rows) {
      const bal = parseFloat(inv.balance);
      totalAssets += bal;
      breakdown.investments.push({ name: inv.name, type: inv.account_type, amount: bal });
    }
    const netWorth = totalAssets - totalLiabilities;
    const result = await pool.query(
      `INSERT INTO net_worth_snapshots (total_assets, total_liabilities, net_worth, breakdown, snapshot_date)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)
       ON CONFLICT (snapshot_date) DO UPDATE SET total_assets = $1, total_liabilities = $2, net_worth = $3, breakdown = $4
       RETURNING *`,
      [totalAssets, totalLiabilities, netWorth, JSON.stringify(breakdown)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/net-worth/history
router.get("/api/net-worth/history", async (req, res) => {
  const months = Math.max(1, Math.min(parseInt(req.query.months) || 12, 60));
  try {
    const result = await pool.query(
      "SELECT * FROM net_worth_snapshots WHERE snapshot_date >= CURRENT_DATE - make_interval(months => $1) ORDER BY snapshot_date",
      [months]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// ============================================================================
// Investment Accounts
// ============================================================================

// GET /api/investment-accounts
router.get("/api/investment-accounts", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM investment_accounts WHERE is_active = true ORDER BY balance DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// POST /api/investment-accounts
router.post("/api/investment-accounts", async (req, res) => {
  const { name, institution, account_type, balance, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });
  const validTypes = ["brokerage", "retirement", "401k", "ira", "roth_ira", "529", "hsa", "crypto", "other"];
  const type = validTypes.includes(account_type) ? account_type : "brokerage";
  try {
    const result = await pool.query(
      `INSERT INTO investment_accounts (name, institution, account_type, balance, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, institution || null, type, parseFloat(balance) || 0, notes || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// PATCH /api/investment-accounts/:id
router.patch("/api/investment-accounts/:id", async (req, res) => {
  const ALLOWED_FIELDS = new Set(["name", "institution", "account_type", "notes"]);
  try {
    const updates = []; const values = []; let idx = 1;
    for (const f of ALLOWED_FIELDS) {
      if (req.body[f] !== undefined) { updates.push(`"${f}" = $${idx++}`); values.push(f === "notes" ? (req.body[f] || null) : req.body[f]); }
    }
    if (req.body.balance !== undefined) { updates.push(`"balance" = $${idx++}`); values.push(parseFloat(req.body.balance)); }
    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });
    updates.push(`updated_at = now()`);
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE investment_accounts SET ${updates.join(", ")} WHERE id = $${idx} AND is_active = true RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// DELETE /api/investment-accounts/:id
router.delete("/api/investment-accounts/:id", async (req, res) => {
  try {
    await pool.query("UPDATE investment_accounts SET is_active = false, updated_at = now() WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "An internal error occurred." });
  }
});

// GET /api/context-export
router.get("/api/context-export", async (req, res) => {
  const format = req.query.format || "markdown";
  try {
    const [accounts, monthlySpend, subs, goals, creditCards, netWorth, recentInsight, settings] = await Promise.all([
      pool.query("SELECT name, type, subtype, mask, available_balance, current_balance, apr FROM linked_accounts ORDER BY type, name"),
      pool.query("SELECT TO_CHAR(date, 'YYYY-MM') AS month, SUM(amount) AS total, COUNT(*) AS txns FROM transactions WHERE amount > 0 AND date >= CURRENT_DATE - INTERVAL '12 months' GROUP BY TO_CHAR(date, 'YYYY-MM') ORDER BY month"),
      pool.query("SELECT display_name, amount, cadence_days, category, next_expected FROM detected_subscriptions WHERE is_active = true AND is_dismissed = false AND cancelled_at IS NULL ORDER BY amount DESC"),
      pool.query("SELECT * FROM financial_goals WHERE is_active = true ORDER BY target_date ASC NULLS LAST").catch(() => ({ rows: [] })),
      pool.query("SELECT name, mask, current_balance, available_balance, apr FROM linked_accounts WHERE type = 'credit' AND current_balance IS NOT NULL").catch(() => ({ rows: [] })),
      pool.query("SELECT * FROM net_worth_snapshots ORDER BY snapshot_date DESC LIMIT 6").catch(() => ({ rows: [] })),
      pool.query("SELECT insight_text, created_at FROM financial_insights ORDER BY created_at DESC LIMIT 1").catch(() => ({ rows: [] })),
      pool.query("SELECT zip_code FROM user_settings WHERE id = 1").catch(() => ({ rows: [{}] })),
    ]);

    const zipCode = settings.rows[0]?.zip_code;
    const state = zipCode ? zipToState(zipCode) : null;

    if (format === "json") {
      return res.json({
        generated_at: new Date().toISOString(),
        accounts: accounts.rows,
        monthly_spending_12mo: monthlySpend.rows,
        subscriptions: subs.rows,
        goals: goals.rows,
        credit_cards: creditCards.rows.map(c => {
          const owed = parseFloat(c.current_balance || 0);
          const avail = parseFloat(c.available_balance || 0);
          return { ...c, credit_limit: owed + avail, utilization_pct: (owed + avail) > 0 ? Math.round(owed / (owed + avail) * 100) : 0 };
        }),
        net_worth_history: netWorth.rows,
        latest_insight: recentInsight.rows[0] || null,
        location: state ? { zip: zipCode, state } : null,
      });
    }

    // Markdown format
    let md = "# My Personal Finance Data (exported " + new Date().toLocaleDateString() + ")\n\n";

    md += "## Accounts\n";
    for (const a of accounts.rows) {
      const bal = a.type === "credit" ? parseFloat(a.current_balance || 0) : parseFloat(a.available_balance || a.current_balance || 0);
      md += "- **" + a.name + "** (" + (a.subtype || a.type) + (a.mask ? ", ****" + a.mask : "") + "): $" + bal.toFixed(2);
      if (a.type === "credit" && a.apr) md += " @ " + a.apr + "% APR";
      md += "\n";
    }

    md += "\n## Monthly Spending (12 months)\n";
    for (const r of monthlySpend.rows) {
      md += "- " + r.month + ": $" + parseFloat(r.total).toFixed(2) + " (" + r.txns + " transactions)\n";
    }

    md += "\n## Recurring Charges (" + subs.rows.length + " active)\n";
    const subsByCategory = {};
    for (const s of subs.rows) {
      const cat = s.category || "subscription";
      if (!subsByCategory[cat]) subsByCategory[cat] = [];
      subsByCategory[cat].push(s);
    }
    for (const [cat, items] of Object.entries(subsByCategory)) {
      md += "### " + cat.charAt(0).toUpperCase() + cat.slice(1) + "s\n";
      for (const s of items) {
        md += "- " + s.display_name + ": $" + parseFloat(s.amount).toFixed(2) + " every " + s.cadence_days + " days (next: " + s.next_expected + ")\n";
      }
    }

    if (goals.rows.length > 0) {
      md += "\n## Financial Goals\n";
      for (const g of goals.rows) {
        const pct = parseFloat(g.target_amount) > 0 ? Math.round(parseFloat(g.current_amount) / parseFloat(g.target_amount) * 100) : 0;
        md += "- **" + g.name + "** (" + g.type + "): $" + parseFloat(g.current_amount).toFixed(2) + " / $" + parseFloat(g.target_amount).toFixed(2) + " (" + pct + "%)";
        if (g.monthly_contribution > 0) md += ", contributing $" + parseFloat(g.monthly_contribution).toFixed(2) + "/mo";
        if (g.target_date) md += ", target: " + g.target_date;
        md += "\n";
      }
    }

    if (creditCards.rows.length > 0) {
      md += "\n## Credit Card Details\n";
      for (const c of creditCards.rows) {
        const owed = parseFloat(c.current_balance || 0);
        const avail = parseFloat(c.available_balance || 0);
        const limit = owed + avail;
        const util = limit > 0 ? Math.round(owed / limit * 100) : 0;
        md += "- **" + c.name + "**" + (c.mask ? " (****" + c.mask + ")" : "") + ": $" + owed.toFixed(2) + " owed / $" + limit.toFixed(2) + " limit (" + util + "% utilization)";
        if (c.apr) md += ", " + c.apr + "% APR";
        md += "\n";
      }
    }

    if (netWorth.rows.length > 0) {
      md += "\n## Net Worth History\n";
      for (const nw of netWorth.rows) {
        md += "- " + nw.snapshot_date + ": $" + parseFloat(nw.net_worth).toFixed(2) + " (assets: $" + parseFloat(nw.total_assets).toFixed(2) + ", liabilities: $" + parseFloat(nw.total_liabilities).toFixed(2) + ")\n";
      }
    }

    if (state) md += "\n## Location\nZIP: " + zipCode + " (State: " + state + ")\n";

    if (recentInsight.rows.length > 0) {
      md += "\n## Most Recent AI Analysis (" + new Date(recentInsight.rows[0].created_at).toLocaleDateString() + ")\n";
      md += recentInsight.rows[0].insight_text + "\n";
    }

    md += "\n---\n*Use this data as context for any personal finance questions. Ask me about budgeting, debt payoff strategies, savings goals, investment allocation, or any specific transaction patterns.*\n";

    res.setHeader("Content-Type", "text/markdown");
    res.setHeader("Content-Disposition", "attachment; filename=perfin-context.md");
    res.send(md);
  } catch (err) {
    console.error("context-export error:", err.message);
    res.status(500).json({ error: "An internal error occurred." });
  }
});

module.exports = router;
