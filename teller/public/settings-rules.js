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

    // Caret rotation + ::-webkit-details-marker hiding live in
    // perfin-shared.css — a runtime-injected <style> has no CSP nonce and is
    // blocked by the nonce-only styleSrcElem policy (WD-14).

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
        var data = await res.json().catch(function() { return {}; });
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

    // ------------------------------------------------------------------
    // Merchant Rename Rules (cycle-7 F55 / ST2) — created from the Activity
    // page's Edit modal ("Apply to all past and future"); listed here so they
    // can be renamed, switched off / on or removed. Deleting one reverts the
    // names it set.
    // ------------------------------------------------------------------
    var renamePanel = document.createElement("details");
    renamePanel.className = "section";
    renamePanel.open = true;
    renamePanel.innerHTML =
      '<summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;padding:0;margin:0;">' +
        '<span style="display:flex;align-items:center;gap:10px;font-size:14px;font-weight:400;color:var(--text);">' +
          '<span class="rules-caret" aria-hidden="true" style="display:inline-block;width:10px;font-size:10px;color:var(--text-muted);transition:transform 0.15s;">&#9656;</span>' +
          'Merchant Rename Rules' +
        '</span>' +
        '<span id="rename-rules-count" style="font-size:11px;font-weight:300;color:var(--text-muted);">--</span>' +
      '</summary>' +
      '<p style="font-size:12px;color:var(--text-muted);font-weight:300;margin:12px 0;">' +
        'Saved via "Apply to all past and future" in the Activity page\'s Edit dialog. Each rule renames every ' +
        'transaction from a merchant, including future syncs, so subscriptions and recurring transfers stay as one entry.' +
      '</p>' +
      '<div id="rename-rules-list"></div>';
    panel.insertAdjacentElement("afterend", renamePanel);
    var renameListEl = document.getElementById("rename-rules-list");
    var renameCountEl = document.getElementById("rename-rules-count");

    function renameRowHtml(r) {
      var matchLabel = r.match_type === "exact" ? "is exactly"
        : r.match_type === "starts_with" ? "starts with" : "contains";
      return '<div class="rule-row" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;font-weight:300;flex-wrap:wrap;' + (r.is_active ? '' : 'opacity:0.55;') + '">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;">' +
            '<span style="color:var(--text-muted);font-size:11px;">if merchant ' + esc(matchLabel) + '</span>' +
            '<strong style="font-weight:500;">' + esc(r.merchant_pattern) + '</strong>' +
            '<span style="color:var(--text-muted);font-size:11px;">→ show as</span>' +
            '<span style="color:var(--warm);">' + esc(r.rename_to) + '</span>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">' + (r.is_active ? '' : 'off · ') + 'renamed ' + (r.times_applied || 0) + ' transaction' + (r.times_applied === 1 ? '' : 's') + '</div>' +
        '</div>' +
        '<button class="btn btn-sm" data-action="edit-rename-rule" data-id="' + r.id + '" data-name="' + esc(r.rename_to) + '" aria-label="Change the name for ' + esc(r.merchant_pattern) + '" style="flex-shrink:0;">Edit</button>' +
        '<button class="btn btn-sm" data-action="toggle-rename-rule" data-id="' + r.id + '" data-on="' + (r.is_active ? '1' : '0') + '" aria-pressed="' + (r.is_active ? 'true' : 'false') + '" aria-label="' + (r.is_active ? 'Turn off' : 'Turn on') + ' the rename rule for ' + esc(r.merchant_pattern) + '" style="flex-shrink:0;">' + (r.is_active ? 'Turn off' : 'Turn on') + '</button>' +
        '<button class="btn btn-sm" data-action="delete-rename-rule" data-id="' + r.id + '" aria-label="Delete rename rule for ' + esc(r.merchant_pattern) + '" style="flex-shrink:0;">Delete</button>' +
      '</div>';
    }

    async function loadRenameRules() {
      try {
        var res = await apiFetch("/api/merchant-rename-rules");
        if (!res.ok) { renameListEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Unable to load rename rules.</div>'; renameCountEl.textContent = "--"; return; }
        var data = await res.json();
        var rules = data.rules || [];
        renameCountEl.textContent = rules.length + (rules.length === 1 ? " rule" : " rules");
        renameListEl.innerHTML = rules.length ? rules.map(renameRowHtml).join("")
          : '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No rename rules yet.</div>';
      } catch (e) {
        renameListEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">Error loading rename rules: ' + esc(e.message) + '</div>';
      }
    }

    // Edit / Turn off / Turn on (roadmap T1.5): PATCH /api/merchant-rename-rules/:id.
    // A new name renames the rows the rule renamed and its detected subscription
    // or transfer (settings kept); off undoes its renames like Delete but keeps it.
    renameListEl.addEventListener("click", async function(e) {
      var btn = e.target.closest('[data-action="edit-rename-rule"], [data-action="toggle-rename-rule"]');
      if (!btn || btn.disabled) return;
      var body;
      if (btn.dataset.action === "edit-rename-rule") {
        var name = prompt("Show this merchant as:", btn.dataset.name || "");
        if (name === null) return;
        name = name.trim();
        if (!name) { msg("Enter a name.", false); return; }
        if (name === btn.dataset.name) return;
        body = { rename_to: name };
      } else {
        var on = btn.dataset.on === "1";
        if (on && !confirm("Turn off this rename rule? The transactions it renamed go back to their bank names until you turn it on again.")) return;
        body = { is_active: !on };
      }
      btn.disabled = true;
      try {
        var res = await apiFetch("/api/merchant-rename-rules/" + encodeURIComponent(btn.dataset.id), {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).catch(function() { return null; });
        if (await writeOk(res, "Couldn't update the rename rule")) {
          msg(body.rename_to ? "Rename rule updated." : body.is_active ? "Rename rule turned on." : "Rename rule turned off.", true);
        }
      } finally {
        loadRenameRules(); // re-renders the row, so the button comes back enabled
      }
    });

    renameListEl.addEventListener("click", async function(e) {
      var btn = e.target.closest('[data-action="delete-rename-rule"]');
      if (!btn) return;
      if (!confirm("Delete this rename rule? The transactions it renamed go back to their bank names.")) return;
      var res = await apiFetch("/api/merchant-rename-rules/" + encodeURIComponent(btn.dataset.id), { method: "DELETE" }).catch(function() { return null; });
      if (await writeOk(res, "Couldn't delete the rename rule")) { msg("Rename rule deleted.", true); loadRenameRules(); }
    });

    loadRenameRules();
  });
})();
