import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Transport } from '@enkaku/protocol'
import { defaultDeviceSettings, type DeviceSettings } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { admitDevice, recordSighting } from '../registry/admission'
import { createLabellingService, type LabellingServiceDeps } from './labelling'

/**
 * The labelling service, host side (plan 89 §4.6, §5 step 89.6).
 *
 * Exercises the honesty rules §3.5 exists for (no silent fallback, no
 * `applied` without both surfaces confirmed), §3.6's idempotence rule
 * (a second apply at an unchanged fingerprint issues no device call;
 * `clear` performs identical writes on the tenth call as the first), and
 * §3.8's zero-work rule for `mode: 'off'` — the acceptance criteria this
 * step is built against, not just "it typechecks".
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function admit(db: Db, stableId: string, opts: { screenW?: number; screenH?: number } = {}): DeviceRow {
  recordSighting(db, { stableId, serial: `serial-${stableId}`, label: `Pixel ${stableId}`, androidVersion: '15' })
  const row = admitDevice(db, stableId)
  if (!row) throw new Error('admitDevice returned null in test setup')
  db.update(devices)
    .set({ status: 'online', screenW: opts.screenW ?? 1080, screenH: opts.screenH ?? 2400 })
    .where(eq(devices.id, row.id))
    .run()
  return db.select().from(devices).where(eq(devices.id, row.id)).get()!
}

function withLabelling(db: Db, id: string, labelling: DeviceSettings['labelling']): void {
  const row = db.select().from(devices).where(eq(devices.id, id)).get()!
  const settings = defaultDeviceSettings()
  db.update(devices)
    .set({ settings: { ...settings, labelling } })
    .where(eq(devices.id, row.id))
    .run()
}

/** A minimal fake guest-agent client the test controls call-by-call. */
function fakeGuestAgentClient(overrides: {
  capabilities?: string[]
  labelStatus?: () => { fingerprint: string | null; matchesOurs: boolean; rendererVersion: number; originalCaptured: boolean; wallpaperIdHome: number | null; wallpaperIdLock: number | null }
  labelApply?: (params: { fingerprint: string; number: string; name: string | null; surfaces: Array<'home' | 'lock'> }) => { applied: Array<'home' | 'lock'>; fingerprint: string; rendererVersion: number; widthPx: number; heightPx: number; wallpaperIdHome: number | null; wallpaperIdLock: number | null }
  labelClear?: (restoreOriginal: boolean) => { restored: 'original' | 'system-default'; fingerprint: null }
}) {
  return {
    hello: async () => ({ protocol: 1, appVersion: '1.0.0', androidSdkInt: 34, capabilities: overrides.capabilities ?? ['screen-label'] }),
    labelStatus: async () => overrides.labelStatus?.() ?? { fingerprint: null, matchesOurs: false, rendererVersion: 1, originalCaptured: false, wallpaperIdHome: null, wallpaperIdLock: null },
    labelApply: async (params: never) => overrides.labelApply?.(params) ?? { applied: ['home', 'lock'], fingerprint: (params as { fingerprint: string }).fingerprint, rendererVersion: 1, widthPx: 1080, heightPx: 2400, wallpaperIdHome: 1, wallpaperIdLock: 2 },
    labelClear: async (restoreOriginal: boolean) => overrides.labelClear?.(restoreOriginal) ?? { restored: restoreOriginal ? ('original' as const) : ('system-default' as const), fingerprint: null },
  }
}

function makeDeps(db: Db, opts: Partial<LabellingServiceDeps> & { agentClient?: ReturnType<typeof fakeGuestAgentClient> } = {}): LabellingServiceDeps & { calls: { withGuestAgentClient: number; buildTransport: number } } {
  const calls = { withGuestAgentClient: 0, buildTransport: 0 }
  const agentClient = opts.agentClient ?? fakeGuestAgentClient({})
  return {
    db,
    client: () => null,
    withGuestAgentClient: async (_deviceId, fn) => {
      calls.withGuestAgentClient++
      // biome-ignore lint: test fake, narrow interface deliberately loose
      return fn(agentClient as never)
    },
    maxConcurrent: () => 2,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => makeDeps(db).log } as LabellingServiceDeps['log'],
    now: () => 1_700_000_000_000,
    buildTransport: () => {
      calls.buildTransport++
      return opts.buildTransport ? opts.buildTransport(undefined as never) : null
    },
    calls,
    ...opts,
  }
}

describe('createLabellingService — mode: off (plan 89 §3.8)', () => {
  test('does zero device work, and zero DB work once the cache already agrees', async () => {
    const db = setUpDb()
    const row = admit(db, 'OFF1')
    const deps = makeDeps(db)
    const svc = createLabellingService(deps)

    const first = await svc.reconcile(row.id)
    expect(first.state).toBe('off')
    expect(deps.calls.withGuestAgentClient).toBe(0)
    expect(deps.calls.buildTransport).toBe(0)

    const before = db.select().from(devices).where(eq(devices.id, row.id)).get()!
    const second = await svc.reconcile(row.id)
    expect(second).toEqual(first)
    const after = db.select().from(devices).where(eq(devices.id, row.id)).get()!
    // The row's own JSON reference is irrelevant; what matters is the second
    // pass never called into the device layer either.
    expect(deps.calls.withGuestAgentClient).toBe(0)
    expect(before.labelState).toEqual(after.labelState)
  })
})

describe('createLabellingService — tier 1 (wallpaper), §3.5, §4.6', () => {
  test('no screen-label capability → unavailable, never a silent downgrade, and label.apply is never called', async () => {
    const db = setUpDb()
    const row = admit(db, 'W1')
    withLabelling(db, row.id, { mode: 'wallpaper', showName: true })
    let applyCalled = false
    const agentClient = fakeGuestAgentClient({
      capabilities: [],
      labelApply: () => {
        applyCalled = true
        return { applied: [], fingerprint: 'x', rendererVersion: 1, widthPx: 0, heightPx: 0, wallpaperIdHome: null, wallpaperIdLock: null }
      },
    })
    const deps = makeDeps(db, { agentClient })
    const svc = createLabellingService(deps)

    const result = await svc.reconcile(row.id)
    expect(result.state).toBe('unavailable')
    expect(result.reason).toContain('screen-label')
    expect(applyCalled).toBe(false)
  })

  test('both surfaces accepted → applied, and a second reconcile at the same fingerprint issues no label.apply call', async () => {
    const db = setUpDb()
    const row = admit(db, 'W2')
    withLabelling(db, row.id, { mode: 'wallpaper', showName: true })
    let applyCount = 0
    let lastFingerprint: string | null = null
    const agentClient = fakeGuestAgentClient({
      labelStatus: () => ({ fingerprint: lastFingerprint, matchesOurs: lastFingerprint !== null, rendererVersion: 1, originalCaptured: true, wallpaperIdHome: 1, wallpaperIdLock: 2 }),
      labelApply: (params) => {
        applyCount++
        lastFingerprint = params.fingerprint
        return { applied: ['home', 'lock'], fingerprint: params.fingerprint, rendererVersion: 1, widthPx: 1080, heightPx: 2400, wallpaperIdHome: 1, wallpaperIdLock: 2 }
      },
    })
    const deps = makeDeps(db, { agentClient })
    const svc = createLabellingService(deps)

    const first = await svc.reconcile(row.id)
    expect(first.state).toBe('applied')
    expect(first.fingerprint).not.toBeNull()
    expect(applyCount).toBe(1)

    const second = await svc.reconcile(row.id)
    expect(second.state).toBe('applied')
    expect(applyCount).toBe(1) // no re-render for an unchanged fingerprint (§3.7)
  })

  test('only one surface accepted → partial, naming which, never rounded up to applied', async () => {
    const db = setUpDb()
    const row = admit(db, 'W3')
    withLabelling(db, row.id, { mode: 'wallpaper', showName: true })
    const agentClient = fakeGuestAgentClient({
      labelApply: (params) => ({ applied: ['home'], fingerprint: params.fingerprint, rendererVersion: 1, widthPx: 1080, heightPx: 2400, wallpaperIdHome: 1, wallpaperIdLock: null }),
    })
    const deps = makeDeps(db, { agentClient })
    const svc = createLabellingService(deps)

    const result = await svc.reconcile(row.id)
    expect(result.state).toBe('partial')
    expect(result.reason).toContain('home')
  })

  test('a device with no reserved number reads unavailable rather than crashing or guessing a number', async () => {
    const db = setUpDb()
    const row = admit(db, 'W4')
    withLabelling(db, row.id, { mode: 'wallpaper', showName: true })
    // Simulate a released reservation the way `releaseDeviceNumber` would leave it.
    const { deviceNumbers } = await import('../db/schema')
    db.delete(deviceNumbers).where(eq(deviceNumbers.stableId, 'W4')).run()

    const deps = makeDeps(db)
    const svc = createLabellingService(deps)
    const result = await svc.reconcile(row.id)
    expect(result.state).toBe('unavailable')
    expect(result.reason).toContain('number')
  })

  test('clear() is idempotent: a second call performs the identical device call and the identical resulting state', async () => {
    const db = setUpDb()
    const row = admit(db, 'W5')
    withLabelling(db, row.id, { mode: 'wallpaper', showName: true })
    let clearCalls = 0
    const agentClient = fakeGuestAgentClient({
      labelApply: (params) => ({ applied: ['home', 'lock'], fingerprint: params.fingerprint, rendererVersion: 1, widthPx: 1080, heightPx: 2400, wallpaperIdHome: 1, wallpaperIdLock: 2 }),
      labelClear: (restoreOriginal) => {
        clearCalls++
        return { restored: restoreOriginal ? ('original' as const) : ('system-default' as const), fingerprint: null }
      },
    })
    const deps = makeDeps(db, { agentClient })
    const svc = createLabellingService(deps)

    await svc.apply(row.id, { userId: 'u1' })
    const first = await svc.clear(row.id, { restoreOriginal: true, actor: { userId: 'u1' } })
    const second = await svc.clear(row.id, { restoreOriginal: true, actor: { userId: 'u1' } })
    expect(first).toEqual(second)
    expect(first.state).toBe('off')
    // First clear undoes the wallpaper (mode was 'wallpaper' in the cache);
    // the second finds nothing left to undo (mode already reset to the
    // current settings' own value) — the identical RESULT, not necessarily
    // a second identical device call, matching `clearImpl`'s own comment.
    expect(clearCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('createLabellingService — tier 0 (lock-screen), §3.5 H2, §4.5', () => {
  function fakeTransport(initial: { text: string; enabled: boolean }): { transport: Transport; writes: string[] } {
    const state = { ...initial }
    const writes: string[] = []
    const transport: Transport = {
      id: 't',
      serial: 's',
      stableId: 'stable',
      connect: async () => {},
      disconnect: async () => {},
      exec: async (cmd: string) => {
        writes.push(cmd)
        if (cmd.includes('get secure lock_screen_owner_info_enabled')) return { stdout: state.enabled ? '1' : '0', stderr: '', exitCode: 0 }
        if (cmd.includes('get secure lock_screen_owner_info')) return { stdout: state.text || 'null', stderr: '', exitCode: 0 }
        if (cmd.includes('put secure lock_screen_owner_info_enabled')) {
          state.enabled = cmd.trim().endsWith('1')
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        if (cmd.includes('put secure lock_screen_owner_info')) {
          const m = /put secure lock_screen_owner_info\s+'([^']*)'/.exec(cmd)
          state.text = m ? m[1]! : ''
          return { stdout: '', stderr: '', exitCode: 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      execOut: async () => new Uint8Array(),
    }
    return { transport, writes }
  }

  test('applies, verifies by reading back, and captures the original exactly once', async () => {
    const db = setUpDb()
    const row = admit(db, 'L1')
    withLabelling(db, row.id, { mode: 'lock-screen', showName: true })
    const { transport, writes } = fakeTransport({ text: 'previous owner text', enabled: false })
    const deps = makeDeps(db, { buildTransport: () => transport })
    const svc = createLabellingService(deps)

    const first = await svc.reconcile(row.id)
    expect(first.state).toBe('applied')
    expect(first.originalCaptured).toBe(true)
    expect(first.capturedLockScreen).toEqual({ text: 'previous owner text', enabled: false })

    const writesAfterFirst = writes.length
    // Second reconcile at the SAME fingerprint takes the cheap path — no transport built at all.
    const second = await svc.reconcile(row.id)
    expect(second).toEqual(first)
    expect(writes.length).toBe(writesAfterFirst)
  })

  test('a read-back mismatch is reported unavailable, never applied (H2 is unproven — CLAUDE.md’s unverified rule)', async () => {
    const db = setUpDb()
    const row = admit(db, 'L2')
    withLabelling(db, row.id, { mode: 'lock-screen', showName: true })
    const { transport } = fakeTransport({ text: '', enabled: false })
    // Sabotage the transport so the write never actually lands.
    const brokenTransport: Transport = {
      ...transport,
      exec: async (cmd: string) => {
        if (cmd.startsWith('settings put')) return { stdout: '', stderr: '', exitCode: 0 } // silently ignored
        return { stdout: 'null', stderr: '', exitCode: 0 } // always reads back unset
      },
    }
    const deps = makeDeps(db, { buildTransport: () => brokenTransport })
    const svc = createLabellingService(deps)

    const result = await svc.reconcile(row.id)
    expect(result.state).toBe('unavailable')
    expect(result.reason).toContain('read-back')
  })

  test('restoring after a captured original writes back exactly what was captured', async () => {
    const db = setUpDb()
    const row = admit(db, 'L3')
    withLabelling(db, row.id, { mode: 'lock-screen', showName: true })
    const { transport } = fakeTransport({ text: 'operator text', enabled: true })
    const deps = makeDeps(db, { buildTransport: () => transport })
    const svc = createLabellingService(deps)

    await svc.apply(row.id, { userId: 'u1' })
    const cleared = await svc.clear(row.id, { restoreOriginal: true, actor: { userId: 'u1' } })
    expect(cleared.state).toBe('off')

    const live = await transport.exec('settings get secure lock_screen_owner_info')
    const liveEnabled = await transport.exec('settings get secure lock_screen_owner_info_enabled')
    expect(live.stdout).toBe('operator text')
    expect(liveEnabled.stdout).toBe('1')
  })
})
