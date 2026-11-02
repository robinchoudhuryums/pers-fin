// In-memory fake pool for services/linked-tasks.js (roadmap T2.4 X1a / X1b):
// it applies the intent of each statement the module sends to a todos array.
// It models the statements, not their SQL — the predicates themselves are
// judged on real Postgres by tests/contract/linked-tasks.contract.test.js.
// A fake pool that understands exactly the statements linked-tasks.js sends.
function fakePool() {
  const rows = [];
  const tombstones = new Set();
  let nextId = 1;
  const queries = [];
  const pool = {
    rows,
    queries,
    tombstones,
    // What db/031's trigger does when a linked task is deleted for good.
    hardDelete(key) {
      const i = rows.findIndex((r) => r.source_key === key);
      if (i >= 0) { tombstones.add(key); rows.splice(i, 1); }
    },
    // syncLinkedTasks runs on one client in a transaction.
    async connect() { return { query: (sql, params) => pool.query(sql, params), release() { pool.released = (pool.released || 0) + 1; } }; },
    async query(sql, params) {
      queries.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/^INSERT INTO todos/.test(sql)) {
        const [title, description, priority, due_date, source_app, source_key, source_url, snapshot] = params;
        if (tombstones.has(source_key)) return { rows: [], rowCount: 0 };
        if (rows.some((r) => r.source_key === source_key)) return { rows: [], rowCount: 0 };
        const row = { id: nextId++, title, description, priority, horizon: "short", category: "finance", due_date,
          source_app, source_key, source_url, source_snapshot: JSON.parse(snapshot),
          completed: false, completed_at: null, auto_closed: false, source_detached: false, deleted_at: null };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/^UPDATE todos SET completed = false/.test(sql)) {
        const [app, keys] = params;
        const hit = rows.filter((r) => r.source_app === app && keys.includes(r.source_key) && r.completed && r.auto_closed && !r.source_detached && !r.deleted_at);
        for (const r of hit) { r.completed = false; r.completed_at = null; r.auto_closed = false; }
        return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
      }
      if (/^UPDATE todos SET completed = true/.test(sql)) {
        const [app, keys, kinds] = params;
        const hit = rows.filter((r) => r.source_app === app && kinds.includes(r.source_key.split(":")[1]) && !keys.includes(r.source_key) && !r.completed && !r.source_detached && !r.deleted_at);
        for (const r of hit) { r.completed = true; r.completed_at = "now"; r.auto_closed = true; }
        return { rows: hit, rowCount: hit.length };
      }
      if (/^UPDATE todos t SET/.test(sql)) {
        // Edits win: a field is replaced only while it equals the snapshot.
        const [app, json] = params;
        const ids = [];
        for (const d of JSON.parse(json)) {
          const r = rows.find((x) => x.source_key === d.key && x.source_app === app && !x.completed && !x.source_detached && !x.deleted_at);
          if (!r) continue;
          const snap = { title: d.title, description: d.description, due_date: d.due_date, priority: d.priority };
          if (JSON.stringify(r.source_snapshot) === JSON.stringify(snap) && r.source_url === d.url) continue;
          for (const f of ["title", "description", "due_date", "priority"]) if (r[f] === r.source_snapshot[f]) r[f] = d[f];
          r.source_snapshot = snap;
          r.source_url = d.url;
          ids.push({ id: r.id });
        }
        return { rows: ids, rowCount: ids.length };
      }
      if (/^SELECT id FROM todos WHERE source_key/.test(sql)) {
        const r = rows.find((x) => x.source_key === params[0]);
        return { rows: r ? [{ id: r.id }] : [], rowCount: r ? 1 : 0 };
      }
      throw new Error("unexpected SQL: " + sql);
    },
  };
  return pool;
}

module.exports = { fakePool };
