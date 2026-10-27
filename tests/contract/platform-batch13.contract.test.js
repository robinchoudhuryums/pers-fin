// Real-Postgres contract tests for cycle-7 Batch 13 (platform hardening + the
// behaviours that only had source-regex pins, F138):
//   F9   — Perfin's own responses carry COOP same-origin-allow-popups (INV-62)
//   F10  — migrations serialize on an advisory lock; a lock held past
//          lock_timeout fails with 55P03, is retried, and succeeds once freed
//   F12  — "Sign out everywhere" bumps user_settings.shell_session_epoch and
//          every cookie minted before it is refused; a legacy (pre-epoch)
//          cookie is still valid at epoch 0
//   F138 — SSO validate rejects a replayed token and a bad signature doesn't
//          burn the nonce; perfin_try_decrypt returns NULL (never raises) for
//          a token encrypted under another passphrase (INV-22)
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const supertest = require("supertest");
const { SKIP, perfinDb, ROOT } = require("./_setup");

describe("Platform Batch 13 on real Postgres", { skip: SKIP }, () => {
  let pool, database;
  const q = (s, p) => pool.query(s, p);

  before(async () => {
    process.env.SESSION_PIN = "24681357";
    process.env.SSO_SECRET = "contract-sso-secret";
    process.env.SHELL_SECRET = "contract-shell-secret";
    pool = await perfinDb("batch13");
    database = require(ROOT + "/teller/services/database");
  });
  after(async () => { if (pool) await pool.end(); });

  it("F9: Perfin's helmet sends COOP same-origin-allow-popups (Plaid/Teller Link popups)", async () => {
    const { app } = require(ROOT + "/teller/server");
    const r = await supertest(app).get("/health");
    assert.equal(r.headers["cross-origin-opener-policy"], "same-origin-allow-popups");
  });

  it("F138: SSO validate — a replay is refused; a bad signature doesn't burn the nonce", async () => {
    const { app } = require(ROOT + "/teller/server");
    const ts = Date.now();
    const nonce = crypto.randomBytes(12).toString("hex");
    const payload = `sso:${ts}:${nonce}`;
    const good = payload + ":" + crypto.createHmac("sha256", process.env.SSO_SECRET).update(payload).digest("hex");
    const forged = payload + ":" + crypto.createHmac("sha256", "wrong").update(payload).digest("hex");
    const bad = await supertest(app).post("/api/sso/validate").set("X-Requested-With", "XMLHttpRequest").send({ token: forged });
    assert.equal(bad.status, 401);
    assert.match(bad.body.error, /Invalid token/);
    const ok = await supertest(app).post("/api/sso/validate").set("X-Requested-With", "XMLHttpRequest").send({ token: good });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.headers["set-cookie"], "a session cookie is issued");
    const replay = await supertest(app).post("/api/sso/validate").set("X-Requested-With", "XMLHttpRequest").send({ token: good });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /already used/);
  });

  it("F138 / INV-22: perfin_try_decrypt returns NULL for another passphrase and garbage, the value for the right one", async () => {
    const r = (await q(`SELECT
        perfin_try_decrypt(pgp_sym_encrypt('tok-123', 'key-a'), 'key-a') AS right,
        perfin_try_decrypt(pgp_sym_encrypt('tok-123', 'key-a'), 'key-b') AS wrong,
        perfin_try_decrypt('\\x00010203'::bytea, 'key-a') AS garbage`)).rows[0];
    assert.deepEqual(r, { right: "tok-123", wrong: null, garbage: null });
  });

  describe("F10: migration locking", () => {
    it("two concurrent runs serialize and both succeed", async () => {
      await Promise.all([database.runMigrations(), database.runMigrations()]);
      assert.equal((await q("SELECT count(*)::int AS n FROM user_settings")).rows[0].n, 1);
    });

    it("a table lock held past lock_timeout fails with 55P03 (no retries left) and is retried to success once freed", async () => {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE user_settings IN ACCESS EXCLUSIVE MODE");
        await assert.rejects(database.runMigrations({ attempts: 1 }), (err) => err.code === "55P03");
        let slept = 0;
        await database.runMigrations({
          attempts: 3,
          sleep: async () => { slept++; await holder.query("ROLLBACK"); },
        });
        assert.equal(slept, 1, "one retry after the lock was released");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
    });
  });

  describe("F12: shell session epoch", () => {
    let app, auth;
    const cookieOf = (res) => (res.headers["set-cookie"] || []).find((c) => c.startsWith("shell_session="));
    const legacy = (expires) => {
      const v = String(expires);
      return v + "." + crypto.createHmac("sha256", process.env.SHELL_SECRET).update(v).digest("hex");
    };

    before(() => {
      const express = require("express");
      auth = require(ROOT + "/shell/middleware/auth");
      auth.init({ pool });
      app = express();
      app.use(require("cookie-parser")());
      app.post("/logout", auth.handleLogout);
      app.get("/api/x", auth.requireAuth, (req, res) => res.json({ ok: true }));
      app.get("/mint", async (req, res) => { const idle = await auth.getIdleMs(); auth.setSessionCookie(res, idle); res.json({ ok: true }); });
    });

    it("a cookie minted before 'sign out everywhere' is refused afterwards; a new one works", async () => {
      const startEpoch = (await q("SELECT shell_session_epoch FROM user_settings")).rows[0].shell_session_epoch;
      assert.equal(startEpoch, 0);
      const a = cookieOf(await supertest(app).get("/mint")).split(";")[0];
      const old = "shell_session=" + legacy(Date.now() + 3600e3);
      await supertest(app).get("/api/x").set("Cookie", a).expect(200);
      await supertest(app).get("/api/x").set("Cookie", old).expect(200); // legacy cookie = epoch 0

      await supertest(app).post("/logout?everywhere=1").expect(401); // needs a valid session
      const out = await supertest(app).post("/logout?everywhere=1").set("Cookie", a);
      assert.equal(out.status, 302);
      assert.equal((await q("SELECT shell_session_epoch FROM user_settings")).rows[0].shell_session_epoch, 1);

      assert.notEqual((await supertest(app).get("/api/x").set("Cookie", a)).status, 200, "pre-bump cookie refused");
      assert.notEqual((await supertest(app).get("/api/x").set("Cookie", old)).status, 200, "legacy cookie refused too");
      const b = cookieOf(await supertest(app).get("/mint")).split(";")[0];
      await supertest(app).get("/api/x").set("Cookie", b).expect(200);
    });

    it("a plain sign-out clears only this cookie and leaves the epoch alone", async () => {
      const b = cookieOf(await supertest(app).get("/mint")).split(";")[0];
      const r = await supertest(app).post("/logout").set("Cookie", b);
      assert.equal(r.status, 302);
      assert.equal((await q("SELECT shell_session_epoch FROM user_settings")).rows[0].shell_session_epoch, 1);
      await supertest(app).get("/api/x").set("Cookie", b).expect(200);
    });
  });
});
