// Same system as the desktop app and canvas: one ink on paper, hairline rules, square marks,
// mono uppercase labels, condensed display type, orange only for live state.
import { useColorScheme } from 'react-native';

const THEMES = {
  signal: { paper: '#F1EFE9', ink: '#16130F', sig: '#FF4400', onInk: '#F1EFE9' },
  night: { paper: '#0B0B0B', ink: '#EDEDEA', sig: '#FF5A1F', onInk: '#0B0B0B' },
};

// color-mix(in srgb, ink p%, paper) for hex colours
function mix(a, b, p) {
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}

export function useTheme() {
  const t = THEMES[useColorScheme() === 'dark' ? 'night' : 'signal'];
  return { ...t, ink2: mix(t.ink, t.paper, 0.62), ink3: mix(t.ink, t.paper, 0.4), rule: mix(t.ink, t.paper, 0.18), wash: mix(t.ink, t.paper, 0.05) };
}

export const FONT = {
  display: 'BigShouldersDisplay_500Medium',
  mono: 'FragmentMono_400Regular',
  sans: 'Geist_400Regular',
  sansMedium: 'Geist_500Medium',
};

export const KINDS = ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'shell'];
