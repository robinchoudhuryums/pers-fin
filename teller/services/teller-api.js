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

async function tellerRequest(endpoint, accessToken, options = {}) {
  const url = `${TELLER_API_BASE}${endpoint}`;
  const method = options.method || "GET";

  const authHeader = "Basic " + Buffer.from(accessToken + ":").toString("base64");
  const bodyData = options.body ? JSON.stringify(options.body) : null;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method,
        agent: getTlsAgent(),
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          ...options.headers,
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
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

module.exports = {
  TELLER_API_BASE,
  TELLER_APP_ID,
  TELLER_ENV,
  getTlsAgent,
  tellerRequest,
};
