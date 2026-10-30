// Playwright browser smokes — the layer the unit suite can't cover: real
// login flow, real pages in a real browser, against a real (scratch) DB.
// Run: npm run test:e2e   (needs a local Postgres; see e2e/boot-server.js)
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 30000,
  // One file at a time (cycle-8 E5a): behaviour.spec.js changes rows and puts
  // them back, and the click sweep in pages.spec.js presses Dismiss / Cancel /
  // Save on whatever rows a page shows — the two must never run side by side.
  // CI's 2-core runner already ran one worker.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    // PW_CHROMIUM_PATH points at a preinstalled Chromium when the pinned
    // Playwright build isn't installed (e.g. /opt/pw-browsers/chromium in a
    // Claude Code cloud container). Unset in CI.
    ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: "node e2e/boot-server.js",
    cwd: require("path").join(__dirname, ".."),
    url: "http://localhost:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
