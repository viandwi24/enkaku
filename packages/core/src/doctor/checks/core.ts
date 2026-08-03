import type { Check } from '../types'

/** Only runs when a core actually answers — the standalone (no-core) run reports `skip` here (plan 41 §3.4, §6.5/§6.6). */
export const coreCheck: Check = {
  id: 'core',
  title: 'Core',
  async run(ctx) {
    const result = await ctx.core.probe()
    if (!result.running) {
      return { status: 'skip', observed: 'no running core detected — the checks above ran standalone' }
    }
    const { health, quarantined } = result
    const observed = `core v${health.version} reachable (${health.mode} mode), ${health.deviceCount} device(s), ${quarantined.length} quarantined, up ${Math.round(health.uptimeMs / 1000)}s`
    if (quarantined.length > 0) {
      return {
        status: 'warn',
        observed,
        remedy: `${quarantined.length} device(s) quarantined: ${quarantined
          .map((d) => `${d.label} (${d.reason})`)
          .join(', ')} — check cables/power, then clear the quarantine from the Devices page`,
      }
    }
    return { status: 'ok', observed }
  },
}
