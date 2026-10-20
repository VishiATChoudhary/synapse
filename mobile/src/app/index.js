// Home: one room per project, a square per agent in it (outlined: needs you, orange: working). The first
// question waiting for you sits on top. Tap a room for its agents, by worktree.
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Squares, rooms, summary } from '../rooms';
import { byAttention, leaveDemo, useSynapse } from '../store';
import { FONT, useTheme } from '../theme';
import { Display, Meta } from '../ui';

function Notice({ children }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.wash, borderLeftWidth: 3, borderColor: t.sig, padding: 14, marginBottom: 16 }}>
      <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink }}>{children}</Text>
    </View>
  );
}

function Room({ r }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => router.push(`/room/${encodeURIComponent(r.key)}`)} style={({ pressed }) => ({
      width: '48.5%', minHeight: 132, backgroundColor: t.wash, padding: 14, justifyContent: 'space-between', opacity: pressed ? 0.7 : 1,
    })}>
      <Text style={{ fontFamily: FONT.display, fontSize: 22, lineHeight: 24, textTransform: 'uppercase', color: t.ink }} numberOfLines={2}>{r.label}</Text>
      <View style={{ gap: 8, marginTop: 12 }}>
        <Squares agents={r.agents} />
        <Meta color={t.ink2}>{summary(r.agents)}</Meta>
      </View>
    </Pressable>
  );
}

export default function Home() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { agents, projects, mode, computer, computers, online, access, error, user } = useSynapse();
  if (mode === 'loading') return <View style={{ flex: 1, backgroundColor: t.paper }} />;
  if (mode === 'signed-out') return <Redirect href="/login" />;
  const account = mode === 'account';
  const asking = byAttention(agents).find((a) => a.needs);
  const list = rooms(projects, agents);
  const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const connected = !account || (online && access === 'ok');
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 100, paddingHorizontal: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: connected ? 18 : 4 }}>
          <Display style={{ fontSize: 36, lineHeight: 38 }}>Synapse</Display>
          <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel="Settings"
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: t.wash, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, color: t.ink2 }}>⚙</Text>
          </Pressable>
        </View>
        {!account && (
          <Pressable onPress={() => { leaveDemo(); router.replace('/login'); }} hitSlop={8} style={{ marginBottom: 18 }}>
            <Meta color={t.sig}>Sample agents. Sign in to see yours.</Meta>
          </Pressable>
        )}
        {account && !connected && (
          <Meta style={{ marginBottom: 18 }}>{!computer ? 'No computer yet' : access === 'waiting' ? `Waiting for ${computer} to allow this phone` : `Connecting to ${computer}…`}</Meta>
        )}
        {!!error && <Meta color={t.sig} style={{ marginBottom: 12 }}>{error}</Meta>}
        {account && !computers.length && (
          <Notice>Open Synapse on your computer and sign in there as {user?.email}. It shows up here by itself.</Notice>
        )}
        {account && access === 'waiting' && (
          <Notice>Synapse on {computer} is asking whether this phone may see, start and message its agents. Click allow there, in Synapse settings under phone.</Notice>
        )}
        {account && access === 'removed' && (
          <Notice>This phone was removed in Synapse on {computer}. Sign out and in again to ask once more.</Notice>
        )}
        {account && access === 'ok' && !agents.length && (
          <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink2 }}>No agents running on {computer}. Start one with New agent.</Text>
        )}

        {asking && (
          <Pressable onPress={() => router.push(`/agent/${asking.id}`)} style={({ pressed }) => ({
            flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.sig, padding: 14, marginBottom: 16, opacity: pressed ? 0.85 : 1,
          })}>
            <View style={{ width: 10, height: 10, borderWidth: 2, borderColor: t.paper }} />
            <Text style={{ flex: 1, fontFamily: FONT.sans, fontSize: 15, lineHeight: 21, color: t.paper }} numberOfLines={2}>
              <Text style={{ fontFamily: FONT.sansMedium }}>{asking.name}</Text> asks: {asking.needs.question.replace(/`/g, '')}
            </Text>
          </Pressable>
        )}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
          {list.map((r) => <Room key={r.key} r={r} />)}
        </View>

        {recent.length > 0 && (
          <View style={{ marginTop: 26, gap: 2 }}>
            <Meta style={{ marginBottom: 6 }}>Recent</Meta>
            {recent.map((a) => (
              <Pressable key={a.id} onPress={() => router.push(`/agent/${a.id}`)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, opacity: pressed ? 0.6 : 1 })}>
                <View style={{ width: 9, height: 9, backgroundColor: a.project.color }} />
                <Text style={{ flex: 1, fontFamily: FONT.sans, fontSize: 15, color: t.ink2 }} numberOfLines={1}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
      {(!account || access === 'ok') && (
        <Pressable onPress={() => router.push('/new')} style={({ pressed }) => ({
          position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink, height: 48, paddingHorizontal: 20,
          borderRadius: 24, justifyContent: 'center', opacity: pressed ? 0.75 : 1,
        })}>
          <Text style={{ fontFamily: FONT.sansMedium, fontSize: 15, color: t.onInk }}>+ New agent</Text>
        </Pressable>
      )}
    </View>
  );
}
