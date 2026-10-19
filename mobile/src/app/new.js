// Start an agent on the laptop: project, worktree, which agent, and the first prompt.
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { withConsent } from '../consent';
import { source, useSynapse } from '../store';
import { FONT, KINDS, useTheme } from '../theme';
import { Button, Label } from '../ui';

function Chips({ items, value, onChange, color }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map(({ key, label, color: c }) => {
        const on = key === value;
        return (
          <Pressable key={key} onPress={() => onChange(key)} style={{
            flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: on ? t.ink : t.rule,
            backgroundColor: on ? t.ink : 'transparent', paddingVertical: 8, paddingHorizontal: 12,
          }}>
            {(c || color) && <View style={{ width: 8, height: 8, backgroundColor: c || color }} />}
            <Label color={on ? t.onInk : t.ink}>{label}</Label>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function New() {
  const t = useTheme();
  const { projects } = useSynapse();
  const [projectKey, setProject] = useState(projects[0]?.key);
  const [worktree, setWorktree] = useState('');
  const [kind, setKind] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const project = projects.find((p) => p.key === projectKey);
  const start = async () => {
    if (prompt.trim() && !(await withConsent())) return;
    const id = source.spawn({ projectKey, worktree: worktree || null, kind, prompt: prompt.trim() });
    router.dismiss();
    router.push(`/agent/${id}`);
  };
  return (
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 22 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 10 }}>
        <Label>project</Label>
        <Chips items={projects} value={projectKey} onChange={(k) => { setProject(k); setWorktree(''); }} />
      </View>
      {project && (
        <View style={{ gap: 10 }}>
          <Label>worktree</Label>
          <Chips items={[{ key: '', label: 'main folder' }, ...project.worktrees.map((w) => ({ key: w, label: w }))]} value={worktree} onChange={setWorktree} />
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Label>agent</Label>
        <Chips items={KINDS.map((k) => ({ key: k, label: k }))} value={kind} onChange={setKind} />
      </View>
      <View style={{ gap: 10 }}>
        <Label>first prompt</Label>
        <TextInput
          value={prompt} onChangeText={setPrompt} multiline placeholder="what should it work on?" placeholderTextColor={t.ink3}
          style={{ minHeight: 120, textAlignVertical: 'top', fontFamily: FONT.sans, fontSize: 16, color: t.ink, borderWidth: 1, borderColor: t.rule, padding: 12 }}
        />
      </View>
      <Button filled disabled={!project} onPress={start}>start {kind}</Button>
    </ScrollView>
  );
}
