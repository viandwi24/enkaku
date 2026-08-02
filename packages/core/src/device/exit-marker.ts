/**
 * The exit-code workaround (plan 26 §3.5): `adb shell:<cmd>` returns output
 * and closes with no exit status in the protocol at all. Asking the device
 * to print one itself, as the LAST line, is the standard workaround.
 */

/** Distinctive on purpose (plan 26 §8 risk table) — unlikely to collide with real command output. */
const EXIT_MARKER = '__ENKAKU_EXIT__'

/** Matches the marker only when it is the ENTIRE final line — never a substring match anywhere else. */
const EXIT_MARKER_RE = new RegExp(`^${EXIT_MARKER}(-?\\d+)$`)

/**
 * Appends the marker suffix to a command. `;` (not `&&`) so the marker
 * prints regardless of whether `cmd` itself succeeded — the exit code it
 * captures via `$?` IS that success/failure, so the marker's own printf
 * must never be skipped.
 */
export function withExitMarker(cmd: string): string {
  return `${cmd} ; printf '\\n${EXIT_MARKER}%d' $?`
}

/**
 * Strips the trailing marker (when present) and reports the exit code it
 * carried. Absent — the command killed the shell, or output was truncated
 * at the byte cap before the marker could be written — reports `null`
 * rather than guessing (plan 26 §3.5, §8).
 */
export function parseExitMarker(raw: string): { stdout: string; exitCode: number | null } {
  const lines = raw.split('\n')
  const last = lines[lines.length - 1] ?? ''
  const match = EXIT_MARKER_RE.exec(last)
  if (!match) return { stdout: raw, exitCode: null }
  return { stdout: lines.slice(0, -1).join('\n'), exitCode: Number.parseInt(match[1] as string, 10) }
}
