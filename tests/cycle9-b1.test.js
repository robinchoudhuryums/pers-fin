// ============================================================================
// Cycle 9 (Nov 2026 broad scan) — Batch 1: backups that can actually succeed
// ============================================================================
// F1  — .github/workflows/db-backup.yml verified each backup with
//       `gpg --decrypt "$out" | pg_restore --list` under pipefail. pg_restore
//       stops reading after the archive's table of contents, so for any dump
//       larger than one pipe buffer gpg died on a broken pipe and the step
//       failed BEFORE the upload — no backup could ever be produced from a real
//       database. The verify now decrypts to a file, then lists that file.
// F9  — deploy/vps/backup.sh had the same pipe with `|| true`, which threw
//       away gpg's exit status: a truncated file still counted as verified.
// F12 — pg_dump's error text (it names the database host) is no longer
//       printed into Actions logs; a set CALENDAR_FEED_TOKEN shorter than 24
//       characters is an operator-check warning.
//
// The two backup scripts are RUN here, in bash, with the real gpg and stubs
// for the Postgres tools (a `pg_restore --list` that — like the real one —
// reads only the start of its input). The behavioural tests skip where gpg or
// bash is missing; the source pins below them always run.
// ============================================================================
if (!process.env.NEON_DATABASE_URL) process.env.NEON_DATABASE_URL = "postgres://mock:mock@localhost/mock";
if (!process.env.TOKEN_ENCRYPTION_PASSPHRASE) process.env.TOKEN_ENCRYPTION_PASSPHRASE = "test-passphrase";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore" }).status === 0; } catch { return false; } };
// GNU stat / truncate too: the stubs (and backup.sh itself) use them.
const CAN_RUN = has("bash", ["-c", "stat -c %s / > /dev/null && command -v truncate > /dev/null"]) && has("gpg", ["--version"]);
const SKIP = CAN_RUN ? false : "bash, GNU coreutils and gpg are needed to run the backup scripts";
const REAL_GPG = CAN_RUN ? spawnSync("bash", ["-c", "command -v gpg"], { encoding: "utf8" }).stdout.trim() : "";

// A workflow env block ("KEY: |" at 6 spaces, body at 8) as a bash script.
function blockOf(yaml, key) {
  const lines = yaml.split("\n");
  const i = lines.findIndex((l) => l.trim() === key + ": |");
  assert.ok(i >= 0, key + " not found");
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() === "" || l.startsWith("        ")) out.push(l.slice(8));
    else break;
  }
  return out.join("\n");
}

function exe(file, body) {
  fs.writeFileSync(file, "#!/bin/bash\n" + body + "\n");
  fs.chmodSync(file, 0o755);
}

// A scratch directory with: a 2 MB incompressible "dump", a private gpg home
// (short path — gpg-agent's socket path is length-limited) and a bin/ of stubs.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9b1-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, "gh"), { mode: 0o700 });
  fs.mkdirSync(path.join(dir, "work"));
  fs.writeFileSync(path.join(dir, "dump.bin"), crypto.randomBytes(2 * 1024 * 1024));
  // gpg: the real one — but with TRUNCATE=1 an ENCRYPTED output is cut in half
  // afterwards (a damaged upload / a disk that filled up).
  exe(path.join(bin, "gpg"), [
    `"${REAL_GPG}" "$@"; rc=$?`,
    'if [ -n "$TRUNCATE" ] && [[ " $* " == *" --symmetric "* ]]; then',
    '  out=""; prev=""',
    '  for a in "$@"; do case "$prev" in --output|-o) out="$a";; esac; prev="$a"; done',
    '  [ -n "$out" ] && truncate -s $(( $(stat -c %s "$out") / 2 )) "$out"',
    "fi",
    "exit $rc",
  ].join("\n"));
  // pg_restore --list: reads only the START of its input (a file argument or
  // stdin), as the real one stops after the table of contents.
  exe(path.join(bin, "pg_restore"), [
    'if [ -n "$2" ]; then head -c 512 "$2" > /dev/null; else head -c 512 > /dev/null; fi',
    'echo "1; 1259 1 TABLE public transactions app"; echo "2; 1259 2 TABLE public user_settings app"',
    '[ -z "$PGR_FAIL" ]',
  ].join("\n"));
  return { dir, bin, gh: path.join(dir, "gh"), work: path.join(dir, "work"), dump: path.join(dir, "dump.bin") };
}
function cleanup(sb) {
  try { spawnSync("gpgconf", ["--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: sb.gh }, stdio: "ignore" }); } catch { /* no gpgconf — nothing to stop */ }
  fs.rmSync(sb.dir, { recursive: true, force: true });
}
function bash(script, { cwd, env }) {
  const r = spawnSync("bash", ["-e", "-c", script], { cwd, env, encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---------------------------------------------------------------------------
describe("F1 / F12 — db-backup.yml's backup_db, run in bash", { skip: SKIP }, () => {
  const HOST = "ep-quiet-secret-123456.us-east-2.aws.neon.tech";
  let sb, fn;
  before(() => {
    sb = sandbox();
    fn = blockOf(read(".github", "workflows", "db-backup.yml"), "BACKUP_FN");
    // pg_dump: writes the 2 MB dump to --file=…, or fails the way a real one
    // does — with the host in its message.
    exe(path.join(sb.bin, "pg_dump"), [
      'if [ -n "$DUMP_ERR" ]; then echo "$DUMP_ERR" >&2; exit 1; fi',
      `for a in "$@"; do case "$a" in --file=*) cp "${sb.dump}" "\${a#--file=}";; esac; done`,
    ].join("\n"));
  });
  after(() => cleanup(sb));
  const run = (extra = {}) => {
    for (const f of fs.readdirSync(sb.work)) fs.rmSync(path.join(sb.work, f), { force: true });
    return bash(fn + `\nbackup_db perfin "postgres://u:pw@${HOST}/db"\n`, {
      cwd: sb.work,
      env: { PATH: sb.bin + ":" + process.env.PATH, HOME: sb.dir, GNUPGHOME: sb.gh, BACKUP_PASSPHRASE: "correct horse", ...extra },
    });
  };
  const files = () => fs.readdirSync(sb.work).sort();

  it("the stubs reproduce the old failure: the decrypt-into-pg_restore pipe dies on a 2 MB dump", () => {
    const r = bash(
      'set -o pipefail\n' +
      `printf '%s' pw | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 --output big.gpg "${sb.dump}"\n` +
      "printf '%s' pw | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt big.gpg | pg_restore --list > /dev/null\n",
      { cwd: sb.work, env: { PATH: sb.bin + ":" + process.env.PATH, HOME: sb.dir, GNUPGHOME: sb.gh } });
    assert.notEqual(r.code, 0, "the pre-fix verify fails on a dump larger than a pipe buffer");
    assert.match(r.out, /Broken pipe/i);
  });

  it("a 2 MB dump is encrypted, verified and left as the only file", () => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /perfin-\d{4}-\d{2}-\d{2}\.dump\.gpg: [\d.]+M, verified \(decrypts in full \+ pg_restore --list\)/);
    assert.equal(files().length, 1, "no plaintext dump, no .verify, no .err left: " + files());
    assert.match(files()[0], /^perfin-\d{4}-\d{2}-\d{2}\.dump\.gpg$/);
    assert.ok(fs.statSync(path.join(sb.work, files()[0])).size > 2 * 1024 * 1024 - 4096);
  });

  it("a truncated encrypted file fails the step and is not left to upload", () => {
    const r = run({ TRUNCATE: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error::The encrypted perfin backup did not decrypt cleanly/);
    assert.deepEqual(files(), [], "neither the damaged .gpg nor a partial plaintext remains");
  });

  it("a file that decrypts but isn't a readable archive fails the step", () => {
    const r = run({ PGR_FAIL: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error::The perfin backup decrypted but is not a readable pg_dump archive/);
    assert.deepEqual(files(), []);
  });

  it("a failed pg_dump says which kind of failure it was and never prints the host (F12)", () => {
    const cases = [
      [`pg_dump: error: connection to server at "${HOST}" (3.14.15.92), port 5432 failed: FATAL:  password authentication failed for user "u"`, /refused the credentials/],
      [`pg_dump: error: could not translate host name "${HOST}" to address: Name or service not known`, /could not be reached/],
      [`pg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 18.0; pg_dump version: 17.2 (${HOST})`, /older than the database server/],
      [`pg_dump: error: query failed: ERROR:  permission denied for table transactions (${HOST})`, /cannot read every table/],
      [`pg_dump: error: something new went wrong on ${HOST}`, /on your own machine to see why/],
    ];
    for (const [stderr, expected] of cases) {
      const r = run({ DUMP_ERR: stderr });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /::error::pg_dump of the perfin database failed: /);
      assert.match(r.out, expected);
      assert.ok(!r.out.includes(HOST), "the host is never printed: " + r.out);
      assert.ok(!r.out.includes("3.14.15.92") && !/\bpw\b/.test(r.out), "nor an address or the password");
      assert.deepEqual(files(), [], "nothing left behind");
    }
  });
});

// ---------------------------------------------------------------------------
describe("F9 — deploy/vps/backup.sh, run in bash", { skip: SKIP }, () => {
  let sb, script, out;
  before(() => {
    sb = sandbox();
    out = path.join(sb.dir, "backups");
    // The script cd's to its own directory and reads ./.env there.
    script = path.join(sb.work, "backup.sh");
    fs.copyFileSync(path.join(ROOT, "deploy", "vps", "backup.sh"), script);
    fs.writeFileSync(path.join(sb.dir, "pass"), "correct horse", { mode: 0o600 });
    fs.writeFileSync(path.join(sb.work, ".env"),
      `BACKUP_PASSPHRASE_FILE=${path.join(sb.dir, "pass")}\nBACKUP_DIR=${out}\nBACKUP_REMOTE=\nBACKUP_HEALTHCHECK_URL=\n`);
    // docker compose exec -T db <tool> …: pg_dump streams the dump, pg_restore
    // reads only the start of stdin, psql records that the stamp was written.
    exe(path.join(sb.bin, "docker"), [
      'case " $* " in',
      `  *" pg_dump "*) cat "${sb.dump}";;`,
      `  *" pg_restore "*) "${path.join(sb.bin, "pg_restore")}" --list;;`,
      `  *" psql "*) echo stamped >> "${path.join(sb.dir, "stamps")}";;`,
      "  *) exit 64;;",
      "esac",
    ].join("\n"));
  });
  after(() => cleanup(sb));
  const run = (extra = {}) => {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(path.join(sb.dir, "stamps"), { force: true });
    return bash(`bash "${script}"`, { cwd: sb.work, env: { PATH: sb.bin + ":" + process.env.PATH, HOME: sb.dir, GNUPGHOME: sb.gh, ...extra } });
  };
  const kept = () => (fs.existsSync(out) ? fs.readdirSync(out).sort() : []);

  it("both databases are dumped, verified and stamped; no partial file is left", () => {
    const r = run();
    assert.equal(r.code, 0, r.out);
    assert.equal(kept().length, 2, String(kept()));
    assert.match(kept()[0], /^perfin-\d{4}-\d{2}-\d{2}\.dump\.gpg$/);
    assert.match(kept()[1], /^persistent-\d{4}-\d{2}-\d{2}\.dump\.gpg$/);
    assert.match(r.out, /perfin: [\d.]+M, 2 table entries/);
    assert.match(r.out, /backup OK/);
    assert.equal(fs.readFileSync(path.join(sb.dir, "stamps"), "utf8"), "stamped\n", "stamped once, after both");
  });

  it("a truncated encrypted file fails the run: not kept, not stamped (it used to count as verified)", () => {
    const r = run({ TRUNCATE: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /backup FAILED: perfin: the encrypted file did not decrypt cleanly/);
    assert.deepEqual(kept(), [], "the damaged file is never renamed into place and the plaintext copy is removed");
    assert.ok(!fs.existsSync(path.join(sb.dir, "stamps")), "no backup is recorded");
  });

  it("an archive with no tables still fails", () => {
    exe(path.join(sb.bin, "pg_restore"), "cat > /dev/null");
    const r = run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /verification read no tables/);
    assert.deepEqual(kept(), []);
  });
});

// ---------------------------------------------------------------------------
describe("F1 / F9 / F12 — the scripts' text (always runs)", () => {
  it("neither script pipes gpg's decrypt into pg_restore any more", () => {
    const yml = read(".github", "workflows", "db-backup.yml");
    const fn = blockOf(yml, "BACKUP_FN");
    assert.doesNotMatch(fn, /--decrypt[^\n]*\|\s*pg_restore/);
    assert.match(fn, /--decrypt --output "\$name\.verify" "\$out"/);
    assert.match(fn, /pg_restore --list "\$name\.verify"/);
    const sh = read("deploy", "vps", "backup.sh");
    const code = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(code, /-d "\$tmp"[^\n]*\n?[^\n]*\|\s*docker compose exec -T db pg_restore/);
    assert.match(code, /-o "\$plain" -d "\$tmp"/);
    assert.match(code, /pg_restore --list < "\$plain"/);
    assert.match(code, /plain="\$out\.plain\.partial"/, "named so fail()'s *.partial cleanup removes it");
  });

  it("pg_dump's stderr goes to a file that is removed, never to the log", () => {
    const fn = blockOf(read(".github", "workflows", "db-backup.yml"), "BACKUP_FN");
    assert.match(fn, /pg_dump "\$url"[^\n]*2> "\$name\.err"/);
    assert.doesNotMatch(fn, /cat "\$name\.err"/);
    assert.match(fn, /rm -f "\$name\.dump" "\$name\.err"/);
    assert.doesNotMatch(fn, /echo[^\n]*\$url/);
  });
});

// ---------------------------------------------------------------------------
describe("F12 — CALENDAR_FEED_TOKEN's length is an operator check", () => {
  const oc = require("../teller/services/operator-checks");
  const feed = async (env) => (await oc.goLiveChecks({ env })).find((c) => c.id === "local:calendar-feed");

  it("a short token warns without showing it; a long one is ok; unset is left to the local note", async () => {
    const short = await feed({ CALENDAR_FEED_TOKEN: "hunter2-feed" });
    assert.equal(short.status, "warn");
    assert.match(short.detail, /shorter than 24 characters/);
    assert.ok(!JSON.stringify(short).includes("hunter2"), "never the value");
    assert.ok(!/\b12\b/.test(short.detail), "nor its exact length (INV-126)");
    assert.match(short.fix, /openssl rand -hex 32/);

    const long = await feed({ CALENDAR_FEED_TOKEN: "a".repeat(24) });
    assert.equal(long.status, "ok");
    assert.equal(await feed({}), undefined);
    assert.equal(await feed({ CALENDAR_FEED_TOKEN: "   " }), undefined, "blank counts as unset");
    // Unset: localChecks' info note is the only calendar-feed entry.
    assert.equal(oc.localChecks({}).filter((c) => c.id === "local:calendar-feed").length, 1);
    assert.equal(oc.localChecks({ CALENDAR_FEED_TOKEN: "x" }).filter((c) => c.id === "local:calendar-feed").length, 0);
  });

  it("a short token reaches data-health as a warning", async () => {
    const issues = oc.toIssues({ checks: await oc.goLiveChecks({ env: { CALENDAR_FEED_TOKEN: "short" } }), github: { pending: true } });
    const issue = issues.find((i) => i.check === "local:calendar-feed");
    assert.deepEqual([issue.severity, issue.source], ["warning", "operator"]);
    assert.match(issue.message, /^Calendar feed: CALENDAR_FEED_TOKEN is shorter than 24 characters/);
  });
});
