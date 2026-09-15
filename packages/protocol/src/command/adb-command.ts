/**
 * What an operator types into an "adb command" box, turned into the command
 * the device shell actually runs (owner, 2026-09-15).
 *
 * The `adb` action verb and the terminal's `shell.exec` both run their `cmd`
 * INSIDE the device shell — the core hands it to `adb shell` itself. So the
 * natural thing to paste from a guide, `adb shell dumpsys battery`, used to
 * reach the phone as the literal line `adb shell dumpsys battery` and fail
 * with `adb: not found`. The dialog's own placeholder even suggested
 * `shell dumpsys battery`, which failed the same way.
 *
 * Three forms are accepted, and they mean the same command:
 *
 *   adb shell dumpsys battery      (also `adb -s <serial> shell …`, `adb -d shell …`)
 *   shell dumpsys battery
 *   dumpsys battery
 *
 * Rules, in order:
 *
 *  1. Surrounding whitespace, and a copied `$ ` prompt, are dropped.
 *  2. A leading `adb` (or `adb.exe`) is followed by adb's own global options,
 *     which are skipped: `-a -d -e` and `-s -t -H -P -L <value>`. The serial
 *     in `-s` is IGNORED on purpose — the target is the device set the UI
 *     already chose, and a serial pasted from someone else's guide must never
 *     quietly retarget a run. Then:
 *       - `shell` or `exec-out` → the rest is the command (see 4);
 *       - `logcat …` → `logcat …`, which is the same program in the shell;
 *       - anything else (`install`, `push`, `reboot`, …) is refused with a
 *         sentence naming what to use instead: it is not a shell command, and
 *         guessing a shell equivalent would run something nobody typed.
 *  3. A leading `shell` without `adb` is the same as rule 2's `shell`.
 *  4. After `shell`, adb's shell flags (`-n -T -t -tt -x`, `-e <char>`) are
 *     skipped. If what remains is ONE quoted string — `adb shell "ls | wc -l"`
 *     — its quotes are removed, because your local shell would have removed
 *     them before adb saw the line. Anything else is passed through verbatim,
 *     quotes and all, for the device shell to parse.
 *  5. Anything else is already a device shell command and is untouched.
 *
 * A bare `adb shell` (an interactive shell) is refused: nothing here holds a
 * terminal open. So is an empty line.
 *
 * NOT a security control, exactly like `isHighConsequence` beside it: it
 * never blocks a shell command, only recognises a prefix. Whether the caller
 * may run shell at all is decided before this runs (`privacy.adbCommand`,
 * `canUseShell`), and nothing here can widen it — every accepted input maps
 * to a device shell command, which is precisely what the gate already
 * governs.
 */

export type AdbCommandForm = 'bare' | 'shell' | 'adb-shell'

export type NormalizedAdbCommand = { ok: true; cmd: string; form: AdbCommandForm } | { ok: false; error: string }

/** adb global options that take a value (`adb --help`). */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-s', '-t', '-H', '-P', '-L'])
/** adb global flags. */
const GLOBAL_FLAGS = new Set(['-a', '-d', '-e'])
/** `adb shell` flags; `-e` alone takes a value (the escape character). */
const SHELL_FLAGS = new Set(['-n', '-T', '-t', '-tt', '-x'])

/** What to reach for instead, for the adb subcommands people paste most. */
const NOT_A_SHELL_COMMAND: Record<string, string> = {
  install: 'use Install apk',
  'install-multiple': 'use Install apk',
  uninstall: 'type `pm uninstall <package>` instead',
  push: 'use Upload file',
  pull: 'use Download file',
  connect: 'use Reconnect',
  disconnect: 'use Disconnect',
  reboot: 'type `svc power reboot` instead',
  root: 'it restarts adb itself and cannot run from here',
  unroot: 'it restarts adb itself and cannot run from here',
  'kill-server': 'use Restart adb server on the Tools page',
  'start-server': 'the farm manages the adb server itself',
  devices: 'the Devices page already lists them',
}

const TOKEN = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/

/** Removes one leading token and returns it with the rest, or null when nothing is left. */
function shift(text: string): { token: string; rest: string } | null {
  const m = TOKEN.exec(text)
  if (!m) return null
  return { token: m[1]!, rest: text.slice(m[0].length) }
}

/** `"…"` or `'…'` as the WHOLE string, without its quotes; null otherwise. */
function unwrapQuoted(text: string): string | null {
  const double = /^"((?:[^"\\]|\\.)*)"$/.exec(text)
  // Inside double quotes a POSIX shell only treats \ before $ ` " \ as an escape.
  if (double) return double[1]!.replace(/\\([$`"\\])/g, '$1')
  const single = /^'([^']*)'$/.exec(text)
  return single ? single[1]! : null
}

function shellRemainder(afterShell: string, form: AdbCommandForm): NormalizedAdbCommand {
  let rest = afterShell
  for (;;) {
    const next = shift(rest)
    if (!next) break
    if (SHELL_FLAGS.has(next.token)) {
      rest = next.rest
      continue
    }
    if (next.token === '-e') {
      const value = shift(next.rest)
      rest = value ? value.rest : ''
      continue
    }
    break
  }
  const trimmed = rest.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'An interactive shell cannot run from here — type the command to run, e.g. `adb shell dumpsys battery`.' }
  }
  const unwrapped = unwrapQuoted(trimmed)
  const cmd = unwrapped !== null ? unwrapped.trim() : trimmed
  if (cmd.length === 0) return { ok: false, error: 'The quoted command is empty.' }
  return { ok: true, cmd, form }
}

export function normalizeAdbCommand(raw: string): NormalizedAdbCommand {
  const line = raw.trim().replace(/^\$\s+/, '')
  if (line.length === 0) return { ok: false, error: 'Type a command.' }

  const adb = /^adb(?:\.exe)?(?=\s|$)/i.exec(line)
  if (adb) {
    let rest = line.slice(adb[0].length)
    for (;;) {
      const next = shift(rest)
      if (!next) {
        return { ok: false, error: 'Nothing follows `adb` — type `adb shell <command>`, `shell <command>`, or just the command.' }
      }
      if (GLOBAL_FLAGS.has(next.token)) {
        rest = next.rest
        continue
      }
      if (GLOBAL_OPTIONS_WITH_VALUE.has(next.token)) {
        const value = shift(next.rest)
        if (!value) return { ok: false, error: `\`adb ${next.token}\` needs a value, and a command after it.` }
        rest = value.rest
        continue
      }
      const sub = next.token.toLowerCase()
      if (sub === 'shell' || sub === 'exec-out') return shellRemainder(next.rest, 'adb-shell')
      if (sub === 'logcat') return { ok: true, cmd: `logcat${next.rest}`.trim(), form: 'adb-shell' }
      const hint = NOT_A_SHELL_COMMAND[sub]
      return {
        ok: false,
        error: `\`adb ${next.token}\` is not a shell command — this box runs commands inside the device shell${hint ? `; ${hint}` : ''}.`,
      }
    }
  }

  const shell = /^shell(?=\s|$)/i.exec(line)
  if (shell) return shellRemainder(line.slice(shell[0].length), 'shell')

  return { ok: true, cmd: line, form: 'bare' }
}
