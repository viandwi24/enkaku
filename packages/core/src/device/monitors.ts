import { LogcatOptionsSchema, optionsSchemaFor, type LogcatOptions, type MonitorKind } from '@enkaku/protocol'
import { shellQuote } from '@enkaku/adb'
import { EnkakuError } from '../util/errors'

/**
 * The ONLY place a monitor's adb command string is produced (plan 24 §4.3,
 * §3.7). Every interpolated value is either drawn from a Zod enum/regex
 * (`priority`, `buffer`, `tag`) or passed through `shellQuote()` — this is
 * the structural guarantee behind "no free-form command entry": a caller
 * gets a fixed builder with typed options, never a string it composes itself.
 *
 * `shellQuote` itself now lives in `@enkaku/adb` (plan 34 §4.3, plan 35 §4.2)
 * — `@enkaku/session` needed it too and must not import from `core` — and is
 * re-exported here so this module's own call sites, and plan 24's existing
 * tests (which import it from `./monitors`), are unaffected by the move.
 */
export { shellQuote }

function buildLogcatCommand(options: LogcatOptions): string {
  // Tag filtering silences everything else (`*:S`), matching logcat's own
  // filterspec idiom — without this, `-b <buffer> <tag>:<priority> *:<priority>`
  // would still print every other tag at `priority`, which is not what
  // "restrict to one tag" means.
  const filterSpec = options.tag ? `${options.tag}:${options.priority} *:S` : `*:${options.priority}`
  let cmd = `logcat -v time -b ${options.buffer} ${filterSpec}`
  if (options.filter) cmd += ` | grep -F ${shellQuote(options.filter)}`
  return cmd
}

/**
 * Resolve one monitor kind plus its raw (untrusted) options into the exact
 * adb shell command to run. Throws `E_BAD_REQUEST` for options that fail
 * validation — this is the enforcement point for "an unknown kind, or a
 * malformed options object, never reaches a device" (plan 24 §8 risks).
 */
export function buildMonitorCommand(kind: MonitorKind, rawOptions: unknown): string {
  const schema = optionsSchemaFor(kind)
  const parsed = schema.safeParse(rawOptions ?? {})
  if (!parsed.success) {
    throw new EnkakuError(
      'E_BAD_REQUEST',
      `invalid options for monitor "${kind}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  switch (kind) {
    case 'logcat':
      return buildLogcatCommand(LogcatOptionsSchema.parse(parsed.data))
    case 'top':
      // -b: non-interactive (batch) output; -d 2: refresh every 2s.
      return 'top -b -d 2'
    case 'thermal':
      // Not a single adb command — thermalservice/battery are both instant
      // snapshots, so the "stream" is a plain shell loop with a 5s pace
      // (plan 24 §4.3 table).
      return 'while true; do dumpsys thermalservice; dumpsys battery; sleep 5; done'
    case 'crash':
      // The crash watcher's own feed (plan 37 §3.2, §4.1) — `logcat -b crash`
      // is the dedicated crash-report buffer; ANRs land in `main` instead
      // (they are reported by ActivityManager, not the crash reporter), so
      // both buffers are read together and the parser (`crash-parser.ts`)
      // filters on the FATAL EXCEPTION / ANR markers. `-T 1` starts from the
      // tail so a fresh subscriber does not replay every crash since boot.
      return 'logcat -b crash,main -v threadtime -T 1'
    case 'ps':
      return 'ps -A'
    case 'meminfo':
      return 'dumpsys meminfo'
    case 'df':
      return 'df -h'
    default: {
      // Exhaustiveness at compile time (a new MonitorKind fails to build
      // here until this switch handles it) AND a runtime guard — the
      // MonitorKindSchema parse upstream is the primary boundary, but this
      // function must never silently no-op for a value that slipped past it.
      const exhaustive: never = kind
      throw new EnkakuError('E_BAD_REQUEST', `unknown monitor kind: ${String(exhaustive)}`)
    }
  }
}
