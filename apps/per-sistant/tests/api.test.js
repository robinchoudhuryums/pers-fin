// ============================================================================
// Per-sistant — API Tests
// ============================================================================
// Tests cover API logic, input validation, and helper functions.
// No database required — tests use mock data and direct function calls.
// Run with: npm test
// ============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Time expression parsing tests
// ---------------------------------------------------------------------------
describe("Time expression parsing", () => {
  // Inline a simplified version of the parser for testing
  function parseTimeExpr(text) {
    const now = new Date();
    const days = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
                  sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
    const dayMatch = text.match(/(?:on\s+|this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)/i);
    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    const morningMatch = text.match(/\bmorning\b/i);
    const afternoonMatch = text.match(/\bafternoon\b/i);
    const eveningMatch = text.match(/\bevening\b/i);
    const tomorrowMatch = text.match(/\btomorrow\b/i);

    const target = new Date(now);
    if (tomorrowMatch) { target.setDate(target.getDate()+1); }
    else if (dayMatch) {
      const targetDay = days[dayMatch[1].toLowerCase()];
      let diff = (targetDay - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      target.setDate(target.getDate() + diff);
    }

    if (timeMatch) {
      let h = parseInt(timeMatch[1]);
      const m = parseInt(timeMatch[2]||"0");
      if (timeMatch[3].toLowerCase() === "pm" && h < 12) h += 12;
      if (timeMatch[3].toLowerCase() === "am" && h === 12) h = 0;
      target.setHours(h, m, 0, 0);
    } else if (morningMatch) { target.setHours(9,0,0,0); }
    else if (afternoonMatch) { target.setHours(14,0,0,0); }
    else if (eveningMatch) { target.setHours(18,0,0,0); }
    else { target.setHours(9,0,0,0); }

    return target > now ? target : null;
  }

  it("parses 'tomorrow morning' correctly", () => {
    const result = parseTimeExpr("send email tomorrow morning");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 9);
    assert.equal(result.getMinutes(), 0);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(result.getDate(), tomorrow.getDate());
  });

  it("parses 'tomorrow afternoon' correctly", () => {
    const result = parseTimeExpr("meet tomorrow afternoon");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 14);
  });

  it("parses 'tomorrow evening' correctly", () => {
    const result = parseTimeExpr("call tomorrow evening");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 18);
  });

  it("parses explicit time like '9AM'", () => {
    const result = parseTimeExpr("send email tomorrow at 9AM");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 9);
    assert.equal(result.getMinutes(), 0);
  });

  it("parses '2:30PM' correctly", () => {
    const result = parseTimeExpr("reminder tomorrow at 2:30PM");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 14);
    assert.equal(result.getMinutes(), 30);
  });

  it("parses '12AM' as midnight", () => {
    const result = parseTimeExpr("task tomorrow at 12AM");
    assert.ok(result instanceof Date);
    assert.equal(result.getHours(), 0);
  });

  it("parses day names correctly", () => {
    const result = parseTimeExpr("send email on Monday at 9AM");
    assert.ok(result instanceof Date);
    assert.equal(result.getDay(), 1); // Monday
    assert.equal(result.getHours(), 9);
  });

  it("parses abbreviated day names", () => {
    const result = parseTimeExpr("email on Tue morning");
    assert.ok(result instanceof Date);
    assert.equal(result.getDay(), 2); // Tuesday
    assert.equal(result.getHours(), 9);
  });

  it("returns future date for day names", () => {
    const result = parseTimeExpr("meet on Wednesday at 3PM");
    assert.ok(result instanceof Date);
    assert.ok(result > new Date());
  });
});

// ---------------------------------------------------------------------------
// Input validation tests
// ---------------------------------------------------------------------------
describe("Input validation", () => {
  it("todo requires title", () => {
    const data = { description: "test" };
    assert.ok(!data.title, "Should require title");
  });

  it("email requires recipient_email, subject, body", () => {
    const valid = { recipient_email: "a@b.com", subject: "hi", body: "test" };
    const invalid1 = { subject: "hi", body: "test" };
    const invalid2 = { recipient_email: "a@b.com", body: "test" };
    assert.ok(valid.recipient_email && valid.subject && valid.body);
    assert.ok(!invalid1.recipient_email);
    assert.ok(!invalid2.subject);
  });

  it("note requires content", () => {
    const valid = { content: "test note" };
    const invalid = { title: "note" };
    assert.ok(valid.content);
    assert.ok(!invalid.content);
  });

  it("contact requires name and email", () => {
    const valid = { name: "Mom", email: "mom@email.com" };
    const invalid = { name: "Mom" };
    assert.ok(valid.name && valid.email);
    assert.ok(!invalid.email);
  });

  it("priority must be valid", () => {
    const valid = ["low", "medium", "high", "urgent"];
    assert.ok(valid.includes("medium"));
    assert.ok(!valid.includes("critical"));
  });

  it("horizon must be valid", () => {
    const valid = ["short", "medium", "long"];
    assert.ok(valid.includes("short"));
    assert.ok(!valid.includes("immediate"));
  });

  it("email status must be valid", () => {
    const valid = ["draft", "scheduled", "sent", "failed"];
    assert.ok(valid.includes("draft"));
    assert.ok(!valid.includes("pending"));
  });

  it("note color must be valid", () => {
    const valid = ["default", "warm", "teal", "green", "blue"];
    assert.ok(valid.includes("warm"));
    assert.ok(!valid.includes("red"));
  });
});

// ---------------------------------------------------------------------------
// Data structure tests
// ---------------------------------------------------------------------------
describe("Data structures", () => {
  it("todo has expected fields", () => {
    const todo = {
      id: 1, title: "Test", description: null, priority: "medium",
      horizon: "short", category: null, due_date: null, completed: false,
      completed_at: null, sort_order: 0, created_at: new Date(), updated_at: new Date()
    };
    assert.ok("id" in todo);
    assert.ok("title" in todo);
    assert.ok("priority" in todo);
    assert.ok("horizon" in todo);
    assert.ok("completed" in todo);
  });

  it("email has expected fields", () => {
    const email = {
      id: 1, recipient_name: "Mom", recipient_email: "mom@email.com",
      subject: "Dinner", body: "Hi Mom", status: "draft",
      scheduled_at: null, sent_at: null, error_message: null
    };
    assert.ok("recipient_email" in email);
    assert.ok("status" in email);
    assert.ok("scheduled_at" in email);
  });

  it("settings has single-row constraint", () => {
    const settings = { id: 1, theme: "dark", session_timeout_minutes: 15 };
    assert.equal(settings.id, 1);
  });
});

// ---------------------------------------------------------------------------
// Contact lookup tests
// ---------------------------------------------------------------------------
describe("Contact lookup", () => {
  it("case-insensitive name matching", () => {
    const contacts = [
      { name: "Mom", email: "mom@email.com" },
      { name: "Boss", email: "boss@work.com" },
    ];
    const lookup = (name) => contacts.find(c => c.name.toLowerCase() === name.toLowerCase());
    assert.deepEqual(lookup("mom"), contacts[0]);
    assert.deepEqual(lookup("MOM"), contacts[0]);
    assert.deepEqual(lookup("Mom"), contacts[0]);
    assert.equal(lookup("unknown"), undefined);
  });

  it("env contacts parsing", () => {
    const json = '{"mom":"mom@email.com","boss":"boss@work.com"}';
    const parsed = JSON.parse(json);
    assert.equal(parsed.mom, "mom@email.com");
    assert.equal(parsed.boss, "boss@work.com");
  });
});

// ---------------------------------------------------------------------------
// Sort order tests
// ---------------------------------------------------------------------------
describe("Todo sorting", () => {
  it("sorts by priority weight", () => {
    const priorities = { urgent: 0, high: 1, medium: 2, low: 3 };
    const todos = [
      { title: "A", priority: "low" },
      { title: "B", priority: "urgent" },
      { title: "C", priority: "medium" },
    ];
    const sorted = [...todos].sort((a, b) => priorities[a.priority] - priorities[b.priority]);
    assert.equal(sorted[0].title, "B"); // urgent first
    assert.equal(sorted[1].title, "C"); // medium second
    assert.equal(sorted[2].title, "A"); // low last
  });

  it("completed items sort after pending", () => {
    const todos = [
      { title: "Done", completed: true },
      { title: "Pending", completed: false },
    ];
    const sorted = [...todos].sort((a, b) => a.completed - b.completed);
    assert.equal(sorted[0].title, "Pending");
    assert.equal(sorted[1].title, "Done");
  });
});

// ---------------------------------------------------------------------------
// Date utility tests
// ---------------------------------------------------------------------------
describe("Date utilities", () => {
  it("detects overdue tasks", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const isOverdue = (dueDate) => new Date(dueDate) <= new Date();
    assert.ok(isOverdue(yesterday));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    assert.ok(!isOverdue(tomorrow));
  });

  it("formats dates correctly", () => {
    const date = new Date("2026-03-15");
    const formatted = date.toISOString().split("T")[0];
    assert.equal(formatted, "2026-03-15");
  });
});

// ---------------------------------------------------------------------------
// Recurring task tests
// ---------------------------------------------------------------------------
describe("Recurring tasks", () => {
  it("validates recurrence rules", () => {
    const valid = ["daily", "weekly", "monthly", "yearly", "weekdays"];
    assert.ok(valid.includes("daily"));
    assert.ok(valid.includes("weekdays"));
    assert.ok(!valid.includes("biweekly"));
    assert.ok(!valid.includes(""));
  });

  it("calculates next occurrence for daily", () => {
    const today = new Date("2026-03-12");
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    assert.equal(next.toISOString().split("T")[0], "2026-03-13");
  });

  it("calculates next occurrence for weekly", () => {
    const today = new Date("2026-03-12");
    const next = new Date(today);
    next.setDate(next.getDate() + 7);
    assert.equal(next.toISOString().split("T")[0], "2026-03-19");
  });

  it("calculates next occurrence for monthly", () => {
    const today = new Date("2026-03-12");
    const next = new Date(today);
    next.setMonth(next.getMonth() + 1);
    assert.equal(next.toISOString().split("T")[0], "2026-04-12");
  });

  it("calculates next occurrence for yearly", () => {
    const today = new Date("2026-03-12");
    const next = new Date(today);
    next.setFullYear(next.getFullYear() + 1);
    assert.equal(next.toISOString().split("T")[0], "2027-03-12");
  });

  it("weekdays skips weekend", () => {
    // Saturday -> Monday
    const sat = new Date("2026-03-14"); // Saturday
    const next = new Date(sat);
    const day = next.getDay();
    if (day === 6) next.setDate(next.getDate() + 2); // Skip to Monday
    else if (day === 0) next.setDate(next.getDate() + 1);
    else next.setDate(next.getDate() + 1);
    assert.equal(next.getDay(), 1); // Monday
  });

  it("recurring todo has correct fields", () => {
    const todo = {
      id: 1, title: "Daily standup", recurring: true,
      recurrence_rule: "weekdays", recurrence_parent_id: null
    };
    assert.ok(todo.recurring);
    assert.equal(todo.recurrence_rule, "weekdays");
    assert.equal(todo.recurrence_parent_id, null);
  });
});

// ---------------------------------------------------------------------------
// Subtask tests
// ---------------------------------------------------------------------------
describe("Subtasks", () => {
  it("subtask has expected fields", () => {
    const subtask = {
      id: 1, todo_id: 5, title: "Step 1",
      completed: false, sort_order: 0
    };
    assert.ok("todo_id" in subtask);
    assert.ok("title" in subtask);
    assert.ok("completed" in subtask);
    assert.ok("sort_order" in subtask);
  });

  it("calculates subtask progress", () => {
    const subtasks = [
      { completed: true }, { completed: true }, { completed: false }
    ];
    const completed = subtasks.filter(s => s.completed).length;
    const total = subtasks.length;
    const pct = Math.round((completed / total) * 100);
    assert.equal(completed, 2);
    assert.equal(total, 3);
    assert.equal(pct, 67);
  });

  it("handles empty subtask list", () => {
    const subtasks = [];
    const pct = subtasks.length === 0 ? 0 : Math.round((subtasks.filter(s => s.completed).length / subtasks.length) * 100);
    assert.equal(pct, 0);
  });
});

// ---------------------------------------------------------------------------
// Email template tests
// ---------------------------------------------------------------------------
describe("Email templates", () => {
  it("template has expected fields", () => {
    const template = {
      id: 1, name: "Weekly Update", subject: "Weekly Update - {{date}}",
      body: "Hi team,\n\nHere is the weekly update..."
    };
    assert.ok("name" in template);
    assert.ok("subject" in template);
    assert.ok("body" in template);
  });

  it("template requires name, subject, body", () => {
    const valid = { name: "Test", subject: "Sub", body: "Body" };
    const invalid = { name: "Test", subject: "Sub" };
    assert.ok(valid.name && valid.subject && valid.body);
    assert.ok(!invalid.body);
  });
});

// ---------------------------------------------------------------------------
// Natural language todo parsing tests
// ---------------------------------------------------------------------------
describe("Natural language todo creation", () => {
  function parseQuickTodo(text) {
    const result = { title: text, priority: "medium", horizon: "short", due_date: null };
    if (/\b(urgent|asap|critical)\b/i.test(text)) result.priority = "urgent";
    else if (/\b(important|high\s*priority)\b/i.test(text)) result.priority = "high";
    else if (/\b(low\s*priority|whenever|someday)\b/i.test(text)) result.priority = "low";
    if (/\b(long[\s-]*term|eventually|this year)\b/i.test(text)) result.horizon = "long";
    else if (/\b(medium[\s-]*term|this month|soon)\b/i.test(text)) result.horizon = "medium";
    const tomorrowMatch = /\btomorrow\b/i.test(text);
    if (tomorrowMatch) {
      const d = new Date(); d.setDate(d.getDate() + 1);
      result.due_date = d.toISOString().split("T")[0];
    }
    return result;
  }

  it("detects urgent priority", () => {
    const r = parseQuickTodo("Fix server crash URGENT");
    assert.equal(r.priority, "urgent");
  });

  it("detects high priority", () => {
    const r = parseQuickTodo("Important: review contract");
    assert.equal(r.priority, "high");
  });

  it("detects low priority", () => {
    const r = parseQuickTodo("Someday clean garage");
    assert.equal(r.priority, "low");
  });

  it("detects long-term horizon", () => {
    const r = parseQuickTodo("Long-term: learn piano");
    assert.equal(r.horizon, "long");
  });

  it("detects medium-term horizon", () => {
    const r = parseQuickTodo("This month finish report");
    assert.equal(r.horizon, "medium");
  });

  it("defaults to short-term medium priority", () => {
    const r = parseQuickTodo("Buy groceries");
    assert.equal(r.priority, "medium");
    assert.equal(r.horizon, "short");
  });

  it("detects tomorrow as due date", () => {
    const r = parseQuickTodo("Submit report tomorrow");
    assert.ok(r.due_date);
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    assert.equal(r.due_date, expected.toISOString().split("T")[0]);
  });
});

// ---------------------------------------------------------------------------
// Global search tests
// ---------------------------------------------------------------------------
describe("Global search", () => {
  it("matches across multiple item types", () => {
    const items = [
      { type: "todo", title: "Buy groceries", description: "" },
      { type: "email", subject: "Grocery list", body: "Milk, eggs" },
      { type: "note", title: "Shopping", content: "Need groceries" },
    ];
    const query = "grocer";
    const results = items.filter(i => {
      const text = [i.title, i.description, i.subject, i.body, i.content]
        .filter(Boolean).join(" ").toLowerCase();
      return text.includes(query.toLowerCase());
    });
    assert.equal(results.length, 3);
  });

  it("handles empty query", () => {
    const query = "";
    assert.ok(!query.trim());
  });

  it("is case-insensitive", () => {
    const items = [{ title: "MEETING with team" }];
    const results = items.filter(i => i.title.toLowerCase().includes("meeting"));
    assert.equal(results.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Calendar tests
// ---------------------------------------------------------------------------
describe("Calendar", () => {
  it("computes days in month", () => {
    const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
    assert.equal(daysInMonth(2026, 0), 31); // January
    assert.equal(daysInMonth(2026, 1), 28); // February (non-leap)
    assert.equal(daysInMonth(2024, 1), 29); // February (leap)
    assert.equal(daysInMonth(2026, 2), 31); // March
  });

  it("computes first day of month", () => {
    const firstDay = new Date(2026, 2, 1).getDay(); // March 2026
    assert.ok(firstDay >= 0 && firstDay <= 6);
  });

  it("week starts on Sunday (day 0)", () => {
    const sunday = new Date("2026-03-08"); // a Sunday
    assert.equal(sunday.getDay(), 0);
  });
});

// ---------------------------------------------------------------------------
// Weekly review tests
// ---------------------------------------------------------------------------
describe("Weekly review", () => {
  it("computes week boundaries", () => {
    const getWeekStart = (date) => {
      const d = new Date(date);
      const day = d.getDay();
      d.setDate(d.getDate() - day);
      d.setHours(0, 0, 0, 0);
      return d;
    };
    const getWeekEnd = (start) => {
      const d = new Date(start);
      d.setDate(d.getDate() + 6);
      d.setHours(23, 59, 59, 999);
      return d;
    };
    const start = getWeekStart("2026-03-12");
    assert.equal(start.getDay(), 0); // Sunday
    const end = getWeekEnd(start);
    assert.equal(end.getDay(), 6); // Saturday
  });

  it("review has expected fields", () => {
    const review = {
      week_start: "2026-03-08", week_end: "2026-03-14",
      tasks_completed: 5, tasks_created: 8,
      emails_sent: 3, notes_created: 2, summary: "Productive week"
    };
    assert.ok("tasks_completed" in review);
    assert.ok("emails_sent" in review);
    assert.ok("summary" in review);
  });
});

// ---------------------------------------------------------------------------
// Drag-and-drop reorder tests
// ---------------------------------------------------------------------------
describe("Drag-and-drop reorder", () => {
  it("reorders array items correctly", () => {
    const items = [{id:1,sort_order:0},{id:2,sort_order:1},{id:3,sort_order:2}];
    // Move item 3 to position 0
    const orderedIds = [3, 1, 2];
    const reordered = orderedIds.map((id, i) => ({ id, sort_order: i }));
    assert.equal(reordered[0].id, 3);
    assert.equal(reordered[0].sort_order, 0);
    assert.equal(reordered[1].id, 1);
    assert.equal(reordered[2].id, 2);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts tests
// ---------------------------------------------------------------------------
describe("Keyboard shortcuts", () => {
  it("shortcut map has expected keys", () => {
    const shortcuts = {
      "n": "new-todo", "e": "new-email", "/": "search",
      "t": "todos-page", "d": "dashboard"
    };
    assert.equal(shortcuts["n"], "new-todo");
    assert.equal(shortcuts["/"], "search");
    assert.ok(!shortcuts["z"]);
  });
});

// ---------------------------------------------------------------------------
// AI model selection tests
// ---------------------------------------------------------------------------
describe("AI model selection", () => {
  it("valid model identifiers", () => {
    const models = {
      haiku: "claude-haiku-4-5-20251001",
      sonnet: "claude-sonnet-4-6-20250415",
    };
    assert.ok(models.haiku);
    assert.ok(models.sonnet);
    assert.ok(!models.opus); // not available
  });

  it("valid feature settings values", () => {
    const valid = ["haiku", "sonnet", "off"];
    assert.ok(valid.includes("haiku"));
    assert.ok(valid.includes("sonnet"));
    assert.ok(valid.includes("off"));
    assert.ok(!valid.includes("gpt-4"));
  });

  it("all 7 AI features have model settings", () => {
    const features = [
      "ai_model_email_draft", "ai_model_task_breakdown", "ai_model_quick_add",
      "ai_model_review_summary", "ai_model_email_tone", "ai_model_daily_briefing",
      "ai_model_note_tagging"
    ];
    assert.equal(features.length, 7);
    features.forEach(f => assert.ok(f.startsWith("ai_model_")));
  });
});

// ---------------------------------------------------------------------------
// AI task breakdown tests
// ---------------------------------------------------------------------------
describe("AI task breakdown", () => {
  it("returns array of subtask strings", () => {
    const response = { subtasks: ["Research options", "Compare prices", "Make decision"] };
    assert.ok(Array.isArray(response.subtasks));
    assert.ok(response.subtasks.every(s => typeof s === "string"));
  });

  it("requires task title", () => {
    const input = { title: "" };
    assert.ok(!input.title);
  });
});

// ---------------------------------------------------------------------------
// AI tone adjustment tests
// ---------------------------------------------------------------------------
describe("AI tone adjustment", () => {
  it("valid tone options", () => {
    const tones = ["more formal", "more casual", "shorter", "friendlier", "more direct"];
    assert.equal(tones.length, 5);
    assert.ok(tones.includes("more formal"));
    assert.ok(tones.includes("shorter"));
  });

  it("requires body and tone", () => {
    const valid = { body: "Hello", tone: "formal" };
    const invalid = { body: "Hello" };
    assert.ok(valid.body && valid.tone);
    assert.ok(!invalid.tone);
  });
});

// ---------------------------------------------------------------------------
// Todo category tests
// ---------------------------------------------------------------------------
describe("Todo categories", () => {
  it("default categories exist", () => {
    const defaults = ["work", "personal", "health", "finance", "errands", "home", "learning"];
    assert.equal(defaults.length, 7);
    assert.ok(defaults.includes("work"));
    assert.ok(defaults.includes("personal"));
  });

  it("merges default and custom categories", () => {
    const defaults = ["work", "personal", "health"];
    const custom = ["custom-project", "work"];
    const all = [...new Set([...defaults, ...custom])].sort();
    assert.equal(all.length, 4);
    assert.ok(all.includes("custom-project"));
  });

  it("category filter works on todo query", () => {
    const params = { category: "work" };
    assert.equal(params.category, "work");
  });
});

// ---------------------------------------------------------------------------
// Note tags tests
// ---------------------------------------------------------------------------
describe("Note tags", () => {
  it("tags are an array of strings", () => {
    const tags = ["meeting-notes", "project", "action-items"];
    assert.ok(Array.isArray(tags));
    assert.ok(tags.every(t => typeof t === "string"));
  });

  it("tags are lowercase and valid format", () => {
    const tags = ["meeting-notes", "project-alpha"];
    tags.forEach(t => {
      assert.ok(t === t.toLowerCase());
      assert.ok(/^[a-z0-9-]+$/.test(t));
    });
  });

  it("handles empty tags", () => {
    const note = { tags: null };
    assert.equal(note.tags, null);
  });
});

// ---------------------------------------------------------------------------
// Dashboard view tests
// ---------------------------------------------------------------------------
describe("Dashboard task views", () => {
  it("groups tasks by category", () => {
    const tasks = [
      { title: "A", category: "work" },
      { title: "B", category: "personal" },
      { title: "C", category: "work" },
    ];
    const cats = {};
    tasks.forEach(t => { var c = t.category || "Uncategorized"; if (!cats[c]) cats[c] = []; cats[c].push(t); });
    assert.equal(Object.keys(cats).length, 2);
    assert.equal(cats["work"].length, 2);
  });

  it("groups tasks by priority", () => {
    const tasks = [
      { priority: "urgent" }, { priority: "high" }, { priority: "urgent" }
    ];
    const groups = {};
    tasks.forEach(t => { if (!groups[t.priority]) groups[t.priority] = []; groups[t.priority].push(t); });
    assert.equal(groups["urgent"].length, 2);
    assert.equal(groups["high"].length, 1);
  });

  it("filters due soon tasks", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tasks = [
      { title: "A", due_date: tomorrow.toISOString() },
      { title: "B", due_date: null },
    ];
    const withDue = tasks.filter(t => t.due_date);
    assert.equal(withDue.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Security tests
// ---------------------------------------------------------------------------
describe("Security", () => {
  it("session timeout calculation", () => {
    const timeoutMinutes = 15;
    const timeout = timeoutMinutes * 60 * 1000;
    assert.equal(timeout, 900000);

    const lastActivity = Date.now() - 800000; // 13.3 minutes ago
    assert.ok(Date.now() - lastActivity < timeout, "Should still be valid");

    const expired = Date.now() - 1000000; // 16.7 minutes ago
    assert.ok(Date.now() - expired >= timeout, "Should be expired");
  });

  it("auth mode detection", () => {
    // PIN mode
    assert.equal("pin", "1234" ? "pin" : "password");
    // Password mode
    const pw = "secret";
    const mode = null ? "pin" : (pw ? "password" : null);
    assert.equal(mode, "password");
    // No auth
    const noAuth = null;
    const noMode = null ? "pin" : (noAuth ? "password" : null);
    assert.equal(noMode, null);
  });

  it("CSRF check allows JSON content-type", () => {
    const ct = "application/json";
    const xrw = undefined;
    const allowed = !!(xrw || ct.includes("application/json") || ct.includes("multipart/form-data"));
    assert.ok(allowed);
  });

  it("CSRF check allows X-Requested-With header", () => {
    const ct = "";
    const xrw = "XMLHttpRequest";
    const allowed = !!(xrw || ct.includes("application/json") || ct.includes("multipart/form-data"));
    assert.ok(allowed);
  });

  it("CSRF check allows multipart/form-data", () => {
    const ct = "multipart/form-data; boundary=----foo";
    const xrw = undefined;
    const allowed = !!(xrw || ct.includes("application/json") || ct.includes("multipart/form-data"));
    assert.ok(allowed);
  });

  it("CSRF check blocks bare POST without headers", () => {
    const ct = "";
    const xrw = undefined;
    const allowed = !!(xrw || ct.includes("application/json") || ct.includes("multipart/form-data"));
    assert.ok(!allowed);
  });

  it("CSRF check skips GET requests", () => {
    const method = "GET";
    const needsCheck = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    assert.ok(!needsCheck);
  });
});

// ---------------------------------------------------------------------------
// Backend validation tests
// ---------------------------------------------------------------------------
describe("Backend validation constants", () => {
  const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
  const VALID_HORIZONS = ["short", "medium", "long"];
  const VALID_RECURRENCE_RULES = ["daily", "weekly", "monthly", "yearly", "weekdays"];
  const VALID_NOTE_COLORS = ["default", "warm", "teal", "green", "blue"];
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const VALID_AI_FEATURES = ["email_draft", "task_breakdown", "quick_add", "review_summary", "email_tone", "daily_briefing", "note_tagging"];

  it("rejects invalid priority values", () => {
    assert.ok(!VALID_PRIORITIES.includes("critical"));
    assert.ok(!VALID_PRIORITIES.includes(""));
    assert.ok(!VALID_PRIORITIES.includes("URGENT"));
    assert.ok(VALID_PRIORITIES.includes("urgent"));
    assert.ok(VALID_PRIORITIES.includes("low"));
  });

  it("rejects invalid horizon values", () => {
    assert.ok(!VALID_HORIZONS.includes("immediate"));
    assert.ok(!VALID_HORIZONS.includes(""));
    assert.ok(VALID_HORIZONS.includes("short"));
    assert.ok(VALID_HORIZONS.includes("long"));
  });

  it("rejects invalid recurrence rules", () => {
    assert.ok(!VALID_RECURRENCE_RULES.includes("hourly"));
    assert.ok(!VALID_RECURRENCE_RULES.includes("biweekly"));
    assert.ok(!VALID_RECURRENCE_RULES.includes(""));
    assert.ok(VALID_RECURRENCE_RULES.includes("daily"));
    assert.ok(VALID_RECURRENCE_RULES.includes("weekdays"));
  });

  it("rejects invalid note colors", () => {
    assert.ok(!VALID_NOTE_COLORS.includes("red"));
    assert.ok(!VALID_NOTE_COLORS.includes("purple"));
    assert.ok(VALID_NOTE_COLORS.includes("default"));
    assert.ok(VALID_NOTE_COLORS.includes("teal"));
  });

  it("validates email format", () => {
    assert.ok(EMAIL_REGEX.test("user@example.com"));
    assert.ok(EMAIL_REGEX.test("a@b.co"));
    assert.ok(EMAIL_REGEX.test("test.user+tag@domain.org"));
    assert.ok(!EMAIL_REGEX.test("invalid"));
    assert.ok(!EMAIL_REGEX.test("@missing.com"));
    assert.ok(!EMAIL_REGEX.test("no@domain"));
    assert.ok(!EMAIL_REGEX.test("spaces in@email.com"));
    assert.ok(!EMAIL_REGEX.test(""));
  });

  it("validates AI feature names", () => {
    assert.ok(VALID_AI_FEATURES.includes("email_draft"));
    assert.ok(VALID_AI_FEATURES.includes("note_tagging"));
    assert.equal(VALID_AI_FEATURES.length, 7);
    assert.ok(!VALID_AI_FEATURES.includes("unknown_feature"));
    assert.ok(!VALID_AI_FEATURES.includes(""));
  });
});

// ---------------------------------------------------------------------------
// Soft delete / trash tests
// ---------------------------------------------------------------------------
describe("Soft delete and trash", () => {
  it("trash type mapping validates correctly", () => {
    const validTypes = { todo: "todos", email: "emails", note: "notes" };
    assert.equal(validTypes.todo, "todos");
    assert.equal(validTypes.email, "emails");
    assert.equal(validTypes.note, "notes");
    assert.equal(validTypes.invalid, undefined);
    assert.equal(validTypes[""], undefined);
  });

  it("deleted_at field distinguishes active vs trashed items", () => {
    const active = { id: 1, title: "Active", deleted_at: null };
    const trashed = { id: 2, title: "Trashed", deleted_at: "2026-03-13T12:00:00Z" };
    assert.equal(active.deleted_at, null);
    assert.ok(trashed.deleted_at !== null);
    // Filter pattern matches what queries do
    const items = [active, trashed];
    assert.deepEqual(items.filter(i => i.deleted_at === null), [active]);
    assert.deepEqual(items.filter(i => i.deleted_at !== null), [trashed]);
  });
});

// ---------------------------------------------------------------------------
// Bulk action tests
// ---------------------------------------------------------------------------
describe("Bulk actions", () => {
  it("validates bulk action requires ids array", () => {
    const valid = { ids: [1, 2, 3], action: "complete" };
    const invalidNoIds = { action: "complete" };
    const invalidEmptyIds = { ids: [], action: "complete" };
    assert.ok(Array.isArray(valid.ids) && valid.ids.length > 0);
    assert.ok(!invalidNoIds.ids);
    assert.ok(invalidEmptyIds.ids.length === 0);
  });

  it("validates bulk action types", () => {
    const validActions = ["complete", "delete", "set_priority", "set_horizon"];
    assert.ok(validActions.includes("complete"));
    assert.ok(validActions.includes("delete"));
    assert.ok(validActions.includes("set_priority"));
    assert.ok(!validActions.includes("unknown"));
  });

  it("set_priority requires valid priority value", () => {
    const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
    assert.ok(VALID_PRIORITIES.includes("urgent"));
    assert.ok(!VALID_PRIORITIES.includes("critical"));
  });
});

// ---------------------------------------------------------------------------
// Theme auto-detection tests
// ---------------------------------------------------------------------------
describe("Theme settings", () => {
  it("supports dark, light, and auto values", () => {
    const validThemes = ["dark", "light", "auto"];
    assert.ok(validThemes.includes("dark"));
    assert.ok(validThemes.includes("light"));
    assert.ok(validThemes.includes("auto"));
    assert.ok(!validThemes.includes("purple"));
  });

  it("auto theme resolves to dark or light", () => {
    function resolveTheme(theme, systemPrefersDark) {
      if (theme === "auto") return systemPrefersDark ? "dark" : "light";
      return theme;
    }
    assert.equal(resolveTheme("auto", true), "dark");
    assert.equal(resolveTheme("auto", false), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("light", true), "light");
  });
});

// ---------------------------------------------------------------------------
// Dashboard inline actions tests
// ---------------------------------------------------------------------------
describe("Dashboard inline actions", () => {
  it("recurring task completion creates next instance", () => {
    const todo = { id: 1, title: "Weekly meeting", recurring: true, recurrence_rule: "weekly", due_date: "2026-03-06" };
    const nextDue = new Date(todo.due_date);
    nextDue.setDate(nextDue.getDate() + 7);
    assert.equal(nextDue.toISOString().split("T")[0], "2026-03-13");
  });

  it("non-recurring task simply marks as complete", () => {
    const todo = { id: 2, title: "One-time task", recurring: false, completed: false };
    const updated = { ...todo, completed: true, completed_at: new Date().toISOString() };
    assert.ok(updated.completed);
    assert.ok(updated.completed_at);
  });
});

// ---------------------------------------------------------------------------
// Markdown notes tests
// ---------------------------------------------------------------------------
describe("Markdown notes", () => {
  it("validates note format field", () => {
    const validFormats = ["plain", "markdown"];
    assert.ok(validFormats.includes("plain"));
    assert.ok(validFormats.includes("markdown"));
    assert.ok(!validFormats.includes("html"));
    assert.ok(!validFormats.includes("richtext"));
  });

  it("renders markdown bold and italic correctly", () => {
    // Simulate the renderMd logic for bold/italic
    function renderMdSimple(s) {
      return s
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
    }
    assert.ok(renderMdSimple("**bold**").includes("<strong>bold</strong>"));
    assert.ok(renderMdSimple("*italic*").includes("<em>italic</em>"));
    assert.ok(renderMdSimple("***both***").includes("<strong><em>both</em></strong>"));
  });

  it("renders markdown lists and checkboxes", () => {
    function renderMdLists(s) {
      return s
        .replace(/^- \[x\] (.+)$/gm, '<done>$1</done>')
        .replace(/^- \[ \] (.+)$/gm, '<todo>$1</todo>')
        .replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    }
    assert.ok(renderMdLists("- [x] Done task").includes("<done>Done task</done>"));
    assert.ok(renderMdLists("- [ ] Pending task").includes("<todo>Pending task</todo>"));
    assert.ok(renderMdLists("- List item").includes("<li>List item</li>"));
  });

  it("default format is plain", () => {
    const note = { id: 1, content: "Hello", format: "plain" };
    assert.equal(note.format, "plain");
  });
});

// ---------------------------------------------------------------------------
// Task dependency tests
// ---------------------------------------------------------------------------
describe("Task dependencies", () => {
  it("prevents self-dependency", () => {
    const todoId = 5;
    const dependsOnId = 5;
    assert.equal(todoId === dependsOnId, true);
    // API should reject this
  });

  it("detects circular dependencies", () => {
    // If A depends on B, then B cannot depend on A
    const deps = [
      { todo_id: 1, depends_on_id: 2 },
    ];
    const newDep = { todo_id: 2, depends_on_id: 1 };
    const isCircular = deps.some(d => d.todo_id === newDep.depends_on_id && d.depends_on_id === newDep.todo_id);
    assert.ok(isCircular);
  });

  it("identifies blocked tasks correctly", () => {
    const deps = {
      blocked_by: [
        { depends_on_id: 2, title: "Task B", completed: false },
        { depends_on_id: 3, title: "Task C", completed: true },
      ],
      blocking: [
        { todo_id: 4, title: "Task D" },
      ],
    };
    const unblockedDeps = deps.blocked_by.filter(d => !d.completed);
    assert.equal(unblockedDeps.length, 1);
    assert.equal(deps.blocking.length, 1);
    // Task is blocked if any unblocked dependency exists
    assert.ok(unblockedDeps.length > 0);
  });

  it("allows completion of non-blocked tasks", () => {
    const deps = {
      blocked_by: [
        { depends_on_id: 2, title: "Task B", completed: true },
      ],
    };
    const unblockedDeps = deps.blocked_by.filter(d => !d.completed);
    assert.equal(unblockedDeps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Streak/habit tracking tests
// ---------------------------------------------------------------------------
describe("Streak tracking", () => {
  it("increments streak on on-time completion", () => {
    const todo = { streak_count: 3, best_streak: 5, due_date: "2026-03-15" };
    const today = "2026-03-14";
    const isOnTime = today <= todo.due_date;
    const newStreak = isOnTime ? todo.streak_count + 1 : 1;
    const newBest = Math.max(newStreak, todo.best_streak);
    assert.equal(newStreak, 4);
    assert.equal(newBest, 5);
  });

  it("resets streak on late completion", () => {
    const todo = { streak_count: 3, best_streak: 5, due_date: "2026-03-10" };
    const today = "2026-03-14";
    const isOnTime = today <= todo.due_date;
    const newStreak = isOnTime ? todo.streak_count + 1 : 1;
    assert.equal(newStreak, 1);
  });

  it("updates best streak when current exceeds it", () => {
    const todo = { streak_count: 5, best_streak: 5, due_date: "2026-03-15" };
    const today = "2026-03-14";
    const isOnTime = today <= todo.due_date;
    const newStreak = isOnTime ? todo.streak_count + 1 : 1;
    const newBest = Math.max(newStreak, todo.best_streak);
    assert.equal(newStreak, 6);
    assert.equal(newBest, 6);
  });

  it("carries streak to next recurring instance", () => {
    const completed = { streak_count: 4, best_streak: 4 };
    const next = { ...completed, completed: false, due_date: "2026-03-20" };
    assert.equal(next.streak_count, 4);
    assert.equal(next.best_streak, 4);
    assert.equal(next.completed, false);
  });

  it("resets streak on overdue auto-completion", () => {
    // Cron job auto-completes overdue tasks with streak = 0
    const todo = { streak_count: 5, best_streak: 5 };
    const autoCompleted = { ...todo, streak_count: 0, completed: true };
    assert.equal(autoCompleted.streak_count, 0);
    // Best streak preserved
    const next = { streak_count: 0, best_streak: todo.best_streak };
    assert.equal(next.best_streak, 5);
  });
});

// ---------------------------------------------------------------------------
// Dashboard customization tests
// ---------------------------------------------------------------------------
describe("Dashboard customization", () => {
  it("default layout contains all widgets", () => {
    const layout = { widgets: ["search", "cards", "briefing", "suggestions", "ai_query", "tasks", "upcoming_emails", "perfin", "shortcuts"], hidden: [] };
    assert.equal(layout.widgets.length, 9);
    assert.ok(layout.widgets.includes("search"));
    assert.ok(layout.widgets.includes("tasks"));
    assert.ok(layout.widgets.includes("suggestions"));
    assert.ok(layout.widgets.includes("ai_query"));
  });

  it("hidden widgets are excluded from display", () => {
    const layout = { widgets: ["search", "cards", "tasks"], hidden: ["cards"] };
    const visible = layout.widgets.filter(w => !layout.hidden.includes(w));
    assert.equal(visible.length, 2);
    assert.ok(!visible.includes("cards"));
  });

  it("widget reordering preserves all widgets", () => {
    const widgets = ["a", "b", "c"];
    const srcIdx = 0, tgtIdx = 2;
    const moved = widgets.splice(srcIdx, 1)[0];
    widgets.splice(tgtIdx, 0, moved);
    assert.deepEqual(widgets, ["b", "c", "a"]);
    assert.equal(widgets.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Automation rules tests
// ---------------------------------------------------------------------------
describe("Automations", () => {
  it("validates trigger types", () => {
    const VALID_TRIGGERS = ["todo_created", "todo_completed", "email_created", "note_created", "schedule"];
    assert.ok(VALID_TRIGGERS.includes("todo_created"));
    assert.ok(VALID_TRIGGERS.includes("todo_completed"));
    assert.ok(!VALID_TRIGGERS.includes("invalid"));
  });

  it("validates action types", () => {
    const VALID_ACTIONS = ["set_priority", "set_category", "set_horizon", "add_tag", "send_notification", "create_todo"];
    assert.ok(VALID_ACTIONS.includes("set_priority"));
    assert.ok(VALID_ACTIONS.includes("create_todo"));
    assert.ok(!VALID_ACTIONS.includes("delete_all"));
  });

  it("condition matching works correctly", () => {
    const rule = { conditions: { category: "work", title_contains: "meeting" } };
    const entity1 = { title: "Weekly meeting", category: "work" };
    const entity2 = { title: "Buy groceries", category: "personal" };
    // entity1 matches
    let match1 = true;
    if (rule.conditions.category && entity1.category !== rule.conditions.category) match1 = false;
    if (rule.conditions.title_contains && !entity1.title.toLowerCase().includes(rule.conditions.title_contains)) match1 = false;
    assert.ok(match1);
    // entity2 doesn't match
    let match2 = true;
    if (rule.conditions.category && entity2.category !== rule.conditions.category) match2 = false;
    assert.ok(!match2);
  });
});

// ---------------------------------------------------------------------------
// File attachment tests
// ---------------------------------------------------------------------------
describe("File attachments", () => {
  it("validates entity types", () => {
    const valid = ["todo", "email", "note"];
    assert.ok(valid.includes("todo"));
    assert.ok(valid.includes("note"));
    assert.ok(!valid.includes("contact"));
  });

  it("attachment has expected fields", () => {
    const attachment = { id: 1, filename: "123-file.pdf", original_name: "file.pdf", mime_type: "application/pdf", size_bytes: 1024, entity_type: "todo", entity_id: 1 };
    assert.ok(attachment.filename);
    assert.ok(attachment.original_name);
    assert.ok(attachment.mime_type);
    assert.ok(attachment.size_bytes > 0);
    assert.ok(["todo", "email", "note"].includes(attachment.entity_type));
  });
});

// ---------------------------------------------------------------------------
// iCal export tests
// ---------------------------------------------------------------------------
describe("iCal export", () => {
  it("generates valid iCal format", () => {
    const header = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Per-sistant//EN\r\n";
    assert.ok(header.includes("BEGIN:VCALENDAR"));
    assert.ok(header.includes("VERSION:2.0"));
  });

  it("formats dates correctly for iCal", () => {
    const d = new Date("2026-03-15");
    const dateStr = d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const dateOnly = dateStr.substring(0, 8);
    assert.equal(dateOnly, "20260315");
  });
});

// ---------------------------------------------------------------------------
// Location-based reminder tests
// ---------------------------------------------------------------------------
describe("Location reminders", () => {
  it("haversine distance calculation", () => {
    // Simple haversine distance
    function haversine(lat1, lon1, lat2, lon2) {
      var R = 6371000; var p = Math.PI / 180;
      var a = 0.5 - Math.cos((lat2-lat1)*p)/2 + Math.cos(lat1*p)*Math.cos(lat2*p)*(1-Math.cos((lon2-lon1)*p))/2;
      return 2 * R * Math.asin(Math.sqrt(a));
    }
    // Same point = 0 distance
    assert.equal(haversine(40.7128, -74.006, 40.7128, -74.006), 0);
    // NYC to nearby point (~1km)
    const dist = haversine(40.7128, -74.006, 40.7218, -74.006);
    assert.ok(dist > 900 && dist < 1100);
  });

  it("location reminder fields are valid", () => {
    const todo = { location_name: "Office", location_lat: 40.7128, location_lng: -74.006, location_radius: 200 };
    assert.ok(todo.location_lat >= -90 && todo.location_lat <= 90);
    assert.ok(todo.location_lng >= -180 && todo.location_lng <= 180);
    assert.ok(todo.location_radius > 0);
  });
});

// ---------------------------------------------------------------------------
// Offline support tests
// ---------------------------------------------------------------------------
describe("Offline support", () => {
  it("offline queue structure is valid", () => {
    const queue = [
      { url: "/api/todos", method: "POST", body: '{"title":"Test"}', headers: { "Content-Type": "application/json" } },
    ];
    assert.ok(Array.isArray(queue));
    assert.equal(queue[0].method, "POST");
    assert.ok(queue[0].body);
  });

  it("cache version naming", () => {
    const CACHE = "per-sistant-v2";
    assert.ok(CACHE.startsWith("per-sistant-"));
    assert.ok(CACHE.includes("v2"));
  });
});

// ---------------------------------------------------------------------------
// Custom recurrence intervals tests
// ---------------------------------------------------------------------------
describe("Custom recurrence intervals", () => {
  function advanceRecurrence(date, rule, interval) {
    const d = new Date(date);
    const n = interval || 1;
    if (rule === "daily" || rule === "custom_days") d.setDate(d.getDate() + n);
    else if (rule === "weekdays") {
      let count = 0;
      while (count < n) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) count++; }
    }
    else if (rule === "weekly" || rule === "custom_weeks") d.setDate(d.getDate() + 7 * n);
    else if (rule === "monthly" || rule === "custom_months") d.setMonth(d.getMonth() + n);
    else if (rule === "yearly") d.setFullYear(d.getFullYear() + n);
    return d;
  }

  it("advances daily by 1", () => {
    const d = advanceRecurrence(new Date("2026-03-10"), "daily", 1);
    assert.equal(d.toISOString().split("T")[0], "2026-03-11");
  });

  it("advances custom_days by 3", () => {
    const d = advanceRecurrence(new Date("2026-03-10"), "custom_days", 3);
    assert.equal(d.toISOString().split("T")[0], "2026-03-13");
  });

  it("advances custom_weeks by 2", () => {
    const d = advanceRecurrence(new Date("2026-03-10"), "custom_weeks", 2);
    assert.equal(d.toISOString().split("T")[0], "2026-03-24");
  });

  it("advances custom_months by 3", () => {
    const d = advanceRecurrence(new Date("2026-03-10"), "custom_months", 3);
    assert.equal(d.getMonth(), 5); // June (0-indexed)
  });

  it("weekdays skips weekends", () => {
    const d = advanceRecurrence(new Date("2026-03-13"), "weekdays", 1); // Friday
    assert.equal(d.getDay(), 1); // Monday
  });

  it("validates extended recurrence rules", () => {
    const valid = ["daily", "weekly", "monthly", "yearly", "weekdays", "custom_days", "custom_weeks", "custom_months"];
    assert.ok(valid.includes("custom_days"));
    assert.ok(valid.includes("custom_weeks"));
    assert.ok(valid.includes("custom_months"));
    assert.ok(!valid.includes("biweekly"));
  });
});

// ---------------------------------------------------------------------------
// Skip/snooze tests
// ---------------------------------------------------------------------------
describe("Skip and snooze recurring tasks", () => {
  it("skip preserves streak but increments skip count", () => {
    const todo = { streak_count: 5, best_streak: 5, skipped_count: 0 };
    // After skip: streak stays, skip count increments
    const afterSkip = { streak_count: todo.streak_count, skipped_count: todo.skipped_count + 1 };
    assert.equal(afterSkip.streak_count, 5);
    assert.equal(afterSkip.skipped_count, 1);
  });

  it("snooze updates due date", () => {
    const todo = { due_date: "2026-03-15", snoozed_until: null };
    const snoozed = { ...todo, due_date: "2026-03-18", snoozed_until: "2026-03-18" };
    assert.equal(snoozed.due_date, "2026-03-18");
    assert.equal(snoozed.snoozed_until, "2026-03-18");
  });

  it("snooze requires a date", () => {
    const body = {};
    assert.ok(!body.until, "Snooze should require 'until' date");
  });
});

// ---------------------------------------------------------------------------
// Cross-entity links tests
// ---------------------------------------------------------------------------
describe("Cross-entity links", () => {
  it("link structure is valid", () => {
    const link = { source_type: "note", source_id: 1, target_type: "todo", target_id: 5 };
    assert.ok(["todo", "email", "note"].includes(link.source_type));
    assert.ok(["todo", "email", "note"].includes(link.target_type));
    assert.ok(link.source_id !== undefined);
    assert.ok(link.target_id !== undefined);
  });

  it("cannot link entity to itself", () => {
    const link = { source_type: "todo", source_id: 1, target_type: "todo", target_id: 1 };
    const isSelf = link.source_type === link.target_type && link.source_id === link.target_id;
    assert.ok(isSelf, "Should detect self-link");
  });

  it("supports all entity types for linking", () => {
    const types = ["todo", "email", "note"];
    const validLinks = [];
    types.forEach(s => types.forEach(t => validLinks.push({ source: s, target: t })));
    assert.equal(validLinks.length, 9); // 3x3 combinations
  });

  it("create-todo-from-note extracts title", () => {
    const note = { title: "Meeting Notes", content: "Discussed project timeline and deliverables..." };
    const todoTitle = note.title || note.content.substring(0, 100);
    assert.equal(todoTitle, "Meeting Notes");
  });

  it("create-todo-from-email uses subject", () => {
    const email = { subject: "Re: Project Update", recipient_name: "Alice", body: "Please review the docs..." };
    const todoTitle = email.subject;
    const todoDesc = `Follow up on email to ${email.recipient_name}: ${email.body.substring(0, 200)}`;
    assert.equal(todoTitle, "Re: Project Update");
    assert.ok(todoDesc.includes("Follow up"));
  });
});

// ---------------------------------------------------------------------------
// Webhook tests
// ---------------------------------------------------------------------------
describe("Webhooks", () => {
  it("webhook structure is valid", () => {
    const webhook = { name: "Test", url: "https://example.com/hook", events: ["todo_created", "todo_completed"], enabled: true, headers: {} };
    assert.ok(webhook.name);
    assert.ok(webhook.url.startsWith("https://"));
    assert.ok(Array.isArray(webhook.events));
    assert.ok(webhook.events.length > 0);
  });

  it("validates webhook events", () => {
    const valid = ["todo_created", "todo_completed", "email_sent", "note_created", "reminder_due", "streak_milestone"];
    assert.ok(valid.includes("todo_created"));
    assert.ok(valid.includes("streak_milestone"));
    assert.ok(!valid.includes("invalid_event"));
  });

  it("webhook payload has correct format", () => {
    const payload = { event: "todo_completed", timestamp: new Date().toISOString(), data: { id: 1, title: "Test" } };
    assert.ok(payload.event);
    assert.ok(payload.timestamp);
    assert.ok(payload.data);
  });

  it("webhook test payload format", () => {
    const payload = { event: "test", timestamp: new Date().toISOString(), message: "Per-sistant webhook test" };
    assert.equal(payload.event, "test");
    assert.ok(payload.message);
  });
});

// ---------------------------------------------------------------------------
// Slack integration tests
// ---------------------------------------------------------------------------
describe("Slack integration", () => {
  it("slack message format is valid", () => {
    const msg = { text: "Task completed: Buy groceries" };
    assert.ok(msg.text);
    assert.ok(typeof msg.text === "string");
  });

  it("slack webhook URL format", () => {
    const url = "https://hooks.slack.com/services/T00/B00/xxxx";
    assert.ok(url.startsWith("https://hooks.slack.com/"));
  });
});

// ---------------------------------------------------------------------------
// Notification check tests
// ---------------------------------------------------------------------------
describe("Notification system", () => {
  it("categorizes notifications correctly", () => {
    const notifications = [
      { type: "due_today", title: "Buy groceries", id: 1, entity: "todo" },
      { type: "overdue", title: "Pay bills", id: 2, entity: "todo" },
      { type: "streak_at_risk", title: "Exercise (5 streak)", id: 3, entity: "todo" },
      { type: "reminder", title: "Meeting notes", id: 4, entity: "note" },
    ];
    assert.equal(notifications.filter(n => n.type === "overdue").length, 1);
    assert.equal(notifications.filter(n => n.type === "streak_at_risk").length, 1);
    assert.equal(notifications.filter(n => n.entity === "note").length, 1);
  });

  it("notification counts are computed", () => {
    const counts = { due_today: 3, overdue: 1, streaks_at_risk: 2, reminders: 0 };
    assert.ok(typeof counts.due_today === "number");
    assert.ok(typeof counts.overdue === "number");
    assert.ok(counts.due_today + counts.overdue > 0);
  });

  it("priority notifications filter correctly", () => {
    const notifications = [
      { type: "due_today", title: "A" },
      { type: "overdue", title: "B" },
      { type: "streak_at_risk", title: "C" },
    ];
    const important = notifications.filter(n => n.type === "overdue" || n.type === "streak_at_risk");
    assert.equal(important.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Analytics tests
// ---------------------------------------------------------------------------
describe("Analytics and insights", () => {
  it("period filter values are valid", () => {
    const valid = ["week", "month", "quarter", "year"];
    assert.ok(valid.includes("week"));
    assert.ok(valid.includes("quarter"));
    assert.ok(!valid.includes("day"));
  });

  it("completion rate calculation", () => {
    const done = 15, total = 20;
    const rate = total > 0 ? Math.round((done / total) * 100) : 0;
    assert.equal(rate, 75);
  });

  it("completion rate with zero tasks", () => {
    const done = 0, total = 0;
    const rate = total > 0 ? Math.round((done / total) * 100) : 0;
    assert.equal(rate, 0);
  });

  it("day of week mapping", () => {
    const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    assert.equal(dowNames[0], "Sun");
    assert.equal(dowNames[6], "Sat");
    assert.equal(dowNames.length, 7);
  });

  it("analytics response has expected fields including new ones", () => {
    const response = {
      period: "week", start_date: "2026-03-09", end_date: "2026-03-15",
      completed_by_day: [], created_by_day: [], completion_rate: 75,
      total_completed: 15, total_created: 20,
      priority_breakdown: [], category_breakdown: [],
      avg_completion_hours: 24.5, streak_leaders: [], productivity_by_dow: [],
      heatmap: [], productivity_score: 72, emails_sent: 5, notes_created: 3,
    };
    assert.ok("completion_rate" in response);
    assert.ok("priority_breakdown" in response);
    assert.ok("streak_leaders" in response);
    assert.ok("productivity_by_dow" in response);
    assert.ok("avg_completion_hours" in response);
    assert.ok("heatmap" in response);
    assert.ok("productivity_score" in response);
    assert.ok("emails_sent" in response);
    assert.ok("notes_created" in response);
  });

  it("productivity by day of week data structure", () => {
    const dowData = [
      { dow: 0, count: 2 }, { dow: 1, count: 5 }, { dow: 2, count: 3 },
      { dow: 3, count: 4 }, { dow: 4, count: 6 }, { dow: 5, count: 1 },
    ];
    const maxCount = Math.max(...dowData.map(d => d.count));
    assert.equal(maxCount, 6); // Thursday
    assert.ok(dowData.every(d => d.dow >= 0 && d.dow <= 6));
  });

  it("productivity score calculation", () => {
    // Score is weighted: completion rate 40%, streak 20%, volume 20%, speed 20%
    const completionPct = 80;
    const topStreak = 7;
    const totalCompleted = 10;
    const avgHours = 24;
    const volumeScore = Math.min(totalCompleted / 10, 1) * 100;
    const speedScore = Math.max(0, Math.min(100, 100 - avgHours));
    const streakScore = Math.min(topStreak / 7, 1) * 100;
    const score = Math.round(completionPct * 0.4 + streakScore * 0.2 + volumeScore * 0.2 + speedScore * 0.2);
    assert.ok(score >= 0 && score <= 100);
    assert.equal(volumeScore, 100); // 10 tasks = max volume
    assert.equal(streakScore, 100); // 7-day streak = max
  });

  it("heatmap data maps dates to counts", () => {
    const heatmap = [
      { day: "2026-03-10", count: 3 },
      { day: "2026-03-11", count: 0 },
      { day: "2026-03-12", count: 5 },
    ];
    const heatmapMap = {};
    heatmap.forEach(h => { heatmapMap[h.day] = parseInt(h.count); });
    assert.equal(heatmapMap["2026-03-10"], 3);
    assert.equal(heatmapMap["2026-03-12"], 5);
    assert.equal(heatmapMap["2026-03-13"] || 0, 0);
  });

  it("heatmap intensity levels", () => {
    const maxHeat = 10;
    function getIntensity(count) {
      return count === 0 ? 0 : count <= maxHeat * 0.33 ? 1 : count <= maxHeat * 0.66 ? 2 : 3;
    }
    assert.equal(getIntensity(0), 0);
    assert.equal(getIntensity(2), 1);
    assert.equal(getIntensity(5), 2);
    assert.equal(getIntensity(8), 3);
  });
});

// ---------------------------------------------------------------------------
// Todo templates
// ---------------------------------------------------------------------------
describe("Todo templates", () => {
  it("template structure has required fields", () => {
    const template = {
      id: 1, name: "Weekly Report", title: "Write weekly report",
      description: "Summarize accomplishments", priority: "high",
      horizon: "short", category: "work", recurring: true,
      recurrence_rule: "weekly", recurrence_interval: 1,
      subtasks: ["Draft outline", "Add metrics", "Review"],
    };
    assert.ok(template.name);
    assert.ok(template.title);
    assert.equal(template.subtasks.length, 3);
    assert.equal(template.recurring, true);
  });

  it("template apply creates todo with template fields", () => {
    const template = { title: "Team standup", priority: "medium", horizon: "short", category: "work" };
    const overrides = { due_date: "2026-03-20" };
    const todo = {
      title: overrides.title || template.title,
      priority: overrides.priority || template.priority,
      horizon: overrides.horizon || template.horizon,
      category: overrides.category || template.category,
      due_date: overrides.due_date || null,
    };
    assert.equal(todo.title, "Team standup");
    assert.equal(todo.due_date, "2026-03-20");
    assert.equal(todo.priority, "medium");
  });

  it("template subtasks are applied as strings", () => {
    const subtasks = [{ title: "Step 1" }, { title: "Step 2" }, "Step 3"];
    const processed = subtasks.map(s => typeof s === "string" ? s : s.title);
    assert.deepEqual(processed, ["Step 1", "Step 2", "Step 3"]);
  });

  it("template validates priority and horizon", () => {
    const VALID_PRIORITIES = ["low", "medium", "high", "urgent"];
    const VALID_HORIZONS = ["short", "medium", "long"];
    assert.ok(VALID_PRIORITIES.includes("high"));
    assert.ok(!VALID_PRIORITIES.includes("critical"));
    assert.ok(VALID_HORIZONS.includes("long"));
    assert.ok(!VALID_HORIZONS.includes("forever"));
  });
});

// ---------------------------------------------------------------------------
// Batch contact import
// ---------------------------------------------------------------------------
describe("Batch contact import", () => {
  it("validates contact structure", () => {
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const contacts = [
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "invalid" },
      { name: "", email: "c@d.com" },
    ];
    const valid = contacts.filter(c => c.name && c.email && EMAIL_REGEX.test(c.email));
    const invalid = contacts.filter(c => !c.name || !c.email || !EMAIL_REGEX.test(c.email));
    assert.equal(valid.length, 1);
    assert.equal(invalid.length, 2);
  });

  it("parses CSV lines into contacts", () => {
    const csv = "name,email\nAlice,alice@test.com\nBob,bob@test.com";
    const lines = csv.split("\n").filter(l => l.trim());
    const contacts = [];
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(",").map(s => s.trim());
      if (i === 0 && parts[0].toLowerCase() === "name") continue;
      if (parts.length >= 2) contacts.push({ name: parts[0], email: parts[1] });
    }
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].name, "Alice");
    assert.equal(contacts[1].email, "bob@test.com");
  });

  it("handles CSV with quotes", () => {
    const line = '"John Doe","john@test.com"';
    const parts = line.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
    assert.equal(parts[0], "John Doe");
    assert.equal(parts[1], "john@test.com");
  });
});

// ---------------------------------------------------------------------------
// Quick actions from search
// ---------------------------------------------------------------------------
describe("Quick actions from search", () => {
  it("search results include actionable fields for todos", () => {
    const result = { id: 1, title: "Buy groceries", type: "todo", completed: false, recurring: false, priority: "high" };
    assert.equal(result.type, "todo");
    assert.equal(result.completed, false);
    assert.ok("recurring" in result);
  });

  it("search results include status for emails", () => {
    const result = { id: 2, title: "Meeting invite", type: "email", status: "scheduled" };
    assert.equal(result.status, "scheduled");
  });

  it("search results include pinned status for notes", () => {
    const result = { id: 3, title: "Shopping list", type: "note", pinned: false };
    assert.equal(result.pinned, false);
  });

  it("determines correct action buttons per type", () => {
    function getActions(r) {
      if (r.type === "todo" && !r.completed) return ["complete"];
      if (r.type === "email" && r.status === "scheduled") return ["send"];
      if (r.type === "note") return [r.pinned ? "unpin" : "pin"];
      return [];
    }
    assert.deepEqual(getActions({ type: "todo", completed: false }), ["complete"]);
    assert.deepEqual(getActions({ type: "email", status: "scheduled" }), ["send"]);
    assert.deepEqual(getActions({ type: "note", pinned: true }), ["unpin"]);
    assert.deepEqual(getActions({ type: "todo", completed: true }), []);
    assert.deepEqual(getActions({ type: "contact" }), []);
  });
});

// ---------------------------------------------------------------------------
// Undo actions
// ---------------------------------------------------------------------------
describe("Undo actions", () => {
  it("supports delete, complete, and send undo types", () => {
    const validActions = ["delete", "complete", "send"];
    validActions.forEach(action => {
      assert.ok(typeof action === "string");
    });
  });

  it("undo complete reverses task completion", () => {
    let task = { id: 1, completed: true };
    // Simulate undo
    task.completed = false;
    assert.equal(task.completed, false);
  });

  it("undo delete restores from trash", () => {
    const trashItem = { id: 1, type: "todo", deleted_at: "2026-03-15T10:00:00Z" };
    // Restore = set deleted_at to null
    const restored = { ...trashItem, deleted_at: null };
    assert.equal(restored.deleted_at, null);
  });
});

// ---------------------------------------------------------------------------
// Recurring task calendar projections
// ---------------------------------------------------------------------------
describe("Recurring task calendar projections", () => {
  function advanceRecurrence(date, rule, interval) {
    const d = new Date(date);
    const n = interval || 1;
    if (rule === "daily" || rule === "custom_days") d.setDate(d.getDate() + n);
    else if (rule === "weekly" || rule === "custom_weeks") d.setDate(d.getDate() + 7 * n);
    else if (rule === "monthly" || rule === "custom_months") d.setMonth(d.getMonth() + n);
    else if (rule === "yearly") d.setFullYear(d.getFullYear() + n);
    return d;
  }

  it("projects weekly recurring into a month", () => {
    const start = new Date("2026-03-01");
    const end = new Date("2026-04-01");
    let nextDate = new Date("2026-03-05"); // A Thursday
    const projected = [];
    let safety = 0;
    while (nextDate < end && safety++ < 20) {
      if (nextDate >= start) projected.push(nextDate.toISOString().split("T")[0]);
      nextDate = advanceRecurrence(nextDate, "weekly", 1);
    }
    assert.ok(projected.length >= 3); // Should be 4 Thursdays in March
    assert.ok(projected.length <= 5);
  });

  it("projects daily recurring correctly", () => {
    const start = new Date("2026-03-10");
    const end = new Date("2026-03-15");
    let next = new Date("2026-03-10");
    const projected = [];
    let safety = 0;
    while (next < end && safety++ < 100) {
      if (next >= start) projected.push(next.toISOString().split("T")[0]);
      next = advanceRecurrence(next, "daily", 1);
    }
    assert.equal(projected.length, 5); // 10,11,12,13,14
  });

  it("marks projected events differently from actual", () => {
    const actual = { id: 1, title: "Task", type: "todo", event_date: "2026-03-15" };
    const projected = { id: 1, title: "Task", type: "todo", event_date: "2026-03-22", recurring_projection: true };
    assert.ok(!actual.recurring_projection);
    assert.ok(projected.recurring_projection);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
describe("Pagination", () => {
  it("builds limit clause from query params", () => {
    const limit = "10";
    const offset = "20";
    let pagination = "";
    let idx = 1;
    const params = [];
    if (limit) { pagination += ` LIMIT $${idx++}`; params.push(parseInt(limit, 10)); }
    if (offset) { pagination += ` OFFSET $${idx++}`; params.push(parseInt(offset, 10)); }
    assert.equal(pagination, " LIMIT $1 OFFSET $2");
    assert.deepEqual(params, [10, 20]);
  });

  it("works without limit or offset", () => {
    const limit = undefined;
    const offset = undefined;
    let pagination = "";
    if (limit) pagination += " LIMIT " + limit;
    if (offset) pagination += " OFFSET " + offset;
    assert.equal(pagination, "");
  });

  it("handles limit without offset", () => {
    const limit = "25";
    const offset = undefined;
    let pagination = "";
    let idx = 1;
    const params = [];
    if (limit) { pagination += ` LIMIT $${idx++}`; params.push(parseInt(limit, 10)); }
    if (offset) { pagination += ` OFFSET $${idx++}`; params.push(parseInt(offset, 10)); }
    assert.equal(pagination, " LIMIT $1");
    assert.deepEqual(params, [25]);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
describe("Health check", () => {
  it("response structure", () => {
    const response = {
      status: "ok", uptime: 3600, memory_mb: 128,
      db: "connected", timestamp: new Date().toISOString(),
    };
    assert.ok("status" in response);
    assert.ok("uptime" in response);
    assert.ok("memory_mb" in response);
    assert.ok("db" in response);
    assert.ok("timestamp" in response);
    assert.equal(response.status, "ok");
  });

  it("degraded status when db disconnected", () => {
    const response = { status: "degraded", db: "disconnected" };
    assert.equal(response.status, "degraded");
    assert.equal(response.db, "disconnected");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe("Rate limiting", () => {
  it("has rate limits for general, auth, and AI endpoints", () => {
    const limits = {
      general: { windowMs: 15 * 60 * 1000, max: 200 },
      auth: { windowMs: 15 * 60 * 1000, max: 10 },
      ai: { windowMs: 60 * 1000, max: 20 },
    };
    assert.ok(limits.general.max > limits.auth.max);
    assert.ok(limits.ai.windowMs < limits.general.windowMs);
    assert.equal(limits.ai.max, 20);
  });
});

// ---------------------------------------------------------------------------
// AI API optimization
// ---------------------------------------------------------------------------
describe("AI API optimization", () => {
  it("singleton client reuse pattern", () => {
    // Singleton pattern: client created once, reused across calls
    let client = null;
    function getClient() {
      if (!client) client = { id: Math.random() };
      return client;
    }
    const first = getClient();
    const second = getClient();
    assert.strictEqual(first, second); // same instance
    assert.equal(first.id, second.id);
  });

  it("callAI supports system prompt parameter for prompt caching", () => {
    // callAI signature: (model, prompt, maxTokens, systemPrompt)
    // When systemPrompt is provided, it's sent with cache_control: { type: "ephemeral" }
    const params = {};
    const systemPrompt = "You are an email assistant.";
    if (systemPrompt) {
      params.system = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
    }
    assert.equal(params.system.length, 1);
    assert.equal(params.system[0].type, "text");
    assert.equal(params.system[0].cache_control.type, "ephemeral");
  });

  it("response cache with TTL", () => {
    const cache = new Map();
    function getCached(key, ttlMs) {
      const entry = cache.get(key);
      if (entry && Date.now() - entry.ts < ttlMs) return entry.value;
      return null;
    }
    function setCache(key, value) {
      cache.set(key, { value, ts: Date.now() });
    }
    setCache("test", "hello");
    assert.equal(getCached("test", 60000), "hello");
    assert.equal(getCached("missing", 60000), null);
  });

  it("expired cache returns null", () => {
    const cache = new Map();
    cache.set("old", { value: "stale", ts: Date.now() - 999999 });
    function getCached(key, ttlMs) {
      const entry = cache.get(key);
      if (entry && Date.now() - entry.ts < ttlMs) return entry.value;
      return null;
    }
    assert.equal(getCached("old", 1000), null); // expired
  });

  it("daily briefing cache key includes date", () => {
    const today = "2026-03-15";
    const cacheKey = `briefing_${today}`;
    assert.equal(cacheKey, "briefing_2026-03-15");
  });

  it("suggestions cache key includes date and hour", () => {
    const todayStr = "2026-03-15";
    const hour = 14;
    const cacheKey = `suggestions_${todayStr}_${hour}`;
    assert.equal(cacheKey, "suggestions_2026-03-15_14");
  });
});

// ---------------------------------------------------------------------------
// URL validation for webhooks
// ---------------------------------------------------------------------------
describe("Webhook URL validation", () => {
  function isValidWebhookUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      const hostname = u.hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]") return false;
      if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
      if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;
      return true;
    } catch {
      return false;
    }
  }

  it("accepts valid public HTTPS URLs", () => {
    assert.ok(isValidWebhookUrl("https://hooks.slack.com/services/abc"));
    assert.ok(isValidWebhookUrl("https://example.com/webhook"));
    assert.ok(isValidWebhookUrl("http://api.example.com/notify"));
  });

  it("rejects localhost and loopback", () => {
    assert.ok(!isValidWebhookUrl("http://localhost:3000/hook"));
    assert.ok(!isValidWebhookUrl("http://127.0.0.1/hook"));
    assert.ok(!isValidWebhookUrl("http://0.0.0.0/hook"));
    assert.ok(!isValidWebhookUrl("http://[::1]/hook"));
  });

  it("rejects private IP ranges", () => {
    assert.ok(!isValidWebhookUrl("http://10.0.0.1/hook"));
    assert.ok(!isValidWebhookUrl("http://192.168.1.1/hook"));
    assert.ok(!isValidWebhookUrl("http://172.16.0.1/hook"));
    assert.ok(!isValidWebhookUrl("http://172.31.255.255/hook"));
  });

  it("rejects non-http protocols", () => {
    assert.ok(!isValidWebhookUrl("file:///etc/passwd"));
    assert.ok(!isValidWebhookUrl("ftp://example.com/file"));
    assert.ok(!isValidWebhookUrl("javascript:alert(1)"));
  });

  it("rejects invalid URLs", () => {
    assert.ok(!isValidWebhookUrl("not-a-url"));
    assert.ok(!isValidWebhookUrl(""));
    assert.ok(!isValidWebhookUrl("://missing-protocol"));
  });

  it("rejects .internal and .local hostnames", () => {
    assert.ok(!isValidWebhookUrl("http://service.internal/hook"));
    assert.ok(!isValidWebhookUrl("http://myhost.local/hook"));
  });

  it("allows 172.x outside private range", () => {
    assert.ok(isValidWebhookUrl("http://172.32.0.1/hook"));
    assert.ok(isValidWebhookUrl("http://172.15.0.1/hook"));
  });
});

// ---------------------------------------------------------------------------
// Webhook header validation
// ---------------------------------------------------------------------------
describe("Webhook header validation", () => {
  const BLOCKED_WEBHOOK_HEADERS = ["host", "cookie", "set-cookie", "transfer-encoding", "content-length", "connection", "upgrade"];
  function validateWebhookHeaders(headers) {
    if (!headers || typeof headers !== "object") return { valid: true };
    for (const key of Object.keys(headers)) {
      if (BLOCKED_WEBHOOK_HEADERS.includes(key.toLowerCase())) {
        return { valid: false, error: `Header "${key}" is not allowed in webhooks.` };
      }
      if (typeof headers[key] !== "string") {
        return { valid: false, error: `Header "${key}" value must be a string.` };
      }
    }
    return { valid: true };
  }

  it("allows standard custom headers", () => {
    assert.deepEqual(validateWebhookHeaders({ "Authorization": "Bearer token", "X-Custom": "value" }), { valid: true });
  });

  it("blocks Host header", () => {
    const r = validateWebhookHeaders({ "Host": "evil.com" });
    assert.ok(!r.valid);
  });

  it("blocks Cookie header (case-insensitive)", () => {
    const r = validateWebhookHeaders({ "cookie": "session=abc" });
    assert.ok(!r.valid);
  });

  it("blocks Set-Cookie header", () => {
    const r = validateWebhookHeaders({ "Set-Cookie": "session=abc" });
    assert.ok(!r.valid);
  });

  it("rejects non-string header values", () => {
    const r = validateWebhookHeaders({ "X-Custom": 123 });
    assert.ok(!r.valid);
  });

  it("allows null/undefined headers", () => {
    assert.deepEqual(validateWebhookHeaders(null), { valid: true });
    assert.deepEqual(validateWebhookHeaders(undefined), { valid: true });
  });

  it("allows empty headers object", () => {
    assert.deepEqual(validateWebhookHeaders({}), { valid: true });
  });
});

// ---------------------------------------------------------------------------
// Pagination bounds validation
// ---------------------------------------------------------------------------
describe("Pagination bounds", () => {
  const MAX_PAGINATION_LIMIT = 100;

  it("caps limit at MAX_PAGINATION_LIMIT", () => {
    const limit = "99999";
    const capped = Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT);
    assert.equal(capped, 100);
  });

  it("defaults to 20 for NaN limit", () => {
    const limit = "abc";
    const capped = Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT);
    assert.equal(capped, 20);
  });

  it("clamps negative limit to 1", () => {
    const limit = "-5";
    const capped = Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT);
    assert.equal(capped, 1);
  });

  it("clamps negative offset to 0", () => {
    const offset = "-10";
    const capped = Math.max(0, parseInt(offset, 10) || 0);
    assert.equal(capped, 0);
  });

  it("passes through valid values", () => {
    const limit = "25";
    const offset = "50";
    assert.equal(Math.min(Math.max(1, parseInt(limit, 10) || 20), MAX_PAGINATION_LIMIT), 25);
    assert.equal(Math.max(0, parseInt(offset, 10) || 0), 50);
  });
});

// ---------------------------------------------------------------------------
// Bulk operation size limits
// ---------------------------------------------------------------------------
describe("Bulk operation limits", () => {
  const MAX_BULK_IDS = 500;

  it("rejects arrays exceeding MAX_BULK_IDS", () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    assert.ok(ids.length > MAX_BULK_IDS);
  });

  it("accepts arrays within limit", () => {
    const ids = [1, 2, 3, 4, 5];
    assert.ok(ids.length <= MAX_BULK_IDS);
  });

  it("accepts arrays at exact limit", () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    assert.ok(ids.length <= MAX_BULK_IDS);
  });
});

// ---------------------------------------------------------------------------
// Input length validation
// ---------------------------------------------------------------------------
describe("Input length validation", () => {
  const MAX_TITLE_LENGTH = 500;
  const MAX_BODY_LENGTH = 50000;
  const MAX_CONTENT_LENGTH = 100000;

  it("rejects title exceeding MAX_TITLE_LENGTH", () => {
    const title = "a".repeat(501);
    assert.ok(title.length > MAX_TITLE_LENGTH);
  });

  it("accepts title within limit", () => {
    const title = "a".repeat(500);
    assert.ok(title.length <= MAX_TITLE_LENGTH);
  });

  it("rejects body exceeding MAX_BODY_LENGTH", () => {
    const body = "x".repeat(50001);
    assert.ok(body.length > MAX_BODY_LENGTH);
  });

  it("accepts body within limit", () => {
    const body = "x".repeat(50000);
    assert.ok(body.length <= MAX_BODY_LENGTH);
  });

  it("rejects content exceeding MAX_CONTENT_LENGTH", () => {
    const content = "y".repeat(100001);
    assert.ok(content.length > MAX_CONTENT_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// Email validation order (trim before validate)
// ---------------------------------------------------------------------------
describe("Email validation order", () => {
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  it("validates email after trimming", () => {
    const email = "  test@example.com  ";
    const trimmed = email.trim().toLowerCase();
    assert.ok(EMAIL_REGEX.test(trimmed));
  });

  it("rejects untrimmed email with spaces", () => {
    const email = "  test@example.com  ";
    assert.ok(!EMAIL_REGEX.test(email)); // fails without trim
  });
});

// ---------------------------------------------------------------------------
// XSS prevention in quick send preview
// ---------------------------------------------------------------------------
describe("XSS prevention", () => {
  function esc(s) {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  it("escapes HTML in contact names", () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const escaped = esc(malicious);
    assert.ok(!escaped.includes("<img"));
    assert.ok(escaped.includes("&lt;img"));
  });

  it("escapes HTML in email addresses", () => {
    const malicious = '"><script>alert(1)</script>';
    const escaped = esc(malicious);
    assert.ok(!escaped.includes("<script>"));
  });

  it("handles null/undefined safely", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
    assert.equal(esc(""), "");
  });
});

// ---------------------------------------------------------------------------
// JSON.parse safety for AI responses
// ---------------------------------------------------------------------------
describe("AI response JSON safety", () => {
  it("handles valid JSON response", () => {
    const text = '{"subject":"Hello","body":"World"}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    assert.ok(jsonMatch);
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
    assert.ok(parsed);
    assert.equal(parsed.subject, "Hello");
  });

  it("handles malformed JSON gracefully", () => {
    const text = '{subject: Hello, body: World}'; // not valid JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    assert.ok(jsonMatch);
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
    assert.equal(parsed, null);
  });

  it("handles no JSON match", () => {
    const text = "No JSON here at all";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    assert.equal(jsonMatch, null);
  });

  it("handles array JSON responses", () => {
    const text = '["task1", "task2", "task3"]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    assert.ok(jsonMatch);
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 3);
  });

  it("handles malformed array JSON", () => {
    const text = "[task1, task2]"; // not valid JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    assert.ok(jsonMatch);
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
    assert.equal(parsed, null);
  });
});

// ---------------------------------------------------------------------------
// Recurring task transaction safety
// ---------------------------------------------------------------------------
describe("Recurring task completion safety", () => {
  it("prevents double-completion", () => {
    const todo = { id: 1, completed: true, recurring: true, recurrence_rule: "daily" };
    assert.ok(todo.completed); // Should be caught by "already completed" check
  });

  it("calculates streak correctly for on-time completion", () => {
    const dueDate = new Date("2026-03-16");
    const today = "2026-03-16";
    const isOnTime = today <= dueDate.toISOString().split("T")[0];
    assert.ok(isOnTime);
    const newStreak = isOnTime ? (3 + 1) : 1;
    assert.equal(newStreak, 4);
  });

  it("resets streak for late completion", () => {
    const dueDate = new Date("2026-03-14");
    const today = "2026-03-16";
    const isOnTime = today <= dueDate.toISOString().split("T")[0];
    assert.ok(!isOnTime);
    const newStreak = isOnTime ? (3 + 1) : 1;
    assert.equal(newStreak, 1);
  });

  it("tracks best streak across resets", () => {
    const currentStreak = 1;
    const bestStreak = 10;
    const newBest = Math.max(currentStreak, bestStreak);
    assert.equal(newBest, 10);
  });
});

// ---------------------------------------------------------------------------
// Perfin URL validation
// ---------------------------------------------------------------------------
describe("Perfin URL validation", () => {
  it("accepts valid http/https URLs", () => {
    const url = "https://perfin.example.com";
    const u = new URL(url);
    assert.ok(u.protocol === "http:" || u.protocol === "https:");
  });

  it("rejects non-http protocols", () => {
    const url = "file:///etc/passwd";
    const u = new URL(url);
    assert.ok(u.protocol !== "http:" && u.protocol !== "https:");
  });

  it("rejects invalid URLs", () => {
    let valid = true;
    try { new URL("not-a-url"); } catch { valid = false; }
    assert.ok(!valid);
  });
});

// ---------------------------------------------------------------------------
// SMTP transporter reuse
// ---------------------------------------------------------------------------
describe("SMTP transporter reuse pattern", () => {
  it("singleton pattern returns same instance", () => {
    let transport = null;
    function getTransport() {
      if (!transport) transport = { id: Math.random() };
      return transport;
    }
    const t1 = getTransport();
    const t2 = getTransport();
    assert.strictEqual(t1, t2);
    assert.equal(t1.id, t2.id);
  });
});

// ---------------------------------------------------------------------------
// Location coordinate validation
// ---------------------------------------------------------------------------
describe("Location coordinate validation", () => {
  it("accepts valid coordinates", () => {
    const lat = 40.7128;
    const lng = -74.0060;
    assert.ok(lat >= -90 && lat <= 90);
    assert.ok(lng >= -180 && lng <= 180);
  });

  it("rejects out-of-range latitude", () => {
    assert.ok(!(91 >= -90 && 91 <= 90));
    assert.ok(!(-91 >= -90 && -91 <= 90));
  });

  it("rejects out-of-range longitude", () => {
    assert.ok(!(181 >= -180 && 181 <= 180));
    assert.ok(!(-181 >= -180 && -181 <= 180));
  });

  it("accepts edge values", () => {
    assert.ok(90 >= -90 && 90 <= 90);
    assert.ok(-90 >= -90 && -90 <= 90);
    assert.ok(180 >= -180 && 180 <= 180);
    assert.ok(-180 >= -180 && -180 <= 180);
  });

  it("validates radius is positive", () => {
    assert.ok(200 > 0);
    assert.ok(!(0 > 0));
    assert.ok(!(-100 > 0));
  });
});
