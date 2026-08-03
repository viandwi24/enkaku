import type { Check } from '../types'

/**
 * Reachability and version ONLY. This check — and the whole doctor package —
 * must NEVER issue the adb server-reset command that is forbidden repo-wide
 * (spec §10.4, plan 41 §6.10): port 5037 is shared with Android Studio, and
 * a diagnostic that resets someone else's adb server is not a diagnostic.
 * If nothing answers, that is a `warn` (the server starts itself on
 * demand), never a reason to intervene.
 */
export const adbServerCheck: Check = {
  id: 'adb-server',
  title: 'adb server',
  async run(ctx) {
    const result = await ctx.adbServer.check()
    if (result.reachable) {
      return { status: 'ok', observed: `adb server reachable on 127.0.0.1:5037 (version ${result.version ?? 'unknown'})` }
    }
    return {
      status: 'warn',
      observed: `no adb server reachable on 127.0.0.1:5037${result.error ? `: ${result.error}` : ''}`,
      remedy:
        'it starts automatically the first time the core (or any adb command) runs — if Android Studio already owns port 5037, that is fine, they share one server',
    }
  },
}
