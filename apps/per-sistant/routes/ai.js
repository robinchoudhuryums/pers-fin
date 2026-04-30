// ============================================================================
// Per-sistant — AI Routes
// ============================================================================

const express = require("express");
const { callAI, getAIModelForFeature, getCached, setCache, isAIAvailable } = require("../ai");
const { VALID_AI_FEATURES } = require("../config");

module.exports = function ({ pool }) {
  const router = express.Router();

  // ============================================================================
  // API — AI Email Drafting
  // ============================================================================
  router.post("/api/ai/draft-email", async (req, res) => {
    try {
      const model = await getAIModelForFeature("email_draft");
      if (model === "off") return res.status(400).json({ error: "AI email drafting is disabled. Enable it in Settings." });
      const { prompt, recipient_name } = req.body;
      if (!prompt) return res.status(400).json({ error: "Prompt is required." });
      const text = await callAI(model,
        `Draft an email based on this request: "${prompt}"${recipient_name ? ` The recipient's name is ${recipient_name}.` : ""}`,
        1024,
        `You are a professional email drafting assistant. Return ONLY a JSON object with these fields:\n- "subject": the email subject line\n- "body": the email body text (plain text, no HTML)\n\nKeep the tone professional but warm. Do not include any other text outside the JSON.`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const draft = JSON.parse(jsonMatch[0]); res.json(draft); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      const text = await callAI(model,
        `Task: "${title}"${description ? `\nDetails: "${description}"` : ""}`,
        512,
        `You are a task breakdown assistant. Break down the given task into 3-8 actionable subtasks. Return ONLY a JSON array of strings, where each string is a subtask. Keep them specific and actionable.\nExample: ["Research options", "Compare prices", "Make decision"]`);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const subtasks = JSON.parse(jsonMatch[0]); res.json({ subtasks }); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      const today = new Date().toISOString().split("T")[0];
      const text = await callAI(model,
        `Today is ${today}.\nInput: "${input}"`,
        256,
        `You are a task parser. Parse natural language task descriptions into structured data.\n\nReturn ONLY a JSON object with:\n- "title": clean task title (remove time/priority words)\n- "priority": one of "low", "medium", "high", "urgent"\n- "horizon": one of "short", "medium", "long"\n- "category": inferred category (e.g. "work", "personal", "health", "finance", "errands", "home") or null\n- "due_date": ISO date string (YYYY-MM-DD) if a date/time is mentioned, or null\n\nBe smart about inferring: "ASAP" = urgent, "someday" = low priority long-term, "this week" = short-term, etc.`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const parsed = JSON.parse(jsonMatch[0]); res.json(parsed); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      const text = await callAI(model,
        `Stats:\n- Tasks completed: ${stats.tasks_completed}\n- Tasks created: ${stats.tasks_created}\n- Emails sent: ${stats.emails_sent}\n- Notes created: ${stats.notes_created}\n- Overdue tasks: ${stats.overdue}\n- Completed task titles: ${stats.completed_titles || "none"}`,
        256,
        `You are a productivity coach. Write a brief, encouraging weekly review summary (2-4 sentences) based on the user's stats. Be conversational and motivating. Highlight accomplishments. If there are overdue tasks, gently remind. Don't use emojis.`);
      res.json({ summary: text });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      const text = await callAI(model,
        `Tone: "${tone}"\n\nOriginal email:\n${body}`,
        1024,
        `You are an email tone adjustment assistant. Rewrite the given email body with the requested tone. Keep the same meaning and content but adjust the language.\n\nReturn ONLY the rewritten email body text (plain text, no JSON wrapping, no quotes).\nValid tones: more formal, more casual, shorter, friendlier, more direct.`);
      res.json({ body: text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API — AI Daily Briefing
  // ============================================================================
  router.get("/api/ai/daily-briefing", async (req, res) => {
    try {
      const model = await getAIModelForFeature("daily_briefing");
      if (model === "off") return res.status(400).json({ error: "AI daily briefing is disabled." });
      const today = new Date().toISOString().split("T")[0];
      const [pending, overdue, scheduled, upcoming] = await Promise.all([
        pool.query("SELECT title, priority, category, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 15"),
        pool.query("SELECT title, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date < $1", [today]),
        pool.query("SELECT subject, recipient_name, scheduled_at FROM emails WHERE deleted_at IS NULL AND status = 'scheduled' AND DATE(scheduled_at) = $1", [today]),
        pool.query("SELECT title, due_date FROM todos WHERE deleted_at IS NULL AND NOT completed AND due_date = $1", [today]),
      ]);
      // Check response cache (briefing cached for 10 minutes)
      const cacheKey = `briefing_${today}`;
      const cached = getCached(cacheKey, 10 * 60 * 1000);
      if (cached) return res.json({ briefing: cached });

      const text = await callAI(model,
        `Today: ${today}\nToday's tasks (${upcoming.rows.length}): ${upcoming.rows.map(t => t.title).join(", ") || "none"}\nOverdue tasks (${overdue.rows.length}): ${overdue.rows.map(t => t.title).join(", ") || "none"}\nScheduled emails today: ${scheduled.rows.map(e => `"${e.subject}" to ${e.recipient_name}`).join(", ") || "none"}\nTotal pending tasks: ${pending.rows.length}\nTop priorities: ${pending.rows.slice(0, 5).map(t => `${t.title} (${t.priority})`).join(", ")}`,
        300,
        `You are a daily briefing assistant. Generate a brief, helpful daily briefing (3-5 sentences). Be conversational and actionable. Summarize what needs attention today. Don't use emojis.`);
      setCache(cacheKey, text);
      res.json({ briefing: text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API — AI Note Auto-Tagging
  // ============================================================================
  router.post("/api/ai/suggest-tags", async (req, res) => {
    try {
      const model = await getAIModelForFeature("note_tagging");
      if (model === "off") return res.status(400).json({ error: "AI note tagging is disabled." });
      const { title, content } = req.body;
      if (!content) return res.status(400).json({ error: "Content is required." });
      const text = await callAI(model,
        `${title ? `Title: "${title}"\n` : ""}Content: "${content.substring(0, 500)}"`,
        128,
        `You are a note tagging assistant. Suggest 1-4 short tags for the given note. Tags should be lowercase single words or hyphenated phrases.\n\nReturn ONLY a JSON array of tag strings.\nExample: ["meeting-notes", "project-alpha", "action-items"]`);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return res.status(500).json({ error: "Failed to parse AI response." });
      try { const tags = JSON.parse(jsonMatch[0]); res.json({ tags }); }
      catch { return res.status(500).json({ error: "Invalid AI response format." }); }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // API — AI Smart Suggestions
  // ============================================================================
  router.get("/api/ai/smart-suggestions", async (req, res) => {
    try {
      const model = await getAIModelForFeature("daily_briefing");
      if (model === "off") return res.json({ suggestions: null });
      // Check response cache (suggestions cached for 5 minutes)
      const todayStr = new Date().toISOString().split("T")[0];
      const suggestCacheKey = `suggestions_${todayStr}_${new Date().getHours()}`;
      const cachedSuggestions = getCached(suggestCacheKey, 5 * 60 * 1000);
      if (cachedSuggestions) return res.json({ suggestions: cachedSuggestions });

      const todos = await pool.query("SELECT id, title, priority, horizon, category, due_date, recurring, recurrence_rule, streak_count FROM todos WHERE deleted_at IS NULL AND completed = false ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date NULLS LAST LIMIT 30");
      if (!todos.rows.length) return res.json({ suggestions: null });
      const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
      const taskList = todos.rows.map(t => `- "${t.title}" [${t.priority}/${t.horizon}]${t.category ? ' ('+t.category+')' : ''}${t.due_date ? ' due:'+t.due_date.toISOString().split("T")[0] : ''}${t.recurring ? ' recurring:'+t.recurrence_rule : ''}${t.streak_count > 0 ? ' streak:'+t.streak_count : ''}`).join("\n");
      const result = await callAI(model,
        `Today is ${dayName}, ${todayStr}. Here are the user's pending tasks:\n${taskList}`,
        512,
        `You are a productivity coach. Provide exactly 3 smart suggestions as a JSON array of objects with "suggestion" (short actionable advice) and "task_ids" (array of relevant task IDs). Consider: urgency, due dates, streaks at risk, workload balance, and day of week. Focus on what to tackle NOW.\nRespond with ONLY a JSON array, no other text.`);
      const cleaned = result.replace(/```json?\s*|\s*```/g, "").trim();
      let suggestions;
      try { suggestions = JSON.parse(cleaned); }
      catch { return res.json({ suggestions: null, error: "Invalid AI response format." }); }
      setCache(suggestCacheKey, suggestions);
      res.json({ suggestions });
    } catch (err) { res.json({ suggestions: null, error: err.message }); }
  });

  // ============================================================================
  // API — AI Natural Language Query
  // ============================================================================
  router.post("/api/ai/query", async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: "Query is required." });
      const model = await getAIModelForFeature("daily_briefing");
      if (model === "off") return res.json({ answer: "AI is not enabled. Enable it in Settings.", data: null });
      // Gather context
      const [todos, emails, notes] = await Promise.all([
        pool.query("SELECT id, title, priority, horizon, category, due_date, completed, completed_at, recurring, recurrence_rule, streak_count, created_at FROM todos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50"),
        pool.query("SELECT id, subject, recipient_name, recipient_email, status, scheduled_at, sent_at, created_at FROM emails WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20"),
        pool.query("SELECT id, title, content, tags, pinned, created_at, updated_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20"),
      ]);
      const todayStr = new Date().toISOString().split("T")[0];
      const context = `Today: ${todayStr}\n\nTasks (${todos.rows.length}):\n${todos.rows.map(t => `- [${t.completed?'done':'pending'}] "${t.title}" priority:${t.priority} horizon:${t.horizon}${t.category?' cat:'+t.category:''}${t.due_date?' due:'+t.due_date.toISOString().split("T")[0]:''}${t.completed_at?' completed:'+t.completed_at.toISOString().split("T")[0]:''}${t.recurring?' recurring:'+t.recurrence_rule:''}`).join("\n")}\n\nEmails (${emails.rows.length}):\n${emails.rows.map(e => `- [${e.status}] "${e.subject}" to:${e.recipient_name||e.recipient_email}${e.sent_at?' sent:'+e.sent_at.toISOString().split("T")[0]:''}`).join("\n")}\n\nNotes (${notes.rows.length}):\n${notes.rows.map(n => `- "${n.title||n.content.substring(0,40)}"${n.tags?' tags:'+n.tags.join(','):''}${n.pinned?' pinned':''}`).join("\n")}`;
      const answer = await callAI(model,
        `Data:\n${context}\n\nUser question: "${query}"`,
        1024,
        `You are a personal assistant with access to the user's data. Answer their question based on the provided data. Be concise and helpful. If the question asks for counts, lists, or stats, provide specific numbers. Answer concisely.`);
      res.json({ answer });
    } catch (err) { res.json({ answer: "Sorry, I couldn't process that query.", error: err.message }); }
  });

  // ============================================================================
  // API — AI Model Preferences
  // ============================================================================
  router.get("/api/ai/models", async (req, res) => {
    try {
      const r = await pool.query("SELECT ai_model_email_draft, ai_model_task_breakdown, ai_model_quick_add, ai_model_review_summary, ai_model_email_tone, ai_model_daily_briefing, ai_model_note_tagging FROM user_settings WHERE id = 1");
      const models = r.rows[0] || {};
      models.available = isAIAvailable();
      res.json(models);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.patch("/api/ai/models", async (req, res) => {
    try {
      const allowed = ["ai_model_email_draft", "ai_model_task_breakdown", "ai_model_quick_add", "ai_model_review_summary", "ai_model_email_tone", "ai_model_daily_briefing", "ai_model_note_tagging"];
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
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
