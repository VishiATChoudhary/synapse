// How the terminals look: a theme (the app's paper, ink and accent plus the sixteen terminal colours), the font,
// its size and line height, and the cursor. Built-in themes below; more can be added under "themes" in
// ~/.synapse/app.json, in the same shape:
//   "themes": { "mine": { "label": "Mine", "dark": true, "paper": "#101418", "ink": "#E6E1CF", "sig": "#FFB454",
//                         "ansi": ["#000000", "#FF3333", ... 16 colours: black red green yellow blue magenta cyan white,
//                                  then the bright ones] } }
// The choice lives in app.json too ("look"), and in localStorage so the first paint already has it.

const A = (s) => s.split(' ').map((c) => `#${c}`);
export const THEMES = {
  signal: { label: 'Signal', dark: false, paper: '#F1EFE9', ink: '#16130F', sig: '#FF4400',
    ansi: A('16130F D64545 2F8F5B B8860B 2F5BEA B0306A 1D9BB0 6B6B6B 8A867E FF5A5A 3DB874 E3A600 5B84FF E5458F 39B6CC 16130F') },
  night: { label: 'Night', dark: true, paper: '#0B0B0B', ink: '#EDEDEA', sig: '#FF5A1F',
    ansi: A('2A2A2A D64545 2F8F5B B8860B 2F5BEA B0306A 1D9BB0 EDEDEA 8A867E FF5A5A 3DB874 E3A600 5B84FF E5458F 39B6CC FFFFFF') },
  'github-light': { label: 'GitHub Light', dark: false, paper: '#FFFFFF', ink: '#24292F', sig: '#0969DA',
    ansi: A('24292F CF222E 116329 4D2D00 0969DA 8250DF 1B7C83 6E7781 57606A A40E26 1A7F37 633C01 218BFF A475F9 3192AA 8C959F') },
  'solarized-light': { label: 'Solarized Light', dark: false, paper: '#FDF6E3', ink: '#586E75', sig: '#CB4B16',
    ansi: A('073642 DC322F 859900 B58900 268BD2 D33682 2AA198 EEE8D5 002B36 CB4B16 586E75 657B83 839496 6C71C4 93A1A1 FDF6E3') },
  'catppuccin-latte': { label: 'Catppuccin Latte', dark: false, paper: '#EFF1F5', ink: '#4C4F69', sig: '#8839EF',
    ansi: A('5C5F77 D20F39 40A02B DF8E1D 1E66F5 EA76CB 179299 ACB0BE 6C6F85 D20F39 40A02B DF8E1D 1E66F5 EA76CB 179299 BCC0CC') },
  'solarized-dark': { label: 'Solarized Dark', dark: true, paper: '#002B36', ink: '#93A1A1', sig: '#B58900',
    ansi: A('073642 DC322F 859900 B58900 268BD2 D33682 2AA198 EEE8D5 002B36 CB4B16 586E75 657B83 839496 6C71C4 93A1A1 FDF6E3') },
  dracula: { label: 'Dracula', dark: true, paper: '#282A36', ink: '#F8F8F2', sig: '#FF79C6',
    ansi: A('21222C FF5555 50FA7B F1FA8C BD93F9 FF79C6 8BE9FD F8F8F2 6272A4 FF6E6E 69FF94 FFFFA5 D6ACFF FF92DF A4FFFF FFFFFF') },
  nord: { label: 'Nord', dark: true, paper: '#2E3440', ink: '#D8DEE9', sig: '#88C0D0',
    ansi: A('3B4252 BF616A A3BE8C EBCB8B 81A1C1 B48EAD 88C0D0 E5E9F0 4C566A BF616A A3BE8C EBCB8B 81A1C1 B48EAD 8FBCBB ECEFF4') },
  'gruvbox-dark': { label: 'Gruvbox Dark', dark: true, paper: '#282828', ink: '#EBDBB2', sig: '#FE8019',
    ansi: A('282828 CC241D 98971A D79921 458588 B16286 689D6A A89984 928374 FB4934 B8BB26 FABD2F 83A598 D3869B 8EC07C EBDBB2') },
  'tokyo-night': { label: 'Tokyo Night', dark: true, paper: '#1A1B26', ink: '#C0CAF5', sig: '#7AA2F7',
    ansi: A('15161E F7768E 9ECE6A E0AF68 7AA2F7 BB9AF7 7DCFFF A9B1D6 414868 F7768E 9ECE6A E0AF68 7AA2F7 BB9AF7 7DCFFF C0CAF5') },
  'catppuccin-mocha': { label: 'Catppuccin Mocha', dark: true, paper: '#1E1E2E', ink: '#CDD6F4', sig: '#CBA6F7',
    ansi: A('45475A F38BA8 A6E3A1 F9E2AF 89B4FA F5C2E7 94E2D5 BAC2DE 585B70 F38BA8 A6E3A1 F9E2AF 89B4FA F5C2E7 94E2D5 A6ADC8') },
  'one-dark': { label: 'One Dark', dark: true, paper: '#282C34', ink: '#ABB2BF', sig: '#61AFEF',
    ansi: A('282C34 E06C75 98C379 E5C07B 61AFEF C678DD 56B6C2 ABB2BF 5C6370 E06C75 98C379 E5C07B 61AFEF C678DD 56B6C2 FFFFFF') },
  'rose-pine': { label: 'Rosé Pine', dark: true, paper: '#191724', ink: '#E0DEF4', sig: '#EBBCBA',
    ansi: A('26233A EB6F92 31748F F6C177 9CCFD8 C4A7E7 EBBCBA E0DEF4 6E6A86 EB6F92 31748F F6C177 9CCFD8 C4A7E7 EBBCBA E0DEF4') },
};

// the bundled font first; the rest are used when installed, else the next one in line
export const FONTS = ['Fragment Mono', 'SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono',
  'Source Code Pro', 'Hack', 'Iosevka', 'Berkeley Mono', 'Consolas'];
export const CURSORS = ['bar', 'block', 'underline'];
export const DEFAULT_LOOK = { theme: null, light: 'signal', dark: 'night', font: 'Fragment Mono', fontSize: 13, lineHeight: 1.25, cursor: 'bar', blink: true };

const HEX = /^#[0-9a-f]{6}$/i;
// a theme from app.json is used only when its colours are all there
const valid = (t) => t && typeof t === 'object' && [t.paper, t.ink, t.sig].every((c) => HEX.test(c)) && Array.isArray(t.ansi) && t.ansi.length === 16 && t.ansi.every((c) => HEX.test(c));
let custom = {};
export function setCustomThemes(themes) {
  custom = Object.fromEntries(Object.entries(themes || {}).filter(([k, t]) => /^[\w-]{1,40}$/.test(k) && valid(t))
    .map(([k, t]) => [k, { label: String(t.label || k).slice(0, 40), dark: !!t.dark, paper: t.paper, ink: t.ink, sig: t.sig, ansi: t.ansi, custom: true }]));
}
export const allThemes = () => ({ ...THEMES, ...custom });

let look = { ...DEFAULT_LOOK };
try { look = { ...look, ...JSON.parse(localStorage.getItem('synapse-look') || '{}') }; } catch {}
export const currentLook = () => look;
export function themeOf(l = look) {
  const all = allThemes();
  // no theme chosen yet: the light or dark one the window started with (the system's, or the toolbar's last pick)
  const id = all[l.theme] ? l.theme : document.documentElement.dataset.theme === 'night' ? (all[l.dark] ? l.dark : 'night') : (all[l.light] ? l.light : 'signal');
  return { id, ...all[id] };
}

// the app's colours follow the theme: paper, ink and accent; the rest of the palette is mixed from them in style.css.
// data-theme stays signal or night, which the node view and the file pane understand
export function paint() {
  const t = themeOf(), root = document.documentElement;
  root.dataset.theme = t.dark ? 'night' : 'signal';
  for (const [k, v] of [['--paper', t.paper], ['--ink', t.ink], ['--sig', t.sig], ['--on-ink', t.paper], ['--term-bg', t.paper]]) root.style.setProperty(k, v);
  localStorage.setItem('synapse-mode', root.dataset.theme);
  return t;
}

export function setLook(patch) {
  look = { ...look, ...patch };
  const t = themeOf();
  if (t.dark) look.dark = t.id; else look.light = t.id; // the toolbar's light / dark switch goes back to these
  localStorage.setItem('synapse-look', JSON.stringify(look));
  return look;
}

// the toolbar's switch: from a light theme to the last dark one, and back
export function flipLook() { const t = themeOf(); return setLook({ theme: t.dark ? look.light : look.dark }); }

export function xtermTheme(t = themeOf()) {
  const n = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const colours = Object.fromEntries(t.ansi.flatMap((c, i) => [[i < 8 ? n[i] : `bright${n[i - 8][0].toUpperCase()}${n[i - 8].slice(1)}`, c]]));
  return {
    background: t.paper, foreground: t.ink, cursor: t.sig, cursorAccent: t.paper,
    selectionBackground: `${t.sig}${t.dark ? '59' : '38'}`, ...colours,
  };
}

const quote = (f) => (/^[\w-]+$/.test(f) ? f : `'${f.replace(/'/g, '')}'`);
export function termOptions(l = look) {
  return {
    fontFamily: `${quote(l.font || 'Fragment Mono')}, 'Fragment Mono', Menlo, monospace`,
    fontSize: Math.min(28, Math.max(9, Number(l.fontSize) || 13)),
    lineHeight: Math.min(2, Math.max(1, Number(l.lineHeight) || 1.25)),
    cursorStyle: CURSORS.includes(l.cursor) ? l.cursor : 'bar', cursorBlink: l.blink !== false,
    theme: xtermTheme(),
  };
}
