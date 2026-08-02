import { LogcatOptionsSchema, optionsSchemaFor, type LogcatOptions, type MonitorKind } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'

/**
 * The ONLY place a monitor's adb command string is produced (plan 24 §4.3,
 * §3.7). Every interpolated value is either drawn from a Zod enum/regex
 * (`priority`, `buffer`, `tag`) or passed through `shellQuote()` below — this
 * is the structural guarantee behind "no free-form command entry": a caller
 * gets a fixed builder with typed options, never a string it composes itself.
 */

/**
 * POSIX single-quoting (works for adb's on-device `/system/bin/sh` the same
 * way it works for bash/dash): everything between single quotes is literal,
 * so `;`, backticks, `$(...)`, and double quotes cannot escape it. The only
 * character that needs special handling is a single quote itself — it ends
 * the quoted string, contributes an escaped `'`, and reopens a new one.
 *
 * `a"b;c$(id)\`` → `'a"b;c$(id)`'` — every one of those characters stays
 * inert inside the quotes.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

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
