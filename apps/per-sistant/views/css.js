// ============================================================================
// Per-sistant — Core CSS: tokens, palettes, shell, typography
// ============================================================================
// Warm-paper design system ported from the UMS Analytics design bundle.
// Paired with css-components.js and css-pages.js via views.js.
//
// Palettes via body[data-palette]: copper | indigo | forest | slate | plum | mono
// Dark via body[data-mode="dark"]; stacks on top of any palette.
module.exports = `
:root {
  --paper: #faf7f2; --paper-2: #f2ede4; --paper-card: #ffffff;
  --ink: #221a14; --muted: #7a6f62; --line: #e2dcd0;
  --accent: oklch(62% 0.12 52); --accent-soft: oklch(92% 0.05 55);
  --good: oklch(58% 0.09 160); --warn: oklch(60% 0.14 35);
  --display: 'Inter Tight', -apple-system, BlinkMacSystemFont, sans-serif;
  --ui: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  --radius: 3px;
}
body[data-palette="copper"] { --paper:#faf7f2; --paper-2:#f2ede4; --paper-card:#ffffff; --ink:#221a14; --muted:#7a6f62; --line:#e2dcd0; --accent:oklch(62% 0.12 52); --accent-soft:oklch(92% 0.05 55); --good:oklch(58% 0.09 160); --warn:oklch(60% 0.14 35); }
body[data-palette="indigo"] { --paper:#f7f7fa; --paper-2:#eeeef4; --paper-card:#ffffff; --ink:#16162a; --muted:#6b6b82; --line:#dedde8; --accent:oklch(55% 0.16 268); --accent-soft:oklch(93% 0.04 268); --good:oklch(58% 0.12 170); --warn:oklch(60% 0.18 28); }
body[data-palette="forest"] { --paper:#f5f6f2; --paper-2:#eaece4; --paper-card:#ffffff; --ink:#15201a; --muted:#677367; --line:#dbdfd3; --accent:oklch(48% 0.10 155); --accent-soft:oklch(92% 0.04 155); --good:oklch(58% 0.12 165); --warn:oklch(60% 0.16 40); }
body[data-palette="slate"]  { --paper:#f6f7f9; --paper-2:#eceef2; --paper-card:#ffffff; --ink:#101418; --muted:#606872; --line:#dadde3; --accent:oklch(55% 0.12 240); --accent-soft:oklch(93% 0.04 240); --good:oklch(58% 0.10 160); --warn:oklch(60% 0.16 30); }
body[data-palette="plum"]   { --paper:#faf6f7; --paper-2:#f0eaec; --paper-card:#ffffff; --ink:#241620; --muted:#7a6670; --line:#e4d8dc; --accent:oklch(52% 0.14 340); --accent-soft:oklch(93% 0.04 340); --good:oklch(58% 0.10 165); --warn:oklch(62% 0.16 45); }
body[data-palette="mono"]   { --paper:#fafafa; --paper-2:#f0f0f0; --paper-card:#ffffff; --ink:#0a0a0a; --muted:#6b6b6b; --line:#d9d9d9; --accent:#0a0a0a; --accent-soft:#ebebeb; --good:oklch(50% 0.10 160); --warn:oklch(58% 0.16 30); }

/* Dark mode stacks on top of any palette */
body[data-mode="dark"] { --paper:#13110f; --paper-2:#1c1815; --paper-card:#1a1612; --ink:#f3ece0; --muted:#8a7d6c; --line:#2d2620; --accent-soft:oklch(30% 0.05 55); }
body[data-mode="dark"][data-palette="indigo"] { --paper:#0f0f17; --paper-2:#17172a; --paper-card:#14142a; --ink:#eeeef8; --muted:#8888a0; --line:#272736; --accent-soft:oklch(28% 0.06 268); }
body[data-mode="dark"][data-palette="forest"] { --paper:#0d120f; --paper-2:#151b16; --paper-card:#131917; --ink:#ecefe8; --muted:#7e8a80; --line:#232b25; --accent-soft:oklch(28% 0.05 155); }
body[data-mode="dark"][data-palette="slate"]  { --paper:#0c0f14; --paper-2:#151a22; --paper-card:#13171e; --ink:#ecf0f6; --muted:#7d8694; --line:#242a34; --accent-soft:oklch(28% 0.05 240); }
body[data-mode="dark"][data-palette="plum"]   { --paper:#130f12; --paper-2:#1d161b; --paper-card:#1b151a; --ink:#efe6ea; --muted:#8e7782; --line:#2d222a; --accent-soft:oklch(28% 0.06 340); }
body[data-mode="dark"][data-palette="mono"]   { --paper:#0a0a0a; --paper-2:#151515; --paper-card:#121212; --ink:#f0f0f0; --muted:#888; --line:#262626; --accent:#f5f5f5; --accent-soft:#222; }
/* Legacy dark compatibility: some call sites still use data-theme="light/dark" */
html[data-theme="light"] { }
html[data-theme="dark"] body { --paper:#13110f; --paper-2:#1c1815; --paper-card:#1a1612; --ink:#f3ece0; --muted:#8a7d6c; --line:#2d2620; --accent-soft:oklch(30% 0.05 55); }

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: var(--paper); }
body {
  font-family: var(--ui); color: var(--ink);
  min-height: 100vh; font-size: 14px; line-height: 1.5;
  padding-left: 220px;
  transition: padding-left 0.2s ease;
}
body.sidebar-collapsed { padding-left: 56px; }
a { color: var(--accent); text-decoration: none; transition: color 0.15s; }
a:hover { color: var(--ink); }

/* ----- Sidebar ----- */
.sidebar {
  position: fixed; top: 0; left: 0; height: 100vh; width: 220px;
  background: var(--paper-card); border-right: 1px solid var(--line);
  display: flex; flex-direction: column;
  font-family: var(--ui); z-index: 50;
  transition: width 0.2s ease;
}
body.sidebar-collapsed .sidebar { width: 56px; }
.sidebar-brand {
  padding: 18px 16px; border-bottom: 1px solid var(--line);
  display: flex; align-items: center; gap: 10px;
}
body.sidebar-collapsed .sidebar-brand { padding: 18px 12px; }
.sidebar-brand .glyph {
  width: 28px; height: 28px; background: var(--ink); color: var(--paper);
  font-family: var(--display); font-size: 14px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  border-radius: 3px; flex-shrink: 0;
}
.sidebar-brand .name {
  font-family: var(--display); font-size: 13px; font-weight: 600;
  letter-spacing: -0.2px; color: var(--ink);
}
.sidebar-brand .tag {
  font-family: var(--mono); font-size: 9px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.14em; margin-top: 2px;
}
body.sidebar-collapsed .sidebar-brand .name,
body.sidebar-collapsed .sidebar-brand .tag { display: none; }

.sidebar-nav { flex: 1; overflow: auto; padding: 10px 8px; }
.sidebar-nav a {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; margin: 1px 0; border-radius: 3px;
  text-decoration: none; color: var(--muted);
  font-size: 13px; font-weight: 400;
  border-left: 2px solid transparent;
  white-space: nowrap; overflow: hidden;
}
.sidebar-nav a:hover { background: var(--paper-2); color: var(--ink); }
.sidebar-nav a.active {
  background: var(--accent-soft); color: var(--ink);
  border-left-color: var(--accent); font-weight: 500;
}
.sidebar-nav a .icon {
  width: 14px; height: 14px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--muted);
}
.sidebar-nav a.active .icon { color: var(--accent); }
body.sidebar-collapsed .sidebar-nav a { justify-content: center; padding: 9px 12px; }
body.sidebar-collapsed .sidebar-nav a .label { display: none; }
.sidebar-nav .sep { height: 1px; background: var(--line); margin: 10px 8px; }

.sidebar-foot {
  border-top: 1px solid var(--line);
  padding: 12px 14px;
}
body.sidebar-collapsed .sidebar-foot { padding: 10px 8px; }
.sidebar-foot .collapse-btn {
  width: 100%; padding: 6px; background: transparent;
  border: 1px solid var(--line); cursor: pointer;
  color: var(--muted); border-radius: 2px;
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.sidebar-foot .collapse-btn:hover { background: var(--paper-2); color: var(--ink); }
body.sidebar-collapsed .sidebar-foot .collapse-btn .lbl { display: none; }

/* ----- App bar (crumbs) ----- */
.appbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 28px; background: var(--paper-card);
  border-bottom: 1px solid var(--line); font-size: 12px;
  position: sticky; top: 0; z-index: 10;
}
.crumbs {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  letter-spacing: 0.04em;
}
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--ink); }
.crumbs .sep { opacity: 0.4; }
.crumbs .here { color: var(--ink); }
.appbar .spacer { flex: 1; }
.appbar .mobile-sidebar-toggle {
  display: none; background: transparent; border: 1px solid var(--line);
  padding: 6px 10px; border-radius: 2px; cursor: pointer;
  font-family: var(--mono); font-size: 11px; color: var(--ink);
}

/* ----- Container & typography ----- */
.container {
  max-width: 1200px; margin: 0 auto; padding: 28px 32px;
}
h1 {
  font-family: var(--display); font-size: 32px; font-weight: 500;
  letter-spacing: -0.5px; margin-bottom: 4px; color: var(--ink);
}
h2 { font-family: var(--display); font-size: 18px; font-weight: 500; letter-spacing: -0.2px; color: var(--ink); }
h3 { font-family: var(--display); font-size: 15px; font-weight: 500; color: var(--ink); }
.subtitle {
  color: var(--muted); margin-bottom: 32px;
  font-size: 13px; font-weight: 400; line-height: 1.55;
  max-width: 720px;
}
.mono-label {
  font-family: var(--mono); font-size: 10px;
  text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--muted);
}

/* ----- Responsive ----- */
@media (max-width: 768px) {
  body { padding-left: 0; }
  .sidebar {
    transform: translateX(-100%); transition: transform 0.2s ease;
  }
  body.sidebar-open .sidebar { transform: translateX(0); }
  .appbar .mobile-sidebar-toggle { display: inline-flex; align-items: center; }
  .container { padding: 20px 16px; }
  h1 { font-size: 24px; }
}
`;
