import { join } from 'node:path'
import { UiautomatorDumpInspector } from '@enkaku/drivers'
import type { Subprocess } from 'bun'
import { createDeviceExecutor } from '../device-executor'
import { SessionError } from '../errors'
import type { Logger } from '../logger'
import type { SessionManager } from '../manager'
import type { DeviceSession } from '../session'
import type { ArtifactSink } from '../types'
import { ChildToParentSchema, DeviceCallSchema, type ChildToParent, type ParentToChild } from './ipc'
import { createJobLogger, type JobLogEntry } from './job-logger'
import { resolveIsolation, type IsolationProvider } from './isolation'

const DEFAULT_TIMEOUT_MS = 300_000
const FINISH_GRACE_MS = 30_000
const FINISH_ONLY_TIMEOUT_MS = 30_000
const SIGKILL_DELAY_MS = 5_000
/** Child dianggap hang kalau tidak ada message apa pun selama ini. */
const SILENCE_LIMIT_MS = 30_000

export interface ScriptFailure {
  code: string
  message: string
  phase: string
}

export interface AttemptOutcome {
  ok: boolean
  value?: unknown
  error?: ScriptFailure
  finishRan: boolean
}

/**
 * Job yang siap dijalankan — bundle sudah dimaterialkan oleh host.
 * Runner tidak mengenal database maupun tabel `scripts`.
 */
export interface JobSpec {
  id: string
  deviceId: string
  /** Path file bundle ESM yang akan di-import child. */
  bundlePath: string
  params: unknown
}

export interface JobRunnerDeps {
  /** Isolasi eksekusi job — child process (local) atau container (cloud). */
  isolation?: IsolationProvider
  /** Root untuk file log job (host menentukan lokasinya). */
  logDir: string
  sessions: SessionManager
  /** Dibuat per job — penomoran urut artifact bersifat per-job. */
  artifacts: (jobId: string) => ArtifactSink
  log: Logger
  onLog: (entry: JobLogEntry) => void
  onArtifact: (jobId: string, artifact: { kind: string; label: string; path: string; sizeBytes: number }) => void
  onPhase: (jobId: string, attempt: number, phase: 'prepare' | 'run' | 'finish') => void
  /** Perpanjang lease job (heartbeat child / aktivitas device). */
  heartbeat: (jobId: string) => void
}

export interface RunningJob {
  abort(reason: 'timeout' | 'cancelled' | 'hung'): void
}

export interface JobRunner {
  execute(job: JobSpec): Promise<{ ok: boolean; value?: unknown; error?: ScriptFailure }>
  abort(jobId: string, reason: 'timeout' | 'cancelled' | 'hung'): boolean
}

const childEntryPath = join(import.meta.dir, 'child-entry.ts')
const defaultIsolation = resolveIsolation()

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const active = new Map<string, RunningJob>()

  async function runAttempt(opts: {
    job: JobSpec
    attempt: number
    bundlePath: string
    session: DeviceSession
    timeoutMs: number
    mode: 'full' | 'finish-only'
    priorError?: ScriptFailure
    logger: ReturnType<typeof createJobLogger>
    artifacts: ArtifactSink
    aborter: { current: ((reason: 'timeout' | 'cancelled' | 'hung') => void) | null }
    /** Diisi dari message `ready` — timeout & retries milik ScriptDefinition. */
    meta?: { timeoutMs?: number; retries?: number }
  }): Promise<AttemptOutcome> {
    const { job, attempt, bundlePath, session, timeoutMs, mode, logger, artifacts } = opts

    const execDevice = createDeviceExecutor({ session })

    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false
      let finishRan = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      let graceTimer: ReturnType<typeof setTimeout> | null = null
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let abortReason: 'timeout' | 'cancelled' | 'hung' | null = null

      const isolation = deps.isolation ?? defaultIsolation
      const child: Subprocess<'ignore', 'pipe', 'pipe'> = isolation.spawn(
        { entryPath: childEntryPath, bundlePath, jobId: job.id, env: { ENKAKU_JOB_ID: job.id } },
        handleChildMessage,
      )

      const send = (msg: ParentToChild) => {
        try {
          child.send(msg)
        } catch {
          // child sudah mati — diselesaikan lewat jalur exit
        }
      }

      const finish = (outcome: AttemptOutcome) => {
        if (settled) return
        settled = true
        for (const t of [killTimer, timeoutTimer, graceTimer, silenceTimer]) if (t) clearTimeout(t)
        opts.aborter.current = null
        try {
          child.kill()
        } catch {
          // sudah mati
        }
        resolve(outcome)
      }

      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          logger.append('error', 'runner', `child diam > ${SILENCE_LIMIT_MS}ms — dianggap hang`)
          doAbort('hung')
        }, SILENCE_LIMIT_MS)
      }

      const doAbort = (reason: 'timeout' | 'cancelled' | 'hung') => {
        if (settled || abortReason) return
        abortReason = reason
        logger.append('warn', 'runner', `abort attempt ${attempt}: ${reason}`)
        send({ t: 'abort', reason })
        // Beri kesempatan `finish` jalan; lewat grace → SIGTERM lalu SIGKILL.
        graceTimer = setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* sudah mati */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              /* sudah mati */
            }
          }, SIGKILL_DELAY_MS)
        }, FINISH_GRACE_MS)
      }
      opts.aborter.current = doAbort

      function handleChildMessage(raw: unknown): void {
        const parsed = ChildToParentSchema.safeParse(raw)
        if (!parsed.success) return
        const msg = parsed.data as ChildToParent
        resetSilenceTimer()
        deps.heartbeat(job.id)

        if (msg.t === 'ready') {
          logger.append('debug', 'runner', `child siap: ${msg.scriptId}@${msg.version}`)
          if (opts.meta) {
            if (msg.timeoutMs !== undefined) opts.meta.timeoutMs = msg.timeoutMs
            if (msg.retries !== undefined) opts.meta.retries = msg.retries
          }
          // Timeout efektif = def.timeout (kalau script menetapkannya).
          if (mode === 'full' && msg.timeoutMs !== undefined && msg.timeoutMs !== timeoutMs) {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            timeoutTimer = setTimeout(() => doAbort('timeout'), msg.timeoutMs)
          }
        } else if (msg.t === 'phase') {
          logger.append('info', 'runner', `fase ${msg.phase} (attempt ${attempt})`)
          deps.onPhase(job.id, attempt, msg.phase)
          if (msg.phase === 'finish') finishRan = true
        } else if (msg.t === 'log') {
          logger.append(msg.level, 'script', msg.msg, msg.fields)
        } else if (msg.t === 'heartbeat') {
          // sudah ditangani resetSilenceTimer + heartbeat lease
        } else if (msg.t === 'device.call') {
          const call = DeviceCallSchema.safeParse(msg)
          if (!call.success) {
            send({ t: 'device.result', callId: msg.callId, ok: false, error: { code: 'BAD_CALL', message: 'call tidak valid' } })
            return
          }
          void execDevice(call.data)
            .then((value) => send({ t: 'device.result', callId: msg.callId, ok: true, value }))
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err)
              const code = err instanceof SessionError ? err.code : 'DEVICE_CALL_FAILED'
              send({ t: 'device.result', callId: msg.callId, ok: false, error: { code, message } })
            })
        } else if (msg.t === 'artifact.save') {
          void (async () => {
            try {
              const data =
                msg.kind === 'screenshot'
                  ? // Screenshot diambil DI CORE → urutannya mengikuti per-device queue.
                    await (session.inspector ?? new UiautomatorDumpInspector(session.transport)).screenshot()
                  : Uint8Array.from(Buffer.from(msg.dataBase64 ?? '', 'base64'))
              const saved = await artifacts.save({
                kind: msg.kind,
                label: msg.label,
                data,
                ...(msg.ext ? { ext: msg.ext } : {}),
              })
              deps.onArtifact(job.id, { kind: msg.kind, label: msg.label, ...saved })
              send({ t: 'artifact.result', callId: msg.callId, ok: true })
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              const code = err instanceof SessionError ? err.code : 'ARTIFACT_FAILED'
              logger.append('error', 'runner', `artifact "${msg.label}" gagal: ${message}`)
              send({ t: 'artifact.result', callId: msg.callId, ok: false, error: { code, message } })
            }
          })()
        } else if (msg.t === 'result') {
          if (abortReason) {
            // Parent yang memutuskan abort → parent juga yang menentukan
            // alasannya; laporan child (sukses maupun gagal) diabaikan.
            finish({
              ok: false,
              error: {
                code: abortReason === 'cancelled' ? 'CANCELLED' : 'TIMEOUT',
                message: `attempt di-abort (${abortReason})`,
                phase: 'timeout',
              },
              finishRan: msg.finishRan || finishRan,
            })
            return
          }
          finish({
            ok: msg.ok,
            ...(msg.value !== undefined ? { value: msg.value } : {}),
            ...(msg.error ? { error: { code: msg.error.code, message: msg.error.message, phase: msg.error.phase } } : {}),
            finishRan: msg.finishRan || finishRan,
          })
        }
      }

      // stdout/stderr child → job log (script boleh console.log).
      void pipeLines(child.stdout, (line) => logger.append('info', 'stdout', line))
      void pipeLines(child.stderr, (line) => logger.append('warn', 'stderr', line))

      void child.exited.then((code) => {
        if (settled) return
        finish({
          ok: false,
          error: abortReason
            ? { code: abortReason === 'cancelled' ? 'CANCELLED' : 'TIMEOUT', message: `child di-abort (${abortReason})`, phase: 'timeout' }
            : { code: 'CHILD_CRASHED', message: `child exit ${code} tanpa mengirim result`, phase: 'run' },
          finishRan,
        })
      })

      resetSilenceTimer()
      timeoutTimer = setTimeout(() => doAbort('timeout'), timeoutMs)

      send({
        t: 'init',
        mode,
        job: { id: job.id, attempt, deviceId: job.deviceId },
        params: job.params ?? {},
        ...(opts.priorError ? { priorError: opts.priorError } : {}),
      })
    })
  }

  return {
    abort(jobId, reason) {
      const running = active.get(jobId)
      if (!running) return false
      running.abort(reason)
      return true
    },

    async execute(job) {
      const logger = createJobLogger({ dataDir: deps.logDir, jobId: job.id, onEntry: deps.onLog })
      const artifacts = deps.artifacts(job.id)
      const aborter: { current: ((reason: 'timeout' | 'cancelled' | 'hung') => void) | null } = { current: null }
      active.set(job.id, { abort: (reason) => aborter.current?.(reason) })

      let outcome: AttemptOutcome = { ok: false, finishRan: false, error: { code: 'NOT_RUN', message: 'belum dijalankan', phase: 'run' } }
      let session: DeviceSession | null = null
      const noopFrame = () => {}

      try {
        const bundlePath = job.bundlePath
        session = await deps.sessions.acquire(job.deviceId, noopFrame)

        // timeout/retries hanya diketahui setelah child mem-`import` bundle;
        // child mengirimkannya lewat message `ready`, lalu dipakai untuk
        // attempt berikutnya.
        const meta: { timeoutMs?: number; retries?: number } = {}
        let attempt = 0
        for (;;) {
          attempt += 1
          const timeoutMs = meta.timeoutMs ?? DEFAULT_TIMEOUT_MS
          logger.append('info', 'runner', `attempt ${attempt} mulai`)
          outcome = await runAttempt({
            job,
            attempt,
            bundlePath,
            session,
            timeoutMs,
            mode: 'full',
            logger,
            artifacts,
            aborter,
            meta,
          })
          if (outcome.ok) break

          // `finish` WAJIB jalan (spec §11.2): child mati sebelum finish →
          // attempt finish-only di process baru (ctx.error terisi).
          if (!outcome.finishRan) {
            logger.append('warn', 'runner', 'finish belum jalan — menjalankan finish-only attempt')
            await runAttempt({
              job,
              attempt,
              bundlePath,
              session,
              timeoutMs: FINISH_ONLY_TIMEOUT_MS,
              mode: 'finish-only',
              ...(outcome.error ? { priorError: outcome.error } : {}),
              logger,
              artifacts,
              aborter,
            }).catch(() => undefined)
          }

          // Cancel TIDAK di-retry (plan 05 §4.7).
          if (outcome.error?.code === 'CANCELLED') break
          if (attempt >= 1 + (meta.retries ?? 0)) break
          logger.append('warn', 'runner', `attempt ${attempt} gagal — mencoba ulang`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.append('error', 'runner', `runner gagal: ${message}`)
        outcome = { ok: false, finishRan: false, error: { code: 'RUNNER_FAILED', message, phase: 'run' } }
      } finally {
        active.delete(job.id)
        if (session) deps.sessions.release(job.deviceId, noopFrame)
        const { bytes } = await logger.close()
        await artifacts
          .save({ kind: 'log', label: 'job', data: bytes, ext: 'log' })
          .then((saved) => deps.onArtifact(job.id, { kind: 'log', label: 'job', ...saved }))
          .catch(() => undefined)
      }

      return {
        ok: outcome.ok,
        ...(outcome.value !== undefined ? { value: outcome.value } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      }
    },
  }
}

async function pipeLines(stream: ReadableStream<Uint8Array> | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd()
        buffer = buffer.slice(idx + 1)
        if (line.length > 0) onLine(line)
      }
    }
    if (buffer.trim().length > 0) onLine(buffer.trim())
  } catch {
    // stream ditutup saat child mati — normal
  }
}
