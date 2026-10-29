// Linked tasks (roadmap T2.4 X1a): tasks another app keeps in step with an item
// it owns. Under the unified shell Perfin computes the set of tasks that should
// be open (rent due, a utility amount to enter, a bill to pay) and hands it to
// syncLinkedTasks, which reconciles the todos table to it:
//   - a key in the set with no row → a task is created (automations + webhooks
//     through announceTodoEvent, like any other task);
//   - an open task of a listed kind whose key left the set (and isn't in
//     `retain`) → closed, marked auto_closed — quietly: it is not your
//     completion, so no todo_completed automation, webhook or Slack post, and
//     analytics / the weekly review / Ask leave it out (cycle-8 F18);
//   - a key in `retain` (an item still open in the source that is no longer
//     due a new task — an unpaid bill older than its creation window) keeps an
//     existing open task open and creates nothing (F17);
//   - an auto_closed task whose key came back → reopened;
//   - an open task's title, description, due date and priority are refreshed
//     only while each still equals what the sync last wrote (source_snapshot),
//     so a field you edited keeps your value and the others keep refreshing.
// A task you completed or reopened yourself is source_detached (db/030's
// trigger) and never touched again; a task you deleted keeps its row (and its
// key) in the trash, and once it is deleted for good its key stays in
// linked_task_tombstones (db/031's trigger), so it is never recreated (F16).
// One sync at a time across processes: each run holds a transaction-level
// advisory lock (LINKED_TASKS_LOCK_KEY) and announces its creations only after
// COMMIT (F20).
// source_url is a path inside the SOURCE app ('/housing'); the task chip joins
// it with that app's mount (window.LINKED_APP_BASES — '/perfin' under the shell).
// ensureLinkedTask is the one-off form (the still-charging subscription): it
// creates a task once and never closes it.
const helpers = require("../helpers");
const { VALID_PRIORITIES } = require("../config");

const APP_RE = /^[a-z][a-z0-9-]{0,30}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,40}$/;
const KEY_REST_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 2000;
const MAX_URL = 500;

// '<app>:<kind>:<id>' → { kind } when it belongs to app, else null.
function parseKey(app, key) {
  if (typeof key !== "string" || !key.startsWith(app + ":")) return null;
  const rest = key.slice(app.length + 1);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const kind = rest.slice(0, i);
  const id = rest.slice(i + 1);
  if (!KIND_RE.test(kind) || !KEY_REST_RE.test(id)) return null;
  return { kind };
}

function isRealYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// A same-app path only: "/x", never "//host", a scheme or a backslash.
function isSafePath(u) {
  return typeof u === "string" && u.length <= MAX_URL && u.startsWith("/") && !u.startsWith("//") && !u.includes("\\");
}

// → { task } (normalized) or { error }. kinds = the kinds this call may write.
function checkTask(app, kinds, t) {
  if (!t || typeof t !== "object") return { error: "not an object" };
  const parsed = parseKey(app, t.key);
  if (!parsed) return { error: "bad key" };
  if (!kinds.includes(parsed.kind)) return { error: `kind ${parsed.kind} not listed` };
  const title = typeof t.title === "string" ? t.title.trim() : "";
  if (!title || title.length > MAX_TITLE) return { error: "title missing or too long" };
  const description = t.description == null || t.description === "" ? null : t.description;
  if (description !== null && (typeof description !== "string" || description.length > MAX_DESCRIPTION)) return { error: "description too long" };
  const url = t.url == null || t.url === "" ? null : t.url;
  if (url !== null && !isSafePath(url)) return { error: "url must be a same-app path" };
  const dueDate = t.due_date == null || t.due_date === "" ? null : t.due_date;
  if (dueDate !== null && !isRealYmd(dueDate)) return { error: "due_date must be YYYY-MM-DD" };
  const priority = t.priority == null ? "medium" : t.priority;
  if (!VALID_PRIORITIES.includes(priority)) return { error: "bad priority" };
  return { task: { key: t.key, kind: parsed.kind, title, description, url, due_date: dueDate, priority } };
}

// A key deleted for good (linked_task_tombstones) is never inserted again.
const INSERT_SQL = `INSERT INTO todos (title, description, priority, horizon, category, due_date,
    source_app, source_key, source_url, source_snapshot)
  SELECT $1, $2, $3, 'short', 'finance', $4, $5, $6, $7, $8
   WHERE NOT EXISTS (SELECT 1 FROM linked_task_tombstones WHERE source_key = $6)
  ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
  RETURNING *`;

// Perfin uses 727274001 and Per-sistant 727274002 for migrations.
const LINKED_TASKS_LOCK_KEY = 727274010;

async function insertTask(pool, app, task) {
  const snapshot = { title: task.title, description: task.description, due_date: task.due_date, priority: task.priority };
  const r = await pool.query(INSERT_SQL, [task.title, task.description, task.priority, task.due_date,
    app, task.key, task.url, JSON.stringify(snapshot)]);
  return r.rows[0] || null;
}

// Reconcile app's open tasks of `kinds` to `desired` ([{ key, title,
// description?, url?, due_date?, priority? }]). Only list a kind whose source
// was read successfully this run — a listed kind with a key missing from
// `desired` and `retain` is closed. `retain` = keys (of listed kinds) whose
// item is still open in the source but no longer due a task: an existing open
// task stays open, nothing is created or refreshed for it.
// → { created, updated, closed, reopened, skipped }.
async function syncLinkedTasks(pool, { app, kinds, desired, retain } = {}) {
  if (!APP_RE.test(app || "")) throw new Error("syncLinkedTasks: bad app");
  const kindList = Array.isArray(kinds) ? kinds.filter((k) => typeof k === "string" && KIND_RE.test(k)) : [];
  const items = Array.isArray(desired) ? desired : [];
  const result = { created: 0, updated: 0, closed: 0, reopened: 0, skipped: 0 };

  const valid = [];
  const desiredKeys = new Set();
  for (const item of items) {
    const checked = checkTask(app, kindList, item);
    // A well-formed key of a listed kind stays desired even when the rest of
    // the item is invalid, so a bad title never reads as "resolved".
    const parsed = parseKey(app, item && item.key);
    if (parsed && kindList.includes(parsed.kind)) desiredKeys.add(item.key);
    if (checked.error) {
      result.skipped++;
      console.error(`linked-tasks: skipped ${app} item (${checked.error})`);
      continue;
    }
    valid.push(checked.task);
  }
  const keepKeys = new Set(desiredKeys);
  for (const key of Array.isArray(retain) ? retain : []) {
    const parsed = parseKey(app, key);
    if (parsed && kindList.includes(parsed.kind)) keepKeys.add(key);
  }

  const created = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LINKED_TASKS_LOCK_KEY]);
    for (const task of valid) {
      const row = await insertTask(client, app, task);
      if (row) created.push(row);
    }
    result.created = created.length;

    if (kindList.length) {
      const reopened = await client.query(
        `UPDATE todos SET completed = false, completed_at = NULL, auto_closed = false, updated_at = now()
          WHERE source_app = $1 AND source_key = ANY($2::text[])
            AND completed AND auto_closed AND NOT source_detached AND deleted_at IS NULL
          RETURNING id`, [app, [...desiredKeys]]);
      result.reopened = reopened.rowCount;

      result.updated = await refreshOpenTasks(client, app, valid);

      const closed = await client.query(
        `UPDATE todos SET completed = true, completed_at = now(), auto_closed = true, updated_at = now()
          WHERE source_app = $1 AND split_part(source_key, ':', 2) = ANY($3::text[])
            AND NOT (source_key = ANY($2::text[]))
            AND NOT completed AND NOT source_detached AND deleted_at IS NULL
          RETURNING id`, [app, [...keepKeys], kindList]);
      result.closed = closed.rowCount;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  for (const row of created) helpers.announceTodoEvent("todo_created", row);
  return result;
}

// Edits win (decision 3): each field of an open, attached task is replaced
// only while it still equals the snapshot; the snapshot always moves to the
// newly desired values and source_url follows the source. A task whose
// snapshot and url already match is not written, so a re-run updates nothing.
const REFRESH_SQL = `UPDATE todos t SET
    title = CASE WHEN t.title IS NOT DISTINCT FROM t.source_snapshot->>'title' THEN d.title ELSE t.title END,
    description = CASE WHEN t.description IS NOT DISTINCT FROM t.source_snapshot->>'description' THEN d.description ELSE t.description END,
    due_date = CASE WHEN t.due_date IS NOT DISTINCT FROM (t.source_snapshot->>'due_date')::date THEN d.due_date ELSE t.due_date END,
    priority = CASE WHEN t.priority IS NOT DISTINCT FROM t.source_snapshot->>'priority' THEN d.priority ELSE t.priority END,
    source_snapshot = jsonb_build_object('title', d.title, 'description', d.description, 'due_date', d.due_date, 'priority', d.priority),
    source_url = d.url,
    updated_at = now()
  FROM jsonb_to_recordset($2::jsonb) AS d(key text, title text, description text, due_date date, priority text, url text)
  WHERE t.source_key = d.key AND t.source_app = $1
    AND NOT t.completed AND NOT t.source_detached AND t.deleted_at IS NULL
    AND (t.source_snapshot IS DISTINCT FROM jsonb_build_object('title', d.title, 'description', d.description, 'due_date', d.due_date, 'priority', d.priority)
         OR t.source_url IS DISTINCT FROM d.url)
  RETURNING t.id`;

async function refreshOpenTasks(pool, app, tasks) {
  if (!tasks.length) return 0;
  const rows = tasks.map((t) => ({ key: t.key, title: t.title, description: t.description, due_date: t.due_date, priority: t.priority, url: t.url }));
  const r = await pool.query(REFRESH_SQL, [app, JSON.stringify(rows)]);
  return r.rowCount;
}

// One-off event task: created once (a trashed or deleted one isn't recreated), never
// closed by a sync — list its kind in no syncLinkedTasks call.
// → { created, id } or { created: false, error }.
async function ensureLinkedTask(pool, { app, task } = {}) {
  if (!APP_RE.test(app || "")) throw new Error("ensureLinkedTask: bad app");
  const parsed = parseKey(app, task && task.key);
  const checked = checkTask(app, parsed ? [parsed.kind] : [], task);
  if (checked.error) return { created: false, id: null, error: checked.error };
  const row = await insertTask(pool, app, checked.task);
  if (!row) {
    const existing = await pool.query("SELECT id FROM todos WHERE source_key = $1", [checked.task.key]);
    return { created: false, id: existing.rows[0] ? existing.rows[0].id : null };
  }
  helpers.announceTodoEvent("todo_created", row);
  return { created: true, id: row.id };
}

// Which of these items (a linked-task key without its "<app>:" prefix, e.g.
// "housing:2026-11") have an OPEN, untrashed task — the surface for that item
// (cycle-8 E3e, ST2). Read-only; a failed read is an empty set (fail-soft: the
// other surface stays).
async function openLinkedItems(pool, items, { app = "perfin" } = {}) {
  const want = [...new Set((items || []).filter((i) => typeof i === "string" && i))];
  if (!pool || !want.length) return new Set();
  try {
    const r = await pool.query(
      `SELECT source_key FROM todos
        WHERE source_key = ANY($1::text[]) AND NOT completed AND deleted_at IS NULL`,
      [want.map((i) => app + ":" + i)]);
    return new Set(r.rows.map((row) => String(row.source_key).slice(app.length + 1)));
  } catch (e) {
    console.error("linked task lookup failed:", e.message);
    return new Set();
  }
}

module.exports = { syncLinkedTasks, ensureLinkedTask, checkTask, parseKey, openLinkedItems, LINKED_TASKS_LOCK_KEY };
