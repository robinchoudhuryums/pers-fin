const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY } = config;
router.get("/dashboard", (req, res) => {
  const apiKey = API_KEY || "";
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#080b12">
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
    [data-theme="light"] body::before {
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.12) 0%, rgba(90,143,143,0.06) 50%, transparent 75%);
    }
    [data-theme="light"] body::after {
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.10) 0%, rgba(212,165,116,0.05) 35%, transparent 80%);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-8px); }
      to { opacity: 1; transform: translateX(0); }
    }
    @keyframes countUp {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    .animate-in { animation: fadeInUp 0.4s ease both; }
    .animate-fade { animation: fadeIn 0.5s ease both; }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    .container { max-width: 1060px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 40px; animation: fadeIn 0.3s ease both; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }
    .topnav .nav-links a.active { color: var(--warm); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px;
         animation: fadeInUp 0.4s ease both; animation-delay: 0.05s; }
    .subtitle { color: var(--text-muted); margin-bottom: 36px; font-size: 15px; font-weight: 300;
                letter-spacing: 0.3px; animation: fadeInUp 0.4s ease both; animation-delay: 0.1s; }

    .top-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                 gap: 16px; margin-bottom: 36px; }
    .card { padding: 24px; border-radius: var(--radius); background: var(--surface);
            border: 1px solid var(--border); transition: all 0.3s ease; backdrop-filter: blur(12px);
            animation: fadeInUp 0.4s ease both; }
    .card:nth-child(1) { animation-delay: 0.1s; }
    .card:nth-child(2) { animation-delay: 0.15s; }
    .card:nth-child(3) { animation-delay: 0.2s; }
    .card:nth-child(4) { animation-delay: 0.25s; }
    .card:nth-child(5) { animation-delay: 0.3s; }
    .card:hover { border-color: var(--border-hover); background: var(--surface-2); }
    .card .label { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                   letter-spacing: 1.5px; font-weight: 500; }
    .card .value { font-size: 28px; font-weight: 300; margin-top: 8px;
                   font-variant-numeric: tabular-nums; letter-spacing: -1px; }
    .card .value.warm { color: var(--warm-glow); }
    .card .value.teal { color: var(--teal); }
    .card .value.green { color: var(--green); }
    .card .value.red { color: var(--red); }
    .card .sub { font-size: 11px; color: var(--text-muted); margin-top: 4px; font-weight: 300; }

    .actions { display: flex; gap: 10px; margin-bottom: 28px; flex-wrap: wrap; align-items: center; }
    .actions button {
      padding: 9px 18px; font-size: 12px; font-weight: 500; letter-spacing: 0.5px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--text-muted); transition: all 0.2s; text-transform: uppercase;
    }
    .actions button:hover:not(:disabled) { border-color: var(--warm); color: var(--text); }
    .actions button.primary { border-color: var(--warm); color: var(--warm); }
    .actions button.primary:hover:not(:disabled) { background: rgba(212,165,116,0.1); color: var(--text); }

    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .status-msg { padding: 14px 18px; border-radius: 8px; margin-bottom: 20px; display: none;
                  font-size: 13px; font-weight: 400; }
    .status-msg.success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15);
                          color: var(--green); display: block; animation: slideDown 0.3s ease both; }
    .status-msg.error { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15);
                        color: var(--red); display: block; animation: slideDown 0.3s ease both; }

    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
    @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

    .section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
               padding: 24px; backdrop-filter: blur(12px); animation: fadeInUp 0.4s ease both; animation-delay: 0.3s; }
    .section h2 { font-size: 10px; font-weight: 500; color: var(--text-muted); text-transform: uppercase;
                  letter-spacing: 1.5px; margin-bottom: 20px; }

    .accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                     gap: 12px; margin-bottom: 28px; animation: fadeInUp 0.4s ease both; animation-delay: 0.25s; }
    .acct-card { padding: 18px; border-radius: var(--radius); background: var(--surface);
                 border: 1px solid var(--border); transition: all 0.2s; }
    .acct-card:hover { border-color: var(--border-hover); }
    .acct-card .acct-inst { font-size: 10px; color: var(--text-muted); text-transform: uppercase;
                            letter-spacing: 1px; font-weight: 500; }
    .acct-card .acct-name { font-size: 14px; font-weight: 400; margin-top: 4px; }
    .acct-card .acct-mask { color: var(--text-muted); font-weight: 300; }
    .acct-card .acct-balance { font-size: 22px; font-weight: 300; margin-top: 10px;
                               font-variant-numeric: tabular-nums; }
    .acct-card .acct-balance.positive { color: var(--green); }
    .acct-card .acct-balance.negative { color: var(--red); }
    .acct-card .acct-balance.neutral { color: var(--warm-glow); }
    .acct-card .acct-type { font-size: 10px; color: var(--text-muted); margin-top: 4px;
                            text-transform: uppercase; letter-spacing: 0.5px; font-weight: 400; }

    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; font-size: 9px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; font-weight: 500;
         border-bottom: 1px solid var(--border); }
    td { padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; font-weight: 300; }
    tr { transition: background 0.15s; }
    tr:hover { background: var(--surface); }
    .amount { font-weight: 400; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }
    .amount.warm { color: var(--warm-glow); }
    .amount.teal { color: var(--teal); }

    .bar-container { width: 100%; height: 6px; background: rgba(255,255,255,0.06);
                     border-radius: 3px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }

    .empty-msg { text-align: center; padding: 40px; color: var(--text-muted); font-weight: 300; font-size: 14px; }

    /* Charts */
    .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px;
                   animation: fadeInUp 0.4s ease both; animation-delay: 0.15s; }
    .chart-card { padding: 20px; border-radius: var(--radius); background: var(--surface);
                  border: 1px solid var(--border); backdrop-filter: blur(12px); }
    .chart-card h3 { font-size: 10px; font-weight: 500; color: var(--text-muted); text-transform: uppercase;
                     letter-spacing: 1.5px; margin-bottom: 16px; }
    .chart-card canvas { max-height: 240px; }
    @media (max-width: 640px) {
      .charts-grid { grid-template-columns: 1fr; }
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 16px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
      .summary { grid-template-columns: 1fr 1fr; }
      .two-col { grid-template-columns: 1fr; }
      .accounts-grid { grid-template-columns: 1fr; }
    }
  </style>
  <script>document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');</script>
</head>
<body>
  <div class="container">
  <nav class="topnav">
    <div class="logo">Perfin</div>
    <div class="nav-links">
      <a href="/dashboard" class="active">Dashboard</a>
      <a href="/subscriptions">Subscriptions</a>
      <a href="/goals">Goals</a>
      <a href="/">Accounts</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>

  <h1>Dashboard</h1>
  <p class="subtitle">Personal finance overview</p>

  <!-- Charts -->
  <div class="charts-grid">
    <div class="chart-card">
      <h3>Monthly Spending Trend</h3>
      <canvas id="trend-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Spending by Category</h3>
      <canvas id="category-chart"></canvas>
    </div>
  </div>

  <div class="actions">
    <button class="primary" id="sync-btn" onclick="syncTransactions()">Sync Transactions</button>
    <button id="balance-btn" onclick="syncBalances()">Refresh Balances</button>
    <button id="detect-btn" onclick="runDetection()">Run Detection</button>
  </div>

  <div id="status-msg" class="status-msg"></div>

  <!-- Summary cards -->
  <div class="top-cards" id="summary-cards">
    <div class="card"><div class="label">Net Balance</div><div class="value warm" id="net-balance">--</div></div>
    <div class="card"><div class="label">Monthly Spend</div><div class="value warm" id="avg-monthly">--</div><div class="sub" id="avg-monthly-sub"></div></div>
    <div class="card"><div class="label">Subscriptions /mo</div><div class="value teal" id="subs-monthly">--</div></div>
    <div class="card"><div class="label">Active Subs</div><div class="value teal" id="active-subs">--</div></div>
    <div class="card"><div class="label">Avg Daily Spend</div><div class="value warm" id="avg-daily">--</div></div>
    <div class="card"><div class="label">Linked Accounts</div><div class="value teal" id="acct-count">--</div></div>
  </div>

  <!-- Account balances -->
  <div id="accounts-section" style="margin-bottom:28px;">
    <div style="font-size:10px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:14px;">Account Balances</div>
    <div class="accounts-grid" id="accounts-grid">
      <div class="empty-msg">Loading accounts...</div>
    </div>
  </div>

  <!-- Two-column: Monthly trend + Categories -->
  <div class="two-col">
    <div class="section">
      <h2>Monthly Spending</h2>
      <table>
        <thead><tr><th>Month</th><th>Total</th><th>Txns</th><th>Avg</th></tr></thead>
        <tbody id="monthly-body"><tr><td colspan="4" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="section">
      <h2>Spending by Category</h2>
      <table>
        <thead><tr><th>Category</th><th>Total</th><th style="width:30%">Share</th></tr></thead>
        <tbody id="category-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Two-column: Top merchants + Upcoming subscriptions -->
  <div class="two-col">
    <div class="section">
      <h2>Top Merchants</h2>
      <table>
        <thead><tr><th>Merchant</th><th>Total</th><th>Txns</th></tr></thead>
        <tbody id="merchant-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="section">
      <h2>Upcoming Charges</h2>
      <table>
        <thead><tr><th>Service</th><th>Amount</th><th>Next</th></tr></thead>
        <tbody id="upcoming-body"><tr><td colspan="3" class="empty-msg">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  </div>

  <script>
    const API_KEY = ${JSON.stringify(apiKey)};
    const statusMsg = document.getElementById('status-msg');

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function apiFetch(url, opts = {}) {
      opts.headers = { ...opts.headers, 'X-Requested-With': 'XMLHttpRequest' };
      if (API_KEY) {
        opts.headers['x-api-key'] = API_KEY;
      }
      return fetch(url, opts);
    }

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

    const fmt = (n) => '$' + parseFloat(n || 0).toFixed(2);
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\\u2014';
    const fmtMonth = (m) => {
      const [y, mo] = m.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[parseInt(mo)-1] + ' ' + y;
    };

    const barColors = ['#c8856c','#d4a574','#5a8f8f','#6fcf97','#7fb5e6','#f0c36d','#eb6b6b','#b07cc6','#e8a87c','#85dcb0','#7bb5d4','#d4a0a0','#9fd4c9','#c4b28f','#a8c3d4'];

    // Load accounts with balances
    async function loadAccounts() {
      try {
        const [res, invRes] = await Promise.all([
          apiFetch('/api/accounts'),
          apiFetch('/api/investment-accounts'),
        ]);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const accounts = await res.json();
        const investments = invRes.ok ? await invRes.json() : [];
        const grid = document.getElementById('accounts-grid');

        document.getElementById('acct-count').textContent = accounts.length + investments.length;

        if (!accounts.length && !investments.length) {
          grid.innerHTML = '<div class="empty-msg">No accounts linked. <a href="/">Link an account</a> to get started.</div>';
          return;
        }

        let netBalance = 0;
        const hasBalances = accounts.some(a => a.available_balance !== null || a.current_balance !== null) || investments.length > 0;

        let html = accounts.map(a => {
          const bal = parseFloat(a.available_balance || a.current_balance || 0);
          // Credit accounts: balance represents debt
          const isCredit = a.type === 'credit';
          const displayBal = isCredit ? -bal : bal;
          netBalance += displayBal;

          const balClass = !hasBalances ? 'neutral' : displayBal > 0 ? 'positive' : displayBal < 0 ? 'negative' : 'neutral';
          const balDisplay = hasBalances ? (displayBal < 0 ? '-' + fmt(Math.abs(displayBal)) : fmt(displayBal)) : '\\u2014';

          // Credit utilization for credit accounts
          let creditExtra = '';
          if (isCredit && hasBalances) {
            const owed = parseFloat(a.current_balance || 0);
            const avail = parseFloat(a.available_balance || 0);
            const limit = owed + avail;
            const util = limit > 0 ? Math.round((owed / limit) * 100) : 0;
            const utilColor = util <= 10 ? 'var(--green)' : util <= 30 ? 'var(--teal)' : util <= 50 ? 'var(--warm)' : 'var(--red)';
            creditExtra += '<div style="font-size:11px;margin-top:4px;color:var(--text-muted);">Utilization: <span style="color:' + utilColor + ';font-weight:500;">' + util + '%</span> of ' + fmt(limit) + '</div>';
            creditExtra += '<div style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">APR: <input type="number" step="0.01" min="0" max="99.99" value="' + (a.apr || '') + '" placeholder="—" style="width:60px;padding:2px 6px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--text);font-family:inherit;" onchange="setApr(' + a.id + ',this.value)">%</div>';
          }
          return '<div class="acct-card">' +
            '<div class="acct-inst">' + esc(a.institution_name || 'Unknown') + '</div>' +
            '<div class="acct-name">' + esc(a.name) + (a.mask ? ' <span class="acct-mask">\\u2022\\u2022\\u2022\\u2022 ' + esc(a.mask) + '</span>' : '') + '</div>' +
            '<div class="acct-balance ' + balClass + '">' + balDisplay + '</div>' +
            '<div class="acct-type">' + esc(a.subtype || a.type || '') + '</div>' +
            creditExtra +
          '</div>';
        }).join('');

        // Append investment accounts
        html += investments.map(inv => {
          const bal = parseFloat(inv.balance);
          netBalance += bal;
          const balClass = bal > 0 ? 'positive' : bal < 0 ? 'negative' : 'neutral';
          return '<div class="acct-card">' +
            '<div class="acct-inst">' + esc(inv.institution || 'Investment') + '</div>' +
            '<div class="acct-name">' + esc(inv.name) + '</div>' +
            '<div class="acct-balance ' + balClass + '">' + fmt(bal) + '</div>' +
            '<div class="acct-type">' + esc(inv.account_type) + '</div>' +
          '</div>';
        }).join('');

        grid.innerHTML = html;

        document.getElementById('net-balance').textContent = hasBalances ? fmt(netBalance) : '\\u2014';
        if (hasBalances) {
          document.getElementById('net-balance').className = 'value ' + (netBalance >= 0 ? 'green' : 'red');
        }
      } catch (e) {
        document.getElementById('accounts-grid').innerHTML = '<div class="empty-msg">Could not load accounts: ' + e.message + '</div>';
      }
    }

    // Load spending summary
    async function loadSpendingSummary() {
      try {
        const res = await apiFetch('/api/spending-summary?months=6');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        // Monthly trend
        const monthBody = document.getElementById('monthly-body');
        if (data.monthly_trend.length) {
          monthBody.innerHTML = data.monthly_trend.map(m =>
            '<tr><td>' + fmtMonth(m.month) + '</td>' +
            '<td class="amount warm">' + fmt(m.total_spend) + '</td>' +
            '<td>' + m.txn_count + '</td>' +
            '<td class="amount">' + fmt(m.avg_transaction) + '</td></tr>'
          ).join('');

          // Avg monthly spend
          const totalSpend = data.monthly_trend.reduce((s, m) => s + parseFloat(m.total_spend), 0);
          const avgMonthly = totalSpend / data.monthly_trend.length;
          document.getElementById('avg-monthly').textContent = fmt(avgMonthly);
          document.getElementById('avg-monthly-sub').textContent = data.monthly_trend.length + '-month avg';

          // Avg daily
          const totalDays = data.monthly_trend.length * 30;
          document.getElementById('avg-daily').textContent = fmt(totalSpend / totalDays);
        } else {
          monthBody.innerHTML = '<tr><td colspan="4" class="empty-msg">No spending data yet.</td></tr>';
        }

        // Categories
        const catBody = document.getElementById('category-body');
        if (data.by_category.length) {
          const maxCat = parseFloat(data.by_category[0].total);
          catBody.innerHTML = data.by_category.map((c, i) => {
            const pct = Math.round((parseFloat(c.total) / maxCat) * 100);
            const color = barColors[i % barColors.length];
            return '<tr><td>' + esc(c.category) + '</td>' +
              '<td class="amount warm">' + fmt(c.total) + '</td>' +
              '<td><div class="bar-container"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></td></tr>';
          }).join('');
        } else {
          catBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No category data yet.</td></tr>';
        }

        // Top merchants
        const merchBody = document.getElementById('merchant-body');
        if (data.top_merchants.length) {
          merchBody.innerHTML = data.top_merchants.map(m =>
            '<tr><td>' + esc(m.merchant) + '</td>' +
            '<td class="amount warm">' + fmt(m.total_spent) + '</td>' +
            '<td>' + m.txn_count + '</td></tr>'
          ).join('');
        } else {
          merchBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No merchant data yet.</td></tr>';
        }

        // Upcoming subscriptions
        const upBody = document.getElementById('upcoming-body');
        if (data.upcoming_subscriptions.length) {
          upBody.innerHTML = data.upcoming_subscriptions.map(s =>
            '<tr><td>' + esc(s.display_name) + '</td>' +
            '<td class="amount teal">' + fmt(s.amount) + '</td>' +
            '<td>' + fmtDate(s.next_expected) + '</td></tr>'
          ).join('');

          // Subs monthly total
          const subsMonthly = data.upcoming_subscriptions.reduce((s, sub) => s + parseFloat(sub.monthly_cost || 0), 0);
          document.getElementById('subs-monthly').textContent = fmt(subsMonthly);
          document.getElementById('active-subs').textContent = data.upcoming_subscriptions.length;
        } else {
          upBody.innerHTML = '<tr><td colspan="3" class="empty-msg">No upcoming charges.</td></tr>';
        }
      } catch (e) {
        showMsg('Could not load spending data: ' + e.message, false);
      }
    }

    async function syncTransactions() {
      const btn = document.getElementById('sync-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Synced: ' + (data.transactions_added || 0) + ' transactions added.', true);
          loadSpendingSummary();
        } else {
          showMsg('Sync error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Sync Transactions');
    }

    async function syncBalances() {
      const btn = document.getElementById('balance-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/sync-balances', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Balances updated for ' + (data.accounts_updated || 0) + ' accounts.', true);
          loadAccounts();
        } else {
          showMsg('Balance sync error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Balance sync failed: ' + e.message, false); }
      btnLoading(btn, false, 'Refresh Balances');
    }

    async function runDetection() {
      const btn = document.getElementById('detect-btn');
      btnLoading(btn, true);
      try {
        const res = await apiFetch('/api/detect', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          showMsg('Detection complete: ' + (data.detected_count || 0) + ' subscriptions found.', true);
          loadSpendingSummary();
        } else {
          showMsg('Detection error: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showMsg('Detection failed: ' + e.message, false); }
      btnLoading(btn, false, 'Run Detection');
    }

    async function setApr(accountId, value) {
      try {
        const apr = value === '' ? null : parseFloat(value);
        const res = await apiFetch('/api/accounts/' + accountId, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apr: apr })
        });
        if (res.ok) showMsg('APR saved.', true);
        else { const d = await res.json().catch(() => ({})); showMsg(d.error || 'Failed to save APR', false); }
      } catch (e) { showMsg(e.message, false); }
    }

    // Initialize
    loadAccounts();
    loadSpendingSummary();

    // PWA
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

    // Charts
    const chartScript = document.createElement('script');
    chartScript.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    chartScript.onload = loadCharts;
    document.head.appendChild(chartScript);

    async function loadCharts() {
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      const textColor = isDark ? 'rgba(240,235,227,0.5)' : 'rgba(26,26,46,0.5)';
      Chart.defaults.color = textColor;
      Chart.defaults.borderColor = gridColor;
      try {
        const txRes = await apiFetch('/api/transactions?months=6');
        const txData = await txRes.json();
        const monthlyMap = {};
        (txData.transactions || []).forEach(t => {
          if (t.amount > 0) {
            const m = t.date.slice(0, 7);
            monthlyMap[m] = (monthlyMap[m] || 0) + parseFloat(t.amount);
          }
        });
        const months = Object.keys(monthlyMap).sort();
        const amounts = months.map(m => monthlyMap[m]);
        const trendCtx = document.getElementById('trend-chart');
        if (trendCtx && months.length > 0) {
          new Chart(trendCtx, {
            type: 'line',
            data: {
              labels: months.map(m => { const d = new Date(m + '-01'); return d.toLocaleString('default', { month: 'short', year: '2-digit' }); }),
              datasets: [{
                label: 'Spending',
                data: amounts,
                borderColor: '#d4a574',
                backgroundColor: 'rgba(212,165,116,0.1)',
                fill: true, tension: 0.4, pointRadius: 4,
                pointBackgroundColor: '#d4a574',
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: true,
              plugins: { legend: { display: false } },
              scales: {
                y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: gridColor } },
                x: { grid: { display: false } }
              }
            }
          });
        }
        // Category doughnut
        const catMap = {};
        (txData.transactions || []).forEach(t => {
          if (t.amount > 0) {
            const cat = (t.personal_finance_category && t.personal_finance_category.primary) || t.category || 'Other';
            catMap[cat] = (catMap[cat] || 0) + parseFloat(t.amount);
          }
        });
        const cats = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const pieColors = ['#d4a574', '#5a8f8f', '#c8856c', '#6fcf97', '#7fb5e6', '#f0c36d', '#eb6b6b', '#b08ed6'];
        const catCtx = document.getElementById('category-chart');
        if (catCtx && cats.length > 0) {
          new Chart(catCtx, {
            type: 'doughnut',
            data: {
              labels: cats.map(c => c[0]),
              datasets: [{ data: cats.map(c => c[1].toFixed(2)), backgroundColor: pieColors.slice(0, cats.length), borderWidth: 0 }]
            },
            options: {
              responsive: true, maintainAspectRatio: true, cutout: '60%',
              plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ctx.label + ': $' + parseFloat(ctx.raw).toLocaleString() } }
              }
            }
          });
        }
      } catch (e) { console.warn('Charts load error:', e); }
    }
  </script>
</body>
</html>`);
});

  return router;
};
