// Start an agent on the computer: workspace, folder (its own or a worktree), which agent, and the first prompt.
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { withConsent } from '../consent';
import { source, useSynapse } from '../store';
import { FONT, KINDS, useTheme } from '../theme';
import { Button, Label } from '../ui';

function Chips({ items, value, onChange }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map(({ key, label, color }) => {
        const on = key === value;
        return (
          <Pressable key={key} onPress={() => onChange(key)} style={{
            flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: on ? t.ink : t.rule,
            backgroundColor: on ? t.ink : 'transparent', paddingVertical: 8, paddingHorizontal: 12,
          }}>
            {color && <View style={{ width: 8, height: 8, backgroundColor: color }} />}
            <Label color={on ? t.onInk : t.ink}>{label}</Label>
          </Pressable>
        );
      })}
    </View>
  );
}

const homeOf = (p) => (p?.worktrees.find((w) => w.home) || p?.worktrees[0])?.path;

export default function New() {
  const t = useTheme();
  const { projects, kinds } = useSynapse();
  const [projectKey, setProject] = useState(projects[0]?.key);
  const project = projects.find((p) => p.key === projectKey);
  const [cwd, setCwd] = useState(homeOf(projects[0]));
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
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 22 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 10 }}>
        <Label>workspace</Label>
        <Chips items={projects} value={projectKey} onChange={(k) => { setProject(k); setCwd(homeOf(projects.find((p) => p.key === k))); }} />
      </View>
      {project && project.worktrees.length > 1 && (
        <View style={{ gap: 10 }}>
          <Label>folder</Label>
          <Chips items={project.worktrees.map((w) => ({ key: w.path, label: w.home ? 'main folder' : w.name }))} value={cwd} onChange={setCwd} />
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Label>agent</Label>
        <Chips items={(kinds || KINDS).map((k) => ({ key: k, label: k }))} value={kind} onChange={setKind} />
      </View>
      <View style={{ gap: 10 }}>
        <Label>first prompt</Label>
        <TextInput
          value={prompt} onChangeText={setPrompt} multiline placeholder="what should it work on?" placeholderTextColor={t.ink3}
          style={{ minHeight: 120, textAlignVertical: 'top', fontFamily: FONT.sans, fontSize: 16, color: t.ink, borderWidth: 1, borderColor: t.rule, padding: 12 }}
        />
      </View>
      {!!error && <Text style={{ fontFamily: FONT.sans, fontSize: 14, color: t.sig }}>{error}</Text>}
      {starting
        ? <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 10 }}><ActivityIndicator color={t.ink} /><Label>starting {kind}…</Label></View>
        : <Button filled disabled={!cwd} onPress={start}>start {kind}</Button>}
    </ScrollView>
  );
}
