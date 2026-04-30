const { pageHead, navBar, themeScript } = require("../views");
const SETTINGS_JS = require("./settings-script");

module.exports = function(AUTH_SECRET) {
  return (req, res) => {
    res.send(`${pageHead("Settings")}
<body>
${themeScript()}
${navBar("/settings")}
<div class="container">
  <h1>Settings</h1>
  <p class="subtitle">Configure your personal assistant.</p>

  <div id="status" class="status-msg"></div>

  <div class="section">
    <h2>Appearance</h2>
    <div style="display:flex;gap:12px;align-items:center;">
      <label style="margin:0;">Theme</label>
      <select id="s-theme" style="width:auto;">
        <option value="dark">Night Mode</option>
        <option value="light">Day Mode</option>
        <option value="auto">Auto (System)</option>
      </select>
    </div>
    <!-- Palette picker is injected here by views/settings-patch.js -->
  </div>

  <div class="section">
    <h2>Session</h2>
    <div style="display:flex;gap:12px;align-items:center;">
      <label style="margin:0;">Timeout (minutes)</label>
      <input type="number" id="s-timeout" min="1" max="1440" style="width:100px;">
      <button class="btn primary" id="save-timeout-btn">Save</button>
    </div>
  </div>

  <div class="section">
    <h2>Default Task Horizon</h2>
    <select id="s-horizon" style="width:auto;">
      <option value="short">Short-term</option>
      <option value="medium">Medium-term</option>
      <option value="long">Long-term</option>
    </select>
  </div>

  <div class="section">
    <h2>Perfin Integration</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Link to your Perfin (personal finance tracker) instance.</p>
    <div style="display:flex;gap:12px;align-items:center;">
      <input type="url" id="s-perfin" placeholder="https://your-perfin-instance.onrender.com" style="flex:1;">
      <button class="btn primary" id="save-perfin-btn">Save</button>
    </div>
  </div>

  <div class="section">
    <h2>AI Features</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px;" id="ai-status"></p>
    <div id="ai-models-section" style="display:none;">
      <p style="font-size:11px;color:var(--muted);margin-bottom:16px;">Choose a model for each AI feature. Sonnet is smarter but ~5× more expensive than Haiku. Set to Off to disable.</p>
      <div style="display:grid;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Email Drafting</div><div style="font-size:10px;color:var(--muted);">AI-compose emails from a prompt</div></div>
          <select id="aim-email_draft" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Task Breakdown</div><div style="font-size:10px;color:var(--muted);">Auto-generate subtasks from task title</div></div>
          <select id="aim-task_breakdown" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Smart Quick Add</div><div style="font-size:10px;color:var(--muted);">AI-parse natural language into structured tasks</div></div>
          <select id="aim-quick_add" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Weekly Review Summary</div><div style="font-size:10px;color:var(--muted);">AI-written narrative of your week</div></div>
          <select id="aim-review_summary" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Email Tone Adjustment</div><div style="font-size:10px;color:var(--muted);">Rewrite emails in different tones</div></div>
          <select id="aim-email_tone" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
          <div><div style="font-size:13px;">Daily Briefing</div><div style="font-size:10px;color:var(--muted);">AI summary of your day on the dashboard</div></div>
          <select id="aim-daily_briefing" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;">
          <div><div style="font-size:13px;">Note Auto-Tagging</div><div style="font-size:10px;color:var(--muted);">Suggest tags when creating notes</div></div>
          <select id="aim-note_tagging" class="aim-select" style="width:120px;"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="off">Off</option></select>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Email (SMTP)</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:8px;" id="smtp-status"></p>
  </div>

  <div class="section">
    <h2>Browser Notifications</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Get notified about reminders and overdue tasks.</p>
    <div class="actions" style="margin-bottom:0;">
      <button class="btn" id="notif-btn">Enable Notifications</button>
    </div>
  </div>

  <div class="section">
    <h2>Keyboard Shortcuts</h2>
    <div style="font-size:12px;color:var(--muted);line-height:2;">
      <span class="kbd">/</span> Focus search &middot;
      <span class="kbd">N</span> New task &middot;
      <span class="kbd">E</span> New email &middot;
      <span class="kbd">C</span> Calendar &middot;
      <span class="kbd">R</span> Weekly review &middot;
      <span class="kbd">Q</span> Quick add (on todos page) &middot;
      <span class="kbd">Esc</span> Close modals
    </div>
  </div>

  <div class="section">
    <h2>Data Export</h2>
    <div class="actions" style="margin-bottom:0;">
      <button class="btn" data-export="todos">Export Todos</button>
      <button class="btn" data-export="emails">Export Emails</button>
      <button class="btn" data-export="notes">Export Notes</button>
      <button class="btn" data-export="contacts">Export Contacts</button>
    </div>
  </div>

  <div class="section">
    <h2>Trash</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:8px;">Deleted items are kept for 30 days before permanent removal.</p>
    <div id="trash-list" style="margin-bottom:10px;"></div>
    <div class="actions" style="margin-bottom:0;">
      <button class="btn" id="view-trash-btn">View Trash</button>
      <button class="btn danger" id="empty-trash-btn">Empty Trash</button>
    </div>
  </div>

  <div class="section">
    <h2>Automations</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Create rules that trigger actions automatically when events occur.</p>
    <div id="automations-list" style="margin-bottom:12px;"></div>
    <button class="btn primary" id="new-auto-btn">+ New Rule</button>
  </div>

  <div class="section">
    <h2>Webhooks</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Configure external webhook endpoints to receive event notifications.</p>
    <div id="webhooks-list" style="margin-bottom:12px;"></div>
    <button class="btn primary" id="new-webhook-btn">+ New Webhook</button>
  </div>

  <div class="section">
    <h2>Slack Integration</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Add a Slack Incoming Webhook URL to receive notifications in Slack.</p>
    <div style="display:flex;gap:12px;align-items:center;">
      <input type="url" id="s-slack" placeholder="https://hooks.slack.com/services/..." style="flex:1;">
      <button class="btn primary" id="save-slack-btn">Save</button>
    </div>
  </div>

  <div class="section">
    <h2>Keep-Alive (Render)</h2>
    <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">Prevent Render free tier from sleeping by pinging the server every 14 minutes during active hours.</p>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <label style="margin:0;white-space:nowrap;">Enable</label>
        <input type="checkbox" id="ka-enabled" style="width:auto;">
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <label style="margin:0;white-space:nowrap;">Active from</label>
        <select id="ka-start" style="width:auto;"></select>
        <label style="margin:0;white-space:nowrap;">to</label>
        <select id="ka-end" style="width:auto;"></select>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <label style="margin:0;white-space:nowrap;">Timezone</label>
        <select id="ka-tz" style="width:auto;">
          <option value="America/New_York">Eastern (ET)</option>
          <option value="America/Chicago">Central (CT)</option>
          <option value="America/Denver">Mountain (MT)</option>
          <option value="America/Los_Angeles">Pacific (PT)</option>
          <option value="America/Anchorage">Alaska (AKT)</option>
          <option value="Pacific/Honolulu">Hawaii (HT)</option>
          <option value="Europe/London">London (GMT/BST)</option>
          <option value="Europe/Berlin">Berlin (CET)</option>
          <option value="Asia/Tokyo">Tokyo (JST)</option>
          <option value="Asia/Kolkata">India (IST)</option>
          <option value="Australia/Sydney">Sydney (AEST)</option>
          <option value="UTC">UTC</option>
        </select>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <button class="btn primary" id="save-keepalive-btn">Save</button>
        <span id="ka-estimate" style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:0.04em;"></span>
      </div>
    </div>
  </div>

  ${AUTH_SECRET ? '<div class="section"><h2>Session</h2><div class="actions" style="margin-bottom:0;"><button class="btn danger" id="logout-btn">Log Out</button></div></div>' : ''}
</div>

<!-- Automation Modal -->
<div class="modal-overlay" id="auto-modal">
  <div class="modal">
    <h2 id="auto-modal-title">New Automation</h2>
    <input type="hidden" id="auto-id">
    <label>Name</label>
    <input type="text" id="auto-name" placeholder="e.g. Auto-prioritize work tasks">
    <label>When (Trigger)</label>
    <select id="auto-trigger" style="width:100%;">
      <option value="todo_created">Task Created</option>
      <option value="todo_completed">Task Completed</option>
      <option value="email_created">Email Created</option>
      <option value="note_created">Note Created</option>
    </select>
    <label>If (Condition — optional)</label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <select id="auto-cond-field">
        <option value="">Any</option>
        <option value="category">Category equals</option>
        <option value="priority">Priority equals</option>
        <option value="title_contains">Title contains</option>
        <option value="horizon">Horizon equals</option>
      </select>
      <input type="text" id="auto-cond-value" placeholder="Value…">
    </div>
    <label>Then (Action)</label>
    <select id="auto-action" style="width:100%;">
      <option value="set_priority">Set Priority</option>
      <option value="set_category">Set Category</option>
      <option value="set_horizon">Set Horizon</option>
      <option value="add_tag">Add Tag (notes)</option>
      <option value="create_todo">Create Follow-up Task</option>
    </select>
    <label>Action Value</label>
    <input type="text" id="auto-action-value" placeholder="e.g. urgent, work, short…">
    <div class="modal-actions">
      <button class="btn" id="auto-cancel-btn">Cancel</button>
      <button class="btn primary" id="auto-save-btn">Save</button>
      <button class="btn danger" id="auto-delete-btn" style="display:none">Delete</button>
    </div>
  </div>
</div>

<!-- Webhook Modal -->
<div class="modal-overlay" id="webhook-modal">
  <div class="modal">
    <h2 id="wh-modal-title">New Webhook</h2>
    <input type="hidden" id="wh-id">
    <label>Name</label>
    <input type="text" id="wh-name" placeholder="e.g. Slack notifications, Zapier">
    <label>URL</label>
    <input type="url" id="wh-url" placeholder="https://example.com/webhook">
    <label>Events</label>
    <div id="wh-events" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
      <label style="display:inline;font-size:11px;cursor:pointer;"><input type="checkbox" value="todo_created" style="width:auto;margin-right:4px;">Task Created</label>
      <label style="display:inline;font-size:11px;cursor:pointer;"><input type="checkbox" value="todo_completed" style="width:auto;margin-right:4px;">Task Completed</label>
      <label style="display:inline;font-size:11px;cursor:pointer;"><input type="checkbox" value="email_sent" style="width:auto;margin-right:4px;">Email Sent</label>
      <label style="display:inline;font-size:11px;cursor:pointer;"><input type="checkbox" value="note_created" style="width:auto;margin-right:4px;">Note Created</label>
      <label style="display:inline;font-size:11px;cursor:pointer;"><input type="checkbox" value="streak_milestone" style="width:auto;margin-right:4px;">Streak Milestone</label>
    </div>
    <div class="modal-actions">
      <button class="btn" id="wh-cancel-btn">Cancel</button>
      <button class="btn primary" id="wh-save-btn">Save</button>
      <button class="btn danger" id="wh-delete-btn" style="display:none">Delete</button>
    </div>
  </div>
</div>

<script>${SETTINGS_JS}</script>
</body></html>`);
  };
};
