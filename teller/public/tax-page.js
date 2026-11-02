// ============================================================================
// The Tax page (roadmap T3.3 K4) — /tax
// ============================================================================
// One calendar year's tax package (GET /api/tax/package — computed on request,
// never stored) as a card per section with its totals and a CSV link, the PDF /
// ZIP downloads, and the documents checklist (GET/POST/PATCH/DELETE
// /api/tax/documents, POST /api/tax/documents/suggest). The year defaults to
// last year from January to April, else this year (taxSeason, perfin-shared.js);
// ?year= overrides it and follows the select. Every write goes through writeOk.
// Uses the globals perfin-shared.js sets (apiFetch, writeOk, esc, withBase,
// showMsg, localTodayStr, taxSeason), so it loads after it.
(function (win) {
  "use strict";

  var SECTIONS = [
    { key: "income", title: "Income" },
    { key: "investment_income", title: "Investment income" },
    { key: "realized_gains", title: "Realized gains (estimate)" },
    { key: "retirement", title: "Retirement distributions" },
    { key: "deductions", title: "Deductions" },
    { key: "rent_paid", title: "Rent and utilities paid" },
  ];
  var MIN_YEAR = 2000;
  var YEARS_LISTED = 7;

  function money(n) {
    if (n == null || n === "" || !isFinite(Number(n))) return "—";
    var v = Number(n);
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ?year= when it's a whole year from 2000 to this year, else the season's year.
  function initialYear(search, today) {
    var max = parseInt(String(today).slice(0, 4), 10);
    var q = null;
    try { q = new URLSearchParams(search || "").get("year"); } catch (e) { q = null; } // a malformed query string: use the default
    if (q && /^\d{4}$/.test(q)) {
      var y = parseInt(q, 10);
      if (y >= MIN_YEAR && y <= max) return y;
    }
    return win.taxSeason(today).year;
  }

  // This year back YEARS_LISTED years, plus the selected year if it's older.
  function yearOptions(maxYear, selected) {
    var years = [];
    for (var y = maxYear; y > maxYear - YEARS_LISTED && y >= MIN_YEAR; y--) years.push(y);
    if (years.indexOf(selected) === -1) years.push(selected);
    return years.map(function (y) {
      return '<option value="' + y + '"' + (y === selected ? " selected" : "") + ">" + y + "</option>";
    }).join("");
  }

  function packageHref(year, format, section) {
    return win.withBase("/api/tax/package?year=" + year + "&format=" + format +
      (section ? "&section=" + encodeURIComponent(section) : ""));
  }

  function row(label, value) {
    return "<li><span>" + win.esc(label) + "</span><span>" + win.esc(value) + "</span></li>";
  }

  // Each section's body; s is the package section ({ ok: true, … }).
  var BODIES = {
    income: function (s) {
      var k = s.by_kind || {};
      return '<div class="big">' + money(s.total) + "</div><ul>" +
        row("Wages", money(k.wages)) + row("Interest", money(k.interest)) +
        row("Dividends", money(k.dividends)) + row("Other", money(k.other)) + "</ul>" +
        ((s.by_source || []).length ? "<ul>" + s.by_source.slice(0, 8).map(function (r) {
          return row(r.source + " (" + r.kind + ")", money(r.total));
        }).join("") + "</ul>" : "") +
        '<p class="tax-note">A deposit on a shared account counts at your share.</p>';
    },
    investment_income: function (s) {
      var t = s.totals || {};
      if (!(s.accounts || []).length) return '<p class="tax-note">None recorded. Only Plaid-linked investment accounts have transactions.</p>';
      return '<div class="big">' + money((t.dividends || 0) + (t.interest || 0) + (t.capital_gain_distributions_long || 0) + (t.capital_gain_distributions_short || 0)) + "</div><ul>" +
        row("Dividends", money(t.dividends)) + row("Qualified dividends", money(t.qualified_dividends)) +
        row("Interest", money(t.interest)) +
        row("Capital-gain distributions", money((t.capital_gain_distributions_long || 0) + (t.capital_gain_distributions_short || 0))) +
        row("Tax withheld", money(t.tax_withheld)) + "</ul>";
    },
    realized_gains: function (s) {
      var t = s.totals || {}, sh = t.short || {}, lg = t.long || {}, un = t.unknown || {}, c = s.coverage || {};
      var sales = (s.sales || []).length;
      return '<div class="big">' + money((sh.gain || 0) + (lg.gain || 0)) + "</div><ul>" +
        row("Short-term gain", money(sh.gain)) + row("Long-term gain", money(lg.gain)) +
        row("Sales", String(sales)) +
        (un.count ? row("Without a known basis", un.count + " (" + money(un.proceeds) + " proceeds)") : "") +
        "</ul>" +
        '<p class="tax-note">First-in-first-out over the purchases Perfin has stored' +
        (c.partial || c.none ? " — " + ((c.partial || 0) + (c.none || 0)) + " sale(s) not fully covered" : "") +
        (s.corporate_action_securities ? "; " + s.corporate_action_securities + " security(ies) had a corporate action" : "") +
        ". Your broker's 1099-B is the authority.</p>";
    },
    retirement: function (s) {
      var n = (s.distributions || []).length;
      if (!n) return '<p class="tax-note">No withdrawals from retirement accounts recorded.</p>';
      return '<div class="big">' + money(s.total) + "</div><ul>" + s.distributions.slice(0, 8).map(function (d) {
        return row((d.date || "") + " " + (d.account_name || "Account"), money(d.amount));
      }).join("") + "</ul>";
    },
    deductions: function (s) {
      var cats = s.by_category || {};
      return '<div class="big">' + money(s.total) + "</div><ul>" +
        Object.keys(cats).map(function (c) { return row(c, money(cats[c])); }).join("") + "</ul>" +
        '<p class="tax-note">' + (s.count || 0) + " transaction(s) matched by keyword — not a tax determination.</p>";
    },
    rent_paid: function (s) {
      var n = (s.payments || []).length;
      if (!n) return '<p class="tax-note">No rent or utility payments recorded.</p>';
      return '<div class="big">' + money(s.total) + '</div><p class="tax-note">' + n + " payment(s) to " + win.esc(s.payee || "the payee") + ".</p>";
    },
  };

  function sectionCard(sec, s, year) {
    var head = '<h2><span>' + win.esc(sec.title) + "</span>" +
      (s && s.ok ? '<a class="btn btn-sm" href="' + win.esc(packageHref(year, "csv", sec.key)) + '" download aria-label="Download the ' + win.esc(sec.title) + ' CSV">CSV</a>' : "") +
      "</h2>";
    var body = !s ? '<p class="tax-error">Not in the package.</p>'
      : !s.ok ? '<p class="tax-error">' + win.esc(s.error || "Could not read this section.") + "</p>"
      : BODIES[sec.key](s);
    return '<div class="tax-card" data-section="' + sec.key + '">' + head + body + "</div>";
  }

  function overviewCard(o) {
    if (!o) return "";
    var failed = (o.sections_failed || []).map(function (k) {
      var sec = SECTIONS.filter(function (x) { return x.key === k; })[0];
      return sec ? sec.title : k;
    });
    return '<div class="tax-card wide" data-section="overview"><h2><span>Overview ' + win.esc(o.year) + "</span></h2><ul>" +
      row("Income", money(o.income_total)) +
      row("Investment income", money(o.investment_income_total)) +
      row("Realized gains with a known basis", money(o.realized_gain_known)) +
      row("Retirement distributions", money(o.retirement_distributions_total)) +
      row("Deductions found", money(o.deductions_total)) +
      row("Rent and utilities paid", money(o.rent_paid_total)) +
      row("Tax documents still open", o.documents_open == null ? "—" : String(o.documents_open) + (o.documents_overdue ? " (" + o.documents_overdue + " past their usual date)" : "")) +
      "</ul>" + (failed.length ? '<p class="tax-error">Not available: ' + win.esc(failed.join(", ")) + ".</p>" : "") + "</div>";
  }

  function renderSections(pkg, year) {
    return overviewCard(pkg.overview) + SECTIONS.map(function (sec) { return sectionCard(sec, pkg[sec.key], year); }).join("");
  }

  var STATE_TEXT = { received: "Received", dismissed: "Dismissed", overdue: "Overdue", waiting: "Waiting" };

  function docName(d) { return d.form + (d.issuer ? " from " + d.issuer : ""); }

  function docRow(d) {
    var name = docName(d);
    var meta = [];
    if (d.expected_by) meta.push("Usually arrives by " + d.expected_by);
    if (d.received_at) meta.push("received " + d.received_at);
    meta.push(d.origin === "suggested" ? "suggested from your data" : "added by you");
    var b = function (action, value, label, aria, extra) {
      return '<button class="btn btn-sm" type="button" data-action="' + action + '" data-id="' + d.id + '"' +
        (value != null ? ' data-value="' + value + '"' : "") + ' aria-label="' + win.esc(aria) + '"' + (extra || "") + ">" + label + "</button>";
    };
    return '<li class="doc-row" data-id="' + d.id + '"><div class="doc-head"><span class="doc-title">' + win.esc(name) +
      '</span><span class="doc-state ' + win.esc(d.state) + '">' + win.esc(STATE_TEXT[d.state] || d.state) + "</span></div>" +
      '<div class="doc-meta">' + win.esc(meta.join(" · ")) + "</div>" +
      '<div class="doc-actions">' +
      (d.received_at ? b("received", "false", "Not received", "Mark the " + name + " not received")
        : b("received", "true", "Mark received", "Mark the " + name + " received")) +
      (d.dismissed_at ? b("dismissed", "false", "Restore", "Restore the " + name)
        : b("dismissed", "true", "Dismiss", "Dismiss the " + name)) +
      '<input class="doc-notes" data-notes-for="' + d.id + '" maxlength="1000" value="' + win.esc(d.notes || "") + '" aria-label="Notes for the ' + win.esc(name) + '" placeholder="Notes">' +
      b("notes", null, "Save notes", "Save the notes for the " + name) +
      (d.origin === "manual" ? b("delete", null, "Delete", "Delete the " + name, " data-e2e-skip") : "") +
      "</div></li>";
  }

  function renderDocuments(docs) {
    if (!docs || !docs.length) return '<li style="color:var(--text-muted);font-size:13px;">No forms on the list yet — press "Suggest from my data" or add one.</li>';
    return docs.map(docRow).join("");
  }

  // ---------------------------------------------------------------------------
  // Page state + loading. A load started for an older year never overwrites a
  // newer one (seq).
  // ---------------------------------------------------------------------------
  // docSeq does the same for the checklist (cycle-8 F39 — two reloads for the
  // same year used to race), and pending makes each write single-flight.
  var state = { year: null, seq: 0, docSeq: 0, forms: null, pending: {} };

  function el(id) { return document.getElementById(id); }

  function setDownloads(year) {
    var pdf = el("tax-pdf-link"), zip = el("tax-zip-link");
    if (pdf) pdf.href = packageHref(year, "pdf");
    if (zip) zip.href = packageHref(year, "zip");
  }

  async function loadPackage() {
    var seq = ++state.seq, year = state.year, box = el("tax-sections");
    try {
      var res = await win.apiFetch("/api/tax/package?year=" + year);
      var body = await res.json().catch(function () { return {}; });
      if (seq !== state.seq) return;
      if (!res.ok) { box.innerHTML = '<p class="tax-error">' + win.esc(body.error || "Could not load the tax package.") + "</p>"; return; }
      box.innerHTML = renderSections(body, year);
    } catch (e) {
      if (seq === state.seq) box.innerHTML = '<p class="tax-error">Could not load the tax package.</p>';
    }
  }

  // Cycle-8 F35: a reload redraws the whole list, so the notes typed in other
  // rows and the focused control are carried across it — they used to be wiped
  // by any action on any row (and focus fell back to the page).
  function captureDocState(list) {
    var dirty = {}, focus = null;
    var inputs = list.querySelectorAll ? list.querySelectorAll("input[data-notes-for]") : [];
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].value !== inputs[i].defaultValue) dirty[inputs[i].getAttribute("data-notes-for")] = inputs[i].value;
    }
    var a = document.activeElement;
    if (a && a !== document.body && list.contains && list.contains(a)) {
      focus = { notes: a.getAttribute("data-notes-for"), action: a.getAttribute("data-action"), id: a.getAttribute("data-id") };
    }
    return { dirty: dirty, focus: focus };
  }

  function restoreDocState(list, saved) {
    Object.keys(saved.dirty).forEach(function (id) {
      var input = list.querySelector('[data-notes-for="' + id + '"]');
      if (input) input.value = saved.dirty[id];
    });
    var f = saved.focus, target = null;
    if (!f) return;
    if (f.notes) target = list.querySelector('[data-notes-for="' + f.notes + '"]');
    else if (f.action && f.id) {
      target = list.querySelector('button[data-action="' + f.action + '"][data-id="' + f.id + '"]') ||
        list.querySelector('[data-notes-for="' + f.id + '"]');
    }
    if (target && target.focus) target.focus();
  }

  async function loadDocuments() {
    var seq = ++state.docSeq, year = state.year, list = el("documents-list");
    try {
      var res = await win.apiFetch("/api/tax/documents?year=" + year);
      var body = await res.json().catch(function () { return {}; });
      if (seq !== state.docSeq || year !== state.year) return;
      if (!res.ok) { list.innerHTML = '<li class="tax-error">' + win.esc(body.error || "Could not load the tax documents.") + "</li>"; return; }
      if (!state.forms && body.forms) {
        state.forms = body.forms;
        el("doc-form").innerHTML = body.forms.map(function (f) { return '<option value="' + win.esc(f) + '">' + win.esc(f) + "</option>"; }).join("");
      }
      var saved = captureDocState(list);
      list.innerHTML = renderDocuments(body.documents);
      restoreDocState(list, saved);
    } catch (e) {
      if (seq === state.docSeq && year === state.year) list.innerHTML = '<li class="tax-error">Could not load the tax documents.</li>';
    }
  }

  function loadAll() { return Promise.all([loadPackage(), loadDocuments()]); }

  function setYear(year) {
    state.year = year;
    try { history.replaceState(null, "", location.pathname + "?year=" + year + location.hash); } catch (e) { /* a sandboxed page can refuse it; the view still changes */ }
    setDownloads(year);
    return loadAll();
  }

  function jsonOpts(method, body) {
    return { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  async function updateDocument(id, patch, what) {
    try {
      var res = await win.apiFetch("/api/tax/documents/" + id, jsonOpts("PATCH", patch));
      if (await win.writeOk(res, what)) { await loadAll(); return true; }
    } catch (e) { win.showMsg(what + ": " + e.message, false); }
    return false;
  }

  // One run per key at a time (a double tap shares the first); the button is
  // disabled meanwhile and put back after — a redrawn row's button is new anyway.
  function singleFlight(key, btn, fn) {
    if (state.pending[key]) return state.pending[key];
    var p = (async function () {
      if (btn) btn.disabled = true;
      try { return await fn(); }
      finally { delete state.pending[key]; if (btn) btn.disabled = false; }
    })();
    state.pending[key] = p;
    return p;
  }

  function onDocAction(btn) {
    var id = btn.getAttribute("data-id"), action = btn.getAttribute("data-action");
    return singleFlight(action + ":" + id, btn, function () { return docAction(id, action, btn); });
  }

  async function docAction(id, action, btn) {
    if (action === "received" || action === "dismissed") {
      var patch = {}; patch[action] = btn.getAttribute("data-value") === "true";
      return updateDocument(id, patch, "Could not update the form");
    }
    if (action === "notes") {
      var input = document.querySelector('[data-notes-for="' + id + '"]');
      if (await updateDocument(id, { notes: input ? input.value : "" }, "Could not save the notes")) win.showMsg("Notes saved.", true);
      return;
    }
    if (action === "delete") {
      if (!win.confirm("Delete this form from the list?")) return;
      try {
        var res = await win.apiFetch("/api/tax/documents/" + id, { method: "DELETE" });
        if (await win.writeOk(res, "Could not delete the form")) { win.showMsg("Form removed.", true); await loadAll(); }
      } catch (e) { win.showMsg("Could not delete the form: " + e.message, false); }
    }
  }

  function addDocument() { return singleFlight("add", el("doc-add"), addDocumentNow); }

  async function addDocumentNow() {
    var form = el("doc-form").value, issuer = el("doc-issuer").value;
    try {
      var res = await win.apiFetch("/api/tax/documents", jsonOpts("POST", { year: state.year, form: form, issuer: issuer }));
      if (await win.writeOk(res, "Could not add the form")) {
        el("doc-issuer").value = "";
        win.showMsg(form + " added.", true);
        await loadAll();
      }
    } catch (e) { win.showMsg("Could not add the form: " + e.message, false); }
  }

  function suggest() { return singleFlight("suggest", el("tax-suggest"), suggestNow); }

  async function suggestNow() {
    try {
      var res = await win.apiFetch("/api/tax/documents/suggest", jsonOpts("POST", { year: state.year }));
      if (!(await win.writeOk(res, "Could not suggest forms"))) return;
      var body = await res.json();
      var msg = body.added ? body.added + " form(s) added from your data." : "Nothing new to add.";
      if ((body.errors || []).length) msg += " Some data couldn't be read: " + body.errors.map(function (e) { return e.error; }).join(" ");
      win.showMsg(msg, !(body.errors || []).length);
      await loadAll();
    } catch (e) { win.showMsg("Could not suggest forms: " + e.message, false); }
  }

  function init() {
    if (!el("tax-page")) return;
    var today = win.localTodayStr();
    var year = initialYear(location.search, today);
    el("tax-year").innerHTML = yearOptions(parseInt(today.slice(0, 4), 10), year);
    el("tax-year").addEventListener("change", function () { setYear(parseInt(this.value, 10)); });
    el("doc-add").addEventListener("click", addDocument);
    el("tax-suggest").addEventListener("click", suggest);
    el("documents-list").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-action]");
      if (btn) onDocAction(btn);
    });
    return setYear(year);
  }

  win.TaxPage = {
    SECTIONS: SECTIONS, money: money, initialYear: initialYear, yearOptions: yearOptions,
    packageHref: packageHref, renderSections: renderSections, renderDocuments: renderDocuments,
    sectionCard: sectionCard, init: init, state: state, setYear: setYear,
    addDocument: addDocument, suggest: suggest, onDocAction: onDocAction,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
