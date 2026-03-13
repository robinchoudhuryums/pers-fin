const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
// ---------------------------------------------------------------------------
// GET /settings — settings page
// ---------------------------------------------------------------------------
router.get("/settings", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settings — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#080b12">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/perfin-shared.css">
  <style>
    .container { max-width: 640px; }
    .insight-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; margin-top: 12px; backdrop-filter: blur(12px); }
    .insight-card h3 { font-size: 14px; font-weight: 400; margin-bottom: 10px; }
    .insight-text { font-size: 13px; line-height: 1.7; color: var(--text-muted); font-weight: 300; }
    .insight-text strong { color: var(--text); font-weight: 500; }
    .insight-text li { margin-left: 16px; margin-bottom: 6px; }
    .insight-meta { font-size: 11px; color: var(--text-muted); margin-top: 10px; }
    select, input[type="number"] { padding: 8px 12px; font-size: 13px; border: 1px solid var(--border);
      border-radius: 8px; background: transparent; color: var(--text); font-family: inherit; font-weight: 300; }
    select:focus, input[type="number"]:focus { outline: none; border-color: var(--warm); }
    select option { background: var(--bg); }
    input[type="number"] { width: 80px; text-align: center; }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head><body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/goals">Goals</a>
      <a href="/budgets">Budgets</a>
      <a href="/">Accounts</a>
      <a href="/settings" class="active">Settings</a>
    </div>
  </nav>
  <h1>Settings</h1>
  <p class="subtitle">Preferences and configuration</p>
  <div id="status-msg" class="status-msg"></div>

  <div class="section"><h2>Appearance</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Theme</div><div class="desc">Switch between dark (night) and light (day) mode</div></div>
      <div class="setting-control">
        <select id="theme-select" onchange="updateSetting('theme', this.value)">
          <option value="dark">Night Mode</option><option value="light">Day Mode</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Dashboard Range</div><div class="desc">Months of spending shown in charts</div></div>
      <div class="setting-control">
        <select id="months-select" onchange="updateSetting('dashboard_months', parseInt(this.value))">
          <option value="3">3 months</option><option value="6">6 months</option>
          <option value="12">12 months</option><option value="24">24 months</option>
        </select>
      </div>
    </div>
  </div>

  <div class="section"><h2>Security</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Session Timeout</div><div class="desc">Minutes before requiring password again (1–1440)</div></div>
      <div class="setting-control">
        <input type="number" id="timeout-input" min="1" max="1440" value="15"
               onchange="updateSetting('session_timeout_minutes', parseInt(this.value))">
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Sign Out</div><div class="desc">End your current session</div></div>
      <div class="setting-control"><button class="btn danger" onclick="logout()">Sign Out</button></div>
    </div>
  </div>

  <div class="section"><h2>AI Insights</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">API Status</div><div class="desc" id="api-status-desc">Checking...</div></div>
      <div class="setting-control"><span id="api-status-badge" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;letter-spacing:0.5px;text-transform:uppercase;">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Monthly AI Analysis</div><div class="desc">Financial insights powered by Claude (~$0.02/month)</div></div>
      <div class="setting-control">
        <label class="toggle"><input type="checkbox" id="insights-toggle" onchange="updateSetting('insights_enabled', this.checked)"><span class="slider"></span></label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Generate Now</div><div class="desc">Run AI analysis on current data</div></div>
      <div class="setting-control"><button class="btn primary" id="insights-btn" onclick="generateInsights()">Generate</button></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">AI Model</div><div class="desc">Haiku (~$0.005/run), Sonnet (~$0.02/run), Opus (~$0.10/run). Always uses latest version.</div></div>
      <div class="setting-control">
        <select id="model-select" onchange="updateSetting('insights_model', this.value)">
          <option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Analysis Cadence</div><div class="desc" id="cadence-desc">How often automated analysis runs. More frequent = finer trend tracking.</div></div>
      <div class="setting-control">
        <select id="cadence-select" onchange="updateSetting('insights_cadence_days', parseInt(this.value))">
          <option value="7">Weekly</option><option value="14">Every 2 weeks</option>
          <option value="30">Monthly</option><option value="60">Every 2 months</option>
          <option value="90">Quarterly</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">ZIP Code</div><div class="desc">For regional rate comparisons (utility costs vs your area's average)</div></div>
      <div class="setting-control">
        <input type="text" id="zip-input" maxlength="5" placeholder="e.g. 10001" style="width:80px;padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font-family:inherit;text-align:center;"
               onchange="updateSetting('zip_code', this.value)">
      </div>
    </div>
    <div class="setting-row" style="flex-direction:column;align-items:stretch;">
      <div class="setting-info" style="margin-bottom:12px;"><div class="name">Insight Modules</div><div class="desc">Toggle analysis features. Each adds a small amount of context to the AI prompt.</div></div>
      <div id="modules-container" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Monthly Budget Cap</div><div class="desc" id="budget-desc">Limits API spending per month (set via INSIGHTS_MONTHLY_BUDGET_CENTS env var)</div></div>
      <div class="setting-control"><span id="budget-status" style="font-size:12px;color:var(--text-muted);">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Long-Term Memory</div><div class="desc" id="memory-desc">AI maintains a cumulative summary across analyses for context continuity</div></div>
      <div class="setting-control"><span id="memory-status" style="font-size:12px;color:var(--text-muted);">--</span></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Reset AI Context</div><div class="desc">Clear long-term memory — next analysis starts fresh with no prior context</div></div>
      <div class="setting-control"><button class="btn danger" id="reset-btn" onclick="resetContext()">Reset</button></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Rebuild AI Context</div><div class="desc">Regenerate long-term memory by re-reading all historical analyses</div></div>
      <div class="setting-control"><button class="btn primary" id="rebuild-btn" onclick="rebuildContext()">Rebuild</button></div>
    </div>
  </div>

  <div id="insights-container"></div>

  <div class="section"><h2>API Usage History</h2>
    <div id="usage-summary" style="padding:10px 0;font-size:13px;color:var(--text-muted);font-weight:300;">Loading...</div>
    <div id="usage-history" style="max-height:260px;overflow-y:auto;"></div>
  </div>

  <div class="section"><h2>Keep-Alive</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Self-Ping</div><div class="desc">Prevents Render free tier from sleeping during active hours (pings every 14 min)</div></div>
      <div class="setting-control">
        <label class="toggle"><input type="checkbox" id="keepalive-toggle" onchange="updateSetting('keep_alive_enabled', this.checked)"><span class="slider"></span></label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Active Hours</div><div class="desc" id="keepalive-hours-desc">Hours when keep-alive runs (saves Render free tier hours)</div></div>
      <div class="setting-control" style="display:flex;gap:6px;align-items:center;">
        <select id="keepalive-start" onchange="updateSetting('keep_alive_start', parseInt(this.value))">
        </select>
        <span style="color:var(--text-muted);font-size:12px;">to</span>
        <select id="keepalive-end" onchange="updateSetting('keep_alive_end', parseInt(this.value))">
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Timezone</div><div class="desc">Your local timezone for active hour scheduling</div></div>
      <div class="setting-control">
        <select id="keepalive-tz" onchange="updateSetting('keep_alive_timezone', this.value)">
          <option value="America/New_York">Eastern (ET)</option>
          <option value="America/Chicago">Central (CT)</option>
          <option value="America/Denver">Mountain (MT)</option>
          <option value="America/Los_Angeles">Pacific (PT)</option>
          <option value="America/Anchorage">Alaska (AKT)</option>
          <option value="Pacific/Honolulu">Hawaii (HT)</option>
          <option value="Europe/London">London (GMT/BST)</option>
          <option value="Europe/Berlin">Central Europe (CET)</option>
          <option value="Asia/Tokyo">Tokyo (JST)</option>
          <option value="UTC">UTC</option>
        </select>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Monthly Hours Estimate</div><div class="desc">Estimated Render hours this app will use per month</div></div>
      <div class="setting-control"><span id="keepalive-estimate" style="font-size:12px;color:var(--text-muted);">--</span></div>
    </div>
  </div>

  <div class="section"><h2>Data</h2>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Export Transactions</div><div class="desc">Download as CSV</div></div>
      <div class="setting-control"><a href="/api/export?type=transactions&api_key=${apiKey}"><button class="btn">Export</button></a></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Export Subscriptions</div><div class="desc">Download as CSV</div></div>
      <div class="setting-control"><a href="/api/export?type=subscriptions&api_key=${apiKey}"><button class="btn">Export</button></a></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Export for Claude Chat</div><div class="desc">Download a structured data summary to paste into a Claude conversation for deep-dive analysis</div></div>
      <div class="setting-control"><a href="/api/context-export?api_key=${apiKey}" download><button class="btn primary">Export Context</button></a></div>
    </div>
    <div class="setting-row">
      <div class="setting-info"><div class="name">Save Net Worth Snapshot</div><div class="desc">Record today's net worth from current account balances</div></div>
      <div class="setting-control"><button class="btn" id="snapshot-btn" onclick="saveSnapshot()">Snapshot</button></div>
    </div>
  </div>
  </div>
  <script src="/perfin-shared.js"></script>
  <script>
    window.PERFIN_API_KEY = '${apiKey}';
    function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('perfin-theme', t); }
    async function loadSettings() {
      try {
        const res = await apiFetch('/api/settings'); if (!res.ok) return;
        const s = await res.json();
        document.getElementById('theme-select').value = s.theme || 'dark';
        document.getElementById('months-select').value = s.dashboard_months || 6;
        document.getElementById('timeout-input').value = s.session_timeout_minutes || 15;
        document.getElementById('insights-toggle').checked = s.insights_enabled || false;
        document.getElementById('model-select').value = s.insights_model || 'sonnet';
        document.getElementById('cadence-select').value = s.insights_cadence_days || 30;
        document.getElementById('keepalive-toggle').checked = s.keep_alive_enabled || false;
        document.getElementById('keepalive-start').value = s.keep_alive_start != null ? s.keep_alive_start : 6;
        document.getElementById('keepalive-end').value = s.keep_alive_end != null ? s.keep_alive_end : 0;
        document.getElementById('keepalive-tz').value = s.keep_alive_timezone || 'America/New_York';
        updateKeepAliveEstimate();
        document.getElementById('zip-input').value = s.zip_code || '';
        // Render insight module toggles
        const mods = s.insight_modules || {};
        const avail = s.available_modules || {};
        const mc = document.getElementById('modules-container');
        if (mc && Object.keys(avail).length > 0) {
          mc.innerHTML = Object.entries(avail).map(function(e) {
            var key = e[0], mod = e[1];
            var checked = mods[key] !== false ? 'checked' : '';
            var needs = mod.requires_zip ? (s.zip_code ? '' : ' (needs ZIP)') : '';
            return '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;transition:border-color 0.2s;" onmouseenter="this.style.borderColor=\\'var(--border-hover)\\';" onmouseleave="this.style.borderColor=\\'var(--border)\\';">' +
              '<input type="checkbox" ' + checked + ' onchange="toggleModule(\\'' + esc(key) + '\\', this.checked)" style="margin-top:2px;">' +
              '<span><span style="font-weight:400;">' + esc(mod.label) + '</span>' + needs +
              '<br><span style="color:var(--text-muted);font-weight:300;font-size:11px;">' + esc(mod.description) +
              ' (~+' + parseInt(mod.extra_tokens) + ' tokens)</span></span></label>';
          }).join('');
        }
        applyTheme(s.theme || 'dark');
        // Show memory status
        const memEl = document.getElementById('memory-status');
        if (memEl) {
          if (s.insights_running_summary) {
            memEl.innerHTML = '<span style="color:var(--green);">Active</span> (' + s.insights_running_summary.split(/\s+/).length + ' words)';
          } else {
            memEl.textContent = 'Not yet initialized — runs after first analysis';
          }
        }
      } catch {}
      // Check AI API status
      try {
        const sRes = await apiFetch('/api/insights/status');
        const st = await sRes.json();
        const badge = document.getElementById('api-status-badge');
        const desc = document.getElementById('api-status-desc');
        const budgetEl = document.getElementById('budget-status');
        if (st.configured) {
          badge.textContent = 'Active';
          badge.style.background = 'var(--green-bg)'; badge.style.color = 'var(--green)';
          desc.textContent = 'ANTHROPIC_API_KEY is configured and ready';
          if (budgetEl) budgetEl.textContent = '$' + (st.estimated_cost_cents / 100).toFixed(3) + ' of $' + (st.budget_cents / 100).toFixed(2) + ' cap used this month';
        } else {
          badge.textContent = 'Not Set';
          badge.style.background = 'var(--yellow-bg)'; badge.style.color = 'var(--yellow)';
          desc.textContent = st.reason + ' — insights will not run until configured';
          if (budgetEl) budgetEl.textContent = 'N/A';
        }
      } catch {}
    }
    async function updateSetting(key, value) {
      try {
        const body = {}; body[key] = value;
        const res = await apiFetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.ok) { showMsg('Setting saved.', true); if (key === 'theme') applyTheme(value); }
        else { const d = await res.json().catch(() => ({})); showMsg(d.error || 'Failed', false); }
      } catch (e) { showMsg(e.message, false); }
    }
    async function toggleModule(key, enabled) {
      try {
        const res = await apiFetch('/api/settings'); const s = await res.json();
        var mods = s.insight_modules || {};
        mods[key] = enabled;
        await updateSetting('insight_modules', mods);
      } catch (e) { showMsg(e.message, false); }
    }
    async function logout() { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; }
    async function generateInsights() {
      const btn = document.getElementById('insights-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          var modList = (data.modules_used || []).length > 0 ? ' Modules: ' + data.modules_used.join(', ') + '.' : '';
          showMsg('Insights generated (' + (data.tokens_used || 0) + ' tokens).' + modList, true);
          renderInsight(data.insight);
        }
        else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    function renderInsight(text) {
      let safe = esc(text);
      let html = safe.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>').replace(/\\n/g, '<br>');
      document.getElementById('insights-container').innerHTML =
        '<div class="insight-card"><h3>AI Financial Insights</h3><div class="insight-text">' + html +
        '</div><div class="insight-meta">Generated just now</div></div>';
    }
    async function loadInsights() {
      try {
        const res = await apiFetch('/api/insights'); const data = await res.json();
        if (data.length > 0) {
          renderInsight(data[0].insight_text);
          const meta = document.querySelector('.insight-meta');
          if (meta) meta.textContent = 'Generated ' + new Date(data[0].created_at).toLocaleDateString();
        }
      } catch {}
    }
    async function loadUsageHistory() {
      try {
        const res = await apiFetch('/api/insights/usage');
        const data = await res.json();
        const sumEl = document.getElementById('usage-summary');
        const t = data.totals;
        sumEl.innerHTML = '<span style="color:var(--text)">' + t.total_runs + ' total runs</span> &middot; ' +
          Number(t.total_tokens).toLocaleString() + ' tokens &middot; <span style="color:var(--warm)">$' +
          parseFloat(t.total_cost_usd).toFixed(4) + ' estimated total</span>';
        const histEl = document.getElementById('usage-history');
        if (data.history.length === 0) { histEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No AI insights generated yet.</div>'; return; }
        let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;">' +
          '<tr style="color:var(--text-muted);text-transform:uppercase;font-size:10px;letter-spacing:1px;">' +
          '<th style="text-align:left;padding:6px 0;border-bottom:1px solid var(--border);">Date</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Tokens</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Est. Cost</th>' +
          '<th style="text-align:right;padding:6px 0;border-bottom:1px solid var(--border);">Model</th></tr>';
        data.history.forEach(function(row) {
          html += '<tr style="font-weight:300;">' +
            '<td style="padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);">' + new Date(row.created_at).toLocaleDateString() + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);">' + (row.tokens_used || 0).toLocaleString() + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);color:var(--warm);">$' + parseFloat(row.estimated_cost_usd || 0).toFixed(4) + '</td>' +
            '<td style="text-align:right;padding:6px 0;border-bottom:1px solid rgba(128,128,128,0.06);color:var(--text-muted);font-size:11px;">' + esc((row.model_used || '').replace('claude-', '').split('-202')[0]) + '</td></tr>';
        });
        html += '</table>';
        histEl.innerHTML = html;
      } catch {}
    }
    async function resetContext() {
      if (!confirm('Clear all long-term AI memory? Next analysis will start fresh with no prior context.')) return;
      const btn = document.getElementById('reset-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights/reset', { method: 'POST' });
        const data = await res.json();
        if (res.ok) { showMsg(data.message, true); document.getElementById('memory-status').textContent = 'Cleared — will reinitialize on next analysis'; }
        else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    async function rebuildContext() {
      if (!confirm('Rebuild long-term memory from all historical analyses? This uses a small API call to synthesize past insights.')) return;
      const btn = document.getElementById('rebuild-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/insights/rebuild', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showMsg(data.message + (data.tokens_used ? ' (' + data.tokens_used + ' tokens)' : ''), true);
          const memEl = document.getElementById('memory-status');
          if (data.summary) memEl.innerHTML = '<span style="color:var(--green);">Active</span> (' + data.summary.split(/\\s+/).length + ' words)';
          else memEl.textContent = 'No historical data to rebuild from';
        } else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    // Populate hour selectors for keep-alive
    (function() {
      var startSel = document.getElementById('keepalive-start');
      var endSel = document.getElementById('keepalive-end');
      if (!startSel || !endSel) return;
      for (var h = 0; h < 24; h++) {
        var label = (h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM');
        startSel.innerHTML += '<option value="' + h + '">' + label + '</option>';
        endSel.innerHTML += '<option value="' + h + '">' + (h === 0 ? 'Midnight' : label) + '</option>';
      }
    })();
    function updateKeepAliveEstimate() {
      var enabled = document.getElementById('keepalive-toggle').checked;
      var el = document.getElementById('keepalive-estimate');
      if (!enabled) { el.textContent = 'Disabled — app sleeps after 15 min idle'; return; }
      var start = parseInt(document.getElementById('keepalive-start').value);
      var end = parseInt(document.getElementById('keepalive-end').value);
      var hours;
      if (start === end) hours = 24;
      else if (start < end) hours = end - start;
      else hours = (24 - start) + end;
      var monthly = hours * 30;
      var color = monthly > 375 ? 'var(--red)' : monthly > 300 ? 'var(--yellow)' : 'var(--green)';
      el.innerHTML = '<span style="color:' + color + ';">' + monthly + ' hrs/mo</span> (' + hours + ' hrs/day)' +
        (monthly > 375 ? ' <span style="color:var(--red);font-size:11px;">— tight if running 2 apps on Render free tier (750 hrs shared)</span>' : '');
    }
    // Override updateSetting to also refresh estimate
    var _origUpdate = updateSetting;
    updateSetting = async function(key, value) {
      await _origUpdate(key, value);
      if (key.startsWith('keep_alive')) updateKeepAliveEstimate();
    };
    async function saveSnapshot() {
      const btn = document.getElementById('snapshot-btn');
      btn.classList.add('btn-loading'); btn.disabled = true;
      try {
        const res = await apiFetch('/api/net-worth/snapshot', { method: 'POST' });
        const data = await res.json();
        if (res.ok) showMsg('Net worth snapshot saved: $' + parseFloat(data.net_worth).toLocaleString(), true);
        else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
      btn.classList.remove('btn-loading'); btn.disabled = false;
    }
    loadSettings(); loadInsights(); loadUsageHistory();
  </script>
</body></html>`);
});

  return router;
};
