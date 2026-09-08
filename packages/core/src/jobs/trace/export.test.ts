import { describe, expect, test } from 'bun:test'
import { JobDetailSchema, JobRunInfoSchema, type JobTraceEvent, type UiNode } from '@enkaku/protocol'
import { buildRunExportEntries, offsetLabel, safeNamePart, type RunExportSources } from './export'

/**
 * These assert the bundle's STRUCTURE — which files exist, what they resolve
 * to, and what a gap turns into. They deliberately assert no prose: the
 * README's wording is copy, and a test that pins copy is a test that gets
 * deleted (plan 200 §8.3). What they do pin is the module's own three rules:
 * a gap is written down, the frame store's de-duplication survives the
 * export, and nothing is read eagerly.
 */

const job = JobDetailSchema.parse({
  jobId: 'job-1111-2222',
  deviceId: 'dev-1',
  scriptId: 'script-1',
  scriptName: 'checkout flow',
  status: 'failed',
  error: 'element not found',
  priority: 0,
  createdAt: 1_700_000_000,
  startedAt: 1_700_000_001,
  finishedAt: 1_700_000_009,
  params: { user: 'alice' },
  result: null,
})

const run = JobRunInfoSchema.parse({
  runId: 'run-1',
  jobId: job.jobId,
  seq: 2,
  trigger: 'manual',
  status: 'failed',
  deviceId: 'dev-1',
  priority: 0,
  createdAt: 1_700_000_000,
  startedAt: 1_700_000_001,
  finishedAt: 1_700_000_009,
  error: 'element not found',
})

function event(partial: Partial<JobTraceEvent> & Pick<JobTraceEvent, 'seq' | 'kind' | 'name'>): JobTraceEvent {
  return {
    id: `ev-${partial.seq}`,
    runId: run.runId,
    atMs: 1_700_000_000_000 + partial.seq * 1000,
    attempt: 1,
    phase: 'run',
    durationMs: null,
    ok: null,
    errorCode: null,
    meta: null,
    frameHash: null,
    frameStatus: null,
    uiHash: null,
    ...partial,
  }
}

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function sources(overrides: Partial<RunExportSources> = {}): RunExportSources {
  return {
    job,
    run,
    result: { value: null, bytes: null, status: null, issues: null },
    events: [],
    eventsTruncated: false,
    artifacts: [],
    logs: { lines: [], source: 'none' },
    deviceLabel: 'Pixel 6',
    openFrame: () => ({ size: 100, stream: () => new ReadableStream({ start: (c) => c.close() }) }),
    readUiTree: async () => ({ cls: 'android.widget.FrameLayout' }) as unknown as UiNode,
    uiTreeSize: () => 64,
    now: () => 1_700_000_010_000,
    ...overrides,
  }
}

async function readEntry(entries: ReturnType<typeof buildRunExportEntries>, name: string): Promise<string> {
  const entry = entries.find((e) => e.name === name)
  if (!entry) throw new Error(`no entry named ${name} — have: ${entries.map((e) => e.name).join(', ')}`)
  const chunks: Uint8Array[] = []
  const reader = entry.open().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return chunks.map((c) => new TextDecoder().decode(c)).join('')
}

describe('buildRunExportEntries — every entry declares a size the archive cap can be checked against', () => {
  test('no text entry is declared as zero bytes — `createZipStream`’s pre-flight refusal reads these', () => {
    const entries = buildRunExportEntries(
      sources({ events: [event({ seq: 1, kind: 'log', name: 'info', meta: { msg: 'hi' } })] }),
    )
    for (const entry of entries) expect({ name: entry.name, zero: entry.size === 0 }).toEqual({ name: entry.name, zero: false })
  })
})

describe('buildRunExportEntries — the fixed spine', () => {
  test('a bundle always carries its seven top-level files, even for a run with no trace at all', () => {
    const names = buildRunExportEntries(sources()).map((e) => e.name)
    expect(names).toEqual(['README.md', 'manifest.json', 'timeline.md', 'timeline.json', 'logs.txt', 'params.json', 'result.json'])
  })

  test('params and result are the job’s own values, not a re-shaped copy', async () => {
    const entries = buildRunExportEntries(sources({ result: { value: { ok: 7 }, bytes: 12, status: 'valid', issues: null } }))
    expect(JSON.parse(await readEntry(entries, 'params.json'))).toEqual({ user: 'alice' })
    expect(JSON.parse(await readEntry(entries, 'result.json'))).toMatchObject({ status: 'valid', bytes: 12, value: { ok: 7 } })
  })
})

describe('buildRunExportEntries — the store’s de-duplication survives (rule 2)', () => {
  test('two actions on one unchanged screen produce ONE frame file, and both resolve onto it', async () => {
    const entries = buildRunExportEntries(
      sources({
        events: [
          event({ seq: 4, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok' }),
          event({ seq: 9, kind: 'action', name: 'swipe', frameHash: HASH_A, frameStatus: 'ok' }),
        ],
      }),
    )
    const frameEntries = entries.filter((e) => e.name.startsWith('frames/'))
    expect(frameEntries).toHaveLength(1)
    expect(frameEntries[0]!.name).toBe('frames/00004-tap.png')

    // Both events must be resolvable by a reader — the map is how the second one gets there.
    const manifest = JSON.parse(await readEntry(entries, 'manifest.json'))
    expect(manifest.frames).toEqual({ [HASH_A]: 'frames/00004-tap.png' })
    expect(manifest.counts.frames).toBe(1)

    // ...and the timeline points BOTH lines at that same path, not one at a file that does not exist.
    const timeline = await readEntry(entries, 'timeline.md')
    expect(timeline.match(/frames\/00004-tap\.png/g)).toHaveLength(2)
  })

  test('two different screens produce two files, named after the event that first showed each', () => {
    const entries = buildRunExportEntries(
      sources({
        events: [
          event({ seq: 1, kind: 'action', name: 'app.launch', frameHash: HASH_A, frameStatus: 'ok', uiHash: HASH_A }),
          event({ seq: 2, kind: 'action', name: 'tap', frameHash: HASH_B, frameStatus: 'ok', uiHash: HASH_B }),
        ],
      }),
    )
    expect(entries.filter((e) => e.name.startsWith('frames/')).map((e) => e.name)).toEqual(['frames/00001-app-launch.png', 'frames/00002-tap.png'])
    expect(entries.filter((e) => e.name.startsWith('ui/')).map((e) => e.name)).toEqual(['ui/00001-app-launch.json', 'ui/00002-tap.json'])
  })
})

describe('buildRunExportEntries — a gap is written down, never left blank (rule 1)', () => {
  test('an event whose frame the policy skipped gets no file, and the timeline says why', async () => {
    const entries = buildRunExportEntries(
      sources({ events: [event({ seq: 3, kind: 'action', name: 'tap', frameStatus: 'skipped-policy' })] }),
    )
    expect(entries.some((e) => e.name.startsWith('frames/'))).toBe(false)
    expect(await readEntry(entries, 'timeline.md')).toContain('capture policy')
  })

  test('a frame the store no longer holds produces no entry and no dangling path', async () => {
    const entries = buildRunExportEntries(
      sources({
        openFrame: () => null,
        events: [event({ seq: 3, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok' })],
      }),
    )
    expect(entries.some((e) => e.name.startsWith('frames/'))).toBe(false)
    const manifest = JSON.parse(await readEntry(entries, 'manifest.json'))
    expect(manifest.frames).toEqual({})
    expect(await readEntry(entries, 'timeline.md')).not.toContain('frames/')
  })

  test('a frame that was captured OK but has since been swept says so, rather than reading as a silent omission', async () => {
    const entries = buildRunExportEntries(
      sources({
        openFrame: () => null,
        events: [event({ seq: 3, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok', ok: true })],
      }),
    )
    expect(await readEntry(entries, 'timeline.md')).toContain('no longer on disk')
  })

  test('an artifact whose file is gone is recorded as missing rather than dropped from the record', async () => {
    const info = { id: 'a1', runId: run.runId, deviceId: null, kind: 'screenshot' as const, label: 'shot', path: 'artifacts/job/0001-shot.png', sizeBytes: 10, createdAt: 1, pinned: false }
    const entries = buildRunExportEntries(sources({ artifacts: [{ info, abs: null, sizeBytes: 0 }] }))
    expect(entries.some((e) => e.name.startsWith('artifacts/'))).toBe(false)
    const manifest = JSON.parse(await readEntry(entries, 'manifest.json'))
    expect(manifest.artifacts).toEqual([{ id: 'a1', kind: 'screenshot', label: 'shot', sizeBytes: 0, createdAt: 1, path: null, missing: true }])
    expect(manifest.counts.artifactsMissing).toBe(1)
  })

  test('truncation reaches the manifest and both timeline files, not just the count', async () => {
    const entries = buildRunExportEntries(
      sources({ events: [event({ seq: 1, kind: 'log', name: 'info', meta: { msg: 'hi' } })], eventsTruncated: true }),
    )
    expect(JSON.parse(await readEntry(entries, 'manifest.json')).counts.eventsTruncated).toBe(true)
    expect(JSON.parse(await readEntry(entries, 'timeline.json')).truncated).toBe(true)
    expect(await readEntry(entries, 'timeline.md')).toContain('TRUNCATED')
  })
})

describe('buildRunExportEntries — one bad capture costs its own file, never the bundle', () => {
  test('a UI snapshot that throws on read becomes a placeholder entry, and the stream still closes cleanly', async () => {
    const entries = buildRunExportEntries(
      sources({
        readUiTree: () => Promise.reject(new Error('trace ui snapshot is unreadable')),
        events: [event({ seq: 5, kind: 'action', name: 'dump', uiHash: HASH_A })],
      }),
    )
    const body = JSON.parse(await readEntry(entries, 'ui/00005-dump.json'))
    expect(body).toEqual({ error: 'trace ui snapshot is unreadable', uiHash: HASH_A })
  })

  test('a UI snapshot that is simply gone says so rather than writing an empty file', async () => {
    const entries = buildRunExportEntries(
      sources({ readUiTree: async () => null, events: [event({ seq: 5, kind: 'action', name: 'dump', uiHash: HASH_A })] }),
    )
    expect(JSON.parse(await readEntry(entries, 'ui/00005-dump.json')).uiHash).toBe(HASH_A)
  })
})

describe('buildRunExportEntries — nothing is read before the writer asks (rule 3)', () => {
  test('a frame referenced by many events is opened ONCE, not once per event naming it', () => {
    let opens = 0
    buildRunExportEntries(
      sources({
        openFrame: () => {
          opens += 1
          return { size: 10, stream: () => new ReadableStream({ start: (c) => c.close() }) }
        },
        events: [
          event({ seq: 1, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok' }),
          event({ seq: 2, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok' }),
          event({ seq: 3, kind: 'action', name: 'tap', frameHash: HASH_A, frameStatus: 'ok' }),
          event({ seq: 4, kind: 'action', name: 'swipe', frameHash: HASH_B, frameStatus: 'ok' }),
        ],
      }),
    )
    expect(opens).toBe(2)
  })

  test('building the entry list opens no frame, no UI tree and no artifact', () => {
    let opened = 0
    const entries = buildRunExportEntries(
      sources({
        readUiTree: async () => {
          opened += 1
          return null
        },
        events: [event({ seq: 1, kind: 'action', name: 'dump', uiHash: HASH_A })],
      }),
    )
    expect(entries.some((e) => e.name === 'ui/00001-dump.json')).toBe(true)
    expect(opened).toBe(0)
  })
})

describe('buildRunExportEntries — logs', () => {
  test('the fallback to the live buffer is stated in the file and in the manifest, not silently taken', async () => {
    const entries = buildRunExportEntries(
      sources({ logs: { lines: [{ ts: 1_700_000_000_000, level: 'info', source: 'script', msg: 'hello' }], source: 'buffer' } }),
    )
    expect(await readEntry(entries, 'logs.txt')).toContain('live log buffer')
    expect(JSON.parse(await readEntry(entries, 'manifest.json')).logs.source).toBe('buffer')
  })
})

describe('naming helpers', () => {
  test('offsetLabel places an event on the axis relative to the run’s first event', () => {
    expect(offsetLabel(1000, 1000)).toBe('00:00.000')
    expect(offsetLabel(1000 + 65_432, 1000)).toBe('01:05.432')
    // An event stamped before the origin (a clock step) clamps rather than going negative.
    expect(offsetLabel(0, 1000)).toBe('00:00.000')
  })

  test('safeNamePart never produces a path separator, a dot, or an empty stem', () => {
    expect(safeNamePart('app.launch')).toBe('app-launch')
    expect(safeNamePart('../../etc/passwd')).toBe('etc-passwd')
    expect(safeNamePart('!!!')).toBe('event')
  })
})
