import { describe, expect, test } from 'bun:test'
import { DEFAULT_DEVICE_PORT_RANGE, addReverse, createReverseRegistry, parseDevicePortRange, parseReverseList, removeReverse, type ReverseRegistryDeps } from './reverse-registry'

/**
 * Plan 114 step 114.4 — `adb reverse`, and the one map that survives a replug.
 *
 * Everything here runs against a fake `hostAdb` that records its argv, because
 * the argv IS the contract: `adb reverse tcp:<device> tcp:<host>` puts the
 * PHONE's port first, and a parser or a wrapper that gets that order backwards
 * fails silently — the reverse binds, nothing matches, and the phone points at
 * a port that answers nothing. No device is touched by any test in this file.
 */

interface FakeAdb {
  hostAdb: (args: string[]) => Promise<string>
  calls: string[][]
  /** Argv predicates that should reject, in the order they are consulted. */
  fail: (args: string[]) => boolean
  listing: string
}

function fakeAdb(opts: { fail?: (args: string[]) => boolean; listing?: string } = {}): FakeAdb {
  const calls: string[][] = []
  const state: FakeAdb = {
    calls,
    fail: opts.fail ?? (() => false),
    listing: opts.listing ?? '',
    hostAdb: async (args: string[]) => {
      calls.push([...args])
      if (state.fail(args)) throw new Error(`adb: ${args.join(' ')} failed`)
      return args.includes('--list') ? state.listing : ''
    },
  }
  return state
}

function makeRegistry(adb: FakeAdb, overrides: Partial<ReverseRegistryDeps> = {}) {
  return createReverseRegistry({
    hostAdb: adb.hostAdb,
    serialOf: (deviceId) => (deviceId === 'dev-1' ? 'SER-1' : null),
    range: { rangeStart: 28100, rangeEnd: 28299 },
    ...overrides,
  })
}

describe('the two adb wrappers (plan 114 §4.3, F9)', () => {
  test('addReverse puts the DEVICE port first and this machine’s second', async () => {
    const adb = fakeAdb()
    await addReverse(adb.hostAdb, 'SER-1', 28100, 9902)
    expect(adb.calls).toEqual([['-s', 'SER-1', 'reverse', 'tcp:28100', 'tcp:9902']])
  })

  test('removeReverse is scoped to one pair with --remove, and never --remove-all', async () => {
    const adb = fakeAdb()
    await removeReverse(adb.hostAdb, 'SER-1', 28100)
    expect(adb.calls).toEqual([['-s', 'SER-1', 'reverse', '--remove', 'tcp:28100']])
    expect(JSON.stringify(adb.calls)).not.toContain('--remove-all')
  })
})

describe('parseReverseList — the measured shape, not the assumed one', () => {
  test('the three-field transport-prefixed form measured on the reference device', () => {
    expect(parseReverseList('UsbFfs tcp:46999 tcp:45999')).toEqual([{ transport: 'UsbFfs', devicePort: 46999, hostPort: 45999 }])
  })

  test('the bare two-field form is accepted too — the prefix is an adb detail nobody promised us', () => {
    expect(parseReverseList('tcp:28100 tcp:9902')).toEqual([{ transport: '', devicePort: 28100, hostPort: 9902 }])
  })

  test('junk, blank lines and non-tcp specs are dropped rather than guessed at', () => {
    const raw = ['', '   ', 'List of devices attached', 'UsbFfs localabstract:scrcpy tcp:9902', 'UsbFfs tcp:notaport tcp:9902', 'UsbFfs tcp:28100 tcp:9902', 'garbage'].join('\n')
    expect(parseReverseList(raw)).toEqual([{ transport: 'UsbFfs', devicePort: 28100, hostPort: 9902 }])
  })
})

describe('parseDevicePortRange — a local parser, so a malformed value can never yield the HOST range', () => {
  test('a valid range is taken verbatim', () => {
    expect(parseDevicePortRange('30000-30010')).toEqual({ rangeStart: 30000, rangeEnd: 30010 })
  })

  test('absent falls back to the device range', () => {
    expect(parseDevicePortRange(undefined)).toEqual({ ...DEFAULT_DEVICE_PORT_RANGE })
    expect(parseDevicePortRange('')).toEqual({ ...DEFAULT_DEVICE_PORT_RANGE })
  })

  /**
   * The whole reason this parser exists rather than `@enkaku/session`'s
   * `parsePortRange`: that one falls back to 27100–27299, which is the HOST
   * range for `adb forward`. Handing those out as DEVICE ports is the silent,
   * intermittent collision this guards against.
   */
  test('malformed and inverted values fall back to the DEVICE range and never to 27100–27299', () => {
    for (const raw of ['nonsense', '28100', '28100-', '-28299', '28299-28100', '0-70000', '28100..28299']) {
      const parsed = parseDevicePortRange(raw)
      expect(parsed, raw).toEqual({ ...DEFAULT_DEVICE_PORT_RANGE })
      expect(parsed.rangeStart, raw).not.toBe(27100)
      expect(parsed.rangeEnd, raw).not.toBe(27299)
    }
    expect(DEFAULT_DEVICE_PORT_RANGE).toEqual({ rangeStart: 28100, rangeEnd: 28299 })
  })
})

describe('establish — the first allocation walks, a pinned port never does', () => {
  test('a first establish takes rangeStart and records the entry', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    const entry = await registry.establish('dev-1', { hostPort: 9902 })
    expect(entry.devicePort).toBe(28100)
    expect(entry.hostPort).toBe(9902)
    expect(entry.establishedAt).not.toBeNull()
    expect(adb.calls).toEqual([['-s', 'SER-1', 'reverse', 'tcp:28100', 'tcp:9902']])
    expect(registry.get('dev-1')?.devicePort).toBe(28100)
    expect(registry.list()).toHaveLength(1)
  })

  test('two rejected ports walk to the third — a failing adb reverse is the only device-side collision signal there is', async () => {
    const adb = fakeAdb({ fail: (args) => args.includes('tcp:28100') || args.includes('tcp:28101') })
    const registry = makeRegistry(adb)
    const entry = await registry.establish('dev-1', { hostPort: 9902 })
    expect(entry.devicePort).toBe(28102)
    expect(adb.calls.map((c) => c[3])).toEqual(['tcp:28100', 'tcp:28101', 'tcp:28102'])
  })

  test('every port rejecting throws E_REVERSE_FAILED naming what was tried, bounded by MAX_PORT_ATTEMPTS', async () => {
    const adb = fakeAdb({ fail: () => true })
    const registry = makeRegistry(adb)
    await expect(registry.establish('dev-1', { hostPort: 9902 })).rejects.toMatchObject({ code: 'E_REVERSE_FAILED' })
    // Bounded at 8 attempts even though the range is 200 wide.
    expect(adb.calls).toHaveLength(8)
    const err = await registry.establish('dev-1', { hostPort: 9902 }).catch((e: Error) => e)
    expect((err as Error).message).toContain('28100')
    expect((err as Error).message).toContain('28107')
    expect(registry.get('dev-1')).toBeNull()
  })

  test('an explicit devicePort is used exactly and never walks — the phone’s own setting names that number', async () => {
    const adb = fakeAdb({ fail: (args) => args.includes('tcp:28150') })
    const registry = makeRegistry(adb)
    await expect(registry.establish('dev-1', { hostPort: 9902, devicePort: 28150 })).rejects.toMatchObject({ code: 'E_REVERSE_FAILED' })
    expect(adb.calls).toHaveLength(1)
    expect(adb.calls[0]?.[3]).toBe('tcp:28150')
    // The entry stays, marked NOT live, so the `reverse` check can report it.
    expect(registry.get('dev-1')).toMatchObject({ devicePort: 28150, establishedAt: null })
  })

  test('a second establish reuses the stored device port while re-pointing the host side', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    const again = await registry.establish('dev-1', { hostPort: 9999 })
    expect(again.devicePort).toBe(28100)
    expect(again.hostPort).toBe(9999)
    expect(adb.calls[1]).toEqual(['-s', 'SER-1', 'reverse', 'tcp:28100', 'tcp:9999'])
  })

  test('a device with no adb address at all is device_not_found, before any adb call', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await expect(registry.establish('ghost', { hostPort: 9902 })).rejects.toMatchObject({ code: 'device_not_found' })
    expect(adb.calls).toHaveLength(0)
  })
})

describe('handleDeviceOnline — H3’s insurance', () => {
  test('re-issues on the SAME device port after a replug', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    registry.handleDeviceOffline('dev-1')
    await registry.handleDeviceOnline('dev-1')
    expect(adb.calls).toHaveLength(2)
    expect(adb.calls[1]).toEqual(['-s', 'SER-1', 'reverse', 'tcp:28100', 'tcp:9902'])
    expect(registry.get('dev-1')?.establishedAt).not.toBeNull()
  })

  test('a device with no entry makes ZERO adb calls — the common case by a wide margin', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.handleDeviceOnline('dev-1')
    expect(adb.calls).toHaveLength(0)
  })

  /**
   * The measured incident behind the second half of this: a phone came back
   * with `adb reverse tcp:28100 tcp:9905` live and its traffic going out
   * through a metered residential proxy, while the farm's own record said the
   * route was gone. Not re-establishing is only half an answer — an entry that
   * outlived its record is an orphan, and this map is bookkeeping, never the
   * authority. So the veto TEARS IT DOWN.
   */
  test('a route the operator disabled while the phone was away does not come back just because the phone did — and the orphan is removed, not left sitting', async () => {
    const adb = fakeAdb()
    let enabled = true
    const registry = makeRegistry(adb, { routeEnabled: () => enabled })
    await registry.establish('dev-1', { hostPort: 9902 })
    enabled = false
    adb.calls.length = 0
    await registry.handleDeviceOnline('dev-1')
    // Never re-established…
    expect(adb.calls.some((c) => c.includes('tcp:28100') && !c.includes('--remove'))).toBe(false)
    // …and taken back off the phone, so a later pass cannot find it and re-decide.
    expect(adb.calls).toEqual([['-s', 'SER-1', 'reverse', '--remove', 'tcp:28100']])
    expect(registry.get('dev-1')).toBeNull()
  })

  test('the orphan release is tolerated when the phone cannot be reached — the entry goes either way', async () => {
    const adb = fakeAdb()
    let enabled = true
    const registry = makeRegistry(adb, { routeEnabled: () => enabled })
    await registry.establish('dev-1', { hostPort: 9902 })
    enabled = false
    adb.fail = () => true
    await registry.handleDeviceOnline('dev-1')
    expect(registry.get('dev-1')).toBeNull()
  })

  test('a phone that comes back on a different adb address is re-resolved, and the entry updates', async () => {
    const adb = fakeAdb()
    let serial = 'SER-1'
    const registry = makeRegistry(adb, { serialOf: () => serial })
    await registry.establish('dev-1', { hostPort: 9902 })
    serial = '192.168.1.20:5555'
    await registry.handleDeviceOnline('dev-1')
    expect(adb.calls[1]?.[1]).toBe('192.168.1.20:5555')
    expect(registry.get('dev-1')?.serial).toBe('192.168.1.20:5555')
  })

  test('a failing re-issue rejects AND leaves establishedAt null on the same port — a dead reverse must be visible', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    adb.fail = () => true
    await expect(registry.handleDeviceOnline('dev-1')).rejects.toMatchObject({ code: 'E_REVERSE_FAILED' })
    expect(registry.get('dev-1')).toMatchObject({ devicePort: 28100, hostPort: 9902, establishedAt: null })
  })
})

describe('handleDeviceOffline / release', () => {
  test('offline clears establishedAt, keeps the entry, and touches no device', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    adb.calls.length = 0
    registry.handleDeviceOffline('dev-1')
    expect(registry.get('dev-1')).toMatchObject({ devicePort: 28100, establishedAt: null })
    expect(adb.calls).toHaveLength(0)
  })

  test('release removes the pair and drops the entry', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    await registry.release('dev-1')
    expect(adb.calls[1]).toEqual(['-s', 'SER-1', 'reverse', '--remove', 'tcp:28100'])
    expect(registry.get('dev-1')).toBeNull()
  })

  test('a device whose remove throws does not throw out of release, and the entry is dropped anyway', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    adb.fail = () => true
    await registry.release('dev-1')
    expect(registry.get('dev-1')).toBeNull()
  })

  test('releasing twice is a no-op, and an unknown device makes no call at all', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    await registry.release('dev-1')
    adb.calls.length = 0
    await registry.release('dev-1')
    await registry.release('ghost')
    expect(adb.calls).toHaveLength(0)
  })
})

describe('verify — asked of the adb server itself', () => {
  test('true only on an exact (device, host) pair match', async () => {
    const adb = fakeAdb({ listing: 'UsbFfs tcp:28100 tcp:9902' })
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    expect(await registry.verify('dev-1')).toBe(true)
    expect(adb.calls[1]).toEqual(['-s', 'SER-1', 'reverse', '--list'])
  })

  test('false on a partial match — the same device port pointed at a different host port is not this reverse', async () => {
    const adb = fakeAdb({ listing: 'UsbFfs tcp:28100 tcp:9999' })
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    expect(await registry.verify('dev-1')).toBe(false)
  })

  test('false for a device with no entry, without asking adb anything', async () => {
    const adb = fakeAdb({ listing: 'UsbFfs tcp:28100 tcp:9902' })
    const registry = makeRegistry(adb)
    expect(await registry.verify('dev-1')).toBe(false)
    expect(adb.calls).toHaveLength(0)
  })

  test('an unreadable listing answers false — "we could not confirm it" is the honest reading', async () => {
    const adb = fakeAdb()
    const registry = makeRegistry(adb)
    await registry.establish('dev-1', { hostPort: 9902 })
    adb.fail = (args) => args.includes('--list')
    expect(await registry.verify('dev-1')).toBe(false)
  })
})
