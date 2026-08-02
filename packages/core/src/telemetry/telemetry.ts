import { z } from 'zod'
import type { Logger } from '../util/logger'

/**
 * Opt-in telemetry (plan 10 §4.4, spec §18) — **off by default**. No
 * data leaves before someone explicitly turns it on in Settings.
 *
 * What it sends when enabled is deliberately minimal and carries no identity:
 * core version, OS/arch, device count, job counts (aggregated), crash error
 * codes. Never: device serials, script names, log contents, or any IP address
 * we keep.
 */
export const TelemetryPayloadSchema = z.object({
  installId: z.string(),
  coreVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  deviceCount: z.number().int(),
  jobCount24h: z.number().int(),
  errorCodes: z.array(z.string()),
  at: z.number().int(),
})
export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>

export interface Telemetry {
  /** Sends once when opted in; a no-op otherwise. */
  report(snapshot: { deviceCount: number; jobCount24h: number; errorCodes: string[] }): Promise<void>
  /** A preview of exactly what would be sent — Studio shows it before anyone agrees. */
  preview(snapshot: { deviceCount: number; jobCount24h: number; errorCodes: string[] }): TelemetryPayload
}

export function createTelemetry(deps: {
  enabled: () => boolean
  installId: string
  coreVersion: string
  endpoint?: string
  log: Logger
}): Telemetry {
  const build = (s: { deviceCount: number; jobCount24h: number; errorCodes: string[] }): TelemetryPayload => ({
    installId: deps.installId,
    coreVersion: deps.coreVersion,
    platform: process.platform,
    arch: process.arch,
    deviceCount: s.deviceCount,
    jobCount24h: s.jobCount24h,
    errorCodes: s.errorCodes,
    at: Math.floor(Date.now() / 1000),
  })

  return {
    preview: build,
    async report(snapshot) {
      if (!deps.enabled()) return
      const endpoint = deps.endpoint ?? process.env.ENKAKU_TELEMETRY_URL
      if (!endpoint) {
        deps.log.debug('telemetry is enabled but no endpoint is set — skipping')
        return
      }
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(build(snapshot)),
          signal: AbortSignal.timeout(5000),
        })
      } catch (err) {
        // Telemetry must never disturb farm operations.
        deps.log.debug(`telemetry failed to send: ${String(err)}`)
      }
    },
  }
}
