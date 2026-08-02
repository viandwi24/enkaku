/**
 * Credential redaction for the terminal's audit trail (plan 26 §3.3),
 * extending plan 18's redaction pass — which already exists for
 * `input.text` (`redactInputText` in `server/ws-handlers.ts`) — to command
 * LINES: `some-cli login --password hunter2` has the exact same problem
 * typed text does, just shaped as a flag instead of a form field.
 *
 * This is a log-hygiene measure only, not a security control (consistent
 * with plan 26 §3.4's position on the whole feature): the command still
 * runs on the device with its full value: redaction changes what is
 * WRITTEN to the event log, never what is executed.
 */

/**
 * Common credential-bearing CLI flags: `--password`, `-p`, `--pwd`,
 * `--pass`, `--token`, `--secret`, `--api-key` / `--apikey`, `--auth`,
 * `--credential`, in both `--flag value` and `--flag=value` shapes, with the
 * value optionally single- or double-quoted. Not an allowlist/denylist of
 * COMMANDS (§3.4 explicitly rejects that as a security control) — this
 * pattern list only decides what gets masked in the log, so a miss here is
 * a logging gap, never an execution gap.
 */
const CREDENTIAL_FLAG_RE =
  /(--?(?:password|passwd|pwd|pass|token|secret|api[-_]?key|apikey|auth|credential)\b)([=\s]+)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi

export function redactShellCommand(cmd: string): string {
  return cmd.replace(CREDENTIAL_FLAG_RE, (_match, flag: string, sep: string) => `${flag}${sep}[redacted]`)
}
