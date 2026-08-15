import { z } from 'zod'
import type { JsonSchemaNode } from '../api/json-schema'
import { formatValue, type NumberKind } from './format'
import { ParamIssueSchema } from './validate'
import { type DurationUnit, type ParamKind, readHints } from './vocabulary'

/**
 * Plan 97 §3.3 — five states, because two are not enough. Written exactly
 * once, by the settle path, for every job that reaches a terminal status;
 * `NULL` while queued or running.
 *
 * - `undeclared` — the script declared no result schema. `jobs.result` holds
 *   whatever it returned (possibly `null`).
 * - `valid` — declared, and the returned value satisfied it. `jobs.result`
 *   holds the value, verbatim.
 * - `invalid` — declared, and the returned value did NOT satisfy it.
 *   `jobs.result` still holds the value, verbatim — never coerced, never
 *   stripped (§3.3: "the child validates with `safeParse` used purely as an
 *   oracle and stores the raw value it was handed").
 * - `partial` — the run failed; this came from `finish()` and no schema was
 *   applied. `jobs.result` holds whatever `finish()` returned.
 * - `oversize` — the value exceeded `job.maxResultBytes` and was never
 *   transmitted. `jobs.result` is `null`.
 */
export const RESULT_STATUSES = ['undeclared', 'valid', 'invalid', 'partial', 'oversize'] as const
export type ResultStatus = (typeof RESULT_STATUSES)[number]
export const ResultStatusSchema = z.enum(RESULT_STATUSES)

/**
 * Plan 97 §3.4, §3.7, §4.1 — the numbers a result is measured against.
 */
export const RESULT_LIMITS = {
  /** Matches `kv.maxValueBytes` (plan 79) — the other place a script persists
   *  structured JSON. One number for "what a script may hand the database
   *  as a value; anything larger is a file" (§3.4). */
  defaultMaxResultBytes: 64 * 1024,
  /** At most three fields may claim the headline (§3.6). */
  maxSummaryFields: 3,
  maxSummaryChars: 120,
  maxIssues: 20,
  maxIssueMessageChars: 200,
  /** Live progress only (§3.7). Not a setting: no operator will tune it. */
  maxProgressBytes: 4 * 1024,
} as const

/**
 * One field marked `summary: true` on a result schema (§3.6, §4.1) — the
 * meaning `summaryFields` extracts, computed once per script version and
 * cached on the registry entry rather than recomputed per job (§4.5).
 * `path` is a top-level key only: `summary` is valid on at most three
 * TOP-LEVEL result fields (§3.6), never a nested one, so there is no dotted
 * path here the way `ParamIssue.path` sometimes needs one.
 */
export interface SummaryField {
  path: string
  title: string
  kind: ParamKind | undefined
  unit: DurationUnit | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Declaration-ordered paths of the fields marked `summary: true`, capped and
 * validated. Computed ONCE per script version, cached on the registry entry
 * (§4.5) — the walk is top-level-only (no `$ref`, no recursion) because
 * `summary` is only ever meaningful on a top-level field (§3.6).
 *
 * Total: a `null` schema (`undeclared`), a schema with no `properties`, or a
 * schema whose hints do not parse all answer `[]` rather than throwing —
 * the same "never propagate junk" discipline `readHints` itself keeps.
 */
export function summaryFields(schema: JsonSchemaNode | null): SummaryField[] {
  if (schema === null) return []
  const properties = (schema as Record<string, unknown>).properties
  if (!isRecord(properties)) return []
  const fields: SummaryField[] = []
  for (const [path, node] of Object.entries(properties)) {
    if (fields.length >= RESULT_LIMITS.maxSummaryFields) break
    if (!isRecord(node)) continue
    const hints = readHints(node as JsonSchemaNode)
    if (hints.summary !== true) continue
    const title = typeof node.title === 'string' ? node.title : path
    fields.push({ path, title, kind: hints.kind, unit: hints.unit })
  }
  return fields
}

/** `kind`s `formatValue` can already render a bare number for (everything
 *  `NumberKind` covers minus the "no kind declared" fallback). Any other
 *  `ParamKind` (`text`, `packageName`, or `undefined`) is not a number
 *  formatter's job. */
function asNumberKind(kind: ParamKind | undefined): NumberKind {
  return kind !== undefined && kind !== 'text' && kind !== 'packageName' ? kind : 'plain'
}

/** The first word of a title, lowercased — `"Videos watched"` → `"videos"`.
 *  Used only for kinds whose formatted text carries no unit of its own
 *  (`count`/`plain`): a bare `"312"` says nothing about what was counted,
 *  unlike `"42 min"` or `"35%"`, which are already self-describing. */
function leadWord(title: string): string {
  const word = title.trim().split(/\s+/)[0]
  return word ? word.toLowerCase() : ''
}

/**
 * `summaryFields(schema)` paired with a job's actual result value →
 * one operator-legible line, ≤ `RESULT_LIMITS.maxSummaryChars`. Pure; uses
 * `formatValue` so a summary and a field's own readout never disagree on
 * how the same number reads (plan 95's formatter, reused rather than
 * reinvented — §3.6). Returns `null` when nothing is marked, the value is
 * not an object, or every marked field is missing/unformattable — never an
 * empty string, so a caller can `?? '—'` once rather than checking length.
 *
 * A `count`/`plain`-kind number is rendered as `"<value> <leadWord(title)>"`
 * (`312` + title `"Videos watched"` → `"312 videos"`) because a bare number
 * has no unit of its own; every other numeric kind renders through
 * `formatValue` alone, since it already carries one (`"42 min"`, `"35%"`).
 * A string field renders as its own text; a boolean renders as
 * `"<title>: yes|no"`. A field whose kind is a string kind (`text`,
 * `packageName`) or absent, and whose value is itself not a string/boolean/
 * number, is skipped — there is no honest generic rendering for it and
 * `formatResult`'s raw `<pre>` is the fallback for that job, not this line.
 */
export function buildResultSummary(fields: SummaryField[], value: unknown): string | null {
  if (fields.length === 0 || !isRecord(value)) return null
  const parts: string[] = []
  for (const field of fields) {
    const raw = value[field.path]
    if (raw === undefined) continue
    if (typeof raw === 'number' || Array.isArray(raw)) {
      const numberKind = asNumberKind(field.kind)
      const formatted = formatValue(numberKind, field.unit, raw)
      if (formatted === '—') continue
      parts.push(numberKind === 'count' || numberKind === 'plain' ? `${formatted} ${leadWord(field.title)}`.trim() : formatted)
    } else if (typeof raw === 'string') {
      if (raw.length > 0) parts.push(raw)
    } else if (typeof raw === 'boolean') {
      parts.push(`${field.title}: ${raw ? 'yes' : 'no'}`)
    }
  }
  if (parts.length === 0) return null
  const joined = parts.join(' · ')
  if (joined.length <= RESULT_LIMITS.maxSummaryChars) return joined
  return `${joined.slice(0, RESULT_LIMITS.maxSummaryChars - 1)}…`
}

/**
 * Plan 97 §3.8, §4.3 — the child's own verdict on one result, carried
 * unchanged across every boundary that touches it: the child⇄parent
 * `result` IPC message (`@enkaku/session`'s `ipc.ts`), the node⇄control-plane
 * tunnel (`tunnel.ts`'s `JobProgressMessage`), `AttemptOutcome`/
 * `JobRunner.execute()` (`@enkaku/session`), and `result-store.ts`'s
 * `recordResult` input (`@enkaku/core`). One shared shape rather than one
 * per boundary, so nothing has to be kept in sync by hand.
 *
 * `bytes` is the child's own `TextEncoder`-measured count (§3.4) — the
 * parent re-measures independently wherever it actually received the value
 * and trusts this number only when it did not (the `oversize` case, where
 * the value never crossed IPC at all and this is the only record it
 * existed). `issues` is present only for `invalid`, capped at
 * `RESULT_LIMITS.maxIssues` — already bounded at the IPC layer so a script
 * returning a value with an enormous number of violations can never
 * silently fail to send its result at all (F10: `send()` drops anything
 * that fails its own schema, with no log and no throw).
 */
export const ResultOutcomeSchema = z.object({
  status: ResultStatusSchema,
  bytes: z.number().int().nonnegative(),
  issues: z.array(ParamIssueSchema).max(RESULT_LIMITS.maxIssues).optional(),
})
export type ResultOutcome = z.infer<typeof ResultOutcomeSchema>
