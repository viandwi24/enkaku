'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { SchemaForm } from './SchemaForm'
import { RUNTIME_OVERRIDE_SCHEMA } from './runtime-override-schema'

/**
 * Plan 98 §3.9 item 2, §5 step 98.8 — the Run form's collapsed "Runtime"
 * section: an operator's per-job override, one layer above a script's own
 * declaration and below the farm ceiling (§3.8). Collapsed by default,
 * exactly like `FarmVideoFields`'s own "Advanced" disclosure (the precedent
 * this component's shape follows) — most runs need none of this, so it must
 * not compete with the params form above it for attention.
 *
 * Rendered through the SAME `SchemaForm` every other schema in this product
 * goes through, against `RUNTIME_OVERRIDE_SCHEMA` — no bespoke inputs, no
 * new control (`runtime-override-schema.test.ts` is the proof).
 *
 * `serverErrors`/`onCanSubmitChange` are intentionally NOT wired here the
 * way the params form above uses them: the core does not yet accept a
 * `runtimeOverride` field on `POST /api/jobs`/`POST /api/batches` (plan 98
 * §5 step 98.7's own status paragraph — that wiring is `packages/core/src/
 * api/jobs.ts`'s `EnqueueBody` and `packages/core/src/api/batches.ts`'s own
 * create-batch body, both outside this step's file ownership). This
 * component still composes and validates a well-formed value CLIENT-side
 * (an out-of-range number is refused by `SchemaForm`'s own client
 * validation before it ever reaches `onChange`'s caller), so what
 * `RunScriptDialog` sends is never malformed — only not yet actable on by
 * the server. See this plan's own status line for the fuller accounting of
 * that gap; it is a genuine, load-bearing one, not implied away here.
 */
export function RuntimeOverrideSection({
  value,
  onChange,
}: {
  value: unknown
  onChange(next: unknown): void
}) {
  const hasValue = typeof value === 'object' && value !== null && Object.keys(value).length > 0
  const [open, setOpen] = useState(hasValue)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted hover:text-fg">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        Runtime
        {hasValue && <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">set</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3">
        <p className="text-[11.5px] leading-relaxed text-fg-muted">
          Overrides this run's timeout and memory limit for THIS job only — never above the farm's own ceiling, which
          refuses the run outright rather than quietly shrinking your number (Plan 98).
        </p>
        <SchemaForm schema={RUNTIME_OVERRIDE_SCHEMA} value={value} onChange={onChange} />
      </CollapsibleContent>
    </Collapsible>
  )
}
