import { z } from 'zod'
import type { Logger } from '../util/logger'

/**
 * Telemetry opt-in (plan 10 §4.4, spec §18) — **default OFF**. Tidak ada
 * data yang dikirim sebelum user menyalakannya secara eksplisit di Settings.
 *
 * Yang dikirim saat aktif sengaja minimal & tidak mengandung identitas:
 * versi core, OS/arch, jumlah device, jumlah job (agregat), kode error crash.
 * Tidak ada: serial device, nama script, isi log, alamat IP yang kita simpan.
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
  /** Kirim sekali kalau opt-in aktif; no-op kalau tidak. */
  report(snapshot: { deviceCount: number; jobCount24h: number; errorCodes: string[] }): Promise<void>
  /** Ringkasan yang akan dikirim — Studio menampilkannya sebelum user setuju. */
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
        deps.log.debug('telemetry aktif tapi endpoint belum di-set — dilewati')
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
        // Telemetry tidak boleh mengganggu operasi farm.
        deps.log.debug(`telemetry gagal dikirim: ${String(err)}`)
      }
    },
  }
}
