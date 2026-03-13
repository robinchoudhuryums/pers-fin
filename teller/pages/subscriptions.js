const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
// ---------------------------------------------------------------------------
// GET /subscriptions — subscription management page
// ---------------------------------------------------------------------------
router.get("/subscriptions", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscriptions — Perfin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
      --yellow: #f0c36d; --yellow-bg: rgba(240,195,109,0.1);
      --blue: #7fb5e6; --blue-bg: rgba(127,181,230,0.1);
      --radius: 12px;
    }
    [data-theme="light"] {
      --bg: #f5f2ed; --surface: rgba(0,0,0,0.03); --surface-2: rgba(0,0,0,0.06);
      --border: rgba(0,0,0,0.10); --border-hover: rgba(0,0,0,0.20);
      --text: #1a1a2e; --text-muted: rgba(26,26,46,0.5);
      --warm: #b07a4a; --warm-glow: #a0684c; --teal: #3d7272;
      --green: #2d9f5f; --green-bg: rgba(45,159,95,0.1);
      --red: #c94444; --red-bg: rgba(201,68,68,0.1);
      --yellow: #c49a2a; --yellow-bg: rgba(196,154,42,0.1);
      --blue: #4a8abf; --blue-bg: rgba(74,138,191,0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif; background: var(--bg);
      color: var(--text); min-height: 100vh; position: relative; overflow-x: hidden;
    }
    body::before {
      content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px);
    }
    body::after {
      content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, rgba(160,100,80,0.05) 60%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px);
    }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    /* Nav */
    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 40px; animation: fadeIn 0.3s ease both; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px;
         color: var(--text); animation: fadeInUp 0.4s ease both; animation-delay: 0.05s; }
    .subtitle { color: var(--text-muted); margin-bottom: 40px; font-size: 15px; font-weight: 300;
                letter-spacing: 0.3px; animation: fadeInUp 0.4s ease both; animation-delay: 0.1s; }

    /* Summary Cards */
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
               gap: 16px; margin-bottom: 36px; }
    .card { padding: 24px; border-radius: var(--radius); background: var(--surface);
            border: 1px solid var(--border); transition: all 0.3s ease;
            backdrop-filter: blur(12px); animation: fadeInUp 0.4s ease both; }
    .card:nth-child(1) { animation-delay: 0.1s; }
    .card:nth-child(2) { animation-delay: 0.15s; }
    .card:nth-child(3) { animation-delay: 0.2s; }
    .card:nth-child(4) { animation-delay: 0.25s; }
    .card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                   letter-spacing: 1.5px; font-weight: 500; }
    .card .value { font-size: 32px; font-weight: 300; margin-top: 8px;
                   font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .card .value.cost { color: var(--warm-glow); }
    .card .value.count { color: var(--teal); }
    .card .sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-weight: 300; }

    /* Action bar */
    .actions { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; align-items: center; }
    .actions button, .actions select {
      padding: 9px 18px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--text-muted); transition: all 0.2s;
      text-transform: uppercase;
    }
    .actions button:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .actions button.primary { border-color: var(--warm); color: var(--warm); background: transparent; }
    .actions button.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }
    .actions button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .actions select { appearance: none; padding-right: 30px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23d4a574' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center; background-color: transparent; }
    .actions select option { background: #131620; color: var(--text); }

    /* Table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { text-align: left; padding: 12px 14px; font-size: 10px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; font-weight: 500;
         border-bottom: 1px solid var(--border); }
    td { padding: 14px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 14px;
         font-weight: 300; }
    tr { transition: background 0.15s; }
    tr:hover { background: var(--surface); }
    .amount { font-weight: 400; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

    /* Badges */
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 9px;
             font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; }
    .badge-new { background: var(--green-bg); color: var(--green); }
    .badge-price { background: var(--yellow-bg); color: var(--yellow); }
    .badge-manual { background: var(--blue-bg); color: var(--blue); }
    .badge-dismissed { background: var(--surface-2); color: var(--text-muted); }
    .badge-cancelled { background: var(--red-bg); color: var(--red); }
    .badge-category { background: var(--surface-2); color: var(--text-muted); font-weight: 400; }
    .badge-utility { background: var(--blue-bg); color: var(--blue); font-weight: 600; }

    /* Action buttons */
    .btn-sm { padding: 5px 12px; font-size: 10px; font-weight: 500; letter-spacing: 0.5px;
              border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
              background: transparent; color: var(--text-muted); margin-right: 4px;
              transition: all 0.2s; text-transform: uppercase; }
    .btn-sm:hover { border-color: var(--border-hover); color: var(--text); }
    .btn-sm.cancel { border-color: rgba(235,107,107,0.25); color: var(--red); }
    .btn-sm.cancel:hover { background: var(--red-bg); }
    .btn-sm.restore { border-color: rgba(111,207,151,0.25); color: var(--green); }
    .btn-sm.restore:hover { background: var(--green-bg); }

    .next-date { font-size: 13px; color: var(--text-muted); font-weight: 300; }
    .next-date.overdue { color: var(--red); font-weight: 500; }

    /* Manual form */
    .manual-form { background: var(--surface); padding: 28px; border-radius: var(--radius);
                   border: 1px solid var(--border); margin-bottom: 28px; display: none;
                   backdrop-filter: blur(12px); }
    .manual-form h3 { margin-bottom: 20px; font-size: 14px; font-weight: 400;
                      text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted); }
    .manual-form .fields { display: flex; gap: 14px; flex-wrap: wrap; align-items: end; }
    .manual-form .field { display: flex; flex-direction: column; gap: 6px; }
    .manual-form label { font-size: 10px; font-weight: 500; color: var(--text-muted);
                         text-transform: uppercase; letter-spacing: 1px; }
    .manual-form input, .manual-form select {
      padding: 9px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px;
      background: transparent; color: var(--text); font-weight: 300; transition: border-color 0.2s; }
    .manual-form input:focus, .manual-form select:focus { outline: none; border-color: var(--warm); }
    .manual-form input::placeholder { color: var(--text-muted); }
    .manual-form input[name="name"] { width: 200px; }
    .manual-form input[name="amount"] { width: 100px; }
    .manual-form input[name="notes"] { width: 200px; }

    /* Status messages */
    .status-msg { padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; display: none;
                  font-size: 13px; font-weight: 400; letter-spacing: 0.2px; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
                          color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
                        color: var(--red); display: block; }
    .empty { text-align: center; padding: 56px; color: var(--text-muted); font-weight: 300; font-size: 15px; }

    .export-link { font-size: 12px; color: var(--text-muted); }

    /* Loading spinner for buttons */
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    @media (max-width: 640px) {
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 14px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
      .summary { grid-template-columns: 1fr 1fr; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions" class="active">Subscriptions</a>
      <a href="/goals">Goals</a>
      <a href="/">Accounts</a>
      <a href="/settings">Settings</a>
      <a href="/api/export?type=subscriptions&api_key=${apiKey}" class="export-link">Export</a>
    </div>
  </nav>

  <h1>Subscriptions</h1>
  <p class="subtitle">Detected recurring charges and manually tracked subscriptions</p>

  <div class="summary">
    <div class="card"><div class="label">Subscriptions/mo</div><div class="value cost" id="subs-cost">--</div><div class="sub" id="subs-count"></div></div>
    <div class="card"><div class="label">Utilities/mo</div><div class="value cost" id="utils-cost">--</div><div class="sub" id="utils-count"></div></div>
    <div class="card"><div class="label">Total Monthly</div><div class="value cost" id="monthly-cost">--</div></div>
    <div class="card"><div class="label">Total Yearly</div><div class="value count" id="yearly-cost">--</div></div>
  </div>

  <div class="actions">
    <button class="primary" id="sync-btn" onclick="syncTransactions()">Sync Transactions</button>
    <button class="primary" id="detect-btn" onclick="runDetection()">Run Detection</button>
    <button id="add-btn" onclick="toggleManualForm()">+ Add Manual</button>
    <button id="sheets-btn" onclick="syncSheets()">Sync to Sheets</button>
    <select id="filter-select" onchange="loadSubscriptions()">
      <option value="active">Active</option>
      <option value="dismissed">Dismissed</option>
      <option value="cancelled">Cancelled</option>
      <option value="all">All</option>
    </select>
  </div>

  <div id="status-msg" class="status-msg"></div>

  <div class="manual-form" id="manual-form">
    <h3>Add Subscription Manually</h3>
    <div class="fields">
      <div class="field"><label>Service Name</label><input name="name" placeholder="e.g. Netflix"></div>
      <div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" placeholder="15.99"></div>
      <div class="field">
        <label>Billing Cycle</label>
        <select name="cadence">
          <option value="30">Monthly</option>
          <option value="90">Quarterly</option>
          <option value="365">Yearly</option>
          <option value="60">Every 2 months</option>
        </select>
      </div>
      <div class="field"><label>Notes (optional)</label><input name="notes" placeholder="Family plan, etc."></div>
      <div class="field"><label>&nbsp;</label><button class="primary" onclick="addManual()">Add</button></div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Subscription</th>
        <th>Amount</th>
        <th>/month</th>
        <th>Cycle</th>
        <th>Next Charge</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="subs-body">
      <tr><td colspan="6" class="empty">Loading...</td></tr>
    </tbody>
  </table>
  </div>

  <script>
    const _apiKey = "${apiKey}";
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function apiFetch(url, opts = {}) {
      opts.headers = { ...opts.headers, 'X-Requested-With': 'XMLHttpRequest' };
      if (_apiKey) { opts.headers['x-api-key'] = _apiKey; }
      return fetch(url, opts);
    }
    const tbody = document.getElementById('subs-body');
    const statusMsg = document.getElementById('status-msg');

    function showMsg(text, ok) {
      statusMsg.textContent = text;
      statusMsg.className = 'status-msg ' + (ok ? 'success' : 'error');
      if (statusMsg._timer) clearTimeout(statusMsg._timer);
      statusMsg._timer = setTimeout(() => {
        statusMsg.style.display = 'none'; statusMsg.className = 'status-msg';
      }, ok ? 5000 : 10000);
    }

    function btnLoading(btn, loading, originalText) {
      if (loading) {
        btn._origText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('btn-loading');
      } else {
        btn.disabled = false;
        btn.classList.remove('btn-loading');
        btn.textContent = originalText || btn._origText || btn.textContent;
      }
    }

    function cadenceLabel(days) {
      if (days === 30) return 'Monthly';
      if (days === 60) return 'Bimonthly';
      if (days === 90) return 'Quarterly';
      if (days === 365) return 'Yearly';
      return days + 'd';
    }

    function isOverdue(dateStr) { return new Date(dateStr) < new Date(); }

    async function loadSubscriptions() {
      const filter = document.getElementById('filter-select').value;
      try {
        const res = await apiFetch('/api/subscriptions?filter=' + filter);
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'Server returned ' + res.status); }
        const data = await res.json();
        document.getElementById('subs-cost').textContent = '$' + data.summary.subscriptions_monthly.toFixed(2);
        document.getElementById('subs-count').textContent = data.summary.subscription_count + ' active';
        document.getElementById('utils-cost').textContent = '$' + data.summary.utilities_monthly.toFixed(2);
        document.getElementById('utils-count').textContent = data.summary.utility_count + ' active';
        document.getElementById('monthly-cost').textContent = '$' + data.summary.monthly_cost.toFixed(2);
        document.getElementById('yearly-cost').textContent = '$' + data.summary.yearly_cost.toFixed(2);
        if (!data.subscriptions.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty">No subscriptions found. Import transactions or add manually.</td></tr>';
          return;
        }
        tbody.innerHTML = data.subscriptions.map(s => {
          const badges = [];
          if (s.is_new) badges.push('<span class="badge badge-new">NEW</span>');
          if (s.amount_changed) badges.push('<span class="badge badge-price">PRICE CHANGE</span>');
          if (s.source === 'manual') badges.push('<span class="badge badge-manual">MANUAL</span>');
          if (s.category === 'utility') badges.push('<span class="badge badge-utility">UTILITY</span>');
          else if (s.display_category && s.display_category !== 'other') badges.push('<span class="badge badge-category">' + esc(s.display_category) + '</span>');
          if (s.is_dismissed) badges.push('<span class="badge badge-dismissed">DISMISSED</span>');
          if (s.cancelled_at) badges.push('<span class="badge badge-cancelled">CANCELLED</span>');
          const overdue = !s.cancelled_at && isOverdue(s.next_expected);
          const nextClass = overdue ? 'next-date overdue' : 'next-date';
          const nextLabel = s.cancelled_at ? 'Cancelled ' + new Date(s.cancelled_at).toLocaleDateString() : new Date(s.next_expected).toLocaleDateString();
          let actions = '';
          if (s.cancelled_at) {
            actions = '<button class="btn-sm restore" onclick="uncancelSub(' + s.id + ')">Restore</button>';
          } else if (s.is_dismissed) {
            actions = '<button class="btn-sm restore" onclick="undismissSub(' + s.id + ')">Restore</button>';
          } else {
            var toggleCat = s.category === 'utility' ? 'subscription' : 'utility';
            var toggleLabel = s.category === 'utility' ? 'Sub' : 'Util';
            actions += '<button class="btn-sm" onclick="reclassify(' + s.id + ',\\'' + toggleCat + '\\')" title="Reclassify as ' + toggleCat + '">' + toggleLabel + '</button>';
            actions += '<button class="btn-sm" onclick="dismissSub(' + s.id + ')">Dismiss</button>';
            if (s.cancel_url) {
              actions += '<a class="btn-sm cancel" href="' + esc(s.cancel_url) + '" target="_blank" rel="noopener">Cancel&rarr;</a>';
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')" title="Mark as cancelled">Done</button>';
            } else {
              actions += '<button class="btn-sm cancel" onclick="markCancelled(' + s.id + ')">Cancel</button>';
            }
          }
          const notesHtml = s.notes ? '<div style="font-size:12px;color:var(--text-muted);">' + esc(s.notes) + '</div>' : '';
          return '<tr>' +
            '<td><strong>' + esc(s.display_name) + '</strong> ' + badges.join(' ') + notesHtml + '</td>' +
            '<td class="amount">$' + parseFloat(s.amount).toFixed(2) + '</td>' +
            '<td class="amount">$' + parseFloat(s.monthly_cost).toFixed(2) + '</td>' +
            '<td>' + cadenceLabel(s.cadence_days) + '</td>' +
            '<td><span class="' + nextClass + '">' + nextLabel + '</span></td>' +
            '<td>' + actions + '</td></tr>';
        }).join('');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Error loading subscriptions: ' + esc(e.message) + '</td></tr>';
        showMsg('Failed to load subscriptions: ' + e.message, false);
      }
    }

    async function syncTransactions() {
      const btn = document.getElementById('sync-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        if (res.ok) showMsg('Synced ' + data.transactions_added + ' transactions from ' + data.enrollments_synced + ' institution(s).', true);
        else showMsg('Sync failed: ' + (data.error || 'Unknown error (HTTP ' + res.status + ')'), false);
      } catch (e) { showMsg('Sync failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Sync Transactions');
    }

    async function runDetection() {
      const btn = document.getElementById('detect-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/detect', { method: 'POST' });
        const data = await res.json();
        if (res.ok) { showMsg('Detection complete: ' + data.detected_count + ' subscriptions found.', true); loadSubscriptions(); }
        else showMsg('Detection failed: ' + (data.error || 'Unknown error (HTTP ' + res.status + ')'), false);
      } catch (e) { showMsg('Detection failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Run Detection');
    }

    function toggleManualForm() {
      const form = document.getElementById('manual-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }

    async function addManual() {
      const name = document.querySelector('.manual-form input[name="name"]').value.trim();
      const amount = parseFloat(document.querySelector('.manual-form input[name="amount"]').value);
      const cadence_days = parseInt(document.querySelector('.manual-form select[name="cadence"]').value);
      const notes = document.querySelector('.manual-form input[name="notes"]').value.trim();
      if (!name || !amount) { showMsg('Name and amount are required.', false); return; }
      try {
        const res = await apiFetch('/api/subscriptions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, amount, cadence_days, notes: notes || undefined }),
        });
        if (res.ok) {
          showMsg('Added ' + name + ' ($' + amount.toFixed(2) + '/' + cadenceLabel(cadence_days).toLowerCase() + ')', true);
          document.querySelector('.manual-form input[name="name"]').value = '';
          document.querySelector('.manual-form input[name="amount"]').value = '';
          document.querySelector('.manual-form input[name="notes"]').value = '';
          loadSubscriptions();
        } else { const data = await res.json(); showMsg('Failed to add: ' + (data.error || 'HTTP ' + res.status), false); }
      } catch (e) { showMsg('Failed to add subscription: ' + e.message, false); }
    }

    async function dismissSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/dismiss', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to dismiss: ' + e.message, false); }
    }
    async function undismissSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/undismiss', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }
    async function markCancelled(id) {
      if (!confirm('Mark this subscription as cancelled?')) return;
      try {
        await apiFetch('/api/subscriptions/' + id + '/cancel', { method: 'PATCH' });
        showMsg('Subscription marked as cancelled.', true); loadSubscriptions();
      } catch (e) { showMsg('Failed to cancel: ' + e.message, false); }
    }
    async function uncancelSub(id) {
      try { await apiFetch('/api/subscriptions/' + id + '/uncancel', { method: 'PATCH' }); loadSubscriptions(); }
      catch (e) { showMsg('Failed to restore: ' + e.message, false); }
    }
    async function reclassify(id, category) {
      try {
        await apiFetch('/api/subscriptions/' + id + '/category', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: category })
        });
        showMsg('Reclassified as ' + category + '.', true);
        loadSubscriptions();
      } catch (e) { showMsg('Failed to reclassify: ' + e.message, false); }
    }

    async function syncSheets() {
      const btn = document.getElementById('sheets-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sheets/sync', { method: 'POST' });
        const data = await res.json();
        if (res.ok) showMsg('Synced to Sheets: ' + data.transactions_synced + ' txns, ' + data.subscriptions_synced + ' subs.', true);
        else showMsg('Sheets sync failed: ' + (data.error || 'HTTP ' + res.status), false);
      } catch (e) { showMsg('Sheets sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Sync to Sheets');
    }

    loadSubscriptions();
  </script>
</body>
</html>`);
});

  return router;
};
