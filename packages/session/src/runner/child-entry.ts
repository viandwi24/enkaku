/**
 * Entry point child process job (plan 05 §4.5). Dijalankan:
 *   bun <child-entry.ts> <bundlePath>
 *
 * Child hanya mengeksekusi bundle script; semua akses device lewat IPC ke
 * parent. Ini crash containment (spec §11.3) — BUKAN security sandbox:
 * bundle punya akses fs/network penuh sebagai OS user core.
 */
import { ChildToParentSchema, ParentToChildSchema, type ChildToParent, type ParentToChild } from './ipc'

const HEARTBEAT_MS = 10_000

type Level = 'debug' | 'info' | 'warn' | 'error'

function send(msg: ChildToParent): void {
  const parsed = ChildToParentSchema.safeParse(msg)
  if (!parsed.success) return
  process.send?.(parsed.data)
}

const pendingDevice = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
const pendingArtifact = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>()
const abortController = new AbortController()
let aborted: 'timeout' | 'cancelled' | 'hung' | null = null

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
  swipe: (from: unknown, to: unknown, ms = 300) => request<void>({ method: 'swipe', args: { from, to, ms } } as never),
  type: (text: string) => request<void>({ method: 'type', args: { text } } as never),
  key: (code: unknown) => request<void>({ method: 'key', args: { code } } as never),
  find: (sel: unknown) => request<unknown>({ method: 'find', args: { sel } } as never),
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
    else waiter.reject(Object.assign(new Error(msg.error?.message ?? 'device call gagal'), { code: msg.error?.code }))
  } else if (msg.t === 'artifact.result') {
    const waiter = pendingArtifact.get(msg.callId)
    if (!waiter) return
    pendingArtifact.delete(msg.callId)
    if (msg.ok) waiter.resolve()
    else waiter.reject(new Error(msg.error?.message ?? 'artifact gagal disimpan'))
  } else if (msg.t === 'abort') {
    aborted = msg.reason
    abortController.abort()
    // Semua call device pending dibatalkan supaya fase aktif cepat berhenti.
    for (const [, waiter] of pendingDevice) waiter.reject(new Error(`job di-abort (${msg.reason})`))
    pendingDevice.clear()
  } else if (msg.t === 'init') {
    void runScript(msg)
  }
})

/**
 * Fase di-race dengan sinyal abort: script yang tidak memeriksa signal
 * (mis. `await sleep(60_000)`) tetap berhenti dihitung saat timeout —
 * hasilnya dibuang dan job ditandai TIMEOUT.
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

async function runScript(init: Extract<ParentToChild, { t: 'init' }>): Promise<void> {
  const bundlePath = process.argv[2]
  let finishRan = false
  let failure: { code: string; message: string; phase: string; stack?: string } | undefined
  let value: unknown

  const heartbeat = setInterval(() => send({ t: 'heartbeat' }), HEARTBEAT_MS)

  try {
    if (!bundlePath) throw new Error('bundlePath tidak diberikan ke child')
    const mod = (await import(bundlePath)) as { default?: unknown }
    const def = mod.default as
      | {
          id: string
          version: string
          timeout?: number
          retries?: number
          params: { parse(v: unknown): unknown }
          prepare?: (ctx: unknown) => Promise<void>
          run: (ctx: unknown) => Promise<unknown>
          finish?: (ctx: unknown) => Promise<void>
        }
      | undefined
    if (!def || typeof def.run !== 'function') {
      throw Object.assign(new Error('bundle tidak punya default export ScriptDefinition'), { code: 'BAD_BUNDLE' })
    }
    send({
      t: 'ready',
      scriptId: def.id,
      version: def.version,
      ...(typeof def.timeout === 'number' ? { timeoutMs: def.timeout } : {}),
      ...(typeof def.retries === 'number' ? { retries: def.retries } : {}),
    })

    const ctx: Record<string, unknown> = {
      device: deviceApi,
      artifact: artifactApi,
      log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
      job: init.job,
      params: undefined,
    }

    if (init.mode === 'finish-only') {
      // Process baru: `finish` HANYA boleh bergantung pada ctx (stateless).
      ctx.error = init.priorError ?? { code: 'UNKNOWN', message: 'attempt sebelumnya mati', phase: 'run' }
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
        ? { code: 'TIMEOUT', message: `job di-abort (${aborted})`, phase: 'timeout' }
        : toScriptError(err, currentPhase)
    }

    if (def.finish) {
      if (failure) ctx.error = failure
      send({ t: 'phase', phase: 'finish' })
      try {
        await def.finish(ctx)
      } catch (err) {
        // Error pertama yang menang; kegagalan finish hanya di-log.
        const finishErr = toScriptError(err, 'finish')
        log('error')(`finish gagal: ${finishErr.message}`)
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
    // Beri waktu message terakhir terkirim sebelum process keluar.
    setTimeout(() => process.exit(0), 50)
  }
}
