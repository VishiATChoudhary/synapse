// Pair with Synapse on a computer: scan the QR code from its settings (or open the synapse://pair link).
// No account on the phone: the code carries the relay invite and the key that seals everything after.
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, View } from 'react-native';
import { parsePairing } from '../link';
import { pairWith } from '../store';
import { FONT, useTheme } from '../theme';
import { Button, Label } from '../ui';

export default function Pair() {
  const t = useTheme();
  const params = useLocalSearchParams();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const used = useRef(false);
  const body = { fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink };

  async function go(text) {
    if (used.current) return;
    const p = parsePairing(text);
    if (!p) return setError('That is not a Synapse pairing code. In Synapse on your computer: settings, phone, pair a phone.');
    used.current = true;
    setBusy(true); setError('');
    try {
      await pairWith(p, Device.deviceName || Device.modelName || 'iPhone');
      router.dismissAll();
    } catch (e) {
      used.current = false;
      setBusy(false);
      setError(/not valid/.test(e.message) ? 'This code has expired. Show a new one in Synapse on your computer.' : e.message);
    }
  }

  // opened from a synapse://pair link (the phone's camera app, or a tap on the link)
  useEffect(() => {
    if (params.c && params.k) go(`synapse://pair?${new URLSearchParams(params)}`);
  }, [params.c, params.k]);

  return (
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 18 }} keyboardShouldPersistTaps="handled">
      <Text style={body}>On your computer, open Synapse, then settings, phone, pair a phone. Scan the code it shows.</Text>
      {busy ? (
        <View style={{ height: 300, alignItems: 'center', justifyContent: 'center', gap: 12, borderWidth: 1, borderColor: t.rule }}>
          <ActivityIndicator color={t.ink} />
          <Label>pairing…</Label>
        </View>
      ) : permission?.granted ? (
        <View style={{ height: 300, borderWidth: 1, borderColor: t.ink, overflow: 'hidden' }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => go(data)} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Text style={[body, { color: t.ink2 }]}>Synapse needs the camera only to read this code. Nothing is recorded.</Text>
          {permission && !permission.canAskAgain
            ? <Button onPress={() => Linking.openSettings()}>allow the camera in settings</Button>
            : <Button filled onPress={requestPermission}>use the camera</Button>}
        </View>
      )}
      {!!error && <Text style={[body, { color: t.sig }]}>{error}</Text>}
      <View style={{ gap: 10 }}>
        <Label>or paste the link</Label>
        <TextInput
          value={pasted} onChangeText={setPasted} placeholder="synapse://pair?…" placeholderTextColor={t.ink3} autoCapitalize="none" autoCorrect={false}
          style={{ fontFamily: FONT.mono, fontSize: 13, color: t.ink, borderWidth: 1, borderColor: t.rule, padding: 12 }}
        />
        <Button disabled={!pasted.trim() || busy} onPress={() => go(pasted)}>pair</Button>
      </View>
    </ScrollView>
  );
}
