/**
 * POSIX single-quoting (works for adb's on-device `/system/bin/sh` the same
 * way it works for bash/dash): everything between single quotes is literal,
 * so `;`, backticks, `$(...)`, and double quotes cannot escape it. The only
 * character that needs special handling is a single quote itself — it ends
 * the quoted string, contributes an escaped `'`, and reopens a new one.
 *
 * `a"b;c$(id)\`` → `'a"b;c$(id)`'` — every one of those characters stays
 * inert inside the quotes.
 *
 * Moved here from `packages/core/src/device/monitors.ts` (plan 24 §4.3) by
 * plan 34 §4.3 / plan 35 §4.2: this is the only place any package builds an
 * adb shell command string with an interpolated value, and `@enkaku/session`
 * must not import from `core` (core sits above session in the dependency
 * graph) to reuse it. `monitors.ts` re-exports this rather than keeping its
 * own copy, so plan 24's tests keep passing unchanged.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
