// App Review 5.1.2(i): say where prompts go (your computer, then the AI providers your agents use)
// and get an explicit yes before the first one leaves the phone. Asked once, revocable in settings.
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform, Text } from 'react-native';
import { FONT, useTheme } from './theme';
import { Button, Label, Sheet } from './ui';

const KEY = 'ai-consent-v1';
const store = Platform.OS === 'web'
  ? { get: async () => globalThis.localStorage?.getItem(KEY), set: async (v) => (v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY)) }
  : { get: () => SecureStore.getItemAsync(KEY), set: (v) => (v ? SecureStore.setItemAsync(KEY, v) : SecureStore.deleteItemAsync(KEY)) };

let state = { given: false, asking: null };
const listeners = new Set();
const set = (next) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };
store.get().then((v) => set({ given: !!v })).catch(() => {});

export const useConsent = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);

// resolves true once the user agreed (now or before), false if they declined
export function withConsent() {
  if (state.given) return Promise.resolve(true);
  return new Promise((resolve) => set({ asking: resolve }));
}

export function revokeConsent() {
  store.set(null);
  set({ given: false });
}

function answer(yes) {
  const resolve = state.asking;
  if (yes) store.set(new Date().toISOString());
  set({ given: yes, asking: null });
  resolve?.(yes);
}

export const DISCLOSURE = 'What you type here is sent to your own computer, where Synapse hands it to the coding agent you picked. '
  + 'That agent sends it, along with code from your project, to its AI provider (for example Anthropic for Claude, OpenAI for Codex, Google for Gemini) under your own account with them. '
  + 'Synapse does not store your prompts or use them for anything else.';

export function ConsentSheet() {
  const t = useTheme();
  const { asking } = useConsent();
  return (
    <Sheet visible={!!asking} onClose={() => answer(false)}>
      <Label color={t.ink}>before your first prompt</Label>
      <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink }}>{DISCLOSURE}</Text>
      <Text style={{ fontFamily: FONT.sans, fontSize: 13, lineHeight: 19, color: t.ink2 }}>You can withdraw this any time in settings.</Text>
      <Button filled onPress={() => answer(true)}>agree and send</Button>
      <Button onPress={() => answer(false)}>not now</Button>
    </Sheet>
  );
}
