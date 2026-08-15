import type { Check } from '../types'

/**
 * "Is adb stuck?" (plan 88 §3.9, §4.7, fixes F21/F23) — reads the live
 * core's own `device/adb-health.ts` verdict and reports it. This check MUST
 * NEVER restart, stop, or start the adb server itself — that is F21's own
 * rule ("a diagnostic that resets someone else's adb server is not a
 * diagnostic"), carried forward from `adb-server.ts` in this same
 * directory. The remedy below only ever NAMES the Tools page's restart
 * action (plan 88 §5 step 88.8); it never performs it.
 */
export const adbHealthCheck: Check = {
  id: 'adb-health',
  title: 'adb server health',
  async run(ctx) {
    const health = await ctx.adbHealth.probe()
    if (health === null) {
      return { status: 'skip', observed: 'no running core detected — adb server health is only known while the core is up' }
    }

    const rtt = health.versionRttMs === null ? 'no reply' : `${health.versionRttMs}ms`
    const windowSummary =
      health.window.execs > 0
        ? `${health.window.timeouts}/${health.window.execs} adb command(s) timed out over the last ${health.window.seconds}s`
        : `no adb commands observed in the last ${health.window.seconds}s`
    const observedBase = `host:version ${rtt} — ${windowSummary}`

    if (health.status === 'ok') {
      return { status: 'ok', observed: observedBase }
    }

    const evidence = health.symptoms.map((s) => s.detail).join('; ')
    const observed = `${observedBase} — ${evidence}`

    if (health.status === 'degraded') {
      return { status: 'warn', observed, remedy: remedyFor(health.symptoms.map((s) => s.symptom)) }
    }

    // 'stuck'
    return { status: 'fail', observed, remedy: remedyFor(health.symptoms.map((s) => s.symptom)) }
  },
}

/**
 * One remedy per symptom set, in the SAME voice as `adb-server.ts`'s own
 * ("it starts automatically...") and `host-adb.ts`'s own ("stop it by
 * hand..."): concrete, and honest about whether restarting actually helps
 * (plan 88 §3.9's own "Restart helps?" column). Joined when more than one
 * symptom is present, worst-first.
 */
function remedyFor(symptoms: string[]): string {
  const parts: string[] = []
  if (symptoms.includes('server-unresponsive')) {
    parts.push(
      'adb has stopped answering host:version — this is the case restarting actually fixes; use the Tools page\'s "Restart adb server" action',
    )
  }
  if (symptoms.includes('transports-wedged')) {
    parts.push(
      'more than one device has a long streak of adb timeouts, which points at the shared server rather than any one phone — the Tools page restart is worth trying',
    )
  }
  if (symptoms.includes('reconnect-ineffective')) {
    parts.push(
      'a device has outlasted several automatic reconnect attempts while still offline — try that device\'s own Reconnect action first; a single stuck device is not a server problem, so restarting adb may not help',
    )
  }
  if (symptoms.includes('timeout-storm')) {
    parts.push(
      'a farm-wide spike in adb command timeouts — this can be the adb server OR a saturated USB hub/controller; restarting adb from the Tools page is worth trying, but if the storm returns immediately, suspect the USB hardware instead',
    )
  }
  if (symptoms.includes('server-unreachable')) {
    parts.push(
      'no adb server answered right now — this usually self-heals on the next adb command; if it does not, check whether something else on this machine is holding port 5037 before assuming the core is broken',
    )
  }
  return parts.join('. ')
}
