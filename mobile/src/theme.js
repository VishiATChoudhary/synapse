import { useColorScheme } from 'react-native';

// card: a surface a step off the paper, so groups read as soft cards instead of ruled boxes
const THEMES = {
  signal: { paper: '#F1EFE9', ink: '#16130F', sig: '#FF4400', onInk: '#F1EFE9', card: '#FBFAF7' },
  night: { paper: '#0B0B0B', ink: '#EDEDEA', sig: '#FF5A1F', onInk: '#0B0B0B', card: '#181817' },
};

function mix(a, b, p) {
  const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) * p + ch(b, i) * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}

export function useTheme() {
  const t = THEMES[useColorScheme() === 'dark' ? 'night' : 'signal'];
  return {
    ...t, ink2: mix(t.ink, t.paper, 0.62), ink3: mix(t.ink, t.paper, 0.4), rule: mix(t.ink, t.paper, 0.1), wash: mix(t.ink, t.paper, 0.05),
    sigWash: mix(t.sig, t.paper, 0.1),
  };
}

export const FONT = {
  display: 'BigShouldersDisplay_500Medium',
  mono: 'FragmentMono_400Regular',
  sans: 'Geist_400Regular',
  sansMedium: 'Geist_500Medium',
};

// corner radii, used with the continuous (squircle) curve iOS draws its own cards with
export const R = { card: 22, row: 16, bubble: 20, chip: 12, pill: 999 };
export const round = (r) => ({ borderRadius: r, borderCurve: 'continuous' });

export const KINDS = ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'shell'];
