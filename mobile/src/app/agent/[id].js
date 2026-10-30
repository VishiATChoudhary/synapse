import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withConsent } from '../../consent';
import { LinkChips } from '../../LinkChips';
import { MediaStrip } from '../../MediaStrip';
import { RenameSheet } from '../../Rename';
import { source, useAgent } from '../../store';
import { FONT, R, round, useTheme } from '../../theme';
import { Button, Dots, FadeIn, Mark, Markdown, Meta, Press, haptic } from '../../ui';

const IOS = Platform.OS === 'ios';

function group(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (m.tool && prev?.tools) { prev.tools.push(m.text); if (m.media) prev.media = [...(prev.media || []), ...m.media]; }
    else out.push(m.tool ? { tools: [m.text], ts: m.ts, media: m.media } : m);
  }
  return out;
}

function Tools({ tools }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const many = tools.length > 1;
  return (
    <Pressable onPress={() => many && setOpen(!open)} hitSlop={6} style={{ alignSelf: 'flex-start', maxWidth: '100%', backgroundColor: t.wash, ...round(R.chip), paddingVertical: 7, paddingHorizontal: 12, gap: 4 }}>
      <Meta numberOfLines={open ? undefined : 1}>{many ? `Used ${tools.length} tools` : tools[0].replace(/^\[|\]$/g, '')}{many ? (open ? '  ⌃' : '  ⌄') : ''}</Meta>
      {open && tools.map((x, i) => <Meta key={i} color={t.ink2}>{x.replace(/^\[|\]$/g, '')}</Meta>)}
    </Pressable>
  );
}

function Message({ m, agentId }) {
  const t = useTheme();
  const media = m.media?.length ? <MediaStrip media={m.media} /> : null;
  if (m.tools) return <View style={{ gap: 10 }}><Tools tools={m.tools} />{media}<LinkChips agentId={agentId} text={m.tools.join('\n')} /></View>;
  if (m.role === 'user') return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '85%', gap: 10 }}>
      {/* the tucked corner points at the sender, like Messages */}
      <View style={{ backgroundColor: t.ink, ...round(R.bubble), borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 15 }}>
        <Markdown text={m.text} color={t.onInk} />
      </View>
      {media}
    </View>
  );
  return <View style={{ gap: 10 }}><Markdown text={m.text} />{media}<LinkChips agentId={agentId} text={m.text} /></View>;
}

function Needs({ a }) {
  const t = useTheme();
  return (
    <FadeIn>
      <View style={{ backgroundColor: t.sigWash, ...round(R.card), padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Mark needs size={9} />
          <Text style={{ fontFamily: FONT.sansMedium, fontSize: 14, color: t.sig }}>Needs you</Text>
        </View>
        <Markdown text={a.needs.question} />
        <View style={{ gap: 8 }}>
          {a.needs.options.map((o, i) => <Button key={o} filled={i === 0} onPress={async () => { if (await withConsent()) source.answer(a.id, o); }}>{`${i + 1}. ${o}`}</Button>)}
        </View>
      </View>
    </FadeIn>
  );
}

// the name in the header doubles as the rename button
function Title({ a, onPress }) {
  const t = useTheme();
  return (
    <Press onPress={onPress} sink={0.95} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${a.name}, rename`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 260 }}>
      <Mark color={a.project.color} status={a.status} needs={a.needs} />
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink }} numberOfLines={1}>{a.name} <Text style={{ color: t.ink3, fontSize: 13 }}>✎</Text></Text>
        <Meta numberOfLines={1}>{[a.kind, a.project.label, a.worktree].filter(Boolean).join(' · ')}</Meta>
      </View>
    </Press>
  );
}

export default function Agent() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();
  const a = useAgent(id);
  const [text, setText] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [keyboard, setKeyboard] = useState(false);
  const scroll = useRef(null);
  const [seen, setSeen] = useState(null); // messages there when the screen opened appear at once, newer ones fade in
  const count = a?.messages.length;
  if (seen == null && a) setSeen(group(a.messages).length);
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }, [count, a?.needs]);
  useEffect(() => { source.watch(id); return () => source.watch(null); }, [id]);
  useEffect(() => {
    // the compose bar drops its home-indicator padding while the keyboard covers it, and the chat follows to the end
    const show = Keyboard.addListener(IOS ? 'keyboardWillShow' : 'keyboardDidShow', () => { setKeyboard(true); setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60); });
    const hide = Keyboard.addListener(IOS ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  if (!a) return <View style={{ flex: 1, backgroundColor: t.paper }} />;
  const busy = a.status === 'busy';
  const ready = !!text.trim();
  const send = async () => {
    if (!ready) return;
    haptic.tap();
    if (!(await withConsent())) return;
    source.send(a.id, text.trim());
    setText('');
  };
  const about = a.about?.trim();
  const bottom = keyboard ? 8 : insets.bottom + 8;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.paper }} behavior={IOS ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen options={{ headerTitle: () => <Title a={a} onPress={() => { haptic.pick(); setRenaming(a); }} /> }} />
      <ScrollView
        ref={scroll} contentContainerStyle={{ padding: 20, paddingBottom: 12, gap: 18 }}
        keyboardDismissMode={IOS ? 'interactive' : 'on-drag'} keyboardShouldPersistTaps="handled"
      >
        {!!about && (
          <Pressable onPress={() => setRenaming(a)} style={{ backgroundColor: t.card, ...round(R.row), paddingVertical: 12, paddingHorizontal: 14, gap: 3 }}>
            <Text style={{ fontFamily: FONT.sansMedium, fontSize: 12, color: t.ink3 }}>About</Text>
            <Text style={{ fontFamily: FONT.sans, fontSize: 14, lineHeight: 20, color: t.ink2 }} numberOfLines={3}>{about}</Text>
          </Pressable>
        )}
        {a.messages.length
          ? group(a.messages).map((m, i) => (i < (seen ?? Infinity) ? <Message key={i} m={m} agentId={a.id} /> : <FadeIn key={i}><Message m={m} agentId={a.id} /></FadeIn>))
          : <Meta>No messages yet. Say what to work on.</Meta>}
        {busy && <FadeIn><Dots /></FadeIn>}
        {a.needs && <Needs a={a} />}
      </ScrollView>
      {a.inApp === false ? (
        <View style={{ margin: 12, marginBottom: insets.bottom + 8, backgroundColor: t.card, ...round(R.row), padding: 14 }}>
          <Meta>Runs outside the Synapse app on your computer, so you can only read it here.</Meta>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: bottom }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', backgroundColor: t.card, ...round(24), paddingLeft: 16, paddingRight: 6, paddingVertical: 6, gap: 8,
            shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 2 } }}>
            <TextInput
              value={text} onChangeText={setText} multiline placeholder={busy ? 'Queue a message…' : 'Message'} placeholderTextColor={t.ink3}
              style={{ flex: 1, maxHeight: 140, fontFamily: FONT.sans, fontSize: 16, lineHeight: 21, color: t.ink, paddingTop: 8, paddingBottom: 8, outlineWidth: 0 }}
            />
            {busy && !ready ? (
              <Press onPress={() => { haptic.tap(); source.stop(a.id); }} sink={0.88} accessibilityLabel="Stop"
                style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.ink, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.onInk }} />
              </Press>
            ) : (
              <Press onPress={send} disabled={!ready} sink={0.88} accessibilityLabel="Send"
                style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: ready ? t.sig : t.wash, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontFamily: FONT.sansMedium, fontSize: 18, lineHeight: 20, color: ready ? '#fff' : t.ink3 }}>↑</Text>
              </Press>
            )}
          </View>
        </View>
      )}
      <RenameSheet agent={renaming} onClose={() => setRenaming(null)} />
    </KeyboardAvoidingView>
  );
}
