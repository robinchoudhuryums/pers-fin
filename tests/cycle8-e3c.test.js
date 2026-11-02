// ============================================================================
// Cycle 8 E3c (G2) — the Settings section and the bell
// ============================================================================
// Settings → Alerts & Notifications → Quiet Hours & Muting, run in a vm from
// settings.ejs: the switch, the two times and the zone filled from GET
// /api/settings; a checkbox per mutable kind grouped by app (Per-sistant's only
// under the shell; security / test never listed; escaped); the switch, Save
// times and each box saved through PATCH /api/settings + writeOk, a refused or
// failed save putting the control back, an empty or equal pair of times refused
// before any request; the markup's labels, its place in the group and its
// wiring. The bell (partials/nav.ejs renderList, in a vm) names a held,
// expired or muted push. Per-sistant's half is
// apps/per-sistant/tests/cycle8-e3c.test.js.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const KINDS = require("../teller/services/notify-prefs").catalog();

// ---------------------------------------------------------------------------
describe("Settings → Quiet Hours & Muting (in a vm)", () => {
  const src = read("teller", "views", "settings.ejs");
  const start = src.indexOf("// Quiet hours & muting (cycle-8 E3c");
  const end = src.indexOf("async function loadSettings() {");

  function load({ status = 200, throws = false } = {}) {
    const el = (extra = {}) => ({ checked: false, value: "", textContent: "", innerHTML: "", ...extra });
    const boxes = [];
    const els = {
      "quiet-toggle": el(), "quiet-start": el(), "quiet-end": el(), "quiet-tz": el(),
      "mute-list": el({ querySelectorAll: () => boxes }),
    };
    const calls = [], msgs = [];
    const ctx = {
      document: { getElementById: (id) => els[id] || null },
      esc, JSON, Array,
      apiFetch: async (url, opts) => {
        if (throws) throw new Error("offline");
        calls.push([url, opts.method, JSON.parse(opts.body)]);
        return { ok: status < 300, status, json: async () => (status < 300 ? {} : { error: "notify_quiet_hours.start and end must differ" }) };
      },
      writeOk: async (res, what) => {
        if (res.ok) return true;
        const b = await res.json();
        msgs.push([what + ": " + b.error, false]);
        return false;
      },
      showMsg: (t, ok) => msgs.push([t, ok]),
    };
    assert.ok(start > 0 && end > start, "the block sits just before loadSettings");
    vm.runInNewContext(src.slice(start, end), ctx);
    return { ctx, els, calls, msgs, boxes };
  }
  const box = (key, checked) => ({ checked, getAttribute: (a) => (a === "data-mute" ? key : null) });

  it("fills the switch, the times, the zone and a box per mutable kind — Perfin's always, Per-sistant's under the shell", () => {
    const { ctx, els } = load();
    ctx.renderNotifyPrefs({ notify_quiet_hours: { enabled: true, start: "23:00", end: "06:30" }, notify_muted_types: ["jobs", "spending"], notify_kinds: KINDS, notify_timezone: "America/Chicago", embedded: true });
    assert.equal(els["quiet-toggle"].checked, true);
    assert.deepEqual([els["quiet-start"].value, els["quiet-end"].value, els["quiet-tz"].textContent], ["23:00", "06:30", "America/Chicago"]);
    const html = els["mute-list"].innerHTML;
    assert.match(html, /<div class="desc"[^>]*>Perfin<\/div>/);
    assert.match(html, /<div class="desc"[^>]*>Per-sistant<\/div>/);
    assert.match(html, /<input type="checkbox" id="mute-spending" data-mute="spending" checked> <label for="mute-spending">Unusual charges and budget alerts<\/label>/);
    assert.match(html, /id="mute-jobs" data-mute="jobs" checked>/);
    assert.match(html, /id="mute-cash" data-mute="cash"> /, "an unmuted kind unchecked");
    assert.doesNotMatch(html, /mute-security|mute-test/, "security and test can't be muted");
    assert.ok(html.indexOf(">Perfin<") < html.indexOf(">Per-sistant<"));

    ctx.renderNotifyPrefs({ notify_kinds: KINDS, embedded: false });
    assert.doesNotMatch(els["mute-list"].innerHTML, /Per-sistant|mute-tasks/, "standalone: Perfin's kinds only");
    assert.equal(els["quiet-toggle"].checked, false, "defaults: off");
    assert.deepEqual([els["quiet-start"].value, els["quiet-end"].value, els["quiet-tz"].textContent], ["22:00", "07:00", "UTC"]);
  });

  it("escapes kind labels", () => {
    const { ctx, els } = load();
    ctx.renderNotifyPrefs({ notify_kinds: [{ key: "x", label: "<b>&", app: "perfin", mutable: true }] });
    assert.match(els["mute-list"].innerHTML, /<label for="mute-x">&lt;b&gt;&amp;<\/label>/);
  });

  it("the switch and Save times send the whole window; a refused switch goes back", async () => {
    const { ctx, els, calls, msgs } = load();
    els["quiet-start"].value = "22:30"; els["quiet-end"].value = "06:00";
    const toggle = els["quiet-toggle"]; toggle.checked = true;
    assert.equal(await ctx.onQuietToggle(toggle), true);
    els["quiet-end"].value = "07:15";
    assert.equal(await ctx.saveQuietTimes(), true);
    assert.deepEqual(calls, [
      ["/api/settings", "PATCH", { notify_quiet_hours: { enabled: true, start: "22:30", end: "06:00" } }],
      ["/api/settings", "PATCH", { notify_quiet_hours: { enabled: true, start: "22:30", end: "07:15" } }],
    ]);
    assert.deepEqual(msgs, [["Setting saved.", true], ["Setting saved.", true]]);

    const refused = load({ status: 400 });
    refused.els["quiet-start"].value = "22:00"; refused.els["quiet-end"].value = "07:00";
    const t = refused.els["quiet-toggle"]; t.checked = true;
    assert.equal(await refused.ctx.onQuietToggle(t), false);
    assert.equal(t.checked, false, "put back");
    assert.deepEqual(refused.msgs, [["Quiet hours & muting: notify_quiet_hours.start and end must differ", false]]);

    const offline = load({ throws: true });
    offline.els["quiet-start"].value = "22:00"; offline.els["quiet-end"].value = "07:00";
    const o = offline.els["quiet-toggle"]; o.checked = false;
    assert.equal(await offline.ctx.onQuietToggle(o), false);
    assert.equal(o.checked, true);
    assert.match(offline.msgs[0][0], /^Quiet hours & muting: offline$/);
  });

  it("an empty or equal pair of times is refused before any request (the switch put back)", async () => {
    const { ctx, els, calls, msgs } = load();
    els["quiet-start"].value = ""; els["quiet-end"].value = "07:00";
    assert.equal(await ctx.saveQuietTimes(), false);
    els["quiet-start"].value = "07:00";
    const toggle = els["quiet-toggle"]; toggle.checked = true;
    assert.equal(await ctx.onQuietToggle(toggle), false);
    assert.equal(toggle.checked, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(msgs.map((m) => m[0]), ["Enter a start and an end time", "The start and end times must differ"]);
  });

  it("a mute box sends every checked kind; a refused save puts it back", async () => {
    const { ctx, calls, boxes } = load();
    boxes.push(box("spending", true), box("jobs", false), box("cash", true));
    assert.equal(await ctx.onMuteToggle(boxes[2]), true);
    assert.deepEqual(calls, [["/api/settings", "PATCH", { notify_muted_types: ["spending", "cash"] }]]);

    const refused = load({ status: 400 });
    const b = box("cash", true);
    refused.boxes.push(b);
    assert.equal(await refused.ctx.onMuteToggle(b), false);
    assert.equal(b.checked, false);
  });

  it("the markup: labelled controls in Alerts & Notifications, before Cash Alerts; wired and filled on load", () => {
    const group = src.slice(src.indexOf('id="group-alerts"'), src.indexOf('id="group-sync"'));
    const section = group.slice(group.indexOf('id="quiet-hours-section"'), group.indexOf('id="cash-alerts-section"'));
    assert.ok(section.length > 0, "inside the group, before Cash Alerts");
    assert.match(section, /<input type="checkbox" id="quiet-toggle" aria-label="Quiet hours">/);
    assert.match(section, /<input type="time" id="quiet-start" aria-label="Quiet hours start">/);
    assert.match(section, /<input type="time" id="quiet-end" aria-label="Quiet hours end">/);
    assert.match(section, /<button class="btn" id="quiet-save">Save times<\/button>/);
    assert.match(section, /<div id="mute-list"/);
    assert.match(src, /\['quiet-toggle', 'change', function\(\) \{ onQuietToggle\(this\); \}\]/);
    assert.match(src, /\['quiet-save', 'click', function\(\) \{ saveQuietTimes\(\); \}\]/);
    assert.match(src, /\['mute-list', 'change', function\(e\) \{ if \(e\.target && e\.target\.getAttribute && e\.target\.getAttribute\('data-mute'\)\) onMuteToggle\(e\.target\); \}\]/);
    assert.match(src, /renderLinkedTasks\(s\);\n\s+renderNotifyPrefs\(s\);/);
  });
});

// ---------------------------------------------------------------------------
describe("the bell names a push that didn't go out (nav.ejs, in a vm)", () => {
  const src = read("teller", "views", "partials", "nav.ejs");
  const start = src.indexOf("var PUSH_STATE_WORDS");
  const end = src.indexOf("var backdrop = document.getElementById('notif-backdrop');");
  function render(notifs) {
    const list = { innerHTML: "" };
    const ctx = { list, esc, Date, Math };
    vm.runInNewContext(src.slice(start, end) + "\nrenderList(__n);", { ...ctx, __n: notifs });
    return list.innerHTML;
  }
  const n = (push_state) => ({ id: 1, title: "Low cash ahead", body: "b", is_read: false, created_at: new Date().toISOString(), push_state, data: {} });

  it("held / expired / muted say so; sent, none and older rows say nothing more", () => {
    assert.ok(start > 0 && end > start);
    assert.match(render([n("held")]), /just now · Held for quiet hours<\/div>/);
    assert.match(render([n("expired")]), /just now · Held for quiet hours — not pushed<\/div>/);
    assert.match(render([n("muted")]), /just now · Muted — not pushed<\/div>/);
    for (const s of ["sent", "none", null, undefined]) assert.match(render([n(s)]), /just now<\/div>/, String(s));
  });
});
