import type { UiServerLauncher } from './launcher'
import type { ConfiguratorInfo, UiServerClient } from './client'
import { createWatchdog, type UiServerStatus, type Watchdog, type WatchdogOptions } from './watchdog'
import { DEFAULT_CONFIGURATOR } from './client'

/**
 * A line of `am instrument -w -r` output, classified. `fatal` ends the start
 * at once; `started` is informational (the ping still decides readiness);
 * `noise` is every other line.
 */
export type InstrumentationLineKind = 'fatal' | 'started' | 'noise'

/**
 * Definitive failures, matched against one trimmed line (plan 208 §3.3).
 * Ordered from the repo's own measurement (launcher.ts, the
 * ClassNotFoundException at ~1.3 s) to the raw-mode vocabulary of the
 * platform (§9 Q3 confirms each on the lab device; add a row, never a
 * branch).
 */
export const INSTRUMENTATION_FATAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^INSTRUMENTATION_STATUS: stack=/, label: 'the instrumentation reported a stack trace' },
  { pattern: /ClassNotFoundException/, label: 'the stub class was not found' },
  { pattern: /^INSTRUMENTATION_STATUS: Error=/, label: 'the instrumentation reported an error' },
  { pattern: /^INSTRUMENTATION_RESULT: shortMsg=/, label: 'the instrumentation finished before the server was up' },
  { pattern: /Process crashed/, label: 'the instrumentation process crashed' },
  { pattern: /^INSTRUMENTATION_FAILED:/, label: 'am instrument could not start the runner' },
]

/** The runner announces the hosting test; readiness is still the ping. */
const STARTED_PATTERN = /^INSTRUMENTATION_STATUS_CODE: 1$/

export function classifyInstrumentationLine(line: string): { kind: InstrumentationLineKind; label?: string } {
  const trimmed = line.trim()
  for (const { pattern, label } of INSTRUMENTATION_FATAL_PATTERNS) {
    if (pattern.test(trimmed)) return { kind: 'fatal', label }
  }
  if (STARTED_PATTERN.test(trimmed)) return { kind: 'started' }
  return { kind: 'noise' }
}

/** Never let a stream that prints no newline grow the buffer without bound. */
export const INSTRUMENTATION_LINE_BUFFER_MAX = 64 * 1024

export interface InstrumentationParser {
  /** Feed raw bytes; complete lines are classified, the remainder is kept. */
  feed(chunk: Uint8Array): void
  /** Flush the remainder as a final line (on stream end). */
  end(): void
}

/**
 * Splits chunks into lines and reports the first fatal line ONCE; `onLine`
 * receives every complete line for debug logging. Pure apart from the two
 * callbacks, so the test feeds byte slices that split lines in the middle.
 */
export function createInstrumentationParser(hooks: {
  onFatal: (reason: string, line: string) => void
  onStarted?: () => void
  onLine?: (line: string) => void
}): InstrumentationParser {
  let buffer = ''
  let fatalReported = false
  const decoder = new TextDecoder()

  const handleLine = (line: string): void => {
    hooks.onLine?.(line)
    if (fatalReported) return
    const verdict = classifyInstrumentationLine(line)
    if (verdict.kind === 'fatal') {
      fatalReported = true
      hooks.onFatal(verdict.label ?? 'the instrumentation reported a failure', line)
    } else if (verdict.kind === 'started') {
      hooks.onStarted?.()
    }
  }

  return {
    feed(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        handleLine(line)
      }
      if (buffer.length > INSTRUMENTATION_LINE_BUFFER_MAX) {
        // A line that never ends: keep only the tail, so a chatty/broken
        // stream cannot grow this buffer without bound (it is still fed to
        // `handleLine` once the stream ends or a newline finally arrives).
        buffer = buffer.slice(buffer.length - INSTRUMENTATION_LINE_BUFFER_MAX)
      }
    },
    end(): void {
      buffer += decoder.decode()
      if (buffer.length > 0) {
        const line = buffer
        buffer = ''
        handleLine(line)
      }
    },
  }
}

/** The budget for a server that prints nothing; a fatal line never waits for it. */
export const INSTRUMENTATION_START_SILENCE_MS = 15_000

export type UiServerLifecycleState = 'idle' | 'starting' | 'ready' | 'dead' | 'failed' | 'closed'

export interface UiServerLifecycleOptions {
  serial: string
  client: UiServerClient
  launcher: UiServerLauncher
  localPort: number
  /** Sent after every `healthy` (start and restart). Default `DEFAULT_CONFIGURATOR`. */
  configurator?: ConfiguratorInfo
  onStatus?: (s: UiServerStatus) => void
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
  /** Forwarded to `createWatchdog` (tests shrink the real delays). */
  watchdog?: Pick<WatchdogOptions, 'idlePingMs' | 'startTimeoutMs' | 'maxRestartsPerWindow' | 'restartWindowMs' | 'restartBackoffMs'>
}

export interface UiServerLifecycle {
  /** Idempotent: a second call joins the first. Rejects with the fatal reason, the silence ceiling, or the launcher's own error. */
  start(): Promise<void>
  /** Resolves once `ready` (joins a start in flight); rejects when `failed`/`dead`/`closed`. */
  whenReady(): Promise<void>
  state(): UiServerLifecycleState
  /** Milliseconds from `start()` to `ready`, or null. The `inspector ready:` log line reads it. */
  startedInMs(): number | null
  /** The engine is done for this session: watchdog stopped, launcher stopped. Idempotent. */
  close(): Promise<void>
  /** Runtime failure report, forwarded to the watchdog (`UiServerInspector.call()`). */
  reportFailure(reason: string): void
  isDead(): boolean
}

export function createUiServerLifecycle(opts: UiServerLifecycleOptions): UiServerLifecycle {
  const configurator = opts.configurator ?? DEFAULT_CONFIGURATOR
  let state: UiServerLifecycleState = 'idle'
  let startPromise: Promise<void> | null = null
  let startedIn: number | null = null
  let closed = false

  const applyConfigurator = async (): Promise<void> => {
    try {
      await opts.client.setConfigurator(configurator)
      const effective = await opts.client.getConfigurator()
      opts.onLog?.('info', `ui-server configurator on ${opts.serial}: ${JSON.stringify(effective)}`)
    } catch (err) {
      opts.onLog?.('warn', `could not set the ui-server configurator on ${opts.serial}: ${String(err)}`)
    }
  }

  const watchdog: Watchdog = createWatchdog({
    client: opts.client,
    launcher: opts.launcher,
    localPort: opts.localPort,
    onStatus: (s: UiServerStatus) => {
      if (s.state === 'starting') state = 'starting'
      else if (s.state === 'healthy') state = 'ready'
      else if (s.state === 'restarting') state = 'starting'
      else if (s.state === 'dead') state = 'dead'
      opts.onStatus?.(s)
    },
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    onReady: applyConfigurator,
    ...(opts.watchdog ?? {}),
  })

  return {
    start(): Promise<void> {
      if (closed) return Promise.reject(new Error('the ui-server lifecycle is closed'))
      if (startPromise) return startPromise
      state = 'starting'
      const t0 = Date.now()
      startPromise = watchdog
        .start()
        .then(() => {
          state = 'ready'
          startedIn = Date.now() - t0
        })
        .catch((err) => {
          // `dead` (set by the watchdog's own `onStatus` hook, just above)
          // names a runtime circuit-breaker trip AFTER a successful start;
          // a rejection of THIS start — the only way `startPromise` itself
          // rejects — is always `failed`, regardless of what the watchdog's
          // status hook reported a moment earlier for the same event.
          state = 'failed'
          throw err
        })
      return startPromise
    },
    whenReady(): Promise<void> {
      return startPromise ?? Promise.reject(new Error('start() was never called'))
    },
    state(): UiServerLifecycleState {
      return state
    },
    startedInMs(): number | null {
      return startedIn
    },
    async close(): Promise<void> {
      closed = true
      state = 'closed'
      await watchdog.stop()
    },
    reportFailure(reason: string): void {
      watchdog.reportFailure(reason)
    },
    isDead(): boolean {
      return watchdog.isDead()
    },
  }
}
