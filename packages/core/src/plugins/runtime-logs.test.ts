import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { PluginLogPageSchema } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { createKvStore, type KvStore } from '../kv/store'
import type { Logger } from '../util/logger'
import { createPluginLogStore, PLUGIN_LOG_KEEP_FILES, PLUGIN_LOG_REDACTOR_TTL_MS, type PluginLogStore } from './runtime-logs'

/**
 * Plan 109 (M74 — the plugin runtime), step **109.8 — logs**: the ring, the
 * rotation, `plugin.log`, and the redaction.
 *
 * ## Redaction is a promise about an ABSENCE, so every claim carries two controls
 *
 * Plan 109 §9 Q15's rule. The three absences this step asserts:
 *
 * | absence claim | control 1 — the thing is real | control 2 — it would be seen |
 * |---|---|---|
 * | a KV secret never appears in a line | the value really is stored as a secret and reads back verbatim through `store.get` | a DECOY of the same shape, logged in the same call, arrives verbatim |
 * | a farm-generated webhook secret never appears | it is supplied through the same `extraSecrets` port `daemon.ts` wires | the same decoy, same call |
 * | a secret never appears in a FIELD either | the field bag really reaches the line | a non-secret field in the same bag survives untouched |
 *
 * The decoy is the control that matters most here, and it is why every
 * redaction test logs two strings at once: without it, "the ring does not
 * contain the secret" passes just as well when the ring is empty, when the line
 * was dropped, or when the test is reading the wrong plugin.
 */

function quietLog(): Logger {
  const self: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => self }
  return self
}

interface Harness {
  logs: PluginLogStore
  kv: KvStore
  dataDir: string
}

const cleanup: Array<() => void> = []

function setUp(opts?: { rotateBytes?: number; ringLines?: number; writeFiles?: boolean; extraSecrets?: (p: string) => Array<{ key: string; plaintext: string }> }): Harness {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-logs-'))
  const kv = createKvStore(opened.db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
  const logs = createPluginLogStore({
    dataDir,
    store: kv,
    log: quietLog(),
    ...(opts?.rotateBytes !== undefined ? { rotateBytes: opts.rotateBytes } : {}),
    ...(opts?.ringLines !== undefined ? { ringLines: opts.ringLines } : {}),
    ...(opts?.writeFiles !== undefined ? { writeFiles: opts.writeFiles } : {}),
    ...(opts?.extraSecrets ? { extraSecrets: opts.extraSecrets } : {}),
  })
  cleanup.push(() => {
    logs.dispose()
    opened.sqlite.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { logs, kv, dataDir }
}

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

// ---------------------------------------------------------------------------
// R3's shape
// ---------------------------------------------------------------------------

describe('the ring (R3’s shape, keyed on plugin)', () => {
  test('lines come back oldest first, with a monotonic seq and the page shape the route will serve', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'one')
    h.logs.append('demo', 'warn', 'two')
    const page = PluginLogPageSchema.parse(h.logs.page('demo'))
    expect(page.plugin).toBe('demo')
    expect(page.lines.map((l) => l.msg)).toEqual(['one', 'two'])
    expect(page.lines.map((l) => l.seq)).toEqual([1, 2])
    expect(page.truncated).toBe(false)
    expect(page.nextSeq).toBe(2)
  })

  test('a cursor returns only what is new, so fetch-then-subscribe has no overlap to dedupe', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'one')
    const first = h.logs.page('demo')
    h.logs.append('demo', 'info', 'two')
    const second = h.logs.page('demo', { cursor: first.nextSeq })
    expect(second.lines.map((l) => l.msg)).toEqual(['two'])
    // Nothing new: the cursor is echoed rather than reset, so a poll that
    // arrives between two lines does not replay the last one forever.
    expect(h.logs.page('demo', { cursor: second.nextSeq }).lines).toEqual([])
  })

  test('an unknown plugin is an empty page, never a throw — a log view opens before the first line exists', () => {
    const h = setUp({ writeFiles: false })
    const page = h.logs.page('never-logged')
    expect(page.lines).toEqual([])
    expect(page.truncated).toBe(false)
  })
})

describe('`truncated` is honest about what a reader missed', () => {
  test('the ring wrapping sets it, and the oldest lines are the ones gone', () => {
    const h = setUp({ writeFiles: false, ringLines: 3 })
    for (let i = 1; i <= 5; i++) h.logs.append('demo', 'info', `line-${i}`)
    const page = h.logs.page('demo')
    expect(page.lines.map((l) => l.msg)).toEqual(['line-3', 'line-4', 'line-5'])
    expect(page.truncated).toBe(true)
  })

  test('a reader whose CURSOR fell off the back is told, even though the answer looks complete', () => {
    const h = setUp({ writeFiles: false, ringLines: 3 })
    h.logs.append('demo', 'info', 'line-1')
    // The reader has seq 1 and then goes away.
    for (let i = 2; i <= 6; i++) h.logs.append('demo', 'info', `line-${i}`)
    const page = h.logs.page('demo', { cursor: 1 })
    // Lines 2 and 3 are gone and this page cannot show them. Without the flag
    // it would look like a clean continuation from where the reader left off.
    expect(page.lines.map((l) => l.msg)).toEqual(['line-4', 'line-5', 'line-6'])
    expect(page.truncated).toBe(true)
  })

  test('control: a reader whose cursor is still inside the ring is NOT told anything was dropped', () => {
    const h = setUp({ writeFiles: false, ringLines: 5 })
    for (let i = 1; i <= 3; i++) h.logs.append('demo', 'info', `line-${i}`)
    expect(h.logs.page('demo', { cursor: 1 }).truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The per-subject filter plan 112 needs
// ---------------------------------------------------------------------------

describe('one ring, tagged — the per-subject filter (plan 112 §3.8)', () => {
  test('`fields.subject` is lifted onto the line and removed from the bag, so it renders once', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'accepted', { subject: 'proxy:a', conn: 7 })
    const line = h.logs.page('demo').lines[0]!
    expect(line.subject).toBe('proxy:a')
    expect(line.fields).toEqual({ conn: 7 })
  })

  test('a per-subject view is a PREDICATE over the one stream, server-side, with no second ring', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'a1', { subject: 'proxy:a' })
    h.logs.append('demo', 'info', 'b1', { subject: 'proxy:b' })
    h.logs.append('demo', 'info', 'supervisor line')
    h.logs.append('demo', 'info', 'a2', { subject: 'proxy:a' })

    expect(h.logs.page('demo', { subject: 'proxy:a' }).lines.map((l) => l.msg)).toEqual(['a1', 'a2'])
    expect(h.logs.page('demo', { subject: 'proxy:b' }).lines.map((l) => l.msg)).toEqual(['b1'])
    // "All" is the same ring with no predicate — one stream, four lines,
    // including the untagged supervisor line that belongs to no subject.
    expect(h.logs.page('demo').lines).toHaveLength(4)
    // And there is exactly ONE ring behind all three answers.
    expect(h.logs.size()).toBe(1)
  })

  test('the filter composes with the cursor, so a per-subject view can tail', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'a1', { subject: 'proxy:a' })
    const first = h.logs.page('demo', { subject: 'proxy:a' })
    h.logs.append('demo', 'info', 'b1', { subject: 'proxy:b' })
    h.logs.append('demo', 'info', 'a2', { subject: 'proxy:a' })
    expect(h.logs.page('demo', { subject: 'proxy:a', cursor: first.nextSeq }).lines.map((l) => l.msg)).toEqual(['a2'])
  })

  test('a non-string or empty subject is no subject — a tag is a filter key, not a place to put an object', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('demo', 'info', 'x', { subject: { id: 1 } })
    h.logs.append('demo', 'info', 'y', { subject: '   ' })
    expect(h.logs.page('demo').lines.map((l) => l.subject)).toEqual([null, null])
  })
})

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redaction — what is removed, and what is honestly not', () => {
  test('a secret in the plugin’s own KV namespace never reaches a line; a decoy of the same shape does', () => {
    const h = setUp({ writeFiles: false })
    const secret = 'sk-live-9f3a2c7b1d4e6081'
    const decoy = 'sk-live-0000000000000000'
    h.kv.set({ kind: 'global' }, 'demo', 'api-key', secret, { secret: true })

    // Control 1 — the secret is real and is stored as one: it reads back
    // verbatim in-process, which is the only way it can.
    expect(h.kv.get({ kind: 'global' }, 'demo', 'api-key')?.value).toBe(secret)

    h.logs.append('demo', 'info', `calling upstream with ${secret} and decoy ${decoy}`)
    const line = h.logs.page('demo').lines[0]!

    // The absence.
    expect(line.msg).not.toContain(secret)
    expect(line.msg).toContain('«redacted:api-key»')
    // Control 2 — the search would have found it. The decoy is the same length,
    // the same shape, in the same string, and it survives untouched, so the
    // assertion above is about redaction rather than about an empty ring.
    expect(line.msg).toContain(decoy)
  })

  test('a secret in the FIELDS is redacted too — the easier mistake is not the unguarded one', () => {
    const h = setUp({ writeFiles: false })
    const secret = 'pw-8a71c2e5b09d43ff'
    h.kv.set({ kind: 'global' }, 'demo', 'password', secret, { secret: true })

    h.logs.append('demo', 'warn', 'upstream refused', { password: secret, host: 'proxy.example', attempt: 2 })
    const line = h.logs.page('demo').lines[0]!
    expect(JSON.stringify(line.fields)).not.toContain(secret)
    expect(JSON.stringify(line.fields)).toContain('«redacted:password»')
    // Control — the bag really did arrive, and its non-secret members are
    // untouched, so "the secret is not there" is not "the fields are not there".
    expect(line.fields).toMatchObject({ host: 'proxy.example', attempt: 2 })
  })

  test('a FARM-generated webhook secret is redacted although it lives outside KV', () => {
    const secret = 'whk_Ff93Kd02LlQq7bZzXx11'
    const decoy = 'whk_00000000000000000000'
    const h = setUp({ writeFiles: false, extraSecrets: (p) => (p === 'demo' ? [{ key: 'webhook:hook', plaintext: secret }] : []) })

    h.logs.append('demo', 'info', `my webhook secret is ${secret}, and this one is ${decoy}`)
    const line = h.logs.page('demo').lines[0]!
    expect(line.msg).not.toContain(secret)
    expect(line.msg).toContain('«redacted:webhook:hook»')
    // Control — same call, same length, same shape, not a secret: it survives.
    expect(line.msg).toContain(decoy)
  })

  test('the stated gap: a secret under 8 characters is NOT redacted', () => {
    const h = setUp({ writeFiles: false })
    // `buildSecretRedactor` ignores anything under 8 characters, on its own
    // stated false-positive reasoning. Asserted rather than glossed: a redactor
    // whose limits are undocumented is a redactor somebody will trust too far.
    h.kv.set({ kind: 'global' }, 'demo', 'pin', 'abc1234', { secret: true })
    h.kv.set({ kind: 'global' }, 'demo', 'long', 'abcdefgh12345678', { secret: true })
    h.logs.append('demo', 'info', 'the pin is abc1234 and the long one is abcdefgh12345678')
    const msg = h.logs.page('demo').lines[0]!.msg
    expect(msg).toContain('abc1234')
    // Control: an 8-plus-character secret written at the same moment, in the
    // same namespace, in the same line, IS redacted — so the miss above is the
    // length rule and not a redactor that never ran.
    expect(msg).not.toContain('abcdefgh12345678')
    expect(msg).toContain('«redacted:long»')
  })

  test('the stated gap: a secret SPLIT across two lines is NOT redacted', () => {
    const h = setUp({ writeFiles: false })
    h.kv.set({ kind: 'global' }, 'demo', 'split', 'a-very-long-secret-value', { secret: true })
    h.logs.append('demo', 'info', 'first half a-very-long')
    h.logs.append('demo', 'info', 'second half -secret-value')
    const lines = h.logs.page('demo').lines
    expect(lines[0]!.msg).toContain('a-very-long')
    expect(lines[1]!.msg).toContain('-secret-value')
    // Control: the WHOLE value, in one line, in this same store, IS caught —
    // so "a substring replace cannot see a split value" is a statement about
    // the split and not about the secret being invisible.
    h.logs.append('demo', 'info', 'whole a-very-long-secret-value')
    expect(h.logs.page('demo').lines[2]!.msg).toContain('«redacted:split»')
  })

  test('the memoised redactor has a stated cost: a secret written mid-window is not redacted until it expires', () => {
    let clock = 1_000_000
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-plugin-logs-ttl-'))
    const kv = createKvStore(opened.db, dataDir, () => ({ maxValueBytes: 65_536, maxKeyLength: 256, maxEntriesPerNamespace: 1_000, maxEntriesPerDevice: 5_000 }))
    const logs = createPluginLogStore({ dataDir, store: kv, writeFiles: false, log: quietLog(), now: () => clock })
    cleanup.push(() => {
      logs.dispose()
      opened.sqlite.close()
      rmSync(dataDir, { recursive: true, force: true })
    })

    // Builds the redactor for a namespace with no secrets in it.
    logs.append('demo', 'info', 'warming the redactor')
    const secret = 'written-after-the-redactor-was-built'
    kv.set({ kind: 'global' }, 'demo', 'late', secret, { secret: true })

    logs.append('demo', 'info', `inside the window: ${secret}`)
    expect(logs.page('demo').lines[1]!.msg).toContain(secret)

    // Control: past the TTL the same call IS redacted, so the miss above is the
    // memo and not a redactor that never sees KV at all.
    clock += PLUGIN_LOG_REDACTOR_TTL_MS + 1
    logs.append('demo', 'info', `after the window: ${secret}`)
    expect(logs.page('demo').lines[2]!.msg).not.toContain(secret)
    expect(logs.page('demo').lines[2]!.msg).toContain('«redacted:late»')
  })

  test('redaction is per PLUGIN — one plugin’s secret is not scanned for in another’s log', () => {
    const h = setUp({ writeFiles: false })
    const secret = 'ns-scoped-secret-value-1'
    h.kv.set({ kind: 'global' }, 'alpha', 'key', secret, { secret: true })
    h.logs.append('alpha', 'info', `alpha says ${secret}`)
    h.logs.append('beta', 'info', `beta says ${secret}`)
    expect(h.logs.page('alpha').lines[0]!.msg).not.toContain(secret)
    // Stated rather than hidden: `beta` printing `alpha`'s secret is not
    // redacted, because the redactor is scoped to the plugin's own namespace.
    // That is the correct scope — a farm-wide scan would decrypt every secret
    // on the farm for every log line — and it is a real limit.
    expect(h.logs.page('beta').lines[0]!.msg).toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// The file and its rotation
// ---------------------------------------------------------------------------

describe('the file, and how a reader learns something was dropped', () => {
  test('lines are APPENDED, not overwritten — the whole point of a record', () => {
    const h = setUp()
    h.logs.append('demo', 'info', 'first')
    h.logs.append('demo', 'error', 'second')
    const path = join(h.dataDir, 'plugins', 'demo', 'runtime.log')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('first')
    expect(text).toContain('second')
    expect(text.trim().split('\n')).toHaveLength(2)
  })

  test('rotation keeps one previous generation, drops the rest, and SAYS SO in the log itself', () => {
    const h = setUp({ rotateBytes: 400 })
    for (let i = 0; i < 12; i++) h.logs.append('demo', 'info', `line-${i} ${'x'.repeat(40)}`)

    const base = join(h.dataDir, 'plugins', 'demo', 'runtime.log')
    expect(existsSync(base)).toBe(true)
    expect(existsSync(`${base}.1`)).toBe(true)
    // What is kept: the live file plus PLUGIN_LOG_KEEP_FILES generations, and
    // nothing beyond that — the oldest is deleted rather than accumulated.
    expect(existsSync(`${base}.${PLUGIN_LOG_KEEP_FILES + 1}`)).toBe(false)

    // How a reader learns. The banner is a real log line, so it is in the ring
    // and at the head of the new file.
    const banner = h.logs.page('demo').lines.filter((l) => l.msg.includes('log rotated'))
    expect(banner.length).toBeGreaterThan(0)
    expect(banner[0]!.level).toBe('warn')
    expect(banner[0]!.msg).toContain('has been deleted')
    expect(readFileSync(base, 'utf8')).toContain('log rotated')
  })
})

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe('bounds', () => {
  test('a released plugin’s ring is gone, and the structure is bounded by plugin count', () => {
    const h = setUp({ writeFiles: false })
    h.logs.append('a', 'info', 'x')
    h.logs.append('b', 'info', 'y')
    expect(h.logs.size()).toBe(2)
    h.logs.release('a')
    expect(h.logs.size()).toBe(1)
    expect(h.logs.page('a').lines).toEqual([])
  })
})
