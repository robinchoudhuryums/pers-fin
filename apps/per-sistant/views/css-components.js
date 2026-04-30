// ============================================================================
// Per-sistant — Component CSS: cards, buttons, forms, tables, badges, modal
// ============================================================================
module.exports = `
/* ----- Cards / sections ----- */
.card {
  padding: 20px; border-radius: var(--radius);
  background: var(--paper-card); border: 1px solid var(--line);
  transition: border-color 0.15s;
}
.card:hover { border-color: var(--muted); }
.card .label {
  font-family: var(--mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--muted); font-weight: 400;
}
.card .value {
  font-family: var(--display); font-size: 32px; font-weight: 500;
  margin-top: 6px; letter-spacing: -1px; color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.card .value.warm { color: var(--accent); }
.card .value.teal { color: var(--accent); }
.card .value.green { color: var(--good); }
.card .value.red { color: var(--warn); }
.card .sub { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 4px; font-variant-numeric: tabular-nums; }

.top-cards {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px; margin-bottom: 28px;
}

.section {
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 24px; margin-bottom: 20px;
}
.section h2 {
  font-family: var(--mono); font-size: 10px; font-weight: 500;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em;
  margin-bottom: 16px;
}

/* ----- Buttons ----- */
.btn, .actions button, .actions .btn {
  padding: 7px 14px; font-family: var(--mono); font-size: 10px;
  font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase;
  border: 1px solid var(--line); border-radius: 2px; cursor: pointer;
  background: transparent; color: var(--ink);
  transition: background 0.15s, border-color 0.15s;
  text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.btn:hover, .actions button:hover:not(:disabled), .actions .btn:hover { background: var(--paper-2); }
.btn.primary, .actions button.primary, .actions .btn.primary {
  background: var(--accent); color: var(--paper); border-color: var(--accent);
}
.btn.primary:hover, .actions button.primary:hover:not(:disabled), .actions .btn.primary:hover {
  filter: brightness(0.95); background: var(--accent);
}
.btn.danger, .actions button.danger {
  border-color: var(--warn); color: var(--warn);
}
.btn.danger:hover, .actions button.danger:hover { background: color-mix(in oklch, var(--warn) 12%, transparent); }
.btn:disabled, .actions button:disabled { opacity: 0.35; cursor: not-allowed; }

.actions { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }

/* ----- Forms ----- */
input[type="text"], input[type="url"], input[type="email"], input[type="number"],
input[type="password"], input[type="search"], input[type="tel"],
input[type="date"], input[type="datetime-local"], input[type="time"],
select, textarea {
  background: var(--paper-card); border: 1px solid var(--line);
  padding: 7px 10px; border-radius: 2px;
  font-family: var(--ui); font-size: 13px; color: var(--ink);
  outline: none; transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent);
}
textarea { min-height: 100px; resize: vertical; line-height: 1.55; }
select { cursor: pointer; }
label { font-size: 13px; color: var(--ink); }

/* ----- Tables ----- */
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; padding: 10px 12px;
  font-family: var(--mono); font-size: 9px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.12em; font-weight: 500;
  border-bottom: 1px solid var(--line);
}
td {
  padding: 11px 12px; border-bottom: 1px solid var(--line);
  font-size: 13px; color: var(--ink);
}
tr:hover td { background: var(--paper-2); }

/* ----- Badges ----- */
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 2px;
  font-family: var(--mono); font-size: 9px; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.1em;
  border: 1px solid var(--line); background: var(--paper-2); color: var(--muted);
}
.badge.urgent   { color: var(--warn); border-color: var(--warn); background: color-mix(in oklch, var(--warn) 10%, transparent); }
.badge.high     { color: var(--warn); border-color: var(--line); }
.badge.medium   { color: var(--muted); }
.badge.low      { color: var(--good); border-color: var(--good); }
.badge.draft    { color: var(--muted); }
.badge.scheduled{ color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.badge.sent     { color: var(--good); border-color: var(--good); }
.badge.failed   { color: var(--warn); border-color: var(--warn); }
.badge.short    { color: var(--good); }
.badge.long     { color: var(--accent); }
.badge.recurring{ color: var(--accent); border-color: var(--accent); }
.badge.streak   { color: var(--good); border-color: var(--good); }
.badge.blocked  { color: var(--warn); border-color: var(--warn); }
.badge.blocking { color: var(--ink); border-color: var(--ink); }

/* ----- Status messages ----- */
.status-msg {
  padding: 12px 14px; border-radius: 2px; margin-bottom: 16px;
  font-size: 13px; display: none;
  border: 1px solid var(--line);
}
.status-msg.success { display: block; color: var(--good); border-color: var(--good); background: color-mix(in oklch, var(--good) 6%, transparent); }
.status-msg.error   { display: block; color: var(--warn); border-color: var(--warn); background: color-mix(in oklch, var(--warn) 6%, transparent); }

/* ----- Modal ----- */
.modal-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(20, 15, 10, 0.35); z-index: 200;
  align-items: center; justify-content: center;
}
.modal-overlay.active { display: flex; }
.modal {
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 28px;
  width: 90%; max-width: 560px; max-height: 90vh; overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0,0,0,0.12);
}
.modal h2 {
  font-family: var(--display); font-size: 18px; font-weight: 500;
  letter-spacing: -0.2px; margin-bottom: 20px;
}
.modal label {
  display: block; font-family: var(--mono); font-size: 10px;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em;
  font-weight: 500; margin-bottom: 6px; margin-top: 14px;
}
.modal label:first-of-type { margin-top: 0; }
.modal input, .modal select, .modal textarea { width: 100%; }
.modal .modal-actions {
  display: flex; gap: 8px; margin-top: 22px; justify-content: flex-end;
}

/* ----- Filters ----- */
.filters {
  display: flex; gap: 4px; margin-bottom: 18px; flex-wrap: wrap;
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: 2px; padding: 3px; width: fit-content;
}
.filters button {
  padding: 5px 12px; font-family: var(--mono); font-size: 10px;
  font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase;
  border: none; background: transparent; color: var(--muted);
  cursor: pointer; border-radius: 2px;
}
.filters button:hover { color: var(--ink); }
.filters button.active { background: var(--ink); color: var(--paper); }

/* ----- Search ----- */
.search-bar { position: relative; margin-bottom: 20px; }
.search-bar input {
  width: 100%; padding: 10px 14px 10px 36px;
  font-size: 13px; font-family: var(--ui);
  background: var(--paper-card); border: 1px solid var(--line);
  border-radius: 2px; color: var(--ink);
}
.search-bar .search-icon {
  position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
  color: var(--muted); font-size: 14px;
}
.search-results .result-item {
  padding: 12px 14px; border-bottom: 1px solid var(--line);
  cursor: pointer; transition: background 0.15s;
}
.search-results .result-item:hover { background: var(--paper-2); }
.search-results .result-type {
  font-family: var(--mono); font-size: 9px; text-transform: uppercase;
  letter-spacing: 0.12em; color: var(--muted); margin-bottom: 4px;
}

/* ----- KBD ----- */
.kbd {
  display: inline-block; padding: 2px 6px;
  background: var(--paper-2); border: 1px solid var(--line);
  border-radius: 2px; font-family: var(--mono);
  font-size: 10px; color: var(--muted);
}

/* ----- Loading spinner ----- */
@keyframes spin { to { transform: rotate(360deg); } }
.btn-loading { position: relative; color: transparent !important; pointer-events: none; }
.btn-loading::after {
  content: ''; position: absolute; top: 50%; left: 50%; width: 12px; height: 12px;
  margin: -6px 0 0 -6px; border: 2px solid var(--accent); border-top-color: transparent;
  border-radius: 50%; animation: spin 0.6s linear infinite;
}

/* ----- Empty state ----- */
.empty-msg {
  text-align: center; padding: 40px; color: var(--muted);
  font-size: 13px; font-style: italic;
}

/* ----- Hide legacy decorative elements globally ----- */
.tree-widget, .tree-container, .tree-glow, .tree-svg,
.tree-particle, .falling-petal, .tree-leaf, #dragon-zzz,
.work-mode-toggle, .mobile-fab, .bottom-nav {
  display: none !important;
}
`;
