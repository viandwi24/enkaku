import type { Check } from '../types'

/**
 * Orphaned `adb`/`adb.exe` children (plan 85 §3.4, §5 85.6) — the process
 * registry in `packages/core/src/device/host-adb.ts` kills every child it
 * spawned on `daemon.stop()`, but that only covers processes the *current*
 * core is still tracking. A core that was killed with `-9`, crashed, or (on
 * Windows) had its terminal window closed leaves its `adb.exe` children
 * running with nothing left to reap them — one plausible reason a dead
 * lock's port stays bound (F14's second half).
 *
 * This check counts `adb`/`adb.exe` processes on the host directly (so it
 * still says something useful with no core running at all) and, when a core
 * IS running and reporting its own bookkeeping, subtracts what the core
 * accounts for — its tracked children (`host-adb.ts`'s `stats().running` +
 * `.longLived`) plus one for the adb server itself, which `host-adb.ts`
 * does not spawn or track. Whatever is left over is unexplained.
 */
export const hostAdbCheck: Check = {
  id: 'host-adb',
  title: 'Host adb processes',
  async run(ctx) {
    const count = await ctx.hostAdb.countAdbProcesses()
    if (count === null) {
      return { status: 'skip', observed: 'could not enumerate adb processes on this platform (no ps/tasklist)' }
    }
    if (count === 0) {
      return { status: 'ok', observed: 'no adb process is running' }
    }

    const core = await ctx.hostAdb.probeCoreStats()
    if (core === null) {
      if (count === 1) {
        return { status: 'ok', observed: '1 adb process running (the adb server) — no core is reporting its own bookkeeping to compare against' }
      }
      return {
        status: 'warn',
        observed: `${count} adb processes running, no core reporting its own bookkeeping to compare against`,
        remedy:
          'if no enkaku core is meant to be running right now, these are likely leftovers from a previous session — check `Get-Process adb` (Windows) or `ps aux | grep adb` (unix) and stop them by hand if they are not needed',
      }
    }

    // +1 accounts for the adb server itself, which `host-adb.ts` never
    // spawns or tracks — its children are per-device CLI invocations only.
    const accountedFor = core.running + core.longLived + 1
    const unexplained = Math.max(0, count - accountedFor)
    const observed = `${count} adb process(es) running, ${accountedFor} accounted for by the core (${core.running} in-flight CLI + ${core.longLived} long-lived + 1 adb server)`
    if (unexplained > 0) {
      return {
        status: 'warn',
        observed: `${observed} — ${unexplained} unexplained`,
        remedy:
          'an unexplained adb.exe usually outlived a crashed or force-killed core — stop it by hand (`Get-Process adb` / `ps aux | grep adb`) if it is not needed',
      }
    }
    return { status: 'ok', observed }
  },
}
