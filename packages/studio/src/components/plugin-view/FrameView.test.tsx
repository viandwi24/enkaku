import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '@testing-library/react'
import type { ActionSpec, ViewSpec } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { FrameView } from './FrameView'
import { FRAME_PROTOCOL, FrameRequestSchema, buildFrameStylesheet } from './frame-rpc'

/**
 * A loopback discard port, deliberately, and not the `http://core.test` the
 * other plugin-view tests use.
 *
 * happy-dom really does try to FETCH an iframe's `src`, and it will not hand
 * back a `contentWindow` if iframe loading is disabled — which every test
 * below needs, because the whole point is the `postMessage` channel between
 * the host and THAT window. So the load is allowed to happen and pointed
 * somewhere that refuses instantly with no DNS lookup, rather than at a
 * hostname whose resolution time is somebody's resolver's business.
 */
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://127.0.0.1:9'
const CORE = 'http://127.0.0.1:9'

afterEach(cleanup)

/**
 * Plan 108 §4.4, criterion 16 — a tier-B frame cannot reach any API the plugin
 * did not declare.
 *
 * Three of these tests are the criterion itself, stated as three separate
 * facts because they fail independently: the frame has no same-origin access
 * (the sandbox attribute), it cannot invent an action id (the RPC gate), and a
 * message that did not come from it is not a message at all (the source gate).
 */

const FRAME_VIEW: ViewSpec = {
  title: 'Custom screen',
  frame: { entry: 'index.html', height: 'fill' },
  toolbar: ['sync'],
  rowActions: [],
}

const SYNC: ActionSpec = { kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker' }

interface Rig {
  iframe: HTMLIFrameElement
  frameWindow: Window
  posted: unknown[]
  send(data: unknown, over?: { origin?: string; source?: unknown }): void
}

function mount(over: { view?: ViewSpec; actions?: Record<string, ActionSpec>; responses?: Parameters<typeof renderWithApi>[1] } = {}): Rig {
  const { container } = renderWithApi(
    <FrameView plugin="tiktok" viewId="custom" view={over.view ?? FRAME_VIEW} actions={over.actions ?? { sync: SYNC }} />,
    over.responses ?? {},
  )
  const iframe = container.querySelector('iframe')
  if (!iframe) throw new Error('no iframe rendered')
  const frameWindow = iframe.contentWindow
  if (!frameWindow) throw new Error('the test DOM gave the iframe no contentWindow')

  const posted: unknown[] = []
  frameWindow.postMessage = ((data: unknown) => {
    posted.push(data)
  }) as unknown as typeof frameWindow.postMessage

  return {
    iframe,
    frameWindow,
    posted,
    send(data, o = {}) {
      window.dispatchEvent(new MessageEvent('message', { data, origin: o.origin ?? 'null', source: 'source' in o ? (o.source as Window) : frameWindow }))
    },
  }
}

function results(posted: unknown[]) {
  return posted.filter((m): m is { type: 'result'; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } } => {
    return !!m && typeof m === 'object' && (m as { type?: string }).type === 'result'
  })
}

describe('FrameView — the sandbox is the security model', () => {
  test('the sandbox attribute is exactly "allow-scripts", and never allows same-origin', () => {
    const { iframe } = mount()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  test('the frame points at the plugin’s own asset route, with each path segment encoded', () => {
    const { iframe } = mount({ view: { ...FRAME_VIEW, frame: { entry: 'assets/my app.html', height: 'fill' } } })
    // Segments encoded individually — a nested entry must stay nested, so the
    // separator survives and only the segment text is escaped.
    expect(iframe.getAttribute('src')).toBe(`${CORE}/api/plugins/tiktok/ui/assets/my%20app.html`)
  })

  test('a view with no frame renders nothing at all rather than an empty box', () => {
    const { container } = renderWithApi(
      <FrameView plugin="tiktok" viewId="custom" view={{ title: 'Table', toolbar: [], rowActions: [] }} actions={{}} />,
      {},
    )
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('FrameView — design tokens are injected', () => {
  test('the frame is sent an init message carrying the tokens and a reset', async () => {
    const rig = mount()
    rig.send({ protocol: FRAME_PROTOCOL, method: 'ready' })

    await waitFor(() => expect(rig.posted.length).toBeGreaterThan(0))
    const init = rig.posted.find((m) => !!m && typeof m === 'object' && (m as { type?: string }).type === 'init') as
      | { plugin: string; viewId: string; actions: string[]; tokens: string }
      | undefined
    expect(init).toBeTruthy()
    expect(init?.plugin).toBe('tiktok')
    expect(init?.viewId).toBe('custom')
    // The frame is told which actions it may run — nothing more.
    expect(init?.actions).toEqual(['sync'])

    const tokens = init?.tokens ?? ''
    expect(tokens).toContain('--color-bg:')
    expect(tokens).toContain('--color-fg:')
    expect(tokens).toContain('--color-accent:')
    expect(tokens).toContain('--font-sans:')
    expect(tokens).toContain('--radius-card:')
    // …plus the minimal reset, so a frame that applies the block alone already
    // has Studio's ground and body text.
    expect(tokens).toContain('background:var(--color-bg)')
    expect(tokens).toContain('font-family:var(--font-sans)')
  })

  test('buildFrameStylesheet prefers the LIVE computed value and falls back only when it is empty', () => {
    const live = buildFrameStylesheet((name) => (name === '--color-bg' ? ' rebeccapurple ' : ''))
    expect(live).toContain('--color-bg:rebeccapurple')
    // Every other token still lands, from its documented fallback.
    expect(live).toContain('--color-fg:oklch(0.961 0.002 245)')
  })

  test('a token value that tries to escape its declaration is stripped, never emitted raw', () => {
    const hostile = buildFrameStylesheet((name) => (name === '--color-bg' ? 'red}body{display:none' : ''))
    expect(hostile).not.toContain('red}body{')
    expect(hostile).toContain('--color-bg:redbodydisplay:none')
  })
})

describe('FrameView — the RPC maps only onto declared actions', () => {
  test('an action id the view did NOT declare is refused, and no request is made', async () => {
    const rig = mount({ responses: { '/api/plugins/*': { body: { plugin: 'tiktok', actionId: 'x', result: { kind: 'batch', batchId: 'b1', scriptId: 's1', jobCount: 1 } } } } })
    const { apiMock } = renderWithApi(<span />, {})
    apiMock.restore()

    rig.send({ protocol: FRAME_PROTOCOL, method: 'action.run', id: 'c1', actionId: 'deleteEverything' })

    await waitFor(() => expect(results(rig.posted).length).toBe(1))
    const [answer] = results(rig.posted)
    expect(answer?.ok).toBe(false)
    expect(answer?.error?.code).toBe('action_not_declared')
    expect(answer?.id).toBe('c1')
  })

  test('a declared action runs through POST /api/plugins/:name/action/:actionId and its result comes back', async () => {
    const result = { kind: 'batch', batchId: 'b1', scriptId: 's1', jobCount: 3 }
    const { container, apiMock } = renderWithApi(<FrameView plugin="tiktok" viewId="custom" view={FRAME_VIEW} actions={{ sync: SYNC }} />, {
      '/api/plugins/tiktok/action/sync': { body: { plugin: 'tiktok', actionId: 'sync', result } },
    })
    const iframe = container.querySelector('iframe')
    const frameWindow = iframe?.contentWindow
    if (!frameWindow) throw new Error('no contentWindow')
    const posted: unknown[] = []
    frameWindow.postMessage = ((data: unknown) => {
      posted.push(data)
    }) as unknown as typeof frameWindow.postMessage

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { protocol: FRAME_PROTOCOL, method: 'action.run', id: 'c2', actionId: 'sync', deviceIds: ['d1', 'd2'] },
        origin: 'null',
        source: frameWindow,
      }),
    )

    await waitFor(() => expect(results(posted).length).toBe(1))
    expect(results(posted)[0]?.ok).toBe(true)
    expect(results(posted)[0]?.data).toEqual(result)

    const call = apiMock.calls.find((c) => c.path === '/api/plugins/tiktok/action/sync')
    expect(call?.method).toBe('POST')
    // Only the three members `PluginActionBodySchema` has — the frame cannot
    // send a script, a namespace, or a scope, because there is nowhere to put one.
    expect(call?.body).toEqual({ deviceIds: ['d1', 'd2'] })
  })

  test('a failing action comes back as a coded refusal rather than a silent nothing', async () => {
    const { container } = renderWithApi(<FrameView plugin="tiktok" viewId="custom" view={FRAME_VIEW} actions={{ sync: SYNC }} />, {
      '/api/plugins/tiktok/action/sync': { status: 409, body: { error: { code: 'script_not_found', message: 'no such script' } } },
    })
    const frameWindow = container.querySelector('iframe')?.contentWindow
    if (!frameWindow) throw new Error('no contentWindow')
    const posted: unknown[] = []
    frameWindow.postMessage = ((data: unknown) => {
      posted.push(data)
    }) as unknown as typeof frameWindow.postMessage

    window.dispatchEvent(
      new MessageEvent('message', { data: { protocol: FRAME_PROTOCOL, method: 'action.run', id: 'c3', actionId: 'sync' }, origin: 'null', source: frameWindow }),
    )

    await waitFor(() => expect(results(posted).length).toBe(1))
    expect(results(posted)[0]?.ok).toBe(false)
    expect(results(posted)[0]?.error?.code).toBe('request_failed')
  })

  test('data.query on a frame view is refused — a frame reads a DECLARED source or nothing', async () => {
    const rig = mount()
    rig.send({ protocol: FRAME_PROTOCOL, method: 'data.query', id: 'q1' })

    await waitFor(() => expect(results(rig.posted).length).toBe(1))
    expect(results(rig.posted)[0]?.ok).toBe(false)
    expect(results(rig.posted)[0]?.error?.code).toBe('no_data_source')
  })
})

describe('FrameView — an inbound message is untrusted input', () => {
  test('a message from a window that is not this frame is ignored entirely', async () => {
    const rig = mount()
    rig.send({ protocol: FRAME_PROTOCOL, method: 'action.run', id: 'c4', actionId: 'sync' }, { source: window })
    rig.send({ protocol: FRAME_PROTOCOL, method: 'ready' }, { source: window })
    // Nothing is answered — not even a refusal, which would itself confirm the
    // host is listening.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rig.posted).toEqual([])
  })

  test('a message with no source at all is ignored', async () => {
    const rig = mount()
    rig.send({ protocol: FRAME_PROTOCOL, method: 'ready' }, { source: null })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rig.posted).toEqual([])
  })

  test('a message from an origin the sandbox cannot produce is ignored', async () => {
    const rig = mount()
    rig.send({ protocol: FRAME_PROTOCOL, method: 'ready' }, { origin: 'https://evil.example' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rig.posted).toEqual([])
  })

  test('a message that is not in the grammar is dropped in silence', async () => {
    const rig = mount()
    for (const data of [
      null,
      'ready',
      { method: 'ready' },
      { protocol: 'enkaku.plugin-frame.v2', method: 'ready' },
      { protocol: FRAME_PROTOCOL, method: 'kv.set', id: 'x', key: 'k', value: 'v' },
      { protocol: FRAME_PROTOCOL, method: 'action.run', id: 'x', actionId: 'sync', script: 'other/thing@latest' },
      { protocol: FRAME_PROTOCOL, method: 'action.run', actionId: 'sync' },
    ]) {
      rig.send(data)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rig.posted).toEqual([])
  })
})

describe('FrameRequestSchema — the grammar, without a DOM', () => {
  test('accepts exactly the three methods', () => {
    expect(FrameRequestSchema.safeParse({ protocol: FRAME_PROTOCOL, method: 'ready' }).success).toBe(true)
    expect(FrameRequestSchema.safeParse({ protocol: FRAME_PROTOCOL, method: 'data.query', id: 'a' }).success).toBe(true)
    expect(FrameRequestSchema.safeParse({ protocol: FRAME_PROTOCOL, method: 'action.run', id: 'a', actionId: 'sync' }).success).toBe(true)
  })

  test('there is nowhere to name a namespace, a script, a scope, or a URL', () => {
    for (const extra of [{ namespace: 'other' }, { script: 'other/thing@latest' }, { scope: 'global' }, { url: 'http://evil.example' }]) {
      expect(FrameRequestSchema.safeParse({ protocol: FRAME_PROTOCOL, method: 'action.run', id: 'a', actionId: 'sync', ...extra }).success).toBe(false)
    }
  })

  test('deviceIds is bounded, so one message cannot enqueue an unbounded batch', () => {
    const many = Array.from({ length: 1001 }, (_, i) => `d${i}`)
    expect(FrameRequestSchema.safeParse({ protocol: FRAME_PROTOCOL, method: 'action.run', id: 'a', actionId: 'sync', deviceIds: many }).success).toBe(false)
  })
})
