import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * Spec §16's "Job overhead (spawn → prepare) < 3 seconds — child process plus
 * attaching ui-server" NFR (plan 84's audit: nothing in the repo ever
 * asserted any of the seven §16 numbers, this one included).
 *
 * The real number is two components: (1) `Bun.spawn`-ing the job's child
 * process and importing its script bundle (device-free — `@enkaku/session`'s
 * `JobRunner`/`child-entry.ts`, plan 05 §4.5), and (2) attaching the ui-server
 * inspector to a real phone (needs hardware — adb install/instrument/forward,
 * `@enkaku/drivers`'s `UiServerLauncher`). `@enkaku/session` is owned by
 * another workstream in progress on this branch, so this file does not
 * import its child-entry machinery — it measures the device-free half in
 * isolation, as a real proxy rather than a fabricated one: a bare `Bun.spawn`
 * of a script that dynamically `import()`s an ESM module and reports back
 * over stdout, the same two operations `child-entry.ts`'s `loadBundle()`
 * performs before it ever touches a device. Component (2) — the "attaching
 * ui-server" half — is measured on real hardware by
 * `scripts/bench-device-nfrs.ts` (ENKAKU_TEST_DEVICE=1), whose "ui-server
 * attach" stage times `UiServerLauncher.start()` end to end.
 *
 * This is deliberately NOT a test of `child-entry.ts` itself — it does not
 * import `@enkaku/session` — so a regression here catches process-spawn and
 * dynamic-import overhead going sideways (a bloated compiled binary, a slow
 * module resolution path), not a regression inside the runner's own IPC
 * handshake.
 */
describe('child-process spawn overhead (spec §16 "job overhead: spawn → prepare < 3s", device-free half)', () => {
  test('Bun.spawn + dynamic import of a small ESM module completes well under budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enkaku-spawn-bench-'))
    try {
      const modPath = join(dir, 'mod.mjs')
      writeFileSync(modPath, 'export default { id: "bench-script", version: "1.0.0" }\n')
      const childPath = join(dir, 'child.mjs')
      // Mirrors `child-entry.ts`'s `loadBundle()`: spawn, dynamically import
      // the bundle, and report back — nothing device-related happens before
      // this point in the real runner either (plan 35 §4.3's `ready`
      // handshake fires right after this same import).
      writeFileSync(
        childPath,
        `const mod = await import(${JSON.stringify(modPath)})\nprocess.stdout.write(JSON.stringify(mod.default))\n`,
      )

      const SAMPLES = 5
      const samplesMs: number[] = []
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now()
        const proc = Bun.spawn(['bun', 'run', childPath], { stdout: 'pipe', stderr: 'pipe' })
        const out = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        samplesMs.push(performance.now() - t0)
        expect(exitCode).toBe(0)
        expect(JSON.parse(out)).toEqual({ id: 'bench-script', version: '1.0.0' })
      }
      samplesMs.sort((a, b) => a - b)
      const p50 = samplesMs[Math.floor(samplesMs.length / 2)] ?? 0

      // Generous on purpose (repo convention, plan 85 §7.4-style thresholds):
      // a cold `bun run` of a trivial script is typically well under 300ms.
      // 3000ms is roughly a 10x regression, the failure mode that actually
      // shipped once for the ui-server number this NFR sits next to.
      expect(p50).toBeLessThan(3_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
