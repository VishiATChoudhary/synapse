// One agent as a chat: its transcript, a "needs you" card when it is blocked, and a compose box.
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withConsent } from '../../consent';
import { MediaStrip } from '../../MediaStrip';
import { source, useAgent } from '../../store';
import { FONT, useTheme } from '../../theme';
import { Button, Label, Mark, Markdown, Meta } from '../../ui';

const tap = () => Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

// consecutive tool lines fold into one row: "3 tool calls", with the screenshots and videos they made
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
  return (
    <Pressable onPress={() => setOpen(!open)} hitSlop={6}>
      <Meta numberOfLines={open ? undefined : 1}>{tools.length === 1 ? tools[0].replace(/^\[|\]$/g, '') : `Used ${tools.length} tools`}{tools.length > 1 && !open ? '  ›' : ''}</Meta>
      {open && tools.length > 1 && tools.map((x, i) => <Meta key={i} color={t.ink2} style={{ marginTop: 4 }}>{x.replace(/^\[|\]$/g, '')}</Meta>)}
    </Pressable>
  );
}

function Message({ m }) {
  const t = useTheme();
  const media = m.media?.length ? <MediaStrip media={m.media} /> : null;
  if (m.tools) return <View style={{ gap: 10 }}><Tools tools={m.tools} />{media}</View>;
  if (m.role === 'user') return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '85%', gap: 10 }}>
      <View style={{ backgroundColor: t.ink, paddingVertical: 10, paddingHorizontal: 14 }}>
        <Markdown text={m.text} color={t.onInk} />
      </View>
      {media}
    </View>
  );
  return <View style={{ gap: 10 }}><Markdown text={m.text} />{media}</View>;
}

function Needs({ a }) {
  const t = useTheme();
  return (
    <View style={{ borderWidth: 1, borderColor: t.sig, padding: 14, gap: 12 }}>
      <Text style={{ fontFamily: FONT.sansMedium, fontSize: 14, color: t.sig }}>Needs you</Text>
      <Markdown text={a.needs.question} />
      <View style={{ gap: 8 }}>
        {a.needs.options.map((o, i) => <Button key={o} filled={i === 0} onPress={async () => { tap(); if (await withConsent()) source.answer(a.id, o); }}>{`${i + 1}. ${o}`}</Button>)}
      </View>
    </View>
  );
}

export default function Agent() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams();
  const a = useAgent(id);
  const [text, setText] = useState('');
  const scroll = useRef(null);
  const count = a?.messages.length;
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }, [count, a?.needs]);
  // the computer sends the full conversation only for the agent that is open here
  useEffect(() => { source.watch(id); return () => source.watch(null); }, [id]);
  if (!a) return <View style={{ flex: 1, backgroundColor: t.paper }} />;
  const busy = a.status === 'busy';
  const send = async () => {
    if (!text.trim()) return;
    tap();
    if (!(await withConsent())) return;
    source.send(a.id, text.trim());
    setText('');
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44}>
      <Stack.Screen options={{
        headerTitle: () => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Mark color={a.project.color} status={a.status} needs={a.needs} />
            <View>
              <Text style={{ fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink }} numberOfLines={1}>{a.name}</Text>
              <Meta numberOfLines={1}>{a.project.label}{a.worktree ? ` · ${a.worktree}` : ''}</Meta>
            </View>
          </View>
        ),
      }} />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 20, gap: 18 }}>
        {a.messages.length ? group(a.messages).map((m, i) => <Message key={i} m={m} />) : <Meta>No messages yet. Say what to work on.</Meta>}
        {busy && <Meta color={t.sig}>Working…</Meta>}
        {a.needs && <Needs a={a} />}
      </ScrollView>
      {a.inApp === false ? (
        <View style={{ borderTopWidth: 1, borderColor: t.rule, padding: 16, paddingBottom: insets.bottom + 16 }}>
          <Meta>Runs outside the Synapse app on your computer, so you can only read it here.</Meta>
        </View>
      ) : (
      <View style={{ borderTopWidth: 1, borderColor: t.rule, padding: 12, paddingBottom: insets.bottom + 12, flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <TextInput
          value={text} onChangeText={setText} multiline placeholder={busy ? 'Queue a message…' : 'Message'} placeholderTextColor={t.ink3}
          style={{ flex: 1, maxHeight: 140, fontFamily: FONT.sans, fontSize: 16, color: t.ink, backgroundColor: t.wash, paddingHorizontal: 12, paddingVertical: 10 }}
        />
        {busy && !text.trim()
          ? <Button onPress={() => { tap(); source.stop(a.id); }}>stop</Button>
          : <Button filled disabled={!text.trim()} onPress={send}>send</Button>}
      </View>
      )}
    </KeyboardAvoidingView>
  );
}
