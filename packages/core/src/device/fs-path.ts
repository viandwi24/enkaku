import { EnkakuError } from '../util/errors'

/**
 * Path rules for the DEVICE file manager (plan 800 D1) — deliberately NOT
 * `validateRemotePath` (`./path-validate.ts`), and the difference is the point.
 *
 * That validator restricts a path to `[A-Za-z0-9_.-/]`, which is right for
 * `push`/`pull`: the caller chooses the destination, so a narrow character set
 * costs nothing. A file MANAGER does not choose — it shows what is already on
 * the phone, and real phones are full of `IMG_20260901 (1).jpg`,
 * `Screenshot 2026-09-01.png`, and `WhatsApp Video 2026-09-01 at 10.11.12.mp4`.
 * Reusing the narrow rule would mean an operator could see those files and not
 * be able to rename or delete one, which is worse than not listing them.
 *
 * What actually keeps a path safe in a shell command is `shellQuote` — POSIX
 * single-quoting, inside which no metacharacter can act. So this validator is
 * defence in depth, not the defence: it rejects what would break the PARSER or
 * the semantics, rather than trying to enumerate dangerous characters.
 *
 * A newline is the one character genuinely refused on those grounds: `ls -A`
 * is read line by line, so a filename containing one would be read as two
 * entries. Such a file cannot be addressed through this API, and saying so is
 * better than acting on the wrong path.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function validateDevicePath(path: unknown, field = 'path'): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new EnkakuError('E_BAD_PATH', `${field} is required`)
  }
  if (!path.startsWith('/')) {
    throw new EnkakuError('E_BAD_PATH', `${field} must be an absolute path`)
  }
  if (path.length > 4096) {
    throw new EnkakuError('E_BAD_PATH', `${field} is too long`)
  }
  if (CONTROL_CHARS.test(path)) {
    throw new EnkakuError(
      'E_BAD_PATH',
      `${field} contains a control character or newline, which this API cannot address unambiguously`,
    )
  }
  // `..` is refused even though the shell would resolve it: a path this API
  // acts on must mean one thing when read, and a caller reasoning about
  // "is this under /sdcard" cannot do so with `..` still in play.
  if (path.split('/').some((segment) => segment === '..')) {
    throw new EnkakuError('E_BAD_PATH', `${field} must not contain ".."`)
  }
  return path
}

/**
 * Where a WRITE is allowed. Reads are not confined — an operator debugging a
 * device should be able to look at `/system/etc` — but `mv`, `rm` and `mkdir`
 * are, and the asymmetry is deliberate: looking at the wrong directory costs
 * nothing, and `rm -r` on it is unrecoverable.
 *
 * Both spellings of the external volume are listed for the same reason
 * `MEDIA_ROOTS` lists both (`transfer.ts`): OEM builds and API levels disagree
 * about which one a caller actually sees. `/data/local/tmp` is included
 * because it is the shell's own scratch space and every adb workflow already
 * uses it.
 *
 * This is not a security boundary — the shell can do as it pleases, and spec
 * §11.3 is explicit that a script is never sandboxed. It is a guard against an
 * operator's typo and a script's bad variable, which is what actually goes
 * wrong in practice.
 */
export const DEVICE_FS_WRITABLE_ROOTS = [
  '/sdcard',
  '/storage/emulated/0',
  '/storage/self/primary',
  '/data/local/tmp',
] as const

export function isUnderWritableRoot(path: string): boolean {
  return DEVICE_FS_WRITABLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
}

/**
 * Validates a path a MUTATING op will act on. Kept separate from the read
 * validator so a destructive operation can never be reached through the
 * permissive one by accident — they are different questions with different
 * answers.
 */
export function validateWritableDevicePath(path: unknown, field = 'path'): string {
  const valid = validateDevicePath(path, field)
  if (!isUnderWritableRoot(valid)) {
    throw new EnkakuError(
      'E_PATH_NOT_WRITABLE',
      `${field} must be under one of ${DEVICE_FS_WRITABLE_ROOTS.join(', ')} — this API reads anywhere but writes only under user storage`,
    )
  }
  // A root itself may be listed and written INTO, never renamed or removed:
  // `rm -r /sdcard` is a whole phone's storage, and no typo should reach it.
  if (DEVICE_FS_WRITABLE_ROOTS.some((root) => root === valid)) {
    throw new EnkakuError('E_PATH_NOT_WRITABLE', `${field} is a storage root and cannot itself be moved or removed`)
  }
  return valid
}
