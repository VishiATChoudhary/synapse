import { useEffect, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { FONT, useTheme } from './theme';

export function Label({ children, style, color }) {
  const t = useTheme();
  return <Text style={[{ fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: color || t.ink3 }, style]}>{children}</Text>;
}

export function Display({ children, style }) {
  const t = useTheme();
  return <Text style={[{ fontFamily: FONT.display, fontSize: 40, lineHeight: 42, textTransform: 'uppercase', color: t.ink }, style]}>{children}</Text>;
}

export const Rule = ({ style }) => <View style={[{ height: 1, backgroundColor: useTheme().rule }, style]} />;

// Square project mark. Orange and blinking while the agent works, an outlined square when it needs you.
export function Mark({ color, status, needs, size = 10 }) {
  const t = useTheme();
  const o = useRef(new Animated.Value(1)).current;
  const live = status === 'busy' || needs;
  useEffect(() => {
    if (!live) return o.setValue(1);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.25, duration: 520, useNativeDriver: true }),
      Animated.timing(o, { toValue: 1, duration: 520, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [live, o]);
  const style = needs
    ? { borderWidth: 2, borderColor: t.sig }
    : { backgroundColor: status === 'busy' ? t.sig : color };
  return <Animated.View style={[{ width: size, height: size, opacity: o }, style]} />;
}

export function Button({ children, onPress, filled, disabled, style }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [{
      borderWidth: 1, borderColor: t.ink, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center',
      backgroundColor: filled ? t.ink : 'transparent', opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
    }, style]}>
      <Label color={filled ? t.onInk : t.ink}>{children}</Label>
    </Pressable>
  );
}

// Enough markdown for agent replies: headings, lists, **bold**, *italic*, `code`.
function inline(text, t, key = 0) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**')) return <Text key={`${key}-${i}`} style={{ fontFamily: FONT.sansMedium }}>{p.slice(2, -2)}</Text>;
    if (p.startsWith('`')) return <Text key={`${key}-${i}`} style={{ fontFamily: FONT.mono, fontSize: 13, backgroundColor: t.wash }}>{p.slice(1, -1)}</Text>;
    if (p.startsWith('*') && p.length > 2) return <Text key={`${key}-${i}`} style={{ fontStyle: 'italic' }}>{p.slice(1, -1)}</Text>;
    return p;
  });
}

export function Markdown({ text, color }) {
  const t = useTheme();
  const base = { fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: color || t.ink };
  return (
    <View style={{ gap: 6 }}>
      {text.split('\n').filter((l, i, all) => l.trim() || (i && all[i - 1].trim())).map((line, i) => {
        const h = line.match(/^#{1,3}\s+(.*)/);
        if (h) return <Label key={i} color={t.ink2} style={{ marginTop: 4 }}>{h[1]}</Label>;
        const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
        if (li) return (
          <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={[base, { fontFamily: FONT.mono, color: t.ink3 }]}>{li[1] ? `${li[1]}.` : '·'}</Text>
            <Text style={[base, { flex: 1 }]}>{inline(li[2], t, i)}</Text>
          </View>
        );
        if (!line.trim()) return <View key={i} style={{ height: 2 }} />;
        return <Text key={i} style={base}>{inline(line, t, i)}</Text>;
      })}
    </View>
  );
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
