const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

module.exports = function ({ pool, views, config }) {
  const router = require("express").Router();
  const { pageHead, themeScript } = views;
  const { AUTH_SECRET, AUTH_MODE, SESSION_PASSWORD, SESSION_PIN } = config;

  // Load vision icon for login animation
  let visionIconSvg = '';
  try {
    visionIconSvg = fs.readFileSync(path.join(__dirname, '..', 'vision icon.svg'), 'utf8');
  } catch (e) { /* no icon available */ }

  router.get("/login", (req, res) => {
    if (!AUTH_SECRET) return res.redirect("/");
    const isPIN = AUTH_MODE === "pin";
    const pinLen = 8; // fixed display length to avoid leaking actual PIN length
    res.send(`${pageHead("Login")}
<body>
${themeScript()}
<style>
  body { display: flex; align-items: center; justify-content: center; overflow: hidden; padding-left: 0 !important; }
  body .sidebar, body .appbar { display: none !important; }
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
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .login-card {
    position: relative; z-index: 1; width: 100%; max-width: 360px;
    padding: 44px 32px;
    background: var(--paper-card); border: 1px solid var(--line);
    border-radius: var(--radius); text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.08);
    animation: scaleIn 0.4s ease both;
  }
  .login-card .logo {
    font-family: var(--mono); font-size: 10px; letter-spacing: 0.2em;
    text-transform: uppercase; color: var(--muted);
    margin-bottom: 28px;
    animation: fadeInUp 0.4s ease both; animation-delay: 0.1s;
  }
  .login-card h1 {
    font-family: var(--display); font-size: 24px; font-weight: 500;
    letter-spacing: -0.3px; margin-bottom: 6px;
    animation: fadeInUp 0.4s ease both; animation-delay: 0.15s;
  }
  .login-card p {
    color: var(--muted); font-size: 13px; margin-bottom: 24px;
    animation: fadeInUp 0.4s ease both; animation-delay: 0.2s;
  }
  .login-card input[type="password"] {
    width: 100%; padding: 10px 14px; font-size: 14px;
    border: 1px solid var(--line); border-radius: 2px; background: var(--paper-card);
    color: var(--ink); font-family: inherit; box-sizing: border-box;
  }
  .login-card input:focus { outline: none; border-color: var(--accent); }
  .login-card button[type="submit"] {
    width: 100%; margin-top: 14px; padding: 10px;
    font-family: var(--mono); font-size: 10px; font-weight: 500;
    letter-spacing: 0.1em; text-transform: uppercase;
    border: 1px solid var(--accent); border-radius: 2px; cursor: pointer;
    background: var(--accent); color: var(--paper);
    transition: filter 0.15s;
  }
  .login-card button[type="submit"]:hover { filter: brightness(0.95); }
  .error-msg {
    margin-top: 14px; padding: 10px; border-radius: 2px;
    background: color-mix(in oklch, var(--warn) 10%, transparent);
    border: 1px solid var(--warn); color: var(--warn);
    font-size: 13px; display: none;
  }
  .pin-dots {
    display: flex; justify-content: center; gap: 12px; margin-bottom: 24px;
    animation: fadeInUp 0.4s ease both; animation-delay: 0.25s;
  }
  .pin-dot {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid var(--line); background: transparent;
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
  }
  .pin-dot.filled { background: var(--accent); border-color: var(--accent); animation: dotPop 0.2s ease; }
  .pin-dot.error { border-color: var(--warn); background: var(--warn); }
  .pin-dots.shake { animation: shake 0.4s ease; }
  .pin-pad {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
    max-width: 240px; margin: 0 auto;
    animation: fadeInUp 0.4s ease both; animation-delay: 0.3s;
  }
  .pin-key {
    padding: 14px; font-family: var(--display); font-size: 20px; font-weight: 500;
    border: 1px solid var(--line); border-radius: 2px;
    background: transparent; color: var(--ink); cursor: pointer;
    transition: all 0.15s; user-select: none; -webkit-user-select: none;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  }
  .pin-key:hover { border-color: var(--accent); background: var(--paper-2); }
  .pin-key:active { background: var(--accent-soft); transform: scale(0.96); }
  .pin-key.fn {
    font-family: var(--mono); font-size: 10px; font-weight: 500;
    letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted); border-color: transparent;
  }
  .pin-key.fn:hover { color: var(--ink); border-color: var(--line); }
  @keyframes loginIconPulse {
    0% { transform: scale(0.3); opacity: 0; }
    40% { transform: scale(1.05); opacity: 1; }
    60% { transform: scale(0.98); opacity: 1; }
    80% { transform: scale(1); opacity: 1; }
    100% { transform: scale(1); opacity: 0; }
  }
  @keyframes loginGlow {
    0% { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
    50% { box-shadow: 0 0 60px 20px color-mix(in oklch, var(--accent) 30%, transparent); }
    100% { box-shadow: 0 0 80px 30px rgba(0,0,0,0); }
  }
  @keyframes loginFadeOut {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }
  .login-success-overlay {
    display: none; position: fixed; inset: 0;
    background: var(--paper); z-index: 1000;
    align-items: center; justify-content: center;
    flex-direction: column; gap: 24px;
  }
  .login-success-overlay.active { display: flex; animation: loginFadeOut 0.5s ease 1.6s forwards; }
  .login-success-overlay .icon-container {
    width: 120px; height: 120px; border-radius: 24px; overflow: hidden;
    animation: loginIconPulse 2s ease forwards, loginGlow 2s ease forwards;
  }
  .login-success-overlay .icon-container svg { width: 100%; height: 100%; }
  .login-success-overlay .welcome-text {
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    letter-spacing: 0.2em; text-transform: uppercase; opacity: 0;
    animation: fadeInUp 0.4s ease 0.4s forwards;
  }
</style>
  <div class="login-success-overlay" id="login-success">
    <div class="icon-container">${visionIconSvg}</div>
    <div class="welcome-text">Welcome back</div>
  </div>
  <div class="login-card">
    <div class="logo">Per-sistant</div>
    <h1>Welcome back</h1>
    ${isPIN ? `
    <p>Enter your PIN</p>
    <div class="pin-dots" id="pin-dots"></div>
    <div class="pin-pad" id="pin-pad"></div>
    <div id="error" class="error-msg"></div>
    ` : `
    <p>Enter your password to continue</p>
    <form id="login-form">
      <input type="password" id="pw" placeholder="Password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
    <div id="error" class="error-msg"></div>
    `}
  </div>
  <script>
    var errEl = document.getElementById('error');
    async function doLogin(value) {
      try {
        var res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: value }),
        });
        var data = await res.json();
        if (res.ok) {
          var overlay = document.getElementById('login-success');
          if (overlay.querySelector('svg')) {
            overlay.classList.add('active');
            setTimeout(function() { window.location.href = '/'; }, 2000);
          } else {
            window.location.href = '/';
          }
          return null;
        }
        else return data.error || 'Invalid credentials';
      } catch(e) { return 'Connection error'; }
    }
    ${isPIN ? `
    (function() {
      var pinLen = ${pinLen};
      var pin = '';
      var submitting = false;
      var dotsEl = document.getElementById('pin-dots');
      var dotsHtml = '';
      for (var i = 0; i < pinLen; i++) dotsHtml += '<div class="pin-dot" id="dot-' + i + '"></div>';
      dotsEl.innerHTML = dotsHtml;
      var padEl = document.getElementById('pin-pad');
      var padHtml = '';
      [1,2,3,4,5,6,7,8,9].forEach(function(n) {
        padHtml += '<button class="pin-key" type="button" data-digit="' + n + '">' + n + '</button>';
      });
      padHtml += '<button class="pin-key fn" type="button" data-action="clear">Clear</button>';
      padHtml += '<button class="pin-key" type="button" data-digit="0">0</button>';
      padHtml += '<button class="pin-key fn" type="button" data-action="submit" style="color:var(--accent);">Go</button>';
      padEl.innerHTML = padHtml;
      function updateDots() {
        for (var i = 0; i < pinLen; i++) {
          document.getElementById('dot-' + i).className = 'pin-dot' + (i < pin.length ? ' filled' : '');
        }
      }
      function handleDigit(n) {
        if (pin.length >= pinLen || submitting) return;
        pin += n;
        updateDots();
        errEl.style.display = 'none';
      }
      async function submitPin() {
        if (!pin.length || submitting) return;
        submitting = true;
        var err = await doLogin(pin);
        if (err) {
          for (var i = 0; i < pinLen; i++) {
            if (i < pin.length) document.getElementById('dot-' + i).className = 'pin-dot error';
          }
          dotsEl.classList.add('shake');
          errEl.textContent = err; errEl.style.display = 'block';
          setTimeout(function() { pin = ''; submitting = false; updateDots(); dotsEl.classList.remove('shake'); }, 600);
        }
      }
      padEl.addEventListener('click', function(e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        e.preventDefault();
        if (btn.dataset.digit !== undefined) handleDigit(btn.dataset.digit);
        else if (btn.dataset.action === 'clear') { pin = ''; updateDots(); errEl.style.display = 'none'; }
        else if (btn.dataset.action === 'submit') submitPin();
      });
      // Physical keyboard support: digits type, Backspace clears last, Enter submits
      document.addEventListener('keydown', function(e) {
        if (submitting) return;
        if (e.key >= '0' && e.key <= '9') { e.preventDefault(); handleDigit(e.key); }
        else if (e.key === 'Backspace') { e.preventDefault(); pin = pin.slice(0, -1); updateDots(); }
        else if (e.key === 'Enter') { e.preventDefault(); submitPin(); }
        else if (e.key === 'Escape') { e.preventDefault(); pin = ''; updateDots(); errEl.style.display = 'none'; }
      });
    })();
    ` : `
    document.getElementById('login-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var err = await doLogin(document.getElementById('pw').value);
      if (err) { errEl.textContent = err; errEl.style.display = 'block'; }
    });
    `}
  </script>
</body></html>`);
  });

  router.post("/api/login", async (req, res) => {
    const { password } = req.body;
    if (!AUTH_SECRET) return res.json({ ok: true });
    if (!password) return res.status(400).json({ error: (AUTH_MODE === "pin" ? "PIN" : "Password") + " required" });
    const providedBuf = Buffer.from(String(password));
    const expectedBuf = Buffer.from(AUTH_SECRET);
    if (providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      let timeout = 15;
      try {
        const r = await pool.query("SELECT session_timeout_minutes FROM user_settings WHERE id = 1");
        if (r.rows.length) timeout = r.rows[0].session_timeout_minutes;
      } catch {}
      req.session.authenticated = true;
      req.session.lastActivity = Date.now();
      req.session.timeoutMinutes = timeout;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: AUTH_MODE === "pin" ? "Invalid PIN" : "Invalid password" });
  });

  router.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  return router;
};
