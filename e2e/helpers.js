// ============================================================================
// Shared e2e helpers (cycle-8 E5a): the PIN login, the page-problem watcher and
// small API calls, used by pages.spec.js and behaviour.spec.js. Not a spec file
// (Playwright only runs *.spec.js).
// ============================================================================
const { expect } = require("@playwright/test");

const PIN = process.env.E2E_SHELL_PIN || "246810";
// Both apps' CSRF checks accept a JSON body or this header.
const HDR = { "X-Requested-With": "XMLHttpRequest" };

async function loginWithPin(page, pin = PIN) {
  await page.goto("/login");
  await expect(page.locator("#pin-pad .pin-key").first()).toBeVisible();
  for (const d of String(pin)) await page.locator('.pin-key[data-digit="' + d + '"]').click();
  await page.locator('.pin-key[data-action="go"]').click();
  await page.waitForURL(/\/per-sistant/);
}

// Collect what would make a page "broken": an uncaught exception, or a server
// error. 501 is expected (no AI key / push keys in the e2e environment).
// A console.error counts too (G2) — except the browser's own "Failed to load
// resource" line, which the response check above already judges (a 501 is
// expected; a 4xx is often the right answer to a sweep click).
function watch(page, label = () => "") {
  const problems = [];
  page.on("pageerror", (err) => problems.push(label() + "pageerror: " + err.message));
  page.on("response", (res) => {
    if (res.status() >= 500 && res.status() !== 501) problems.push(label() + res.status() + " " + res.url());
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/^Failed to load resource/.test(text)) return;
    problems.push(label() + "console.error: " + text);
  });
  return problems;
}

// A GET through the signed-in context, parsed; throws on a non-2xx.
async function apiJson(req, path) {
  const res = await req.get(path, { headers: HDR });
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

// A write through the signed-in context; throws on a non-2xx.
async function apiSend(req, method, path, data) {
  const res = await req[method](path, { headers: HDR, ...(data !== undefined ? { data } : {}) });
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

// A connection string for one of the scratch databases boot-server.js creates
// (perfin_e2e / persistent_e2e) — for the few rows no route can create.
const ADMIN_URL = process.env.E2E_DATABASE_URL || "postgres://postgres:ci@localhost:5432/postgres";
function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return u.toString();
}

// YYYY-MM-DD for a day offset from today (UTC — the e2e server runs on UTC).
function ymd(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

module.exports = { PIN, HDR, loginWithPin, watch, apiJson, apiSend, ymd, dbUrl };
