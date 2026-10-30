import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentRow } from '../../AgentRow';
import { RenameSheet } from '../../Rename';
import { rooms, summary } from '../../rooms';
import { useSynapse } from '../../store';
import { FONT, R, round, useTheme } from '../../theme';
import { Card, FadeIn, Heading, Meta, Press } from '../../ui';

export default function Room() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { key } = useLocalSearchParams();
  const { agents, projects } = useSynapse();
  const [renaming, setRenaming] = useState(null);
  const r = rooms(projects, agents).find((x) => x.key === key);
  const project = projects.find((p) => p.key === key);
  if (!r) return <View style={{ flex: 1, backgroundColor: t.paper }}><Stack.Screen options={{ title: '' }} /></View>;
  const order = (project?.worktrees || []).map((w) => (w.home ? null : w.name));
  const groups = [...new Set([null, ...order, ...r.agents.map((a) => a.worktree || null)])]
    .map((w) => ({ w, list: r.agents.filter((a) => (a.worktree || null) === w) })).filter((g) => g.list.length);
  const ids = new Set(r.agents.map((a) => a.id));
  const tree = (list) => list.filter((a) => !a.forkOf || !ids.has(a.forkOf)).flatMap((a) => [{ a }, ...list.filter((x) => x.forkOf === a.id).map((x) => ({ a: x, fork: true }))]);
  const homeName = project?.worktrees.find((w) => w.home)?.name;
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <Stack.Screen options={{ title: '' }} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 110 }}>
        <View style={{ paddingHorizontal: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: r.color }} />
            <Text style={{ fontFamily: FONT.display, fontSize: 40, lineHeight: 44, textTransform: 'uppercase', color: t.ink, flexShrink: 1 }} numberOfLines={1}>{r.label}</Text>
          </View>
          <Meta color={t.ink2} style={{ marginTop: 4, marginBottom: 20 }}>{summary(r.agents)}. Hold an agent to rename it.</Meta>
        </View>
        {groups.map(({ w, list }, gi) => {
          const rows = tree(list);
          return (
            <FadeIn key={w || 'home'} delay={gi * 60} style={{ marginBottom: 22 }}>
              {groups.length > 1 && <Heading>{w || homeName || 'main'}</Heading>}
              <Card>
                {rows.map(({ a, fork }, i) => <AgentRow key={a.id} a={a} fork={fork} last={i === rows.length - 1} onRename={setRenaming} />)}
              </Card>
            </FadeIn>
          );
        })}
      </ScrollView>
      <Press onPress={() => router.push({ pathname: '/new', params: { project: r.key } })} style={{
        position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink, height: 52, paddingHorizontal: 22,
        ...round(R.pill), justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
      }}>
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 15, color: t.onInk }}>+ New agent here</Text>
      </Press>
      <RenameSheet agent={renaming} onClose={() => setRenaming(null)} />
    </View>
  );
}
