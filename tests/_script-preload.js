// Preload for tests that RUN a script from scripts/ as a child process
// (node -r tests/_script-preload.js scripts/<name>.js). It swaps three modules
// so the script can be executed for real without a database, a .env file or
// Google:
//
//   dotenv      config() applies FAKE_DOTENV (a JSON object) to process.env —
//               the test's stand-in for the repo's .env, which is never read
//   pg          new Pool(opts) prints "POOL <json of opts.ssl>" and exits 0 —
//               the run stops at the moment the script would have connected
//   googleapis  a client whose GoogleAuth prints "AUTH <keyFile basename>"
//
// Not a test file (the runner's glob is tests/*.test.js).
"use strict";
const Module = require("module");
const path = require("path");

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "dotenv") {
    return {
      config() {
        if (process.env.FAKE_DOTENV) Object.assign(process.env, JSON.parse(process.env.FAKE_DOTENV));
        return { parsed: {} };
      },
    };
  }
  if (request === "pg") {
    function Pool(opts) {
      process.stdout.write("POOL " + JSON.stringify({ ssl: opts && opts.ssl, url: !!(opts && opts.connectionString) }) + "\n");
      process.exit(0);
    }
    return { Pool, Client: Pool };
  }
  if (request === "googleapis") {
    class GoogleAuth {
      constructor(o) { process.stdout.write("AUTH " + path.basename(String(o && o.keyFile)) + "\n"); }
      async getClient() { return {}; }
    }
    return { google: { auth: { GoogleAuth }, sheets: () => ({ spreadsheets: { values: {} } }) } };
  }
  return realLoad.call(this, request, parent, isMain);
};
