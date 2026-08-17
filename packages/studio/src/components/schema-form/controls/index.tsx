import type { FieldPlan } from '../plan'
import { ChanceControl } from './ChanceControl'
import { ChoiceControl } from './ChoiceControl'
import { JsonControl } from './JsonControl'
import { ListControl } from './ListControl'
import { NumberControl } from './NumberControl'
import { PairControl } from './PairControl'
import { TableControl } from './TableControl'
import { TextControl } from './TextControl'
import { ToggleControl } from './ToggleControl'
import { WorkspacePathControl } from './WorkspacePathControl'
import type { BaseControlProps } from './types'

/**
 * Dispatches an already-PLANNED `FieldPlan` to its control (plan 95 §4.6).
 * This is deliberately NOT "the place a control is chosen" — `plan.ts`'s
 * precedence table (§3.3) already made that decision; this is only a
 * lookup from an already-closed set of `control` values to the component
 * that draws it.
 *
 * `SchemaForm` calls this for a form's own top-level fields (`group` never
 * reaches here — K7's card/left-rule nesting is `SchemaForm`'s own walk).
 * `ListControl` and `TableControl` call it AGAIN, one level down, for their
 * items/columns (`bare: true`) — which is what closes F18 (an array of
 * objects used to stringify each cell into `[object Object]`): a cell now
 * gets the same control a top-level field of the same shape would, just
 * without its own label row. A column CAN itself be `group` (a nested
 * object property inside a table row) — that one case has nowhere sane to
 * put a card inside a single cell, so it degrades to the same labelled
 * JSON escape hatch a `z.record` or a many-branch union gets (F19, F20),
 * never a blank cell.
 */
export function renderControl(plan: FieldPlan, props: BaseControlProps) {
  switch (plan.control) {
    case 'toggle':
      return <ToggleControl {...props} />
    case 'choice':
      return <ChoiceControl {...props} plan={plan} />
    case 'number':
      // `chance` is structurally a number but gets a slider, never a
      // stepper (plan 95 §3.2) — the one place this dispatcher reads a
      // second field beyond `control` itself.
      return plan.kind === 'chance' ? <ChanceControl {...props} /> : <NumberControl {...props} plan={plan} />
    case 'pair':
      return <PairControl {...props} plan={plan} />
    case 'text':
      return <TextControl {...props} plan={plan} />
    case 'workspacePath':
      return <WorkspacePathControl {...props} plan={plan} />
    case 'list':
      return <ListControl {...props} plan={plan} />
    case 'table':
      return <TableControl {...props} plan={plan} />
    case 'json':
      return <JsonControl {...props} plan={plan} />
    case 'group':
      return <JsonControl {...props} plan={{ control: 'json', reason: 'this is a nested object, not editable inside a list or table row' }} />
  }
}
