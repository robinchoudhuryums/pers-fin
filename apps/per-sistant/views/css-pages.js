// ============================================================================
// Per-sistant — Page-specific CSS: todos, notes, calendar, responsive
// ============================================================================
module.exports = `
/* ----- Todo items ----- */
.todo-item {
  display: flex; align-items: flex-start; gap: 12px; padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.todo-item:last-child { border-bottom: none; }
.todo-check {
  width: 18px; height: 18px; min-width: 18px;
  border: 1.5px solid var(--line); border-radius: 2px;
  cursor: pointer; flex-shrink: 0; margin-top: 3px;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, background 0.15s;
  -webkit-tap-highlight-color: transparent;
}
.todo-check:hover { border-color: var(--accent); }
.todo-check.done { border-color: var(--good); background: var(--good); }
.todo-check.done::after {
  content: '\\2713'; color: var(--paper); font-size: 12px; font-weight: 700;
}
.todo-content { flex: 1; min-width: 0; }
.todo-title { font-size: 14px; color: var(--ink); font-weight: 400; }
.todo-title.done { text-decoration: line-through; opacity: 0.4; }
.todo-meta {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap;
  letter-spacing: 0.04em;
}
.todo-actions { display: flex; gap: 4px; flex-shrink: 0; }
.todo-actions button {
  background: none; border: none; color: var(--muted); cursor: pointer;
  font-size: 13px; padding: 6px 8px; transition: color 0.15s;
  -webkit-tap-highlight-color: transparent;
}
.todo-actions button:hover { color: var(--ink); }
.todo-actions button.delete:hover { color: var(--warn); }

/* Subtasks */
.subtask-list { margin-top: 8px; padding-left: 28px; }
.subtask-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; font-size: 12px;
}
.subtask-check {
  width: 14px; height: 14px; min-width: 14px;
  border: 1.5px solid var(--line); border-radius: 2px;
  cursor: pointer; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s, background 0.15s;
}
.subtask-check:hover { border-color: var(--accent); }
.subtask-check.done { border-color: var(--good); background: var(--good); }
.subtask-check.done::after { content: '\\2713'; color: var(--paper); font-size: 9px; font-weight: 700; }
.subtask-text { flex: 1; min-width: 0; color: var(--ink); }
.subtask-text.done { text-decoration: line-through; opacity: 0.4; }
.subtask-edit-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 4px; }
.subtask-edit-btn:hover { color: var(--ink); }
.subtask-add {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  cursor: pointer; padding: 6px 0; letter-spacing: 0.1em; text-transform: uppercase;
}
.subtask-add:hover { color: var(--accent); }
.subtask-progress {
  height: 2px; background: var(--paper-2); border-radius: 1px;
  margin-top: 6px; overflow: hidden;
}
.subtask-progress-fill {
  height: 100%; background: var(--good); border-radius: 1px;
  transition: width 0.3s;
}

/* Drag-and-drop */
.todo-item.dragging { opacity: 0.4; }
.todo-item.drag-over { border-top: 2px solid var(--accent); }
.drag-handle {
  cursor: grab; color: var(--muted); font-size: 12px; padding: 4px;
  user-select: none; flex-shrink: 0;
}
.drag-handle:active { cursor: grabbing; }

/* ----- Notes grid ----- */
.notes-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.note-card {
  padding: 18px; border-radius: var(--radius);
  background: var(--paper-card); border: 1px solid var(--line);
  cursor: pointer; transition: border-color 0.15s;
}
.note-card:hover { border-color: var(--muted); }
.note-card.pinned { border-left: 2px solid var(--accent); }
.note-card .note-title {
  font-family: var(--display); font-size: 14px; font-weight: 500;
  margin-bottom: 8px; color: var(--ink);
}
.note-card .note-preview {
  font-size: 12px; color: var(--muted); line-height: 1.55;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
  overflow: hidden;
}
.note-card .note-preview.md { display: block; max-height: 80px; }
.note-card .note-preview.md h2,
.note-card .note-preview.md h3,
.note-card .note-preview.md h4 { margin: 2px 0; font-size: 12px; }
.md-badge {
  display: inline-block; font-family: var(--mono); font-size: 9px;
  padding: 1px 5px; border-radius: 2px; background: var(--paper-2);
  color: var(--accent); border: 1px solid var(--accent);
  margin-left: 6px; vertical-align: middle;
  text-transform: uppercase; letter-spacing: 0.1em;
}
.note-card .note-date {
  font-family: var(--mono); font-size: 9px; color: var(--muted);
  margin-top: 12px; text-transform: uppercase; letter-spacing: 0.12em;
}

/* ----- Calendar ----- */
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.cal-header {
  text-align: center; font-family: var(--mono); font-size: 9px;
  color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em;
  padding: 8px 0; background: var(--paper-card);
}
.cal-day {
  min-height: 80px; padding: 6px; background: var(--paper-card);
  cursor: pointer; transition: background 0.15s;
}
.cal-day:hover { background: var(--paper-2); }
.cal-day.today { background: var(--accent-soft); }
.cal-day.other-month { opacity: 0.4; }
.cal-day-num {
  font-family: var(--mono); font-size: 11px;
  color: var(--ink); font-weight: 500;
  font-variant-numeric: tabular-nums; margin-bottom: 4px;
}
.cal-event {
  font-family: var(--mono); font-size: 9px; padding: 2px 4px;
  border-radius: 1px; margin-bottom: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  letter-spacing: 0.04em;
}
.cal-event.todo { background: var(--accent-soft); color: var(--accent); }
.cal-event.todo.recurring-proj { background: transparent; color: var(--accent); border: 1px dashed var(--accent); }
.cal-event.email { background: color-mix(in oklch, var(--warn) 12%, transparent); color: var(--warn); }
.cal-event.note { background: color-mix(in oklch, var(--good) 12%, transparent); color: var(--good); }

/* ----- Palette swatches (Settings page) ----- */
.palette-picker {
  display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;
}
.palette-picker button {
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid transparent; cursor: pointer; padding: 0;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.1);
  transition: border-color 0.15s;
}
.palette-picker button:hover { border-color: var(--muted); }
.palette-picker button.active { border-color: var(--ink); }

/* ----- Mobile ----- */
@media (max-width: 768px) {
  .top-cards { grid-template-columns: repeat(2, 1fr); }
  .notes-grid { grid-template-columns: 1fr; }
  .modal { width: 95%; padding: 22px; }
  .cal-day { min-height: 52px; padding: 4px; }
  .cal-event { font-size: 8px; }
  .section { padding: 18px; }
  .todo-item { padding: 14px 4px; }
  .todo-actions button { min-width: 40px; min-height: 40px; }
  .filters { overflow-x: auto; flex-wrap: nowrap; }
}
@media (max-width: 480px) {
  h1 { font-size: 20px; }
  .top-cards { grid-template-columns: 1fr; }
  .modal {
    width: 100%; max-width: 100%; max-height: 100vh; height: 100vh;
    border-radius: 0; padding: 18px; padding-bottom: 80px;
  }
  .modal-overlay.active { align-items: stretch; }
}
`;
