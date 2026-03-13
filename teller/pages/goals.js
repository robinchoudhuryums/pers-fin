const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
// ---------------------------------------------------------------------------
// GET /goals — financial goals page
// ---------------------------------------------------------------------------
router.get("/goals", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Goals — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#080b12">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #080b12; --surface: rgba(255,255,255,0.04); --surface-2: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08); --border-hover: rgba(255,255,255,0.18);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5);
      --warm: #d4a574; --warm-glow: #c8856c; --teal: #5a8f8f;
      --green: #6fcf97; --green-bg: rgba(111,207,151,0.1);
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1);
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
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    body::before { content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px); }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; }
    .topnav { display: flex; align-items: center; justify-content: space-between; padding: 20px 0; margin-bottom: 40px; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; }
    .topnav .nav-links a { color: var(--text-muted); } .topnav .nav-links a:hover { color: var(--text); }
    .topnav .nav-links a.active { color: var(--warm); }
    h1 { font-size: 36px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 6px; }
    .subtitle { color: var(--text-muted); margin-bottom: 32px; font-size: 15px; font-weight: 300; }
    .status-msg { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; display: none; font-size: 13px; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15); color: var(--green); display: block; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15); color: var(--red); display: block; }
    .goal-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; margin-bottom: 12px; backdrop-filter: blur(12px); transition: border-color 0.2s; }
    .goal-card:hover { border-color: var(--border-hover); }
    .goal-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
    .goal-name { font-size: 16px; font-weight: 400; }
    .goal-type { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted);
      padding: 2px 8px; border: 1px solid var(--border); border-radius: 4px; }
    .goal-progress { margin-bottom: 8px; }
    .progress-bar { height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; margin-top: 6px; }
    .progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
    .goal-amounts { display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); }
    .goal-meta { display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); margin-top: 8px; flex-wrap: wrap; }
    .goal-actions { display: flex; gap: 6px; margin-top: 10px; }
    .btn-sm { padding: 4px 10px; font-size: 11px; border: 1px solid var(--border); border-radius: 6px;
      background: transparent; color: var(--text-muted); cursor: pointer; font-family: inherit; }
    .btn-sm:hover { border-color: var(--warm); color: var(--text); }
    .btn-sm.danger { border-color: rgba(235,107,107,0.25); color: var(--red); }
    .add-form { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; margin-bottom: 20px; display: none; }
    .add-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .add-form label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .add-form input, .add-form select { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid var(--border);
      border-radius: 8px; background: transparent; color: var(--text); font-family: inherit; }
    .btn { padding: 8px 16px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: transparent;
      color: var(--text-muted); font-family: inherit; text-transform: uppercase; }
    .btn:hover { border-color: var(--warm); color: var(--text); }
    .btn.primary { border-color: var(--warm); color: var(--warm); }
    .context-link { display: inline-block; margin-top: 20px; padding: 10px 16px; font-size: 12px;
      border: 1px solid var(--border); border-radius: 8px; color: var(--text-muted); letter-spacing: 0.5px; }
    .context-link:hover { border-color: var(--warm); color: var(--text); }
    @media (max-width: 640px) { .add-form .fields { grid-template-columns: 1fr; } }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head><body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/goals" class="active">Goals</a>
      <a href="/goals">Goals</a>
      <a href="/">Accounts</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>
  <h1>Financial Goals</h1>
  <p class="subtitle">Track progress toward savings, purchases, and retirement</p>
  <div id="status-msg" class="status-msg"></div>

  <div style="margin-bottom:16px;">
    <button class="btn primary" onclick="document.getElementById('add-form').style.display=document.getElementById('add-form').style.display==='none'?'block':'none'">+ Add Goal</button>
  </div>

  <div class="add-form" id="add-form">
    <div class="fields">
      <div><label>Goal Name</label><input id="g-name" placeholder="e.g. House Down Payment"></div>
      <div><label>Type</label><select id="g-type">
        <option value="savings">Savings</option><option value="home">Home Purchase</option>
        <option value="car">Car Purchase</option><option value="retirement">Retirement</option>
        <option value="emergency">Emergency Fund</option><option value="debt_payoff">Debt Payoff</option>
        <option value="education">Education</option><option value="other">Other</option>
      </select></div>
      <div><label>Target Amount ($)</label><input id="g-target" type="number" step="0.01" placeholder="400000"></div>
      <div><label>Current Amount ($)</label><input id="g-current" type="number" step="0.01" placeholder="25000"></div>
      <div><label>Monthly Contribution ($)</label><input id="g-monthly" type="number" step="0.01" placeholder="500"></div>
      <div><label>Expected Annual Return (%)</label><input id="g-rate" type="number" step="0.01" placeholder="7"></div>
      <div><label>Target Date</label><input id="g-date" type="date"></div>
      <div><label>Notes</label><input id="g-notes" placeholder="20% down payment"></div>
    </div>
    <div style="margin-top:12px;"><button class="btn primary" onclick="addGoal()">Save Goal</button></div>
  </div>

  <div id="goals-list"><div style="color:var(--text-muted);font-size:13px;">Loading...</div></div>

  <a class="context-link" href="/api/context-export?api_key=${apiKey}" download>Export data for Claude chat</a>
  </div>

  <script>
    const API_KEY = '${apiKey}';
    function apiFetch(url, opts = {}) {
      if (API_KEY) { opts.headers = opts.headers || {}; opts.headers['x-api-key'] = API_KEY; }
      return fetch(url, opts);
    }
    const statusEl = document.getElementById('status-msg');
    function showMsg(t, ok) {
      statusEl.textContent = t; statusEl.className = 'status-msg ' + (ok ? 'success' : 'error');
      clearTimeout(statusEl._t); statusEl._t = setTimeout(() => { statusEl.style.display='none'; statusEl.className='status-msg'; }, ok ? 4000 : 8000);
    }
    function fmt(n) { return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

    async function loadGoals() {
      try {
        const res = await apiFetch('/api/goals'); const goals = await res.json();
        const el = document.getElementById('goals-list');
        if (!goals.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px 0;">No goals yet. Add one above.</div>'; return; }
        el.innerHTML = goals.map(g => {
          const pct = g.percent_complete;
          const color = pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--teal)' : pct >= 25 ? 'var(--warm)' : 'var(--red)';
          let meta = [];
          if (g.monthly_contribution > 0) meta.push(fmt(g.monthly_contribution) + '/mo');
          if (g.interest_rate > 0) meta.push(g.interest_rate + '% return');
          if (g.estimated_date && pct < 100) meta.push('Est. ' + new Date(g.estimated_date).toLocaleDateString());
          if (g.target_date) meta.push('Target: ' + new Date(g.target_date).toLocaleDateString());
          if (g.months_to_goal && pct < 100) {
            const yrs = Math.floor(g.months_to_goal / 12);
            const mos = g.months_to_goal % 12;
            meta.push((yrs > 0 ? yrs + 'y ' : '') + mos + 'mo to go');
          }
          return '<div class="goal-card">' +
            '<div class="goal-header"><span class="goal-name">' + g.name + '</span><span class="goal-type">' + g.type + '</span></div>' +
            '<div class="goal-progress"><div class="goal-amounts"><span>' + fmt(g.current_amount) + '</span><span style="color:' + color + ';font-weight:500;">' + pct + '%</span><span>' + fmt(g.target_amount) + '</span></div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min(100, pct) + '%;background:' + color + ';"></div></div></div>' +
            '<div class="goal-meta">' + meta.map(m => '<span>' + m + '</span>').join('') + '</div>' +
            (g.notes ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">' + g.notes + '</div>' : '') +
            '<div class="goal-actions">' +
              '<button class="btn-sm" onclick="updateAmount(' + g.id + ')">Update Amount</button>' +
              '<button class="btn-sm danger" onclick="deleteGoal(' + g.id + ')">Delete</button>' +
            '</div></div>';
        }).join('');
      } catch (e) { document.getElementById('goals-list').innerHTML = '<div style="color:var(--red);">Error: ' + e.message + '</div>'; }
    }

    async function addGoal() {
      const body = {
        name: document.getElementById('g-name').value,
        type: document.getElementById('g-type').value,
        target_amount: parseFloat(document.getElementById('g-target').value) || 0,
        current_amount: parseFloat(document.getElementById('g-current').value) || 0,
        monthly_contribution: parseFloat(document.getElementById('g-monthly').value) || 0,
        interest_rate: parseFloat(document.getElementById('g-rate').value) || 0,
        target_date: document.getElementById('g-date').value || null,
        notes: document.getElementById('g-notes').value || null,
      };
      if (!body.name || !body.target_amount) { showMsg('Name and target amount are required.', false); return; }
      try {
        const res = await apiFetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.ok) { showMsg('Goal added.', true); loadGoals(); document.getElementById('add-form').style.display = 'none'; }
        else { const d = await res.json(); showMsg(d.error || 'Failed', false); }
      } catch (e) { showMsg(e.message, false); }
    }

    async function updateAmount(id) {
      const val = prompt('Enter current amount ($):');
      if (val === null) return;
      try {
        const res = await apiFetch('/api/goals/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_amount: parseFloat(val) }) });
        if (res.ok) { showMsg('Updated.', true); loadGoals(); }
        else showMsg('Failed to update.', false);
      } catch (e) { showMsg(e.message, false); }
    }

    async function deleteGoal(id) {
      if (!confirm('Delete this goal?')) return;
      try {
        await apiFetch('/api/goals/' + id, { method: 'DELETE' });
        showMsg('Goal deleted.', true); loadGoals();
      } catch (e) { showMsg(e.message, false); }
    }

    loadGoals();
  </script>
</body></html>`);
});

  return router;
};
