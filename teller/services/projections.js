// ============================================================================
// Projections — FIRE number, time-to-FIRE, and spending runway (pure math)
// ============================================================================
// No SQL here: callers (routes/goals.js GET /api/fire-projection) assemble the
// inputs from getNetWorth + getMonthlyIncome/Spending and the fire_* settings.
// Kept pure so the money math is exhaustively unit-testable.
//
// Conventions:
// - annualReturnPct is treated as a REAL (inflation-adjusted) return, so the
//   FIRE number and projections are in today's dollars. Default 5.
// - withdrawalRatePct drives the FIRE number: annualSpending × (100 / rate)
//   (4% rule → 25× annual spending).
// - Monthly compounding uses the geometric monthly rate so the annual figure
//   is honored exactly: (1 + r)^(1/12) − 1.

const MAX_YEARS = 75;
const RUNWAY_CAP_MONTHS = 1200; // 100 years — report null beyond (effectively infinite)

function monthlyRate(annualReturnPct) {
  return Math.pow(1 + annualReturnPct / 100, 1 / 12) - 1;
}

// Months until net worth reaches the FIRE number, compounding monthly with
// contributions. Returns { months: n | null, series } — null when the target
// is unreachable within MAX_YEARS (e.g. negative savings rate and the
// compounding never closes the gap).
function computeFireProjection({
  netWorth = 0,
  monthlySavings = 0,
  monthlySpending = 0,
  annualReturnPct = 5,
  withdrawalRatePct = 4,
}) {
  const annualSpending = monthlySpending * 12;
  const fireNumber = withdrawalRatePct > 0 && annualSpending > 0
    ? annualSpending * (100 / withdrawalRatePct)
    : null;
  const r = monthlyRate(annualReturnPct);

  const out = {
    fire_number: fireNumber === null ? null : Math.round(fireNumber * 100) / 100,
    progress_pct: fireNumber ? Math.max(0, Math.min(999, (netWorth / fireNumber) * 100)) : null,
    already_fire: fireNumber !== null && netWorth >= fireNumber,
    months_to_fire: null,
    series: [],
  };

  // Yearly projection series is useful even without a reachable target.
  let nw = netWorth;
  const horizonYears = 40;
  out.series.push({ year: 0, projected_net_worth: Math.round(nw * 100) / 100 });
  let fireMonth = out.already_fire ? 0 : null;
  for (let m = 1; m <= Math.max(MAX_YEARS, horizonYears) * 12; m++) {
    nw = nw * (1 + r) + monthlySavings;
    if (fireMonth === null && fireNumber !== null && nw >= fireNumber) fireMonth = m;
    if (m % 12 === 0 && m / 12 <= horizonYears) {
      out.series.push({ year: m / 12, projected_net_worth: Math.round(nw * 100) / 100 });
    }
    if (m >= MAX_YEARS * 12 && m % 12 === 0 && m / 12 >= horizonYears) break;
  }
  out.months_to_fire = out.already_fire ? 0 : fireMonth; // null = unreachable in MAX_YEARS

  return out;
}

// Months current net worth covers at current spending with NO income — the
// "if I stopped earning today" figure. Assets keep compounding while being
// drawn down. null when spending is non-positive (runway is infinite) or the
// portfolio outearns the draw (also effectively infinite).
function computeRunwayMonths({ netWorth = 0, monthlySpending = 0, annualReturnPct = 5 }) {
  if (monthlySpending <= 0) return null;
  if (netWorth <= 0) return 0;
  const r = monthlyRate(annualReturnPct);
  let nw = netWorth;
  for (let m = 1; m <= RUNWAY_CAP_MONTHS; m++) {
    nw = nw * (1 + r) - monthlySpending;
    if (nw <= 0) return m;
  }
  return null; // portfolio sustains the draw indefinitely (or > 100 years)
}

module.exports = { computeFireProjection, computeRunwayMonths, monthlyRate };
