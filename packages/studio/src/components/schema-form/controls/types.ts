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
  /**
   * Whether the schema lists this field in `required`. Only a control that
   * can be EMPTIED needs it — `WorkspacePathControl` hides its "Clear" button
   * on a required field, because offering to clear a value the form will
   * immediately refuse is a dead end, not a choice. Every other control
   * ignores it: a toggle, a number box and a text box all have a natural
   * empty state the form already validates.
   */
  required?: boolean
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
