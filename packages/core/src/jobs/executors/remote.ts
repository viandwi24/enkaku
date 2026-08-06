import type { ArtifactInfo } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db'
import { scripts, type JobRow } from '../../db/schema'
import type { TunnelRouter } from '../../tunnel/router'
import { EnkakuError } from '../../util/errors'
import type { Logger } from '../../util/logger'
import type { ExecutorContext, JobExecutor } from '../executor'

export interface RemoteJobHooks {
  onLog: (jobId: string, entry: { level: string; source: string; msg: string; ts: number }) => void
  onArtifact: (jobId: string, artifact: ArtifactInfo) => void
  onPhase: (jobId: string, attempt: number | undefined, phase: 'prepare' | 'run' | 'finish') => void
  heartbeat: (jobId: string) => void
}

interface PendingJob {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export interface RemoteJobBridge {
  executor: JobExecutor
  /** Called by the router on receiving job.progress from a node. */
  handleProgress(payload: {
    jobId: string
    kind: 'phase' | 'log' | 'artifact' | 'result'
    phase?: 'prepare' | 'run' | 'finish'
    attempt?: number
    log?: { level: string; source: string; msg: string; ts: number }
    artifact?: { label: string; kind: string; ext?: string; dataBase64: string }
    result?: { ok: boolean; value?: unknown; error?: { code: string; message: string; phase?: string } }
  }): void
}

/**
 * The executor for node-owned devices (plan 12 §4.5).
 *
 * The bundle is shipped to the node and **the exact same runner** as local
 * mode executes it there — timeouts, retries, and the guarantee that `finish`
 * always runs included. The control plane only waits for word and writes it to
 * the DB, so Studio cannot tell a local job from a remote one.
 *
 * Lease heartbeat: every `job.progress` extends the lease. A dropped tunnel
 * means no progress, which expires the lease, which fails the job through the
 * Plan 04 mechanism. No special path that could become its own bug source.
 */
export function createRemoteJobBridge(deps: {
  db: Db
  router: TunnelRouter
  hooks: RemoteJobHooks
  saveArtifact: (jobId: string, a: { kind: string; label: string; ext?: string; data: Uint8Array }) => Promise<ArtifactInfo>
  log: Logger
}): RemoteJobBridge {
  const pending = new Map<string, PendingJob>()

  return {
    executor: {
      validateParams: (params) => params ?? {},

      run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
        const script = deps.db.select().from(scripts).where(eq(scripts.id, job.scriptId)).get()
        if (!script) throw new EnkakuError('unknown_script', `no such script: ${job.scriptId}`)
        if (!script.enabled) throw new EnkakuError('script_disabled', `the script ${script.name} is disabled`)

        const sent = deps.router.sendToDevice(job.deviceId, {
          type: 'job.dispatch',
          payload: { jobId: job.id, deviceId: job.deviceId, bundle: script.bundle, params: job.params ?? {} },
        } as never)
        if (!sent) throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')

        ctx.signal.addEventListener('abort', () => {
          deps.router.sendToDevice(job.deviceId, {
            type: 'job.cancel.forward',
            payload: { jobId: job.id },
          } as never)
        })

        return new Promise<unknown>((resolve, reject) => {
          pending.set(job.id, { resolve, reject })
        })
      },
    },

    handleProgress(payload) {
      const { jobId } = payload
      deps.hooks.heartbeat(jobId)

      if (payload.kind === 'log' && payload.log) {
        deps.hooks.onLog(jobId, payload.log)
        return
      }
      if (payload.kind === 'phase' && payload.phase) {
        deps.hooks.onPhase(jobId, payload.attempt, payload.phase)
        return
      }
      if (payload.kind === 'artifact' && payload.artifact) {
        const a = payload.artifact
        void deps
          .saveArtifact(jobId, {
            kind: a.kind,
            label: a.label,
            ...(a.ext ? { ext: a.ext } : {}),
            data: Uint8Array.from(Buffer.from(a.dataBase64, 'base64')),
          })
          .then((info) => deps.hooks.onArtifact(jobId, info))
          .catch((err) => deps.log.warn(`failed to store remote artifact ${a.label}: ${String(err)}`))
        return
      }
      if (payload.kind === 'result' && payload.result) {
        const waiter = pending.get(jobId)
        pending.delete(jobId)
        if (!waiter) return
        if (payload.result.ok) {
          waiter.resolve(payload.result.value ?? null)
        } else {
          const err = payload.result.error ?? { code: 'SCRIPT_FAILED', message: 'the job failed on the node' }
          waiter.reject(
            Object.assign(new EnkakuError(err.code, err.message), {
              code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
              // Same as the local executor (plan 60 §3.4): a cloud job's
              // Summary must be able to say where it failed too.
              ...('phase' in err && err.phase ? { phase: err.phase } : {}),
            }),
          )
        }
      }
    },
  }
}
