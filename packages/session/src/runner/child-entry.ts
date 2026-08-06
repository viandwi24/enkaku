/**
 * Entry point child process job (plan 05 §4.5). Two launch shapes:
 *   dev:      bun <child-entry.ts> <bundlePath>
 *   compiled: <enkaku-binary> --job-child <bundlePath>  (the core's entrypoint
 *             dispatches on the flag and imports this module)
 *
 * The child only executes the script bundle; every device access goes over IPC to
 * parent. This is crash containment (spec §11.3) — NOT a security sandbox:
 * the bundle has full fs and network access as the core's OS user.
 */
import { FindOutcomeSchema } from '@enkaku/protocol'
import { ChildToParentSchema, ParentToChildSchema, type ChildToParent, type JobsCall, type KvCall, type ParentToChild } from './ipc'
import { createJobsApiFor } from './jobs-client'
import { createKvApiFor } from './kv-client'

const HEARTBEAT_MS = 10_000

type Level = 'debug' | 'info' | 'warn' | 'error'

function send(msg: ChildToParent): void {
  const parsed = ChildToParentSchema.safeParse(msg)
  if (!parsed.success) return
  process.send?.(parsed.data)
}

const pendingDevice = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingArtifact = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()
const pendingKv = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingJobs = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const abortController = new AbortController()
let aborted: 'timeout' | 'cancelled' | 'hung' | 'crashed' | 'startup-timeout' | null = null

function request<T>(call: Omit<Extract<ChildToParent, { t: 'device.call' }>, 't' | 'callId'>): Promise<T> {
  const callId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    if (aborted) {
      reject(new Error(`job di-abort (${aborted})`))
      return
    }
    pendingDevice.set(callId, { resolve: resolve as (v: unknown) => void, reject })
    send({ t: 'device.call', callId, ...call } as ChildToParent)
  })
}

function kvRequest<T>(call: KvCall): Promise<T> {
  const callId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    if (aborted) {
      reject(new Error(`job di-abort (${aborted})`))
      return
    }
    pendingKv.set(callId, { resolve: resolve as (v: unknown) => void, reject })
    send({ t: 'kv.call', callId, ...call } as ChildToParent)
  })
}

const kvApi = { device: createKvApiFor('device', kvRequest), global: createKvApiFor('global', kvRequest) }

function jobsRequest<T>(call: JobsCall): Promise<T> {
  const callId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    if (aborted) {
      reject(new Error(`job di-abort (${aborted})`))
      return
    }
    pendingJobs.set(callId, { resolve: resolve as (v: unknown) => void, reject })
    send({ t: 'jobs.call', callId, ...call } as ChildToParent)
  })
}

// `jobsApi` is built inside `runScript`, once `init.job` is known — NOT here
// at module scope like `kvApi` above — because `ctx.jobs.trigger()`'s
// default idempotency key needs the caller's own `{ id, attempt }` (plan 81
// §3.3, §4.2), which does not exist until the `init` message arrives.

function saveArtifact(kind: 'screenshot' | 'file', label: string, dataBase64?: string, ext?: string): Promise<void> {
  const callId = crypto.randomUUID()
  return new Promise<void>((resolve, reject) => {
    pendingArtifact.set(callId, { resolve, reject })
    send({ t: 'artifact.save', callId, kind, label, ...(dataBase64 ? { dataBase64 } : {}), ...(ext ? { ext } : {}) })
  })
}

const log = (level: Level) => (msg: string, fields?: Record<string, unknown>) =>
  send({ t: 'log', level, msg, ...(fields ? { fields } : {}) })

const deviceApi = {
  tap: (target: unknown) => request<void>({ method: 'tap', args: { target } } as never),
  swipe: (from: unknown, to: unknown, ms = 300, opts?: { curvature?: number; easing?: string }) =>
    request<void>({
      method: 'swipe',
      args: {
        from,
        to,
        ms,
        ...(opts?.curvature !== undefined ? { curvature: opts.curvature } : {}),
        ...(opts?.easing !== undefined ? { easing: opts.easing } : {}),
      },
    } as never),
  scroll: (opts: { direction: string; distance?: number; from?: unknown }) =>
    request<void>({ method: 'scroll', args: opts } as never),
  fling: (opts: { direction: string; strength?: string }) => request<void>({ method: 'fling', args: opts } as never),
  type: (text: string, opts?: { perCharMs?: [number, number]; instant?: boolean }) =>
    request<void>({
      method: 'type',
      args: {
        text,
        ...(opts?.perCharMs !== undefined ? { perCharMs: opts.perCharMs } : {}),
        ...(opts?.instant !== undefined ? { instant: opts.instant } : {}),
      },
    } as never),
  key: (code: unknown) => request<void>({ method: 'key', args: { code } } as never),
  // Plan 74 §3.5, §4.3: the parent's 'find' device.call always answers with
  // the full `FindOutcome` now (not-found/rejected-oversized/ambiguous
  // travel beside the node) — `find()` narrows it to `UiNode | null` so a
  // bundle published before this plan keeps working unchanged (criterion
  // 10); `findDetailed()` below is the new call that hands back the reason.
  find: async (sel: unknown) => {
    const outcome = FindOutcomeSchema.parse(await request<unknown>({ method: 'find', args: { sel } } as never))
    return outcome.ok ? outcome.node : null
  },
  findDetailed: async (sel: unknown) => FindOutcomeSchema.parse(await request<unknown>({ method: 'find', args: { sel } } as never)),
  dump: () => request<unknown>({ method: 'dump', args: {} } as never),
  waitFor: (sel: unknown, opts?: { timeout?: number; intervalMs?: number }) =>
    request<unknown>({
      method: 'waitFor',
      args: { sel, timeout: opts?.timeout ?? 10_000, intervalMs: opts?.intervalMs ?? 1_000 },
    } as never),
  screenshot: async () => {
    const base64 = await request<string>({ method: 'screenshot', args: {} } as never)
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  },
  app: {
    launch: (pkg: string, opts?: { activity?: string }) =>
      request<void>({ method: 'app.launch', args: { pkg, ...(opts?.activity ? { activity: opts.activity } : {}) } } as never),
    forceStop: (pkg: string) => request<void>({ method: 'app.forceStop', args: { pkg } } as never),
  },
  clipboard: {
    get: () => request<string>({ method: 'clipboard.get', args: {} } as never),
    set: (text: string, opts?: { paste?: boolean }) =>
      request<void>({ method: 'clipboard.set', args: { text, paste: opts?.paste ?? false } } as never),
  },
  install: (opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean }) =>
    request<{ package: string | null; durationMs: number; output: string }>({ method: 'install', args: opts } as never),
  push: (opts: { artifactId: string; remotePath: string }) => request<void>({ method: 'push', args: opts } as never),
  pull: (opts: { remotePath: string }) =>
    request<{ artifactId: string; bytes: number }>({ method: 'pull', args: opts } as never),
}

const artifactApi = {
  screenshot: (label: string) => saveArtifact('screenshot', label),
  file: (label: string, data: Uint8Array | string, opts?: { ext?: string }) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return saveArtifact('file', label, btoa(binary), opts?.ext)
  },
}

process.on('message', (raw: unknown) => {
  const parsed = ParentToChildSchema.safeParse(raw)
  if (!parsed.success) return
  const msg: ParentToChild = parsed.data
  if (msg.t === 'device.result') {
    const waiter = pendingDevice.get(msg.callId)
    if (!waiter) return
    pendingDevice.delete(msg.callId)
    if (msg.ok) waiter.resolve(msg.value)
    else waiter.reject(Object.assign(new Error(msg.error?.message ?? 'device call failed'), { code: msg.error?.code }))
  } else if (msg.t === 'artifact.result') {
    const waiter = pendingArtifact.get(msg.callId)
    if (!waiter) return
    pendingArtifact.delete(msg.callId)
    if (msg.ok) waiter.resolve()
    else waiter.reject(new Error(msg.error?.message ?? 'failed to save the artifact'))
  } else if (msg.t === 'kv.result') {
    const waiter = pendingKv.get(msg.callId)
    if (!waiter) return
    pendingKv.delete(msg.callId)
    if (msg.ok) waiter.resolve(msg.value)
    else waiter.reject(Object.assign(new Error(msg.error?.message ?? 'kv call failed'), { code: msg.error?.code }))
  } else if (msg.t === 'jobs.result') {
    const waiter = pendingJobs.get(msg.callId)
    if (!waiter) return
    pendingJobs.delete(msg.callId)
    if (msg.ok) waiter.resolve(msg.value)
    else waiter.reject(Object.assign(new Error(msg.error?.message ?? 'jobs call failed'), { code: msg.error?.code }))
  } else if (msg.t === 'abort') {
    aborted = msg.reason
    abortController.abort()
    // Every pending device call is cancelled so the active phase stops quickly.
    for (const [, waiter] of pendingDevice) waiter.reject(new Error(`job di-abort (${msg.reason})`))
    pendingDevice.clear()
    for (const [, waiter] of pendingKv) waiter.reject(new Error(`job di-abort (${msg.reason})`))
    pendingKv.clear()
    for (const [, waiter] of pendingJobs) waiter.reject(new Error(`job di-abort (${msg.reason})`))
    pendingJobs.clear()
  } else if (msg.t === 'init') {
    void runScript(msg)
  }
})

/**
 * Each phase races the abort signal: a script that never checks the signal
 * (say `await sleep(60_000)`) still stops counting at the timeout — its result
 * is discarded and the job is marked TIMEOUT.
 */
function raceAbort<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (aborted) {
        reject(Object.assign(new Error(`job di-abort (${aborted})`), { code: 'ABORTED' }))
        return
      }
      abortController.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error(`job di-abort (${aborted})`), { code: 'ABORTED' })),
      )
    }),
  ])
}

function toScriptError(err: unknown, phase: string): { code: string; message: string; phase: string; stack?: string } {
  if (err instanceof Error) {
    const code = 'code' in err ? String((err as { code: unknown }).code) : 'SCRIPT_ERROR'
    return { code, message: err.message, phase, ...(err.stack ? { stack: err.stack } : {}) }
  }
  return { code: 'SCRIPT_ERROR', message: String(err), phase }
}

/** Dev shape: the bundle is argv[2]; compiled shape: it follows `--job-child`. */
function resolveBundlePath(): string | undefined {
  const flag = process.argv.indexOf('--job-child')
  return flag >= 0 ? process.argv[flag + 1] : process.argv[2]
}

interface BundleDef {
  id: string
  version: string
  timeout?: number
  retries?: number
  params: { parse(v: unknown): unknown }
  prepare?: (ctx: unknown) => Promise<void>
  run: (ctx: unknown) => Promise<unknown>
  finish?: (ctx: unknown) => Promise<void>
  reset?: { packages: string[]; clearData?: boolean }
}

/**
 * A `definePlugin()` bundle's default export (plan 82 §3.2, §4.1) — `scripts`
 * is the tell: a standalone `ScriptDefinition` has `run`, a plugin has
 * `scripts` (an array of members, each shaped like `BundleDef` minus its own
 * `id`/`version`, which the plugin stamps at build time — see
 * `@enkaku/sdk`'s `definePlugin`). Duplicated here as a small structural
 * check rather than adding `@enkaku/sdk` as a dependency of this package for
 * one shape test — `@enkaku/sdk`'s own `isPlugin()` does the identical
 * check.
 */
interface PluginDef {
  id: string
  version: string
  scripts: BundleDef[]
  reset?: { packages?: string[] }
}

function isPluginBundle(def: unknown): def is PluginDef {
  return !!def && typeof def === 'object' && Array.isArray((def as { scripts?: unknown }).scripts)
}

/**
 * Which member of a plugin bundle to run (plan 82 §3.2) — set by the
 * process that spawns this child (`@enkaku/session`'s `isolation.ts`,
 * `SpawnRequest.scriptExportId`, threaded into `req.env`). Undefined for
 * EVERY standalone bundle, and for a plugin bundle spawned by a caller that
 * has not been updated to set it yet — see this file's own module doc and
 * `isolation.ts`'s for the current state of that wiring.
 */
function resolveScriptExportId(): string | undefined {
  return process.env.ENKAKU_SCRIPT_EXPORT_ID || undefined
}

/**
 * Import the bundle and report `ready` — done ONCE, at process start, rather
 * than gated on the `init` message (plan 35 §4.3 ordering problem). The
 * bundle path is already known from argv, so the child does not need any IPC
 * message to begin this: the parent reads `ready` (now carrying `reset`),
 * runs the pre-job reset, and only then sends `init`. The child holds
 * through the SAME `init` handshake that already existed — `runScript` below
 * just waits on this promise instead of doing the import itself.
 *
 * A failure here is reported as a `result` directly (there is no attempt to
 * run without a bundle), so the parent's existing `result` handling covers
 * it without needing `init` to ever be sent.
 */
async function loadBundle(): Promise<{ bundlePath: string; def: BundleDef } | undefined> {
  const bundlePath = resolveBundlePath()
  try {
    if (!bundlePath) throw new Error('no bundlePath was given to the child')
    const mod = (await import(bundlePath)) as { default?: unknown }
    const rawDef = mod.default

    // Plan 82 §3.2 — a pre-plan bundle (`rawDef.run` is a function, no
    // `scripts` array) takes the standalone branch exactly as before this
    // plan (criterion 27); a plugin bundle selects one member by
    // `scriptExportId` and its `reset.packages` are the PLUGIN's own merged
    // with the selected member's (§3.10, criterion 5) — deduplicated, order
    // preserved, plugin-level packages first.
    let def: BundleDef | undefined
    let pluginResetPackages: string[] = []
    if (isPluginBundle(rawDef)) {
      const exportId = resolveScriptExportId()
      const selected = exportId ? rawDef.scripts.find((s) => s.id === exportId) : undefined
      if (!selected) {
        throw Object.assign(
          new Error(exportId ? `plugin bundle has no script "${exportId}"` : 'a plugin bundle requires ENKAKU_SCRIPT_EXPORT_ID to select a script'),
          { code: 'BAD_BUNDLE' },
        )
      }
      def = selected
      pluginResetPackages = rawDef.reset?.packages ?? []
    } else {
      def = rawDef as BundleDef | undefined
    }

    if (!def || typeof def.run !== 'function') {
      throw Object.assign(new Error('the bundle has no default ScriptDefinition export'), { code: 'BAD_BUNDLE' })
    }
    const mergedResetPackages = [...new Set([...pluginResetPackages, ...(def.reset?.packages ?? [])])]
    const reset = def.reset || pluginResetPackages.length > 0 ? { packages: mergedResetPackages, ...(def.reset?.clearData !== undefined ? { clearData: def.reset.clearData } : {}) } : undefined
    send({
      t: 'ready',
      scriptId: def.id,
      version: def.version,
      ...(typeof def.timeout === 'number' ? { timeoutMs: def.timeout } : {}),
      ...(typeof def.retries === 'number' ? { retries: def.retries } : {}),
      ...(reset ? { reset } : {}),
    })
    return { bundlePath, def }
  } catch (err) {
    const e = toScriptError(err, 'run')
    send({ t: 'result', ok: false, error: e, finishRan: false })
    return undefined
  }
}

/** Kicked off immediately at process start — see `loadBundle` above. */
const loaded = loadBundle()

async function runScript(init: Extract<ParentToChild, { t: 'init' }>): Promise<void> {
  let finishRan = false
  let failure: { code: string; message: string; phase: string; stack?: string } | undefined
  let value: unknown

  const heartbeat = setInterval(() => send({ t: 'heartbeat' }), HEARTBEAT_MS)

  try {
    const bundle = await loaded
    // `loadBundle` already reported the failure as a `result` — nothing left to do.
    if (!bundle) return
    const { def } = bundle

    const ctx: Record<string, unknown> = {
      device: deviceApi,
      artifact: artifactApi,
      log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
      job: init.job,
      params: undefined,
      kv: kvApi,
      // Bound to THIS attempt (plan 81 §3.3, §4.2) — see the module-level
      // comment above `jobsRequest` for why this cannot be built earlier.
      jobs: createJobsApiFor(jobsRequest, { id: init.job.id, attempt: init.job.attempt }),
    }

    if (init.mode === 'finish-only') {
      // Fresh process: `finish` may depend on ctx and nothing else (stateless).
      ctx.error = init.priorError ?? { code: 'UNKNOWN', message: 'the previous attempt died', phase: 'run' }
      try {
        ctx.params = def.params.parse(init.params)
      } catch {
        ctx.params = init.params
      }
      if (def.finish) {
        send({ t: 'phase', phase: 'finish' })
        await def.finish(ctx)
      }
      finishRan = true
      send({ t: 'result', ok: false, error: ctx.error as never, finishRan })
      return
    }

    try {
      ctx.params = def.params.parse(init.params)
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code: 'PARAMS_INVALID' })
    }

    let currentPhase: 'prepare' | 'run' = 'prepare'
    try {
      if (def.prepare) {
        send({ t: 'phase', phase: 'prepare' })
        await raceAbort(def.prepare(ctx))
      }
      currentPhase = 'run'
      send({ t: 'phase', phase: 'run' })
      value = await raceAbort(def.run(ctx))
    } catch (err) {
      failure = aborted
        ? { code: aborted === 'crashed' ? 'APP_CRASHED' : 'TIMEOUT', message: `job di-abort (${aborted})`, phase: 'timeout' }
        : toScriptError(err, currentPhase)
    }

    if (def.finish) {
      if (failure) ctx.error = failure
      send({ t: 'phase', phase: 'finish' })
      try {
        await def.finish(ctx)
      } catch (err) {
        // The first error wins; a failure in finish is only logged.
        const finishErr = toScriptError(err, 'finish')
        log('error')(`finish failed: ${finishErr.message}`)
        if (!failure) failure = finishErr
      }
    }
    finishRan = true
    send({
      t: 'result',
      ok: !failure,
      ...(failure ? { error: failure } : { value }),
      finishRan,
    })
  } catch (err) {
    const e = toScriptError(err, 'run')
    send({ t: 'result', ok: false, error: e, finishRan })
  } finally {
    clearInterval(heartbeat)
    // Give the last message time to flush before the process exits.
    setTimeout(() => process.exit(0), 50)
  }
}
