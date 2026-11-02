// The landing page's status lines (design pass D7 — `.cycle/plan-design-ux.md`,
// decision 13). The shell manifest's start_url is "/", so the home-screen app
// opens on the landing tile picker; each tile gets one line saying what needs
// a look in that app.
//
//   - Perfin: "$X owed to <payee> · N bills due this week · N to review" — from
//     Perfin's own gatherDashboardSummary (INV-147), only its rent / bills /
//     uncategorized parts, in-process over the wired pool (never an HTTP
//     self-fetch, INV-25). "Nothing needs attention" when all three read and
//     none has anything.
//   - Per-sistant: "N tasks due today · N overdue" — its taskDueCounts.
//
// Read-only. Each line has its own time budget (1.5s); a line whose read fails
// or runs over is null, and the tile keeps just its description. landingStatus
// never throws.
//
// Cycle-8 F33: each line's read is single-flight and its result kept 30 s, per
// pool. A read that ran over the budget kept running with nothing waiting for
// it, and every visit started another set of queries — on a 3-connection pool a
// slow database piled them up. Now a visit during a read waits on that same
// read, a visit within 30 s of a finished one reuses its line (a failure too,
// as null), and a read that finishes after its page was served is what the next
// visit shows.

const TIMEOUT_MS = 1500;
const CACHE_MS = 30 * 1000;
const slots = new WeakMap(); // pool → { at, value, running }

// fn's result for this pool: the cached one when under CACHE_MS old, else the
// read in flight, else a new read. Never rejects (a failure is null).
function sharedRead(pool, label, fn, now = Date.now) {
  let slot = slots.get(pool);
  if (!slot) { slot = { at: 0, value: undefined, running: null }; slots.set(pool, slot); }
  if (slot.value !== undefined && now() - slot.at < CACHE_MS) return Promise.resolve(slot.value);
  if (!slot.running) {
    slot.running = Promise.resolve()
      .then(fn)
      .catch((err) => {
        console.warn("landing status: " + label + " failed: " + (err && err.message));
        return null;
      })
      .then((v) => {
        slot.value = v === undefined ? null : v;
        slot.at = now();
        slot.running = null;
        return slot.value;
      });
  }
  return slot.running;
}

function defaultDeps() {
  return {
    // Lazy: the modules pull in each app's database layer.
    gatherDashboardSummary: (...a) => require("../teller/routes/dashboard-summary").gatherDashboardSummary(...a),
    taskDueCounts: (...a) => require("../apps/per-sistant/routes/settings").taskDueCounts(...a),
  };
}

// fn() within ms, else null; a throw (sync or async) is null too.
function within(label, ms, fn) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn("landing status: " + label + " took longer than " + ms + "ms");
      resolve(null);
    }, ms);
  });
  const run = Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.warn("landing status: " + label + " failed: " + (err && err.message));
      return null;
    });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

const money = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

// The Perfin line from a summary gathered with parts rent / bills / uncategorized.
function perfinLine(summary) {
  if (!summary || !summary.attention) return null;
  const { items = [], errors = [] } = summary.attention;
  const parts = [];
  for (const it of items) {
    if (it.kind === "rent") parts.push(money(it.amount) + " " + String(it.text).replace(/^Owed to /, "owed to "));
    else if (it.kind === "bills") parts.push(plural(it.count, "bill", "bills") + " due this week");
    else if (it.kind === "uncategorized") parts.push(it.count + " to review");
  }
  if (parts.length) return parts.join(" · ");
  return errors.length ? null : "Nothing needs attention";
}

function persistentLine(counts) {
  if (!counts) return null;
  const due = Number(counts.due_today) || 0;
  const overdue = Number(counts.overdue) || 0;
  if (!due && !overdue) return "Nothing due today";
  return plural(due, "task", "tasks") + " due today · " + overdue + " overdue";
}

async function landingStatus({ perfinPool, persistentPool, deps, timeoutMs = TIMEOUT_MS } = {}) {
  const d = Object.assign(defaultDeps(), deps || {});
  const [summary, counts] = await Promise.all([
    perfinPool
      ? within("perfin", timeoutMs, () => sharedRead(perfinPool, "perfin", () => d.gatherDashboardSummary(perfinPool, { parts: ["rent", "bills", "uncategorized"] })))
      : null,
    persistentPool ? within("per-sistant", timeoutMs, () => sharedRead(persistentPool, "per-sistant", () => d.taskDueCounts(persistentPool))) : null,
  ]);
  return { perfin: perfinLine(summary), persistent: persistentLine(counts) };
}

module.exports = { landingStatus, perfinLine, persistentLine, sharedRead, TIMEOUT_MS, CACHE_MS };
