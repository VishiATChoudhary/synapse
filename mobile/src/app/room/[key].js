// One project: its agents by worktree, the one that needs you first, forks under their parent.
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { rooms, summary } from '../../rooms';
import { useSynapse } from '../../store';
import { FONT, useTheme } from '../../theme';
import { Mark, Meta } from '../../ui';

function preview(a) {
  if (a.needs) return a.needs.question.replace(/`/g, '');
  const m = [...a.messages].reverse().find((x) => !x.tool) || a.messages.at(-1) || a.preview;
  return m ? `${m.role === 'user' ? 'You: ' : ''}${m.text.replace(/^>\s?|^\s*[-*]\s+|[#*`[\]]/gm, '').replace(/\s+/g, ' ').trim()}` : 'No messages yet';
}

function Row({ a, fork }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => router.push(`/agent/${a.id}`)} style={({ pressed }) => ({ flexDirection: 'row', gap: 12, paddingVertical: 10, paddingLeft: fork ? 22 : 0, opacity: pressed ? 0.6 : 1 })}>
      {fork && <View style={{ position: 'absolute', left: 4, top: 0, height: 24, width: 10, borderLeftWidth: 1, borderBottomWidth: 1, borderColor: t.rule }} />}
      <View style={{ paddingTop: 6 }}><Mark color={t.ink3} status={a.status} needs={a.needs} size={9} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink }} numberOfLines={1}>{a.name}</Text>
        <Text style={{ fontFamily: FONT.sans, fontSize: 14, lineHeight: 20, color: a.needs ? t.ink : t.ink2 }} numberOfLines={1}>{preview(a)}</Text>
      </View>
    </Pressable>
  );
}

export default function Room() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { key } = useLocalSearchParams();
  const { agents, projects } = useSynapse();
  const r = rooms(projects, agents).find((x) => x.key === key);
  const project = projects.find((p) => p.key === key);
  if (!r) return <View style={{ flex: 1, backgroundColor: t.paper }}><Stack.Screen options={{ title: '' }} /></View>;
  // worktrees in the project's order (home first), each with its agents; forks right under their parent
  const order = (project?.worktrees || []).map((w) => (w.home ? null : w.name));
  const groups = [...new Set([null, ...order, ...r.agents.map((a) => a.worktree || null)])]
    .map((w) => ({ w, list: r.agents.filter((a) => (a.worktree || null) === w) })).filter((g) => g.list.length);
  const ids = new Set(r.agents.map((a) => a.id));
  const tree = (list) => list.filter((a) => !a.forkOf || !ids.has(a.forkOf)).flatMap((a) => [{ a }, ...list.filter((x) => x.forkOf === a.id).map((x) => ({ a: x, fork: true }))]);
  const homeName = project?.worktrees.find((w) => w.home)?.name;
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <Stack.Screen options={{ title: '' }} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 100 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 12, height: 12, backgroundColor: r.color }} />
          <Text style={{ fontFamily: FONT.display, fontSize: 40, lineHeight: 42, textTransform: 'uppercase', color: t.ink, flexShrink: 1 }} numberOfLines={1}>{r.label}</Text>
        </View>
        <Meta color={t.ink2} style={{ marginTop: 6, marginBottom: 18 }}>{summary(r.agents)}</Meta>
        {groups.map(({ w, list }) => (
          <View key={w || 'home'} style={{ marginBottom: 16 }}>
            {groups.length > 1 && <Meta style={{ marginBottom: 2 }}>{w || homeName || 'main'}</Meta>}
            {tree(list).map(({ a, fork }) => <Row key={a.id} a={a} fork={fork} />)}
          </View>
        ))}
      </ScrollView>
      <Pressable onPress={() => router.push({ pathname: '/new', params: { project: r.key } })} style={({ pressed }) => ({
        position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink, height: 48, paddingHorizontal: 20,
        borderRadius: 24, justifyContent: 'center', opacity: pressed ? 0.75 : 1,
      })}>
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 15, color: t.onInk }}>+ New agent here</Text>
      </Pressable>
    </View>
  );
}
