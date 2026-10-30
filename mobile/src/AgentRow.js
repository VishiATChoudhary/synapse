import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { FONT, useTheme } from './theme';
import { Mark, Press, Tag, ago, haptic } from './ui';

export function preview(a) {
  if (a.needs) return a.needs.question.replace(/`/g, '');
  const m = [...a.messages].reverse().find((x) => !x.tool) || a.messages.at(-1) || a.preview;
  return m ? `${m.role === 'user' ? 'You: ' : ''}${m.text.replace(/^>\s?|^\s*[-*]\s+|[#*`[\]]/gm, '').replace(/\s+/g, ' ').trim()}` : 'No messages yet';
}

// One agent as a cell in a card: name, what it is about, then its latest line, dimmer.
// Long press renames it.
export function AgentRow({ a, fork, last, dot, onRename }) {
  const t = useTheme();
  const about = a.about?.trim();
  return (
    <Press
      onPress={() => router.push(`/agent/${a.id}`)}
      onLongPress={onRename && (() => { haptic.pick(); onRename(a); })} delayLongPress={350} sink={0.985}
      style={{ flexDirection: 'row', gap: 12, paddingVertical: 13, paddingRight: 16, paddingLeft: fork ? 38 : 16, backgroundColor: t.card }}
    >
      {fork && <View style={{ position: 'absolute', left: 21, top: 0, height: 26, width: 10, borderLeftWidth: 1.5, borderBottomWidth: 1.5, borderColor: t.rule, borderBottomLeftRadius: 8 }} />}
      <View style={{ paddingTop: 6 }}><Mark color={dot || t.ink3} status={a.status} needs={a.needs} size={9} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, fontFamily: FONT.sansMedium, fontSize: 16, color: t.ink }} numberOfLines={1}>{a.name}</Text>
          {!!a.kind && <Tag>{a.kind}</Tag>}
          {!!a.updatedAt && <Text style={{ fontFamily: FONT.sans, fontSize: 12, color: t.ink3 }}>{ago(a.updatedAt)}</Text>}
        </View>
        {!!about && <Text style={{ fontFamily: FONT.sans, fontSize: 14, lineHeight: 19, color: t.ink2 }} numberOfLines={2}>{about}</Text>}
        <Text style={{ fontFamily: FONT.sans, fontSize: 13, lineHeight: 18, color: a.needs ? t.sig : t.ink3 }} numberOfLines={1}>{preview(a)}</Text>
      </View>
      {!last && <View style={{ position: 'absolute', left: fork ? 59 : 37, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.rule }} />}
    </Press>
  );
}
