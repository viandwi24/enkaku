import { AdbError } from './errors'
import {
  ADB_MAX_OUTPUT_BYTES,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_QUEUE_DEPTH,
  DEFAULT_MAX_STREAMS,
  DEFAULT_MAX_STREAMS_PER_DEVICE,
  DEFAULT_STREAM_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_BYTES,
  type AdbTimeoutProfile,
  resolveExecTimeout,
} from './timeouts'
import { PerDeviceQueue, Semaphore } from './queue'
import { ShellFrameParser, type ShellResult } from './shell-frames'
import { AdbSocket } from './socket'
import { DeviceTracker, type TrackedDevice } from './tracker'

export type { ShellResult } from './shell-frames'

/** Why an `execStream` ended (plan 24 §4.2). */
export type AdbStreamEndReason = 'closed' | 'idle' | 'deadline' | 'bytes' | 'stopped' | 'error'

export interface AdbStreamOptions {
  onData: (chunk: Uint8Array) => void
  onEnd: (reason: AdbStreamEndReason, err?: unknown) => void
  /** No bytes at all within this window ends the stream. Default 60_000ms. */
  idleTimeoutMs?: number
  /** The stream may not outlive this, however healthy. Default 600_000ms. */
  absoluteTimeoutMs?: number
  /** Hard cap on total bytes streamed. Default 5 MiB. */
  maxBytes?: number
  signal?: AbortSignal
}

export interface AdbStreamHandle {
  readonly pid: number | null
  /** Terminates the socket, then best-effort kills the on-device process (plan 24 §3.4). */
  stop(): Promise<void>
}

/**
 * The streaming lane's own budget (plan 24 §3.2) — completely separate from
 * `Semaphore`/`PerDeviceQueue` above, and deliberately synchronous:
 * exceeding either limit rejects `E_ADB_STREAM_LIMIT` immediately, never
 * waits in a queue. That is the whole point of a dedicated lane — a stream
 * request either gets a slot right now or is told plainly that it cannot.
 */
export class StreamLane {
  private globalCount = 0
  private perDevice = new Map<string, number>()

  constructor(
    private maxPerDevice: number,
    private maxGlobal: number,
  ) {}

  setLimits(maxPerDevice: number, maxGlobal: number): void {
    this.maxPerDevice = Math.max(1, maxPerDevice)
    this.maxGlobal = Math.max(1, maxGlobal)
  }

  /**
   * `serial: count` for every device currently holding a lane slot, sorted by
   * descending count (plan 85 §5, step 85.1) — this is what turns "the farm
   * already has 4 adb stream(s) running (max 4)" (F3/F7's field log line, on
   * its own useless for naming a culprit) into a line that names which
   * devices hold the slots, without a second round trip to `stats()`.
   */
  private occupancyBreakdown(): string {
    if (this.perDevice.size === 0) return '(no device holds a slot)'
    return [...this.perDevice.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}: ${n}`)
      .join(', ')
  }

  /** Reserves a slot or throws `E_ADB_STREAM_LIMIT`; never blocks. */
  acquire(serial: string): () => void {
    const current = this.perDevice.get(serial) ?? 0
    if (current >= this.maxPerDevice) {
      throw new AdbError(
        'E_ADB_STREAM_LIMIT',
        `device ${serial} already has ${current} adb stream(s) running (max ${this.maxPerDevice} per device); farm-wide: ${this.globalCount}/${this.maxGlobal} held by ${this.occupancyBreakdown()}`,
      )
    }
    if (this.globalCount >= this.maxGlobal) {
      throw new AdbError(
        'E_ADB_STREAM_LIMIT',
        `the farm already has ${this.globalCount} adb stream(s) running (max ${this.maxGlobal}), held by ${this.occupancyBreakdown()}`,
      )
    }
    this.perDevice.set(serial, current + 1)
    this.globalCount++
    let released = false
    return () => {
      if (released) return
      released = true
      this.globalCount--
      const next = (this.perDevice.get(serial) ?? 1) - 1
      if (next <= 0) this.perDevice.delete(serial)
      else this.perDevice.set(serial, next)
    }
  }

  stats(): { maxStreams: number; maxStreamsPerDevice: number; streams: number; perDevice: Record<string, number> } {
    return {
      maxStreams: this.maxGlobal,
      maxStreamsPerDevice: this.maxPerDevice,
      streams: this.globalCount,
      perDevice: Object.fromEntries(this.perDevice),
    }
  }
}

/**
 * `host:devices-l`'s response body (plan 85 §3.3, §4.3; plan 88 §3.1, fixes
 * F6). Unlike `host:track-devices` (tab-separated, `tracker.ts`'s
 * `parseSnapshot`), adb's long-listing format left-pads the serial to a
 * fixed column width with plain spaces and then appends unstructured
 * `key:value` fields (product/model/device/transport_id, and — USB only —
 * usb) after the state — so this splits on ANY whitespace run rather than
 * assuming a tab. `product`/`model`/`device` are still ignored (nothing
 * reads them); `usb` and `transport_id` are now kept, because `usb:` is
 * adb's own signal that a transport is USB rather than TCP — the exact
 * field this function used to throw away. Verified against a real
 * `adb devices -l` line (plan 88 §5 step 88.1's H6 spike):
 * `ZP2222RMBS   device usb:3-1.4.3 product:lagos_gpn model:moto_g06_power
 * device:lagos transport_id:10` — confirming the field order and that a
 * USB line always carries `usb:`. A zero-length block (no devices at all)
 * parses to `[]`.
 */
function parseDevicesLongBlock(raw: string): TrackedDevice[] {
  const out: TrackedDevice[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [serial, state, ...fields] = trimmed.split(/\s+/)
    if (!serial || !state) continue
    const device: TrackedDevice = { serial, state }
    for (const field of fields) {
      const colon = field.indexOf(':')
      if (colon < 0) continue
      const key = field.slice(0, colon)
      const value = field.slice(colon + 1)
      if (!value) continue
      if (key === 'usb') device.usb = value
      else if (key === 'transport_id') {
        const transportId = Number(value)
        if (Number.isFinite(transportId)) device.transportId = transportId
      }
    }
    out.push(device)
  }
  return out
}

/**
 * `host:list-forward`'s response body (plan 119 §4.1, step 119.1): one
 * "serial local remote" line per active forward. Verified live for the
 * EMPTY case only (plan 119 §0.2: `host:list-forward` → OKAY, body "" —
 * no device was attached, so a non-empty body was never actually seen).
 * The whitespace-split three-field shape below is inferred from
 * `packages/drivers/src/network/guest-agent/launcher.ts`'s existing
 * CLI-based parsing of `adb forward --list`'s plain-text output
 * (`line.trim().split(/\s+/)` → `[serial, local, remote]`) — the CLI
 * flag is itself documented as a thin formatter over this exact host:
 * service, but that is "plausible," not "measured," per plan 119 §0.2's
 * own evidence standard. A line that does not split into exactly three
 * fields is skipped rather than throwing, the same defensive posture
 * `parseDevicesLongBlock` above takes with a malformed line.
 */
function parseListForwardBlock(raw: string): { serial: string; local: string; remote: string }[] {
  const out: { serial: string; local: string; remote: string }[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [serial, local, remote] = trimmed.split(/\s+/)
    if (!serial || !local || !remote) continue
    out.push({ serial, local, remote })
  }
  return out
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Translates a `streamFrom` end error into the reason `execStream.onEnd` reports. */
function reasonFromStreamError(err: unknown): 'closed' | 'idle' | 'bytes' | 'error' {
  if (err === undefined || err === null) return 'closed'
  if (err instanceof AdbError) {
    if (err.code === 'E_ADB_STREAM_IDLE') return 'idle'
    if (err.code === 'E_ADB_OUTPUT_LIMIT') return 'bytes'
  }
  return 'error'
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AdbError('E_ADB_BAD_TIMEOUT', `invalid ${name}: ${value}`)
  }
}

/**
 * Like `assertPositive`, but `0` is a legal value meaning "disabled" (plan 34
 * §4.1, §8): a caller whose command is meant to outlive both stream clocks
 * (the ui-server instrumentation) passes `0` for `idleTimeoutMs` and
 * `absoluteTimeoutMs` deliberately, not by omission — omission still falls
 * back to the lane's own defaults above.
 */
function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new AdbError('E_ADB_BAD_TIMEOUT', `invalid ${name}: ${value}`)
  }
}

export interface AdbClientOptions {
  /** Path to the adb binary — from resolveToolPath('adb'); the client NEVER reads env itself. */
  adbPath: string
  host?: string
  port?: number
  /**
   * Semaphore global (spec §10.4, scaled by plan 23 §3.2). Default 6, clamp
   * 1..24. Plan 23's autoscaler raises or pins this at runtime via
   * `setMaxConcurrent` — this constructor option only sets the starting point.
   */
  maxConcurrent?: number
  /** Per-device queue depth cap (plan 22.1 §4.5). Default 32. */
  maxQueueDepth?: number
  /** The streaming lane's per-device budget (plan 24 §3.2). Default 1. */
  maxStreamsPerDevice?: number
  /** The streaming lane's farm-wide budget (plan 24 §3.2). Default 4. */
  maxStreams?: number
  onLog?: (level: 'debug' | 'warn', msg: string) => void
  /** One call per settled exec/execOut task (plan 22.1 §4.6, wired up by plan 23). */
  onMetric?: (m: AdbMetric) => void
}

/** One exec/execOut outcome (plan 22.1 §4.6, extended by plan 23 §4.4 with `code` — the
 * health tracker needs to tell `E_ADB_CONNECT_TIMEOUT` apart from a plain `E_ADB_FAIL`,
 * and both settle as outcome `'error'`). */
export interface AdbMetric {
  serial: string
  profile: string
  ms: number
  outcome: 'ok' | 'timeout' | 'busy' | 'error'
  /** The AdbErrorCode when the task rejected; absent on `'ok'`. */
  code?: string
}

export interface AdbExecOptions {
  /** Named profile from ADB_TIMEOUTS; ignored when timeoutMs is given. */
  profile?: AdbTimeoutProfile
  /** Absolute execution budget, clamped to MAX_EXEC_TIMEOUT_MS. */
  timeoutMs?: number
  /** How long the task may wait for its turn in the per-device queue. */
  queueTimeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

function classifyOutcome(err: unknown): 'timeout' | 'busy' | 'error' {
  if (err instanceof AdbError) {
    if (err.code === 'E_ADB_TIMEOUT') return 'timeout'
    if (err.code === 'E_ADB_BUSY') return 'busy'
  }
  return 'error'
}

/**
 * A thin client for the adb server over its smartsocket (127.0.0.1:5037).
 * The only CLI spawn allowed here is `adb start-server` when the connection
 * is refused. `adb kill-server` is FORBIDDEN across the codebase (spec §10.4)
 * — the single exception is the Toolchain Manager swapping adb versions.
 */
export class AdbClient {
  private host: string
  private port: number
  private adbPath: string
  private sem: Semaphore
  private queue: PerDeviceQueue
  private maxQueueDepth: number
  /**
   * The streaming lane (plan 24 §3.1, §3.2): a completely separate budget
   * from `sem`/`queue` above. `execStream` NEVER calls `this.queue.run` —
   * that is the one rule this whole plan exists to enforce, and it is what
   * `client.test.ts` asserts by checking `pending(serial)` stays 0 for a
   * stream's entire lifetime.
   */
  private streamLane: StreamLane
  /** Per-serial verdict on `shell,v2,raw` support (plan 53 §3.4); unset means "not yet known". */
  private shellFramedSupported = new Map<string, boolean>()
  private tracker: DeviceTracker | null = null
  private onLog?: (level: 'debug' | 'warn', msg: string) => void
  private onMetric?: AdbClientOptions['onMetric']

  constructor(opts: AdbClientOptions) {
    this.adbPath = opts.adbPath
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 5037
    const max = Math.min(24, Math.max(1, opts.maxConcurrent ?? 6))
    this.sem = new Semaphore(max)
    this.queue = new PerDeviceQueue(this.sem)
    this.maxQueueDepth = opts.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
    this.streamLane = new StreamLane(
      opts.maxStreamsPerDevice ?? DEFAULT_MAX_STREAMS_PER_DEVICE,
      opts.maxStreams ?? DEFAULT_MAX_STREAMS,
    )
    this.onLog = opts.onLog
    this.onMetric = opts.onMetric
  }

  /**
   * Resize the global semaphore at runtime (plan 23 §4.2/§4.3): the
   * autoscaler calls this as fleet size changes, and the `adb.maxConcurrent`
   * farm setting calls it with a pinned value. Clamped the same way the
   * constructor's starting value is.
   */
  setMaxConcurrent(n: number): void {
    this.sem.resize(Math.min(24, Math.max(1, n)))
  }

  /** The global semaphore's live state — `GET /api/adb/stats` (plan 23 §4.6). */
  stats(): { maxConcurrent: number; inFlight: number; waiting: number } {
    return { maxConcurrent: this.sem.max, inFlight: this.sem.inFlight, waiting: this.sem.waiting }
  }

  /** Resize the streaming lane's budgets at runtime — the `adb` farm setting calls this (plan 24 §4.2). */
  setStreamLimits(maxStreamsPerDevice: number, maxStreams: number): void {
    this.streamLane.setLimits(maxStreamsPerDevice, maxStreams)
  }

  /** The streaming lane's live state (plan 24 §3.2) — separate from `stats()` above on purpose. */
  streamStats(): { maxStreams: number; maxStreamsPerDevice: number; streams: number; perDevice: Record<string, number> } {
    return this.streamLane.stats()
  }

  /** Connect, run `fn`, and close: gracefully on success, force-terminated on any error. */
  private async withSocket<T>(fn: (socket: AdbSocket) => Promise<T>): Promise<T> {
    const socket = await AdbSocket.connect(this.host, this.port)
    let ok = false
    try {
      const out = await fn(socket)
      ok = true
      return out
    } finally {
      socket.close(!ok)
    }
  }

  /** Connect to the adb server; if it is not running, spawn `adb start-server` and retry. */
  async ensureServer(): Promise<void> {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const socket = await AdbSocket.connect(this.host, this.port)
        socket.close()
        return
      } catch (err) {
        if (attempt === maxAttempts) {
          throw new AdbError(
            'E_ADB_UNAVAILABLE',
            `could not reach the adb server at ${this.host}:${this.port} after ${maxAttempts} attempts`,
            err,
          )
        }
        this.onLog?.('debug', `adb server is not running, trying start-server (attempt ${attempt})`)
        const proc = Bun.spawn([this.adbPath, 'start-server'], { stdout: 'ignore', stderr: 'ignore' })
        await proc.exited
        await Bun.sleep(500 * attempt)
      }
    }
  }

  /** host:version → the adb server's version string (hex). */
  async version(): Promise<string> {
    return this.withSocket(async (socket) => {
      socket.send('host:version')
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /**
   * One connection attempt, bounded end to end by `execTimeoutMs`: connect →
   * host:transport:<serial> → shell,v2,raw:/shell:/exec:<cmd> → read until
   * the socket closes. On any deadline or `AbortSignal`, the socket is
   * terminated (plan 22.1 §3.5) so the pending read unblocks and the
   * caller's `finally` in `PerDeviceQueue.run` can release the per-device
   * slot — that release already existed; it was simply never reached before
   * this plan.
   *
   * `service: 'shell-framed'` sends the framed `shell,v2,raw:<cmd>` service
   * (plan 53 §3.3) — the caller (`execFramedOrFallback` below) is the one
   * that parses the returned bytes into `{ stdout, stderr, exitCode }`; this
   * method only knows about raw bytes, same as the `'shell'`/`'exec'` paths.
   * A FAIL at the service-request step (as opposed to the transport step)
   * is reported as `E_ADB_SHELL_FRAMED_UNSUPPORTED` so the caller can tell
   * "this device/adb build has no framed shell" from any other failure.
   */
  private async runOneShot(
    serial: string,
    cmd: string,
    service: 'shell-framed' | 'shell' | 'exec',
    opts: { execTimeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    let socket: AdbSocket | null = null
    let ok = false
    let deadlineErr: AdbError | null = null
    const wireService = service === 'shell-framed' ? 'shell,v2,raw' : service

    const timer = setTimeout(() => {
      deadlineErr = new AdbError('E_ADB_TIMEOUT', `adb ${wireService}:${cmd} exceeded ${opts.execTimeoutMs}ms`)
      socket?.abort(deadlineErr)
    }, opts.execTimeoutMs)

    const onAbort = () => {
      deadlineErr ??= new AdbError('E_ADB_ABORTED', 'aborted by caller signal')
      socket?.abort(deadlineErr)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      if (deadlineErr) throw deadlineErr
      socket = await AdbSocket.connect(this.host, this.port, { maxBytes: opts.maxOutputBytes })
      if (deadlineErr) throw deadlineErr // fired while connect() itself was still in flight
      socket.send(`host:transport:${serial}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      if (deadlineErr) throw deadlineErr
      socket.send(`${wireService}:${cmd}`)
      try {
        await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      } catch (err) {
        if (service === 'shell-framed' && err instanceof AdbError && err.code === 'E_ADB_FAIL') {
          throw new AdbError(
            'E_ADB_SHELL_FRAMED_UNSUPPORTED',
            `adb server or device rejected shell,v2,raw: ${err.message}`,
            err,
          )
        }
        throw err
      }
      const out = await socket.readUntilClose()
      ok = true
      return out
    } finally {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      socket?.close(!ok) // terminate on any abnormal exit, end() only on success
    }
  }

  private execRaw(
    serial: string,
    cmd: string,
    service: 'shell-framed' | 'shell' | 'exec',
    opts?: AdbExecOptions,
  ): Promise<Uint8Array> {
    const profile = opts?.profile ?? 'default'
    const execTimeoutMs = resolveExecTimeout(opts)
    // An explicit caller value wins; otherwise the profile decides, and only then the text default.
    // See `ADB_MAX_OUTPUT_BYTES` for why a screenshot cannot share a budget sized for printed lines.
    const maxOutputBytes = opts?.maxOutputBytes ?? ADB_MAX_OUTPUT_BYTES[profile] ?? DEFAULT_MAX_OUTPUT_BYTES
    const start = Date.now()

    const run = this.queue.run(
      serial,
      () => this.runOneShot(serial, cmd, service, { execTimeoutMs, maxOutputBytes, signal: opts?.signal }),
      { queueTimeoutMs: opts?.queueTimeoutMs, signal: opts?.signal, maxDepth: this.maxQueueDepth },
    )
    if (this.onMetric) {
      const onMetric = this.onMetric
      const report = (outcome: 'ok' | 'timeout' | 'busy' | 'error', code?: string) => {
        try {
          onMetric({ serial, profile, ms: Date.now() - start, outcome, ...(code ? { code } : {}) })
        } catch {
          // A caller-supplied hook must never turn into an unhandled rejection here.
        }
      }
      run.then(
        () => report('ok'),
        (err) => report(classifyOutcome(err), err instanceof AdbError ? err.code : undefined),
      )
    }
    return run
  }

  /**
   * One-shot shell per device: new connection → host:transport:<serial> →
   * shell,v2,raw:<cmd> → the framed protocol separates stdout, stderr, and
   * the exit code (plan 53 §3.3) instead of merging everything and losing
   * the exit status. Always through the per-device queue plus the
   * semaphore — there is no shortcut around it.
   *
   * Falls back to the plain `shell:<cmd>` service — merged output on
   * `stdout`, `exitCode: null` — when the device or adb server does not
   * support framing (plan 53 §3.4); the verdict is cached per serial so
   * that cost is paid once, not on every command.
   */
  exec(serial: string, cmd: string, opts?: AdbExecOptions): Promise<ShellResult> {
    return this.execFramedOrFallback(serial, cmd, opts)
  }

  private async execFramedOrFallback(serial: string, cmd: string, opts?: AdbExecOptions): Promise<ShellResult> {
    if (this.shellFramedSupported.get(serial) === false) {
      return this.execLegacyShell(serial, cmd, opts)
    }
    try {
      const raw = await this.execRaw(serial, cmd, 'shell-framed', opts)
      this.shellFramedSupported.set(serial, true)
      const parser = new ShellFrameParser()
      parser.push(raw)
      const result = parser.result()
      return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: result.exitCode }
    } catch (err) {
      if (err instanceof AdbError && err.code === 'E_ADB_SHELL_FRAMED_UNSUPPORTED') {
        this.shellFramedSupported.set(serial, false)
        return this.execLegacyShell(serial, cmd, opts)
      }
      throw err
    }
  }

  /** `exitCode: null` here is the honest answer (plan 53 §3.4) — never a fabricated `0`. */
  private async execLegacyShell(serial: string, cmd: string, opts?: AdbExecOptions): Promise<ShellResult> {
    const raw = await this.execRaw(serial, cmd, 'shell', opts)
    return { stdout: new TextDecoder().decode(raw).trim(), stderr: '', exitCode: null }
  }

  /** Like exec, but returns raw binary stdout (screencap and friends) via exec-out. */
  execOut(serial: string, cmd: string, opts?: AdbExecOptions): Promise<Uint8Array> {
    return this.execRaw(serial, cmd, 'exec', opts)
  }

  /**
   * A long-running shell stream (`logcat`, `top`, ...) that NEVER touches
   * `PerDeviceQueue` (plan 24 §3.1, §4.2) — it takes a slot from the
   * streaming lane instead, so it cannot park a per-device queue slot the
   * way `packages/scrcpy/src/session.ts:90-98` documents. The lane check is
   * synchronous and rejects `E_ADB_STREAM_LIMIT` immediately rather than
   * ever waiting.
   *
   * `shell:echo $$; exec <cmd>` (§3.4): `$$` is the shell's own PID, and
   * `exec` replaces that shell with the target command, so the printed PID
   * IS the command's PID. The first line is parsed and stripped from the
   * data path; every later byte goes straight to `onData` via
   * `AdbSocket.streamFrom` without being buffered.
   */
  async execStream(serial: string, cmd: string, opts: AdbStreamOptions): Promise<AdbStreamHandle> {
    const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const absoluteTimeoutMs = opts.absoluteTimeoutMs ?? DEFAULT_STREAM_ABSOLUTE_TIMEOUT_MS
    const maxBytes = opts.maxBytes ?? DEFAULT_STREAM_MAX_BYTES
    assertNonNegative('idleTimeoutMs', idleTimeoutMs)
    assertNonNegative('absoluteTimeoutMs', absoluteTimeoutMs)
    assertPositive('maxBytes', maxBytes)

    const releaseLane = this.streamLane.acquire(serial)

    let ended = false
    let pid: number | null = null
    let socket: AdbSocket | null = null
    let absoluteTimer: ReturnType<typeof setTimeout> | null = null

    const onAbort = () => finish('stopped')

    const finish = (reason: AdbStreamEndReason, err?: unknown): void => {
      if (ended) return
      ended = true
      if (absoluteTimer) clearTimeout(absoluteTimer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      // Order matters (plan 24 §4.2): release the lane slot, THEN terminate
      // the socket, THEN best-effort kill whatever is left on the device.
      releaseLane()
      socket?.close(true)
      if (pid !== null) {
        // Through the NORMAL per-device queue — only the stream itself
        // bypasses it (§4.2). Best-effort: the caller has already been told
        // the stream ended, so a device that already reaped the process (or
        // ignores the signal) must not surface as a second error.
        void this.exec(serial, `kill ${pid}`, { profile: 'input' }).catch(() => {})
      }
      opts.onEnd(reason, err)
    }

    try {
      socket = await AdbSocket.connect(this.host, this.port, { maxBytes })
      socket.send(`host:transport:${serial}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      socket.send(`shell:echo $$; exec ${cmd}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    } catch (err) {
      releaseLane()
      socket?.close(true)
      throw err
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        finish('stopped')
        return { pid: null, stop: async () => {} }
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    // Idle clock: Bun's native per-socket timer (§3.3, §4.1) — `0` disables
    // it outright (`AdbSocket.setIdleTimeout`'s own contract), used by plan
    // 34 §4.1 for a stream that is legitimately silent once healthy (the
    // ui-server instrumentation). Absolute clock: a plain timer, since
    // nothing in Bun's socket API expresses it directly — `0` means "never",
    // so no timer is armed at all rather than one that fires immediately.
    socket.setIdleTimeout(idleTimeoutMs === 0 ? 0 : Math.max(1, Math.ceil(idleTimeoutMs / 1000)))
    if (absoluteTimeoutMs > 0) {
      absoluteTimer = setTimeout(() => finish('deadline'), absoluteTimeoutMs)
    }

    let pidChunks: Uint8Array[] = []
    let pidResolved = false

    const handleChunk = (chunk: Uint8Array): void => {
      if (pidResolved) {
        if (chunk.length > 0) opts.onData(chunk)
        return
      }
      pidChunks.push(chunk)
      const combined = concatChunks(pidChunks)
      const nl = combined.indexOf(10) // '\n'
      if (nl === -1) return // still waiting for the PID line to complete
      pidResolved = true
      pidChunks = []
      const line = new TextDecoder().decode(combined.subarray(0, nl)).trim()
      const parsed = Number.parseInt(line, 10)
      // Defensive (plan 24 §8 risks): an OEM shell that does not print a
      // bare PID leaves `pid` null instead of breaking the stream — only the
      // explicit on-device kill is skipped; socket termination still works.
      pid = Number.isFinite(parsed) && String(parsed) === line ? parsed : null
      const rest = combined.subarray(nl + 1)
      if (rest.length > 0) opts.onData(rest)
    }

    socket.streamFrom(handleChunk, (err) => finish(reasonFromStreamError(err), err))

    return {
      get pid() {
        return pid
      },
      stop: async () => {
        finish('stopped')
      },
    }
  }

  /**
   * Opens a raw, long-lived smartsocket stream for the adb endpoint shim
   * (plan 27 §4.1): connect → `host:transport:<serial>` → `<service>` →
   * return the socket itself, rather than reading it to completion the way
   * `exec`/`execOut` do. Deliberately bypasses `PerDeviceQueue`/`Semaphore`
   * entirely — an endpoint stream can live for minutes (a `logcat`, a large
   * `push`), and plan 24 §3.1 already established that long-lived work must
   * not hold a per-device queue slot. There is no lane budget here either:
   * the endpoint's own `maxEndpointStreams` cap (enforced by
   * `transport/stream-mux.ts`) is the only limit on concurrent streams.
   *
   * The returned `AdbSocket` already structurally satisfies
   * `transport/stream-mux.ts`'s `RawStream` (`write`/`streamFrom`/`close`) —
   * no wrapper needed at the call site.
   */
  async openRaw(serial: string, service: string): Promise<AdbSocket> {
    const socket = await AdbSocket.connect(this.host, this.port)
    let ok = false
    try {
      socket.send(`host:transport:${serial}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      socket.send(service)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      ok = true
      return socket
    } finally {
      if (!ok) socket.close(true)
    }
  }

  /**
   * `host:devices-l` → adb's own truth (plan 85 §3.3, §4.3) — the
   * `DeviceReconciler`'s primary signal, deliberately independent of
   * `trackDevices()`'s long-lived event stream: a one-shot request/response
   * exactly like `version()`/`connectDevice()` below, so it can be polled on
   * a timer without holding a second permanent connection open.
   */
  async listDevices(): Promise<TrackedDevice[]> {
    return this.withSocket(async (socket) => {
      socket.send('host:devices-l')
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      const raw = await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return parseDevicesLongBlock(raw)
    })
  }

  /**
   * `host:reconnect-offline` (plan 85 §3.3, §4.3) — asks the adb server to
   * re-open its transports for every device currently stuck `offline`. This
   * is a host-level re-open, NOT `kill-server`: port 5037 keeps its owner
   * and no other tool's session on it is disturbed (`adb kill-server` is
   * forbidden repo-wide outside the Toolchain Manager's swap flow, spec
   * §10.4).
   */
  async reconnectOffline(): Promise<string> {
    return this.withSocket(async (socket) => {
      socket.send('host:reconnect-offline')
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /** `adb connect <host:port>` via host service (wireless / adb-tcp). */
  async connectDevice(hostPort: string): Promise<string> {
    return this.withSocket(async (socket) => {
      socket.send(`host:connect:${hostPort}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /** `adb disconnect <host:port>` via host service. */
  async disconnectDevice(hostPort: string): Promise<string> {
    return this.withSocket(async (socket) => {
      socket.send(`host:disconnect:${hostPort}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /**
   * `host-serial:<serial>:forward:<local>;<remote>` (plan 119 §4.1, step
   * 119.1) — adds one forward, off the `adb.exe` process-spawn path
   * `guest-agent/launcher.ts` and `ui-server/launcher.ts` both used before
   * this plan. Sends bare OKAY with no body: NOT independently verified
   * against a real device — no device was attached when step 119.1 ran, and
   * plan 119 §0.2's only live findings for this family were `host:list-forward`'s
   * empty-body case, a generic FAIL with an empty reason for a bogus-serial
   * `forward` and for `host:killforward:tcp:19999`, and `host:killforward-all`'s
   * bare OKAY with no body. This method's SUCCESS shape is inferred by
   * analogy with that last one (every other `host:`/`host-serial:` service
   * in this client that DOES something rather than answering a query is
   * bare-OKAY), not measured. §0.2's own point stands either way: `OKAY` is
   * never assumed to be followed by a block just because some other method
   * has one — a FAIL is thrown by `readStatus()` exactly like every other
   * method here.
   */
  async forward(serial: string, local: string, remote: string): Promise<void> {
    await this.withSocket(async (socket) => {
      socket.send(`host-serial:${serial}:forward:${local};${remote}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /**
   * `host:list-forward` (plan 119 §4.1, step 119.1) — OKAY plus a
   * length-prefixed body (verified live for the empty case, §0.2: body "").
   * See `parseListForwardBlock` for the per-line format, which is inferred
   * rather than verified against a real device with active forwards.
   */
  async listForward(): Promise<{ serial: string; local: string; remote: string }[]> {
    return this.withSocket(async (socket) => {
      socket.send('host:list-forward')
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      const raw = await socket.readBlock({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      return parseListForwardBlock(raw)
    })
  }

  /**
   * `host-serial:<serial>:killforward:<local>` (plan 119 §4.1, step 119.1)
   * — removes one forward. Bare OKAY, no body: inferred by analogy with
   * `host:killforward-all`'s verified bare-OKAY action-reply shape (§0.2).
   * The generic, serial-less `host:killforward:tcp:19999` FAIL case (§0.2)
   * confirms the FAIL side of this family behaves like every other host:
   * FAIL (empty reason, caught by `readStatus()`); the per-serial SUCCESS
   * shape itself was not independently exercised against a real device,
   * same caveat as `forward` above.
   */
  async killForward(serial: string, local: string): Promise<void> {
    await this.withSocket(async (socket) => {
      socket.send(`host-serial:${serial}:killforward:${local}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /**
   * `tcpip:<port>` as a DEVICE service (plan 88 §0.2 H1, §5 step 88.5) — NOT
   * one of the HOST services above (`host:connect`/`host:disconnect`, which
   * ask the adb SERVER to dial or drop a transport it already has). This
   * asks adbd itself, on ONE already-attached (normally USB) device, to
   * restart its own listener in TCP mode on `port` — the first half of the
   * OTG/Wi-Fi cutover (§3.4 step 2), before any network address exists to
   * `connect` to. `host:transport:<serial>` selects the device exactly like
   * `openRaw` (F16) already does; `tcpip:<port>` is the device service this
   * plan's H1 hypothesis is about — whether adbd accepts it this way with no
   * CLI spawn. The reply is not parsed for correctness: `cutover.ts` verifies
   * the effect independently by reading back `getprop service.adb.tcp.port`
   * (§3.4's own "verify by read-back" rule) — this method only reports
   * whether the SERVICE REQUEST itself was accepted (`readStatus` throws
   * `E_ADB_FAIL` otherwise), so a caller can fall back to
   * `hostAdb.run(['-s', serial, 'tcpip', String(port)])` on any throw here,
   * per H1's own documented fallback.
   */
  async tcpip(serial: string, port: number): Promise<void> {
    await this.withSocket(async (socket) => {
      socket.send(`host:transport:${serial}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
      socket.send(`tcpip:${port}`)
      await socket.readStatus({ timeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS })
    })
  }

  /** Path to the active adb binary (for the few CLI spawns needed, e.g. `adb pair`). */
  get binaryPath(): string {
    return this.adbPath
  }

  /** Number of queued tasks for one serial (debugging aid; also read by the Plan 23 metrics endpoint). */
  pending(serial: string): number {
    return this.queue.pending(serial)
  }

  /**
   * Used by the Toolchain Manager when swapping adb versions (plan 02 §4.11):
   * pause → waitIdle (drain) → [kill/start-server in the core] → resume.
   */
  pauseQueue(): void {
    this.queue.pause()
  }

  resumeQueue(): void {
    this.queue.resume()
  }

  waitQueueIdle(timeoutMs: number): Promise<boolean> {
    return this.queue.waitIdle(timeoutMs)
  }

  /** Point at a new adb binary after a version swap (path from the Toolchain Manager). */
  setAdbPath(path: string): void {
    this.adbPath = path
  }

  trackDevices(): DeviceTracker {
    if (!this.tracker) {
      this.tracker = new DeviceTracker({ host: this.host, port: this.port, onLog: this.onLog })
    }
    return this.tracker
  }

  async dispose(): Promise<void> {
    await this.tracker?.stop()
    this.tracker = null
  }
}
