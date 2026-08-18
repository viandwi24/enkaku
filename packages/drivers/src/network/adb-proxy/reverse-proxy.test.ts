import { describe, expect, test } from 'bun:test'
import { shellQuote } from '@enkaku/adb'
import type { ReverseProxyRouteConfig, ShellResult, Transport } from '@enkaku/protocol'
import {
  HTTP_PROXY_EXCLUSION_LIST_KEY,
  HTTP_PROXY_HOST_KEY,
  HTTP_PROXY_KEY,
  HTTP_PROXY_PORT_KEY,
  HTTP_PROXY_RESET_VALUE,
  HttpProxyError,
  type CapturedHttpProxySettings,
  type HttpProxyCaptureStore,
} from './http-proxy'
import {
  createReverseProxyRoute,
  REVERSE_PROXY_DEVICE_HOST,
  reverseProxyValue,
  type ReverseAllocation,
  type ReverseAllocationStore,
  type ReverseBinding,
  type ReversePort,
} from './reverse-proxy'

/**
 * Plan 114 §3.6, §3.8, §4.2, §4.3 (step 114.5) — the `adb-reverse-proxy` engine.
 *
 * Every fake below writes into ONE shared, ordered log — the reverse's
 * `establish`/`release`, the allocation store's `write`, and every `exec` on the
 * transport — because on this rung the ordering between those three IS the
 * design, and a per-fake log could not express it:
 *
 * - apply: reverse **first**, then the setting. The port answers before any app
 *   can read a value pointing at it.
 * - revert: setting **first**, then the reverse. There is never a window where
 *   the phone is pointed at a port that has just stopped answering.
 * - establish → write allocation → write setting, so a crash in the middle
 *   still leaves the port on disk for the restore pass to converge on.
 *
 * And one invariant that is not an ordering rule at all, checked over the whole
 * log rather than one command: **nothing this engine writes to a phone may
 * contain a username, a password, or a userinfo `@`** (§3.8). The account lives
 * in the host-side listener; the only value that ever reaches the device is
 * built by `reverseProxyValue()` out of a port number.
 */

// ---------------------------------------------------------------------------
// Fakes, all writing into one ordered log
// ---------------------------------------------------------------------------

const GET_RE = /^settings get global (\S+)$/
const PUT_RE = /^settings put global (\S+) '(.*)'$/
const DELETE_RE = /^settings delete global (\S+)$/

function unquote(inner: string): string {
  return inner.split(`'\\''`).join(`'`)
}

interface FakeDeviceOptions {
  initial?: Record<string, string>
  fail?: (cmd: string) => ShellResult | undefined
}

function createFakeDevice(log: string[], opts: FakeDeviceOptions = {}) {
  const values = new Map<string, string>(Object.entries(opts.initial ?? {}))
  const transport: Transport = {
    id: 'fake',
    serial: 'fake-serial',
    stableId: 'fake-stable',
    connect: async () => {},
    disconnect: async () => {},
    execOut: async () => new Uint8Array(),
    async exec(cmd: string): Promise<ShellResult> {
      log.push(`exec ${cmd}`)
      const override = opts.fail?.(cmd)
      if (override) return override
      const get = GET_RE.exec(cmd)
      const put = PUT_RE.exec(cmd)
      const del = DELETE_RE.exec(cmd)
      if (get) {
        const key = get[1]!
        return { stdout: values.has(key) ? `${values.get(key)!}\n` : 'null\n', stderr: '', exitCode: 0 }
      }
      if (put) {
        values.set(put[1]!, unquote(put[2]!))
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (del) {
        values.delete(del[1]!)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: `the fake device does not know this command: ${cmd}`, exitCode: 1 }
    },
  }
  return { transport, values }
}

interface FakeReverseOptions {
  /** The port the registry hands out when it is allowed to walk its range. */
  allocates?: number
  /** An entry the live registry already holds — e.g. after a replug within one core lifetime. */
  existing?: ReverseBinding | null
  establishThrows?: Error
  releaseThrows?: Error
}

function createFakeReverse(log: string[], opts: FakeReverseOptions = {}) {
  let entry: ReverseBinding | null = opts.existing ?? null
  const establishCalls: Array<{ hostPort: number; devicePort?: number }> = []
  const releaseCalls: string[] = []

  const port: ReversePort = {
    async establish(_deviceId, o) {
      log.push(`reverse.establish hostPort=${o.hostPort} devicePort=${o.devicePort ?? '(walk)'}`)
      establishCalls.push(o)
      if (opts.establishThrows) throw opts.establishThrows
      entry = { devicePort: o.devicePort ?? opts.allocates ?? 28100, hostPort: o.hostPort, establishedAt: 1_700_000_000 }
      return entry
    },
    async release(deviceId) {
      log.push('reverse.release')
      releaseCalls.push(deviceId)
      if (opts.releaseThrows) throw opts.releaseThrows
      entry = null
    },
    get: () => entry,
  }

  return {
    port,
    establishCalls,
    releaseCalls,
    get entry() {
      return entry
    },
  }
}

function createAllocationStore(log: string[], initial: ReverseAllocation | null = null) {
  let value: ReverseAllocation | null = initial
  const writes: ReverseAllocation[] = []
  const store: ReverseAllocationStore = {
    read: () => value,
    write: (allocation) => {
      log.push(`allocation.write devicePort=${allocation.devicePort} hostPort=${allocation.hostPort}`)
      value = allocation
      writes.push(allocation)
    },
  }
  return {
    store,
    writes,
    get current() {
      return value
    },
  }
}

function createCaptureStore(initial: CapturedHttpProxySettings | null = null) {
  let value: CapturedHttpProxySettings | null = initial
  const store: HttpProxyCaptureStore = {
    read: () => value,
    write: (captured) => {
      value = captured
    },
  }
  return {
    store,
    get current() {
      return value
    },
  }
}

const CONFIG: ReverseProxyRouteConfig = { engine: 'adb-reverse-proxy', hostPort: 8888 }

const putCmd = (key: string, value: string) => `exec settings put global ${key} ${shellQuote(value)}`
const deleteCmd = (key: string) => `exec settings delete global ${key}`
const isDeviceWrite = (entry: string) => entry.startsWith('exec settings put ') || entry.startsWith('exec settings delete ')

interface HarnessOptions {
  device?: FakeDeviceOptions
  reverse?: FakeReverseOptions
  allocation?: ReverseAllocation | null
  capture?: CapturedHttpProxySettings | null
}

function harness(opts: HarnessOptions = {}) {
  const log: string[] = []
  const device = createFakeDevice(log, opts.device)
  const reverse = createFakeReverse(log, opts.reverse)
  const allocation = createAllocationStore(log, opts.allocation ?? null)
  const capture = createCaptureStore(opts.capture ?? null)
  const engine = createReverseProxyRoute({
    transport: device.transport,
    deviceId: 'dev-1',
    reverse: reverse.port,
    allocation: allocation.store,
    capture: capture.store,
  })
  return { log, device, reverse, allocation, capture, engine }
}

// ---------------------------------------------------------------------------

describe('reverseProxyValue (plan 114 §3.8)', () => {
  test('builds 127.0.0.1:<port> from a port NUMBER — there is no parameter through which a credential could reach a phone', () => {
    expect(reverseProxyValue(28100)).toBe('127.0.0.1:28100')
    expect(REVERSE_PROXY_DEVICE_HOST).toBe('127.0.0.1')
  })
})

describe('createReverseProxyRoute() — what the engine advertises (plan 114 §3.2, §3.5, §3.8)', () => {
  test('id is "adb-reverse-proxy"', () => {
    expect(harness().engine.id).toBe('adb-reverse-proxy')
  })

  test('every capability is false — auth included, because the credential belongs to the listener on this machine', () => {
    expect(harness().engine.capabilities).toEqual({ auth: false, enforcing: false, udp: false, probe: false })
  })

  test('probe and hold are ABSENT, exactly as on rung 1', () => {
    const { engine } = harness()
    expect('probe' in engine).toBe(false)
    expect('hold' in engine).toBe(false)
  })
})

describe('createReverseProxyRoute().apply — order (plan 114 §3.6, §3.7)', () => {
  test('the reverse is established BEFORE the first settings put, and the allocation is persisted in between', async () => {
    const h = harness()
    await h.engine.apply(CONFIG)

    const establishAt = h.log.findIndex((e) => e.startsWith('reverse.establish'))
    const allocateAt = h.log.findIndex((e) => e.startsWith('allocation.write'))
    const firstWriteAt = h.log.findIndex(isDeviceWrite)

    expect(establishAt).toBeGreaterThanOrEqual(0)
    expect(firstWriteAt).toBeGreaterThanOrEqual(0)
    expect(establishAt).toBeLessThan(allocateAt)
    expect(allocateAt).toBeLessThan(firstWriteAt)
    // The reverse is the very first thing that happens at all — before even the capture reads.
    expect(establishAt).toBe(0)
  })

  test('the value written to the phone is 127.0.0.1:<devicePort> and nothing else', async () => {
    const h = harness({ reverse: { allocates: 28100 } })
    await h.engine.apply(CONFIG)
    expect(h.device.values.get(HTTP_PROXY_KEY)).toBe('127.0.0.1:28100')
    expect(h.log).toContain(putCmd(HTTP_PROXY_KEY, '127.0.0.1:28100'))
    // The operator's own farm-side port never reaches the device.
    expect(h.log.filter(isDeviceWrite).some((e) => e.includes('8888'))).toBe(false)
  })

  test('NOTHING in the whole log carries a userinfo `@`, a username or a password — even when the caller smuggles them onto the config', async () => {
    // `ReverseProxyRouteConfig` has no such fields, so this has to be forced past the type to be
    // tested at all — which is the point: the guarantee is the SHAPE of the code (the only value
    // reaching the settings writer is built from a port number), not a field-by-field filter.
    const smuggled = {
      engine: 'adb-reverse-proxy',
      hostPort: 8888,
      username: 'secretuser',
      password: 'hunter2',
      host: 'user:pass@upstream.example',
    } as unknown as ReverseProxyRouteConfig

    const h = harness()
    await h.engine.apply(smuggled)

    const joined = h.log.join('\n')
    expect(joined).not.toContain('@')
    expect(joined).not.toContain('secretuser')
    expect(joined).not.toContain('hunter2')
    expect(joined).not.toContain('upstream.example')
    expect(h.device.values.get(HTTP_PROXY_KEY)).toBe('127.0.0.1:28100')
  })

  test('exclusions still reach the device — they are the operator’s, and they carry no secret', async () => {
    const h = harness()
    await h.engine.apply({ ...CONFIG, exclusions: ['localhost'] })
    expect(h.log).toContain(putCmd(HTTP_PROXY_EXCLUSION_LIST_KEY, 'localhost'))
    // And the exclusion list still goes before the composite key, as on rung 1.
    expect(h.log.indexOf(putCmd(HTTP_PROXY_EXCLUSION_LIST_KEY, 'localhost'))).toBeLessThan(
      h.log.indexOf(putCmd(HTTP_PROXY_KEY, '127.0.0.1:28100')),
    )
  })

  test('no exclusions deletes the key rather than writing an empty one', async () => {
    const h = harness({ device: { initial: { [HTTP_PROXY_EXCLUSION_LIST_KEY]: 'stale.example' } } })
    await h.engine.apply(CONFIG)
    expect(h.log).toContain(deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY))
    expect(h.device.values.has(HTTP_PROXY_EXCLUSION_LIST_KEY)).toBe(false)
  })
})

describe('createReverseProxyRoute().apply — the two half-failures (plan 114 §3.6)', () => {
  test('`adb reverse` FAILING means no settings put ever ran — a phone is never left pointed at a port that answers nothing', async () => {
    const boom = new Error('E_REVERSE_FAILED: adb reverse tcp:28100 tcp:8888 failed')
    const h = harness({ reverse: { establishThrows: boom } })

    const err = await h.engine.apply(CONFIG).catch((e: unknown) => e)
    expect(err).toBe(boom)
    expect(h.log.filter(isDeviceWrite)).toEqual([])
    // Nor was an allocation recorded for a tunnel that does not exist.
    expect(h.allocation.writes).toEqual([])
    expect(h.log).toEqual(['reverse.establish hostPort=8888 devicePort=(walk)'])
  })

  test('establish OK then the write DECLINED leaves the reverse standing and does NOT call release', async () => {
    // Tearing it down would guarantee a dead port for a phone that may well have taken the write —
    // a read-back mismatch is not proof the value was rejected.
    const h = harness({
      device: {
        initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' },
        fail: (cmd) => (cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: '', exitCode: 0 } : undefined),
      },
    })

    const err = await h.engine.apply(CONFIG).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpProxyError)
    expect((err as HttpProxyError).code).toBe('E_SETTING_NOT_ACCEPTED')
    expect(h.reverse.releaseCalls).toEqual([])
    expect(h.log).not.toContain('reverse.release')
    expect(h.reverse.entry).toEqual({ devicePort: 28100, hostPort: 8888, establishedAt: 1_700_000_000 })
    // And the allocation is on disk, so `revert()` can still reach the standing tunnel later.
    expect(h.allocation.current).toMatchObject({ devicePort: 28100, hostPort: 8888 })
  })

  test('the left-standing reverse is reported at warn rather than silently', async () => {
    const logs: Array<{ level: string; msg: string }> = []
    const log: string[] = []
    const device = createFakeDevice(log, {
      fail: (cmd) => (cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: '', exitCode: 0 } : undefined),
    })
    const reverse = createFakeReverse(log)
    const engine = createReverseProxyRoute({
      transport: device.transport,
      deviceId: 'dev-1',
      reverse: reverse.port,
      allocation: createAllocationStore(log).store,
      capture: createCaptureStore().store,
      onLog: (level, msg) => logs.push({ level, msg }),
    })
    await engine.apply(CONFIG).catch(() => {})
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('left standing'))).toBe(true)
  })
})

describe('createReverseProxyRoute().apply — which device port is asked for (plan 114 §4.3)', () => {
  test('a STORED allocation pins the port exactly — the phone’s own setting names that number', async () => {
    const h = harness({ allocation: { devicePort: 28105, hostPort: 7777, at: 5 }, reverse: { allocates: 29999 } })
    await h.engine.apply(CONFIG)
    expect(h.reverse.establishCalls).toEqual([{ hostPort: 8888, devicePort: 28105 }])
    expect(h.device.values.get(HTTP_PROXY_KEY)).toBe('127.0.0.1:28105')
    // The hostPort on disk follows the config; the devicePort does not move.
    expect(h.allocation.current).toMatchObject({ devicePort: 28105, hostPort: 8888 })
  })

  test('no stored allocation but a LIVE registry entry pins that port', async () => {
    const h = harness({
      reverse: { existing: { devicePort: 28107, hostPort: 8888, establishedAt: 1 }, allocates: 29999 },
    })
    await h.engine.apply(CONFIG)
    expect(h.reverse.establishCalls).toEqual([{ hostPort: 8888, devicePort: 28107 }])
  })

  test('the stored allocation WINS over a live entry that disagrees — the row is what the phone’s setting agrees with', async () => {
    const h = harness({
      allocation: { devicePort: 28105, hostPort: 8888, at: 5 },
      reverse: { existing: { devicePort: 28107, hostPort: 8888, establishedAt: 1 } },
    })
    await h.engine.apply(CONFIG)
    expect(h.reverse.establishCalls[0]?.devicePort).toBe(28105)
  })

  test('NO allocation and NO live entry is the only case a walk is allowed — establish is called with no devicePort key at all', async () => {
    const h = harness({ reverse: { allocates: 28100 } })
    await h.engine.apply(CONFIG)
    expect(h.reverse.establishCalls).toHaveLength(1)
    expect('devicePort' in h.reverse.establishCalls[0]!).toBe(false)
    expect(h.log[0]).toBe('reverse.establish hostPort=8888 devicePort=(walk)')
  })

  test('re-applying with a DIFFERENT hostPort keeps the device port and re-points the tunnel — the phone’s setting never changes', async () => {
    const h = harness({ reverse: { allocates: 28100 } })
    await h.engine.apply(CONFIG)
    await h.engine.apply({ engine: 'adb-reverse-proxy', hostPort: 9999 })

    expect(h.reverse.establishCalls).toEqual([
      { hostPort: 8888 },
      { hostPort: 9999, devicePort: 28100 },
    ])
    expect(h.device.values.get(HTTP_PROXY_KEY)).toBe('127.0.0.1:28100')
    expect(h.allocation.current).toMatchObject({ devicePort: 28100, hostPort: 9999 })
  })
})

describe('createReverseProxyRoute().revert — setting first, reverse second (plan 114 §3.6)', () => {
  test('the release is the LAST thing that happens, after every device write', async () => {
    const h = harness({ capture: { httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 } })
    await h.engine.revert()

    const releaseAt = h.log.indexOf('reverse.release')
    expect(releaseAt).toBe(h.log.length - 1)
    const lastWriteAt = h.log.reduce((acc, e, i) => (isDeviceWrite(e) ? i : acc), -1)
    expect(lastWriteAt).toBeGreaterThanOrEqual(0)
    expect(lastWriteAt).toBeLessThan(releaseAt)
    expect(h.reverse.releaseCalls).toEqual(['dev-1'])
  })

  test('with a capture, the captured values are restored — and only then is the tunnel torn down', async () => {
    const captured: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '10.9.9.9', port: '3128', exclusionList: '', at: 5 }
    const h = harness({ device: { initial: { [HTTP_PROXY_KEY]: '127.0.0.1:28100' } }, capture: captured })
    await h.engine.revert()
    expect(h.device.values.get(HTTP_PROXY_KEY)).toBe('10.9.9.9:3128')
    expect(h.log.filter((e) => isDeviceWrite(e) || e === 'reverse.release')).toEqual([
      putCmd(HTTP_PROXY_HOST_KEY, '10.9.9.9'),
      putCmd(HTTP_PROXY_PORT_KEY, '3128'),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, '10.9.9.9:3128'),
      'reverse.release',
    ])
  })

  test('with NO capture it clears to Android’s default — `:0` then delete — and then releases', async () => {
    const h = harness({ device: { initial: { [HTTP_PROXY_KEY]: '127.0.0.1:28100' } } })
    await h.engine.revert()
    expect(h.log.filter((e) => isDeviceWrite(e) || e === 'reverse.release')).toEqual([
      deleteCmd(HTTP_PROXY_HOST_KEY),
      deleteCmd(HTTP_PROXY_PORT_KEY),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE),
      deleteCmd(HTTP_PROXY_KEY),
      'reverse.release',
    ])
    expect(h.device.values.has(HTTP_PROXY_KEY)).toBe(false)
  })

  test('a release that THROWS is tolerated — revert never throws, per NetworkRoute’s own contract', async () => {
    const h = harness({ reverse: { releaseThrows: new Error('registry exploded') } })
    await expect(h.engine.revert()).resolves.toBeUndefined()
  })

  test('DOUBLE REVERT is idempotent, never throws, and leaves the capture AND the allocation in place', async () => {
    // The allocation deliberately survives: `/disable` keeps the row, and a route switched back on
    // should come back on the port the phone last knew.
    const captured: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 }
    const h = harness({ allocation: { devicePort: 28105, hostPort: 8888, at: 5 }, capture: captured })

    await h.engine.revert()
    const first = h.log.slice()
    h.log.length = 0
    await h.engine.revert()

    expect(h.log).toEqual(first)
    expect(h.capture.current).toEqual(captured)
    expect(h.allocation.current).toEqual({ devicePort: 28105, hostPort: 8888, at: 5 })
  })
})

describe('createReverseProxyRoute().observe — delegated whole to the settings half (plan 114 §3.5)', () => {
  test('the phone reporting the loopback address reads as up, and `up` says nothing about the tunnel behind it', async () => {
    const h = harness({ device: { initial: { [HTTP_PROXY_KEY]: '127.0.0.1:28100' } } })
    expect(await h.engine.observe()).toEqual({ prepared: true, up: true, state: 'up', upstream: '127.0.0.1:28100' })
  })

  test('a dead reverse with the setting intact STILL reads up — that fact belongs to the `reverse` check, not to `up`', async () => {
    // The registry is empty (nothing established), and the phone still carries the setting. `up`
    // must not fold the two facts together, or the report loses the ability to say which failed.
    const h = harness({ device: { initial: { [HTTP_PROXY_KEY]: '127.0.0.1:28100' } } })
    expect(h.reverse.entry).toBeNull()
    expect((await h.engine.observe()).up).toBe(true)
  })

  test('an unset setting reads as down', async () => {
    const h = harness()
    expect(await h.engine.observe()).toEqual({ prepared: true, up: false, state: 'down' })
  })
})
