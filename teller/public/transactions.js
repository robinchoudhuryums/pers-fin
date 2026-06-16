    // Mirror of the server-side CATEGORIES list in routes/categorize-helpers.js.
    // The server validates whatever we POST, so this is purely UI — it's fine
    // for the two copies to drift; this one can get a refresh whenever we add
    // new categories on the backend.
    var CATEGORIES = [
      "Food & Drink", "Groceries", "Transportation", "Gas & Fuel",
      "Shopping", "Entertainment", "Health & Fitness", "Healthcare",
      "Housing", "Utilities", "Insurance", "Education",
      "Travel", "Personal Care", "Gifts & Donations", "Fees & Charges",
      "Transfer", "Income", "Investment", "Subscription",
      "Other",
    ];

    var currentOffset = 0;
    var currentTotal = 0;
    var PAGE_SIZE = 100;
    var selectedIds = new Set();

    function getFilters() {
      return {
        q: document.getElementById('search-input').value.trim(),
        category: document.getElementById('filter-category').value,
        min_amount: document.getElementById('filter-min').value,
        max_amount: document.getElementById('filter-max').value,
        start_date: document.getElementById('filter-start').value,
        end_date: document.getElementById('filter-end').value,
      };
    }

    async function searchTransactions(offset) {
      currentOffset = offset || 0;
      var filters = getFilters();
      var params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.category) params.set('category', filters.category);
      if (filters.min_amount) params.set('min_amount', filters.min_amount);
      if (filters.max_amount) params.set('max_amount', filters.max_amount);
      if (filters.start_date) params.set('start_date', filters.start_date);
      if (filters.end_date) params.set('end_date', filters.end_date);
      params.set('limit', PAGE_SIZE);
      params.set('offset', currentOffset);

      try {
        var res = await apiFetch('/api/transactions/search?' + params.toString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        currentTotal = data.total;
        selectedIds.clear();
        updateBulkBar();

        document.getElementById('result-count').textContent =
          data.total.toLocaleString() + ' transactions found' +
          (currentOffset > 0 ? ' (showing ' + (currentOffset + 1) + '-' + Math.min(currentOffset + PAGE_SIZE, data.total) + ')' : '');

        var tbody = document.getElementById('txn-body');
        if (!data.transactions.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty">No transactions match your filters.</td></tr>';
          document.getElementById('pagination').innerHTML = '';
          return;
        }

        tbody.innerHTML = data.transactions.map(function(t) {
          var amt = parseFloat(t.amount);
          var amtClass = amt > 0 ? 'debit' : 'credit';
          var reimbursedBadge = t.is_reimbursed ? ' <span style="font-size:10px;color:var(--teal);border:1px solid var(--teal);padding:1px 4px;border-radius:4px;">REIMBURSED</span>' : '';
          // Shared-card per-transaction settlement override. Only meaningful on
          // is_shared accounts — on a normal account, personal_for has no
          // effect on the SPLIT_AMOUNT formula, so we hide the control.
          var personalBadge = '';
          if (t.account_is_shared) {
            if (t.personal_for === 'self') personalBadge = ' <span style="font-size:10px;color:var(--warm);border:1px solid var(--warm);padding:1px 4px;border-radius:4px;">MINE</span>';
            else if (t.personal_for === 'partner') personalBadge = ' <span style="font-size:10px;color:var(--teal);border:1px solid var(--teal);padding:1px 4px;border-radius:4px;">PARTNER</span>';
          }
          return '<tr>' +
            '<td class="cell-check" data-label="Select"><input type="checkbox" class="txn-check" data-id="' + esc(t.transaction_id) + '"></td>' +
            '<td data-label="Date">' + fmtDate(t.date) + '</td>' +
            '<td class="cell-primary">' + esc(t.merchant) + reimbursedBadge + personalBadge + '</td>' +
            '<td data-label="Category"><span class="txn-cat">' + esc(t.category || 'Uncategorized') + '</span></td>' +
            '<td class="amount ' + amtClass + '" data-label="Amount">' + fmt(Math.abs(amt)) + '</td>' +
            '<td data-label="Account" style="font-size:11px;color:var(--text-muted);">' + esc(t.account_name || '') + '</td>' +
            '<td class="row-actions cell-actions">' +
              '<button class="btn-xs" data-action="edit" data-id="' + esc(t.transaction_id) + '" data-merchant="' + esc(t.merchant || '') + '" data-notes="' + esc(t.user_notes || '') + '" data-reimbursed="' + (t.is_reimbursed ? '1' : '0') + '" data-category="' + esc(t.category || '') + '" data-shared="' + (t.account_is_shared ? '1' : '0') + '" data-personal="' + esc(t.personal_for || '') + '">Edit</button>' +
              (amt > 0 && !t.pending
                ? '<button class="btn-xs" data-action="split" data-id="' + esc(t.transaction_id) + '" data-amount="' + esc(String(Math.abs(amt))) + '" data-merchant="' + esc(t.merchant || '') + '">Split</button>'
                : '') +
            '</td>' +
            '</tr>';
        }).join('');

        // Pagination
        var totalPages = Math.ceil(data.total / PAGE_SIZE);
        var currentPage = Math.floor(currentOffset / PAGE_SIZE) + 1;
        var pagHtml = '';
        if (currentPage > 1) pagHtml += '<button class="btn btn-sm" id="prev-page">Previous</button>';
        pagHtml += '<span>Page ' + currentPage + ' of ' + totalPages + '</span>';
        if (currentPage < totalPages) pagHtml += '<button class="btn btn-sm" id="next-page">Next</button>';
        document.getElementById('pagination').innerHTML = pagHtml;

      } catch (e) {
        document.getElementById('txn-body').innerHTML = '<tr><td colspan="6" class="empty">Error: ' + esc(e.message) + '</td></tr>';
      }
    }

    function updateBulkBar() {
      var bar = document.getElementById('bulk-bar');
      bar.style.display = selectedIds.size > 0 ? 'flex' : 'none';
      document.getElementById('selected-count').textContent = selectedIds.size + ' selected';
    }

    async function applyBulkCategory() {
      var category = document.getElementById('bulk-category').value;
      if (!category) { showMsg('Select a category first.', false); return; }
      if (selectedIds.size === 0) { showMsg('No transactions selected.', false); return; }
      try {
        var res = await apiFetch('/api/transactions/bulk-category', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_ids: Array.from(selectedIds), category: category }),
        });
        var data = await res.json().catch(function() { return {}; });
        if (res.ok) {
          showMsg('Updated ' + data.updated + ' transactions to ' + category + '.', true);
          selectedIds.clear();
          updateBulkBar();
          searchTransactions(currentOffset);
        } else showMsg(data.error || 'Failed', false);
      } catch (e) { showMsg(e.message, false); }
    }

    async function loadDuplicates() {
      try {
        var res = await apiFetch('/api/transactions/duplicates');
        if (!res.ok) return;
        var data = await res.json();
        if (!data.duplicates || data.duplicates.length === 0) return;

        document.getElementById('dup-section').style.display = 'block';
        document.getElementById('dup-list').innerHTML = data.duplicates.map(function(d) {
          return '<div class="dup-card">' +
            '<div class="dup-info">' +
              '<strong>' + esc(d.merchant) + '</strong> &mdash; ' + fmt(Math.abs(parseFloat(d.amount))) +
              ' on ' + fmtDate(d.date) +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' +
                'Account 1: ' + esc(d.account1 || '') + ' &bull; Account 2: ' + esc(d.account2 || '') +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              '<button class="btn btn-sm" data-action="delete-dup" data-id="' + esc(d.id1) + '" title="Keep second, delete first">Delete #1</button>' +
              '<button class="btn btn-sm" data-action="delete-dup" data-id="' + esc(d.id2) + '" title="Keep first, delete second">Delete #2</button>' +
            '</div>' +
          '</div>';
        }).join('');
      } catch (e) { /* non-critical */ }
    }

    async function deleteDuplicate(txnId) {
      if (!confirm('Delete this duplicate transaction?')) return;
      try {
        var res = await apiFetch('/api/transactions/' + encodeURIComponent(txnId), { method: 'DELETE' });
        if (res.ok) { showMsg('Transaction deleted.', true); loadDuplicates(); searchTransactions(currentOffset); }
        else showMsg('Failed to delete.', false);
      } catch (e) { showMsg(e.message, false); }
    }

    // Event bindings
    bindEvents([
      ['search-btn', 'click', function() { searchTransactions(0); }],
      ['search-input', 'keydown', function(e) { if (e.key === 'Enter') searchTransactions(0); }],
      ['filter-category', 'change', function() { searchTransactions(0); }],
      ['bulk-apply-btn', 'click', applyBulkCategory],
      ['header-check', 'change', function() {
        var checked = this.checked;
        document.querySelectorAll('.txn-check').forEach(function(cb) {
          cb.checked = checked;
          if (checked) selectedIds.add(cb.dataset.id);
          else selectedIds.delete(cb.dataset.id);
        });
        updateBulkBar();
      }],
      ['select-all', 'change', function() {
        var checked = this.checked;
        document.querySelectorAll('.txn-check').forEach(function(cb) {
          cb.checked = checked;
          if (checked) selectedIds.add(cb.dataset.id);
          else selectedIds.delete(cb.dataset.id);
        });
        document.getElementById('header-check').checked = checked;
        updateBulkBar();
      }],
    ]);

    onDelegate('txn-body', 'change', '.txn-check', function() {
      if (this.checked) selectedIds.add(this.dataset.id);
      else selectedIds.delete(this.dataset.id);
      updateBulkBar();
    });

    onDelegate('pagination', 'click', '#prev-page', function() { searchTransactions(Math.max(0, currentOffset - PAGE_SIZE)); });
    onDelegate('pagination', 'click', '#next-page', function() { searchTransactions(currentOffset + PAGE_SIZE); });
    onDelegate('dup-list', 'click', '[data-action="delete-dup"]', function() { deleteDuplicate(this.dataset.id); });

    // --- Split modal (Phase B3) ---------------------------------------------
    // The modal collects N (amount, category, notes) rows; the user can
    // add/remove rows and a running total tells them when their splits sum to
    // the parent amount (within $0.01). Save POSTs the full set and replaces
    // any existing splits for that transaction.
    var SPLIT_CATEGORIES = ['Food & Drink','Groceries','Transportation','Gas & Fuel','Shopping','Entertainment',
      'Health & Fitness','Healthcare','Housing','Utilities','Insurance','Education','Travel',
      'Personal Care','Gifts & Donations','Fees & Charges','Transfer','Income','Investment','Subscription','Other'];

    function categorySelect(selected) {
      return '<select>' + SPLIT_CATEGORIES.map(function(c) {
        return '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('') + '</select>';
    }

    async function openSplitModal(txnId, parentAmount, merchant) {
      var existing = [];
      try {
        var r = await apiFetch('/api/transactions/' + encodeURIComponent(txnId) + '/splits');
        if (r.ok) existing = (await r.json()).splits || [];
      } catch (_) {}

      var rows = existing.length
        ? existing.map(function(s) { return { amount: s.amount, category: s.category || 'Other', notes: s.notes || '' }; })
        : [{ amount: parentAmount, category: 'Other', notes: '' }];

      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-label="Split transaction">' +
          '<h3>Split: ' + esc(merchant) + '</h3>' +
          '<div class="parent-info">Parent transaction: ' + fmt(parentAmount) + '. Splits must sum to this amount (±$0.01).</div>' +
          '<div id="split-rows"></div>' +
          '<button class="btn btn-sm" id="add-split-row" type="button">+ Add row</button>' +
          '<div class="totals" id="split-totals"></div>' +
          '<div class="actions">' +
            '<button class="btn" id="cancel-split">Cancel</button>' +
            (existing.length ? '<button class="btn" id="clear-splits">Remove all splits</button>' : '') +
            '<button class="btn primary" id="save-splits">Save splits</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);

      function renderRows() {
        document.getElementById('split-rows').innerHTML = rows.map(function(r, i) {
          return '<div class="split-row" data-row="' + i + '">' +
            '<input type="number" step="0.01" min="0" class="row-amt" value="' + esc(String(r.amount)) + '">' +
            categorySelect(r.category) +
            '<button type="button" class="del" data-action="remove-row">×</button>' +
          '</div>';
        }).join('');
        // Reattach select values (innerHTML re-render loses non-attribute state)
        document.querySelectorAll('#split-rows .split-row').forEach(function(el, i) {
          var sel = el.querySelector('select');
          sel.value = rows[i].category;
          sel.addEventListener('change', function() { rows[i].category = this.value; });
          el.querySelector('.row-amt').addEventListener('input', function() {
            rows[i].amount = parseFloat(this.value) || 0;
            updateTotals();
          });
          el.querySelector('[data-action="remove-row"]').addEventListener('click', function() {
            rows.splice(i, 1); renderRows(); updateTotals();
          });
        });
        updateTotals();
      }
      function updateTotals() {
        var sum = rows.reduce(function(s, r) { return s + (parseFloat(r.amount) || 0); }, 0);
        var diff = sum - parentAmount;
        var ok = Math.abs(diff) <= 0.01;
        document.getElementById('split-totals').innerHTML =
          'Sum: ' + fmt(sum) + ' / ' + fmt(parentAmount) +
          ' &mdash; <span class="' + (ok ? 'ok' : 'bad') + '">' +
          (ok ? '✓ matches' : (diff > 0 ? '$' + diff.toFixed(2) + ' over' : '$' + Math.abs(diff).toFixed(2) + ' under')) +
          '</span>';
      }

      function close() { document.body.removeChild(backdrop); }

      backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
      document.getElementById('cancel-split').addEventListener('click', close);
      document.getElementById('add-split-row').addEventListener('click', function() {
        rows.push({ amount: 0, category: 'Other', notes: '' }); renderRows();
      });
      var clearBtn = document.getElementById('clear-splits');
      if (clearBtn) clearBtn.addEventListener('click', async function() {
        if (!confirm('Remove all splits and revert to the parent transaction?')) return;
        try {
          var r = await apiFetch('/api/transactions/' + encodeURIComponent(txnId) + '/splits', { method: 'DELETE' });
          if (r.ok) { showMsg('Splits removed.', true); close(); searchTransactions(currentOffset); }
          else showMsg('Failed to remove splits.', false);
        } catch (e) { showMsg(e.message, false); }
      });
      document.getElementById('save-splits').addEventListener('click', async function() {
        try {
          var r = await apiFetch('/api/transactions/' + encodeURIComponent(txnId) + '/splits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ splits: rows.map(function(x) { return { amount: x.amount, category: x.category, notes: x.notes }; }) }),
          });
          var d = await r.json().catch(function() { return {}; });
          if (r.ok) { showMsg('Splits saved.', true); close(); searchTransactions(currentOffset); }
          else showMsg(d.error || 'Failed', false);
        } catch (e) { showMsg(e.message, false); }
      });
      renderRows();
    }

    onDelegate('txn-body', 'click', '[data-action="split"]', function() {
      openSplitModal(this.dataset.id, parseFloat(this.dataset.amount), this.dataset.merchant);
    });

    // --- Edit modal: merchant rename + notes + reimbursed + category + rule --
    // The "Remember" checkbox is the "train me" feature: when the user picks a
    // category AND checks Remember, we also POST to /api/categorization-rules/
    // from-transaction so next time the same merchant appears it auto-maps.
    onDelegate('txn-body', 'click', '[data-action="edit"]', function() {
      var txnId = this.dataset.id;
      var currentMerchant = this.dataset.merchant || '';
      var currentNotes = this.dataset.notes || '';
      var currentReimbursed = this.dataset.reimbursed === '1';
      var currentCategory = this.dataset.category || '';
      var isSharedAccount = this.dataset.shared === '1';
      var currentPersonal = this.dataset.personal || '';
      // Only offer to "remember" when the current category isn't already in
      // our scheme. If it is, the user is probably making a one-off correction.
      var inScheme = CATEGORIES.indexOf(currentCategory) >= 0;

      var catOptions = '<option value="">(keep current)</option>' +
        CATEGORIES.map(function(c) {
          var selected = c === currentCategory ? ' selected' : '';
          return '<option value="' + esc(c) + '"' + selected + '>' + esc(c) + '</option>';
        }).join('');

      var backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-label="Edit transaction">' +
          '<h3>Edit Transaction</h3>' +
          '<div class="edit-field"><label>Merchant Name</label>' +
            '<input id="edit-merchant" value="' + esc(currentMerchant) + '" placeholder="Override merchant name"></div>' +
          '<div class="edit-field"><label>Category' +
            (currentCategory ? ' <span style="color:var(--text-muted);font-weight:300;">(current: ' + esc(currentCategory) + ')</span>' : '') +
            '</label>' +
            '<select id="edit-category">' + catOptions + '</select></div>' +
          '<div class="edit-field" style="display:flex;gap:8px;align-items:flex-start;">' +
            '<input type="checkbox" id="edit-remember"' + (inScheme ? '' : ' checked') + ' style="width:auto;min-height:auto;margin-top:3px;">' +
            '<label style="margin:0;font-weight:400;" for="edit-remember">Remember this merchant' +
              '<div style="font-size:11px;color:var(--text-muted);font-weight:300;margin-top:2px;">' +
                'Create a rule so future transactions from this merchant auto-categorize to the chosen category.' +
              '</div>' +
            '</label>' +
          '</div>' +
          '<div class="edit-field"><label>Notes</label>' +
            '<input id="edit-notes" value="' + esc(currentNotes) + '" placeholder="Add a note"></div>' +
          '<div class="edit-field" style="display:flex;gap:8px;align-items:center;">' +
            '<label style="margin:0;" for="edit-reimbursed">Reimbursed</label>' +
            '<input type="checkbox" id="edit-reimbursed"' + (currentReimbursed ? ' checked' : '') + ' style="width:auto;min-height:auto;">' +
            '<span style="font-size:11px;color:var(--text-muted);">Excludes this transaction from spending totals</span>' +
          '</div>' +
          (isSharedAccount
            ? '<div class="edit-field"><label>Settlement</label>' +
                '<select id="edit-personal">' +
                  '<option value=""' + (currentPersonal === '' ? ' selected' : '') + '>Shared (default split)</option>' +
                  '<option value="self"' + (currentPersonal === 'self' ? ' selected' : '') + '>Mine (I pay 100%)</option>' +
                  '<option value="partner"' + (currentPersonal === 'partner' ? ' selected' : '') + '>Partner (they pay 100%)</option>' +
                '</select>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Per-transaction override for shared cards. Reflected in the Settlement widget on the dashboard.</div>' +
              '</div>'
            : '') +
          '<div class="actions">' +
            '<button class="btn" id="edit-cancel">Cancel</button>' +
            '<button class="btn primary" id="edit-save">Save</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);

      backdrop.addEventListener('click', function(e) { if (e.target === backdrop) { document.body.removeChild(backdrop); } });
      document.getElementById('edit-cancel').addEventListener('click', function() { document.body.removeChild(backdrop); });
      document.getElementById('edit-save').addEventListener('click', async function() {
        var body = {};
        var newMerchant = document.getElementById('edit-merchant').value.trim();
        var newNotes = document.getElementById('edit-notes').value.trim();
        var newReimbursed = document.getElementById('edit-reimbursed').checked;
        var newCategory = document.getElementById('edit-category').value;
        var remember = document.getElementById('edit-remember').checked;

        if (newMerchant !== currentMerchant) body.merchant_name = newMerchant || null;
        if (newNotes !== currentNotes) body.notes = newNotes || null;
        if (newReimbursed !== currentReimbursed) body.is_reimbursed = newReimbursed;
        if (isSharedAccount) {
          var personalEl = document.getElementById('edit-personal');
          var newPersonal = personalEl ? personalEl.value : '';
          if (newPersonal !== currentPersonal) body.personal_for = newPersonal || null;
        }

        var categoryChanged = newCategory && newCategory !== currentCategory;
        if (!Object.keys(body).length && !categoryChanged) {
          document.body.removeChild(backdrop);
          return;
        }

        try {
          if (Object.keys(body).length) {
            var r = await apiFetch('/api/transactions/' + encodeURIComponent(txnId), {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!r.ok) {
              var d = await r.json().catch(function() { return {}; });
              showMsg(d.error || 'Failed to update', false);
              return;
            }
          }
          if (categoryChanged) {
            var r2 = await apiFetch('/api/transactions/' + encodeURIComponent(txnId) + '/category', {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ category: newCategory }),
            });
            if (!r2.ok) {
              var d2 = await r2.json().catch(function() { return {}; });
              showMsg(d2.error || 'Category update failed', false);
              return;
            }
          }
          // Only create a rule if the user changed the category AND asked
          // us to remember. Skipping on "no category change" avoids writing
          // a rule that just restates what Teller already tagged.
          if (categoryChanged && remember) {
            // Use the merchant name the row was saved with — if the user
            // just overrode it we want to build the rule off the new name
            // so the rule matches future occurrences as they'll also be
            // renamed (user_merchant_name takes precedence in the matcher).
            try {
              await apiFetch('/api/categorization-rules/from-transaction', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_id: txnId, category: newCategory }),
              });
            } catch (_) { /* non-fatal — the category already saved */ }
          }
          showMsg(
            categoryChanged && remember ? 'Updated and remembered for this merchant.'
              : categoryChanged ? 'Category updated.'
              : 'Transaction updated.',
            true
          );
          document.body.removeChild(backdrop);
          searchTransactions(currentOffset);
        } catch (e) { showMsg(e.message, false); }
      });
    });

    // Mobile filters toggle (the list is the page; filters collapse on top)
    var filtersToggle = document.getElementById('filters-toggle');
    if (filtersToggle) {
      filtersToggle.addEventListener('click', function() {
        var bar = document.getElementById('search-bar');
        var open = bar.classList.toggle('open');
        filtersToggle.setAttribute('aria-expanded', String(open));
        filtersToggle.innerHTML = open ? 'Filters &#9652;' : 'Filters &#9662;';
      });
    }

    // Set default date range to last 6 months
    var now = new Date();
    var sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    document.getElementById('filter-start').value = sixMonthsAgo.toISOString().split('T')[0];
    document.getElementById('filter-end').value = now.toISOString().split('T')[0];

    searchTransactions(0);
    loadDuplicates();
