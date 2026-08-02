import { describe, expect, test } from 'bun:test'
import type { ControlToAgent } from '@enkaku/protocol'
import type { AgentConn, TunnelRegistry } from './registry'
import type { TunnelRouter } from './router'
import { createTunnelRpc } from './rpc'

interface Sent {
  deviceId: string
  msg: ControlToAgent
}

/** A fake router/registry pair — no real WS involved. `online` controls which
 * device→agent mappings currently resolve, so a test can simulate an agent
 * going offline mid-flight by mutating it. */
function createFakeTunnel() {
  const online = new Map<string, string>() // deviceId -> agentId
  const sent: Sent[] = []
  let routable = true // sendToDevice() itself can be told to fail even when "online"

  const registry: TunnelRegistry = {
    attach: () => {
      throw new Error('not used')
    },
    detach: () => {
      throw new Error('not used')
    },
    byAgent: () => null,
    forDevice: (deviceId) => {
      const agentId = online.get(deviceId)
      if (!agentId) return null
      return { agentId, ws: {} as never, connectedAt: Date.now() } as AgentConn
    },
    syncDevices: () => {},
    onlineAgents: () => [],
  }

  const router: TunnelRouter = {
    handleAgentMessage: () => {},
    handleAgentFrame: () => {},
    sendToDevice: (deviceId, msg) => {
      if (!online.has(deviceId) || !routable) return false
      sent.push({ deviceId, msg })
      return true
    },
    subscribeVideo: () => () => {},
    openChannel: () => null,
    subscribeChannel: () => () => {},
    sendFrame: () => {},
    closeChannel: () => {},
  }

  return {
    registry,
    router,
    sent,
    setOnline: (deviceId: string, agentId: string) => online.set(deviceId, agentId),
    setOffline: (deviceId: string) => online.delete(deviceId),
    setRoutable: (v: boolean) => {
      routable = v
    },
  }
}

describe('TunnelRpc (plan 25 §4.1) — correlation, timeout, offline, disconnect cleanup', () => {
  test('request() resolves with the reply payload once handleReply is called with the matching id', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })

    const promise = rpc.request<{ ok: boolean; stdout: string }>('dev-1', 'shell.exec.request', { cmd: 'ps' })
    expect(fake.sent).toHaveLength(1)
    const id = (fake.sent[0]?.msg as { id: string }).id
    expect(typeof id).toBe('string')

    const matched = rpc.handleReply({ type: 'shell.exec.reply', id, payload: { ok: true, stdout: 'hi' } })
    expect(matched).toBe(true)
    await expect(promise).resolves.toEqual({ ok: true, stdout: 'hi' })
  })

  test('rejects E_AGENT_OFFLINE immediately when the device has no agent online — no message is even sent', async () => {
    const fake = createFakeTunnel()
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    await expect(rpc.request('ghost-device', 'shell.exec.request', {})).rejects.toMatchObject({ code: 'E_AGENT_OFFLINE' })
    expect(fake.sent).toHaveLength(0)
  })

  test('rejects E_AGENT_OFFLINE when the registry says online but the send itself fails', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    fake.setRoutable(false)
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    await expect(rpc.request('dev-1', 'shell.exec.request', {})).rejects.toMatchObject({ code: 'E_AGENT_OFFLINE' })
  })

  test('rejects E_AGENT_TIMEOUT after the configured timeout with no reply', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    await expect(rpc.request('dev-1', 'shell.exec.request', {}, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'E_AGENT_TIMEOUT',
    })
  })

  test('a reply that arrives after the timeout has already fired is a harmless no-op (no id leak, no crash)', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    await expect(rpc.request('dev-1', 'shell.exec.request', {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' })
    const id = (fake.sent[0]?.msg as { id: string }).id
    // The late reply matches nothing — it was already cleaned up.
    expect(rpc.handleReply({ type: 'shell.exec.reply', id, payload: {} })).toBe(false)
  })

  test('handleReply for an unknown id is a no-op that returns false', () => {
    const fake = createFakeTunnel()
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    expect(rpc.handleReply({ type: 'shell.exec.reply', id: 'never-requested', payload: {} })).toBe(false)
  })

  test('handleReply resolves only the FIRST matching call — a duplicate reply cannot resolve twice or leak', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    const promise = rpc.request('dev-1', 'shell.exec.request', {})
    const id = (fake.sent[0]?.msg as { id: string }).id
    expect(rpc.handleReply({ type: 'shell.exec.reply', id, payload: { ok: true } })).toBe(true)
    expect(rpc.handleReply({ type: 'shell.exec.reply', id, payload: { ok: true } })).toBe(false)
    await promise
  })

  test('failAllForAgent rejects every pending request for that agent with E_AGENT_OFFLINE, and leaves other agents untouched', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    fake.setOnline('dev-2', 'agent-2')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })

    const p1 = rpc.request('dev-1', 'shell.exec.request', {})
    const p2 = rpc.request('dev-2', 'shell.exec.request', {})

    rpc.failAllForAgent('agent-1', 'the agent disconnected')
    await expect(p1).rejects.toMatchObject({ code: 'E_AGENT_OFFLINE' })

    // dev-2's request is still alive — resolve it normally.
    const id2 = (fake.sent[1]?.msg as { id: string }).id
    rpc.handleReply({ type: 'shell.exec.reply', id: id2, payload: { ok: true } })
    await expect(p2).resolves.toEqual({ ok: true })
  })

  test('an agent disconnecting mid-request rejects immediately, not after the timeout (acceptance #3)', async () => {
    const fake = createFakeTunnel()
    fake.setOnline('dev-1', 'agent-1')
    const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
    const start = Date.now()
    const promise = rpc.request('dev-1', 'shell.exec.request', {}, { timeoutMs: 5000 })
    rpc.failAllForAgent('agent-1', 'the agent disconnected')
    await expect(promise).rejects.toMatchObject({ code: 'E_AGENT_OFFLINE' })
    expect(Date.now() - start).toBeLessThan(200) // nowhere near the 5s timeout
  })

  describe('watch/dispatch — out-of-band pushes not tied to a pending request (shell.stream.ended)', () => {
    test('dispatch() delivers the payload to the matching watcher exactly once', () => {
      const fake = createFakeTunnel()
      fake.setOnline('dev-1', 'agent-1')
      const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
      const received: unknown[] = []
      rpc.watch('dev-1', 'stream-abc', (payload) => received.push(payload))

      expect(rpc.dispatch('stream-abc', { reason: 'idle' })).toBe(true)
      expect(received).toEqual([{ reason: 'idle' }])
      // A second push for the same (already-consumed) id matches nothing.
      expect(rpc.dispatch('stream-abc', { reason: 'idle' })).toBe(false)
      expect(received).toHaveLength(1)
    })

    test('the unsubscribe function returned by watch() prevents a later dispatch from firing it', () => {
      const fake = createFakeTunnel()
      fake.setOnline('dev-1', 'agent-1')
      const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
      const received: unknown[] = []
      const unwatch = rpc.watch('dev-1', 'stream-abc', (payload) => received.push(payload))
      unwatch()
      expect(rpc.dispatch('stream-abc', { reason: 'stopped' })).toBe(false)
      expect(received).toHaveLength(0)
    })

    test('failAllForAgent also ends every active watcher for that agent with reason agent_offline (acceptance #4)', () => {
      const fake = createFakeTunnel()
      fake.setOnline('dev-1', 'agent-1')
      fake.setOnline('dev-2', 'agent-2')
      const rpc = createTunnelRpc({ router: fake.router, registry: fake.registry })
      const seenOn1: unknown[] = []
      const seenOn2: unknown[] = []
      rpc.watch('dev-1', 'stream-1', (p) => seenOn1.push(p))
      rpc.watch('dev-2', 'stream-2', (p) => seenOn2.push(p))

      rpc.failAllForAgent('agent-1', 'the agent disconnected')

      expect(seenOn1).toEqual([{ reason: 'agent_offline' }])
      expect(seenOn2).toHaveLength(0) // dev-2's agent never dropped
      // The dead watcher is gone — a later dispatch for it matches nothing.
      expect(rpc.dispatch('stream-1', { reason: 'stopped' })).toBe(false)
    })
  })
})
