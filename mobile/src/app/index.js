// Home: one room per project, a square per agent in it (outlined: needs you, orange: working). The first
// question waiting for you sits on top. Tap a room for its agents, by worktree.
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentRow } from '../AgentRow';
import { RenameSheet } from '../Rename';
import { Squares, rooms, summary } from '../rooms';
import { byAttention, leaveDemo, useSynapse } from '../store';
import { FONT, R, round, useTheme } from '../theme';
import { minutesLeft } from '../links';
import { Card, Display, FadeIn, Heading, Meta, Press } from '../ui';

function Notice({ children }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.sigWash, ...round(R.row), padding: 16, marginBottom: 16 }}>
      <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink }}>{children}</Text>
    </View>
  );
}

function Room({ r, i }) {
  const t = useTheme();
  return (
    <FadeIn delay={i * 50} style={{ width: '48.4%' }}>
      <Press onPress={() => router.push(`/room/${encodeURIComponent(r.key)}`)} style={{
        minHeight: 140, backgroundColor: t.card, ...round(R.card), padding: 16, justifyContent: 'space-between',
      }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: r.color, marginTop: 7 }} />
          <Text style={{ flex: 1, fontFamily: FONT.display, fontSize: 22, lineHeight: 24, textTransform: 'uppercase', color: t.ink }} numberOfLines={2}>{r.label}</Text>
        </View>
        <View style={{ gap: 8, marginTop: 12 }}>
          <Squares agents={r.agents} />
          <Meta color={t.ink2}>{summary(r.agents)}</Meta>
        </View>
      </Press>
    </FadeIn>
  );
}

export default function Home() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { agents, projects, mode, computer, computers, online, access, error, user, shares = [] } = useSynapse();
  const [renaming, setRenaming] = useState(null);
  if (mode === 'loading') return <View style={{ flex: 1, backgroundColor: t.paper }} />;
  if (mode === 'signed-out') return <Redirect href="/login" />;
  const account = mode === 'account';
  const asking = byAttention(agents).find((a) => a.needs);
  const list = rooms(projects, agents);
  const recent = [...agents].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const connected = !account || (online && access === 'ok');
  return (
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 110, paddingHorizontal: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: connected ? 18 : 4 }}>
          <Display style={{ fontSize: 36, lineHeight: 38 }}>Synapse</Display>
          <Press onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel="Settings" sink={0.9}
            style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: t.card, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 17, color: t.ink2 }}>⚙</Text>
          </Press>
        </View>
        {!account && (
          <Pressable onPress={() => { leaveDemo(); router.replace('/login'); }} hitSlop={8} style={{ marginBottom: 18 }}>
            <Meta color={t.sig}>Sample agents. Sign in to see yours.</Meta>
          </Pressable>
        )}
        {account && !connected && (
          <Meta style={{ marginBottom: 18 }}>{!computer ? 'No computer yet' : access === 'waiting' ? `Waiting for ${computer} to allow this phone` : `Connecting to ${computer}…`}</Meta>
        )}
        {!!error && <Meta color={t.sig} style={{ marginBottom: 12 }}>{error}</Meta>}
        {account && !computers.length && (
          <Notice>Open Synapse on your computer and sign in there as {user?.email}. It shows up here by itself.</Notice>
        )}
        {account && access === 'waiting' && (
          <Notice>Synapse on {computer} is asking whether this phone may see, start and message its agents. Click allow there, in Synapse settings under phone.</Notice>
        )}
        {account && access === 'removed' && (
          <Notice>This phone was removed in Synapse on {computer}. Sign out and in again to ask once more.</Notice>
        )}
        {account && access === 'ok' && !agents.length && (
          <Text style={{ fontFamily: FONT.sans, fontSize: 15, lineHeight: 22, color: t.ink2 }}>No agents running on {computer}. Start one with New agent.</Text>
        )}

        {asking && (
          <FadeIn>
            <Press onPress={() => router.push(`/agent/${asking.id}`)} style={{
              flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.sig, ...round(R.row), paddingVertical: 14, paddingHorizontal: 16, marginBottom: 16,
            }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: t.paper }} />
              <Text style={{ flex: 1, fontFamily: FONT.sans, fontSize: 15, lineHeight: 21, color: t.paper }} numberOfLines={2}>
                <Text style={{ fontFamily: FONT.sansMedium }}>{asking.name}</Text> asks: {asking.needs.question.replace(/`/g, '')}
              </Text>
              <Text style={{ fontFamily: FONT.sans, fontSize: 18, color: t.paper }}>›</Text>
            </Press>
          </FadeIn>
        )}

        {shares.length > 0 && (
          <Press onPress={() => router.push('/live')} style={{
            flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.sigWash, ...round(R.row), paddingVertical: 13, paddingHorizontal: 16, marginBottom: 16,
          }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.sig }} />
            <Text style={{ flex: 1, fontFamily: FONT.sans, fontSize: 15, color: t.ink }} numberOfLines={1}>
              {shares.length === 1 ? `${shares[0].label} is open` : `${shares.length} links open`}
            </Text>
            <Meta color={t.ink2}>{`${minutesLeft(Math.min(...shares.map((s) => s.expires)))} min ›`}</Meta>
          </Press>
        )}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
          {list.map((r, i) => <Room key={r.key} r={r} i={i} />)}
        </View>

        {recent.length > 0 && (
          <FadeIn delay={list.length * 50} style={{ marginTop: 28 }}>
            <Heading>Recent</Heading>
            <Card>
              {recent.map((a, i) => <AgentRow key={a.id} a={a} dot={a.project.color} last={i === recent.length - 1} onRename={setRenaming} />)}
            </Card>
          </FadeIn>
        )}
      </ScrollView>
      {(!account || access === 'ok') && (
        <Press onPress={() => router.push('/new')} style={{
          position: 'absolute', right: 20, bottom: insets.bottom + 20, backgroundColor: t.ink, height: 52, paddingHorizontal: 22,
          ...round(R.pill), justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6,
        }}>
          <Text style={{ fontFamily: FONT.sansMedium, fontSize: 15, color: t.onInk }}>+ New agent</Text>
        </Press>
      )}
      <RenameSheet agent={renaming} onClose={() => setRenaming(null)} />
    </View>
  );
}
