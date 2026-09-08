import { shellQuote } from '@enkaku/adb'
import type {
  DeviceFsEntry,
  DeviceFsKind,
  DeviceFsListResult,
  DeviceFsOkResult,
  DeviceFsStatResult,
} from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { validateDevicePath, validateWritableDevicePath } from './fs-path'

/**
 * The device file manager's shell layer (plan 700 D1), built the same way
 * `media-query.ts` is: a pure parser over command output, and a thin transport
 * around it holding no parsing logic at all.
 *
 * **Why `stat` and not `ls -l`.** `ls -l`'s output is a human report — its date
 * format varies by build and locale, the column count differs between toybox
 * and BusyBox, and a filename containing spaces cannot be told apart from the
 * columns before it. `stat -c` takes an explicit format string, so every field
 * is chosen here rather than guessed from a layout: sizes are bytes, times are
 * unix seconds, and the NAME comes last so anything it contains — spaces,
 * pipes, quotes — is simply the rest of the line.
 */

/** Chosen so `%n` is last: everything after the third `|` is the name, whatever it holds. */
const STAT_FORMAT = '%s|%Y|%F|%n'

export interface DeviceFsBackend {
  /** Returns null when the command could not be run at all — never throws. */
  exec(cmd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string } | null>
}

/**
 * `%F` is a human phrase ("regular file", "directory", "symbolic link"), which
 * is stable across toybox and coreutils. Anything that is neither a plain file
 * nor a directory is `other` on purpose — see `DeviceFsKindSchema`.
 */
function kindFromFileType(fileType: string): DeviceFsKind {
  const t = fileType.trim().toLowerCase()
  if (t === 'directory') return 'dir'
  if (t === 'regular file' || t === 'regular empty file') return 'file'
  return 'other'
}

const int = (v: string): number | null => {
  const n = Number.parseInt(v, 10)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * One `stat -c '%s|%Y|%F|%n'` line to an entry.
 *
 * Splits on the first three separators only. A filename holding a `|` — legal
 * on every Android filesystem — would otherwise lose everything after it, or
 * worse, have part of its own name parsed as a field.
 */
export function parseStatLine(line: string): DeviceFsEntry | null {
  const trimmed = line.trimEnd()
  if (trimmed.length === 0) return null
  const first = trimmed.indexOf('|')
  const second = trimmed.indexOf('|', first + 1)
  const third = trimmed.indexOf('|', second + 1)
  if (first < 0 || second < 0 || third < 0) return null

  const path = trimmed.slice(third + 1)
  if (path.length === 0) return null

  return {
    name: path.split('/').pop() || path,
    path,
    kind: kindFromFileType(trimmed.slice(second + 1, third)),
    sizeBytes: int(trimmed.slice(0, first)),
    modifiedAt: int(trimmed.slice(first + 1, second)),
  }
}

export function parseStatOutput(stdout: string): DeviceFsEntry[] {
  return stdout
    .split('\n')
    .map(parseStatLine)
    .filter((e): e is DeviceFsEntry => e !== null)
}

/**
 * Directories first, then files, each alphabetical and case-insensitive —
 * decided once here rather than in each client, so a script's view and the UI's
 * view of the same directory never disagree about what "the first entry" is.
 */
function sortEntries(entries: DeviceFsEntry[]): DeviceFsEntry[] {
  const rank = (k: DeviceFsKind): number => (k === 'dir' ? 0 : k === 'file' ? 1 : 2)
  return [...entries].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Lists a directory in ONE shell round trip.
 *
 * `find -maxdepth 1` rather than `ls` piped into `stat`: it enumerates and
 * stats together, includes dotfiles without a second glob, and `-mindepth 1`
 * keeps the directory itself out of its own listing. `2>/dev/null` on the stat
 * half only — a file deleted between the enumerate and the stat is normal on a
 * live phone and must not fail the listing, but a failure to read the DIRECTORY
 * still has to surface, which the exit code carries.
 */
export async function listDeviceFs(
  backend: DeviceFsBackend,
  args: { path: string; limit: number },
): Promise<DeviceFsListResult> {
  const path = validateDevicePath(args.path)
  const quoted = shellQuote(path)

  // `-mindepth 1 -maxdepth 1` is one level, excluding the directory itself.
  // One extra row is fetched so `truncated` reflects the device's real count
  // rather than "we happened to fill the window".
  const cmd = `find ${quoted} -mindepth 1 -maxdepth 1 -exec stat -c ${shellQuote(STAT_FORMAT)} {} + 2>/dev/null | head -n ${args.limit + 1}`
  const res = await backend.exec(cmd)
  if (!res) throw new EnkakuError('E_DEVICE_FS_FAILED', `could not list ${path} — the shell command did not run`)

  const entries = parseStatOutput(res.stdout)
  if (entries.length === 0 && res.exitCode !== 0) {
    // Nothing parsed AND a non-zero exit: the directory is genuinely
    // unreadable. An empty directory exits 0 with no output, so the two cases
    // are distinguishable and are never reported as the same thing.
    throw new EnkakuError('E_DEVICE_FS_FAILED', `could not list ${path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
  }

  const truncated = entries.length > args.limit
  return { entries: sortEntries(truncated ? entries.slice(0, args.limit) : entries), truncated }
}

/** One path. A missing path is `{ entry: null }`, never an error — "not there" is an answer. */
export async function statDeviceFs(backend: DeviceFsBackend, args: { path: string }): Promise<DeviceFsStatResult> {
  const path = validateDevicePath(args.path)
  const res = await backend.exec(`stat -c ${shellQuote(STAT_FORMAT)} ${shellQuote(path)} 2>/dev/null`)
  if (!res) throw new EnkakuError('E_DEVICE_FS_FAILED', `could not stat ${path} — the shell command did not run`)
  return { entry: parseStatOutput(res.stdout)[0] ?? null }
}

/** True when something exists at `path`. Used by the guards below, which must not rely on `mv`/`rm` semantics differing between builds. */
async function exists(backend: DeviceFsBackend, path: string): Promise<boolean> {
  const res = await backend.exec(`stat -c ${shellQuote('%F')} ${shellQuote(path)} 2>/dev/null`)
  return res !== null && res.exitCode === 0 && res.stdout.trim().length > 0
}

/**
 * Rename or move. Both ends must be under a writable root: a move is a delete
 * at the source, so a source outside user storage is as dangerous as a
 * destination inside it.
 *
 * The overwrite check is an explicit `stat` rather than `mv -n`, because `-n`
 * is not universally present on Android's toybox and, where it is missing, is
 * silently ignored — which would clobber the destination while the caller
 * believed it was protected.
 */
export async function moveDeviceFs(
  backend: DeviceFsBackend,
  args: { from: string; to: string; overwrite: boolean },
): Promise<DeviceFsOkResult> {
  const from = validateWritableDevicePath(args.from, 'from')
  const to = validateWritableDevicePath(args.to, 'to')
  if (from === to) throw new EnkakuError('E_BAD_REQUEST', 'from and to are the same path')

  if (!args.overwrite && (await exists(backend, to))) {
    throw new EnkakuError('E_EXISTS', `${to} already exists — pass overwrite to replace it`)
  }

  const res = await backend.exec(`mv -f ${shellQuote(from)} ${shellQuote(to)}`)
  if (!res) throw new EnkakuError('E_DEVICE_FS_FAILED', `could not move ${from} — the shell command did not run`)
  if (res.exitCode !== 0) {
    throw new EnkakuError('E_DEVICE_FS_FAILED', `could not move ${from} to ${to}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
  }
  return { ok: true, path: to }
}

/**
 * Delete a file, or a directory when `recursive`.
 *
 * A non-empty directory without `recursive` is refused BEFORE running anything,
 * rather than letting `rm` fail: the refusal names what would have been
 * destroyed, and a caller who then passes `recursive` is making that choice
 * knowingly instead of retrying a command they did not understand.
 */
export async function deleteDeviceFs(
  backend: DeviceFsBackend,
  args: { path: string; recursive: boolean },
): Promise<DeviceFsOkResult> {
  const path = validateWritableDevicePath(args.path)

  const { entry } = await statDeviceFs(backend, { path })
  if (entry === null) throw new EnkakuError('E_NOT_FOUND', `nothing exists at ${path}`)
  if (entry.kind === 'dir' && !args.recursive) {
    throw new EnkakuError('E_IS_DIRECTORY', `${path} is a directory — pass recursive to delete it and everything under it`)
  }

  const res = await backend.exec(`rm ${args.recursive ? '-rf' : '-f'} ${shellQuote(path)}`)
  if (!res) throw new EnkakuError('E_DEVICE_FS_FAILED', `could not delete ${path} — the shell command did not run`)
  if (res.exitCode !== 0) {
    throw new EnkakuError('E_DEVICE_FS_FAILED', `could not delete ${path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
  }
  return { ok: true, path }
}

export async function mkdirDeviceFs(
  backend: DeviceFsBackend,
  args: { path: string; parents: boolean },
): Promise<DeviceFsOkResult> {
  const path = validateWritableDevicePath(args.path)
  const res = await backend.exec(`mkdir ${args.parents ? '-p ' : ''}${shellQuote(path)}`)
  if (!res) throw new EnkakuError('E_DEVICE_FS_FAILED', `could not create ${path} — the shell command did not run`)
  if (res.exitCode !== 0) {
    throw new EnkakuError('E_DEVICE_FS_FAILED', `could not create ${path}: ${res.stderr.trim() || `exit ${res.exitCode}`}`)
  }
  return { ok: true, path }
}
