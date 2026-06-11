// Playwright browser smokes — the layer the unit suite can't cover: real
// login flow, real pages in a real browser, against a real (scratch) DB.
// Run: npm run test:e2e   (needs a local Postgres; see e2e/boot-server.js)
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node e2e/boot-server.js",
    cwd: require("path").join(__dirname, ".."),
    url: "http://localhost:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
