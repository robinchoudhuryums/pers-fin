// ============================================================================
// Per-sistant — AI Routes
// ============================================================================

const express = require("express");
// Roadmap T2.3 C2: every model call goes through ai.cappedAI (check the
// monthly Per-sistant AI budget, call, charge one ai_usage row) — read off the
// module object so tests can stub it. No route calls callAI directly.
const ai = require("../ai");
const { getAIModelForFeature, getCached, setCache, isAIAvailable } = ai;
const { VALID_AI_FEATURES } = require("../config");

const { serverError } = require("../errors");
const { gatherHealthSummary, todayStr } = require("./health");
const { housingDue, housingDueSuffix } = require("./housing-due");

// F124: the model's parse-todo answer is shaped before it reaches the page —
// enums checked, the due date a real YYYY-MM-DD or null, text fields strings
// of bounded length (the preview rendered them as HTML, and Add sent them
// straight to POST /api/todos).
const { VALID_PRIORITIES, VALID_HORIZONS } = require("../config");
function normalizeParsedTodo(p, input) {
  const o = p && typeof p === "object" ? p : {};
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const due = str(o.due_date, 10);
  const dueOk = due && /^\d{4}-\d{2}-\d{2}$/.test(due) && !isNaN(Date.parse(due + "T00:00:00Z"))
    && new Date(due + "T00:00:00Z").toISOString().slice(0, 10) === due;
  return {
    title: str(o.title, 500) || String(input).slice(0, 500),
    priority: VALID_PRIORITIES.includes(o.priority) ? o.priority : "medium",
    horizon: VALID_HORIZONS.includes(o.horizon) ? o.horizon : "short",
    category: str(o.category, 50),
    due_date: dueOk ? due : null,
  };
}

// Roadmap T1.5: a model-calling route answers 501 when no API key is set —
// after its own 400s (feature off, missing input), before any model call. It used to reach callAI, which throws "AI not configured",
// and answer 500 — logged as a server error on every Review page load.
const AI_NOT_CONFIGURED = "AI is not configured on this server (ANTHROPIC_API_KEY is not set).";
function aiUnavailable(res) {
  if (isAIAvailable()) return false;
  res.status(501).json({ error: AI_NOT_CONFIGURED, ai_unavailable: true });
  return true;
}

// Roadmap T2.3 C2: over the monthly AI budget the action routes answer 429
// (after their 400s and the 501, before any data query or model call); an
// unreadable spend answers 503 — spend that can't be read can't be checked
// (ai.capResponse, shared with routes/rag.js). Ask and Smart Suggestions keep
// their 200 shapes and add ai_cap instead.
const { capMessage, capResponse } = ai;
// The cap as a thrown-shape error (CAP / CAP_CHECK_FAILED) or null when under
// it — for the routes that gate BEFORE their data queries.
async function capBlock(pool) {
  try {
    const c = await ai.checkAiCap(pool);
    return c.ok ? null : ai.capError(c.spent, c.budget);
  } catch (err) {
    if (err.code === "CAP_CHECK_FAILED") return err;
    throw err;
  }
}

function askCapAnswer(err) {
  return err.code === "CAP"
    ? { answer: capMessage(err), data: null, ai_cap: true }
    : { answer: err.message, data: null, ai_cap_check_failed: true };
}

module.exports = function ({ pool }) {
  const router = express.Router();
  const capped = (entry_type, model, prompt, maxTokens, system) =>
    ai.cappedAI(pool, { entry_type, model, prompt, maxTokens, system }).then((r) => r.text);

  // ============================================================================
  // API — AI Email Drafting
  // ============================================================================
  router.post("/api/ai/draft-email", async (req, res) => {
    try {
      const model = await getAIModelForFeature("email_draft");
      if (model === "off") return res.status(400).json({ error: "AI email drafting is disabled. Enable it in Settings." });
      const { prompt, recipient_name } = req.body;
      if (!prompt) return res.status(400).json({ error: "Prompt is required." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      const text = await capped("email_draft", model,
        `Draft an email based on this request: "${prompt}"${recipient_name ? ` The recipient's name is ${recipient_name}.` : ""}`,
        1024,
        `You are a professional email drafting assistant. Return ONLY a JSON object with these fields:\n- "subject": the email subject line\n- "body": the email body text (plain text, no HTML)\n\nKeep the tone professional but warm. Do not include any other text outside the JSON.`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const draft = JSON.parse(jsonMatch[0]); res.json(draft); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Task Breakdown (generate subtasks)
  // ============================================================================
  router.post("/api/ai/task-breakdown", async (req, res) => {
    try {
      const model = await getAIModelForFeature("task_breakdown");
      if (model === "off") return res.status(400).json({ error: "AI task breakdown is disabled. Enable it in Settings." });
      const { title, description } = req.body;
      if (!title) return res.status(400).json({ error: "Task title is required." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      const text = await capped("task_breakdown", model,
        `Task: "${title}"${description ? `\nDetails: "${description}"` : ""}`,
        512,
        `You are a task breakdown assistant. Break down the given task into 3-8 actionable subtasks. Return ONLY a JSON array of strings, where each string is a subtask. Keep them specific and actionable.\nExample: ["Research options", "Compare prices", "Make decision"]`);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const subtasks = JSON.parse(jsonMatch[0]); res.json({ subtasks }); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Quick Add (parse natural language into structured todo)
  // ============================================================================
  router.post("/api/ai/parse-todo", async (req, res) => {
    try {
      const model = await getAIModelForFeature("quick_add");
      if (model === "off") return res.status(400).json({ error: "AI quick add is disabled." });
      const { input } = req.body;
      if (!input) return res.status(400).json({ error: "Input is required." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      // F124: "today" in APP_TIMEZONE — the UTC date is already tomorrow on a
      // US evening, so "tomorrow" became the day after.
      const today = todayStr();
      const text = await capped("quick_add", model,
        `Today is ${today}.\nInput: "${input}"`,
        256,
        `You are a task parser. Parse natural language task descriptions into structured data.\n\nReturn ONLY a JSON object with:\n- "title": clean task title (remove time/priority words)\n- "priority": one of "low", "medium", "high", "urgent"\n- "horizon": one of "short", "medium", "long"\n- "category": inferred category (e.g. "work", "personal", "health", "finance", "errands", "home") or null\n- "due_date": ISO date string (YYYY-MM-DD) if a date/time is mentioned, or null\n\nBe smart about inferring: "ASAP" = urgent, "someday" = low priority long-term, "this week" = short-term, etc.`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      let parsed;
      try { parsed = JSON.parse(jsonMatch[0]); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
      res.json(normalizeParsedTodo(parsed, input));
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Weekly Review Summary
  // ============================================================================
  router.post("/api/ai/review-summary", async (req, res) => {
    try {
      const model = await getAIModelForFeature("review_summary");
      if (model === "off") return res.status(400).json({ error: "AI review summary is disabled." });
      const { stats } = req.body;
      if (!stats) return res.status(400).json({ error: "Stats required." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      const text = await capped("review_summary", model,
        `Stats:\n- Tasks completed: ${stats.tasks_completed}\n- Tasks created: ${stats.tasks_created}\n- Emails sent: ${stats.emails_sent}\n- Notes created: ${stats.notes_created}\n- Overdue tasks: ${stats.overdue}\n- Completed task titles: ${stats.completed_titles || "none"}`,
        256,
        `You are a productivity coach. Write a brief, encouraging weekly review summary (2-4 sentences) based on the user's stats. Be conversational and motivating. Highlight accomplishments. If there are overdue tasks, gently remind. Don't use emojis.`);
      res.json({ summary: text });
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Email Tone Adjustment
  // ============================================================================
  router.post("/api/ai/adjust-tone", async (req, res) => {
    try {
      const model = await getAIModelForFeature("email_tone");
      if (model === "off") return res.status(400).json({ error: "AI tone adjustment is disabled." });
      const { body, tone } = req.body;
      if (!body || !tone) return res.status(400).json({ error: "Body and tone are required." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      const text = await capped("email_tone", model,
        `Tone: "${tone}"\n\nOriginal email:\n${body}`,
        1024,
        `You are an email tone adjustment assistant. Rewrite the given email body with the requested tone. Keep the same meaning and content but adjust the language.\n\nReturn ONLY the rewritten email body text (plain text, no JSON wrapping, no quotes).\nValid tones: more formal, more casual, shorter, friendlier, more direct.`);
      res.json({ body: text });
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Daily Briefing
  // ============================================================================
  router.get("/api/ai/daily-briefing", async (req, res) => {
    try {
      const model = await getAIModelForFeature("daily_briefing");
      if (model === "off") return res.status(400).json({ error: "AI daily briefing is disabled." });
      if (aiUnavailable(res)) return; // before the queries and the model call
      const today = todayStr(); // APP_TIMEZONE, matching the habit/rent lines (PB-13)
      // Response cache first (10 minutes) — a cached briefing is free: no
      // queries, no cap check, no model call (T2.3).
      const cacheKey = `briefing_${today}`;
      const cached = getCached(cacheKey, 10 * 60 * 1000);
      if (cached) return res.json({ briefing: cached });
      // Over the AI budget → 429 before any data query (T2.3 C2).
      if (capResponse(res, await capBlock(pool))) return;
      const [pending, overdue, scheduled, upcoming, health] = await Promise.all([
        pool.query("SELECT title, priority, category, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 15"),
        pool.query("SELECT title, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date < $1", [today]),
        pool.query("SELECT subject, recipient_name, scheduled_at FROM emails WHERE deleted_at IS NULL AND status = 'scheduled' AND DATE(scheduled_at) = $1", [today]),
        pool.query("SELECT title, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date = $1", [today]),
        // Fail-soft — a health-tables error just drops the habits line.
        gatherHealthSummary(pool).catch(() => null),
      ]);

      // (health.streaks_at_risk || []) — the .catch() above only guards a thrown
      // error, not a success-shaped summary that omits the array; defend it so a
      // future shape change can't throw a TypeError outside the fail-soft path (F13).
      const atRisk = (health && health.streaks_at_risk) || [];
      const habitLine = health && health.due_today
        ? `\nHabits due today: ${health.done_today}/${health.due_today} done${atRisk.length ? `; streaks at risk: ${atRisk.map(h => `${h.name} (${h.current_streak}-day)`).join(", ")}` : ""}`
        : "";

      // Rent & utilities — cross-app, READ-ONLY via the shell-wired perfinPool
      // (INV-25/35, never an HTTP self-fetch). Fail-soft: no perfinPool
      // (standalone Per-sistant) or any error just drops the line.
      let housingLine = "";
      try {
        const perfinPool = req.app.get("perfinPool");
        if (perfinPool) {
          // Shared day-granular helper (PB-2) — the same due/overdue state the
          // notification check reports, in APP_TIMEZONE.
          const h = await housingDue(perfinPool);
          if (h) housingLine = `\nRent & utilities: $${h.balance.toFixed(2)} owed to ${h.payee} across ${h.n} item(s)${housingDueSuffix(h)}`;
        }
      } catch { /* cross-app read is best-effort — drop the line on any error */ }

      // Job Radar — one line of high-fit leads via the shared aggregator (fail-soft).
      let jobLine = "";
      try {
        const s = await pool.query("SELECT job_radar_enabled FROM user_settings WHERE id = 1");
        if (s.rows.length && s.rows[0].job_radar_enabled) {
          const { gatherJobRadarSummary } = require("./jobs");
          const jr = await gatherJobRadarSummary(pool);
          if (jr.counts.main > 0) {
            const t = jr.top_pick;
            jobLine = `\nJob Radar: ${jr.counts.main} new high-fit role(s)${t ? `; top: ${t.title || "a role"}${t.company ? " @ " + t.company : ""}` : ""}`;
          }
        }
      } catch { /* best-effort — drop the line on any error */ }

      const text = await capped("daily_briefing", model,
        `Today: ${today}\nToday's tasks (${upcoming.rows.length}): ${upcoming.rows.map(t => t.title).join(", ") || "none"}\nOverdue tasks (${overdue.rows.length}): ${overdue.rows.map(t => t.title).join(", ") || "none"}\nScheduled emails today: ${scheduled.rows.map(e => `"${e.subject}" to ${e.recipient_name}`).join(", ") || "none"}\nTotal pending tasks: ${pending.rows.length}\nTop priorities: ${pending.rows.slice(0, 5).map(t => `${t.title} (${t.priority})`).join(", ")}${habitLine}${housingLine}${jobLine}`,
        300,
        `You are a daily briefing assistant. Generate a brief, helpful daily briefing (3-5 sentences). Be conversational and actionable. Summarize what needs attention today. If habit streaks are at risk, nudge the user to keep them alive. If rent or utilities are owed and due soon, remind the user to send the payment. If high-fit job leads are waiting, mention them briefly. Don't use emojis.`);
      setCache(cacheKey, text);
      res.json({ briefing: text });
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Note Auto-Tagging
  // ============================================================================
  router.post("/api/ai/suggest-tags", async (req, res) => {
    try {
      const model = await getAIModelForFeature("note_tagging");
      if (model === "off") return res.status(400).json({ error: "AI note tagging is disabled." });
      const { title, content, sensitivity } = req.body;
      if (!content) return res.status(400).json({ error: "Content is required." });
      // A private / secret note is never sent to the AI (F134).
      if (sensitivity && sensitivity !== "normal") return res.status(400).json({ error: "AI tagging is off for private and secret notes." });
      if (aiUnavailable(res)) return; // after input checks, before the model call
      const text = await capped("note_tagging", model,
        `${title ? `Title: "${title}"\n` : ""}Content: "${content.substring(0, 500)}"`,
        128,
        `You are a note tagging assistant. Suggest 1-4 short tags for the given note. Tags should be lowercase single words or hyphenated phrases.\n\nReturn ONLY a JSON array of tag strings.\nExample: ["meeting-notes", "project-alpha", "action-items"]`);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const tags = JSON.parse(jsonMatch[0]); res.json({ tags }); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      if (!capResponse(res, err)) serverError(res, err);
    }
  });

  // ============================================================================
  // API — AI Smart Suggestions
  // ============================================================================
  router.get("/api/ai/smart-suggestions", async (req, res) => {
    try {
      // PD-7: its own setting (it used the daily_briefing model, default off).
      const model = await getAIModelForFeature("smart_suggestions");
      if (model === "off" || !isAIAvailable()) return res.json({ suggestions: null });
      // Check response cache (suggestions cached for 5 minutes) — a hit is free.
      // The day is the APP_TIMEZONE date (T2.3 C2 — it was the UTC date, so a
      // US evening read "tomorrow" and the day name was the server's).
      const today = todayStr();
      const suggestCacheKey = `suggestions_${today}_${new Date().getHours()}`;
      const cachedSuggestions = getCached(suggestCacheKey, 5 * 60 * 1000);
      if (cachedSuggestions) return res.json({ suggestions: cachedSuggestions });
      // Over the AI budget → the usual empty answer + ai_cap, before the query.
      const blocked = await capBlock(pool);
      if (blocked) return res.json(blocked.code === "CAP"
        ? { suggestions: null, ai_cap: true, error: capMessage(blocked) }
        : { suggestions: null, ai_cap_check_failed: true, error: blocked.message });

      const todos = await pool.query("SELECT id, title, priority, horizon, category, due_date, recurring, recurrence_rule, streak_count FROM todos WHERE deleted_at IS NULL AND completed = false ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date NULLS LAST LIMIT 30");
      if (!todos.rows.length) return res.json({ suggestions: null });
      const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(today + "T00:00:00Z").getUTCDay()];
      const taskList = todos.rows.map(t => `- "${t.title}" [${t.priority}/${t.horizon}]${t.category ? ' ('+t.category+')' : ''}${t.due_date ? ' due:'+t.due_date.toISOString().split("T")[0] : ''}${t.recurring ? ' recurring:'+t.recurrence_rule : ''}${t.streak_count > 0 ? ' streak:'+t.streak_count : ''}`).join("\n");
      const result = await capped("smart_suggestions", model,
        `Today is ${dayName}, ${today}. Here are the user's pending tasks:\n${taskList}`,
        512,
        `You are a productivity coach. Provide exactly 3 smart suggestions as a JSON array of objects with "suggestion" (short actionable advice) and "task_ids" (array of relevant task IDs). Consider: urgency, due dates, streaks at risk, workload balance, and day of week. Focus on what to tackle NOW.\nRespond with ONLY a JSON array, no other text.`);
      const cleaned = result.replace(/```json?\s*|\s*```/g, "").trim();
      let suggestions;
      try { suggestions = JSON.parse(cleaned); }
      catch { return res.json({ suggestions: null, error: "Invalid AI response format." }); }
      setCache(suggestCacheKey, suggestions);
      res.json({ suggestions });
    } catch (err) {
      if (err && err.code === "CAP") return res.json({ suggestions: null, ai_cap: true, error: capMessage(err) });
      if (err && err.code === "CAP_CHECK_FAILED") return res.json({ suggestions: null, ai_cap_check_failed: true, error: err.message });
      res.json({ suggestions: null, error: "AI request failed." });
    }
  });

  // ============================================================================
  // API — AI Natural Language Query
  // ============================================================================
  router.post("/api/ai/query", async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: "Query is required." });
      // PD-7: Ask has its own setting (default haiku) — it was gated on the
      // daily_briefing model, which defaults to off, so Ask was dead on a
      // fresh install and switching the briefing off silently disabled it.
      const model = await getAIModelForFeature("natural_language_query");
      if (model === "off") return res.json({ answer: "Ask is turned off. Enable it in Settings → AI Models.", data: null });
      if (!isAIAvailable()) return res.json({ answer: "AI is not configured on this server (ANTHROPIC_API_KEY is not set).", data: null });
      // Over the AI budget → the answer says so (200, ai_cap), before the queries (T2.3 C2).
      const blocked = await capBlock(pool);
      if (blocked) return res.json(askCapAnswer(blocked));
      // Gather context
      const today = todayStr();
      const [todos, emails, notes, totals] = await Promise.all([
        pool.query("SELECT id, title, priority, horizon, category, due_date, completed, completed_at, recurring, recurrence_rule, streak_count, created_at FROM todos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50"),
        pool.query("SELECT id, subject, recipient_name, recipient_email, status, scheduled_at, sent_at, created_at FROM emails WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20"),
        // Only 'normal' notes reach the model (cycle-7 F134 / ST5).
        pool.query("SELECT id, title, content, tags, pinned, created_at, updated_at FROM notes WHERE deleted_at IS NULL AND sensitivity = 'normal' ORDER BY updated_at DESC LIMIT 20"),
        // F118: real totals over ALL rows — the lists below are only the most
        // recent 50 / 20 / 20, so "how many tasks are overdue?" used to be
        // counted from a sample with no warning.
        pool.query(`SELECT
            (SELECT count(*) FROM todos WHERE deleted_at IS NULL) AS todos_total,
            (SELECT count(*) FROM todos WHERE deleted_at IS NULL AND NOT completed) AS todos_open,
            (SELECT count(*) FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date < $1::date) AS todos_overdue,
            (SELECT count(*) FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date = $1::date) AS todos_due_today,
            (SELECT count(*) FROM todos WHERE deleted_at IS NULL AND completed AND NOT COALESCE(missed, false)) AS todos_done,
            (SELECT count(*) FROM emails WHERE deleted_at IS NULL) AS emails_total,
            (SELECT count(*) FROM emails WHERE deleted_at IS NULL AND status = 'sent') AS emails_sent,
            (SELECT count(*) FROM emails WHERE deleted_at IS NULL AND status = 'scheduled') AS emails_scheduled,
            (SELECT count(*) FROM notes WHERE deleted_at IS NULL) AS notes_total`, [today])
          .then((r) => r.rows[0]).catch((err) => { console.error("ask totals:", err.message); return null; }),
      ]);
      const t = totals;
      const totalsLine = t
        ? `Totals over ALL data (use these for counts): tasks ${t.todos_total} (open ${t.todos_open}, overdue ${t.todos_overdue}, due today ${t.todos_due_today}, done ${t.todos_done}); emails ${t.emails_total} (sent ${t.emails_sent}, scheduled ${t.emails_scheduled}); notes ${t.notes_total}.\n`
        : "";
      const context = `Today: ${today}\n${totalsLine}\nMost recent tasks (up to 50 shown of ${t ? t.todos_total : "?"} — a sample, not everything) (${todos.rows.length}):\n${todos.rows.map(t => `- [${t.completed?'done':'pending'}] "${t.title}" priority:${t.priority} horizon:${t.horizon}${t.category?' cat:'+t.category:''}${t.due_date?' due:'+t.due_date.toISOString().split("T")[0]:''}${t.completed_at?' completed:'+t.completed_at.toISOString().split("T")[0]:''}${t.recurring?' recurring:'+t.recurrence_rule:''}`).join("\n")}\n\nEmails (${emails.rows.length}):\n${emails.rows.map(e => `- [${e.status}] "${e.subject}" to:${e.recipient_name||e.recipient_email}${e.sent_at?' sent:'+e.sent_at.toISOString().split("T")[0]:''}`).join("\n")}\n\nNotes (${notes.rows.length}):\n${notes.rows.map(n => `- "${n.title||n.content.substring(0,40)}"${n.tags?' tags:'+n.tags.join(','):''}${n.pinned?' pinned':''}`).join("\n")}`;
      const answer = await capped("natural_language_query", model,
        `Data:\n${context}\n\nUser question: "${query}"`,
        1024,
        `You are a personal assistant with access to the user's data. Answer their question based on the provided data. Be concise and helpful. For counts and stats use the "Totals over ALL data" line; the task / email / note lists are only the most recent items, so if a question needs something outside them, say the answer covers recent items only. Answer concisely.`);
      res.json({ answer });
    } catch (err) {
      if (err && (err.code === "CAP" || err.code === "CAP_CHECK_FAILED")) return res.json(askCapAnswer(err));
      res.json({ answer: "Sorry, I couldn't process that query.", error: "AI request failed." });
    }
  });

  // ============================================================================
  // API — AI Model Preferences
  // ============================================================================
  router.get("/api/ai/models", async (req, res) => {
    try {
      const r = await pool.query("SELECT ai_model_email_draft, ai_model_task_breakdown, ai_model_quick_add, ai_model_review_summary, ai_model_email_tone, ai_model_daily_briefing, ai_model_note_tagging, ai_model_rag, ai_model_job_fit, ai_model_natural_language_query, ai_model_smart_suggestions FROM user_settings WHERE id = 1");
      const models = r.rows[0] || {};
      models.available = isAIAvailable();
      res.json(models);
    } catch (err) { serverError(res, err); }
  });

  router.patch("/api/ai/models", async (req, res) => {
    try {
      const allowed = ["ai_model_email_draft", "ai_model_task_breakdown", "ai_model_quick_add", "ai_model_review_summary", "ai_model_email_tone", "ai_model_daily_briefing", "ai_model_note_tagging", "ai_model_rag", "ai_model_job_fit", "ai_model_natural_language_query", "ai_model_smart_suggestions"];
      const validValues = ["haiku", "sonnet", "off"];
      const fields = []; const params = []; let idx = 1;
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          if (!validValues.includes(req.body[key])) return res.status(400).json({ error: `Invalid value for ${key}: must be haiku, sonnet, or off` });
          fields.push(`${key} = $${idx++}`);
          params.push(req.body[key]);
        }
      }
      if (!fields.length) return res.status(400).json({ error: "No fields to update." });
      const r = await pool.query(`UPDATE user_settings SET ${fields.join(", ")} WHERE id = 1 RETURNING *`, params);
      res.json(r.rows[0]);
    } catch (err) { serverError(res, err); }
  });

  return router;
};

// Helpers attached AFTER module.exports = router factory (INV-19).
module.exports.normalizeParsedTodo = normalizeParsedTodo;
