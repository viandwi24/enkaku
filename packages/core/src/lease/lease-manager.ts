import type { DeviceStatus } from '@enkaku/protocol'
import type { DeviceStateMachine } from '../device/state-machine'
import type { JobStore } from '../queue/job-store'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

export type LeaseType = 'manual' | 'job'

export interface Lease {
  deviceId: string
  type: LeaseType
  /** manual: clientId koneksi WS; job: jobId. */
  holder: string
  acquiredAt: number
  expiresAt: number
}

export interface LeaseConfig {
  jobTtlSec: number
  manualIdleTimeoutSec: number
  reaperIntervalMs: number
}

export interface LeaseManager {
  acquireManual(deviceId: string, clientId: string): Lease
  touchManual(deviceId: string, clientId: string): void
  releaseManual(deviceId: string, clientId: string, reason?: 'idle_timeout' | 'disconnected' | 'quarantined'): boolean
  releaseAllForClient(clientId: string): void
  noteJobLease(deviceId: string, jobId: string, ttlSec: number): void
  clearJobLease(deviceId: string): void
  getLease(deviceId: string): Lease | null
  /** Otorisasi input sesuai aturan spec §10.1 / plan 04 §4.1. */
  checkInputAllowed(deviceId: string, clientId: string): { ok: true } | { ok: false; code: string; message: string }
  startReaper(): void
  stopReaper(): void
}

export interface LeaseManagerDeps {
  states: DeviceStateMachine
  jobStore: JobStore
  config: LeaseConfig
  log: Logger
  /** Job lease expired → job failed + device force-release (spec §10.2). */
  onJobLeaseExpired: (jobId: string, reason: string) => void
  onManualRevoked?: (deviceId: string, reason: 'idle_timeout' | 'disconnected' | 'quarantined') => void
  onDeviceFreed?: () => void
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

export function createLeaseManager(deps: LeaseManagerDeps): LeaseManager {
  const { states, jobStore, config, log } = deps
  const leases = new Map<string, Lease>()
  let reaper: ReturnType<typeof setInterval> | null = null

  function release(deviceId: string, reason?: 'idle_timeout' | 'disconnected' | 'quarantined'): boolean {
    const lease = leases.get(deviceId)
    if (!lease || lease.type !== 'manual') return false
    leases.delete(deviceId)
    states.apply(deviceId, 'MANUAL_RELEASED')
    if (reason) deps.onManualRevoked?.(deviceId, reason)
    deps.onDeviceFreed?.()
    return true
  }

  return {
    acquireManual(deviceId, clientId) {
      const existing = leases.get(deviceId)
      if (existing?.type === 'manual' && existing.holder === clientId) {
        existing.expiresAt = nowSec() + config.manualIdleTimeoutSec
        return existing
      }
      const status = states.current(deviceId)
      if (status === null) throw new EnkakuError('device_not_found', `device tidak ada: ${deviceId}`)
      if (status === 'busy') {
        throw new EnkakuError('device_busy', 'Device is running an automation job')
      }
      if (status === 'manual') {
        throw new EnkakuError('device_busy', 'Device sedang dikontrol client lain')
      }
      if (status !== 'idle') {
        throw new EnkakuError('device_unavailable', `device tidak tersedia (status ${status})`)
      }
      const applied = states.apply(deviceId, 'MANUAL_ACQUIRED')
      if (!applied) throw new EnkakuError('device_busy', 'device keburu dipakai pihak lain')
      const lease: Lease = {
        deviceId,
        type: 'manual',
        holder: clientId,
        acquiredAt: nowSec(),
        expiresAt: nowSec() + config.manualIdleTimeoutSec,
      }
      leases.set(deviceId, lease)
      log.info(`lease manual diambil: device=${deviceId} client=${clientId}`)
      return lease
    },

    touchManual(deviceId, clientId) {
      const lease = leases.get(deviceId)
      if (lease?.type === 'manual' && lease.holder === clientId) {
        lease.expiresAt = nowSec() + config.manualIdleTimeoutSec
      }
    },

    releaseManual(deviceId, clientId, reason) {
      const lease = leases.get(deviceId)
      if (!lease || lease.type !== 'manual' || lease.holder !== clientId) return false
      log.info(`lease manual dilepas: device=${deviceId} client=${clientId}${reason ? ` (${reason})` : ''}`)
      return release(deviceId, reason)
    },

    releaseAllForClient(clientId) {
      for (const [deviceId, lease] of [...leases]) {
        if (lease.type === 'manual' && lease.holder === clientId) release(deviceId)
      }
    },

    noteJobLease(deviceId, jobId, ttlSec) {
      leases.set(deviceId, {
        deviceId,
        type: 'job',
        holder: jobId,
        acquiredAt: nowSec(),
        expiresAt: nowSec() + ttlSec,
      })
    },

    clearJobLease(deviceId) {
      const lease = leases.get(deviceId)
      if (lease?.type === 'job') leases.delete(deviceId)
    },

    getLease(deviceId) {
      return leases.get(deviceId) ?? null
    },

    checkInputAllowed(deviceId, clientId) {
      const status = states.current(deviceId) as DeviceStatus | null
      if (status === null) return { ok: false, code: 'device_not_found', message: 'device tidak ada' }
      if (status === 'busy') {
        return { ok: false, code: 'device_busy', message: 'Device is running an automation job' }
      }
      if (status === 'offline' || status === 'quarantined') {
        return { ok: false, code: 'device_unavailable', message: `device tidak tersedia (status ${status})` }
      }
      if (status === 'idle') {
        return { ok: false, code: 'no_lease', message: 'ambil kontrol (lease.acquire) dulu sebelum mengirim input' }
      }
      const lease = leases.get(deviceId)
      if (!lease || lease.type !== 'manual') {
        return { ok: false, code: 'no_lease', message: 'tidak ada lease manual aktif' }
      }
      if (lease.holder !== clientId) {
        return { ok: false, code: 'not_lease_holder', message: 'device dikontrol client lain' }
      }
      return { ok: true }
    },

    startReaper() {
      if (reaper) return
      reaper = setInterval(() => {
        // Job lease expired → job failed + device force-release (spec §10.2).
        for (const job of jobStore.expiredRunning()) {
          log.warn(`lease job expired: ${job.id} (device ${job.deviceId})`)
          deps.onJobLeaseExpired(job.id, 'lease expired')
        }
        // Manual lease idle-timeout.
        const now = nowSec()
        for (const [deviceId, lease] of [...leases]) {
          if (lease.type === 'manual' && lease.expiresAt < now) {
            log.info(`lease manual idle-timeout: device=${deviceId}`)
            release(deviceId, 'idle_timeout')
          }
        }
      }, config.reaperIntervalMs)
    },

    stopReaper() {
      if (reaper) clearInterval(reaper)
      reaper = null
    },
  }
}
