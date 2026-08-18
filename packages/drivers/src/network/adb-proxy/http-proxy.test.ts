import { describe, expect, test } from 'bun:test'
import { shellQuote } from '@enkaku/adb'
import type { HttpProxyRouteConfig, ShellResult, Transport } from '@enkaku/protocol'
import {
  createHttpProxyRoute,
  HTTP_PROXY_EXCLUSION_LIST_KEY,
  HTTP_PROXY_HOST_KEY,
  HTTP_PROXY_KEY,
  HTTP_PROXY_PORT_KEY,
  HTTP_PROXY_RESET_VALUE,
  HttpProxyError,
  httpProxyExclusionList,
  httpProxyValue,
  normaliseUnset,
  readHttpProxySettings,
  type CapturedHttpProxySettings,
  type HttpProxyCaptureStore,
} from './http-proxy'

/**
 * Plan 114 §3.6, §4.2 — the `adb-proxy` engine, tested against a fake
 * `Transport` that records an ORDERED call log and models the four
 * `Settings.Global` keys the way a device does (an unset key prints the literal
 * string `null`).
 *
 * The order matters more than any individual command here, and that is why the
 * log is a list rather than a set. Three of this engine's rules are ordering
 * rules and nothing else:
 *
 * - the capture is taken BEFORE any write, or a device that could not be read
 *   gets recorded as pristine and a revert months later destroys the operator's
 *   own proxy;
 * - `http_proxy` is written LAST, because it is the key the framework reacts to;
 * - on a restore-to-unset, `:0` is written BEFORE the delete, because `:0` is
 *   what the framework notices and the delete is what leaves the row genuinely
 *   absent.
 */

// ---------------------------------------------------------------------------
// The fake device
// ---------------------------------------------------------------------------

interface FakeDeviceOptions {
  /** Keys the device already has set. Anything absent reads back as Android's literal `null`. */
  initial?: Record<string, string>
  /**
   * Full override for a matching command: the device state is NOT touched and
   * this result is returned instead. Used to model a read that fails, a write
   * the device accepts but silently drops, and so on.
   */
  fail?: (cmd: string) => ShellResult | undefined
  /**
   * Rewrites only the exit code of an otherwise-normal command — the device
   * state still changes. This is how `exitCode: null` (plan 53 §3.4's un-framed
   * shell fallback) is modelled: the command really ran, the status is unknown.
   */
  exitCodeFor?: (cmd: string) => number | null | undefined
  /** Every `exec` rejects outright — an unreachable device. */
  dead?: boolean
}

const GET_RE = /^settings get global (\S+)$/
const PUT_RE = /^settings put global (\S+) '(.*)'$/
const DELETE_RE = /^settings delete global (\S+)$/

/** Reverses `shellQuote`'s `'` → `'\''` escaping. */
function unquote(inner: string): string {
  return inner.split(`'\\''`).join(`'`)
}

function createFakeDevice(opts: FakeDeviceOptions = {}) {
  const values = new Map<string, string>(Object.entries(opts.initial ?? {}))
  const calls: string[] = []

  const transport: Transport = {
    id: 'fake',
    serial: 'fake-serial',
    stableId: 'fake-stable',
    connect: async () => {},
    disconnect: async () => {},
    execOut: async () => new Uint8Array(),
    async exec(cmd: string): Promise<ShellResult> {
      calls.push(cmd)
      if (opts.dead) throw new Error(`device unreachable: ${cmd}`)
      const override = opts.fail?.(cmd)
      if (override) return override

      let result: ShellResult
      const get = GET_RE.exec(cmd)
      const put = PUT_RE.exec(cmd)
      const del = DELETE_RE.exec(cmd)
      if (get) {
        const key = get[1]!
        // A key that was never set prints the literal string `null`, with a trailing newline.
        result = { stdout: values.has(key) ? `${values.get(key)!}\n` : 'null\n', stderr: '', exitCode: 0 }
      } else if (put) {
        values.set(put[1]!, unquote(put[2]!))
        result = { stdout: '', stderr: '', exitCode: 0 }
      } else if (del) {
        values.delete(del[1]!)
        result = { stdout: '', stderr: '', exitCode: 0 }
      } else {
        result = { stdout: '', stderr: `the fake device does not know this command: ${cmd}`, exitCode: 1 }
      }

      const exitCode = opts.exitCodeFor?.(cmd)
      if (exitCode !== undefined) return { ...result, exitCode }
      return result
    },
  }

  return { transport, calls, values }
}

function createCaptureStore(initial: CapturedHttpProxySettings | null = null) {
  let value: CapturedHttpProxySettings | null = initial
  const writes: CapturedHttpProxySettings[] = []
  let readThrows = false
  const store: HttpProxyCaptureStore = {
    read: () => {
      if (readThrows) throw new Error('the route row could not be read')
      return value
    },
    write: (captured) => {
      value = captured
      writes.push(captured)
    },
  }
  return {
    store,
    writes,
    get current() {
      return value
    },
    breakReads() {
      readThrows = true
    },
  }
}

const CONFIG: HttpProxyRouteConfig = { engine: 'adb-proxy', host: '10.0.0.2', port: 8899 }

const getCmd = (key: string) => `settings get global ${key}`
const putCmd = (key: string, value: string) => `settings put global ${key} ${shellQuote(value)}`
const deleteCmd = (key: string) => `settings delete global ${key}`

/** Only the commands that CHANGE the device — the ones whose ordering the plan makes rules about. */
const writesOnly = (calls: string[]) => calls.filter((c) => !c.startsWith('settings get '))

function route(deps: { transport: Transport; capture: HttpProxyCaptureStore }) {
  return createHttpProxyRoute({ transport: deps.transport, deviceId: 'dev-1', capture: deps.capture })
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('normaliseUnset / httpProxyValue / httpProxyExclusionList (plan 114 §3.6)', () => {
  test('Android’s literal string `null` normalises to `""` — one representation of "unset", not two that compare unequal', () => {
    expect(normaliseUnset('null\n')).toBe('')
    expect(normaliseUnset('  null  ')).toBe('')
    expect(normaliseUnset('')).toBe('')
  })

  test('a real value is trimmed but otherwise verbatim — and a value that merely CONTAINS "null" survives', () => {
    expect(normaliseUnset('10.0.0.2:8899\n')).toBe('10.0.0.2:8899')
    expect(normaliseUnset('nullproxy.example:8080\n')).toBe('nullproxy.example:8080')
  })

  test('httpProxyValue is the one definition of the format the setting check compares against', () => {
    expect(httpProxyValue({ host: '10.0.0.2', port: 8899 })).toBe('10.0.0.2:8899')
  })

  test('httpProxyExclusionList joins with commas, and "declared none" is the empty string', () => {
    expect(httpProxyExclusionList({ exclusions: ['a.com', 'b.com'] })).toBe('a.com,b.com')
    expect(httpProxyExclusionList({ exclusions: [] })).toBe('')
    expect(httpProxyExclusionList({})).toBe('')
  })
})

describe('readHttpProxySettings (plan 114 §3.6)', () => {
  test('reads the four keys in order and normalises every unset one to ""', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128', [HTTP_PROXY_HOST_KEY]: '10.9.9.9' } })
    expect(await readHttpProxySettings(device.transport)).toEqual({
      httpProxy: '10.9.9.9:3128',
      host: '10.9.9.9',
      port: '',
      exclusionList: '',
    })
    expect(device.calls).toEqual([
      getCmd(HTTP_PROXY_KEY),
      getCmd(HTTP_PROXY_HOST_KEY),
      getCmd(HTTP_PROXY_PORT_KEY),
      getCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
    ])
  })

  test('a failed read is E_SETTING_READ_FAILED, NEVER swallowed into "" — an unreachable device must not look pristine', async () => {
    const device = createFakeDevice({
      fail: (cmd) => (cmd === getCmd(HTTP_PROXY_KEY) ? { stdout: '', stderr: 'error: device offline', exitCode: 1 } : undefined),
    })
    const err = await readHttpProxySettings(device.transport).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpProxyError)
    expect((err as HttpProxyError).code).toBe('E_SETTING_READ_FAILED')
  })

  test('exitCode: null is NOT a failure — it is the un-framed shell fallback and means "unknown", not "non-zero"', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' }, exitCodeFor: () => null })
    expect((await readHttpProxySettings(device.transport)).httpProxy).toBe('10.9.9.9:3128')
  })
})

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

describe('createHttpProxyRoute().apply — the capture (plan 114 §3.6 rule 1)', () => {
  test('a pristine device is captured as four EMPTY strings, never the literal "null"', async () => {
    const device = createFakeDevice()
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)

    expect(capture.writes).toHaveLength(1)
    const written = capture.writes[0]!
    expect(written.httpProxy).toBe('')
    expect(written.host).toBe('')
    expect(written.port).toBe('')
    expect(written.exclusionList).toBe('')
    expect(JSON.stringify(written)).not.toContain('null')
    expect(typeof written.at).toBe('number')
  })

  test('an operator’s own pre-existing proxy is captured verbatim', async () => {
    const device = createFakeDevice({
      initial: {
        [HTTP_PROXY_KEY]: '10.9.9.9:3128',
        [HTTP_PROXY_HOST_KEY]: '10.9.9.9',
        [HTTP_PROXY_PORT_KEY]: '3128',
        [HTTP_PROXY_EXCLUSION_LIST_KEY]: 'localhost,127.0.0.1',
      },
    })
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)
    expect(capture.writes[0]).toMatchObject({
      httpProxy: '10.9.9.9:3128',
      host: '10.9.9.9',
      port: '3128',
      exclusionList: 'localhost,127.0.0.1',
    })
  })

  test('CAPTURE-ONCE: a second apply with a DIFFERENT host does not write the capture again', async () => {
    // The failure this prevents: the second apply would record the FARM's own value as "the
    // original", and the device's real prior state would be gone for good.
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' } })
    const capture = createCaptureStore()
    const engine = route({ transport: device.transport, capture: capture.store })

    await engine.apply(CONFIG)
    await engine.apply({ engine: 'adb-proxy', host: '172.16.0.5', port: 3128 })

    expect(capture.writes).toHaveLength(1)
    expect(capture.current?.httpProxy).toBe('10.9.9.9:3128')
  })

  test('the capture is taken BEFORE any write — the first four commands are reads', async () => {
    const device = createFakeDevice()
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)
    expect(device.calls.slice(0, 4)).toEqual([
      getCmd(HTTP_PROXY_KEY),
      getCmd(HTTP_PROXY_HOST_KEY),
      getCmd(HTTP_PROXY_PORT_KEY),
      getCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
    ])
  })

  test('THE FALSE-PRISTINE GUARD: a failing `settings get` throws E_SETTING_READ_FAILED with no `settings put` issued and NO capture written', async () => {
    // This is the case that would silently destroy an operator's own proxy months later: if the
    // read failure were swallowed into `''`, the capture would record a pristine device, and the
    // eventual revert would faithfully "restore" nothing over a real proxy setting.
    const device = createFakeDevice({
      initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' },
      fail: (cmd) => (cmd === getCmd(HTTP_PROXY_KEY) ? { stdout: '', stderr: 'error: device offline', exitCode: 1 } : undefined),
    })
    const capture = createCaptureStore()

    const err = await route({ transport: device.transport, capture: capture.store })
      .apply(CONFIG)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HttpProxyError)
    expect((err as HttpProxyError).code).toBe('E_SETTING_READ_FAILED')
    expect(capture.writes).toHaveLength(0)
    expect(capture.current).toBeNull()
    expect(device.calls.filter((c) => c.startsWith('settings put '))).toEqual([])
    expect(writesOnly(device.calls)).toEqual([])
  })

  test('a capture store whose READ throws aborts the apply before any write — the same false-pristine family as a failed `settings get`', async () => {
    // The engine deliberately does not catch this: if the row cannot be read, "has this device been
    // captured yet" is unanswerable, and writing anyway would either overwrite a real capture on the
    // next successful read or record the farm's own value as the original.
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' } })
    const capture = createCaptureStore({ httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 })
    capture.breakReads()

    await expect(route({ transport: device.transport, capture: capture.store }).apply(CONFIG)).rejects.toThrow()
    expect(writesOnly(device.calls)).toEqual([])
    expect(device.values.get(HTTP_PROXY_KEY)).toBe('10.9.9.9:3128')
  })

  test('an existing capture is honoured without re-reading the device for it', async () => {
    const existing: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '10.9.9.9', port: '3128', exclusionList: '', at: 5 }
    const device = createFakeDevice()
    const capture = createCaptureStore(existing)
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)
    expect(capture.writes).toHaveLength(0)
    // Only the post-write read-back happened, not a second capture read.
    expect(device.calls.filter((c) => c.startsWith('settings get ')).length).toBe(4)
  })
})

describe('createHttpProxyRoute().apply — write, read back, compare (plan 114 §3.6 rule 2, criterion 5)', () => {
  test('a clean apply leaves the four keys as written', async () => {
    const device = createFakeDevice()
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply({ ...CONFIG, exclusions: ['a.com', 'b.com'] })
    expect(device.values.get(HTTP_PROXY_KEY)).toBe('10.0.0.2:8899')
    expect(device.values.get(HTTP_PROXY_EXCLUSION_LIST_KEY)).toBe('a.com,b.com')
  })

  test('a read-back MISMATCH is E_SETTING_NOT_ACCEPTED, carrying .expected and .observed', async () => {
    // The device accepts the write (exit 0) and quietly keeps its old value — precisely the case
    // that must never be reported as applied.
    const device = createFakeDevice({
      initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' },
      fail: (cmd) => (cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: '', exitCode: 0 } : undefined),
    })
    const capture = createCaptureStore()
    const err = await route({ transport: device.transport, capture: capture.store })
      .apply(CONFIG)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HttpProxyError)
    expect((err as HttpProxyError).code).toBe('E_SETTING_NOT_ACCEPTED')
    expect((err as HttpProxyError).expected).toBe('10.0.0.2:8899')
    expect((err as HttpProxyError).observed).toBe('10.9.9.9:3128')
    expect((err as HttpProxyError).message).toContain('10.9.9.9:3128')
  })

  test('an exclusion-list mismatch is E_SETTING_NOT_ACCEPTED too', async () => {
    const device = createFakeDevice({
      fail: (cmd) =>
        cmd.startsWith(`settings put global ${HTTP_PROXY_EXCLUSION_LIST_KEY} `) ? { stdout: '', stderr: '', exitCode: 0 } : undefined,
    })
    const capture = createCaptureStore()
    const err = await route({ transport: device.transport, capture: capture.store })
      .apply({ ...CONFIG, exclusions: ['a.com'] })
      .catch((e: unknown) => e)
    expect((err as HttpProxyError).code).toBe('E_SETTING_NOT_ACCEPTED')
    expect((err as HttpProxyError).expected).toBe('a.com')
    expect((err as HttpProxyError).observed).toBe('')
  })

  test('a KNOWN non-zero exit on a put is E_SETTING_WRITE_FAILED — a different code from a declined value', async () => {
    const device = createFakeDevice({
      fail: (cmd) =>
        cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: 'Permission denial', exitCode: 255 } : undefined,
    })
    const capture = createCaptureStore()
    const err = await route({ transport: device.transport, capture: capture.store })
      .apply(CONFIG)
      .catch((e: unknown) => e)
    expect((err as HttpProxyError).code).toBe('E_SETTING_WRITE_FAILED')
    expect((err as HttpProxyError).message).toContain('255')
  })

  test('exitCode: null on a put is NOT a failure — the read-back is what decides', async () => {
    // The un-framed shell fallback (plan 53 §3.4) means the exit status is genuinely unknown on
    // this device. Treating it as failure would fail every apply on such a build even though the
    // device took the value; treating it as success would claim one it did not. The read-back is
    // the tiebreak, and it says the write landed.
    const device = createFakeDevice({ exitCodeFor: () => null })
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)
    expect(device.values.get(HTTP_PROXY_KEY)).toBe('10.0.0.2:8899')
  })

  test('exitCode: null on a put whose value the device then DECLINES still fails — as E_SETTING_NOT_ACCEPTED, not as a write failure', async () => {
    const device = createFakeDevice({
      initial: { [HTTP_PROXY_KEY]: '10.9.9.9:3128' },
      fail: (cmd) => (cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: '', exitCode: null } : undefined),
    })
    const capture = createCaptureStore()
    const err = await route({ transport: device.transport, capture: capture.store })
      .apply(CONFIG)
      .catch((e: unknown) => e)
    expect((err as HttpProxyError).code).toBe('E_SETTING_NOT_ACCEPTED')
  })

  test('the DERIVED split keys disagreeing is logged, never thrown — the composite is the key this engine wrote', async () => {
    const logs: string[] = []
    const device = createFakeDevice()
    const capture = createCaptureStore()
    const engine = createHttpProxyRoute({
      transport: device.transport,
      deviceId: 'dev-1',
      capture: capture.store,
      onLog: (_level, msg) => logs.push(msg),
    })
    // The fake never populates `global_http_proxy_host`/`_port` from a composite write, which is
    // exactly the "a build that populates them lazily, or not at all" case.
    await engine.apply(CONFIG)
    expect(logs.some((l) => l.includes('derived keys disagree'))).toBe(true)
  })
})

describe('createHttpProxyRoute().apply — ordering and the exclusion list (plan 114 §3.6)', () => {
  test('the exclusion list is written BEFORE http_proxy, and http_proxy is the LAST write', async () => {
    const device = createFakeDevice()
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply({ ...CONFIG, exclusions: ['a.com'] })

    const writes = writesOnly(device.calls)
    expect(writes).toEqual([putCmd(HTTP_PROXY_EXCLUSION_LIST_KEY, 'a.com'), putCmd(HTTP_PROXY_KEY, '10.0.0.2:8899')])
    expect(writes[writes.length - 1]).toBe(putCmd(HTTP_PROXY_KEY, '10.0.0.2:8899'))
  })

  test('an EMPTY exclusions array deletes the key — it never writes an empty string', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_EXCLUSION_LIST_KEY]: 'stale.example' } })
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply({ ...CONFIG, exclusions: [] })

    const writes = writesOnly(device.calls)
    expect(writes).toEqual([deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY), putCmd(HTTP_PROXY_KEY, '10.0.0.2:8899')])
    expect(writes.some((c) => c === putCmd(HTTP_PROXY_EXCLUSION_LIST_KEY, ''))).toBe(false)
    // A stale list the operator removed from the config is genuinely gone, not left in force.
    expect(device.values.has(HTTP_PROXY_EXCLUSION_LIST_KEY)).toBe(false)
  })

  test('ABSENT exclusions behave identically to an empty array', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_EXCLUSION_LIST_KEY]: 'stale.example' } })
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply(CONFIG)
    expect(writesOnly(device.calls)).toEqual([deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY), putCmd(HTTP_PROXY_KEY, '10.0.0.2:8899')])
  })
})

// ---------------------------------------------------------------------------
// revert()
// ---------------------------------------------------------------------------

describe('createHttpProxyRoute().revert — WITH a capture (plan 114 §3.6 rule 3, criterion 6)', () => {
  test('the captured strings are re-issued verbatim, and http_proxy is written LAST', async () => {
    const captured: CapturedHttpProxySettings = {
      httpProxy: '10.9.9.9:3128',
      host: '10.9.9.9',
      port: '3128',
      exclusionList: 'localhost',
      at: 5,
    }
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.0.0.2:8899' } })
    const capture = createCaptureStore(captured)
    await route({ transport: device.transport, capture: capture.store }).revert()

    expect(writesOnly(device.calls)).toEqual([
      putCmd(HTTP_PROXY_HOST_KEY, '10.9.9.9'),
      putCmd(HTTP_PROXY_PORT_KEY, '3128'),
      putCmd(HTTP_PROXY_EXCLUSION_LIST_KEY, 'localhost'),
      putCmd(HTTP_PROXY_KEY, '10.9.9.9:3128'),
    ])
    expect(device.values.get(HTTP_PROXY_KEY)).toBe('10.9.9.9:3128')
  })

  test('a captured "" becomes a DELETE, never `put ""` — an unset key and a key holding the empty string are different device states', async () => {
    const captured: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 }
    const device = createFakeDevice()
    const capture = createCaptureStore(captured)
    await route({ transport: device.transport, capture: capture.store }).revert()

    const writes = writesOnly(device.calls)
    expect(writes).toEqual([
      deleteCmd(HTTP_PROXY_HOST_KEY),
      deleteCmd(HTTP_PROXY_PORT_KEY),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, '10.9.9.9:3128'),
    ])
    expect(writes.some((c) => c.endsWith(` ''`))).toBe(false)
  })

  test('a PRISTINE capture (all four empty) writes `:0` FIRST and then deletes, in that order', async () => {
    // `:0` is what the framework notices; the delete is what leaves the row genuinely absent, so a
    // phone that was never proxied comes back reading `null` rather than the literal `:0` plan
    // 33 §5's original prescription left behind.
    const captured: CapturedHttpProxySettings = { httpProxy: '', host: '', port: '', exclusionList: '', at: 5 }
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.0.0.2:8899' } })
    const capture = createCaptureStore(captured)
    await route({ transport: device.transport, capture: capture.store }).revert()

    const writes = writesOnly(device.calls)
    expect(writes).toEqual([
      deleteCmd(HTTP_PROXY_HOST_KEY),
      deleteCmd(HTTP_PROXY_PORT_KEY),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE),
      deleteCmd(HTTP_PROXY_KEY),
    ])
    expect(writes.indexOf(putCmd(HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE))).toBeLessThan(writes.indexOf(deleteCmd(HTTP_PROXY_KEY)))
    expect(device.values.has(HTTP_PROXY_KEY)).toBe(false)
  })

  test('restoring to a value the device then refuses is logged, never thrown — revert may not throw', async () => {
    const logs: string[] = []
    const captured: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 }
    const device = createFakeDevice({
      fail: (cmd) => (cmd.startsWith(`settings put global ${HTTP_PROXY_KEY} `) ? { stdout: '', stderr: '', exitCode: 0 } : undefined),
    })
    const capture = createCaptureStore(captured)
    const engine = createHttpProxyRoute({
      transport: device.transport,
      deviceId: 'dev-1',
      capture: capture.store,
      onLog: (_level, msg) => logs.push(msg),
    })
    await engine.revert()
    expect(logs.some((l) => l.includes('did not take the restore'))).toBe(true)
  })
})

describe('createHttpProxyRoute().revert — WITHOUT a capture (plan 114 §3.6 rule 4)', () => {
  test('nothing captured → the CLEAR path: the four keys go to Android’s default', async () => {
    const device = createFakeDevice({
      initial: {
        [HTTP_PROXY_KEY]: '10.0.0.2:8899',
        [HTTP_PROXY_HOST_KEY]: '10.0.0.2',
        [HTTP_PROXY_PORT_KEY]: '8899',
        [HTTP_PROXY_EXCLUSION_LIST_KEY]: 'a.com',
      },
    })
    const capture = createCaptureStore(null)
    await route({ transport: device.transport, capture: capture.store }).revert()

    expect(writesOnly(device.calls)).toEqual([
      deleteCmd(HTTP_PROXY_HOST_KEY),
      deleteCmd(HTTP_PROXY_PORT_KEY),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE),
      deleteCmd(HTTP_PROXY_KEY),
    ])
    expect(device.values.size).toBe(0)
  })

  test('a capture.read() that THROWS takes the same clear path, and revert still does not throw', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.0.0.2:8899' } })
    const capture = createCaptureStore({ httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 })
    capture.breakReads()

    await route({ transport: device.transport, capture: capture.store }).revert()
    expect(writesOnly(device.calls)).toEqual([
      deleteCmd(HTTP_PROXY_HOST_KEY),
      deleteCmd(HTTP_PROXY_PORT_KEY),
      deleteCmd(HTTP_PROXY_EXCLUSION_LIST_KEY),
      putCmd(HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE),
      deleteCmd(HTTP_PROXY_KEY),
    ])
  })

  test('a capture.read() that throws is logged at warn — a lossy outcome is not swallowed silently', async () => {
    const logs: Array<{ level: string; msg: string }> = []
    const device = createFakeDevice()
    const capture = createCaptureStore({ httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 })
    capture.breakReads()
    const engine = createHttpProxyRoute({
      transport: device.transport,
      deviceId: 'dev-1',
      capture: capture.store,
      onLog: (level, msg) => logs.push({ level, msg }),
    })
    await engine.revert()
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('reading the capture failed'))).toBe(true)
  })
})

describe('createHttpProxyRoute().revert — idempotence and unreachability (plan 114 §3.6 rule 3)', () => {
  test('DOUBLE REVERT is a no-op the second time, never throws, and THE CAPTURE IS STILL PRESENT afterwards', async () => {
    // If revert cleared the capture, the second revert would fall into the "nothing was captured"
    // path and CLEAR a proxy it was supposed to restore. That is the whole reason revert leaves
    // the row alone.
    const captured: CapturedHttpProxySettings = { httpProxy: '10.9.9.9:3128', host: '10.9.9.9', port: '3128', exclusionList: '', at: 5 }
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '10.0.0.2:8899' } })
    const capture = createCaptureStore(captured)
    const engine = route({ transport: device.transport, capture: capture.store })

    await engine.revert()
    const firstWrites = writesOnly(device.calls).slice()
    device.calls.length = 0

    await engine.revert()
    expect(writesOnly(device.calls)).toEqual(firstWrites)
    expect(capture.current).toEqual(captured)
    expect(device.values.get(HTTP_PROXY_KEY)).toBe('10.9.9.9:3128')
  })

  test('revert NEVER throws when every exec rejects — a device that cannot be reached is not a reason to throw out of a teardown', async () => {
    const device = createFakeDevice({ dead: true })
    const capture = createCaptureStore({ httpProxy: '10.9.9.9:3128', host: '', port: '', exclusionList: '', at: 5 })
    await expect(route({ transport: device.transport, capture: capture.store }).revert()).resolves.toBeUndefined()
    // It still TRIED — silence would mean the teardown never ran at all.
    expect(device.calls.length).toBeGreaterThan(0)
  })

  test('revert never throws on the clear path either, when every exec rejects', async () => {
    const device = createFakeDevice({ dead: true })
    const capture = createCaptureStore(null)
    await expect(route({ transport: device.transport, capture: capture.store }).revert()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The descriptor surface and observe()
// ---------------------------------------------------------------------------

describe('createHttpProxyRoute() — what the engine advertises (plan 114 §3.2, §3.5)', () => {
  test('id is "adb-proxy"', () => {
    const device = createFakeDevice()
    expect(route({ transport: device.transport, capture: createCaptureStore().store }).id).toBe('adb-proxy')
  })

  test('every capability is false — advertising one the engine does not have is what the schema exists to prevent', () => {
    const device = createFakeDevice()
    expect(route({ transport: device.transport, capture: createCaptureStore().store }).capabilities).toEqual({
      auth: false,
      enforcing: false,
      udp: false,
      probe: false,
    })
  })

  test('probe and hold are ABSENT, not stubs — a caller discovers an engine’s reach instead of assuming it', () => {
    const device = createFakeDevice()
    const engine = route({ transport: device.transport, capture: createCaptureStore().store })
    expect('probe' in engine).toBe(false)
    expect('hold' in engine).toBe(false)
    expect(engine.probe).toBeUndefined()
    expect(engine.hold).toBeUndefined()
  })
})

describe('createHttpProxyRoute().observe (plan 114 §3.5)', () => {
  test('an unset http_proxy reads as DOWN, with no upstream claimed', async () => {
    const device = createFakeDevice()
    const observed = await route({ transport: device.transport, capture: createCaptureStore().store }).observe()
    expect(observed).toEqual({ prepared: true, up: false, state: 'down' })
    expect(observed).not.toHaveProperty('upstream')
  })

  test('the literal `:0` reads as DOWN — Android’s "no proxy" value, and plan 33 §5’s residue', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: HTTP_PROXY_RESET_VALUE } })
    expect(await route({ transport: device.transport, capture: createCaptureStore().store }).observe()).toEqual({
      prepared: true,
      up: false,
      state: 'down',
    })
  })

  test('a real value reads as UP, carrying the upstream the DEVICE reports', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '1.2.3.4:8899' } })
    expect(await route({ transport: device.transport, capture: createCaptureStore().store }).observe()).toEqual({
      prepared: true,
      up: true,
      state: 'up',
      upstream: '1.2.3.4:8899',
    })
  })

  test('a value the device pads with whitespace is trimmed, not treated as a different string', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '  1.2.3.4:8899  ' } })
    expect(await route({ transport: device.transport, capture: createCaptureStore().store }).observe()).toEqual({
      prepared: true,
      up: true,
      state: 'up',
      upstream: '1.2.3.4:8899',
    })
  })

  test('prepared is always true — this engine needs no VPN consent, and that is not a claim anything was verified', async () => {
    const device = createFakeDevice({ initial: { [HTTP_PROXY_KEY]: '1.2.3.4:8899' } })
    expect((await route({ transport: device.transport, capture: createCaptureStore().store }).observe()).prepared).toBe(true)
  })

  test('a read failure PROPAGATES rather than being papered over with a confident `false`', async () => {
    const device = createFakeDevice({ fail: () => ({ stdout: '', stderr: 'error: device offline', exitCode: 1 }) })
    const err = await route({ transport: device.transport, capture: createCaptureStore().store })
      .observe()
      .catch((e: unknown) => e)
    expect((err as HttpProxyError).code).toBe('E_SETTING_READ_FAILED')
  })
})

// ---------------------------------------------------------------------------
// Shell injection
// ---------------------------------------------------------------------------

describe('shellQuote — a host cannot escape into a second command (plan 114 §4.2)', () => {
  /**
   * Every value this engine writes goes through `shellQuote`, so the assertion
   * below is structural rather than a blocklist: the argument must be ONE
   * single-quoted POSIX word, and the only `'` inside it must be part of the
   * `'\''` escape sequence. A value satisfying that cannot contain a command
   * separator the shell will act on, whatever it contains.
   */
  function assertSingleQuotedWord(cmd: string, key: string) {
    const prefix = `settings put global ${key} `
    expect(cmd.startsWith(prefix)).toBe(true)
    const arg = cmd.slice(prefix.length)
    expect(arg.startsWith(`'`)).toBe(true)
    expect(arg.endsWith(`'`)).toBe(true)
    // Split on the escape sequence; no remaining fragment may contain a bare quote, which is what
    // would end the quoting and let the rest of the value be interpreted.
    for (const fragment of arg.slice(1, -1).split(`'\\''`)) {
      expect(fragment).not.toContain(`'`)
    }
  }

  const hostile = [
    `evil;reboot`,
    `evil$(id)`,
    `evil\`id\``,
    `evil && rm -rf /`,
    `evil' ; reboot ; '`,
    `evil'\\''; reboot`,
    `evil|nc 10.0.0.1 4444`,
  ]

  for (const host of hostile) {
    test(`a host containing ${JSON.stringify(host)} stays inside one quoted word`, async () => {
      const device = createFakeDevice()
      const capture = createCaptureStore()
      // The write lands and the read-back agrees, so the value really did survive quoting intact —
      // proving the quoting is not merely mangling the input into safety.
      await route({ transport: device.transport, capture: capture.store }).apply({ engine: 'adb-proxy', host, port: 8080 })
      const put = device.calls.find((c) => c.startsWith(`settings put global ${HTTP_PROXY_KEY} `))!
      assertSingleQuotedWord(put, HTTP_PROXY_KEY)
      expect(device.values.get(HTTP_PROXY_KEY)).toBe(`${host}:8080`)
    })
  }

  test('an exclusion entry is quoted the same way', async () => {
    const device = createFakeDevice()
    const capture = createCaptureStore()
    await route({ transport: device.transport, capture: capture.store }).apply({
      ...CONFIG,
      exclusions: [`a.com`, `b.com; reboot`],
    })
    const put = device.calls.find((c) => c.startsWith(`settings put global ${HTTP_PROXY_EXCLUSION_LIST_KEY} `))!
    assertSingleQuotedWord(put, HTTP_PROXY_EXCLUSION_LIST_KEY)
  })

  test('a captured value is re-quoted on restore too, not re-issued raw', async () => {
    const captured: CapturedHttpProxySettings = { httpProxy: `x'; reboot`, host: '', port: '', exclusionList: '', at: 5 }
    const device = createFakeDevice()
    const capture = createCaptureStore(captured)
    await route({ transport: device.transport, capture: capture.store }).revert()
    const put = device.calls.find((c) => c.startsWith(`settings put global ${HTTP_PROXY_KEY} `))!
    assertSingleQuotedWord(put, HTTP_PROXY_KEY)
  })
})
