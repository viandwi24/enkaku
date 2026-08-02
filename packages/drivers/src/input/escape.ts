/**
 * Escaping for `adb shell input text` (plan 03 §4.5):
 * - printable ASCII only — `input text` is unreliable for unicode and IMEs;
 *   full text arrives with UHID (Plan 08) and ui-server set_text (Plan 06)
 * - spasi → %s (kontrak `input text`), % literal → \%
 * - dibungkus single-quote shell, ' → '\''
 */
export class InputTextError extends Error {
  code = 'INPUT_TEXT_UNSUPPORTED'
}

export function escapeInputText(s: string): string {
  if (s.length === 0 || s.length > 1000) {
    throw new InputTextError('text must be 1..1000 characters')
  }
  if (/[^\x20-\x7e]/.test(s)) {
    throw new InputTextError('only printable ASCII is supported in the fallback input mode (adb-input)')
  }
  const escaped = s.replaceAll('%', '\\%').replaceAll(' ', '%s').replaceAll("'", `'\\''`)
  return `'${escaped}'`
}
