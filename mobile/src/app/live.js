// Live: everything the computer opened for this phone. Each is a public link through Cloudflare until it runs
// out or is stopped here (or on the computer, in Synapse settings under phone).
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openShare } from '../LinkChips';
import { minutesLeft } from '../links';
import { source, useSynapse } from '../store';
import { FONT, R, round, useTheme } from '../theme';
import { Button, FadeIn, Meta } from '../ui';

function Row({ s, now }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const left = minutesLeft(s.expires, now);
  const more = async () => { setBusy(true); await source.extend(s.id); setBusy(false); };
  return (
    <FadeIn style={{ backgroundColor: t.card, ...round(R.card), padding: 16, gap: 12 }}>
      <View style={{ gap: 3 }}>
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink }} numberOfLines={1}>{s.label}</Text>
        <Meta color={s.state === 'error' ? t.sig : t.ink2}>
          {s.state === 'error' ? s.error : s.state === 'starting' ? 'Starting…' : `${s.kind === 'site' ? 'Site' : 'File'} · ${left} min left`}
        </Meta>
      </View>
      {s.state === 'live' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button small filled style={{ flex: 1 }} onPress={() => openShare(s.url)}>Open</Button>
          <Button small style={{ flex: 1 }} disabled={busy} onPress={more}>+15 min</Button>
          <Button small style={{ flex: 1 }} onPress={() => source.unshare(s.id)}>Stop</Button>
        </View>
      )}
    </FadeIn>
  );
}

export default function Live() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { shares = [] } = useSynapse();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20, gap: 10 }}>
      <Text style={{ fontFamily: FONT.sans, fontSize: 14, lineHeight: 20, color: t.ink2, marginBottom: 6 }}>
        Links and files your computer opened for this phone. Anyone with a link can open it until it runs out or you stop it.
      </Text>
      {shares.length ? shares.map((s) => <Row key={s.id} s={s} now={now} />) : <Meta>Nothing open. Tap a localhost link or a file in an agent’s chat to open it here.</Meta>}
    </ScrollView>
  );
}
