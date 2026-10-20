// Every agent on the laptop, grouped by project, the ones that need you on top.
import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { byAttention, leaveDemo, useSynapse } from '../store';
import { FONT, useTheme } from '../theme';
import { Display, Label, Mark, Rule, ago } from '../ui';

function last(a) {
  const m = [...a.messages].reverse().find((x) => !x.tool) || a.messages.at(-1) || a.preview;
  return m ? `${m.role === 'user' ? 'you: ' : ''}${m.text.replace(/^>\s?|[#*`]/gm, '').replace(/\s+/g, ' ').trim()}` : 'no messages yet';
}

// agents grouped by their project: the computer's workspaces in its order, then folders it has no workspace for
function groups(projects, agents) {
  const out = projects.map((p) => ({ ...p }));
  for (const a of agents) if (!out.some((p) => p.key === a.project.key)) out.push(a.project);
  return out;
}

// what stands between the phone and the agents, in words: no computer yet, not allowed yet, removed
function Notice({ title, children }) {
  const t = useTheme();
  return (
    <View style={{ marginHorizontal: 20, marginBottom: 16, borderWidth: 1, borderColor: t.sig, padding: 16, gap: 8 }}>
      <Label color={t.sig}>{title}</Label>
      <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink }}>{children}</Text>
    </View>
  );
}

function AgentRow({ a }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => router.push(`/agent/${a.id}`)} style={({ pressed }) => ({ paddingVertical: 14, paddingHorizontal: 20, backgroundColor: pressed ? t.wash : 'transparent' })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Mark color={a.project.color} status={a.status} needs={a.needs} />
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink, flexShrink: 1 }} numberOfLines={1}>{a.name}</Text>
        <Label>{a.kind}</Label>
        <View style={{ flex: 1 }} />
        <Label color={a.needs || a.status === 'busy' ? t.sig : t.ink3}>{a.needs ? 'needs you' : a.status === 'busy' ? 'working' : ago(a.updatedAt)}</Label>
      </View>
      <Text style={{ fontFamily: FONT.sans, fontSize: 14, color: t.ink2, marginTop: 6, marginLeft: 20 }} numberOfLines={2}>
        {a.needs ? a.needs.question.replace(/`/g, '') : last(a)}
      </Text>
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
  const working = agents.filter((a) => a.status === 'busy').length;
  const waiting = agents.filter((a) => a.needs).length;
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 96 }}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {!account
              ? <Pressable onPress={() => { leaveDemo(); router.replace('/login'); }} hitSlop={12}><Label color={t.sig}>sample agents · sign in</Label></Pressable>
              : <Pressable onPress={() => router.push('/settings')} hitSlop={12} style={{ flexShrink: 1, marginRight: 12 }}><Label numberOfLines={1} color={online && access === 'ok' ? t.ink2 : t.ink3}>{computer || 'no computer'} · {!computer ? 'set up' : access === 'ok' && online ? 'connected' : access === 'waiting' ? 'not allowed yet' : 'connecting…'}</Label></Pressable>}
            <Pressable onPress={() => router.push('/settings')} hitSlop={12}><Label color={t.ink}>settings</Label></Pressable>
          </View>
          <Display style={{ marginTop: 6 }}>Synapse</Display>
          <Label style={{ marginTop: 6 }} color={t.ink2}>
            {agents.length} agents · <Text style={{ color: working ? t.sig : t.ink2 }}>{working} working</Text>
            {waiting ? <Text style={{ color: t.sig }}> · {waiting} need you</Text> : null}
          </Label>
        </View>
        {!!error && <Text style={{ fontFamily: FONT.sans, fontSize: 14, color: t.sig, paddingHorizontal: 20, paddingBottom: 12 }}>{error}</Text>}
        {account && !computers.length && (
          <Notice title="connect your computer">Open Synapse on your computer and sign in there as {user?.email}. It shows up here by itself.</Notice>
        )}
        {account && access === 'waiting' && (
          <Notice title={`allow this phone on ${computer}`}>Synapse on {computer} is asking whether this phone may see, start and message its agents. Click allow there (Synapse settings, phone).</Notice>
        )}
        {account && access === 'removed' && (
          <Notice title={`removed on ${computer}`}>This phone was removed in Synapse on {computer}. Sign out and in again to ask once more.</Notice>
        )}
        {account && !!computers.length && access === 'unknown' && !agents.length && (
          <Notice title="connecting">Waiting for {computer}. Synapse has to be open there.</Notice>
        )}
        {account && access === 'ok' && !agents.length && (
          <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink2, paddingHorizontal: 20 }}>No agents running on {computer}. Start one with + new agent.</Text>
        )}
        {groups(projects, agents).map((p) => {
          const list = byAttention(agents.filter((a) => a.project.key === p.key));
          if (!list.length) return null;
          return (
            <View key={p.key} style={{ marginTop: 8 }}>
              <Rule />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 12 }}>
                <View style={{ width: 6, height: 6, backgroundColor: p.color }} />
                <Label color={t.ink}>{p.label}</Label>
              </View>
              {list.map((a) => <AgentRow key={a.id} a={a} />)}
            </View>
          );
        })}
      </ScrollView>
      {(!account || access === 'ok') && <Pressable onPress={() => router.push('/new')} style={({ pressed }) => ({
        position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink,
        paddingVertical: 14, paddingHorizontal: 20, opacity: pressed ? 0.7 : 1,
      })}>
        <Label color={t.onInk}>+ new agent</Label>
      </Pressable>}
    </View>
  );
}
