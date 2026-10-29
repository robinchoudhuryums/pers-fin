// ============================================================================
// Transaction id watermarks with an overlap rescan (cycle-8 E2c, ST3)
// ============================================================================
// The "what's new since the last check" reads over transactions (the anomaly
// check, "Paycheck landed") keep two things per check: the newest id visible
// when the check started (`id`) and the database's time then (`at`).
//
//   - readMark(db) — { id, at }: MAX(transactions.id) (0 for an empty table)
//     and now(), both as text, read BEFORE the candidates. The new watermark
//     is this mark, never a row read afterwards, so a row committed between
//     the mark and the candidate read is left for the next check (the
//     candidates stop at `id <= mark`).
//   - windowSql(...) — the WHERE fragment: rows above the watermark id, PLUS
//     the overlap — rows at or below it created less than `overlapHours`
//     before the previous check's time. An id is allocated at INSERT, not at
//     COMMIT: a transaction still open at the last check (a CSV import, a
//     slow sync) can commit a LOWER id after it, which the id alone would
//     skip for good. A row stamps created_at with its transaction's start,
//     so such a row was created less than its transaction's duration before
//     the previous check — inside the overlap unless the transaction stayed
//     open longer than `overlapHours`. The caller drops overlap rows it
//     already announced (notification_log).
//   - advanceSql(idColumn, atColumn) — moves both columns forward only
//     (GREATEST), so two checks finishing in either order never step back.
// Replaces cycle-8 F1's created_at mark bounded by pg_stat_activity (it
// needed that view's rights and stalled behind any long-open transaction).
// ============================================================================

const OVERLAP_HOURS = 24;

const MARK_SQL = "SELECT COALESCE(MAX(id), 0)::text AS mark_id, now()::text AS mark_at FROM transactions";

async function readMark(db) {
  const r = (await db.query(MARK_SQL)).rows[0] || {};
  return { id: r.mark_id || "0", at: r.mark_at || null };
}

// alias: the transactions alias ("t" → "t.id"; "" for an unaliased table).
// watermark / since / mark: the parameter placeholders holding the stored id,
// the stored time (NULL → no overlap: a first check reads everything above
// the id anyway) and readMark's id.
function windowSql({ alias = "t", watermark, since, mark, overlapHours = OVERLAP_HOURS }) {
  const a = alias ? alias + "." : "";
  const h = Number(overlapHours);
  if (!Number.isInteger(h) || h < 0) throw new Error("overlapHours must be a non-negative integer");
  return {
    where: `(${a}id <= ${mark}::bigint AND (${a}id > ${watermark}::bigint OR (${since}::timestamptz IS NOT NULL AND ${a}created_at > ${since}::timestamptz - make_interval(hours => ${h}))))`,
    inOverlap: `(${a}id <= ${watermark}::bigint)`,
  };
}

function advanceSql(idColumn, atColumn) {
  return `UPDATE user_settings SET ${idColumn} = GREATEST(COALESCE(${idColumn}, 0), $1::bigint), ${atColumn} = GREATEST(${atColumn}, $2::timestamptz) WHERE id = 1`;
}

module.exports = { OVERLAP_HOURS, MARK_SQL, readMark, windowSql, advanceSql };
