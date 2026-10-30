import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { source } from './store';
import { FONT, R, round, useTheme } from './theme';
import { Button, Meta, Sheet, haptic } from './ui';

// Rename an agent from anywhere: pass the agent to open, null to close.
// An empty name hands the agent back to its automatic name.
export function RenameSheet({ agent, onClose }) {
  const t = useTheme();
  const [a, setA] = useState(null); // the last agent opened, still shown while the sheet slides away
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (agent && agent !== a) { setA(agent); setName(agent.name || ''); setError(''); setSaving(false); }
  if (!a) return null;
  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    let r;
    try { r = await source.rename(a.id, name.trim()); } catch (e) { r = { error: e.message }; }
    setSaving(false);
    if (r?.ok) { haptic.done(); onClose(); } else { haptic.fail(); setError(r?.error || 'Could not rename it.'); }
  };
  return (
    <Sheet visible={!!agent} onClose={onClose}>
      <Text style={{ fontFamily: FONT.sansMedium, fontSize: 18, color: t.ink }}>Rename</Text>
      {!!a.about && <Meta color={t.ink2} numberOfLines={2}>{a.about}</Meta>}
      <TextInput
        value={name} onChangeText={setName} autoFocus selectTextOnFocus placeholder="Automatic name" placeholderTextColor={t.ink3}
        returnKeyType="done" onSubmitEditing={save} autoCorrect={false} maxLength={80} clearButtonMode="while-editing"
        style={{ fontFamily: FONT.sans, fontSize: 17, color: t.ink, backgroundColor: t.card, ...round(R.row), paddingHorizontal: 16, paddingVertical: 14, outlineWidth: 0 }}
      />
      <Meta>Leave it empty to go back to the automatic name.</Meta>
      {!!error && <Meta color={t.sig}>{error}</Meta>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button style={{ flex: 1 }} onPress={onClose}>cancel</Button>
        <Button style={{ flex: 1 }} filled disabled={saving} onPress={save}>{saving ? 'saving…' : 'save'}</Button>
      </View>
    </Sheet>
  );
}
