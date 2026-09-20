import { artifactFamilyOf, type ArtifactFamily } from '@enkaku/protocol'
import { fileExtOf, type FileFilter, type FileItem } from './files-api'

/**
 * The Files screen's view model: which files are shown, in what order, and
 * which page of them (owner, 2026-09-20 — "kasih mode show, order, dll biar
 * kaya file manager/finder beneran").
 *
 * Pure functions over an array, deliberately kept out of the page component.
 * The screen has three lenses (tiles, a list, a details table) and all three
 * show the SAME rows in the SAME order — a grid that sorts differently from
 * the table above it is two libraries wearing one name. One module they all
 * call is the mechanical way that stays true.
 *
 * `@enkaku/ui` has zero tests by decision (plan 200 §8.3) and so does Studio,
 * so this file is written to be read: every comparator is total, every null
 * has a stated place, and nothing here throws.
 */

/** Tiles, compact rows, or the sortable details table. Stored in `localStorage` (`prefs.ts`'s `filesView`). */
export type FilesView = 'grid' | 'list' | 'details'

/** What the library is ordered by. `kind` groups images with images, the way a file manager's Kind column does. */
export type FilesSort = 'name' | 'added' | 'size' | 'duration' | 'kind'

export type SortDir = 'asc' | 'desc'

/** The page sizes the toolbar offers. A union so a stored value is always one the menu can show. */
export const PAGE_SIZES = [24, 48, 96, 192] as const
export type PageSize = (typeof PAGE_SIZES)[number]

/**
 * What to call a file. The operator's label when there is one, the id when
 * there is not — the same fallback every other surface uses, so a file that
 * was never named reads the same here as in an artifact picker.
 */
export function fileName(item: FileItem): string {
  return item.label ?? item.id
}

/**
 * The order a file manager sorts names in: `clip2` before `clip10`, and case
 * ignored, which is what `numeric` + `sensitivity: 'base'` buy. A plain
 * `<`/`>` on strings puts `clip10` first and reads as a bug every single time
 * somebody numbers forty uploads.
 *
 * Built once. `Intl.Collator` is expensive to construct and this runs inside a
 * sort over the whole library.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * A number that may not be known, ordered so that "not known" is always LAST —
 * ascending or descending alike.
 *
 * That asymmetry is deliberate. A file whose duration the probe could not read
 * has no duration, not a duration of zero; letting it sort as zero would park
 * every unreadable file at the top of "shortest first" and make the one real
 * question the sort was asked ("which clip is shortest?") unanswerable. Finder
 * does the same with an empty column.
 */
function compareMaybeNumber(a: number | null, b: number | null, dir: SortDir): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return dir === 'asc' ? a - b : b - a
}

/** Images, then videos, then everything else — the order the filter tabs are in, so the two agree. */
const FAMILY_RANK: Record<ArtifactFamily, number> = { image: 0, video: 1, other: 2 }

/**
 * One comparator for every lens. Always total and always stable: every branch
 * falls through to the id, so two files with the same name, the same size and
 * the same second do not swap places between renders and make a grid flicker.
 */
export function compareFiles(sort: FilesSort, dir: SortDir): (a: FileItem, b: FileItem) => number {
  return (a, b) => {
    const signed = dir === 'asc' ? 1 : -1
    let result = 0
    switch (sort) {
      case 'name':
        result = collator.compare(fileName(a), fileName(b)) * signed
        break
      case 'added':
        result = (a.createdAt - b.createdAt) * signed
        break
      case 'size':
        result = compareMaybeNumber(a.sizeBytes, b.sizeBytes, dir)
        break
      case 'duration':
        result = compareMaybeNumber(a.durationMs, b.durationMs, dir)
        break
      case 'kind': {
        const byFamily = (FAMILY_RANK[artifactFamilyOf(a)] - FAMILY_RANK[artifactFamilyOf(b)]) * signed
        if (byFamily !== 0) {
          result = byFamily
          break
        }
        // Same family: the extension separates a PNG from a JPG, and a file
        // with no readable extension goes last within its family for the same
        // reason an unknown duration does.
        const extA = fileExtOf(a)
        const extB = fileExtOf(b)
        if (extA !== extB) {
          if (extA === null) return 1
          if (extB === null) return -1
          result = collator.compare(extA, extB) * signed
        }
        // A tie on kind reads best alphabetically — grouping by type is only
        // useful if the group itself is ordered.
        if (result === 0) result = collator.compare(fileName(a), fileName(b))
        break
      }
    }
    if (result !== 0) return result
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}

/**
 * The family tab and the search box, in that order. The query matches the
 * NAME and the extension only — not the id, which is a ULID no operator has
 * ever typed, and not the path, which would match the storage layout rather
 * than anything on screen.
 */
export function filterFiles(items: readonly FileItem[], filter: FileFilter, query: string): FileItem[] {
  const q = query.trim().toLowerCase()
  return items.filter((item) => {
    if (filter !== 'all' && artifactFamilyOf(item) !== filter) return false
    if (q.length === 0) return true
    if (fileName(item).toLowerCase().includes(q)) return true
    return (fileExtOf(item)?.toLowerCase() ?? '').includes(q)
  })
}

/** How many pages `total` rows make. Always at least 1, so an empty library still has a page 1 to be on rather than page 1 of 0. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/**
 * The 1-based page of `items` to render, clamped into range.
 *
 * Clamping rather than trusting the caller is what makes deleting the last
 * file on the last page safe: the list shortens under a page number that no
 * longer exists, and the screen shows the new last page instead of an empty
 * one with no way back.
 */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const pages = pageCount(items.length, pageSize)
  const clamped = Math.min(Math.max(1, Math.trunc(page)), pages)
  const start = (clamped - 1) * pageSize
  return items.slice(start, start + pageSize)
}

/**
 * The page numbers a pager should draw, with `null` standing for a gap.
 *
 * Every page is a button up to nine of them; past that it is first, last, the
 * current page and its neighbours, with the gaps elided. A farm with 2 000
 * uploads at 24 a page has 84 pages, and a row of 84 buttons is not a control,
 * it is a wall.
 */
export function pagerItems(current: number, pages: number): (number | null)[] {
  if (pages <= 9) return Array.from({ length: pages }, (_, i) => i + 1)
  const window = new Set<number>([1, pages, current])
  for (const offset of [-2, -1, 1, 2]) {
    const page = current + offset
    if (page > 1 && page < pages) window.add(page)
  }
  // The first and last page always have a neighbour, so the pager does not
  // jump from `1` straight to a gap when the current page is near an end.
  if (current <= 3) for (const page of [2, 3, 4]) if (page < pages) window.add(page)
  if (current >= pages - 2) for (const page of [pages - 1, pages - 2, pages - 3]) if (page > 1) window.add(page)

  const sorted = [...window].sort((a, b) => a - b)
  const out: (number | null)[] = []
  let previous = 0
  for (const page of sorted) {
    if (previous !== 0 && page - previous > 1) out.push(null)
    out.push(page)
    previous = page
  }
  return out
}

/** The sort menu's labels, and the details table's column headers, from one list so the two never disagree. */
export const SORT_LABELS: Record<FilesSort, string> = {
  name: 'Name',
  added: 'Added',
  size: 'Size',
  duration: 'Duration',
  kind: 'Kind',
}

/**
 * Which direction an operator means by "ascending" for each column, in words.
 *
 * A file manager says "A → Z" for a name and "Newest first" for a date, never
 * "ascending" for either — and getting that backwards on a date column is the
 * single most common way a sort menu lies about what it is about to do.
 */
export const SORT_DIRECTION_LABELS: Record<FilesSort, Record<SortDir, string>> = {
  name: { asc: 'A → Z', desc: 'Z → A' },
  added: { asc: 'Oldest first', desc: 'Newest first' },
  size: { asc: 'Smallest first', desc: 'Largest first' },
  duration: { asc: 'Shortest first', desc: 'Longest first' },
  kind: { asc: 'Images first', desc: 'Other first' },
}

/**
 * The direction a column starts in when it is picked fresh.
 *
 * Nobody asks for the oldest file, or the smallest, or the shortest — a date,
 * a size and a duration all open on the big end, and only a name opens at A.
 * Clicking the same column again flips it, which is the other half of the rule.
 */
export function defaultDirectionFor(sort: FilesSort): SortDir {
  return sort === 'name' || sort === 'kind' ? 'asc' : 'desc'
}

/**
 * What a preview can actually DO with a file, which is a finer question than
 * the family the filter tabs use.
 *
 * `artifactFamilyOf` (in `@enkaku/protocol`) answers image / video / other,
 * because those are the three the Clean up dialog's filter has to select
 * exactly. A preview needs one more distinction the filter does not: an mp3 is
 * `other` to the filter and `audio` here, and the difference is a control bar
 * with no picture instead of a large black rectangle that reads as a video
 * that failed to load.
 *
 * `none` is honest rather than apologetic: an apk or a log has no preview, and
 * the dialog says so with the file's own facts instead of an empty frame.
 */
export type PreviewKind = 'image' | 'video' | 'audio' | 'none'

export function previewKindOf(item: FileItem): PreviewKind {
  const family = artifactFamilyOf(item)
  if (family === 'image') return 'image'
  if (family === 'video') return 'video'
  if (item.mimeType?.startsWith('audio/')) return 'audio'
  return 'none'
}
