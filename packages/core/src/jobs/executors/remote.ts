import type { ArtifactInfo, ResultOutcome } from '@enkaku/protocol'
import type { Db } from '../../db'
import type { JobRow } from '../../db/schema'
import { findShadowedPublished, type ScriptRegistry } from '../../scripts/registry'
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
  /**
   * Plan 97 §3.3, §3.4, §3.8, §4.5, F6 — captured from `ctx.onResultOutcome`
   * when `run()` is called (below), the same closure indirection `resolve`/
   * `reject` already use to bridge an async tunnel round-trip back into this
   * executor's `Promise`. Undefined for a node too old to send `outcome` at
   * all (plan 59's "an older bundle/node meeting a newer core is a normal
   * condition" rule) — `handleProgress` below then simply never calls it.
   */
  onResultOutcome?: (outcome: ResultOutcome) => void
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
    result?: { ok: boolean; value?: unknown; error?: { code: string; message: string; phase?: string }; outcome?: ResultOutcome }
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
 * Job heartbeat: every `job.progress` extends it. A dropped tunnel means no
 * progress, which expires the heartbeat, which fails the job through the
 * Plan 04 mechanism. No special path that could become its own bug source.
 */
export function createRemoteJobBridge(deps: {
  db: Db
  registry: ScriptRegistry
  router: TunnelRouter
  hooks: RemoteJobHooks
  saveArtifact: (jobId: string, a: { kind: string; label: string; ext?: string; data: Uint8Array }) => Promise<ArtifactInfo>
  log: Logger
}): RemoteJobBridge {
  const pending = new Map<string, PendingJob>()

  return {
    executor: {
      validateParams: (params) => params ?? {},

      async run(job: JobRow, ctx: ExecutorContext): Promise<unknown> {
        // Plan 82 §3.3: through the registry, not a direct `scripts` table
        // read — a node-owned device runs a published plugin member the
        // same way the local executor does (a dev entry too, though
        // scheduling one is out of scope per §2; an ad-hoc run is not).
        const entry = deps.registry.get(job.scriptId)
        if (!entry) throw new EnkakuError('unknown_script', `no such script: ${job.scriptId}`)
        if (!entry.enabled) throw new EnkakuError('script_disabled', `the script ${entry.name} is disabled`)

        const shadowed = findShadowedPublished(deps.registry, entry)
        if (shadowed) {
          ctx.log.info(
            `running the DEV build of "${entry.name}" (${entry.version}, owned by ${entry.devOwner ?? 'a dev session'}) — this shadows the published "${shadowed.name}@${shadowed.version}"`,
          )
        }

        // The registry always hands back a materialised FILE (db-backed or
        // dev-slot-backed alike, plan 82 §4.5) — read its text back out for
        // the tunnel wire, which carries the bundle inline.
        const bundlePath = await deps.registry.bundlePath(entry)
        const bundle = await Bun.file(bundlePath).text()

        const sent = deps.router.sendToDevice(job.deviceId, {
          type: 'job.dispatch',
          payload: {
            jobId: job.id,
            deviceId: job.deviceId,
            bundle,
            params: job.params ?? {},
            ...(entry.exportId ? { scriptExportId: entry.exportId } : {}),
          },
        } as never)
        if (!sent) throw new EnkakuError('node_offline', 'the node that owns this device is currently disconnected')

        ctx.signal.addEventListener('abort', () => {
          deps.router.sendToDevice(job.deviceId, {
            type: 'job.cancel.forward',
            payload: { jobId: job.id },
          } as never)
        })

        return new Promise<unknown>((resolve, reject) => {
          pending.set(job.id, { resolve, reject, onResultOutcome: ctx.onResultOutcome })
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
          // Plan 97 §3.3, §4.5, F6 — before resolving, so the executor's own
          // `run()` (still returning a bare value, per `executor.ts`'s own
          // doc comment on why `onResultOutcome` exists rather than widening
          // that return type) has already reported the verdict by the time
          // `executor-host.ts`'s `.then()` reads it.
          if (payload.result.outcome !== undefined) waiter.onResultOutcome?.(payload.result.outcome)
          waiter.resolve(payload.result.value ?? null)
        } else {
          // Plan 97 §3.5, step 97.4, F6 — same as the local path: a
          // `partial` outcome/value from a node's own `finish()` salvage
          // must still reach `ctx.onResultOutcome` before the rejection, or
          // 97.4 would only ever fix local jobs.
          if (payload.result.outcome !== undefined) waiter.onResultOutcome?.(payload.result.outcome)
          const err = payload.result.error ?? { code: 'SCRIPT_FAILED', message: 'the job failed on the node' }
          waiter.reject(
            Object.assign(new EnkakuError(err.code, err.message), {
              code: err.code === 'CANCELLED' ? 'job_cancelled' : err.code,
              // Same as the local executor (plan 60 §3.4): a cloud job's
              // Summary must be able to say where it failed too.
              ...('phase' in err && err.phase ? { phase: err.phase } : {}),
              // Same as the local executor (script.ts) — riding the thrown
              // error, since this executor's `run()` also rejects on failure.
              ...(payload.result.value !== undefined ? { partialResult: payload.result.value } : {}),
            }),
          )
        }
      }
    },
  }
}
