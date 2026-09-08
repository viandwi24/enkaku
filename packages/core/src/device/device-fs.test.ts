import { describe, expect, test } from 'bun:test'
import {
  deleteDeviceFs,
  listDeviceFs,
  mkdirDeviceFs,
  moveDeviceFs,
  parseStatLine,
  parseStatOutput,
  statDeviceFs,
} from './device-fs'
import { DEVICE_FS_WRITABLE_ROOTS, isUnderWritableRoot, validateDevicePath, validateWritableDevicePath } from './fs-path'

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

/** Records every command issued, so a test can assert what actually reached the shell. */
function backendOf(impl: (cmd: string) => { exitCode: number | null; stdout: string; stderr: string } | null) {
  const seen: string[] = []
  return { seen, backend: { exec: async (cmd: string) => (seen.push(cmd), impl(cmd)) } }
}

describe('parseStatLine', () => {
  test('reads size, mtime, kind and path from the four-field format', () => {
    expect(parseStatLine('1048576|1725782400|regular file|/sdcard/DCIM/Camera/a.mp4')).toEqual({
      name: 'a.mp4',
      path: '/sdcard/DCIM/Camera/a.mp4',
      kind: 'file',
      sizeBytes: 1_048_576,
      modifiedAt: 1_725_782_400,
    })
  })

  test('a directory is a dir, and an empty regular file is still a file', () => {
    expect(parseStatLine('4096|1|directory|/sdcard/DCIM')?.kind).toBe('dir')
    expect(parseStatLine('0|1|regular empty file|/sdcard/a.txt')?.kind).toBe('file')
  })

  test('a symlink is "other", never silently a file', () => {
    expect(parseStatLine('12|1|symbolic link|/sdcard/link')?.kind).toBe('other')
  })

  /**
   * The reason `%n` is the last field. A pipe is legal in an Android filename,
   * and splitting on every separator would lose part of the name — or parse
   * part of it as a field.
   */
  test('a filename containing the separator survives intact', () => {
    const entry = parseStatLine('10|20|regular file|/sdcard/Movies/a|b|c.mp4')
    expect(entry?.path).toBe('/sdcard/Movies/a|b|c.mp4')
    expect(entry?.name).toBe('a|b|c.mp4')
    expect(entry?.sizeBytes).toBe(10)
  })

  test('spaces and parentheses — what real phones are full of — are kept', () => {
    expect(parseStatLine('10|20|regular file|/sdcard/DCIM/IMG_20260901 (1).jpg')?.name).toBe('IMG_20260901 (1).jpg')
  })

  test('a malformed or empty line is dropped, never half-parsed', () => {
    expect(parseStatLine('')).toBeNull()
    expect(parseStatLine('stat: unknown option')).toBeNull()
    expect(parseStatLine('10|20|regular file|')).toBeNull()
  })

  test('an unparseable size or mtime is null, not zero — "unknown" is not "empty"', () => {
    const entry = parseStatLine('?|?|regular file|/sdcard/a.mp4')
    expect(entry?.sizeBytes).toBeNull()
    expect(entry?.modifiedAt).toBeNull()
  })
})

describe('parseStatOutput', () => {
  test('keeps the good lines and drops stderr noise mixed into stdout', () => {
    const out = ['10|20|regular file|/sdcard/a.mp4', 'stat: cannot read', '4096|21|directory|/sdcard/sub'].join('\n')
    expect(parseStatOutput(out).map((e) => e.name)).toEqual(['a.mp4', 'sub'])
  })
})

describe('listDeviceFs', () => {
  const DUMP = [
    '10|30|regular file|/sdcard/DCIM/b.mp4',
    '4096|20|directory|/sdcard/DCIM/Camera',
    '10|10|regular file|/sdcard/DCIM/a.mp4',
  ].join('\n')

  test('directories come first, then files, each alphabetical', async () => {
    const { backend } = backendOf(() => ok(DUMP))
    const res = await listDeviceFs(backend, { path: '/sdcard/DCIM', limit: 100 })
    expect(res.entries.map((e) => e.name)).toEqual(['Camera', 'a.mp4', 'b.mp4'])
    expect(res.truncated).toBe(false)
  })

  test('one level only, excluding the directory itself', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    await listDeviceFs(backend, { path: '/sdcard/DCIM', limit: 100 })
    expect(seen[0]).toContain('-mindepth 1 -maxdepth 1')
  })

  test('a full window reports truncation from the device row count', async () => {
    const { backend } = backendOf(() => ok(DUMP))
    const res = await listDeviceFs(backend, { path: '/sdcard/DCIM', limit: 2 })
    expect(res.entries).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })

  /** An empty directory exits 0 with no output; an unreadable one exits non-zero. The two must never be reported alike. */
  test('an empty directory is an empty list, not a failure', async () => {
    const { backend } = backendOf(() => ok(''))
    expect(await listDeviceFs(backend, { path: '/sdcard/Empty', limit: 10 })).toEqual({ entries: [], truncated: false, usage: null })
  })

  test('an unreadable directory throws with the shell reason', async () => {
    const { backend } = backendOf(() => ({ exitCode: 1, stdout: '', stderr: 'Permission denied' }))
    expect(listDeviceFs(backend, { path: '/data/data', limit: 10 })).rejects.toThrow(/Permission denied/)
  })

  test('reads are NOT confined to the writable roots — looking costs nothing', async () => {
    const { backend } = backendOf(() => ok('4096|1|directory|/system/etc/x'))
    await expect(listDeviceFs(backend, { path: '/system/etc', limit: 10 })).resolves.toBeDefined()
  })

  test('a relative path is refused before any command runs', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    expect(listDeviceFs(backend, { path: 'sdcard/DCIM', limit: 10 })).rejects.toThrow(/absolute/)
    expect(seen).toHaveLength(0)
  })
})

describe('free space rides along with the listing', () => {
  test("`df`'s last line is read from the END, so a filesystem name with spaces still parses", async () => {
    const stdout = ['10|30|regular file|/sdcard/a.mp4', '@@enkaku-df@@', 'my volume 1000000 400000 500000 45% /storage/emulated'].join('\n')
    const { backend } = backendOf(() => ok(stdout))
    const res = await listDeviceFs(backend, { path: '/sdcard', limit: 10 })
    // Columns counted back from the mountpoint: total, used, available, use%, mount.
    expect(res.usage).toEqual({ totalBytes: 1_000_000 * 1024, freeBytes: 500_000 * 1024 })
  })

  test('an unreadable df is null, and never costs the listing', async () => {
    const { backend } = backendOf(() => ok(['4096|1|directory|/sdcard/DCIM', '@@enkaku-df@@', 'df: not found'].join('\n')))
    const res = await listDeviceFs(backend, { path: '/sdcard', limit: 10 })
    expect(res.usage).toBeNull()
    expect(res.entries).toHaveLength(1)
  })

  test('the df output is never mistaken for a file', async () => {
    const stdout = ['10|30|regular file|/sdcard/a.mp4', '@@enkaku-df@@', '/dev/x 100 10 90 10% /sdcard'].join('\n')
    const { backend } = backendOf(() => ok(stdout))
    expect((await listDeviceFs(backend, { path: '/sdcard', limit: 10 })).entries.map((e) => e.name)).toEqual(['a.mp4'])
  })
})

describe('statDeviceFs', () => {
  test('a missing path is { entry: null } — "not there" is an answer, not an error', async () => {
    const { backend } = backendOf(() => ({ exitCode: 1, stdout: '', stderr: 'No such file' }))
    expect(await statDeviceFs(backend, { path: '/sdcard/nope.mp4' })).toEqual({ entry: null })
  })
})

describe('moveDeviceFs', () => {
  test('refuses to clobber the destination unless asked', async () => {
    // The first stat is the existence probe; it finding something must stop the move.
    const { seen, backend } = backendOf(() => ok('regular file'))
    expect(
      moveDeviceFs(backend, { from: '/sdcard/a.mp4', to: '/sdcard/b.mp4', overwrite: false }),
    ).rejects.toThrow(/already exists/)
    expect(seen.some((c) => c.startsWith('mv '))).toBe(false)
  })

  test('overwrite runs the move even when the destination exists', async () => {
    const { seen, backend } = backendOf((cmd) => (cmd.startsWith('mv ') ? ok('') : ok('regular file')))
    await moveDeviceFs(backend, { from: '/sdcard/a.mp4', to: '/sdcard/b.mp4', overwrite: true })
    expect(seen.some((c) => c.startsWith('mv '))).toBe(true)
  })

  test('a rename to the same path is refused', async () => {
    const { backend } = backendOf(() => ok(''))
    expect(moveDeviceFs(backend, { from: '/sdcard/a.mp4', to: '/sdcard/a.mp4', overwrite: true })).rejects.toThrow(/same path/)
  })

  test('both ends are confined — a move is a delete at the source', async () => {
    const { backend } = backendOf(() => ok(''))
    expect(moveDeviceFs(backend, { from: '/system/x', to: '/sdcard/x', overwrite: true })).rejects.toThrow(/writes only under user storage/)
    expect(moveDeviceFs(backend, { from: '/sdcard/x', to: '/system/x', overwrite: true })).rejects.toThrow(/writes only under user storage/)
  })

  test('the shell reason reaches the caller when mv fails', async () => {
    const { backend } = backendOf((cmd) =>
      cmd.startsWith('mv ') ? { exitCode: 1, stdout: '', stderr: 'Read-only file system' } : { exitCode: 1, stdout: '', stderr: '' },
    )
    expect(moveDeviceFs(backend, { from: '/sdcard/a', to: '/sdcard/b', overwrite: true })).rejects.toThrow(/Read-only file system/)
  })
})

describe('deleteDeviceFs', () => {
  const statAs = (fileType: string) => (cmd: string) =>
    cmd.startsWith('stat ') ? ok(`0|1|${fileType}|/sdcard/target`) : ok('')

  test('a non-empty directory needs recursive stated explicitly', async () => {
    const { seen, backend } = backendOf(statAs('directory'))
    expect(deleteDeviceFs(backend, { path: '/sdcard/target', recursive: false })).rejects.toThrow(/pass recursive/)
    expect(seen.some((c) => c.startsWith('rm '))).toBe(false)
  })

  test('recursive deletes the directory', async () => {
    const { seen, backend } = backendOf(statAs('directory'))
    await deleteDeviceFs(backend, { path: '/sdcard/target', recursive: true })
    expect(seen.some((c) => c.startsWith('rm -rf '))).toBe(true)
  })

  test('a file deletes without recursive', async () => {
    const { seen, backend } = backendOf(statAs('regular file'))
    await deleteDeviceFs(backend, { path: '/sdcard/target', recursive: false })
    expect(seen.some((c) => c.startsWith('rm -f '))).toBe(true)
  })

  test('deleting something that is not there is an error, not a silent success', async () => {
    const { backend } = backendOf(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    expect(deleteDeviceFs(backend, { path: '/sdcard/gone', recursive: false })).rejects.toThrow(/nothing exists/)
  })

  test('a storage root itself can never be removed, however the call is shaped', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    for (const root of DEVICE_FS_WRITABLE_ROOTS) {
      expect(deleteDeviceFs(backend, { path: root, recursive: true })).rejects.toThrow(/storage root/)
    }
    expect(seen).toHaveLength(0)
  })

  test('a path outside user storage is refused before anything runs', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    expect(deleteDeviceFs(backend, { path: '/system/app/Thing.apk', recursive: false })).rejects.toThrow(/writes only under user storage/)
    expect(seen).toHaveLength(0)
  })
})

describe('mkdirDeviceFs', () => {
  test('parents by default', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    await mkdirDeviceFs(backend, { path: '/sdcard/a/b/c', parents: true })
    expect(seen[0]).toContain('mkdir -p ')
  })

  test('without parents the flag is absent', async () => {
    const { seen, backend } = backendOf(() => ok(''))
    await mkdirDeviceFs(backend, { path: '/sdcard/a', parents: false })
    expect(seen[0]?.startsWith('mkdir ')).toBe(true)
    expect(seen[0]).not.toContain('-p')
  })
})

describe('path rules', () => {
  test('a file manager must address the names real phones hold', () => {
    // Every one of these is refused by `validateRemotePath` (push/pull's narrow
    // rule) and must be accepted here — that difference is the whole point.
    expect(validateDevicePath('/sdcard/DCIM/IMG_20260901 (1).jpg')).toBeTruthy()
    expect(validateDevicePath('/sdcard/WhatsApp Video 2026-09-01 at 10.11.12.mp4')).toBeTruthy()
    expect(validateDevicePath('/sdcard/Music/Beyoncé — Halo.mp3')).toBeTruthy()
  })

  test('a newline is refused: `find` output is read line by line', () => {
    expect(() => validateDevicePath('/sdcard/a\nb.mp4')).toThrow(/control character/)
  })

  test('".." is refused so a path means one thing when read', () => {
    expect(() => validateDevicePath('/sdcard/../data/data')).toThrow(/\.\./)
  })

  test('isUnderWritableRoot matches a root and its children, never a sibling prefix', () => {
    expect(isUnderWritableRoot('/sdcard')).toBe(true)
    expect(isUnderWritableRoot('/sdcard/DCIM')).toBe(true)
    // The trap: a plain `startsWith` would call this one writable.
    expect(isUnderWritableRoot('/sdcard-evil/x')).toBe(false)
    expect(isUnderWritableRoot('/system')).toBe(false)
  })

  test('a root may be written INTO but never itself moved or removed', () => {
    expect(validateWritableDevicePath('/sdcard/DCIM')).toBe('/sdcard/DCIM')
    expect(() => validateWritableDevicePath('/sdcard')).toThrow(/storage root/)
  })
})
