import { expect, mock, test } from 'claude-code/testing'

const edge = {
  id: 'e1',
  from: 'codex-1',
  to: 'me',
  fromName: 'codex-agent-platform',
  toName: 'shennies-07',
  fromColor: '#6C7CFF',
  fromKind: 'codex',
}

test('toasts when an agent connects, then shows it above the prompt', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  const files: Record<string, string> = { '/home/u/.synapse/edges.json': '[]', '/home/u/.synapse/messages.json': '[]' }
  const toasts: string[] = []
  // the kit wants primitive results wrapped as { value }
  on('session.id', async () => ({ value: 'me' }) as never)
  on('fs.read', ($, e) => {
    if (!(e.path in files)) throw new Error(`missing ${e.path}`)
    return { value: files[e.path] } as never
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(toasts).toEqual([])

  files['/home/u/.synapse/edges.json'] = JSON.stringify([edge])
  files['/home/u/.synapse/messages.json'] = JSON.stringify([
    { id: 'm1', from: 'codex-1', to: 'me', fromName: 'codex-agent-platform', delivered: false, text: 'hi' },
  ])
  await clock.advance(1600)

  expect(toasts.some(t => t.includes('codex-agent-platform connected'))).toBe(true)
  expect(toasts.some(t => t.includes('message from codex-agent-platform'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'synapse-tui', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } })
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain('codex-agent-platform')
    expect(drawn).toContain('reads ⇠')
    expect(drawn).toContain('✉')
  }
})
