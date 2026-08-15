/**
 * Patterns that raise a confirmation dialog before running (plan 26 §3.4,
 * §4.5). This is a USABILITY guard ONLY: the server does not know this list
 * exists, does not enforce it, and never will. §3.4 rejects an
 * allowlist/denylist over command strings as a security control outright —
 * `sh -c '…'`, a backtick, or a shell alias defeats any parser — so this
 * exists purely to make a human pause before a self-inflicted mistake, not
 * to stop anyone who actually intends to run the command.
 */
export const HIGH_CONSEQUENCE_PATTERNS: RegExp[] = [
  /\breboot\b/i,
  /\bsvc\s+power\b/i,
  /\bsettings\s+put\s+global\s+adb_enabled\b/i,
  // Android's own `start`/`stop` restart the entire framework, so they belong
  // here — but ONLY as a command in their own right. Anchoring to a separator
  // rather than to any whitespace is what stops `am start -a … -d <url>` from
  // being flagged: opening a page is not a device-wide act, and a warning that
  // cries wolf on an everyday command teaches people to dismiss every warning.
  /(^|[;&|]\s*)(stop|start)([\s;&|]|$)/i,
  /\brm\s+-rf\s+\//i,
  // plan 93 §3.14 — irreversible, takes the app's data with it. Anchored to
  // `uninstall`/`clear` as their own word so `pm list packages`, `pm path`
  // and `pm dump` do not fire.
  /\bpm\s+uninstall\b/i,
  /\bcmd\s+package\s+uninstall\b/i,
  /\bpm\s+clear\b/i,
]

/** Exported for `high-consequence.test.ts` — the patterns are easy to widen by accident. */
export function isHighConsequence(cmd: string): { hit: true; pattern: string } | { hit: false } {
  for (const re of HIGH_CONSEQUENCE_PATTERNS) {
    if (re.test(cmd)) return { hit: true, pattern: re.source }
  }
  return { hit: false }
}
