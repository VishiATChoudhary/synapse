export type Peer = { name: string; color: string; kind: string }
export type View = { incoming: Peer[]; outgoing: Peer[]; unread: number; unreadFrom: string[] }

declare module 'claude-code' {
  interface PluginState {
    'synapse-tui': { view: View | null }
  }
}
