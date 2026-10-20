// The first screen: sign in to the Synapse account the computer is signed in to (or create one), with
// Apple, GitHub, Google, X or email. App Review 4.8: with GitHub, Google and X on offer, Sign in with Apple
// is offered too. The demo is a quiet link for anyone who wants to look first.
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View, useColorScheme } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_CLOUD, providers } from '../link';
import { signInWith, signInWithApple, signInWithProvider, tryDemo } from '../store';
import { FONT, useTheme } from '../theme';
import { Button, Display, Label } from '../ui';

export default function Login() {
  const t = useTheme();
  const dark = useColorScheme() === 'dark';
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
  const phoneName = Device.deviceName || Device.modelName || 'iPhone';
  const [offered, setOffered] = useState([]);
  const [apple, setApple] = useState(false);
  useEffect(() => {
    providers(DEFAULT_CLOUD).then((p) => setOffered(['github', 'google', 'x'].filter((k) => p[k]))).catch(() => {});
    if (Platform.OS === 'ios') AppleAuthentication.isAvailableAsync().then(setApple).catch(() => {});
  }, []);
  const done = () => router.replace('/');
  const attempt = async (fn) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); done(); }
    catch (e) { if (e.code !== 'ERR_REQUEST_CANCELED' && e.message !== 'cancelled') setError(e.message); setBusy(false); }
  };
  const withApple = () => attempt(async () => {
    const c = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL] });
    const name = [c.fullName?.givenName, c.fullName?.familyName].filter(Boolean).join(' ');
    await signInWithApple({ identityToken: c.identityToken, name }, phoneName);
  });
  // the provider's sign-in, then "Connect", in a browser sheet; it closes by itself once the app is connected
  const withProvider = (p) => attempt(async () => {
    try { await signInWithProvider(p, phoneName, (url) => WebBrowser.openAuthSessionAsync(url, 'synapse://signed-in')); }
    finally { WebBrowser.dismissAuthSession(); }
  });
  const LABEL = { github: 'GitHub', google: 'Google', x: 'X' };

  const go = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await signInWith({ email: email.trim(), password, name: name.trim(), create }, phoneName);
      done();
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
        {apple && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={0} style={{ height: 46 }} onPress={withApple}
          />
        )}
        {offered.map((p) => <Button key={p} disabled={busy} onPress={() => withProvider(p)}>{`continue with ${LABEL[p]}`}</Button>)}
        {(apple || offered.length > 0) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: t.rule }} /><Label>or with email</Label><View style={{ flex: 1, height: 1, backgroundColor: t.rule }} />
          </View>
        )}
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
