import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `createRecordingRoutes` (`recordings.ts`, plan 94 §4.9, §5 step 94.5) is a
 * pure function of its deps — fully covered by this package's own unit
 * tests. What it can never prove on its own is that `daemon.ts`'s ONE real
 * `createApp({...})` call actually constructs a real instance and passes it
 * as `recordingRoutes`. This is the exact "a mechanism proven correct in
 * isolation, never reaching its one production call site" class of defect
 * `packages/core/src/api/workflows-wiring.test.ts` already guards against
 * for `/api/workflows` — this file is the same self-detecting pattern for
 * `/api/recordings`, in a fresh file for the same reason that one gives (zero
 * merge risk against other concurrent workers touching `daemon.ts` or the
 * shared `daemon-wiring.test.ts`).
 *
 * This step DID wire `daemon.ts` (the edit was small, additive, and used
 * `workspaceStore`/`recordingService` instances every other route in that
 * file already shares — see this step's own report for the exact diff), so
 * unlike `workflows-wiring.test.ts` at the time it was written, this test is
 * expected to PASS today. It stays in the tree as the tripwire for the day
 * someone edits `daemon.ts`'s `createApp({...})` call and drops the field by
 * accident.
 *
 * The exact two-line fix, verbatim, for as long as this test is red:
 *
 *   import { createRecordingRoutes } from './api/recordings'
 *
 * and, inside the `createApp({ ... })` call, beside `workflowRoutes:`:
 *
 *   recordingRoutes: createRecordingRoutes({ db, workspace: workspaceStore, recording: recordingService, audit }),
 */

const daemonSource = readFileSync(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')

/** Extracts the balanced-brace call `name({ ... })` starting at `name({` — same helper `daemon-wiring.test.ts`/`workflows-wiring.test.ts` each duplicate for the same "not this step's ownership, and importing a `.test.ts` helper across files is not a pattern this codebase uses" reason. */
function extractCall(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`daemon.ts no longer contains ${JSON.stringify(marker)} — this test needs updating alongside that change`)
  const openBrace = start + marker.length - 1
  expect(source[openBrace]).toBe('{')
  let depth = 0
  let i = openBrace
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(openBrace, i + 1)
}

describe('daemon.ts wiring — /api/recordings (plan 94 §4.9, §5 step 94.5)', () => {
  test('daemon.ts imports createRecordingRoutes from ./api/recordings', () => {
    expect(daemonSource).toContain("import { createRecordingRoutes } from './api/recordings'")
  })

  test("createApp({...}) passes a real recordingRoutes — without it, /api/recordings 404s through http.ts's catch-all forever", () => {
    const call = extractCall(daemonSource, 'const app = createApp({')
    expect(call).toContain('recordingRoutes:')
    expect(call).toContain('createRecordingRoutes(')
    // `workspace: workspaceStore` and `recording: recordingService` — not fresh instances, not
    // `undefined` — the SAME ones every other route/service in this file already shares (F16/F11).
    expect(call).toContain('workspace: workspaceStore')
    expect(call).toContain('recording: recordingService')
  })
})
