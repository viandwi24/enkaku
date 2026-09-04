import type { ScriptListItem, ScheduleInfo } from '@enkaku/protocol'
import type { WorkflowInfo } from '@/lib/api'

/**
 * `matchesScript`/`matchesWorkflow`/`matchesSchedule`: pure predicates, one
 * per tab of `/scripts` (plan 217 §4.4), imported by the tab strip's "N
 * shown" and by the three list/grid/table components below it, so the two
 * never disagree.
 *
 * Kept out of `app/scripts/page.tsx` itself: a Next.js `page.tsx` under
 * `output: 'export'` may export only the recognised page fields (the
 * default component, `generateMetadata`, etc.) — any other named export
 * fails the build with "is not a valid Page export field" (plan 200 §2.6,
 * found executing this plan).
 */
export function matchesScript(s: ScriptListItem, q: string): boolean {
  if (!q.trim()) return true
  const needle = q.toLowerCase()
  return s.name.toLowerCase().includes(needle) || s.plugin.name.toLowerCase().includes(needle)
}

export function matchesWorkflow(w: WorkflowInfo, q: string): boolean {
  if (!q.trim()) return true
  const needle = q.toLowerCase()
  return (
    w.name.toLowerCase().includes(needle) ||
    (w.doc.title ?? '').toLowerCase().includes(needle) ||
    (w.doc.description ?? '').toLowerCase().includes(needle)
  )
}

export function matchesSchedule(s: ScheduleInfo, q: string): boolean {
  if (!q.trim()) return true
  return s.name.toLowerCase().includes(q.toLowerCase())
}
