import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { BigShouldersDisplay_500Medium } from '@expo-google-fonts/big-shoulders-display';
import { FragmentMono_400Regular } from '@expo-google-fonts/fragment-mono';
import { Geist_400Regular, Geist_500Medium } from '@expo-google-fonts/geist';
import { ConsentSheet } from '../consent';
import { FONT, useTheme } from '../theme';

// a deep link straight into a chat still gets a back button to the list
export const unstable_settings = { anchor: 'index' };

export default function Layout() {
  const t = useTheme();
  const [loaded] = useFonts({ BigShouldersDisplay_500Medium, FragmentMono_400Regular, Geist_400Regular, Geist_500Medium });
  if (!loaded) return null;
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: t.paper },
        headerTintColor: t.ink,
        headerTitleStyle: { fontFamily: FONT.mono, fontSize: 13 },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.paper },
      }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="agent/[id]" options={{ title: '' }} />
        <Stack.Screen name="new" options={{ presentation: 'modal', title: 'NEW AGENT' }} />
        <Stack.Screen name="settings" options={{ title: 'SETTINGS' }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
      </Stack>
      <ConsentSheet />
    </>
  );
}
