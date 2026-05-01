// ============================================================================
// Settings page: Categorization Rules panel
// ============================================================================
// Self-contained — loaded on every page via partials/foot.ejs but only
// activates when it detects the settings page (via #categorize-btn, which
// is unique to the Transaction Categorization section). Keeping it as an
// external script means the 46KB settings.ejs doesn't need to be touched.

(function() {
  "use strict";

  // Only run on settings page. #categorize-btn is the existing "Categorize"
  // button in the Transaction Categorization section; if it's missing we're
  // on some other page and should no-op.
  document.addEventListener("DOMContentLoaded", function() {
    var anchor = document.getElementById("categorize-btn");
    if (!anchor) return;

    // Find the .section that contains the Transaction Categorization card so
    // we can inject our panel immediately after it — visually grouped with
    // related categorization UI rather than floating at the bottom of the page.
    var section = anchor.closest(".section");
    if (!section) return;

    // Use a <details> element so the section is natively collapsible. The
    // browser handles open/close; we just style <summary> to look like the
    // section header. `open` defaults to true so the panel matches its prior
    // expanded behavior — users who don't care about rules can click the
    // header once to collapse it permanently (the open state isn't persisted
    // across reloads, which is intentional: it's a glance UI, not a setting).
    var panel = document.createElement("details");
    panel.className = "section";
    panel.open = true;
    panel.innerHTML =
      '<summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;padding:0;margin:0;">' +
        '<span style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:400;color:var(--text);">' +
          '<span class="rules-caret" aria-hidden="true" style="display:inline-block;width:10px;font-size:10px;color:var(--text-muted);transition:transform 0.15s;">&#9656;</span>' +
          'Categorization Rules' +
        '</span>' +
        '<span id="rules-count" style="font-size:11px;font-weight:300;color:var(--text-muted);">--</span>' +
      '</summary>' +
      '<p style="font-size:12px;color:var(--text-muted);font-weight:300;margin:12px 0;">' +
        'Merchant→category rules saved via the "Remember this merchant" checkbox on the Transactions page. ' +
        'Rules run before the ML classifier, so matched merchants never cost an AI call.' +
      '</p>' +
      '<div class="setting-row">' +
        '<div class="setting-info">' +
          '<div class="name">Apply rules now</div>' +
          '<div class="desc">Run every active rule against your uncategorized transactions</div>' +
        '</div>' +
        '<div class="setting-control">' +
          '<button class="btn primary" id="rules-apply-btn">Apply</button>' +
        '</div>' +
      '</div>' +
      '<div id="rules-list" style="margin-top:12px;"></div>';

    section.insertAdjacentElement("afterend", panel);

    // Inline style for the caret rotation when open. ::-webkit-details-marker
    // is hidden via list-style:none above; we draw our own caret instead so
    // its position is consistent across browsers.
    var caretStyle = document.createElement("style");
    caretStyle.textContent =
      "details.section[open] .rules-caret { transform: rotate(90deg); }" +
      "details.section > summary::-webkit-details-marker { display: none; }";
    document.head.appendChild(caretStyle);

    var listEl = document.getElementById("rules-list");
    var countEl = document.getElementById("rules-count");
    var applyBtn = document.getElementById("rules-apply-btn");

    // Reusable showMsg fallback — perfin-shared.js's global showMsg writes
    // into #status-msg on the page. If for some reason it isn't defined,
    // skip the message and don't break the flow.
    function msg(text, ok) {
      if (typeof window.showMsg === "function") window.showMsg(text, ok);
    }

    function rowHtml(r) {
      var matchLabel = r.match_type === "exact" ? "exactly"
        : r.match_type === "starts_with" ? "starts with"
        : "contains";
      return '<div class="rule-row" data-id="' + r.id + '" ' +
        'style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;font-weight:300;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;">' +
            '<span style="color:var(--text-muted);font-size:11px;">if merchant ' + esc(matchLabel) + '</span>' +
            '<strong style="font-weight:500;">' + esc(r.merchant_pattern) + '</strong>' +
            '<span style="color:var(--text-muted);font-size:11px;">→</span>' +
            '<span style="color:var(--warm);">' + esc(r.category) + '</span>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">' +
            'applied ' + (r.times_applied || 0) + ' time' + (r.times_applied === 1 ? '' : 's') +
            (r.updated_at ? ' · last updated ' + new Date(r.updated_at).toLocaleDateString() : '') +
          '</div>' +
        '</div>' +
        '<button class="btn btn-sm" data-action="delete-rule" data-id="' + r.id + '" ' +
          'title="Delete rule" style="flex-shrink:0;">Delete</button>' +
      '</div>';
    }

    async function loadRules() {
      try {
        var res = await apiFetch("/api/categorization-rules");
        if (!res.ok) {
          listEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Unable to load rules.</div>';
          countEl.textContent = "--";
          return;
        }
        var data = await res.json();
        countEl.textContent = data.length + (data.length === 1 ? " rule" : " rules");
        if (data.length === 0) {
          listEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">' +
            'No rules yet. On the Transactions page, click Edit on any row, pick a category, and check "Remember this merchant" to create your first rule.' +
            '</div>';
          return;
        }
        listEl.innerHTML = data.map(rowHtml).join("");
      } catch (e) {
        listEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Error loading rules: ' + esc(e.message) + '</div>';
      }
    }

    async function deleteRule(id) {
      if (!confirm("Delete this rule? Existing categorizations won't change, but future transactions from this merchant won't auto-map anymore.")) return;
      try {
        var res = await apiFetch("/api/categorization-rules/" + encodeURIComponent(id), { method: "DELETE" });
        if (res.ok) { msg("Rule deleted.", true); loadRules(); }
        else { msg("Failed to delete rule.", false); }
      } catch (e) { msg(e.message, false); }
    }

    async function applyAllRules() {
      applyBtn.disabled = true;
      applyBtn.textContent = "Applying…";
      try {
        var res = await apiFetch("/api/categorization-rules/apply", { method: "POST" });
        var data = await res.json();
        if (res.ok) {
          msg("Applied " + (data.applied || 0) + " categorization" + (data.applied === 1 ? "" : "s") + ".", true);
          loadRules();
        } else {
          msg(data.error || "Failed", false);
        }
      } catch (e) { msg(e.message, false); }
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply";
    }

    applyBtn.addEventListener("click", applyAllRules);
    // Event delegation — the list re-renders, so attaching to listEl lets a
    // single listener survive across refreshes.
    listEl.addEventListener("click", function(e) {
      var btn = e.target.closest('[data-action="delete-rule"]');
      if (btn) deleteRule(btn.dataset.id);
    });
    // Stop the apply button click from also toggling the <details> open/close
    // (clicks inside <summary> normally do; we want them confined to the
    // header text).
    applyBtn.addEventListener("click", function(e) { e.stopPropagation(); });

    loadRules();
  });
})();
