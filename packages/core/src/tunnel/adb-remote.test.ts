import { describe, expect, test } from 'bun:test'
import type { TunnelRouter } from './router'
import type { TunnelRpc } from './rpc'
import { createRemoteOpenService } from './adb-remote'

// ---- fakes: no real tunnel, no real agent — mirrors shell-port.test.ts's harness ----

interface FakeRpcRequest {
  deviceId: string
  type: string
  payload: unknown
}

function createFakeRpc() {
  const calls: FakeRpcRequest[] = []
  const watchers = new Map<string, (payload: unknown) => void>()
  let nextReply: unknown = { ok: true }
  let nextRejection: Error | null = null

  const rpc: TunnelRpc = {
    async request<T>(deviceId: string, type: string, payload: unknown) {
      calls.push({ deviceId, type, payload })
      if (nextRejection) throw nextRejection
      return nextReply as T
    },
    handleReply: () => false,
    watch: (_deviceId, id, cb) => {
      watchers.set(id, cb)
      return () => {
        // Mirror the real implementation's identity check (plan 25 §4.1):
        // only remove the entry if it is still THIS registration.
        if (watchers.get(id) === cb) watchers.delete(id)
      }
    },
    dispatch: (id, payload) => {
      const cb = watchers.get(id)
      if (!cb) return false
      watchers.delete(id)
      cb(payload)
      return true
    },
    failAllForAgent: () => {},
  }
  return {
    rpc,
    calls,
    setReply: (r: unknown) => {
      nextReply = r
    },
    setRejection: (e: Error | null) => {
      nextRejection = e
    },
    hasWatcher: (id: string) => watchers.has(id),
    watcherCount: () => watchers.size,
  }
}

function createFakeRouter() {
  let nextChannelId = 1
  let channelsAvailable = true
  const opened: Array<{ deviceId: string; kind: string; channelId: number }> = []
  const closed: number[] = []
  const sentToDevice: Array<{ deviceId: string; msg: unknown }> = []
  const framesSent: Array<{ channelId: number; payload: Uint8Array }> = []
  const dataSubs = new Map<number, (payload: Uint8Array) => void>()

  const router: TunnelRouter = {
    handleAgentMessage: () => {},
    handleAgentFrame: () => {},
    sendToDevice: (deviceId, msg) => {
      sentToDevice.push({ deviceId, msg })
      return true
    },
    subscribeVideo: () => () => {},
    openChannel: (deviceId, kind) => {
      if (!channelsAvailable) return null
      const channelId = nextChannelId++
      opened.push({ deviceId, kind, channelId })
      return channelId
    },
    subscribeChannel: (channelId, cb) => {
      dataSubs.set(channelId, cb)
      return () => dataSubs.delete(channelId)
    },
    sendFrame: (channelId, payload) => {
      framesSent.push({ channelId, payload })
    },
    closeChannel: (channelId) => {
      closed.push(channelId)
      dataSubs.delete(channelId)
    },
  }
  return {
    router,
    opened,
    closed,
    sentToDevice,
    framesSent,
    emit: (channelId: number, text: string) => dataSubs.get(channelId)?.(new TextEncoder().encode(text)),
    setChannelsAvailable: (v: boolean) => {
      channelsAvailable = v
    },
  }
}

const td = new TextDecoder()

describe('createRemoteOpenService (plan 28 §4.2) — against a fake rpc/router', () => {
  test('opens an adb-raw channel, sends adb.open.request, and resolves a RawStream on ok:true', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    const stream = await openService('SERIAL-1', 'shell:echo hi')

    expect(fakeRouter.opened).toEqual([{ deviceId: 'dev-1', kind: 'adb-raw', channelId: 1 }])
    expect(fakeRpc.calls).toEqual([
      { deviceId: 'dev-1', type: 'adb.open.request', payload: { deviceId: 'dev-1', service: 'shell:echo hi', channelId: 1 } },
    ])
    expect(stream).toBeTruthy()
  })

  test('an ok:false reply throws a coded error and releases the channel', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: false, error: { code: 'E_ADB_STREAM_LIMIT', message: 'too many streams' } })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(openService('SERIAL-1', 'shell:x')).rejects.toMatchObject({ code: 'E_ADB_STREAM_LIMIT' })
    expect(fakeRouter.opened).toHaveLength(1)
    expect(fakeRouter.closed).toEqual([1]) // opened optimistically, released on refusal
  })

  test('a TunnelRpc rejection (offline/timeout) propagates and releases the channel', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    class Boom extends Error {
      code = 'E_AGENT_TIMEOUT'
    }
    fakeRpc.setRejection(new Boom('agent did not reply'))
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(openService('SERIAL-1', 'shell:x')).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' })
    expect(fakeRouter.closed).toEqual([1])
  })

  test('no channel available throws agent_offline without ever calling rpc.request', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRouter.setChannelsAvailable(false)
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(openService('SERIAL-1', 'shell:x')).rejects.toMatchObject({ code: 'agent_offline' })
    expect(fakeRpc.calls).toHaveLength(0)
  })

  test('inbound channel frames (device → agent → core) reach onData via subscribeChannel', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'shell:cat')

    const received: string[] = []
    stream.streamFrom(
      (chunk) => received.push(td.decode(chunk)),
      () => {},
    )
    fakeRouter.emit(1, 'device output\n')
    expect(received).toEqual(['device output\n'])
  })
})

describe('createRemoteOpenService — ack-driven delivery window (plan 28 §3.3, acceptance #4)', () => {
  test('write() does NOT resolve until adb.ack arrives for that channel — the window does not advance on a mere handoff to the tunnel', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'sync:')
    stream.streamFrom(
      () => {},
      () => {},
    )

    let resolved = false
    const writePromise = Promise.resolve(stream.write(new TextEncoder().encode('chunk-1'))).then(() => {
      resolved = true
    })

    // The bytes are handed to the tunnel immediately (no local queueing when
    // nothing is outstanding)...
    expect(fakeRouter.framesSent).toHaveLength(1)
    expect(td.decode(fakeRouter.framesSent[0]!.payload)).toBe('chunk-1')
    // ...but the write must NOT have resolved yet — that would mean the
    // shim's WRTE window advanced on a mere handoff, exactly what plan 28
    // §3.3 forbids ("the shim must NOT acknowledge a WRTE when it merely
    // hands bytes to the tunnel").
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Only once the agent's adb.ack for this channel is dispatched does the
    // write settle.
    const matched = fakeRpc.rpc.dispatch('adb:1:ack', { bytes: 7 })
    expect(matched).toBe(true)
    await writePromise
    expect(resolved).toBe(true)
  })

  test('a second write queues behind the first and is not sent to the tunnel until the first is acked', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'sync:')
    stream.streamFrom(
      () => {},
      () => {},
    )

    const order: string[] = []
    const w1 = Promise.resolve(stream.write(new TextEncoder().encode('one'))).then(() => order.push('one'))
    const w2 = Promise.resolve(stream.write(new TextEncoder().encode('two'))).then(() => order.push('two'))

    // Only the first chunk has actually gone out — the second is withheld,
    // which is exactly what keeps control-plane memory flat: at most one
    // chunk per stream is ever unacknowledged.
    expect(fakeRouter.framesSent).toHaveLength(1)
    expect(td.decode(fakeRouter.framesSent[0]!.payload)).toBe('one')

    fakeRpc.rpc.dispatch('adb:1:ack', { bytes: 3 })
    await w1
    expect(order).toEqual(['one'])
    expect(fakeRouter.framesSent).toHaveLength(2)
    expect(td.decode(fakeRouter.framesSent[1]!.payload)).toBe('two')

    fakeRpc.rpc.dispatch('adb:1:ack', { bytes: 3 })
    await w2
    expect(order).toEqual(['one', 'two'])
  })

  test('close() sends adb.close, releases the channel, and unblocks the underlying stream-mux write via streamFrom onEnd', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'shell:x')
    const ended: unknown[] = []
    stream.streamFrom(
      () => {},
      (err) => ended.push(err),
    )

    stream.close(false)

    expect(fakeRouter.sentToDevice).toEqual([{ deviceId: 'dev-1', msg: { type: 'adb.close', payload: { channelId: 1, reason: 'closed' } } }])
    expect(fakeRouter.closed).toEqual([1])
    expect(ended).toEqual(['closed'])
  })

  test('a pending write is resolved (never left hanging) when the agent reports adb.close before acking', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'sync:')
    const ended: unknown[] = []
    stream.streamFrom(
      () => {},
      (err) => ended.push(err),
    )

    let resolved = false
    const writePromise = Promise.resolve(stream.write(new TextEncoder().encode('chunk'))).then(() => {
      resolved = true
    })
    expect(resolved).toBe(false)

    // The agent (or `failAllForAgent`) reports the stream ending before ever
    // acking — plan §3.5: "half-open streams that never resolve are the
    // worst possible failure for a file transfer."
    fakeRpc.rpc.dispatch('adb:1:close', { reason: 'agent_offline' })

    await writePromise
    expect(resolved).toBe(true)
    expect(ended).toEqual(['agent_offline'])
    expect(fakeRouter.closed).toEqual([1])
  })
})

describe('createRemoteOpenService — channel release on every path (plan §4.2 point 5, acceptance #7)', () => {
  test('no watcher is left registered after a clean close', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true })
    const openService = createRemoteOpenService({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const stream = await openService('SERIAL-1', 'shell:x')
    stream.streamFrom(
      () => {},
      () => {},
    )
    expect(fakeRpc.hasWatcher('adb:1:close')).toBe(true)

    stream.close(false)
    expect(fakeRpc.hasWatcher('adb:1:close')).toBe(false)
    expect(fakeRpc.watcherCount()).toBe(0)
  })
})
