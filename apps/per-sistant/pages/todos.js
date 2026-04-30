const { pageHead, navBar, themeScript } = require("../views");
const TODOS_JS = require("./todos-script-1") + require("./todos-script-2");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("To-Dos")}
<body>
${themeScript()}
${navBar("/todos")}
<div class="container">
  <h1>To-Dos</h1>
  <p class="subtitle">Short, medium, and long-term task management.</p>

  <div class="actions">
    <button class="btn primary" id="add-task-btn">+ New Task</button>
    <button class="btn" id="quick-add-btn">Quick Add</button>
    <button class="btn" id="template-btn">From Template</button>
    <button class="btn" id="select-toggle">Select</button>
  </div>
  <div id="bulk-bar" class="section" style="display:none;padding:10px 14px;margin-bottom:14px;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;">
    <span id="bulk-count" class="mono-label">0 selected</span>
    <button class="btn" id="bulk-complete-btn">Complete</button>
    <button class="btn danger" id="bulk-delete-btn">Delete</button>
    <select id="bulk-priority">
      <option value="">Set Priority...</option><option value="urgent">Urgent</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
    </select>
    <button class="btn" id="select-all-btn" style="margin-left:auto;">Select All</button>
  </div>

  <div class="filter-bar" style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;align-items:center;">
    <select id="filter-horizon">
      <option value="">All Horizons</option>
      <option value="short">Short-term</option>
      <option value="medium">Medium-term</option>
      <option value="long">Long-term</option>
    </select>
    <select id="filter-status">
      <option value="pending">Pending</option>
      <option value="all">All Status</option>
      <option value="done">Completed</option>
    </select>
    <select id="filter-priority">
      <option value="">Any Priority</option>
      <option value="urgent">Urgent</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
    <select id="filter-category">
      <option value="">All Categories</option>
    </select>
  </div>

  <div class="section">
    <div id="todo-list"></div>
  </div>
</div>

<!-- Add/Edit Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <h2 id="modal-title" style="margin-bottom:0;">New Task</h2>
      <button id="modal-close-x" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;font-family:inherit;" aria-label="Close">&times;</button>
    </div>
    <input type="hidden" id="edit-id">
    <label>Title</label>
    <input type="text" id="f-title" placeholder="What needs to be done?">
    <label>Description</label>
    <textarea id="f-desc" placeholder="Optional details…"></textarea>
    <div class="mobile-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div><label>Priority</label>
        <select id="f-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select>
      </div>
      <div><label>Horizon</label>
        <select id="f-horizon"><option value="short">Short-term</option><option value="medium">Medium-term</option><option value="long">Long-term</option></select>
      </div>
    </div>
    <div class="mobile-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div><label>Category</label>
        <select id="f-category-select">
          <option value="">None</option>
          <option value="__custom__">Custom...</option>
        </select>
        <input type="text" id="f-category-custom" placeholder="Type custom category" style="display:none;margin-top:6px;">
      </div>
      <div><label>Due Date</label>
        <input type="date" id="f-due"></div>
    </div>
    <div class="mobile-form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
      <div style="margin-top:12px;">
        <label style="display:inline;cursor:pointer">
          <input type="checkbox" id="f-recurring" style="width:auto;margin-right:6px;"> Recurring task
        </label>
      </div>
      <div id="f-recurrence" style="display:none;">
        <label>Repeat</label>
        <select id="f-recurrence-rule">
          <option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option>
          <option value="custom_days">Every N Days</option><option value="custom_weeks">Every N Weeks</option><option value="custom_months">Every N Months</option>
        </select>
        <div id="f-interval-row" style="display:none;gap:8px;align-items:center;margin-top:6px;">
          <label style="margin:0;font-size:11px;white-space:nowrap;">Every</label>
          <input type="number" id="f-interval" min="1" max="365" value="2" style="width:60px;font-size:12px;">
          <span id="f-interval-unit" style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:0.04em;">days</span>
        </div>
      </div>
    </div>
    <div id="subtasks-section" style="display:none;margin-top:14px;">
      <label>Subtasks <button class="btn" id="ai-breakdown-btn" style="float:right;">AI Breakdown</button></label>
      <div id="subtask-list-edit"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input type="text" id="new-subtask" placeholder="Add subtask…" style="flex:1">
        <button class="btn primary" id="add-subtask-btn">Add</button>
      </div>
    </div>
    <!-- Location reminder (edit mode only) -->
    <div id="location-section" style="display:none;margin-top:14px;">
      <label>Location Reminder</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" id="f-location-name" placeholder="e.g. Home, Office, Grocery Store" style="flex:1">
        <button class="btn" id="get-location-btn" title="Use current location">&#128205;</button>
      </div>
      <div class="mobile-form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">
        <input type="number" step="any" id="f-location-lat" placeholder="Latitude" style="font-size:11px;">
        <input type="number" step="any" id="f-location-lng" placeholder="Longitude" style="font-size:11px;">
        <input type="number" id="f-location-radius" placeholder="Radius (m)" value="200" style="font-size:11px;">
      </div>
      <div id="location-status" style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:6px;letter-spacing:0.08em;"></div>
    </div>
    <!-- Dependencies section (edit mode only) -->
    <div id="deps-section" style="display:none;margin-top:14px;">
      <label>Dependencies</label>
      <div id="deps-list" style="margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;">
        <select id="dep-select" style="flex:1"><option value="">Select a task this depends on…</option></select>
        <button class="btn primary" id="add-dep-btn">Add</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="cancel-modal-btn">Cancel</button>
      <button class="btn primary" id="save-todo-btn">Save</button>
      <button class="btn" id="save-template-btn" style="display:none;">Save as Template</button>
      <button class="btn danger" id="delete-btn" style="display:none">Delete</button>
    </div>
  </div>
</div>

<!-- Template List Modal -->
<div class="modal-overlay" id="template-modal">
  <div class="modal">
    <h2>Task Templates</h2>
    <div id="template-list" style="margin-bottom:14px;"></div>
    <div class="modal-actions">
      <button class="btn" id="close-template-btn">Close</button>
    </div>
  </div>
</div>

<!-- Quick Add Modal (natural language) -->
<div class="modal-overlay" id="quick-todo-modal">
  <div class="modal">
    <h2>Quick Add Task</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:14px;">
      Examples: "Buy groceries tomorrow" &middot; "Call dentist Friday at 2PM" &middot; "Finish report by March 20"
    </p>
    <label>What needs to be done?</label>
    <div style="display:flex;gap:8px;">
      <input type="text" id="qt-input" placeholder="Type or speak a task…" style="flex:1">
      <button class="btn" id="qt-voice-btn" title="Voice input">&#127908;</button>
    </div>
    <div id="qt-preview" style="display:none;margin-top:14px;" class="section">
      <h2>Preview</h2>
      <div id="qt-preview-content"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="qt-cancel-btn">Cancel</button>
      <button class="btn primary" id="qt-parse-btn">Parse</button>
      <button class="btn primary" id="qt-confirm" style="display:none">Create</button>
    </div>
  </div>
</div>

<script>${TODOS_JS}</script>
</body></html>`);
  };
};
