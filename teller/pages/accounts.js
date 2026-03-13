const express = require("express");
const router = express.Router();

module.exports = function(config) {
  const { API_KEY, TELLER_APP_ID, TELLER_ENV } = config;
// ---------------------------------------------------------------------------
// GET / — Teller Connect enrollment + CSV import page
// ---------------------------------------------------------------------------
router.get("/", (req, res) => {
  const tellerEnv = TELLER_ENV === "production" ? "production" : TELLER_ENV === "development" ? "development" : "sandbox";
  const apiKey = API_KEY || "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Perfin — Link Account</title>
  <script src="https://cdn.teller.io/connect/connect.js"></script>
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
    .container { max-width: 640px; margin: 0 auto; padding: 24px 20px; position: relative; z-index: 1; }
    a { color: var(--warm); text-decoration: none; transition: color 0.2s; }
    a:hover { color: var(--text); }

    .topnav { display: flex; align-items: center; justify-content: space-between;
              padding: 20px 0; margin-bottom: 48px; animation: fadeIn 0.3s ease both; }
    .topnav .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px;
                    text-transform: uppercase; color: var(--text-muted); }
    .topnav .nav-links { display: flex; gap: 24px; font-size: 13px; font-weight: 400;
                         letter-spacing: 0.5px; }
    .topnav .nav-links a { color: var(--text-muted); }
    .topnav .nav-links a:hover { color: var(--text); }

    h1 { font-size: 42px; font-weight: 300; letter-spacing: -0.5px; margin-bottom: 8px;
         animation: fadeInUp 0.4s ease both; animation-delay: 0.05s; }
    h2 { font-size: 28px; font-weight: 300; letter-spacing: -0.3px; margin-bottom: 8px; }
    h3 { font-size: 10px; font-weight: 500; margin-bottom: 12px; color: var(--text-muted);
         text-transform: uppercase; letter-spacing: 1.5px; }
    p { color: var(--text-muted); font-size: 15px; line-height: 1.6; margin-bottom: 24px; font-weight: 300; }

    button { padding: 12px 28px; font-size: 12px; font-weight: 500; cursor: pointer;
             border: 1px solid var(--warm); background: transparent; color: var(--warm);
             border-radius: 8px; transition: all 0.2s; text-transform: uppercase; letter-spacing: 1px; }
    button:hover { background: rgba(212,165,116,0.1); color: var(--text); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }

    #status { margin-top: 20px; padding: 14px 18px; border-radius: 8px; display: none; font-size: 13px; font-weight: 400; }
    .success { background: var(--green-bg); border: 1px solid rgba(111,207,151,0.15); color: var(--green); }
    .error   { background: var(--red-bg); border: 1px solid rgba(235,107,107,0.15); color: var(--red); }

    #items { margin-top: 36px; }
    .item { padding: 16px 18px; margin: 8px 0; background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius); font-size: 14px; font-weight: 300; transition: all 0.2s;
            backdrop-filter: blur(12px); }
    .item:hover { border-color: var(--border-hover); background: var(--surface-2); }

    .section-divider { margin: 48px 0; border: none; border-top: 1px solid var(--border); }

    .csv-section { margin-top: 8px; }
    .csv-form { display: flex; flex-direction: column; gap: 18px; max-width: 420px; }
    .csv-form label { font-weight: 500; font-size: 10px; color: var(--text-muted);
                      text-transform: uppercase; letter-spacing: 1.5px; }
    .csv-form select, .csv-form input[type="text"] {
      padding: 10px 14px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px;
      background: transparent; color: var(--text); width: 100%; font-weight: 300;
      transition: border-color 0.2s; }
    .csv-form select:focus, .csv-form input:focus { outline: none; border-color: var(--warm); }
    .csv-form select option { background: #131620; color: var(--text); }
    .csv-form input[type="file"] { font-size: 13px; color: var(--text-muted); }
    .csv-form .field { display: flex; flex-direction: column; gap: 8px; }
    .csv-form input::placeholder { color: var(--text-muted); }

    .csv-imports { margin-top: 32px; }
    .csv-import-entry { padding: 14px 18px; margin: 6px 0; background: var(--surface);
                        border: 1px solid var(--border); border-radius: var(--radius);
                        font-size: 13px; font-weight: 300; backdrop-filter: blur(12px); }

    /* Loading spinner */
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn-loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn-loading::after {
      content: ''; position: absolute; top: 50%; left: 50%; width: 14px; height: 14px;
      margin: -7px 0 0 -7px; border: 2px solid var(--warm); border-top-color: transparent;
      border-radius: 50%; animation: spin 0.6s linear infinite;
    }

    /* Item with actions */
    .item { display: flex; align-items: center; justify-content: space-between; }
    .item-info { flex: 1; }
    .item-actions { flex-shrink: 0; margin-left: 12px; }
    .btn-unlink { padding: 5px 12px; font-size: 10px; font-weight: 500; letter-spacing: 0.5px;
                  border: 1px solid rgba(235,107,107,0.25); border-radius: 6px; cursor: pointer;
                  background: transparent; color: var(--red); text-transform: uppercase;
                  transition: all 0.2s; }
    .btn-unlink:hover { background: var(--red-bg); }
    @media (max-width: 640px) {
      .topnav { flex-direction: column; gap: 12px; align-items: flex-start; }
      .topnav .nav-links { gap: 14px; flex-wrap: wrap; }
      h1 { font-size: 28px; }
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
      <a href="/subscriptions">Subscriptions</a>
      <a href="/goals">Goals</a>
      <a href="/" class="active">Accounts</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>

  <h1>Link Accounts</h1>
  <p>Connect a financial institution to start tracking recurring charges automatically.</p>
  <button id="link-btn" onclick="startLink()">Link an Account</button>
  <div id="status"></div>
  <div id="items"><h3>Linked Institutions</h3><div id="items-list" style="color:var(--text-muted);font-size:14px;font-weight:300;">Loading...</div></div>

  <hr class="section-divider">

  <div class="csv-section">
    <h2>Import from CSV</h2>
    <p>Upload a CSV export from your bank. Supports Chase, Wells Fargo, Capital One, Discover, Schwab, and generic formats.</p>
    <div class="csv-form">
      <div class="field">
        <label for="csv-institution">Bank / Institution</label>
        <select id="csv-institution">
          <option value="Chase">Chase</option>
          <option value="Wells Fargo">Wells Fargo</option>
          <option value="Capital One">Capital One</option>
          <option value="Discover">Discover</option>
          <option value="Charles Schwab">Charles Schwab</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <input type="text" id="csv-custom-institution" placeholder="Institution name" style="display:none">

      <div class="field">
        <label for="csv-account-label">Account Label</label>
        <input type="text" id="csv-account-label" placeholder="e.g. Chase Checking, WF Visa">
      </div>

      <div class="field">
        <label for="csv-file">CSV File</label>
        <input type="file" id="csv-file" accept=".csv">
      </div>

      <button id="csv-upload-btn" onclick="uploadCsv()">Upload & Import</button>
    </div>
    <div id="csv-status" style="margin-top:12px;padding:14px 18px;border-radius:8px;display:none;font-size:13px;"></div>
    <div class="csv-imports">
      <h3>Import History</h3>
      <div id="csv-imports-list" style="color:var(--text-muted);font-size:14px;font-weight:300;">Loading...</div>
    </div>
  </div>
  </div>

  <script>
    const _apiKey = "${apiKey}";
    function apiFetch(url, opts = {}) {
      if (_apiKey) {
        opts.headers = { ...opts.headers, 'x-api-key': _apiKey };
      }
      return fetch(url, opts);
    }
    const statusEl  = document.getElementById('status');
    const itemsList = document.getElementById('items-list');

    function showStatus(msg, ok) {
      statusEl.textContent = msg;
      statusEl.className = ok ? 'success' : 'error';
      statusEl.style.display = 'block';
      if (statusEl._timer) clearTimeout(statusEl._timer);
      if (ok) { statusEl._timer = setTimeout(() => { statusEl.style.display = 'none'; }, 8000); }
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

    async function loadItems() {
      try {
        const res = await apiFetch('/api/items');
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status); }
        const items = await res.json();
        if (!items.length) { itemsList.textContent = 'No institutions linked yet.'; return; }
        itemsList.innerHTML = items.map(i =>
          '<div class="item">' +
            '<div class="item-info"><strong>' + i.institution_name + '</strong>' +
            ' (' + (i.provider || 'teller') + ') — ' +
            i.accounts.length + ' account(s) — Status: ' + i.status + '</div>' +
            '<div class="item-actions"><button class="btn-unlink" onclick="unlinkAccount(' + i.id + ', \\'' + (i.institution_name || '').replace(/'/g, "\\\\'") + '\\')">Unlink</button></div>' +
          '</div>'
        ).join('');
      } catch (e) {
        itemsList.textContent = 'Could not load items: ' + e.message;
        showStatus('Failed to load linked accounts: ' + e.message, false);
      }
    }

    async function unlinkAccount(id, name) {
      if (!confirm('Unlink ' + name + '? This will remove the enrollment but keep existing transaction data.')) return;
      try {
        const res = await apiFetch('/api/enrollments/' + id, { method: 'DELETE' });
        if (res.ok) {
          showStatus('Unlinked ' + name + ' successfully.', true);
          loadItems();
        } else {
          const data = await res.json().catch(() => ({}));
          showStatus('Failed to unlink: ' + (data.error || 'HTTP ' + res.status), false);
        }
      } catch (e) { showStatus('Failed to unlink: ' + e.message, false); }
    }

    function startLink() {
      var tellerConnect = TellerConnect.setup({
        applicationId: "${TELLER_APP_ID}",
        environment: "${tellerEnv}",
        onInit: function() { console.log("Teller Connect initialized"); },
        onSuccess: async function(enrollment) {
          showStatus('Enrolling...', true);
          try {
            const res = await apiFetch('/api/enroll', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accessToken: enrollment.accessToken,
                enrollment: {
                  id: enrollment.enrollment.id,
                  institution: enrollment.enrollment.institution,
                },
              }),
            });
            const data = await res.json();
            if (res.ok) {
              showStatus('Linked ' + data.institution + ' (' + data.accounts_linked + ' accounts)', true);
              loadItems();
            } else {
              showStatus('Enrollment failed: ' + (data.error || 'HTTP ' + res.status), false);
            }
          } catch (e) { showStatus('Enrollment failed: Could not reach server. ' + e.message, false); }
        },
        onExit: function() { console.log("Teller Connect exited"); },
        onFailure: function(failure) {
          showStatus('Teller Connect error: ' + (failure.message || JSON.stringify(failure)), false);
        },
      });
      tellerConnect.open();
    }

    // CSV import
    const csvInstitution = document.getElementById('csv-institution');
    const csvCustom = document.getElementById('csv-custom-institution');
    const csvStatusEl = document.getElementById('csv-status');

    csvInstitution.addEventListener('change', () => {
      csvCustom.style.display = csvInstitution.value === 'Other' ? 'block' : 'none';
    });

    function showCsvStatus(msg, ok) {
      csvStatusEl.textContent = msg;
      csvStatusEl.className = ok ? 'success' : 'error';
      csvStatusEl.style.display = 'block';
      if (csvStatusEl._timer) clearTimeout(csvStatusEl._timer);
      if (ok) { csvStatusEl._timer = setTimeout(() => { csvStatusEl.style.display = 'none'; }, 8000); }
    }

    async function uploadCsv() {
      const fileInput = document.getElementById('csv-file');
      const file = fileInput.files[0];
      if (!file) { showCsvStatus('Please select a CSV file.', false); return; }
      const institution = csvInstitution.value === 'Other'
        ? csvCustom.value.trim() || 'Unknown'
        : csvInstitution.value;
      const accountLabel = document.getElementById('csv-account-label').value.trim()
        || institution + ' Account';
      const formData = new FormData();
      formData.append('file', file);
      formData.append('institution', institution);
      formData.append('account_label', accountLabel);
      const btn = document.getElementById('csv-upload-btn');
      btnLoading(btn, true);
      showCsvStatus('Importing...', true);
      try {
        const resp = await apiFetch('/api/import-csv', { method: 'POST', body: formData });
        const data = await resp.json();
        if (resp.ok) {
          showCsvStatus('Imported ' + data.rows_imported + ' transactions (' + data.rows_skipped +
            ' skipped) — Format: ' + data.format_detected, true);
          loadCsvImports(); loadItems();
        } else showCsvStatus('Import failed: ' + (data.error || 'HTTP ' + resp.status), false);
      } catch (e) { showCsvStatus('Import failed: Could not reach server. ' + e.message, false); }
      btnLoading(btn, false, 'Upload & Import');
    }

    async function loadCsvImports() {
      const list = document.getElementById('csv-imports-list');
      try {
        const res = await apiFetch('/api/csv-imports');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const imports = await res.json();
        if (!imports.length) { list.textContent = 'No CSV imports yet.'; return; }
        list.innerHTML = imports.map(i =>
          '<div class="csv-import-entry"><strong>' + i.institution + '</strong> — ' +
          i.account_label + ' — ' + i.rows_imported + ' rows — ' +
          new Date(i.imported_at).toLocaleDateString() + ' — <em>' + i.filename + '</em></div>'
        ).join('');
      } catch (e) { list.textContent = 'Could not load import history.'; }
    }

    loadItems();
    loadCsvImports();
  </script>
</body>
</html>`);
});

  return router;
};
