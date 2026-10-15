import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Peer, View } from '../types'

// Reads ~/.synapse (written by the Synapse canvas, CLI and MCP server) and shows,
// for this session: who is linked in, who it shares with, and unread agent messages.

const view = atom({ plugin: 'synapse-tui', key: 'view' } as const, null)

type Edge = {
  id: string
  from: string
  to: string
  fromName: string
  toName?: string
  fromColor?: string
  toColor?: string
  fromKind?: string
  toKind?: string
}
type Message = { id: string; from: string; to: string; fromName: string; delivered: boolean }

const ACCENT = '#FF4400'
const POLL_MS = 1500

export const register: Register = on => {
  let timer: { cancel(): void } | undefined
  let known: Map<string, Edge> | null = null
  let seenMessages: Set<string> | null = null

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = await $.env.get('HOME')
    const me = await $.session.id()
    const dir = `${home}/.synapse`

    const readJSON = async <T,>(file: string, fallback: T): Promise<T> => {
      try {
        return JSON.parse(await $.fs.read(`${dir}/${file}`)) as T
      } catch {
        return fallback
      }
    }

    const poll = async () => {
      const edges = await readJSON<Edge[]>('edges.json', [])
      const messages = await readJSON<Message[]>('messages.json', [])
      const mine = edges.filter(x => x.from === me || x.to === me)
      const unread = messages.filter(m => m.to === me && !m.delivered)

      // toasts for what changed since the last look (none on the first look)
      if (known) {
        for (const x of mine) {
          if (known.has(x.id)) continue
          if (x.to === me) {
            $.ui.toast(`⇠ synapse: ${x.fromName} connected. Its context flows in with your next prompt.`, { timeoutMs: 6000 })
          } else {
            $.ui.toast(`⇢ synapse: now sharing this session with ${x.toName ?? 'an agent'}`, { timeoutMs: 6000 })
          }
        }
        for (const [id, x] of known) {
          if (!mine.some(y => y.id === id)) $.ui.toast(`synapse: unlinked ${x.to === me ? x.fromName : x.toName ?? 'an agent'}`)
        }
      }
      if (seenMessages) {
        for (const m of unread) {
          if (!seenMessages.has(m.id)) $.ui.toast(`✉ synapse: message from ${m.fromName}, delivered with your next prompt`, { timeoutMs: 6000 })
        }
      }
      known = new Map(mine.map(x => [x.id, x]))
      seenMessages = new Set(unread.map(m => m.id))

      const peer = (name: string | undefined, color: string | undefined, kind: string | undefined): Peer => ({
        name: name ?? '?',
        color: color ?? ACCENT,
        kind: kind ?? '',
      })
      const fresh: View = {
        incoming: mine.filter(x => x.to === me).map(x => peer(x.fromName, x.fromColor, x.fromKind)),
        outgoing: mine.filter(x => x.from === me).map(x => peer(x.toName, x.toColor, x.toKind)),
        unread: unread.length,
        unreadFrom: [...new Set(unread.map(m => m.fromName))],
      }
      if (JSON.stringify(await read($, view)) !== JSON.stringify(fresh)) await update($, view, () => fresh)
    }

    timer?.cancel()
    await poll()
    timer = $.clock.every(POLL_MS, () => void poll())
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (e.props.hasSurvey || !v || (!v.incoming.length && !v.outgoing.length && !v.unread)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const list = (peers: Peer[], prefix: string) =>
      peers.map((p, i) => (
        <Text key={`${prefix}${i}`}>
          <Text color={p.color}>● </Text>
          <Text>{p.name}</Text>
          {p.kind ? <Text dimColor> {p.kind}</Text> : null}
          <Text>{'  '}</Text>
        </Text>
      ))

    return (
      <Box>
        <Text color={ACCENT} weight="bold">◉ synapse  </Text>
        {v.incoming.length ? <Text dimColor>reads ⇠ </Text> : null}
        {list(v.incoming, 'in')}
        {v.outgoing.length ? <Text dimColor>shares ⇢ </Text> : null}
        {list(v.outgoing, 'out')}
        {v.unread ? (
          <Text color={ACCENT}>✉ {v.unread} from {v.unreadFrom.join(', ')}</Text>
        ) : null}
      </Box>
    )
  })
}
