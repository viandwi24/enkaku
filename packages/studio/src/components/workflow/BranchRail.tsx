import { cn } from '@/lib/utils'
import type { EdgeLabel } from './edges'

/**
 * The left-hand rail (plan 99 §3.9, §4.11) — a continuous spine down the
 * node list, echoing `DeviceCard`'s own `.status-rail` idea (design.md:
 * "scanning a column of rails is far faster than reading status text one
 * card at a time") applied to a PIPELINE instead of a fleet: a lit dot marks
 * a row whose flow is NOT simply "the next row down" — a `goto`, an
 * `onFailure` override, or (always) a gate's two branches. The edge text
 * itself renders beside the dot, in the node card (`edgeLabelsFor`,
 * `edges.ts`); this component only draws the spine and marks which rows to
 * look at.
 */
export function BranchRail({ index, total, edges }: { index: number; total: number; edges: readonly EdgeLabel[] }) {
  const lit = edges.length > 0
  return (
    <div className="relative flex w-5 shrink-0 flex-col items-center self-stretch" aria-hidden>
      {index > 0 && <div className="absolute top-0 h-1/2 w-px bg-line" />}
      <div className={cn('z-10 mt-4 size-2.5 shrink-0 rounded-full border-2 border-bg', lit ? 'bg-accent' : 'bg-line-strong')} />
      {index < total - 1 && <div className="absolute bottom-0 h-1/2 w-px bg-line" />}
    </div>
  )
}
