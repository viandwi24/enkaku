import { type ReactNode, useMemo } from 'react'
import { formatFieldValue } from '@enkaku/ui'
import type { FieldPlan, PlannedField } from '../schema-form/plan'
import type { JsonSchemaNode } from '../schema-form/types'
import { planResult, type PlannedResultField } from './plan-result'

/**
 * Plan 97 §3.6, §4.8 — a result's own read-only twin of `SchemaForm`. It
 * never edits, never validates, and consumes exactly what `planResult`
 * plans: a `FieldPlan` (from `planField`, unchanged — K3) paired with the
 * value it actually holds, formatted through `formatFieldValue` (K4) so a
 * result reading `4 min 12 s` and a form label reading `4 min 12 s` come
 * from the same line of code. `formatFieldValue` is `@enkaku/protocol`'s own
 * `formatValue` plus the one browser-only case — `kind: 'timestamp'` reads
 * as `relativeTime`, because a result on screen is being read NOW (plan 108
 * step 108.7 item A).
 *
 * `planResult`'s three rules (R1/R2/R3) apply only at the TOP level (its own
 * module doc explains why); everything BELOW the top level — a nested
 * `group`'s own children, a `table`'s columns, a `list`'s item — is
 * `planField`'s unchanged, value-FREE static plan. `renderField` below is
 * what pairs that static plan back up with the matching slice of the
 * ACTUAL value at render time, recursively, so a nested object still shows
 * real numbers rather than degrading to raw JSON the moment it is not a
 * top-level field. This is `ResultView`'s own job, not a second resolver:
 * it makes no structural decision `planField` has not already made, it only
 * decides which value belongs next to which already-planned label.
 *
 * A `json`-terminal field (row 16 of `planField`'s own table, R1's
 * unresolved union, R3's unknown key) renders its raw value — Studio never
 * uses `dangerouslySetInnerHTML` (plan 95 F23), so this is escaped text, not
 * markup, and it is the same fallback the page has always shown for the
 * whole result. `humanize` — the last-resort label wherever neither the
 * schema's own `title` nor a declared field name is available — is applied
 * by `planResult` itself (R2's record keys, R3's unknown keys); every
 * nested label below the top level already comes from `planField`'s own
 * `humanize` fallback (`plan.ts`'s `labelFor`), so this file never needs it
 * directly.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonText(value: unknown): string {
  if (value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** `FieldPlan`'s scalar controls, rendered as text. `group`/`table`/`list`/
 *  `json` are each their own block below — they are not "a piece of text". */
function renderScalar(plan: FieldPlan, value: unknown): string {
  switch (plan.control) {
    case 'toggle':
      return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : '—'
    case 'choice': {
      if (value === undefined || value === null) return '—'
      const match = plan.options.find((option) => option.value === String(value))
      return match ? match.label : String(value)
    }
    case 'number':
      return formatFieldValue(plan.kind, plan.unit, value)
    case 'pair':
      return formatFieldValue(plan.item.kind, plan.item.unit, value)
    case 'text':
    // A workspace path IS its own best rendering — `/captions.txt`, not
    // `"/captions.txt"` with the quotes a JSON fallback would add.
    case 'workspacePath':
      return typeof value === 'string' && value.length > 0 ? value : '—'
    default:
      return jsonText(value)
  }
}

/** One `table`/`list` cell/item: a bare leaf uses `renderScalar` directly; a
 *  nested object/array falls back to raw JSON — a table cell has no room
 *  for a further nested block, and `planField`'s own `table`/`list` rows
 *  (10/11) never plan an object ITEMS array as anything deeper than this
 *  (an object-items array becomes a `table` one level up, not two). */
function renderCell(plan: FieldPlan, value: unknown): string {
  return plan.control === 'group' || plan.control === 'table' || plan.control === 'list' ? jsonText(value) : renderScalar(plan, value)
}

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line/60 py-1.5 last:border-b-0">
      <span className="text-[12px] text-fg-muted" title={help}>
        {label}
      </span>
      <span className="text-[13px]">{children}</span>
    </div>
  )
}

function Block({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="border-t pt-2 first:border-t-0 first:pt-0">
      <p className="rack-label mb-1.5">{heading}</p>
      {children}
    </div>
  )
}

function GroupNode({ heading, fields, value }: { heading: string; fields: PlannedField[]; value: unknown }) {
  const scope = isPlainObject(value) ? value : {}
  return (
    <Block heading={heading}>
      {fields.length === 0 ? (
        <p className="text-[12px] text-fg-subtle">no entries</p>
      ) : (
        <div className="pl-2">
          {fields.map((field) => (
            <div key={field.path}>{renderField(field.plan, scope[field.path], field.label, field.help)}</div>
          ))}
        </div>
      )}
    </Block>
  )
}

function TableNode({ heading, columns, value }: { heading: string; columns: { key: string; label: string; plan: FieldPlan }[]; value: unknown }) {
  const rows = Array.isArray(value) ? value : []
  return (
    <Block heading={heading}>
      {rows.length === 0 ? (
        <p className="text-[12px] text-fg-subtle">no rows</p>
      ) : (
        <div className="overflow-auto rounded-md border">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b bg-surface">
                {columns.map((c) => (
                  <th key={c.key} className="px-2 py-1 text-left font-medium text-fg-muted">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-b-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1 align-top">
                      {renderCell(c.plan, isPlainObject(row) ? row[c.key] : undefined)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  )
}

function ListNode({ heading, item, value }: { heading: string; item: FieldPlan; value: unknown }) {
  const items = Array.isArray(value) ? value : []
  return (
    <Block heading={heading}>
      {items.length === 0 ? (
        <p className="text-[12px] text-fg-subtle">no items</p>
      ) : (
        <ul className="list-inside list-disc space-y-0.5 text-[13px]">
          {items.map((it, i) => (
            <li key={i}>{renderCell(item, it)}</li>
          ))}
        </ul>
      )}
    </Block>
  )
}

function JsonNode({ heading, reason, value }: { heading: string; reason?: string; value: unknown }) {
  return (
    <Block
      heading={reason ? `${heading} — ${reason}` : heading}
    >
      <pre className="readout max-h-60 overflow-auto whitespace-pre-wrap rounded-md border bg-bg p-2 text-[11.5px] leading-relaxed">
        {jsonText(value)}
      </pre>
    </Block>
  )
}

/** The single recursive entry point: a `FieldPlan` (`planField`'s own,
 *  unchanged) paired with the value it belongs to, at ANY depth. */
function renderField(plan: FieldPlan, value: unknown, label: string, help?: string): ReactNode {
  switch (plan.control) {
    case 'group':
      return <GroupNode heading={label} fields={plan.children} value={value} />
    case 'table':
      return <TableNode heading={label} columns={plan.columns} value={value} />
    case 'list':
      return <ListNode heading={label} item={plan.item} value={value} />
    case 'json':
      return <JsonNode heading={label} reason={plan.reason} value={value} />
    default:
      return (
        <Row label={label} help={help}>
          {renderScalar(plan, value)}
        </Row>
      )
  }
}

function UnknownField({ field }: { field: PlannedResultField }) {
  return <JsonNode heading={field.label} value={field.value} />
}

export interface ResultViewProps {
  schema: JsonSchemaNode
  value: unknown
}

/**
 * The typed, read-only view of a job's result (F19/F20's replacement).
 * `page.tsx` mounts this only when `job.resultSchema` is present (a
 * `valid`/`invalid` result with a known shape); every other status —
 * `undeclared`, `oversize`, a `null` value — keeps today's `<pre>`, which
 * this component does not attempt to reproduce or improve on (§4.8's own
 * banners sit above it, not inside it).
 */
export function ResultView({ schema, value }: ResultViewProps) {
  const fields = useMemo(() => planResult(schema, value), [schema, value])
  const declared = fields.filter((f) => !f.unknown)
  const unknownFields = fields.filter((f) => f.unknown)

  if (declared.length === 0 && unknownFields.length === 0) {
    return <p className="text-[12.5px] text-fg-subtle">This result has no fields to show.</p>
  }

  return (
    <div className="space-y-1">
      <div>{declared.map((field) => <div key={field.path}>{renderField(field.plan, field.value, field.label, field.help)}</div>)}</div>
      {unknownFields.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <p className="rack-label mb-1 text-fg-subtle">not declared by the schema</p>
          {unknownFields.map((field) => (
            <UnknownField key={field.path} field={field} />
          ))}
        </div>
      )}
    </div>
  )
}
