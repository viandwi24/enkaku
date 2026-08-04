import { describe, expect, test } from 'bun:test'
import type { AdbClient, AdbStreamHandle, AdbStreamOptions } from '@enkaku/adb'
import type { TunnelRouter } from '../tunnel/router'
import type { TunnelRpc } from '../tunnel/rpc'
import { createLocalShellPort, createRemoteShellPort } from './shell-port'

// ---- local port: a thin wrapper over a fake AdbClient, no real socket ----

describe('createLocalShellPort (plan 25 §4.3)', () => {
  test('exec() maps AdbClient.exec output to a ShellExecResult', async () => {
    const calls: Array<{ serial: string; cmd: string }> = []
    const client = {
      exec: async (serial: string, cmd: string) => {
        calls.push({ serial, cmd })
        return { stdout: 'hello world', stderr: 'a warning', exitCode: 0 }
      },
    } as unknown as AdbClient
    const port = createLocalShellPort({ client, serial: 'SER1' })

    const result = await port.exec('echo hi', { profile: 'appLifecycle' })
    expect(result).toEqual({ stdout: 'hello world', stderr: 'a warning', exitCode: 0, truncated: false })
    expect(calls).toEqual([{ serial: 'SER1', cmd: 'echo hi' }])
  })

  test('exec() lets AdbClient errors propagate unchanged', async () => {
    const client = {
      exec: async () => {
        throw new Error('adb blew up')
      },
    } as unknown as AdbClient
    const port = createLocalShellPort({ client, serial: 'SER1' })
    await expect(port.exec('anything')).rejects.toThrow('adb blew up')
  })

  test('stream() wraps execStream: data flows through, stop() calls the underlying handle', async () => {
    const captured: { opts: AdbStreamOptions | null } = { opts: null }
    const client = {
      execStream: async (serial: string, cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> => {
        captured.opts = opts
        return { pid: 4242, stop: async () => opts.onEnd('stopped') }
      },
    } as unknown as AdbClient
    const port = createLocalShellPort({ client, serial: 'SER1' })

    const received: Uint8Array[] = []
    const ended: string[] = []
    const handle = await port.stream('logcat', { onData: (c) => received.push(c), onEnd: (r) => ended.push(r) })
    expect(handle.streamId).toBe('4242') // the pid, when known

    captured.opts?.onData(new TextEncoder().encode('a line\n'))
    expect(received).toHaveLength(1)

    await handle.stop()
    expect(ended).toEqual(['stopped'])
  })
})

// ---- remote port: against a fake rpc/router, no real tunnel ----

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
      return () => watchers.delete(id)
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
  }
}

function createFakeRouter() {
  let nextChannelId = 1
  let channelsAvailable = true
  const opened: Array<{ deviceId: string; kind: string; channelId: number }> = []
  const closed: number[] = []
  const sentToDevice: Array<{ deviceId: string; msg: unknown }> = []
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
    sendFrame: () => {},
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
    emit: (channelId: number, text: string) => dataSubs.get(channelId)?.(new TextEncoder().encode(text)),
    setChannelsAvailable: (v: boolean) => {
      channelsAvailable = v
    },
  }
}

describe('createRemoteShellPort (plan 25 §4.3) — against a fake rpc/router', () => {
  test('exec() sends shell.exec.request and maps a successful reply', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true, stdout: 'device output', stderr: 'device warning', exitCode: 0, truncated: false })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    const result = await port.exec('ps -A', { profile: 'appLifecycle', maxOutputBytes: 1024 })
    expect(result).toEqual({ stdout: 'device output', stderr: 'device warning', exitCode: 0, truncated: false })
    expect(fakeRpc.calls).toHaveLength(1)
    expect(fakeRpc.calls[0]).toMatchObject({
      deviceId: 'dev-1',
      type: 'shell.exec.request',
      payload: { deviceId: 'dev-1', cmd: 'ps -A', profile: 'appLifecycle', maxOutputBytes: 1024 },
    })
  })

  test('exec() defaults stderr to "" when the agent reply omits it (an older agent build predating plan 53)', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true, stdout: 'device output', exitCode: 0, truncated: false }) // no `stderr` field at all
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    const result = await port.exec('ps -A')
    expect(result).toEqual({ stdout: 'device output', stderr: '', exitCode: 0, truncated: false })
  })

  test('exec() error passthrough: a reply with ok:false throws a coded EnkakuError built from it', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: false, error: { code: 'E_ADB_TIMEOUT', message: 'adb shell:ps -A exceeded 15000ms' } })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(port.exec('ps -A')).rejects.toMatchObject({ code: 'E_ADB_TIMEOUT', message: 'adb shell:ps -A exceeded 15000ms' })
  })

  test('exec() lets a TunnelRpc rejection (offline/timeout) propagate unchanged', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    class Boom extends Error {
      code = 'E_AGENT_TIMEOUT'
    }
    fakeRpc.setRejection(new Boom('agent did not reply'))
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    await expect(port.exec('ps -A')).rejects.toMatchObject({ code: 'E_AGENT_TIMEOUT' })
  })

  test('stream() opens a shell channel, starts on a successful reply, and delivers channel frames via onData', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true, streamId: 'agent-stream-1' })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    const received: string[] = []
    const handle = await port.stream('logcat -v time', {
      onData: (c) => {
        received.push(new TextDecoder().decode(c))
      },
      onEnd: () => {},
    })

    expect(handle.streamId).toBe('agent-stream-1')
    expect(fakeRouter.opened).toEqual([{ deviceId: 'dev-1', kind: 'shell', channelId: 1 }])
    expect(fakeRpc.calls[0]).toMatchObject({ type: 'shell.stream.request', payload: { deviceId: 'dev-1', cmd: 'logcat -v time', channelId: 1 } })

    fakeRouter.emit(1, 'a log line\n')
    expect(received).toEqual(['a log line\n'])
  })

  test('stop() sends shell.stream.stop, closes the channel, and fires onEnd("stopped") — channel release on the happy path', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true, streamId: 'agent-stream-1' })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const ended: string[] = []
    const handle = await port.stream('logcat', { onData: () => {}, onEnd: (r) => ended.push(r) })

    await handle.stop()

    expect(fakeRouter.sentToDevice).toEqual([{ deviceId: 'dev-1', msg: { type: 'shell.stream.stop', payload: { streamId: 'agent-stream-1' } } }])
    expect(fakeRouter.closed).toEqual([1])
    expect(ended).toEqual(['stopped'])
    // The watcher for this stream is gone — a late `shell.stream.ended` from
    // the agent (a race with our own stop) is a harmless no-op, not a double-end.
    expect(fakeRpc.hasWatcher('agent-stream-1')).toBe(false)
  })

  test('an agent-pushed shell.stream.ended (idle/deadline/error/backpressure) closes the channel and fires onEnd with that reason', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: true, streamId: 'agent-stream-1' })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })
    const ended: string[] = []
    await port.stream('logcat', { onData: () => {}, onEnd: (r) => ended.push(r) })

    const dispatched = fakeRpc.rpc.dispatch('agent-stream-1', { streamId: 'agent-stream-1', reason: 'idle' })

    expect(dispatched).toBe(true)
    expect(ended).toEqual(['idle'])
    expect(fakeRouter.closed).toEqual([1]) // released even though nobody called stop()
  })

  test('the channel is released even when the agent rejects the stream request (channel release on the unhappy path)', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRpc.setReply({ ok: false, error: { code: 'E_ADB_STREAM_LIMIT', message: 'too many streams' } })
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(port.stream('logcat', { onData: () => {}, onEnd: () => {} })).rejects.toMatchObject({ code: 'E_ADB_STREAM_LIMIT' })
    expect(fakeRouter.opened).toHaveLength(1)
    expect(fakeRouter.closed).toEqual([1]) // opened optimistically, released on rejection
  })

  test('stream() throws agent_offline without ever calling rpc.request when no channel can be opened', async () => {
    const fakeRpc = createFakeRpc()
    const fakeRouter = createFakeRouter()
    fakeRouter.setChannelsAvailable(false)
    const port = createRemoteShellPort({ rpc: fakeRpc.rpc, router: fakeRouter.router, deviceId: 'dev-1' })

    await expect(port.stream('logcat', { onData: () => {}, onEnd: () => {} })).rejects.toMatchObject({ code: 'agent_offline' })
    expect(fakeRpc.calls).toHaveLength(0)
  })
})
