// Under a message: the localhost links and files it mentions, each opening on the phone through a short-lived
// tunnel from the computer (15 minutes, more from the Live screen). Errors show right under the chip.
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { isSite, labelOf, targetsIn } from './links';
import { source } from './store';
import { FONT, useTheme } from './theme';
import { Meta } from './ui';

export async function openShare(url) {
  if (Platform.OS === 'web') { window.open(url, '_blank'); return; }
  await WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}

function Chip({ agentId, target }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await source.share(agentId, target);
    setBusy(false);
    if (r?.share?.state === 'live' && r.share.url) return openShare(r.share.url);
    setError(r?.error || r?.share?.error || 'Could not open it.');
  };
  return (
    <View style={{ gap: 4, maxWidth: '100%' }}>
      <Pressable onPress={open} onLongPress={() => router.push('/live')} style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: busy ? t.sig : t.rule,
        paddingVertical: 6, paddingHorizontal: 10, opacity: pressed ? 0.6 : 1,
      })}>
        <Text style={{ fontFamily: FONT.mono, fontSize: 12, color: t.sig }}>{busy ? '…' : isSite(target) ? '◎' : '↗'}</Text>
        <Text style={{ fontFamily: FONT.mono, fontSize: 12, color: t.ink, flexShrink: 1 }} numberOfLines={1}>{busy ? `Opening ${labelOf(target)}` : labelOf(target)}</Text>
      </Pressable>
      {!!error && <Meta color={t.sig}>{error}</Meta>}
    </View>
  );
}

export function LinkChips({ agentId, text }) {
  const targets = targetsIn(text).filter((x) => isSite(x) || !/\.(mp4|mov|webm|gif)$/i.test(x)).slice(0, 6); // videos already play in the chat
  if (!targets.length) return null;
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{targets.map((x) => <Chip key={x} agentId={agentId} target={x} />)}</View>;
}
