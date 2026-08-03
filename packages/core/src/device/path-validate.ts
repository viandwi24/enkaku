import { EnkakuError } from '../util/errors'

/**
 * Validates a device-side path a caller supplies for push/pull (plan 39 §4.4,
 * §4.6, acceptance #11) — used by both the HTTP routes and the script API's
 * `device.push`/`device.pull`, so a `remotePath` is checked exactly once,
 * the same way, everywhere it can originate.
 *
 * Deliberately conservative: absolute, no `..` segment, and restricted to a
 * safe character set. This is NOT a security sandbox (spec §11.3) — it exists
 * so an operator's typo cannot walk out of `/sdcard` into `/data/data`, and
 * so the path can be interpolated into a shell command (after `shellQuote`)
 * without carrying a metacharacter that would need it to defend against.
 */
const SAFE_PATH = /^[A-Za-z0-9_.\-/]+$/

export function validateRemotePath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new EnkakuError('E_BAD_PATH', 'remotePath is required')
  }
  if (!path.startsWith('/')) {
    throw new EnkakuError('E_BAD_PATH', 'remotePath must be an absolute path')
  }
  if (path.length > 4096) {
    throw new EnkakuError('E_BAD_PATH', 'remotePath is too long')
  }
  if (!SAFE_PATH.test(path)) {
    throw new EnkakuError('E_BAD_PATH', 'remotePath contains characters other than letters, digits, "_.-/"')
  }
  if (path.split('/').some((segment) => segment === '..')) {
    throw new EnkakuError('E_BAD_PATH', 'remotePath must not contain ".."')
  }
  return path
}
