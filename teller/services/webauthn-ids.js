// ============================================================================
// WebAuthn credential ids (seams audit #3)
// ============================================================================
// @simplewebauthn/server v11 returns registrationInfo.credential.id as a
// base64url STRING. Registration used to store Buffer.from(id).toString(
// "base64url") — the base64url of that string's UTF-8 text — so no stored id
// matched the id an authenticator presents: allowCredentials named a credential
// that doesn't exist (the browser offered the cross-device QR instead of Face
// ID) and the verify lookup always missed. Ids are now stored as given.
//
// legacyCredentialId(stored) returns the real id hidden in a double-encoded
// row, or null when the row is already correct. A real id is the base64url of
// ≥16 random bytes; decoding it gives binary that is (practically) never itself
// a run of ≥16 base64url characters, so the check can't misfire on a good row.

const B64URL_RE = /^[A-Za-z0-9_-]{16,}$/;

function legacyCredentialId(stored) {
  if (typeof stored !== "string" || !B64URL_RE.test(stored)) return null;
  const inner = Buffer.from(stored, "base64url").toString("utf8");
  return B64URL_RE.test(inner) ? inner : null;
}

// One-shot repair, run inside the migration transaction: rewrite each
// double-encoded row to its real id (a row whose real id already exists is the
// stale duplicate and is removed). Idempotent — a repaired row no longer matches.
async function repairCredentialIds(client) {
  const rows = (await client.query("SELECT id, credential_id FROM webauthn_credentials")).rows;
  let repaired = 0;
  for (const r of rows) {
    const real = legacyCredentialId(r.credential_id);
    if (!real) continue;
    const dup = await client.query("SELECT 1 FROM webauthn_credentials WHERE credential_id = $1", [real]);
    if (dup.rows.length) await client.query("DELETE FROM webauthn_credentials WHERE id = $1", [r.id]);
    else await client.query("UPDATE webauthn_credentials SET credential_id = $1 WHERE id = $2", [real, r.id]);
    repaired += 1;
  }
  return repaired;
}

module.exports = { legacyCredentialId, repairCredentialIds };
