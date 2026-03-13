const express = require("express");
const router = express.Router();

module.exports = function(authConfig) {
  const { AUTH_MODE, AUTH_SECRET, SESSION_PASSWORD, SESSION_PIN } = authConfig;
// ---------------------------------------------------------------------------
// GET /login — login page
// ---------------------------------------------------------------------------
router.get("/login", (_req, res) => {
  if (!AUTH_SECRET) return res.redirect("/dashboard");
  const isPin = AUTH_MODE === "pin";
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Perfin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#080b12">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #080b12; --surface: rgba(255,255,255,0.04); --border: rgba(255,255,255,0.08);
      --text: #f0ebe3; --text-muted: rgba(240,235,227,0.5); --warm: #d4a574; --warm-glow: #c8856c;
      --red: #eb6b6b; --red-bg: rgba(235,107,107,0.1); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text);
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           position: relative; overflow: hidden; }
    body::before { content: ''; position: fixed; top: -30%; right: -20%; width: 90vw; height: 90vh;
      background: radial-gradient(ellipse at 50% 30%, rgba(200,133,108,0.28) 0%, rgba(180,120,100,0.15) 25%, rgba(90,143,143,0.12) 50%, transparent 75%);
      pointer-events: none; z-index: 0; filter: blur(50px); }
    body::after { content: ''; position: fixed; bottom: -20%; left: -15%; width: 80vw; height: 70vh;
      background: radial-gradient(ellipse at 40% 60%, rgba(90,143,143,0.20) 0%, rgba(212,165,116,0.10) 35%, transparent 80%);
      pointer-events: none; z-index: 0; filter: blur(60px); }
    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes dotPop {
      0% { transform: scale(1); }
      50% { transform: scale(1.3); }
      100% { transform: scale(1); }
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20%, 60% { transform: translateX(-6px); }
      40%, 80% { transform: translateX(6px); }
    }
    .login-card { position: relative; z-index: 1; width: 100%; max-width: 360px; padding: 44px 32px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
      backdrop-filter: blur(16px); text-align: center;
      animation: scaleIn 0.4s ease both; }
    .logo { font-weight: 300; font-size: 13px; letter-spacing: 2px; text-transform: uppercase;
            color: var(--text-muted); margin-bottom: 28px; animation: fadeInUp 0.4s ease both; animation-delay: 0.1s; }
    h1 { font-size: 26px; font-weight: 300; letter-spacing: -0.3px; margin-bottom: 6px;
         animation: fadeInUp 0.4s ease both; animation-delay: 0.15s; }
    p { color: var(--text-muted); font-size: 14px; font-weight: 300; margin-bottom: 24px;
        animation: fadeInUp 0.4s ease both; animation-delay: 0.2s; }
    input[type="password"] { width: 100%; padding: 12px 16px; font-size: 14px; font-weight: 300;
      border: 1px solid var(--border); border-radius: 8px; background: transparent;
      color: var(--text); font-family: inherit; }
    input:focus { outline: none; border-color: var(--warm); }
    button[type="submit"] { width: 100%; margin-top: 14px; padding: 12px; font-size: 13px; font-weight: 500;
      border: 1px solid var(--warm); border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--warm); text-transform: uppercase;
      letter-spacing: 1px; font-family: inherit; transition: all 0.2s; }
    button[type="submit"]:hover { background: rgba(212,165,116,0.1); color: var(--text); }
    .error-msg { margin-top: 14px; padding: 10px; border-radius: 6px;
      background: var(--red-bg); color: var(--red); font-size: 13px; display: none; }
    .pin-dots { display: flex; justify-content: center; gap: 12px; margin-bottom: 24px;
                animation: fadeInUp 0.4s ease both; animation-delay: 0.25s; }
    .pin-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border);
      transition: all 0.2s; }
    .pin-dot.filled { background: var(--warm); border-color: var(--warm); animation: dotPop 0.2s ease; }
    .pin-dot.error { border-color: var(--red); background: var(--red); }
    .pin-dots.shake { animation: shake 0.4s ease; }
    .pin-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; max-width: 240px; margin: 0 auto;
               animation: fadeInUp 0.4s ease both; animation-delay: 0.3s; }
    .pin-key { padding: 16px; font-size: 22px; font-weight: 300; border: 1px solid var(--border);
      border-radius: 10px; background: transparent; color: var(--text); cursor: pointer;
      font-family: inherit; transition: all 0.15s; user-select: none; -webkit-user-select: none;
      touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .pin-key:hover { border-color: var(--warm); }
    .pin-key:active { background: rgba(212,165,116,0.1); transform: scale(0.95); }
    .pin-key.fn { font-size: 12px; font-weight: 400; letter-spacing: 0.5px; text-transform: uppercase;
      color: var(--text-muted); border-color: transparent; }
    .pin-key.fn:hover { color: var(--text); }
  </style>
</head><body>
  <div class="login-card">
    <div class="logo">Perfin</div>
    <h1>Welcome back</h1>
    ${isPin ? `<p>Enter your PIN</p>
    <div class="pin-dots" id="pin-dots"></div>
    <div class="pin-pad" id="pin-pad"></div>
    <div id="error" class="error-msg"></div>` :
    `<p>Enter your password to continue</p>
    <form id="login-form">
      <input type="password" id="password" placeholder="Password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
    <div id="error" class="error-msg"></div>`}
  </div>
  <script>
    const AUTH_MODE = '${AUTH_MODE}';
    const errEl = document.getElementById('error');
    async function doLogin(value) {
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: value }),
        });
        const data = await res.json();
        if (res.ok) window.location.href = '/dashboard';
        else return data.error || 'Invalid ' + AUTH_MODE;
      } catch { return 'Connection error'; }
      return null;
    }
    if (AUTH_MODE === 'pin') {
      const pinLen = ${SESSION_PIN ? SESSION_PIN.length : 4};
      let pin = '';
      let submitting = false;
      const dotsEl = document.getElementById('pin-dots');
      let dotsHtml = '';
      for (let i = 0; i < pinLen; i++) dotsHtml += '<div class="pin-dot" id="dot-' + i + '"></div>';
      dotsEl.innerHTML = dotsHtml;
      const padEl = document.getElementById('pin-pad');
      let padHtml = '';
      [1,2,3,4,5,6,7,8,9].forEach(function(n) {
        padHtml += '<button class="pin-key" type="button" data-digit="' + n + '">' + n + '</button>';
      });
      padHtml += '<button class="pin-key fn" type="button" data-action="clear">Clear</button>';
      padHtml += '<button class="pin-key" type="button" data-digit="0">0</button>';
      padHtml += '<button class="pin-key fn" type="button" data-action="del">Del</button>';
      padEl.innerHTML = padHtml;
      function updateDots() {
        for (let i = 0; i < pinLen; i++) {
          document.getElementById('dot-' + i).className = 'pin-dot' + (i < pin.length ? ' filled' : '');
        }
      }
      async function handleDigit(n) {
        if (pin.length >= pinLen || submitting) return;
        pin += n;
        updateDots();
        errEl.style.display = 'none';
        if (pin.length === pinLen) {
          submitting = true;
          var err = await doLogin(pin);
          if (err) {
            for (let i = 0; i < pinLen; i++) document.getElementById('dot-' + i).className = 'pin-dot error';
            dotsEl.classList.add('shake');
            errEl.textContent = err; errEl.style.display = 'block';
            setTimeout(function() { pin = ''; submitting = false; updateDots(); dotsEl.classList.remove('shake'); }, 600);
          }
        }
      }
      padEl.addEventListener('click', function(e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        e.preventDefault();
        if (btn.dataset.digit !== undefined) handleDigit(btn.dataset.digit);
        else if (btn.dataset.action === 'clear') { pin = ''; updateDots(); errEl.style.display = 'none'; }
        else if (btn.dataset.action === 'del') { pin = pin.slice(0, -1); updateDots(); }
      });
    } else {
      document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = await doLogin(document.getElementById('password').value);
        if (err) { errEl.textContent = err; errEl.style.display = 'block'; }
      });
    }
  </script>
</body></html>`);
});

// POST /api/login
router.post("/api/login", (req, res) => {
  if (!AUTH_SECRET) return res.json({ ok: true });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: (AUTH_MODE === "pin" ? "PIN" : "Password") + " required" });
  const providedBuf = Buffer.from(password);
  const expectedBuf = Buffer.from(AUTH_SECRET);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({ error: AUTH_MODE === "pin" ? "Invalid PIN" : "Invalid password" });
  }
  req.session.authenticated = true;
  req.session.lastActivity = Date.now();
  req.session.timeoutMinutes = 15;
  res.json({ ok: true });
});

// POST /api/logout
router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

  return router;
};
