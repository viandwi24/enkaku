import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `createAdbStatsRoutes`'s new `commandConsole` dep (`api/adb-stats.ts`,
 * plan 93 §5 step 93.12) is fully covered by this package's own unit tests
 * (`adb-stats.test.ts`) — the zero-fill default when the dep is absent, and
 * the pass-through when it is present, are both proven directly against
 * the route. What that file can never prove on its own is that a REAL boot
 * ever supplies the dep: `packages/core/src/daemon.ts` is explicitly
 * outside this step's file ownership (it is plan 93 step 93.10's own file,
 * and the step's brief lists it among the files this step must not touch),
 * so the one-line addition to `daemon.ts`'s existing `createAdbStatsRoutes({
 * ... })` call — the object literal at the `adbStatsRoutes:` key, right
 * beside its sibling `video: () => ...` line — could not be made here.
 *
 * This is the same "self-detecting, not self-breaking" shape
 * `saved-commands-mount.test.ts` (step 93.6) and `daemon-wiring.test.ts`
 * establish for a contested production file: this test reads `daemon.ts`'s
 * source text only (`readFileSync`, never an import of the module), so a
 * failing assertion here can never itself cause a typecheck or boot
 * failure. Until the line below lands, `GET /api/adb/stats` reports the
 * `commandConsole` block zero-filled forever, on a live farm, even while
 * command runs are genuinely in flight — the same "inert until wired"
 * failure mode step 93.5's own status paragraph named for
 * `commandRunStore`.
 *
 * The exact edit, verbatim (see this step's own report for the identical
 * text, for the coordinator to relay or apply directly): inside
 * `daemon.ts`'s `adbStatsRoutes: createAdbStatsRoutes({ ... })` call,
 * beside the existing `video: () => ...` line:
 *
 *   commandConsole: () => commandRunner?.stats() ?? null,
 */

const daemonSource = readFileSync(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')

describe('daemon.ts wiring — GET /api/adb/stats commandConsole block (plan 93 §5 step 93.12)', () => {
  test('daemon.ts passes commandConsole through to createAdbStatsRoutes — without it, the block is always zero-filled on a real boot', () => {
    expect(daemonSource).toContain('commandConsole: () => commandRunner?.stats() ?? null')
  })
})
