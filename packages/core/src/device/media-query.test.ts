import { describe, expect, test } from 'bun:test'
import { shellQuote } from '@enkaku/adb'
import { findMediaIdForPath, parseContentQuery, parseContentRow, queryDeviceMedia, rowToMediaItem } from './media-query'

const VIDEO_COLUMNS = ['_id', '_display_name', '_data', 'date_added', '_size', 'mime_type', 'duration']

/** A real-shaped `content query` dump — the format is a debug print, not a documented wire format, which is the whole reason this parser is tested. */
const DUMP = [
  'Row: 0 _id=1000000033, _display_name=post-abc-1.mp4, _data=/storage/emulated/0/DCIM/Camera/post-abc-1.mp4, date_added=1725782400, _size=1048576, mime_type=video/mp4, duration=15000',
  'Row: 1 _id=1000000032, _display_name=VID_20260901.mp4, _data=/storage/emulated/0/DCIM/Camera/VID_20260901.mp4, date_added=1725700000, _size=2097152, mime_type=video/mp4, duration=30000',
].join('\n')

describe('parseContentRow', () => {
  test('splits a row into the projected columns', () => {
    const row = parseContentRow(DUMP.split('\n')[0] as string, VIDEO_COLUMNS)
    expect(row._id).toBe('1000000033')
    expect(row._display_name).toBe('post-abc-1.mp4')
    expect(row._data).toBe('/storage/emulated/0/DCIM/Camera/post-abc-1.mp4')
    expect(row.duration).toBe('15000')
  })

  /**
   * The bug this parser exists to avoid. `content` neither quotes nor escapes
   * values, so a filename holding the separator would make a naive
   * `split(', ')` invent columns and corrupt its neighbours.
   */
  test('a value containing the ", " separator stays in one column', () => {
    const line =
      'Row: 0 _id=42, _display_name=clip, final.mp4, _data=/sdcard/Movies/clip, final.mp4, date_added=100, _size=5, mime_type=video/mp4, duration=1'
    const row = parseContentRow(line, VIDEO_COLUMNS)
    expect(row._display_name).toBe('clip, final.mp4')
    expect(row._data).toBe('/sdcard/Movies/clip, final.mp4')
    expect(row.date_added).toBe('100')
  })

  test('a SQL NULL reads back as null, and a column the device omitted stays null', () => {
    const row = parseContentRow('Row: 0 _id=7, _display_name=NULL, date_added=100', VIDEO_COLUMNS)
    expect(row._display_name).toBeNull()
    expect(row._size).toBeNull()
  })
})

describe('parseContentQuery', () => {
  test('reads every Row: line', () => {
    expect(parseContentQuery(DUMP, VIDEO_COLUMNS)).toHaveLength(2)
  })

  test('"No result found." is an empty list, never a parse failure', () => {
    expect(parseContentQuery('No result found.', VIDEO_COLUMNS)).toEqual([])
  })

  test('non-row noise on stdout is ignored', () => {
    expect(parseContentQuery(`WARNING: linker: something\n${DUMP}`, VIDEO_COLUMNS)).toHaveLength(2)
  })
})

describe('rowToMediaItem', () => {
  test('maps a video row, keeping MediaStore units (seconds added, ms duration)', () => {
    const item = rowToMediaItem(parseContentQuery(DUMP, VIDEO_COLUMNS)[0] as Record<string, string | null>, 'video')
    expect(item).toEqual({
      id: '1000000033',
      kind: 'video',
      displayName: 'post-abc-1.mp4',
      path: '/storage/emulated/0/DCIM/Camera/post-abc-1.mp4',
      addedAt: 1_725_782_400,
      sizeBytes: 1_048_576,
      durationMs: 15_000,
      mimeType: 'video/mp4',
    })
  })

  test('an image never carries a duration, even if the device reported one', () => {
    const row = parseContentRow('Row: 0 _id=9, _display_name=a.jpg, duration=500', VIDEO_COLUMNS)
    expect(rowToMediaItem(row, 'image')?.durationMs).toBeNull()
  })

  test('a row with no _id is dropped rather than surfaced without identity', () => {
    expect(rowToMediaItem({ _id: null }, 'video')).toBeNull()
  })

  test('a missing _display_name falls back to the filename off _data, not to a guess', () => {
    const row = parseContentRow('Row: 0 _id=9, _data=/sdcard/Movies/x.mp4', VIDEO_COLUMNS)
    expect(rowToMediaItem(row, 'video')?.displayName).toBe('x.mp4')
  })
})

describe('queryDeviceMedia', () => {
  const backendOf = (impl: (cmd: string) => { exitCode: number | null; stdout: string } | null) => {
    const seen: string[] = []
    return {
      seen,
      backend: {
        exec: async (cmd: string) => {
          seen.push(cmd)
          return impl(cmd)
        },
      },
    }
  }

  test('returns items newest-first and reports truncation from the device row count', async () => {
    const { backend } = backendOf(() => ({ exitCode: 0, stdout: DUMP }))
    const res = await queryDeviceMedia(backend, { kind: 'video', limit: 1 })
    expect(res.items).toHaveLength(1)
    expect(res.items[0]?.id).toBe('1000000033')
    // Two rows came back for a limit of one — the device has more than the window shows.
    expect(res.truncated).toBe(true)
  })

  test('falls back to a bare sort when the device rejects the LIMIT clause', async () => {
    const { seen, backend } = backendOf((cmd) => (cmd.includes('LIMIT') ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: DUMP }))
    const res = await queryDeviceMedia(backend, { kind: 'video', limit: 10 })
    expect(seen).toHaveLength(2)
    expect(res.items).toHaveLength(2)
    expect(res.truncated).toBe(false)
  })

  test('a shell failure on both attempts is an empty list, never a throw', async () => {
    const { backend } = backendOf(() => null)
    expect(await queryDeviceMedia(backend, { kind: 'video', limit: 10 })).toEqual({ items: [], truncated: false })
  })

  test('underPath keeps only rows under it, and drops rows whose path is unknown', async () => {
    const stdout = [DUMP, 'Row: 2 _id=5, _display_name=other.mp4, _data=/sdcard/Download/other.mp4, date_added=1, _size=1, mime_type=video/mp4, duration=1'].join('\n')
    const { backend } = backendOf(() => ({ exitCode: 0, stdout }))
    const res = await queryDeviceMedia(backend, { kind: 'video', limit: 50, underPath: '/storage/emulated/0/DCIM/Camera' })
    expect(res.items.map((i) => i.id)).toEqual(['1000000033', '1000000032'])
  })

  test('the image volume is queried without a duration column', async () => {
    const { seen, backend } = backendOf(() => ({ exitCode: 0, stdout: 'No result found.' }))
    await queryDeviceMedia(backend, { kind: 'image', limit: 5 })
    expect(seen[0]).toContain('content://media/external/images/media')
    expect(seen[0]).not.toContain('duration')
  })
})

describe('findMediaIdForPath', () => {
  const backendOf = (stdout: string, exitCode = 0) => {
    const seen: string[] = []
    return { seen, backend: { exec: async (cmd: string) => (seen.push(cmd), { exitCode, stdout }) } }
  }

  test('returns the id for an exact path', async () => {
    const { backend } = backendOf('Row: 0 _id=1000000033, _data=/sdcard/DCIM/Camera/a.mp4')
    expect(await findMediaIdForPath(backend, 'video', '/sdcard/DCIM/Camera/a.mp4')).toBe('1000000033')
  })

  test('two rows for one path is null — no single id is the honest answer', async () => {
    const { backend } = backendOf('Row: 0 _id=1, _data=/x\nRow: 1 _id=2, _data=/x')
    expect(await findMediaIdForPath(backend, 'video', '/x')).toBeNull()
  })

  test('no row is null, and a failing shell is null — never a throw', async () => {
    expect(await findMediaIdForPath(backendOf('No result found.').backend, 'video', '/x')).toBeNull()
    expect(await findMediaIdForPath(backendOf('', 1).backend, 'video', '/x')).toBeNull()
  })

  /**
   * The SQL literal is escaped INSIDE the shell quoting — two escapes in two
   * languages. Collapsing them is how an injection gets in, so the quote in a
   * filename must survive as a doubled SQL quote.
   */
  test('a single quote in the path is doubled for SQL, then shell-quoted on top', async () => {
    const { seen, backend } = backendOf('No result found.')
    await findMediaIdForPath(backend, 'video', "/sdcard/Movies/it's.mp4")
    // Built from the same primitive rather than hand-written: the point is that
    // the SQL doubling happens FIRST and the shell escaping wraps the result,
    // which a literal string in this file would only obscure.
    expect(seen[0]).toContain(shellQuote(`_data='/sdcard/Movies/it''s.mp4'`))
  })
})
