// Connection, privacy and contact. Kept reachable from the home screen (App Review 5.1.1(i), 1.2).
import { Linking, ScrollView, Text, View } from 'react-native';
import { DISCLOSURE, revokeConsent, useConsent } from '../consent';
import { source } from '../store';
import { FONT, useTheme } from '../theme';
import { Button, Label, Rule } from '../ui';

const PRIVACY_URL = 'https://app.heysynapse.dev/privacy';
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
  const body = { fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink };
  return (
    <ScrollView style={{ backgroundColor: t.paper }} contentContainerStyle={{ padding: 20, gap: 22 }}>
      <Section title="connection">
        <Text style={body}>{source.name === 'demo'
          ? 'Demo mode: sample agents, nothing leaves this phone. Pair with Synapse on your computer to see your own agents.'
          : 'Paired with your computer. Agents run there, this phone only shows them and sends your messages.'}</Text>
      </Section>
      <Rule />
      <Section title="your prompts">
        <Text style={body}>{DISCLOSURE}</Text>
        <Text style={[body, { color: t.ink2 }]}>{given ? 'You agreed to this.' : 'Not agreed yet: you will be asked before your first prompt.'}</Text>
        {given && <Button onPress={revokeConsent}>withdraw consent</Button>}
      </Section>
      <Rule />
      <Section title="privacy and help">
        <Button onPress={() => Linking.openURL(PRIVACY_URL)}>privacy policy</Button>
        <Button onPress={() => Linking.openURL(SUPPORT_URL)}>contact and support</Button>
      </Section>
    </ScrollView>
  );
}
