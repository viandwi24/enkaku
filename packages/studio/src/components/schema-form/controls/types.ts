import type { FieldPlan } from '../plan'

/** Every leaf `FieldPlan` — everything a control (plan 95 §4.6) can be asked
 *  to render. `group` is excluded: nesting is `SchemaForm`'s own job (K7's
 *  card/left-rule rule), never a control's. */
export type LeafPlan = Exclude<FieldPlan, { control: 'group' }>

/**
 * The props every control shares (plan 95 §5 step 95.3). `SchemaForm` fills
 * these in for a form's own fields; `ListControl`/`TableControl` fill them
 * in again, one level down, for their items/columns — the same shape either
 * way, which is what lets a single `renderControl` (`./index.tsx`) serve
 * both call sites.
 */
export interface BaseControlProps {
  id: string
  /** Dot/bracket-notation path from the form's root, e.g. `retry.backoffMs`
   *  or `keywords[2]` — what `onChange` reports and `errors` is keyed by. */
  path: string
  label: string
  help?: string
  error?: string
  value: unknown
  onChange(path: string, value: unknown): void
  /**
   * Set by `ListControl`/`TableControl` for an item/column control (plan 95
   * §4.6): render the bare widget only — no label row, no readout, no help
   * text. The field that CONTAINS the list already carries all three (its
   * own label, its own `N items` readout, its own help) one level up, so
   * repeating them per row would be noise, not the reference UI's second
   * property. `label` is still required in bare mode: it becomes the
   * widget's `aria-label`, so a screen reader still gets "Interest keywords
   * 2", never a bare, anonymous input.
   */
  bare?: boolean
}
