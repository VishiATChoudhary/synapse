// The first screen: sign in to the Synapse account the computer is signed in to (or create one).
// Email and password only; the demo is a quiet link for anyone who wants to look first.
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_CLOUD } from '../link';
import { signInWith, tryDemo } from '../store';
import { FONT, useTheme } from '../theme';
import { Button, Display, Label } from '../ui';

export default function Login() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [create, setCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = { fontFamily: FONT.sans, fontSize: 16, color: t.ink, borderBottomWidth: 1, borderColor: t.rule, paddingVertical: 12 };
  const small = { fontFamily: FONT.sans, fontSize: 13, lineHeight: 19, color: t.ink2 };
  const ready = email.trim() && password && (!create || name.trim());

  const go = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await signInWith({ email: email.trim(), password, name: name.trim(), create }, Device.deviceName || Device.modelName || 'iPhone');
      router.replace('/');
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24, gap: 18 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 14, height: 14, backgroundColor: t.sig }} />
          <Display>Synapse</Display>
        </View>
        <Text style={[small, { fontSize: 15, lineHeight: 22 }]}>Your coding agents, from your phone. Sign in with the account you use in Synapse on your computer.</Text>
        <View style={{ flexDirection: 'row', borderWidth: 1, borderColor: t.rule }}>
          {[['sign in', false], ['create account', true]].map(([label, c]) => (
            <Pressable key={label} onPress={() => { setCreate(c); setError(''); }} style={{ flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: create === c ? t.ink : 'transparent' }}>
              <Label color={create === c ? t.onInk : t.ink2}>{label}</Label>
            </Pressable>
          ))}
        </View>
        {create && <TextInput value={name} onChangeText={setName} placeholder="your name" placeholderTextColor={t.ink3} autoComplete="name" textContentType="name" style={field} />}
        <TextInput value={email} onChangeText={setEmail} placeholder="email" placeholderTextColor={t.ink3} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" style={field} />
        <TextInput value={password} onChangeText={setPassword} placeholder="password" placeholderTextColor={t.ink3} secureTextEntry autoComplete={create ? 'new-password' : 'current-password'} textContentType={create ? 'newPassword' : 'password'} onSubmitEditing={go} returnKeyType="go" style={field} />
        {!!error && <Text style={[small, { color: t.sig, fontSize: 14 }]}>{error}</Text>}
        {busy
          ? <View style={{ padding: 12, alignItems: 'center' }}><ActivityIndicator color={t.ink} /></View>
          : <Button filled disabled={!ready} onPress={go}>{create ? 'create account' : 'sign in'}</Button>}
        {create
          ? <Text style={small}>By creating an account you agree to the <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(`${DEFAULT_CLOUD}/terms`)}>terms</Text> and the <Text style={{ textDecorationLine: 'underline' }} onPress={() => Linking.openURL(`${DEFAULT_CLOUD}/privacy`)}>privacy policy</Text>.</Text>
          : <Pressable onPress={() => Linking.openURL(`${DEFAULT_CLOUD}/forgot`)} hitSlop={8}><Label>forgot password?</Label></Pressable>}
        <View style={{ flex: 1, minHeight: 40 }} />
        <Pressable onPress={() => { tryDemo(); router.replace('/'); }} hitSlop={8} style={{ alignSelf: 'center' }}>
          <Label style={{ textAlign: 'center' }}>no computer yet? look around with sample agents</Label>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
