const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

module.exports = function ({ pool, views, config }) {
  const router = require("express").Router();
  const { pageHead, themeScript, nonceAttr } = views;
  const { AUTH_SECRET, AUTH_MODE, SESSION_PASSWORD, SESSION_PIN } = config;

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
  /* ── Cosmic login reveal ── */
  @keyframes loginFadeOut {
    0% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes cosmicMaskReveal {
    0%   { clip-path: inset(0 0 100% 0); opacity: 0; }
    8%   { opacity: 1; }
    100% { clip-path: inset(0 0 0% 0); opacity: 1; }
  }
  @keyframes cosmicScanLine {
    0%   { top: 0%; opacity: 0; }
    8%   { opacity: 1; }
    92%  { opacity: 1; }
    100% { top: 100%; opacity: 0; }
  }
  @keyframes cosmicHaloIn {
    0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.8); }
    100% { opacity: 1; transform: translate(-50%,-50%) scale(1); }
  }
  @keyframes cosmicHaloPulse {
    0%, 100% { filter: drop-shadow(0 0 12px rgba(168,140,220,0.45)) drop-shadow(0 0 24px rgba(212,165,116,0.25)); }
    50%      { filter: drop-shadow(0 0 28px rgba(168,140,220,0.75)) drop-shadow(0 0 48px rgba(212,165,116,0.45)); }
  }
  @keyframes cosmicNebula {
    0%, 100% { opacity: 0.55; transform: translate(-50%,-50%) scale(1); }
    50%      { opacity: 0.85; transform: translate(-50%,-50%) scale(1.08); }
  }
  @keyframes cosmicRingSpin {
    from { transform: translate(-50%,-50%) rotate(0deg); }
    to   { transform: translate(-50%,-50%) rotate(360deg); }
  }
  @keyframes cosmicTwinkle {
    0%, 100% { opacity: 0.15; transform: scale(0.8); }
    50%      { opacity: 1;    transform: scale(1.2); }
  }
  .login-success-overlay {
    display: none; position: fixed; inset: 0;
    background: radial-gradient(ellipse at center,
      color-mix(in oklch, var(--paper) 92%, #0b0820) 0%,
      var(--paper) 75%);
    z-index: 1000;
    align-items: center; justify-content: center;
    flex-direction: column; gap: 36px;
  }
  .login-success-overlay.active { display: flex; animation: loginFadeOut 0.5s ease 2.6s forwards; }
  .cosmic-stage {
    position: relative; width: 220px; height: 220px;
    display: flex; align-items: center; justify-content: center;
  }
  /* Nebula glow — soft radial pulse behind the mask */
  .cosmic-nebula {
    position: absolute; left: 50%; top: 50%;
    width: 320px; height: 320px;
    transform: translate(-50%,-50%);
    background:
      radial-gradient(circle at 30% 35%, rgba(168,140,220,0.55) 0%, transparent 55%),
      radial-gradient(circle at 70% 65%, rgba(212,165,116,0.40) 0%, transparent 55%),
      radial-gradient(circle at 50% 50%, rgba(95,191,191,0.18) 0%, transparent 70%);
    filter: blur(20px);
    animation: cosmicNebula 3.4s ease-in-out infinite;
    pointer-events: none;
  }
  /* Slow rotating ring behind the mask */
  .cosmic-ring {
    position: absolute; left: 50%; top: 50%;
    width: 200px; height: 200px;
    border: 1px solid rgba(168,140,220,0.35);
    border-radius: 50%;
    transform: translate(-50%,-50%);
    animation: cosmicRingSpin 12s linear infinite;
    pointer-events: none;
  }
  .cosmic-ring::before {
    content: ''; position: absolute; left: 50%; top: -3px;
    width: 6px; height: 6px; background: rgba(212,165,116,0.9);
    border-radius: 50%; transform: translateX(-50%);
    box-shadow: 0 0 8px rgba(212,165,116,0.8);
  }
  /* Starfield container — stars are individual divs to allow stagger */
  .cosmic-stars {
    position: absolute; left: 50%; top: 50%;
    width: 380px; height: 380px;
    transform: translate(-50%,-50%);
    pointer-events: none;
  }
  .cosmic-stars span {
    position: absolute; width: 2px; height: 2px;
    background: #fff; border-radius: 50%;
    box-shadow: 0 0 4px rgba(255,255,255,0.7);
    animation: cosmicTwinkle 2.4s ease-in-out infinite;
  }
  /* Mask wrapper */
  .cosmic-mask-wrap {
    position: relative; width: 160px; height: 160px;
    transform: translate(-50%,-50%); left: 50%; top: 50%;
    animation: cosmicHaloIn 0.6s ease forwards, cosmicHaloPulse 2.6s ease-in-out 0.6s infinite;
  }
  .cosmic-mask-wrap img {
    width: 100%; height: 100%; object-fit: contain; display: block;
    /* Top-to-bottom reveal */
    animation: cosmicMaskReveal 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.2s both;
  }
  /* Glowing horizontal scan line riding the reveal edge */
  .cosmic-scanline {
    position: absolute; left: -8%; right: -8%; top: 0; height: 2px;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(168,140,220,0.9) 30%,
      rgba(212,165,116,1) 50%,
      rgba(168,140,220,0.9) 70%,
      transparent 100%);
    box-shadow: 0 0 12px rgba(168,140,220,0.9), 0 0 24px rgba(212,165,116,0.6);
    animation: cosmicScanLine 1.4s cubic-bezier(0.4, 0, 0.2, 1) 0.2s forwards;
    pointer-events: none;
  }
  .login-success-overlay .welcome-text {
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    letter-spacing: 0.3em; text-transform: uppercase; opacity: 0;
    animation: fadeInUp 0.5s ease 1.5s forwards;
  }
  @media (prefers-reduced-motion: reduce) {
    .cosmic-mask-wrap img,
    .cosmic-scanline,
    .cosmic-nebula,
    .cosmic-ring,
    .cosmic-stars span,
    .cosmic-mask-wrap { animation: none !important; }
    .cosmic-mask-wrap img { clip-path: inset(0); opacity: 1; }
    .cosmic-scanline { display: none; }
  }
</style>
  <div class="login-success-overlay" id="login-success">
    <div class="cosmic-stage">
      <div class="cosmic-stars" id="cosmic-stars"></div>
      <div class="cosmic-nebula"></div>
      <div class="cosmic-ring"></div>
      <div class="cosmic-mask-wrap">
        <img src="/android-chrome-mask-crop.png" alt="" aria-hidden="true">
        <div class="cosmic-scanline"></div>
      </div>
    </div>
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
  <script${nonceAttr()}>
    // Generate randomized starfield for the cosmic login reveal. Stars are
    // scattered across the 380x380 backdrop with staggered twinkle delays so
    // they don't all flash in lockstep. Cap the count modestly to keep the
    // overlay cheap on low-end devices.
    (function() {
      var box = document.getElementById('cosmic-stars');
      if (!box) return;
      var count = 32;
      var html = '';
      for (var i = 0; i < count; i++) {
        var x = Math.random() * 100;
        var y = Math.random() * 100;
        var size = (Math.random() * 1.6 + 1).toFixed(2);
        var delay = (Math.random() * 2.4).toFixed(2);
        var dur = (Math.random() * 1.6 + 1.6).toFixed(2);
        html += '<span style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) +
                '%;width:' + size + 'px;height:' + size +
                'px;animation-delay:' + delay + 's;animation-duration:' + dur + 's;"></span>';
      }
      box.innerHTML = html;
    })();
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
          if (overlay && overlay.querySelector('.cosmic-mask-wrap')) {
            overlay.classList.add('active');
            // Cosmic reveal: ~1.6s reveal + 1s halo hold + 0.5s fadeout
            setTimeout(function() { window.location.href = '/'; }, 3000);
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
