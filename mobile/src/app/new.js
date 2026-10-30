// Start an agent on the computer: workspace, folder (its own or a worktree), which agent, and the first prompt.
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { withConsent } from '../consent';
import { source, useSynapse } from '../store';
import { FONT, KINDS, R, round, useTheme } from '../theme';
import { Button, Heading, Meta, Press, haptic } from '../ui';

function Chips({ items, value, onChange }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map(({ key, label, color }) => {
        const on = key === value;
        return (
          <Press key={key} onPress={() => { haptic.pick(); onChange(key); }} sink={0.94} style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: on ? t.ink : t.card, paddingVertical: 9, paddingHorizontal: 14, ...round(R.pill),
          }}>
            {color && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />}
            <Text style={{ fontFamily: FONT.sans, fontSize: 14, color: on ? t.onInk : t.ink }}>{label}</Text>
          </Press>
        );
      })}
    </View>
  );
}

const homeOf = (p) => (p?.worktrees.find((w) => w.home) || p?.worktrees[0])?.path;

export default function New() {
  const t = useTheme();
  const { projects, kinds } = useSynapse();
  const { project: wanted } = useLocalSearchParams(); // opened from a room: start there
  const first = projects.find((p) => p.key === wanted) || projects[0];
  const [projectKey, setProject] = useState(first?.key);
  const project = projects.find((p) => p.key === projectKey);
  const [cwd, setCwd] = useState(homeOf(first));
  const [kind, setKind] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    if (prompt.trim() && !(await withConsent())) return;
    setStarting(true); setError('');
    const id = await source.spawn({ cwd, kind, prompt: prompt.trim() });
    if (!id) { setStarting(false); return setError('It did not start in time. Is Synapse open on your computer?'); }
    router.dismiss();
    router.push(`/agent/${id}`);
  };
  if (!projects.length) return (
    <View style={{ flex: 1, backgroundColor: t.paper, padding: 20 }}>
      <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink }}>No workspaces yet. Add a folder in Synapse on your computer, then start agents in it from here.</Text>
    </View>
  );
  return (
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 24 }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} automaticallyAdjustKeyboardInsets>
      <View style={{ gap: 10 }}>
        <Heading style={{ marginLeft: 4, marginBottom: 0 }}>Project</Heading>
        <Chips items={projects} value={projectKey} onChange={(k) => { setProject(k); setCwd(homeOf(projects.find((p) => p.key === k))); }} />
      </View>
      {project && project.worktrees.length > 1 && (
        <View style={{ gap: 10 }}>
          <Heading style={{ marginLeft: 4, marginBottom: 0 }}>Folder</Heading>
          <Chips items={project.worktrees.map((w) => ({ key: w.path, label: w.home ? 'main folder' : w.name }))} value={cwd} onChange={setCwd} />
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Heading style={{ marginLeft: 4, marginBottom: 0 }}>Agent</Heading>
        <Chips items={(kinds || KINDS).map((k) => ({ key: k, label: k }))} value={kind} onChange={setKind} />
      </View>
      <View style={{ gap: 10 }}>
        <Heading style={{ marginLeft: 4, marginBottom: 0 }}>First prompt</Heading>
        <TextInput
          value={prompt} onChangeText={setPrompt} multiline placeholder="What should it work on?" placeholderTextColor={t.ink3}
          style={{ minHeight: 130, textAlignVertical: 'top', fontFamily: FONT.sans, fontSize: 16, lineHeight: 22, color: t.ink, backgroundColor: t.card, ...round(R.row), padding: 16, paddingTop: 14, outlineWidth: 0 }}
        />
      </View>
      {!!error && <Text style={{ fontFamily: FONT.sans, fontSize: 14, color: t.sig }}>{error}</Text>}
      {starting
        ? <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 10 }}><ActivityIndicator color={t.ink} /><Meta>Starting {kind}…</Meta></View>
        : <Button filled disabled={!cwd} onPress={start}>{`start ${kind}`}</Button>}
    </ScrollView>
  );
}
