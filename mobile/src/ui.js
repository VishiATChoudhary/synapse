import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONT, R, round, useTheme } from './theme';

const NATIVE = Platform.OS !== 'web'; // web has no native animation driver and warns about it

// haptics: light for taps, a tick for picks, a notification for things that landed
export const haptic = {
  tap: () => NATIVE && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  pick: () => NATIVE && Haptics.selectionAsync().catch(() => {}),
  done: () => NATIVE && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  fail: () => NATIVE && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}),
};

// Reduce Motion turns slides and springs into plain fades
let calm = false;
AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { calm = !!v; }).catch(() => {});
AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v) => { calm = !!v; });

// an Animated.Value that lives as long as the component (react-native-web has no useAnimatedValue)
const useValue = (start) => useState(() => new Animated.Value(start))[0];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// a Pressable that sinks a little under the finger and springs back, like system cells and buttons
export function Press({ children, style, onPressIn, onPressOut, sink = 0.97, ...props }) {
  const v = useValue(0);
  const to = (toValue) => Animated.spring(v, { toValue, useNativeDriver: NATIVE, speed: toValue ? 50 : 18, bounciness: toValue ? 0 : 6 }).start();
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [1, calm ? 1 : sink] });
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] });
  return (
    <AnimatedPressable {...props} onPressIn={(e) => { to(1); onPressIn?.(e); }} onPressOut={(e) => { to(0); onPressOut?.(e); }}
      style={[style, { opacity: props.disabled ? 0.45 : opacity, transform: [{ scale }] }]}>
      {children}
    </AnimatedPressable>
  );
}

// fades and lifts its content in once, on mount; delay staggers a list
export function FadeIn({ children, delay = 0, style, from = 10 }) {
  const v = useValue(0);
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 320, delay, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
  }, [v, delay]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [calm ? 0 : from, 0] });
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

export function Label({ children, style, color }) {
  const t = useTheme();
  return <Text style={[{ fontFamily: FONT.mono, fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: color || t.ink3 }, style]}>{children}</Text>;
}

export function Display({ children, style }) {
  const t = useTheme();
  return <Text style={[{ fontFamily: FONT.display, fontSize: 40, lineHeight: 42, textTransform: 'uppercase', color: t.ink }, style]}>{children}</Text>;
}

export function Meta({ children, style, color, numberOfLines }) {
  const t = useTheme();
  return <Text numberOfLines={numberOfLines} style={[{ fontFamily: FONT.sans, fontSize: 13, lineHeight: 18, color: color || t.ink3 }, style]}>{children}</Text>;
}

export const Rule = ({ style }) => <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: useTheme().rule }, style]} />;

// a soft rounded surface that groups rows, in place of borders
export function Card({ children, style }) {
  const t = useTheme();
  return <View style={[{ backgroundColor: t.card, ...round(R.card), overflow: 'hidden' }, style]}>{children}</View>;
}

// section heading above a card, iOS grouped-list style
export function Heading({ children, style }) {
  const t = useTheme();
  return <Text style={[{ fontFamily: FONT.sansMedium, fontSize: 13, color: t.ink3, marginLeft: 16, marginBottom: 8 }, style]}>{children}</Text>;
}

// small rounded tag, for an agent's kind
export function Tag({ children, color }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.wash, ...round(R.pill), paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ fontFamily: FONT.mono, fontSize: 11, color: color || t.ink3 }}>{children}</Text>
    </View>
  );
}

export function Mark({ color, status, needs, size = 10 }) {
  const t = useTheme();
  const o = useValue(1);
  const live = status === 'busy' || needs;
  useEffect(() => {
    if (!live) return o.setValue(1);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.3, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
      Animated.timing(o, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [live, o]);
  const style = needs
    ? { borderWidth: 2, borderColor: t.sig }
    : { backgroundColor: status === 'busy' ? t.sig : color };
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, opacity: o }, style]} />;
}

// three dots breathing in turn, while an agent works
export function Dots({ color }) {
  const t = useTheme();
  const v = useValue(0);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: NATIVE }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', height: 18 }}>
      {[0, 1, 2].map((i) => {
        const a = i / 3;
        const opacity = v.interpolate({ inputRange: [0, a, a + 0.17, a + 0.34, 1].map((x) => Math.min(1, x)), outputRange: [0.25, 0.25, 1, 0.25, 0.25], extrapolate: 'clamp' });
        return <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color || t.sig, opacity }} />;
      })}
    </View>
  );
}

export function Button({ children, onPress, filled, disabled, style, small }) {
  const t = useTheme();
  return (
    <Press onPress={(e) => { haptic.tap(); onPress?.(e); }} disabled={disabled} style={[{
      ...round(R.pill), paddingVertical: small ? 8 : 13, paddingHorizontal: small ? 14 : 18, alignItems: 'center', justifyContent: 'center',
      backgroundColor: filled ? t.ink : t.wash,
    }, style]}>
      <Text style={{ fontFamily: FONT.sansMedium, fontSize: small ? 14 : 15, color: filled ? t.onInk : t.ink }}>{typeof children === 'string' ? children.charAt(0).toUpperCase() + children.slice(1) : children}</Text>
    </Press>
  );
}

// a bottom sheet: the backdrop fades, the panel springs up from the bottom and rides above the keyboard
export function Sheet({ visible, onClose, children }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true); // mount before sliding in; unmount only after sliding out
  const v = useValue(0);
  useEffect(() => {
    if (visible) {
      Animated.spring(v, { toValue: 1, useNativeDriver: NATIVE, speed: 16, bounciness: 0 }).start();
    } else Animated.timing(v, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: NATIVE }).start(() => setShown(false));
  }, [visible, v]);
  if (!shown) return null;
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [calm ? 0 : 420, 0] });
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)', opacity: v }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View style={{
          backgroundColor: t.paper, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderCurve: 'continuous',
          paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 16, gap: 14, opacity: calm ? v : 1, transform: [{ translateY }],
        }}>
          <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: t.rule, marginBottom: 4 }} />
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

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
  const base = { fontFamily: FONT.sans, fontSize: 16, lineHeight: 24, color: color || t.ink };
  return (
    <View style={{ gap: 6 }}>
      {text.split('\n').filter((l, i, all) => l.trim() || (i && all[i - 1].trim())).map((line, i) => {
        const h = line.match(/^#{1,3}\s+(.*)/);
        if (h) return <Text key={i} style={[base, { fontFamily: FONT.sansMedium, color: color || t.ink, marginTop: 4 }]}>{inline(h[1], t, i)}</Text>;
        const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
        if (li) return (
          <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={[base, { fontFamily: FONT.mono, color: color || t.ink3 }]}>{li[1] ? `${li[1]}.` : '•'}</Text>
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
