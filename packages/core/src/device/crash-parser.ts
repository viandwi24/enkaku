/**
 * Parses `logcat -b crash,main -v threadtime` output into crash / ANR events
 * (plan 37 §4.2). This is the ONLY place that turns raw logcat lines into a
 * `CrashEvent` — the watcher (`crash-watcher.ts`) just feeds it lines.
 *
 * Recognises two AOSP-stable markers (both are printed by platform
 * components, not by the app under test, so they cannot be spoofed by a
 * script and do not drift across OEM skins — plan 37 §8 risks):
 *
 *  - **Crash** — a `threadtime`-formatted line tagged `AndroidRuntime` at
 *    priority `E` whose message is `FATAL EXCEPTION: <thread>`, followed by
 *    `Process: <pkg>, PID: <n>`, then the exception's own line
 *    (`<Class>: <message>`), then the Java stack until a line that does not
 *    continue it.
 *  - **ANR** — a line tagged `ActivityManager` at priority `E` whose message
 *    is `ANR in <pkg> (...)`, followed by continuation lines (`Reason: ...`
 *    and friends) from the same tag.
 *
 * A block is closed by whichever comes first: a line that does not continue
 * it (a different tag arrives — expected, since `crash,main` interleaves
 * every other app's main-buffer output with the crash buffer), a
 * `idleMs` gap with no further lines (default 2000ms — a trace split across
 * socket/WS chunks must not be dropped just because it arrived in two
 * pieces), or the block reaching `maxLines` (default 200 — a block that
 * never finds a natural end must not buffer forever).
 */

/** `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message` — Android's `-v threadtime` format. */
const THREADTIME_RE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s?(.*)$/

export interface CrashEvent {
  kind: 'crash' | 'anr'
  /** The offending package, e.g. `com.example.app`. */
  package: string
  /** The process name from the `Process:` line — usually equal to `package`,
   * different when the app declares `android:process` (e.g. `pkg:remote`). */
  process: string
  /** e.g. `java.lang.NullPointerException`; `'ANR'` for an ANR block. */
  exception: string
  /** The text after the exception class on its own line; the ANR reason for an ANR block. */
  message: string
  /** The full contiguous block, raw lines, newline-joined. */
  trace: string
  /** Epoch ms when the block started. */
  at: number
  /**
   * True for `android`, `com.android.*`, and anything that looks like a
   * launcher (plan 37 §4.2) — lets the `any` crash policy exclude platform
   * noise. Not part of the plan's illustrative interface, added because the
   * `any` policy is unimplementable without it (documented as a deliberate
   * addition in the plan-37 report).
   */
  system: boolean
  /** True when the block was cut off at `maxLines` rather than ending naturally. */
  truncated: boolean
}

export interface CrashParserOptions {
  /** Inactivity gap that closes an in-progress block. Default 2000ms (plan 37 §4.2). */
  idleMs?: number
  /** Hard cap on lines buffered for one block. Default 200 (plan 37 §4.2, acceptance #9). */
  maxLines?: number
  /** Injectable clock, purely for deterministic tests. */
  now?: () => number
}

const DEFAULT_IDLE_MS = 2000
const DEFAULT_MAX_LINES = 200

/** `android`, `com.android.*`, and common launcher packages (plan 37 §4.2). */
function isSystemPackage(pkg: string): boolean {
  if (pkg === 'android') return true
  if (pkg.startsWith('com.android.')) return true
  if (/launcher/i.test(pkg)) return true
  return false
}

interface ParsedLine {
  level: string
  tag: string
  message: string
}

function parseThreadtime(line: string): ParsedLine | null {
  const m = THREADTIME_RE.exec(line)
  if (!m) return null
  const level = m[1] ?? ''
  const tag = (m[2] ?? '').trim()
  const message = m[3] ?? ''
  return { level, tag, message }
}

interface CrashBlock {
  kind: 'crash' | 'anr'
  tag: string
  lines: string[]
  at: number
  pkg: string
  process: string
  exception: string
  message: string
  gotProcess: boolean
  gotException: boolean
}

/** `Process: com.example.app, PID: 12345` → `['com.example.app', '12345']`. */
const PROCESS_LINE_RE = /^Process:\s*([^\s,]+),\s*PID:\s*(\d+)/
/** `ANR in com.example.app (com.example.app/.MainActivity)` → `com.example.app`. */
const ANR_LINE_RE = /^ANR in\s+([^\s(]+)/

export function createCrashParser(onCrash: (e: CrashEvent) => void, opts: CrashParserOptions = {}): (line: string) => void {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const now = opts.now ?? (() => Date.now())

  let current: CrashBlock | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function emit(block: CrashBlock, truncated: boolean): void {
    onCrash({
      kind: block.kind,
      package: block.pkg,
      process: block.process || block.pkg,
      exception: block.exception,
      message: block.message,
      trace: block.lines.join('\n'),
      at: block.at,
      system: isSystemPackage(block.pkg),
      truncated,
    })
  }

  function closeBlock(truncated = false): void {
    clearIdleTimer()
    if (!current) return
    const block = current
    current = null
    // A block with no recognised package (parsing never found the `Process:`
    // or `ANR in` line — e.g. the stream was cut off after just the opening
    // line) is dropped rather than reported with an empty package, which
    // would be worse than useless downstream (an unattributable "crash").
    if (!block.pkg) return
    emit(block, truncated)
  }

  function resetIdleTimer(): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => closeBlock(false), idleMs)
  }

  function enrich(block: CrashBlock, parsed: ParsedLine): void {
    if (block.kind !== 'crash') return
    if (!block.gotProcess) {
      const m = PROCESS_LINE_RE.exec(parsed.message)
      if (m) {
        const process = m[1] ?? ''
        block.process = process
        // A `pkg:remote`-style process name — the package is the part before the colon.
        block.pkg = process.split(':')[0] ?? process
        block.gotProcess = true
      }
      return
    }
    if (!block.gotException) {
      const idx = parsed.message.indexOf(': ')
      if (idx >= 0) {
        block.exception = parsed.message.slice(0, idx)
        block.message = parsed.message.slice(idx + 2)
      } else {
        block.exception = parsed.message
        block.message = ''
      }
      block.gotException = true
    }
  }

  /**
   * True for a line that opens a NEW block, regardless of whether one is
   * already in progress — a second `FATAL EXCEPTION:` (or `ANR in`) arriving
   * on the same tag as an already-open block is a fresh crash starting
   * immediately after the previous one, not a continuation of it. Without
   * this check, two back-to-back crashes on the same tag (`AndroidRuntime`)
   * with no other tag's line in between would silently merge into one block.
   */
  function isStartMarker(parsed: ParsedLine): boolean {
    if (parsed.tag === 'AndroidRuntime' && parsed.level === 'E' && parsed.message.startsWith('FATAL EXCEPTION:')) return true
    if (parsed.tag === 'ActivityManager' && parsed.level === 'E' && parsed.message.startsWith('ANR in')) return true
    return false
  }

  function tryStart(line: string, parsed: ParsedLine): boolean {
    if (parsed.tag === 'AndroidRuntime' && parsed.level === 'E' && parsed.message.startsWith('FATAL EXCEPTION:')) {
      current = {
        kind: 'crash',
        tag: 'AndroidRuntime',
        lines: [line],
        at: now(),
        pkg: '',
        process: '',
        exception: '',
        message: '',
        gotProcess: false,
        gotException: false,
      }
      resetIdleTimer()
      return true
    }
    if (parsed.tag === 'ActivityManager' && parsed.level === 'E' && parsed.message.startsWith('ANR in')) {
      const m = ANR_LINE_RE.exec(parsed.message)
      const pkg = m?.[1] ?? ''
      current = {
        kind: 'anr',
        tag: 'ActivityManager',
        lines: [line],
        at: now(),
        pkg,
        process: pkg,
        exception: 'ANR',
        message: parsed.message,
        gotProcess: true,
        gotException: true,
      }
      resetIdleTimer()
      return true
    }
    return false
  }

  return function feed(line: string): void {
    const parsed = parseThreadtime(line)

    if (current) {
      const continues = parsed !== null && parsed.tag === current.tag && !isStartMarker(parsed)
      if (continues && parsed) {
        current.lines.push(line)
        enrich(current, parsed)
        if (current.lines.length >= maxLines) {
          closeBlock(true)
          return
        }
        resetIdleTimer()
        return
      }
      // Does not continue the open block — close it first, then see whether
      // THIS line starts a new one (plan 37 §4.2: "closed by the first line
      // that does not continue it").
      closeBlock(false)
    }

    if (!parsed) return
    tryStart(line, parsed)
  }
}
