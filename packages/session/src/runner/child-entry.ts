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
import { DANGEROUS_FIELD_NAMES, FindOutcomeSchema, RESULT_LIMITS, type ResultOutcome, type RuntimeEnvelope } from '@enkaku/protocol'
import { ChildToParentSchema, ParentToChildSchema, type ChildToParent, type JobsCall, type KvCall, type ParentToChild } from './ipc'
import { createJobsApiFor } from './jobs-client'
import { createChildPluginContext } from '../plugin-context'

const HEARTBEAT_MS = 10_000

type Level = 'debug' | 'info' | 'warn' | 'error'

function send(msg: ChildToParent): void {
  const parsed = ChildToParentSchema.safeParse(msg)
  if (!parsed.success) return
  process.send?.(parsed.data)
}

const pendingDevice = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingArtifact = new Map<string, { resolve: (v: { artifactId: string }) => void; reject: (e: unknown) => void }>()
const pendingKv = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingJobs = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingFarm = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const abortController = new AbortController()
let aborted: 'timeout' | 'cancelled' | 'hung' | 'crashed' | 'startup-timeout' | null = null

/**
 * `ctx.onAssist` registrations (plan 91 §3.6, §4.8) — a list, not a single
 * slot, so a script that calls `ctx.onAssist` more than once (unusual, but
 * never silently drops a caller's registration the way overwriting a single
 * slot would). Never cleared mid-process: this child runs exactly one
 * attempt, so there is no "next job" to leak into.
 */
const assistHandlers: Array<(e: { at: number; actor: string | null }) => void> = []

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

/**
 * `ctx.farm`'s child side (plan 109 §3.1, §4.3, step 109.1) — the same
 * `callId` round trip `kvRequest` above already uses.
 */
function farmRequest(capability: string, input: unknown): Promise<unknown> {
  const callId = crypto.randomUUID()
  return new Promise<unknown>((resolve, reject) => {
    if (aborted) {
      reject(new Error(`job di-abort (${aborted})`))
      return
    }
    pendingFarm.set(callId, { resolve, reject })
    send({ t: 'farm.call', callId, capability, ...(input !== undefined ? { input } : {}) })
  })
}

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

// `jobsApi` is built inside `runScript`, once `init.job` is known, because
// `ctx.jobs.trigger()`'s default idempotency key needs the caller's own
// `{ id, attempt }` (plan 81 §3.3, §4.2), which does not exist until the
// `init` message arrives. The shared plugin context (`storage`/`log`/`farm`,
// plan 109 step 109.1) is built there for the same reason — its
// `storage.forDevice` has to know which device this job holds, so it can
// refuse every other one (plan 108 §3.1 G4).

function saveArtifact(kind: 'screenshot' | 'file', label: string, dataBase64?: string, ext?: string): Promise<{ artifactId: string }> {
  const callId = crypto.randomUUID()
  return new Promise<{ artifactId: string }>((resolve, reject) => {
    pendingArtifact.set(callId, { resolve, reject })
    send({ t: 'artifact.save', callId, kind, label, ...(dataBase64 ? { dataBase64 } : {}), ...(ext ? { ext } : {}) })
  })
}

const log = (level: Level) => (msg: string, fields?: Record<string, unknown>) =>
  send({ t: 'log', level, msg, ...(fields ? { fields } : {}) })

const deviceApi = {
  tap: (target: unknown) => request<void>({ method: 'tap', args: { target } } as never),
  /*
   * Plan 94 step 94.2's four replay verbs, forwarded HERE — the line they were
   * missing from until 2026-08-27.
   *
   * All four were declared on `DeviceApi` (`packages/sdk/src/types.ts`),
   * accepted by the wire schema (`ipc.ts`'s `DEVICE_CALL_ARGS`), and
   * implemented by the executor (`device-executor.ts`'s `'tapNorm'` /
   * `'swipeNorm'` / `'longPress'` / `'gesture'` cases). Only this object — the
   * bridge a script actually calls THROUGH — never listed them. So a call
   * typechecked against the declared interface, published, verified, and died
   * at runtime with `ctx.device.tapNorm is not a function`.
   *
   * That is not a hypothetical: `packages/sdk/src/define-recording.ts` calls
   * `device.tapNorm(...)` for every point tap, so **every recording containing
   * one failed on its first replay** — and `plugins/youtube-automation-pack`
   * hit it on its own first run against hardware, which is how it was found.
   *
   * This file's own comment on `app.launch` already records the identical
   * defect once (`url` declared everywhere and forwarded nowhere): "A field
   * list spelled out in three places will drift; this is the one that decides."
   * A method list in three places drifts the same way, and
   * `child-entry-surface.test.ts` now fails when it does.
   */
  tapNorm: (pos: unknown, opts?: { holdMs?: number }) =>
    request<void>({ method: 'tapNorm', args: { pos, ...(opts?.holdMs !== undefined ? { holdMs: opts.holdMs } : {}) } } as never),
  swipeNorm: (from: unknown, to: unknown, ms: number) => request<void>({ method: 'swipeNorm', args: { from, to, ms } } as never),
  longPress: (target: unknown, ms: number) => request<void>({ method: 'longPress', args: { target, ms } } as never),
  gesture: (samples: unknown) => request<void>({ method: 'gesture', args: { samples } } as never),
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
    // Every field the wire schema accepts has to be forwarded HERE too. `url` was added to
    // `AppLaunchArgsSchema` and to `DeviceApi`, but not to this line, so it typechecked, published,
    // and silently dropped the address on its way across the IPC boundary — the script asked Chrome
    // to open a page, the executor received a bare launch, and the run then failed on a page that
    // had never been navigated. A field list spelled out in three places will drift; this is the
    // one that decides.
    launch: (pkg: string, opts?: { activity?: string; url?: string }) =>
      request<void>({
        method: 'app.launch',
        args: {
          pkg,
          ...(opts?.activity ? { activity: opts.activity } : {}),
          ...(opts?.url ? { url: opts.url } : {}),
        },
      } as never),
    forceStop: (pkg: string, opts?: { clearRecents?: boolean }) =>
      request<void>({
        method: 'app.forceStop',
        args: { pkg, ...(opts?.clearRecents ? { clearRecents: true } : {}) },
      } as never),
  },
  clipboard: {
    get: () => request<string>({ method: 'clipboard.get', args: {} } as never),
    set: (text: string, opts?: { paste?: boolean }) =>
      request<void>({ method: 'clipboard.set', args: { text, paste: opts?.paste ?? false } } as never),
  },
  install: (opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean }) =>
    request<{ package: string | null; durationMs: number; output: string }>({ method: 'install', args: opts } as never),
  push: (opts: { artifactId: string; remotePath: string; mediaScan?: 'auto' | 'always' | 'never' }) =>
    request<{ mediaScan: { ran: boolean; method: 'scan_file' | 'scan_volume' | null; ms: number; error?: string } }>({
      method: 'push',
      args: opts,
    } as never),
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
    if (msg.ok) {
      // The parent always sends `artifactId` alongside `ok: true` (see
      // `ipc.ts`'s own comment on `artifact.result`) — a defensive check
      // rather than a cast, so a parent that somehow did not (an older build
      // mid-upgrade) fails loudly instead of the script silently believing
      // it holds an id it does not.
      if (!msg.artifactId) waiter.reject(new Error('the parent saved the artifact but reported no artifactId'))
      else waiter.resolve({ artifactId: msg.artifactId })
    } else waiter.reject(new Error(msg.error?.message ?? 'failed to save the artifact'))
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
  } else if (msg.t === 'farm.result') {
    const waiter = pendingFarm.get(msg.callId)
    if (!waiter) return
    pendingFarm.delete(msg.callId)
    if (msg.ok) waiter.resolve(msg.value)
    else waiter.reject(Object.assign(new Error(msg.error?.message ?? 'farm call failed'), { code: msg.error?.code }))
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
    for (const [, waiter] of pendingFarm) waiter.reject(new Error(`job di-abort (${msg.reason})`))
    pendingFarm.clear()
  } else if (msg.t === 'assist') {
    // NOT an abort (plan 91 §3.6) — the job keeps running exactly as before;
    // a script that never called `ctx.onAssist` is unaffected. Delivered to
    // every registration, in order.
    for (const cb of assistHandlers) cb({ at: msg.at, actor: msg.actor })
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

/**
 * Plan 97 §3.8, V3 — a safety valve for the WALK itself, not the real bound
 * (the byte cap already runs first — see `buildResultOutcome` below — so a
 * value reaching this walk is already at most `maxResultBytes`, which is at
 * most 1 MiB per `job.maxResultBytes`'s own ceiling). Generous enough that
 * no honest result — even a maximally wide, maximally deep one within that
 * byte budget — ever trips it.
 */
const MAX_RESULT_WALK_VISITS = 50_000

/**
 * Iterative, not recursive (a `JSON.stringify`-safe value can still nest
 * deeply while staying small — a stack-based walk cannot overflow the call
 * stack the way a recursive one could). Returns the dot/bracket path of the
 * first `__proto__`/`constructor`/`prototype` OWN key found at any depth, or
 * `null` when none exists. Checked with `Object.keys` — the same set
 * `JSON.stringify` itself would visit — so this mirrors exactly what will
 * end up in the stored text (plan 97 §3.8, V3): a prototype already hijacked
 * via `obj['__proto__'] = x` (rather than a genuine own property, e.g. from
 * `JSON.parse` or a spread) never shows up as an own key at all, and neither
 * would it appear in the JSON this value is about to become — nothing to
 * flag, because nothing dangerous will be READ back out of the stored text.
 */
function findDangerousKey(value: unknown): string | null {
  const stack: Array<{ node: unknown; path: string }> = [{ node: value, path: '' }]
  let visits = 0
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: string }
    visits++
    if (visits > MAX_RESULT_WALK_VISITS) break
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) stack.push({ node: node[i], path: `${path}[${i}]` })
    } else if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        if (DANGEROUS_FIELD_NAMES.has(key)) return path ? `${path}.${key}` : key
        stack.push({ node: (node as Record<string, unknown>)[key], path: path ? `${path}.${key}` : key })
      }
    }
  }
  return null
}

/**
 * Plan 97 §3.3, §3.4, §3.8, H2 — measure, then check, then store, in that
 * order (this step's own title): measuring after validating would run the
 * expensive schema check on a payload that was always going to be refused
 * for its size, and walking before measuring would walk a payload that was
 * never going to be sent at all.
 *
 * `sendValue: false` means exactly two things happened: the value never
 * crossed IPC (`oversize` — F10, F11), or it never COULD (a circular
 * reference — V2, H2, F10: `process.send` uses the same JSON serialisation
 * `JSON.stringify` does here, so a value that cannot survive one cannot
 * survive the other; letting it reach `send()` unchecked is what produced
 * today's silent hang to the 30s silence timer). Every other outcome sends
 * the value verbatim — never `safeParse`'s coerced/stripped `.data` (F25) —
 * because the verdict decides `status`, never the stored value (§3.3).
 *
 * `statusWhenNoSchema` (plan 97 §3.5, §4.2, step 97.4) — the status this
 * function reports when `resultSchema` is absent. `runScript`'s two success-
 * path callers below keep the default, `'undeclared'`. The two `finish()`-
 * salvage call sites (main-branch failure, and the finish-only re-attempt)
 * always pass `undefined` for `resultSchema` itself — a salvage is NEVER
 * checked against `def.result`, even when the script declared one (§3.5:
 * "there is no honest lenient schema") — and pass `'partial'` here, so they
 * still get every size/circularity/prototype-pollution guard this function
 * already gives a normal result (F10/V1/V2/V3 do not stop mattering just
 * because the value came from `finish()` instead of `run()`).
 */
function buildResultOutcome(
  value: unknown,
  resultSchema: BundleDef['result'],
  maxResultBytes: number,
  statusWhenNoSchema: 'undeclared' | 'partial' = 'undeclared',
): { outcome: ResultOutcome; sendValue: boolean } {
  // 1. Serialise inside a try. `process.send` itself would throw on exactly
  //    the same input (F10) — doing it here, first, turns that crash into a
  //    reported, terminal `invalid` instead of a silent hang (H2).
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return {
      outcome: {
        status: 'invalid',
        // Nothing here to measure — the value never became text at all, and
        // that is the one honest number for a payload that "could not be
        // stored" (this outcome's own issue message).
        bytes: 0,
        issues: [{ path: '', message: 'the result contains a circular reference and could not be stored' }],
      },
      sendValue: false,
    }
  }

  // 2. Measure — BEFORE any check runs, so an oversized payload never pays
  //    for the walk or the schema validation below.
  const bytes = new TextEncoder().encode(serialized).length
  if (bytes > maxResultBytes) {
    return { outcome: { status: 'oversize', bytes }, sendValue: false }
  }

  // 3. Walk for a prototype-hijack field name (V3) — the value still gets
  //    stored (as inert JSON text no walker ever dereferences); only the
  //    verdict changes, and the path is named so an operator can find it.
  const dangerousPath = findDangerousKey(value)
  if (dangerousPath !== null) {
    return {
      outcome: {
        status: 'invalid',
        bytes,
        issues: [
          {
            path: dangerousPath,
            message: `the result contains a reserved field name at "${dangerousPath}" ("__proto__"/"constructor"/"prototype" are refused as a prototype-pollution risk)`,
          },
        ],
      },
      sendValue: true,
    }
  }

  // 4. Only now — check against the declared schema, if any. The VERDICT
  //    decides `status`; `value` (never `parsed.data`) is what gets sent and
  //    stored either way (§3.3, F25).
  if (!resultSchema) {
    return { outcome: { status: statusWhenNoSchema, bytes }, sendValue: true }
  }
  const parsed = resultSchema.safeParse(value)
  if (parsed.success) {
    return { outcome: { status: 'valid', bytes }, sendValue: true }
  }
  const issues = parsed.error.issues.slice(0, RESULT_LIMITS.maxIssues).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
  return { outcome: { status: 'invalid', bytes, issues }, sendValue: true }
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
  /**
   * Plan 98 §3.1, §4.7, §5 step 98.4 — already folded from `timeout`/
   * `retries` by `defineScript`/`definePlugin` (`@enkaku/sdk`) on the
   * author's own machine. Reported in `ready`, undefined for a pre-plan-98
   * bundle (which keeps reporting only the bare `timeoutMs`/`retries` top-
   * level fields below, exactly as before this plan existed).
   */
  runtime?: RuntimeEnvelope
  params: { parse(v: unknown): unknown }
  /**
   * Plan 97 §3.2, §4.2 — present only when the author declared `result:` on
   * `defineScript`/`definePlugin`; a genuine Zod schema (`defineScript`
   * already refuses anything else at the author's own machine, before this
   * file ever sees it). `safeParse` is used purely as an oracle (§3.3): the
   * child stores whatever `run()` actually returned, never `.data`, which
   * Zod's `.parse()` would have coerced/stripped unknown keys from (F25).
   * Undefined for every script that declares nothing — `undeclared` — which
   * is the entire rest of this file's behaviour, unchanged (criterion 1).
   */
  result?: {
    safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: (string | number | symbol)[]; message: string }> } }
  }
  prepare?: (ctx: unknown) => Promise<void>
  run: (ctx: unknown) => Promise<unknown>
  finish?: (ctx: unknown) => Promise<void>
  reset?: { packages: string[]; clearData?: boolean }
  /** Plan 91 §3.6, §4.8 — whether an operator may assist this script's job. Reported in `ready`, undefined for a pre-plan-91 bundle. */
  assist?: 'allow' | 'deny'
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
    let pluginId: string | undefined
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
      // The plugin's own id — `tiktok`, not `login` — reported alongside
      // `scriptId` so the parent can resolve `ctx.kv`'s namespace to the
      // PLUGIN, which is what makes a login script's session readable by a
      // warmup script in the same pack (plan 82 §3.10, plan 79 §3.2).
      pluginId = rawDef.id
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
      ...(pluginId !== undefined ? { pluginId } : {}),
      ...(typeof def.timeout === 'number' ? { timeoutMs: def.timeout } : {}),
      ...(typeof def.retries === 'number' ? { retries: def.retries } : {}),
      ...(def.runtime !== undefined ? { runtime: def.runtime } : {}),
      ...(reset ? { reset } : {}),
      ...(def.assist !== undefined ? { assist: def.assist } : {}),
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

/** Plan 97 §3.7, §4.9 — mirrors `job.progressIntervalMs`'s own zod default (`packages/protocol/src/settings.ts`); used only when `init.progressIntervalMs` is absent (a caller — chiefly a test — that predates this field). */
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000

/**
 * Plan 97 §3.7, §4.3 — `ctx.progress()`'s child-side coalescing: ONE timer
 * for the whole attempt, started lazily on the FIRST call (a script that
 * never calls `progress()` never runs a timer at all), last value wins. A
 * script calling this in a tight loop costs one assignment per call — the
 * timer, not the caller, decides when a message actually crosses IPC, and at
 * most one crosses per tick no matter how many calls happened in between.
 * Returns the timer handle so the caller can clear it — a coalescing timer
 * must not outlive the attempt (00-overview §7), the same reason
 * `heartbeat`/`rssTimer` below are cleared in `runScript`'s own `finally`.
 */
function createProgressReporter(intervalMs: number): { progress: (value: unknown) => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let pending: { value: unknown } | undefined
  return {
    progress(value: unknown) {
      pending = { value }
      if (timer) return
      timer = setInterval(() => {
        if (!pending) return
        const value = pending.value
        pending = undefined
        try {
          send({ t: 'progress', value })
        } catch {
          // A circular/unserialisable progress value is dropped silently —
          // `ctx.progress` is best-effort live state, never a guarantee
          // (unlike `run()`'s own return value, which reports the same
          // failure as `resultStatus: 'invalid'` — §3.7: only one of them is
          // a commitment).
        }
      }, intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

async function runScript(init: Extract<ParentToChild, { t: 'init' }>): Promise<void> {
  let finishRan = false
  let failure: { code: string; message: string; phase: string; stack?: string } | undefined
  let value: unknown

  const progressReporter = createProgressReporter(init.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS)
  const heartbeat = setInterval(() => send({ t: 'heartbeat' }), HEARTBEAT_MS)
  // Plan 98 §3.5, §4.7, H1 — self-reported RSS. One sample fires immediately
  // (a job that finishes before the first `rssSampleMs` tick must still get
  // at least one reading — most test/dev jobs run in well under 10s), then
  // one per tick. No limit reads this yet; the parent only accumulates a
  // peak (step 98.3 adds the limit).
  send({ t: 'rss', bytes: process.memoryUsage.rss() })
  const rssTimer = setInterval(() => send({ t: 'rss', bytes: process.memoryUsage.rss() }), init.rssSampleMs)

  try {
    const bundle = await loaded
    // `loadBundle` already reported the failure as a `result` — nothing left to do.
    if (!bundle) return
    const { def } = bundle

    // Plan 109 §3.1, step 109.1 — `storage`/`log`/`farm` come from the ONE
    // context builder (`../plugin-context.ts`), the same function the core
    // calls for an HTTP/WS/event/query handler. This is what makes a plugin's
    // own helper callable from a script handler and a core handler unchanged
    // (criterion 2); two builders would agree today and disagree in three
    // months.
    const plugin = createChildPluginContext({
      deviceId: init.job.deviceId,
      kvRequest,
      farmRequest,
      emitLog: (level, msg, fields) => log(level)(msg, fields),
    })

    const ctx: Record<string, unknown> = {
      device: deviceApi,
      artifact: artifactApi,
      ...plugin,
      job: init.job,
      params: undefined,
      // `ctx.kv` is plan 79's name for what plan 109 calls `ctx.storage`, and
      // it is the SAME OBJECT, not a second one — a published bundle sitting
      // in the `scripts` table (or embedded in the release binary) already
      // compiled `ctx.kv` into its code, and there is no publish step that
      // could rewrite it. Aliasing costs nothing and cannot drift; renaming
      // would break every stored bundle that uses the store.
      kv: plugin.storage,
      // Bound to THIS attempt (plan 81 §3.3, §4.2) — see the module-level
      // comment above `jobsRequest` for why this cannot be built earlier.
      // `nodeId` (plan 99 §3.2, §4.8) is undefined outside a workflow, which
      // reproduces the exact key derivation this had before that field
      // existed.
      jobs: createJobsApiFor(jobsRequest, { id: init.job.id, attempt: init.job.attempt, nodeId: init.job.nodeId }),
      // Plan 91 §3.6, §4.8 — a running script's own view of `{t:'assist'}`
      // pushes (handled at module scope, above `process.on('message', ...)`).
      // A script that never calls this is affected in NO way.
      onAssist: (cb: (e: { at: number; actor: string | null }) => void) => {
        assistHandlers.push(cb)
      },
      // Plan 97 §3.7, §4.2 — a live, unpersisted snapshot; coalesced here,
      // never validated, never stored, never `resultOf`-readable.
      progress: progressReporter.progress,
    }

    if (init.mode === 'finish-only') {
      // Fresh process: `finish` may depend on ctx and nothing else (stateless).
      ctx.error = init.priorError ?? { code: 'UNKNOWN', message: 'the previous attempt died', phase: 'run' }
      try {
        ctx.params = def.params.parse(init.params)
      } catch {
        ctx.params = init.params
      }
      let finishValue: unknown
      if (def.finish) {
        send({ t: 'phase', phase: 'finish' })
        finishValue = await def.finish(ctx)
      }
      finishRan = true
      // Plan 97 §3.5, §4.2, step 97.4 — this fresh process is the ONLY
      // carrier for a `finish()` salvage after a timeout kill: the ORIGINAL
      // attempt's own result (whatever it was) is discarded by the parent's
      // abort handling before this re-attempt is even spawned (`job-runner.ts`'s
      // own "the parent decides to abort, the parent also decides the
      // reason" comment). No schema check (§3.5 — "there is no honest
      // lenient schema"); `buildResultOutcome`'s size/circularity/
      // prototype-pollution guards still apply.
      if (finishValue === undefined) {
        send({ t: 'result', ok: false, error: ctx.error as never, finishRan })
      } else {
        const { outcome, sendValue } = buildResultOutcome(finishValue, undefined, init.maxResultBytes, 'partial')
        send({ t: 'result', ok: false, error: ctx.error as never, finishRan, ...(sendValue ? { value: finishValue } : {}), outcome })
      }
      return
    }

    try {
      ctx.params = def.params.parse(init.params)
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code: 'PARAMS_INVALID' })
    }

    let currentPhase: 'prepare' | 'run' = 'prepare'
    let finishValue: unknown
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
        finishValue = await def.finish(ctx)
      } catch (err) {
        // The first error wins; a failure in finish is only logged.
        const finishErr = toScriptError(err, 'finish')
        log('error')(`finish failed: ${finishErr.message}`)
        if (!failure) failure = finishErr
      }
    }
    finishRan = true
    if (failure) {
      // Plan 97 §3.5, §4.2, step 97.4 — a failed run can still say
      // something: `run()`'s own value wins when both it and `finish()`
      // produced one. (The only way both are defined at once is `run()`
      // succeeding — setting `value` — and `finish()` itself then throwing —
      // producing no `finishValue` and setting `failure` — so in practice
      // this is never a real conflict, but the precedence is still coded
      // explicitly rather than left to accident.) Sent as `partial`, never
      // validated against `def.result` (§3.5: "there is no honest lenient
      // schema").
      const salvage = value !== undefined ? value : finishValue
      if (salvage === undefined) {
        send({ t: 'result', ok: false, error: failure, finishRan })
      } else {
        const { outcome, sendValue } = buildResultOutcome(salvage, undefined, init.maxResultBytes, 'partial')
        send({ t: 'result', ok: false, error: failure, finishRan, ...(sendValue ? { value: salvage } : {}), outcome })
      }
    } else {
      // Plan 97 §3.3, §3.4, §3.8, H2 — measure, then check, then store: only
      // on the success path (97.4's `finish()` salvage, above, is the
      // failure path's own outcome).
      const { outcome, sendValue } = buildResultOutcome(value, def.result, init.maxResultBytes)
      send({ t: 'result', ok: true, ...(sendValue ? { value } : {}), finishRan, outcome })
    }
  } catch (err) {
    const e = toScriptError(err, 'run')
    send({ t: 'result', ok: false, error: e, finishRan })
  } finally {
    clearInterval(heartbeat)
    clearInterval(rssTimer)
    // Plan 97 §3.7 — the coalescing timer must not outlive the attempt
    // (00-overview §7): a script that called `progress()` once and then hung
    // in `run()` (later killed by the parent's abort/timeout) must not leave
    // a live `setInterval` behind when this process exits.
    progressReporter.stop()
    // Give the last message time to flush before the process exits.
    setTimeout(() => process.exit(0), 50)
  }
}
