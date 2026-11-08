// A shell tab on the computer, on the phone: its screen as the Mac's copy of it shows it, a line to type a
// command into (Enter runs it) and a row of the keys a phone keyboard lacks.
import { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { source } from './store';
import { FONT, R, round, useTheme } from './theme';
import { Meta, Press, haptic } from './ui';

const IOS = Platform.OS === 'ios';
const KEYS = [
  ['esc', 'esc'], ['tab', 'tab'], ['ctrl-c', '^C'], ['up', '↑'], ['down', '↓'], ['left', '←'], ['right', '→'],
  ['ctrl-d', '^D'], ['ctrl-l', '^L'], ['ctrl-r', '^R'], ['enter', '⏎'],
];
const SIZE = 11.5, LINE = 16;

function Screen({ screen }) {
  const t = useTheme();
  if (!screen) return <Meta style={{ padding: 16 }}>Loading the screen…</Meta>;
  const { lines, cursor } = screen;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}>
      <View>
        {lines.map((line, i) => {
          const at = cursor && cursor.y === i ? cursor.x : -1;
          const text = at >= 0 ? line.padEnd(at + 1) : line;
          return (
            <Text key={i} style={{ fontFamily: FONT.mono, fontSize: SIZE, lineHeight: LINE, color: t.ink }}>
              {at >= 0 ? <>{text.slice(0, at)}<Text style={{ backgroundColor: t.sig, color: t.paper }}>{text[at]}</Text>{text.slice(at + 1)}</> : (text || ' ')}
            </Text>
          );
        })}
      </View>
    </ScrollView>
  );
}

export function Shell({ a }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [keyboard, setKeyboard] = useState(false);
  const scroll = useRef(null);
  const input = useRef(null);
  const body = a.screen?.lines.join('\n');
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 30); }, [body]);
  useEffect(() => {
    const show = Keyboard.addListener(IOS ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener(IOS ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const press = (k) => { haptic.tap(); source.keys(a.id, [k]); };
  const run = () => { if (!text) return press('enter'); haptic.tap(); source.type(a.id, text); setText(''); };
  return (
    <View style={{ flex: 1 }}>
      <ScrollView ref={scroll} style={{ flex: 1 }} keyboardDismissMode={IOS ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled">
        <Screen screen={a.screen} />
      </ScrollView>
      <View style={{ paddingTop: 6, paddingBottom: keyboard ? 8 : insets.bottom + 8, gap: 8 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }}>
          {KEYS.map(([k, label]) => (
            <Press key={k} onPress={() => (k === 'enter' ? run() : press(k))} sink={0.9} accessibilityLabel={k} hitSlop={4}
              style={{ minWidth: 42, height: 34, paddingHorizontal: 10, backgroundColor: t.card, ...round(R.chip), alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontFamily: FONT.mono, fontSize: 13, color: k === 'ctrl-c' ? t.sig : t.ink }}>{label}</Text>
            </Press>
          ))}
        </ScrollView>
        <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: t.card, ...round(24), paddingLeft: 16, paddingRight: 6, paddingVertical: 6, gap: 8 }}>
          <Text style={{ fontFamily: FONT.mono, fontSize: 14, color: t.sig }}>$</Text>
          <TextInput
            ref={input} value={text} onChangeText={setText} onSubmitEditing={run} blurOnSubmit={false} returnKeyType="go"
            autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off" keyboardType={IOS ? 'ascii-capable' : 'default'}
            placeholder="Type a command" placeholderTextColor={t.ink3}
            style={{ flex: 1, fontFamily: FONT.mono, fontSize: 15, color: t.ink, paddingVertical: 8, outlineWidth: 0 }}
          />
          <Press onPress={run} sink={0.88} accessibilityLabel="Run"
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: text ? t.sig : t.wash, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: FONT.sansMedium, fontSize: 17, color: text ? '#fff' : t.ink3 }}>⏎</Text>
          </Press>
        </View>
      </View>
    </View>
  );
}
