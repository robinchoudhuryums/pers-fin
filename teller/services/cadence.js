// ============================================================================
// Cadence stepping — calendar-month aware (DC-9)
// ============================================================================
// Recurring-charge cadences are stored in DAYS (7/14/30/60/90/365). Stepping a
// monthly bill by a fixed 30 days drifts ~5 days/year and can land it twice in
// one calendar month (next_expected Sep 1 → Oct 1 AND Oct 31). Month-scale
// cadences therefore step by CALENDAR MONTHS anchored to the original day of
// month, clamped to the month's length (Jan 31 → Feb 28/29 → Mar 31 — the
// anchor day is re-applied each step, so a short month never shifts the
// rest of the series). Week-scale cadences (7/14) keep stepping in days.
//
// All dates are plain 'YYYY-MM-DD' strings in and out (a pg DATE arriving as a
// JS Date at local midnight is read with LOCAL getters so the day never shifts
// with the host's UTC offset). Pure module — no DB, safe to require from the
// standalone scripts/ detectors.
// ============================================================================

// cadence_days → whole calendar months (month-scale cadences only).
const MONTH_CADENCES = { 30: 1, 60: 2, 90: 3, 365: 12 };

function cadenceMonths(cadenceDays) {
  return MONTH_CADENCES[parseInt(cadenceDays, 10)] || null;
}

// → { y, m (0-11), d } or null
function parseYmd(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return { y: value.getFullYear(), m: value.getMonth(), d: value.getDate() };
  }
  const parts = String(value).slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  return { y: parts[0], m: parts[1] - 1, d: parts[2] };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function fmt(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toISOString().slice(0, 10);
}

// The k-th occurrence after `anchor` (k may be negative; k = 0 is the anchor
// itself). Month-scale cadences keep the anchor's day of month (clamped).
function stepDate(anchor, cadenceDays, k) {
  const a = parseYmd(anchor);
  const cad = parseInt(cadenceDays, 10);
  if (!a || !(cad > 0)) return null;
  const months = cadenceMonths(cad);
  if (months) {
    const total = a.m + months * k;
    const y = a.y + Math.floor(total / 12);
    const m = ((total % 12) + 12) % 12;
    return fmt(y, m, Math.min(a.d, daysInMonth(y, m)));
  }
  return fmt(a.y, a.m, a.d + cad * k);
}

function nextOccurrence(anchor, cadenceDays) {
  return stepDate(anchor, cadenceDays, 1);
}

// Every occurrence of the series anchored at `anchor` that falls within
// [from, to] (inclusive, 'YYYY-MM-DD'). Walks both directions from the anchor
// so a window before the anchor works too. Bounded by `max`.
function occurrencesBetween(anchor, cadenceDays, from, to, max = 400) {
  const a = parseYmd(anchor);
  const cad = parseInt(cadenceDays, 10);
  if (!a || !(cad > 0) || !from || !to || from > to) return [];
  // Keep the RAW anchor (a manual bill's due_day 31 anchored in February is
  // "the 31st, clamped" — normalizing it here would roll it to Mar 3).
  const rawAnchor = `${a.y}-${String(a.m + 1).padStart(2, "0")}-${String(a.d).padStart(2, "0")}`;
  const clampedAnchor = fmt(a.y, a.m, Math.min(a.d, daysInMonth(a.y, a.m)));
  // Rough starting k so long series don't iterate from far away.
  const approxDays = cadenceMonths(cad) ? cadenceMonths(cad) * 30.44 : cad;
  const dayDiff = (Date.parse(from + "T00:00:00Z") - Date.parse(clampedAnchor + "T00:00:00Z")) / 86400000;
  let k = Math.floor(dayDiff / approxDays) - 2;
  const out = [];
  for (let i = 0; i < max; i++, k++) {
    const d = stepDate(rawAnchor, cad, k);
    if (d > to) break;
    if (d >= from) out.push(d);
  }
  return out;
}

// First occurrence on or after `from`.
function firstOnOrAfter(anchor, cadenceDays, from) {
  const far = fmt(...(() => { const p = parseYmd(from); return [p.y + 3, p.m, p.d]; })());
  return occurrencesBetween(anchor, cadenceDays, from, far, 2000)[0] || null;
}

// Manual bills (DC-15): ONE placement rule shared by the in-app calendar and
// the ICS feed. The series is anchored on the month the bill was created with
// the bill's due_day (clamped to each month's real length — no blanket 28-day
// cap), stepping 1/3/12 months for monthly/quarterly/yearly. Previously the
// calendar anchored quarterly/yearly on created_at while the ICS anchored on
// "this month", so the two surfaces disagreed on which months a bill falls in.
const MANUAL_BILL_CADENCE_DAYS = { monthly: 30, quarterly: 90, yearly: 365 };

function manualBillOccurrences(bill, from, to) {
  const cad = MANUAL_BILL_CADENCE_DAYS[bill && bill.cadence];
  const created = parseYmd(bill && bill.created_at) || parseYmd(from);
  const dueDay = Math.min(31, Math.max(1, parseInt(bill && bill.due_day, 10) || 1));
  if (!cad || !created) return [];
  const anchor = `${created.y}-${String(created.m + 1).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
  return occurrencesBetween(anchor, cad, from, to);
}

function addDaysStr(ymd, n) {
  const p = parseYmd(ymd);
  return p ? fmt(p.y, p.m, p.d + n) : null;
}

// Occurrences of a detected recurring charge within [from, to]. The series is
// anchored on the REAL last charge date (last_charged / last_transferred) so
// the day of month never drifts — a stored next_expected is itself a clamped
// step (a 31st-billed sub's next_expected in September is the 30th, and
// anchoring there would move it to the 30th forever). next_expected is the
// lower bound: nothing is projected before the next expected charge.
function seriesOccurrences(lastDate, nextExpected, cadenceDays, from, to, max) {
  const next = ymdStr(nextExpected);
  const anchor = ymdStr(lastDate) || next;
  if (!anchor || !from || !to) return [];
  const start = next && next > from ? next : from;
  return occurrencesBetween(anchor, cadenceDays, start, to, max);
}

// ---------------------------------------------------------------------------
// Income streams (DC-10)
// ---------------------------------------------------------------------------
// The bill calendar used to GROUP BY (source, exact amount) and place ONE event
// per month on the average day — so biweekly pay (2–3 deposits/month) showed a
// single event, a semimonthly 1st/15th paycheck averaged to "the 8th", and a
// paycheck varying by cents split into many 1-row groups that fell below the
// HAVING COUNT >= 2 floor. Income now reads as ~50% of reality.
//
// buildIncomeStreams takes raw deposit rows ({ source, date, amount>0 }),
// clusters each source's deposits by amount (±10%), classifies each cluster's
// cadence from its gaps, and returns streams:
//   { source, amount (median), cadence: 'weekly'|'biweekly'|'semimonthly'|'monthly',
//     anchor (latest date), days (semimonthly day-of-month pair), last }
// incomeEventsBetween(stream, from, to) projects a stream into a window.
const INCOME_AMOUNT_TOLERANCE = 0.10;

function ymdStr(v) {
  const p = parseYmd(v);
  return p ? `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : null;
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function dayGap(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Split sorted day-of-month values into two groups at the largest jump; each
// group must be tight (spread <= 3 days) and hold >= 2 deposits.
function twoDayClusters(daysOfMonth) {
  const d = [...daysOfMonth].sort((x, y) => x - y);
  if (d.length < 4) return null;
  let cut = -1, best = -1;
  for (let i = 1; i < d.length; i++) {
    if (d[i] - d[i - 1] > best) { best = d[i] - d[i - 1]; cut = i; }
  }
  const lo = d.slice(0, cut), hi = d.slice(cut);
  if (lo.length < 2 || hi.length < 2) return null;
  if (lo[lo.length - 1] - lo[0] > 3 || hi[hi.length - 1] - hi[0] > 3) return null;
  return [Math.round(median(lo)), Math.round(median(hi))];
}

function classifyIncomeDates(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i++) gaps.push(dayGap(dates[i - 1], dates[i]));
  const med = median(gaps);
  if (med === null) return null;
  if (med <= 10) return { cadence: "weekly" };
  if (med <= 20) {
    // Biweekly gaps are a steady 14 (±1); semimonthly (1st/15th, 15th/last)
    // alternates 13–17 and lands on the same two days of month.
    const allFourteen = gaps.every(g => g >= 13 && g <= 15);
    const days = twoDayClusters(dates.map(x => parseYmd(x).d));
    if (!allFourteen && days) return { cadence: "semimonthly", days };
    return { cadence: "biweekly" };
  }
  if (med <= 45) return { cadence: "monthly" };
  return null; // quarterly/irregular income isn't projected onto the month grid
}

function buildIncomeStreams(rows) {
  const bySource = new Map();
  for (const r of rows) {
    const date = ymdStr(r.date);
    const amount = Math.abs(parseFloat(r.amount));
    if (!date || !(amount > 0)) continue;
    const key = r.source || "Income";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push({ date, amount });
  }
  const streams = [];
  for (const [source, entries] of bySource) {
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const clusters = [];
    for (const e of entries) {
      const c = clusters.find(cl => Math.abs(e.amount - cl.ref) / cl.ref <= INCOME_AMOUNT_TOLERANCE);
      if (c) c.items.push(e); else clusters.push({ ref: e.amount, items: [e] });
    }
    for (const cl of clusters) {
      if (cl.items.length < 2) continue;
      const dates = cl.items.map(i => i.date);
      const cls = classifyIncomeDates(dates);
      if (!cls) continue;
      streams.push({
        source,
        amount: Math.round(median(cl.items.map(i => i.amount)) * 100) / 100,
        cadence: cls.cadence,
        days: cls.days || null,
        anchor: dates[dates.length - 1],
        last: dates[dates.length - 1],
        count: dates.length,
      });
    }
  }
  return streams;
}

// A stream is live when its latest deposit is within ~1.5 cycles of `today`
// (a job you left three months ago shouldn't keep paying you on the calendar).
function isIncomeStreamLive(stream, today) {
  const maxAge = stream.cadence === "monthly" ? 50 : 35;
  return dayGap(stream.last, today) <= maxAge;
}

function incomeEventsBetween(stream, from, to) {
  if (stream.cadence === "weekly") return occurrencesBetween(stream.anchor, 7, from, to);
  if (stream.cadence === "biweekly") return occurrencesBetween(stream.anchor, 14, from, to);
  if (stream.cadence === "monthly") return occurrencesBetween(stream.anchor, 30, from, to);
  if (stream.cadence === "semimonthly" && stream.days) {
    const out = [];
    const f = parseYmd(from);
    for (const day of stream.days) {
      const anchor = `${f.y}-${String(f.m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      out.push(...occurrencesBetween(anchor, 30, from, to));
    }
    return out.sort();
  }
  return [];
}

module.exports = {
  seriesOccurrences,
  buildIncomeStreams,
  classifyIncomeDates,
  isIncomeStreamLive,
  incomeEventsBetween,
  MANUAL_BILL_CADENCE_DAYS,
  manualBillOccurrences,
  addDaysStr,
  MONTH_CADENCES,
  cadenceMonths,
  parseYmd,
  daysInMonth,
  stepDate,
  nextOccurrence,
  occurrencesBetween,
  firstOnOrAfter,
};
