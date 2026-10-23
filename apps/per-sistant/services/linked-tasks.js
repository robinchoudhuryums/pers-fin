// Linked tasks (roadmap T2.4 X1a): tasks another app keeps in step with an item
// it owns. Under the unified shell Perfin computes the set of tasks that should
// be open (rent due, a utility amount to enter, a bill to pay) and hands it to
// syncLinkedTasks, which reconciles the todos table to it:
//   - a key in the set with no row → a task is created (automations + webhooks
//     through announceTodoEvent, like any other task);
//   - an open task of a listed kind whose key left the set → closed, marked
//     auto_closed;
//   - an auto_closed task whose key came back → reopened.
// A task you completed or reopened yourself is source_detached (db/030's
// trigger) and never touched again; a task you deleted keeps its row (and its
// key) in the trash, so it isn't recreated until the 30-day purge.
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

const INSERT_SQL = `INSERT INTO todos (title, description, priority, horizon, category, due_date,
    source_app, source_key, source_url, source_snapshot)
  VALUES ($1, $2, $3, 'short', 'finance', $4, $5, $6, $7, $8)
  ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
  RETURNING *`;

async function insertTask(pool, app, task) {
  const snapshot = { title: task.title, description: task.description, due_date: task.due_date, priority: task.priority };
  const r = await pool.query(INSERT_SQL, [task.title, task.description, task.priority, task.due_date,
    app, task.key, task.url, JSON.stringify(snapshot)]);
  return r.rows[0] || null;
}

// Reconcile app's open tasks of `kinds` to `desired` ([{ key, title,
// description?, url?, due_date?, priority? }]). Only list a kind whose source
// was read successfully this run — a listed kind with a key missing from
// `desired` is closed. → { created, closed, reopened, skipped }.
async function syncLinkedTasks(pool, { app, kinds, desired } = {}) {
  if (!APP_RE.test(app || "")) throw new Error("syncLinkedTasks: bad app");
  const kindList = Array.isArray(kinds) ? kinds.filter((k) => typeof k === "string" && KIND_RE.test(k)) : [];
  const items = Array.isArray(desired) ? desired : [];
  const result = { created: 0, closed: 0, reopened: 0, skipped: 0 };

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

  for (const task of valid) {
    const row = await insertTask(pool, app, task);
    if (row) {
      result.created++;
      helpers.announceTodoEvent("todo_created", row);
    }
  }

  if (!kindList.length) return result;
  const keys = [...desiredKeys];

  const reopened = await pool.query(
    `UPDATE todos SET completed = false, completed_at = NULL, auto_closed = false, updated_at = now()
      WHERE source_app = $1 AND source_key = ANY($2::text[])
        AND completed AND auto_closed AND NOT source_detached AND deleted_at IS NULL
      RETURNING id`, [app, keys]);
  result.reopened = reopened.rowCount;

  const closed = await pool.query(
    `UPDATE todos SET completed = true, completed_at = now(), auto_closed = true, updated_at = now()
      WHERE source_app = $1 AND split_part(source_key, ':', 2) = ANY($3::text[])
        AND NOT (source_key = ANY($2::text[]))
        AND NOT completed AND NOT source_detached AND deleted_at IS NULL
      RETURNING *`, [app, keys, kindList]);
  result.closed = closed.rowCount;
  for (const row of closed.rows) helpers.announceTodoEvent("todo_completed", row);

  return result;
}

// One-off event task: created once (a trashed one isn't recreated), never
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

module.exports = { syncLinkedTasks, ensureLinkedTask, checkTask, parseKey };
