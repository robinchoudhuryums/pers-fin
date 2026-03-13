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
  <link rel="stylesheet" href="/perfin-shared.css">
  <style>
    .container { max-width: 720px; }
    h1 { font-size: 36px; }
    .subtitle { margin-bottom: 32px; }
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
    .add-form { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; margin-bottom: 20px; display: none; }
    .add-form .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .add-form label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .add-form input, .add-form select { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid var(--border);
      border-radius: 8px; background: transparent; color: var(--text); font-family: inherit; }
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

  <script src="/perfin-shared.js"></script>
  <script>
    window.PERFIN_API_KEY = '${apiKey}';

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
            '<div class="goal-header"><span class="goal-name">' + esc(g.name) + '</span><span class="goal-type">' + esc(g.type) + '</span></div>' +
            '<div class="goal-progress"><div class="goal-amounts"><span>' + fmt(g.current_amount) + '</span><span style="color:' + color + ';font-weight:500;">' + pct + '%</span><span>' + fmt(g.target_amount) + '</span></div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min(100, pct) + '%;background:' + color + ';"></div></div></div>' +
            '<div class="goal-meta">' + meta.map(m => '<span>' + m + '</span>').join('') + '</div>' +
            (g.notes ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">' + esc(g.notes) + '</div>' : '') +
            '<div class="goal-actions">' +
              '<button class="btn-sm" onclick="updateAmount(' + g.id + ')">Update Amount</button>' +
              '<button class="btn-sm danger" onclick="deleteGoal(' + g.id + ')">Delete</button>' +
            '</div></div>';
        }).join('');
      } catch (e) { document.getElementById('goals-list').innerHTML = '<div style="color:var(--red);">Error: ' + esc(e.message) + '</div>'; }
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
