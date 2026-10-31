// Your own shortcuts, set in Settings (kept under "shortcuts" in ~/.synapse/app.json). Each one is a key combination
// and what it does:
//   { "keys": "cmd+alt+c", "action": "agent", "kind": "claude", "cwd": "", "text": "review the last commit" }
//       opens an agent tab (cwd: a workspace folder; empty is the focused one), text is its first prompt
//   { "keys": "cmd+shift+g", "action": "run", "text": "git status" }     types the text into the focused tab and runs it
//   { "keys": "cmd+alt+l", "action": "type", "text": "ls -la" }          types it without running it
//   { "keys": "cmd+alt+t", "action": "command", "command": "split-right" } one of COMMANDS below
//   { "keys": "cmd+alt+1", "action": "theme", "theme": "dracula" }       switches the theme
// A combination of yours wins over the built-in one with the same keys.

export const ACTIONS = [
  ['agent', 'open an agent tab'], ['run', 'run a command'], ['type', 'type text'], ['command', 'app command'], ['theme', 'switch theme'],
];
export const COMMANDS = [
  ['shell', 'new shell tab'], ['agent-picker', 'agent picker'], ['split-right', 'split side by side'], ['split-down', 'split top and bottom'],
  ['close', 'close tab'], ['next', 'next tab'], ['prev', 'previous tab'], ['sidebar', 'toggle sidebar'], ['fork', 'fork'],
  ['fork-tree', 'fork tree'], ['canvas', 'node view'], ['search', 'find in terminal'], ['theme-toggle', 'light / dark'],
  ['past-chats', 'past chats'], ['worktree', 'new worktree'], ['settings', 'settings'],
];

const CODES = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-',
  Equal: '=', Backslash: '\\', Enter: 'enter', Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Escape: 'escape',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};
const MODS = ['ctrl', 'alt', 'shift', 'cmd'];
// the physical key, so a combination is the same on every keyboard layout
function keyOf(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^F\d{1,2}$/.test(e.code)) return e.code.toLowerCase();
  return CODES[e.code] || null;
}
// "cmd+shift+k" for the event, or null for a lone modifier
export function comboOf(e) {
  const k = keyOf(e);
  if (!k) return null;
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'cmd', k].filter(Boolean).join('+');
}
// a shortcut needs a modifier (other than Shift alone) or a function key, so typing never sets one off
export function usable(combo) {
  const parts = String(combo || '').split('+'), key = parts.at(-1);
  return /^f\d{1,2}$/.test(key) || parts.slice(0, -1).some((m) => m !== 'shift' && MODS.includes(m));
}
// written in the order comboOf writes it, whatever order app.json has it in
export function normal(combo) {
  const parts = String(combo || '').toLowerCase().replace(/\s+/g, '').replace(/\bmeta\b|\bcommand\b|\bsuper\b/g, 'cmd').replace(/\bcontrol\b/g, 'ctrl').replace(/\boption\b|\bopt\b/g, 'alt').split('+');
  const key = parts.pop();
  return [...MODS.filter((m) => parts.includes(m)), key].join('+');
}
const GLYPH = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const NAMES = { enter: '↩', space: 'Space', tab: '⇥', backspace: '⌫', delete: '⌦', escape: 'esc', up: '↑', down: '↓', left: '←', right: '→' };
export function pretty(combo, win = false) {
  if (!combo) return '';
  const parts = normal(combo).split('+'), key = parts.pop();
  const k = NAMES[key] || key.toUpperCase();
  return win ? [...parts.map((m) => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Win' }[m])), k].join('+') : parts.map((m) => GLYPH[m]).join('') + k;
}

let list = [];
export function setShortcuts(items) {
  list = (Array.isArray(items) ? items : []).filter((s) => s && usable(normal(s.keys)) && ACTIONS.some(([a]) => a === s.action)).map((s) => ({ ...s, keys: normal(s.keys) }));
}
export const shortcuts = () => list;
export const match = (e) => { const c = comboOf(e); return c ? list.find((s) => s.keys === c) || null : null; };
