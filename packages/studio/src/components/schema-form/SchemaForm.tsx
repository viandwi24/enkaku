'use client'

import { useEffect, useMemo, useState } from 'react'
import { validateAgainstSchema } from '@enkaku/protocol'
import type { ShowWhen } from '@enkaku/protocol'
import { Button, cn } from '@enkaku/ui'
import { renderControl } from './controls/index'
import type { PlannedField } from './plan'
import { planForm, sectionFields } from './plan'
import { applyDefaults, getAtPath, setAtPath } from './resolve'
import type { JsonSchemaNode } from './types'

/**
 * `validateAgainstSchema` (`./validate.ts`) is gone (plan 95 §3.7, §4.3, §5
 * step 95.6, fixes F10, F13, F15) — this is the SAME `validateAgainstSchema` the
 * core runs at `POST /api/jobs`/`/api/batches`/`/api/schedules`, so the form
 * and the server can no longer disagree about what is acceptable. `issues`
 * are `{ path, message }` pairs; this adapts them to the
 * `Record<path, message>` shape the controls' `error` prop already uses.
 */
function issuesToErrorMap(result: ReturnType<typeof validateAgainstSchema>): Record<string, string> {
  if (result.ok) return {}
  const map: Record<string, string> = {}
  for (const issue of result.issues) map[issue.path] = issue.message
  return map
}

/**
 * `showWhen` evaluation (plan 95 §3.6, §5 step 95.9) — resolved against the
 * field's IMMEDIATE parent's current value. `showWhen.field` names a sibling
 * within the SAME object the field itself is declared in, at whatever depth
 * that object sits: a controlling field nested inside a `group` resolves
 * correctly with no special case, because `FieldList` (below) already
 * recurses with THAT group's own scoped value for its children — the
 * sibling scope this function is handed IS the value that recursion passes.
 *
 * `siblingKeys` is the set of field names PLANNED at this level (the
 * schema's own declared siblings), never the runtime value's own keys.
 * Checking against it is what makes an unresolvable reference default to
 * SHOWN rather than hidden: "a `field` that does not exist among the
 * siblings is a publish-time error [`checkDeclaredSchema`, `limits.ts`'s
 * sibling check]; at render, an unresolvable condition means the field is
 * shown (never hidden by a mistake)" (§3.6) — for a schema stored before
 * that publish-time check existed, or one that reached the database some
 * other way. A sibling that DOES exist but currently holds `undefined` is a
 * normal non-match, not an unresolvable reference, and is correctly treated
 * as "hidden" like any other mismatch.
 *
 * Chained `showWhen` (B's condition names A, C's condition names B) falls
 * out of this for free and is deliberately NOT special-cased: each field's
 * visibility is a pure function of the CURRENT value tree, evaluated
 * independently, never of whether some other field happens to be rendered
 * right now. If B is hidden, nothing can edit it, so it keeps whatever value
 * it was seeded or last set with, and C's `showWhen` reads that value
 * exactly as it would if B were visible — the chain composes without this
 * file ever needing to know it is one. What is NOT supported, on purpose
 * (§2, §3.6 — "one sibling field, one comparison, no boolean algebra, no
 * paths"): a `field` that is not a direct sibling (an ancestor, a dotted
 * path, a field in a different branch of the schema), and more than one
 * condition on a single field.
 */
function matchesShowWhen(showWhen: ShowWhen, siblingKeys: ReadonlySet<string>, scopeValue: unknown): boolean {
  if (!siblingKeys.has(showWhen.field)) return true
  const actual = getAtPath(scopeValue, showWhen.field)
  return 'is' in showWhen ? actual === showWhen.is : showWhen.in.includes(actual as string | number | boolean)
}

function isFieldVisible(field: PlannedField, siblingKeys: ReadonlySet<string>, scopeValue: unknown): boolean {
  return !field.showWhen || matchesShowWhen(field.showWhen, siblingKeys, scopeValue)
}

/** Where a hidden field's error should surface instead, and the label to
 *  name it with — `isFieldVisible` above has already decided the error
 *  cannot surface on the field itself. */
interface HiddenRedirect {
  controllingPath: string
  label: string
}

/**
 * Walks the SAME tree `FieldList`/`Field` render — full paths, the same
 * per-level scoping — recording, for every field `showWhen` currently
 * hides, where ITS error should be attributed instead (§3.6's corollary:
 * "a required-and-hidden field with no default reports its error on the
 * controlling field, because the operator cannot see or fix the field that
 * is actually wrong"). Deliberately never descends into an already-hidden
 * field's own `children`: nothing under an invisible field is rendered
 * either, so any error anywhere in that whole subtree is the SAME
 * operator-facing fact — "the controlling field needs a different answer" —
 * and is attributed to the one controlling field the operator can actually
 * see and act on, not to whichever descendant three levels down happened to
 * fail.
 */
function collectHiddenRedirects(fields: PlannedField[], parentPath: string, scopeValue: unknown, out: Map<string, HiddenRedirect>): void {
  const siblingKeys = new Set(fields.map((f) => f.path))
  for (const field of fields) {
    const path = parentPath ? `${parentPath}.${field.path}` : field.path
    if (field.showWhen && !matchesShowWhen(field.showWhen, siblingKeys, scopeValue)) {
      const controllingPath = parentPath ? `${parentPath}.${field.showWhen.field}` : field.showWhen.field
      out.set(path, { controllingPath, label: field.label })
      continue
    }
    if (field.plan.control === 'group') {
      collectHiddenRedirects(field.plan.children, path, getAtPath(scopeValue, field.path), out)
    }
  }
}

/**
 * Re-keys `errors` so a message that landed on a HIDDEN field's path — from
 * either source, client or server — surfaces on its controlling field
 * instead. Applied to the fully-merged map, not just the client half: the
 * server has no notion of "hidden" either (`validateAgainstSchema` never reads
 * `showWhen` — see this file's comment above `issuesToErrorMap`, and §3.7:
 * the browser and the core run the exact SAME validator against the exact
 * same value, which is what makes them agree at all), so a `serverErrors`
 * entry needs exactly the same redirect a client one does.
 */
function redirectHiddenErrors(fields: PlannedField[], value: unknown, errors: Record<string, string>): Record<string, string> {
  const redirects = new Map<string, HiddenRedirect>()
  collectHiddenRedirects(fields, '', value, redirects)
  if (redirects.size === 0) return errors

  const result: Record<string, string> = {}
  for (const [path, message] of Object.entries(errors)) {
    let redirect = redirects.get(path)
    if (!redirect) {
      for (const [hiddenPath, candidate] of redirects) {
        if (path.startsWith(`${hiddenPath}.`)) {
          redirect = candidate
          break
        }
      }
    }
    const target = redirect ? redirect.controllingPath : path
    const text = redirect ? `${redirect.label}: ${message}` : message
    result[target] = result[target] ? `${result[target]}; ${text}` : text
  }
  return result
}

/**
 * Form renderer driven by JSON Schema (spec §8, §19): every engine, tool,
 * and script gets a settings panel with no hardcoded UI. `planForm()`
 * (plan 95 §3.3, §4.5) is the ONLY place a control is chosen — this
 * component just walks its output, seeds defaults, and wires validation.
 *
 * The schema is generated from Zod in the core, so there is a single
 * source of truth — and values outside the list are rejected by the
 * server, not merely hidden in the UI.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  serverErrors,
  onSubmit,
  onReset,
  submitLabel = 'Save changes',
  busy,
  dirty,
  onCanSubmitChange,
}: {
  schema: JsonSchemaNode
  value: unknown
  onChange(next: unknown): void
  serverErrors?: Record<string, string>
  onSubmit?: () => void
  onReset?: () => void
  submitLabel?: string
  busy?: boolean
  dirty?: boolean
  /**
   * Fires whenever validity changes (plan 95 §3.7, §4.3, fixes F14) — the
   * form's OWN submit button already refuses to fire while invalid
   * (`hasErrors` below), but `RunScriptDialog`/`ScheduleEditorDialog` render
   * their Run/Save button OUTSIDE this component, and used to never consult
   * it: a form showing red fields could still be submitted. Called once on
   * mount and again on every change, independent of `touched` — a caller
   * should be able to disable its button before the operator has touched
   * anything.
   */
  onCanSubmitChange?: (canSubmit: boolean) => void
}) {
  const [touched, setTouched] = useState(false)

  // Memoised on the SCHEMA's identity — computed once per schema, never per
  // keystroke (plan 95 §5 step 95.3's own performance requirement: a
  // resolver that reruns on every character is the defect this design would
  // otherwise introduce). `value` is deliberately NOT a dependency here.
  const fields = useMemo(() => planForm(schema), [schema])

  useEffect(() => {
    const filled = applyDefaults(schema, value, schema)
    if (JSON.stringify(filled) !== JSON.stringify(value)) onChange(filled)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema])

  const clientErrors = useMemo(() => issuesToErrorMap(validateAgainstSchema(schema, value)), [schema, value])
  // Redirected AFTER merging client and server errors (plan 95 §3.6, §5 step
  // 95.9): a hidden field's error — from either source — surfaces on its
  // controlling field instead, because the operator cannot see or fix the
  // field it is actually attached to. `hasErrors` below is computed from
  // the PRE-redirect `clientErrors`, on purpose: the value is genuinely
  // invalid either way, and submission must stay blocked regardless of
  // where the message is displayed.
  const errors = redirectHiddenErrors(fields, value, { ...(touched ? clientErrors : {}), ...(serverErrors ?? {}) })
  const hasErrors = Object.keys(clientErrors).length > 0

  useEffect(() => {
    onCanSubmitChange?.(!hasErrors)
    // Only re-fire when validity itself flips — `onCanSubmitChange` is
    // typically an inline setState from the caller and re-running this every
    // render would otherwise add nothing but noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasErrors])

  const handleChange = (path: string, next: unknown) => onChange(setAtPath(value, path, next))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!hasErrors) onSubmit?.()
      }}
    >
      <div className="space-y-5">
        <FieldList fields={fields} parentPath="" value={value} errors={errors} onChange={handleChange} />
      </div>

      {onSubmit && (
        // Solid background, not translucent: the save bar often covers the
        // last field, and text bleeding through makes both unreadable.
        <div className="sticky bottom-0 z-10 mt-5 flex flex-wrap items-center gap-2 border-t bg-bg py-3">
          <Button type="submit" disabled={busy || dirty === false}>
            {busy ? 'Saving…' : submitLabel}
          </Button>
          {onReset && (
            <Button type="button" variant="ghost" onClick={onReset} disabled={busy || dirty === false}>
              Discard changes
            </Button>
          )}
          {touched && hasErrors && <span className="text-[12px] text-led-danger">Fix the fields marked in red first.</span>}
          {dirty === false && <span className="text-[12px] text-fg-subtle">No changes</span>}
        </div>
      )}
    </form>
  )
}

/**
 * One planned field, recursively. `path` is the FULL accumulated dotted
 * path from the form's root — `plan.ts`'s own `PlannedField.path` is only
 * the field's key within its immediate parent (plan.ts's doc comment), so
 * this is where the accumulation happens, exactly as the pre-95.3 renderer
 * did it.
 *
 * K7's nesting rule, preserved verbatim: a group whose OWN accumulated path
 * has no dot is a direct child of the schema's root and becomes a card;
 * anything nested deeper only gets a left rule — "cards inside cards add
 * borders without adding clarity."
 */
function Field({
  field,
  path,
  value,
  errors,
  onChange,
}: {
  field: PlannedField
  path: string
  value: unknown
  errors: Record<string, string>
  onChange(path: string, value: unknown): void
}) {
  const id = `f-${path.replace(/\./g, '-') || 'root'}`

  if (field.plan.control === 'group') {
    const nested = path.includes('.')
    const body = (
      <div className={cn('space-y-4', nested ? 'mt-2.5' : 'mt-4')}>
        <FieldList fields={field.plan.children} parentPath={path} value={value} errors={errors} onChange={onChange} />
      </div>
    )

    if (nested) {
      return (
        <section className="border-l-2 pl-3.5">
          <h4 className="rack-label">{field.label}</h4>
          {field.help && <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">{field.help}</p>}
          {body}
        </section>
      )
    }

    return (
      <section className="rounded-lg border bg-surface p-5">
        <h3 className="text-[14px] font-semibold tracking-tight">{field.label}</h3>
        {field.help && <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{field.help}</p>}
        {body}
      </section>
    )
  }

  return renderControl(field.plan, {
    id,
    path,
    label: field.label,
    help: field.help,
    error: errors[path],
    value,
    required: field.required,
    onChange,
  })
}

/**
 * A flat, planned field list, rendered as SECTIONS — maximal consecutive
 * runs sharing a `group` (plan 95 §3.5, §5 step 95.4's `sectionFields`).
 * Called at the form's own root AND from every nested 'group' control's own
 * `children` above, so annotating ANY object's fields with `x-enkaku.group`
 * — not only the schema's top level — sections them: the multiplier (plan 95
 * F33) applies uniformly, at whatever depth an author declared the group.
 *
 * A run with no heading (every field in it declares no `group`) renders its
 * fields directly, with no wrapper — no extra DOM node, no changed spacing —
 * which is what keeps a schema that names no group byte-identical to the
 * pre-95.4 markup (the same purely-additive property `SectionNav`'s own
 * grouped headings already keep).
 *
 * `showWhen` filtering (plan 95 §3.6, §5 step 95.9) happens HERE, before
 * `sectionFields` ever sees the list — not inside `plan.ts`'s
 * `sectionFields`, which stays value-independent and pure (it only regroups
 * whatever list it is handed; `planForm`'s own doc comment is explicit that
 * it "does not take a value, so it has none to seed"). The values of hidden
 * fields are untouched — they are simply not among the elements handed to
 * `sectionFields`/rendered below, which is what "not rendered, still
 * submitted" (§3.6) means in practice: nothing here ever removes a key from
 * `value`.
 *
 * The deliberate consequence: a section every one of whose fields `showWhen`
 * currently hides never appears at all — no heading over an empty body. The
 * alternative (keep the heading, hide only the fields under it) trades an
 * "appearing and disappearing section" for a WORSE failure: an inert heading
 * naming zero visible fields, which is the empty-card defect (F19) this
 * plan's resolver exists to close, reintroduced one level up. A section that
 * appears only when its fields do is not a regression this design regrets —
 * it is the SAME "four controls in simple mode, seven in advanced" property
 * (§5 step 95.9's verifiable result) applied to whichever of those seven
 * happen to share a `group`: the count changing IS the point, and a heading
 * over nothing is never legible in the interim.
 */
function FieldList({
  fields,
  parentPath,
  value,
  errors,
  onChange,
}: {
  fields: PlannedField[]
  parentPath: string
  value: unknown
  errors: Record<string, string>
  onChange(path: string, value: unknown): void
}) {
  const siblingKeys = new Set(fields.map((f) => f.path))
  const visibleFields = fields.filter((field) => isFieldVisible(field, siblingKeys, value))
  return (
    <>
      {sectionFields(visibleFields).map((section, i) => {
        const rows = section.fields.map((field) => {
          const path = parentPath ? `${parentPath}.${field.path}` : field.path
          return <Field key={field.path} field={field} path={path} value={getAtPath(value, field.path)} errors={errors} onChange={onChange} />
        })
        if (!section.heading) return rows
        return (
          <div key={`${section.heading}-${i}`} className="space-y-4">
            <p className="rack-label">{section.heading}</p>
            {rows}
          </div>
        )
      })}
    </>
  )
}
