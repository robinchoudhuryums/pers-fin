// ============================================================================
// Teller API — mTLS client for bank account access
// ============================================================================

const https = require("https");
const fs = require("fs");
const path = require("path");

const TELLER_API_BASE = "https://api.teller.io";
const TELLER_APP_ID = process.env.TELLER_APPLICATION_ID;
const TELLER_ENV = (process.env.TELLER_ENV || "sandbox").toLowerCase();
const TELLER_CERT_PATH = process.env.TELLER_CERT_PATH;
const TELLER_KEY_PATH = process.env.TELLER_KEY_PATH;

// Load TLS client certificate for mTLS
let tlsAgent = null;
function getTlsAgent() {
  if (tlsAgent) return tlsAgent;

  let cert, key;

  // Option 1: base64-encoded cert/key in env vars (recommended for PaaS)
  if (process.env.TELLER_CERT && process.env.TELLER_KEY) {
    console.log("[mTLS] Loading certificate from TELLER_CERT/TELLER_KEY env vars (base64)");
    cert = Buffer.from(process.env.TELLER_CERT, "base64");
    key = Buffer.from(process.env.TELLER_KEY, "base64");
  } else {
    // Option 2: file paths
    const certPath = path.resolve(TELLER_CERT_PATH || "./certificate.pem");
    const keyPath = path.resolve(TELLER_KEY_PATH || "./private_key.pem");
    console.log(`[mTLS] Loading certificate from files: ${certPath}, ${keyPath}`);

    if (!fs.existsSync(certPath)) {
      console.error(`[mTLS] ERROR: Certificate file not found: ${certPath}`);
      console.error(`[mTLS] cwd: ${process.cwd()}`);
      throw new Error(`Certificate file not found: ${certPath}`);
    }
    if (!fs.existsSync(keyPath)) {
      console.error(`[mTLS] ERROR: Private key file not found: ${keyPath}`);
      throw new Error(`Private key file not found: ${keyPath}`);
    }

    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
  }

  console.log(`[mTLS] Certificate loaded (${cert.length} bytes), key loaded (${key.length} bytes)`);
  tlsAgent = new https.Agent({ cert, key });
  return tlsAgent;
}

function tellerRequestOnce(url, authHeader, method, bodyData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method,
        agent: getTlsAgent(),
        timeout: 30000,
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          ...(bodyData ? { "Content-Length": Buffer.byteLength(bodyData) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400) {
            const err = new Error(`Teller API error ${res.statusCode}: ${text}`);
            err.status = res.statusCode;
            err.body = text;
            return reject(err);
          }
          if (res.statusCode === 204) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`Invalid JSON from Teller API: ${text}`));
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Teller API request timed out")); });
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function tellerRequest(endpoint, accessToken, options = {}) {
  const url = `${TELLER_API_BASE}${endpoint}`;
  const method = options.method || "GET";
  const authHeader = "Basic " + Buffer.from(accessToken + ":").toString("base64");
  const bodyData = options.body ? JSON.stringify(options.body) : null;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await tellerRequestOnce(url, authHeader, method, bodyData);
    } catch (err) {
      // Don't retry client errors (4xx) — only transient/network errors
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

module.exports = {
  TELLER_API_BASE,
  TELLER_APP_ID,
  TELLER_ENV,
  getTlsAgent,
  tellerRequest,
};
