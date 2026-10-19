// Every agent on the laptop, grouped by project, the ones that need you on top.
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { byAttention, source, useSynapse } from '../store';
import { FONT, useTheme } from '../theme';
import { Display, Label, Mark, Rule, ago } from '../ui';

function last(a) {
  const m = [...a.messages].reverse().find((x) => !x.tool) || a.messages.at(-1);
  return m ? `${m.role === 'user' ? 'you: ' : ''}${m.text.replace(/^>\s?|[#*`]/gm, '').replace(/\s+/g, ' ').trim()}` : 'no messages yet';
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
  const { agents, projects } = useSynapse();
  const working = agents.filter((a) => a.status === 'busy').length;
  const waiting = agents.filter((a) => a.needs).length;
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 96 }}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Label>{source.name === 'demo' ? 'demo · not paired' : 'paired'}</Label>
            <Pressable onPress={() => router.push('/settings')} hitSlop={12}><Label color={t.ink}>settings</Label></Pressable>
          </View>
          <Display style={{ marginTop: 6 }}>Synapse</Display>
          <Label style={{ marginTop: 6 }} color={t.ink2}>
            {agents.length} agents · <Text style={{ color: working ? t.sig : t.ink2 }}>{working} working</Text>
            {waiting ? <Text style={{ color: t.sig }}> · {waiting} need you</Text> : null}
          </Label>
        </View>
        {projects.map((p) => {
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
      <Pressable onPress={() => router.push('/new')} style={({ pressed }) => ({
        position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink,
        paddingVertical: 14, paddingHorizontal: 20, opacity: pressed ? 0.7 : 1,
      })}>
        <Label color={t.onInk}>+ new agent</Label>
      </Pressable>
    </View>
  );
}
