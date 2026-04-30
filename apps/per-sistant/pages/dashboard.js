const { pageHead, navBar, themeScript } = require("../views");
const DASHBOARD_JS = require("./dashboard-script");

module.exports = function() {
  return (req, res) => {
    res.send(`${pageHead("Dashboard")}
<body>
${themeScript()}
${navBar("/")}
<div class="container">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
    <div>
      <h1>Dashboard</h1>
      <p class="subtitle" style="margin-bottom:0;">Your personal command center.</p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="customize-btn" class="btn">Customize</button>
    </div>
  </div>
  <div style="margin-bottom:28px;"></div>

  <!-- Customization panel -->
  <div id="customize-panel" class="section" style="display:none;margin-bottom:20px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <span class="mono-label">Widget visibility &amp; order</span>
      <button id="reset-layout-btn" class="btn">Reset</button>
    </div>
    <div id="widget-toggles" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    <div style="margin-top:10px;font-size:11px;color:var(--muted);">Drag widgets below to reorder. Click toggles above to show/hide.</div>
  </div>

  <div id="dash-widgets">
    <!-- Search -->
    <div class="dash-widget" data-widget="search" draggable="true">
      <div class="search-bar">
        <span class="search-icon">&#128269;</span>
        <input type="text" id="global-search" placeholder="Search todos, emails, notes, contacts… (press /)">
      </div>
      <div class="section search-results" id="search-results" style="display:none;margin-bottom:20px;"></div>
    </div>

    <!-- Stats cards -->
    <div class="dash-widget" data-widget="cards" draggable="true">
      <div class="top-cards" id="cards"></div>
    </div>

    <!-- AI Daily Briefing -->
    <div class="dash-widget" data-widget="briefing" draggable="true">
      <div id="briefing-section" style="display:none;margin-bottom:20px;">
        <div class="section">
          <h2>Today's briefing</h2>
          <div id="briefing-content" style="font-size:14px;line-height:1.7;color:var(--ink);"></div>
        </div>
      </div>
    </div>

    <!-- AI Smart Suggestions -->
    <div class="dash-widget" data-widget="suggestions" draggable="true">
      <div id="suggestions-section" style="display:none;margin-bottom:20px;">
        <div class="section">
          <h2>Smart suggestions</h2>
          <div id="suggestions-content"></div>
        </div>
      </div>
    </div>

    <!-- AI Natural Language Query -->
    <div class="dash-widget" data-widget="ai_query" draggable="true">
      <div class="section" style="margin-bottom:20px;">
        <h2>Ask your assistant</h2>
        <div style="display:flex;gap:8px;">
          <input type="text" id="ai-query-input" placeholder="Ask anything — what did I do last week? How many tasks are overdue?" style="flex:1;">
          <button id="ask-ai-btn" class="btn primary">Ask</button>
        </div>
        <div id="ai-query-answer" style="display:none;margin-top:12px;padding:12px 14px;background:var(--paper-2);border:1px solid var(--line);border-radius:var(--radius);font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--ink);"></div>
      </div>
    </div>

    <!-- Task Overview -->
    <div class="dash-widget" data-widget="tasks" draggable="true">
      <div class="section" style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <h2 style="margin-bottom:0;">Task overview</h2>
        </div>
        <div class="filters" id="dash-task-filters">
          <button class="active" data-view="all">All</button>
          <button data-view="category">By Category</button>
          <button data-view="urgency">By Urgency</button>
          <button data-view="due">Due Soon</button>
        </div>
        <div id="dash-tasks" style="margin-top:12px;"></div>
      </div>
    </div>

    <!-- Upcoming + Emails -->
    <div class="dash-widget" data-widget="upcoming_emails" draggable="true">
      <div class="dash-two-col" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
        <div class="section" style="margin-bottom:0;">
          <h2>Upcoming tasks</h2>
          <div id="upcoming-tasks"></div>
        </div>
        <div class="section" style="margin-bottom:0;">
          <h2>Scheduled emails</h2>
          <div id="scheduled-emails"></div>
        </div>
      </div>
    </div>

    <!-- Mini Calendar -->
    <div class="dash-widget" data-widget="mini_cal" draggable="true">
      <div class="section" style="margin-bottom:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <h2 style="margin-bottom:0;">Calendar</h2>
          <a href="/calendar" class="mono-label" style="color:var(--muted);">Full view &rarr;</a>
        </div>
        <div id="mini-cal-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <button id="mini-cal-prev" class="btn" style="padding:4px 10px;">&larr;</button>
          <span id="mini-cal-title" class="mono-label" style="color:var(--ink);"></span>
          <button id="mini-cal-next" class="btn" style="padding:4px 10px;">&rarr;</button>
        </div>
        <div id="mini-cal-grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:11px;"></div>
        <div id="mini-cal-events" style="margin-top:12px;max-height:120px;overflow-y:auto;"></div>
      </div>
    </div>

    <!-- Perfin -->
    <div class="dash-widget" data-widget="perfin" draggable="true">
      <div id="perfin-section" style="display:none;margin-bottom:20px;">
        <div class="section">
          <h2>Perfin — financial overview</h2>
          <div id="perfin-data"></div>
        </div>
      </div>
    </div>

    <!-- Shortcuts -->
    <div class="dash-widget" data-widget="shortcuts" draggable="true">
      <div style="margin-top:16px;text-align:center;">
        <p style="font-size:11px;color:var(--muted);font-family:var(--mono);letter-spacing:0.04em;">Shortcuts: <span class="kbd">/</span> Search &middot; <span class="kbd">N</span> New task &middot; <span class="kbd">E</span> New email &middot; <span class="kbd">C</span> Calendar &middot; <span class="kbd">R</span> Review</p>
      </div>
    </div>
  </div>
</div>
<script>${DASHBOARD_JS}</script>
</body></html>`);
  };
};
