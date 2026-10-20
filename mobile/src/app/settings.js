// Account, computer, privacy and contact. Kept reachable from the home screen (App Review 5.1.1(i), (v), 1.2).
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { DISCLOSURE, revokeConsent, useConsent } from '../consent';
import { DEFAULT_CLOUD } from '../link';
import { setMediaOn, supported as mediaSupported, useMediaOn } from '../media';
import { choose, deleteAccount, leaveDemo, signOutPhone, useSynapse } from '../store';
import { FONT, useTheme } from '../theme';
import { Button, Label, Rule, ago } from '../ui';

const SUPPORT_URL = 'https://github.com/VishiATChoudhary/synapse/issues';

function Section({ title, children }) {
  return (
    <View style={{ gap: 10 }}>
      <Label>{title}</Label>
      {children}
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const { given } = useConsent();
  const mediaOn = useMediaOn();
  const { mode, user, computers, computerId } = useSynapse();
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const body = { fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink };
  const out = async () => { await signOutPhone(); router.replace('/login'); };
  const remove = async () => {
    setError('');
    try { await deleteAccount(password); router.replace('/login'); } catch (e) { setError(e.message); }
  };
  return (
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 22 }} keyboardShouldPersistTaps="handled">
      {mode === 'account' ? (
        <>
          <Section title="account">
            <Text style={body}>{user?.name}{user?.email ? ` · ${user.email}` : ''}</Text>
            <Button onPress={out}>sign out</Button>
          </Section>
          <Rule />
          <Section title="computer">
            {!computers.length && <Text style={[body, { color: t.ink2 }]}>None yet. Sign in to Synapse on your computer with this account.</Text>}
            {computers.map((c) => (
              <Pressable key={c.id} onPress={() => choose(c)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: c.id === computerId ? t.ink : t.rule, padding: 12 }}>
                <View style={{ width: 8, height: 8, backgroundColor: c.id === computerId ? t.sig : t.rule }} />
                <Text style={[body, { flex: 1 }]}>{c.name}</Text>
                <Label>{c.lastSeen ? `seen ${ago(c.lastSeen)}` : ''}</Label>
              </Pressable>
            ))}
          </Section>
        </>
      ) : (
        <Section title="sample agents">
          <Text style={body}>These are sample agents, nothing leaves this phone. Sign in to see the agents on your own computer.</Text>
          <Button filled onPress={() => { leaveDemo(); router.replace('/login'); }}>sign in</Button>
        </Section>
      )}
      {mediaSupported && (
        <>
          <Rule />
          <Section title="images and videos">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text style={[body, { flex: 1 }]}>Show the screenshots and videos your agents make in their chats.</Text>
              <Switch value={mediaOn} onValueChange={setMediaOn} trackColor={{ true: t.sig }} />
            </View>
            <Text style={[body, { color: t.ink2, fontSize: 13 }]}>Videos come as a small phone copy, at most 8 MB each.</Text>
          </Section>
        </>
      )}
      <Rule />
      <Section title="your prompts">
        <Text style={body}>{DISCLOSURE}</Text>
        <Text style={[body, { color: t.ink2 }]}>{given ? 'You agreed to this.' : 'Not agreed yet: you will be asked before your first prompt.'}</Text>
        {given && <Button onPress={revokeConsent}>withdraw consent</Button>}
      </Section>
      <Rule />
      <Section title="privacy and help">
        <Button onPress={() => Linking.openURL(`${DEFAULT_CLOUD}/privacy`)}>privacy policy</Button>
        <Button onPress={() => Linking.openURL(SUPPORT_URL)}>contact and support</Button>
      </Section>
      {mode === 'account' && (
        <>
          <Rule />
          <Section title="delete account">
            {!deleting ? <Button onPress={() => setDeleting(true)}>delete my synapse account</Button> : (
              <View style={{ gap: 10 }}>
                <Text style={body}>This deletes your Synapse account, your trusted people and every share, on all your devices. It cannot be undone.</Text>
                {user?.hasPassword !== false && <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="your password" placeholderTextColor={t.ink3}
                  style={{ fontFamily: FONT.sans, fontSize: 16, color: t.ink, borderWidth: 1, borderColor: t.rule, padding: 12 }} />}
                {!!error && <Text style={[body, { color: t.sig }]}>{error}</Text>}
                <Button filled onPress={remove}>delete forever</Button>
                <Button onPress={() => { setDeleting(false); setPassword(''); setError(''); }}>keep my account</Button>
              </View>
            )}
          </Section>
        </>
      )}
    </ScrollView>
  );
}
