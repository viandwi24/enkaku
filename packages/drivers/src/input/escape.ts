/**
 * Escaping untuk `adb shell input text` (plan 03 §4.5):
 * - hanya ASCII printable — `input text` tidak andal untuk unicode/IME;
 *   teks penuh datang bersama UHID (Plan 08) / ui-server set_text (Plan 06)
 * - spasi → %s (kontrak `input text`), % literal → \%
 * - dibungkus single-quote shell, ' → '\''
 */
export class InputTextError extends Error {
  code = 'INPUT_TEXT_UNSUPPORTED'
}

export function escapeInputText(s: string): string {
  if (s.length === 0 || s.length > 1000) {
    throw new InputTextError('teks harus 1..1000 karakter')
  }
  if (/[^\x20-\x7e]/.test(s)) {
    throw new InputTextError('hanya ASCII printable yang didukung di mode input fallback (adb-input)')
  }
  const escaped = s.replaceAll('%', '\\%').replaceAll(' ', '%s').replaceAll("'", `'\\''`)
  return `'${escaped}'`
}
