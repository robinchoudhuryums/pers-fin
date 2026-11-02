// Cycle-8 broad scan Batch 6 on real Postgres — F42: the tier-1 audit on real
// spending no longer compares a prior-year same-month claim ("Last <this
// month> …"), "last year", "last week" or "last quarter" with this month's
// actuals, while the same claim about this month is still flagged.
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { SKIP, perfinDb } = require("./_setup");

describe("cycle-8 Batch 6 — the audit's period rules on real Postgres", { skip: SKIP }, () => {
  let pool, audit, monthName;

  before(async () => {
    pool = await perfinDb("c8_batch6");
    const fq = require("../../teller/services/financial-queries");
    const today = fq.todayStr();
    monthName = new Date(fq.currentMonth() + "-15T12:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    audit = require("../../teller/services/ai-audit");
    await pool.query("INSERT INTO linked_accounts (account_id, name, type, subtype, is_manual, current_balance) VALUES ('card','Card','credit','credit card',true,0)");
    await pool.query(`INSERT INTO transactions (account_id, transaction_id, amount, date, merchant_name, name, pending, user_category)
                      VALUES ('card','t_shop',120,$1,'Target','TARGET',false,'Shopping')`, [today]);
  });
  after(async () => { if (pool) await pool.end(); });

  const critical = async (text) =>
    (await audit.auditInsight(text, null)).findings.filter((f) => f.check === "arithmetic" && f.severity === "critical").length;

  it("F42: prior-year and other-period claims are skipped; the this-month claim is still flagged", async () => {
    assert.equal(await critical(`Shopping hit $800 this month.`), 1, "control: $800 vs $120 this month");
    assert.equal(await critical(`Last ${monthName} Shopping hit $800.`), 0, "the scan's seasonal insight");
    assert.equal(await critical(`Shopping hit $800 in ${monthName} ${Number(new Date().getUTCFullYear()) - 1}.`), 0);
    assert.equal(await critical("Last year Shopping hit $800."), 0);
    assert.equal(await critical("Shopping was $800 last week."), 0);
    assert.equal(await critical("Last quarter Shopping hit $800."), 0);
  });
});
