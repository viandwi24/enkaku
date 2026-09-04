import { z } from 'zod'
import type { JsonSchemaNode } from '../api/json-schema'

/**
 * The value's meaning. Closed and versioned: adding an entry is a protocol
 * change, and everything that reads hints (the resolver, `readHints` below)
 * must degrade gracefully on one it does not know — a schema published by a
 * newer core, rendered by an older Studio.
 *
 * `range` is deliberately absent (plan 95 §3.2). A `[min, max]` interval is
 * already stated by *structure* — `prefixItems` of length two — so a
 * `kind: 'range'` would be a second statement of a fact the schema already
 * carries, and could disagree with it. `kind` names meaning; structure names
 * arity.
 *
 * Every control name (`slider`, `stepper`, `dropdown`, ...) is likewise
 * absent on purpose: this package names what a value MEANS, never how it is
 * drawn (plan 95 §3.1) — choosing a control is Studio's job, in a later step.
 *
 * `workspaceFolder` and `workspaceFile` are the two PATH meanings: "this
 * value names a place in the workspace" (`/videos`) and "this value names a
 * file in the workspace" (`/captions.txt`). Always a workspace path —
 * absolute within the workspace, the same string `fs.list`/`fs.read` take —
 * and NEVER a host filesystem path: nothing outside the workspace is
 * nameable this way, which is the whole reason these are two kinds and not
 * one `kind: 'path'`. Both are valid only on `type: 'string'`.
 *
 * `artifact` (plan 113 §4.1, added by step 113.9 to close gap G6) names a
 * value that is an ARTIFACT ID — the same opaque id `POST /api/artifacts`
 * returns and `device.push`/`resolveArtifact` already accept. It is its own
 * kind rather than a third `workspace*` variant on purpose: the two kinds
 * above name a place inside the WORKSPACE tree (`fs.list`/`fs.read`'s own
 * path strings), while an artifact is a row in a completely different store
 * (the artifact table, files on disk) addressable only by this id — never a
 * path, and never a URL. Valid only on `type: 'string'`, like the two
 * workspace kinds above.
 *
 * `timestamp` (plan 108 §4.3, added by step 108.7 after 108.11 hit the gap)
 * is an INSTANT, always in unix **seconds** — the repo-wide storage
 * convention for every time value (`docs/plans/00-overview.md` §4.2, and
 * Drizzle's own `mode: 'timestamp'` columns). It is the counterpart to
 * `duration`, which is a SPAN and carries a `unit`; an instant needs no unit
 * because the vocabulary fixes one, exactly as `chance` fixes the domain
 * `[0,1]` rather than letting an author declare percent-or-fraction. A field
 * holding milliseconds is therefore NOT a `timestamp` — it is a number, and
 * declaring it one would render it as a date in 1970.
 */
export const PARAM_KINDS = [
  'count',
  'chance',
  'duration',
  'timestamp',
  'bytes',
  'bitrate',
  'pixels',
  'temperature',
  'text',
  'packageName',
  'workspaceFolder',
  'workspaceFile',
  'artifact',
] as const
export type ParamKind = (typeof PARAM_KINDS)[number]

/**
 * The kinds whose value is a STRING. Everything else in `PARAM_KINDS` is a
 * number, which is what `NumberKind` (`./format.ts`) derives itself from —
 * so adding a string kind above without adding it here is a compile error at
 * `formatScalar`'s exhaustive switch, not a value silently formatted as
 * `"NaN"`. Meaning, not presentation: "is this value a string" is a fact
 * about the value, the same category as `kind` itself.
 */
export const STRING_PARAM_KINDS = ['text', 'packageName', 'workspaceFolder', 'workspaceFile', 'artifact'] as const
export type StringParamKind = (typeof STRING_PARAM_KINDS)[number]

/** Required by, and valid only for, `kind: 'duration'` (plan 95 §3.2). */
export const DURATION_UNITS = ['ms', 's', 'min', 'h'] as const
export type DurationUnit = (typeof DURATION_UNITS)[number]

/**
 * How hard a field is actually enforced (plan 98 §3.5, §4.3) — sits beside
 * `kind`, not inside it: `kind` names what a value MEANS, `enforcement`
 * names how much to trust the ceiling next to it. `hard` is refused/clamped
 * outright; `sampled` is checked on an interval and can miss the window
 * between two samples (a memory limit today — see `job.memory.*` in
 * `./settings.ts`); `advisory` is recorded but never acted on. Every field
 * this plan ships carries one on purpose, so an unlabelled advisory field
 * can never be added silently (plan 98 §1).
 */
export const ENFORCEMENT_LEVELS = ['hard', 'sampled', 'advisory'] as const
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number]

/**
 * Where the set of ALLOWED VALUES comes from, when the schema cannot list it
 * literally (plan 95 §3.4). A closed allowlist kept in Studio (`KEY_MAP` in
 * `useEnumSource.ts`): an unrecognised value is ignored, never fetched — a
 * script cannot name an arbitrary URL or endpoint this way.
 */
export const PARAM_SOURCES = [
  'registry.transports',
  'registry.displays',
  'registry.inputs',
  'registry.inspectors',
  'registry.networks',
  'devices',
  'groups',
  'scripts',
] as const
export type ParamSource = (typeof PARAM_SOURCES)[number]

/**
 * A parameter only applies when a sibling field holds a given value (plan 95
 * §3.6) — one comparison, no boolean algebra, no nested paths.
 */
export type ShowWhen = { field: string; is: string | number | boolean } | { field: string; in: Array<string | number | boolean> }

/**
 * Everything an author may say about a parameter, beyond `title` and
 * `.describe()`. Nothing here names a control — see plan 95 §3.1: this
 * package must contain no word that names a UI widget.
 */
export interface ParamHints {
  kind?: ParamKind
  /** Required by, and valid only for, `kind: 'duration'`. */
  unit?: DurationUnit
  /**
   * Valid only for `kind: 'workspaceFile'` — the file suffixes this field is
   * ABOUT (`['.txt']` for a captions file). A companion key scoped to one
   * kind, exactly like `unit` above, rather than a second parallel way of
   * saying what a value means.
   *
   * It narrows what is OFFERED, never what is accepted: a value already
   * stored — by an older version of the script, by an agent, by hand — is
   * still read back and still shown, because a hint that silently dropped a
   * real value would be worse than an unfiltered list. Lowercase, dotted,
   * matched case-insensitively against the end of the path.
   */
  extensions?: string[]
  /** 2-number tuples only: the pair is an interval, low end first. Default `true`. */
  ordered?: boolean
  /** Strings only: the value is prose, not a token. */
  multiline?: boolean
  /** Section heading. Adjacent fields sharing a value form one section (plan 95 §3.5). */
  group?: string
  /** A parameter most operators never change. Studio may collapse it; the schema does not say how. */
  advanced?: boolean
  /** Where the set of allowed values comes from, when the schema cannot list it. */
  source?: ParamSource
  /** Human names for enum members. */
  labels?: Record<string, string>
  showWhen?: ShowWhen
  /** How hard this field's limit is actually enforced (plan 98 §3.5). Append-only, like `kind`. */
  enforcement?: EnforcementLevel
  /**
   * RESULT fields only (plan 97 §3.6, §4.1): "of these fields, this one is
   * the headline fact about the run." Valid on at most three top-level
   * fields of a `result` schema, enforced at publish (`checkDeclaredSchema`)
   * — meaningless, and never checked, on a `params` schema. It is meaning,
   * the same category as `kind`, not a presentation hint: Studio still
   * decides entirely how to draw it (a summary line, a badge, ...); the core
   * uses the same fact to build `jobs.result_summary` (`buildResultSummary`,
   * `./result.ts`). One key, nothing else — the vocabulary is shared by
   * parameters and results, and every key added to it is a key every
   * consumer must understand forever.
   */
  summary?: boolean
}

/**
 * The one `.meta()` key everything above lives under (plan 95 §3.2): one
 * thing to size-limit, one thing to validate, one thing to strip before
 * handing a schema to an external consumer.
 */
export const ENKAKU_META_KEY = 'x-enkaku' as const

const ShowWhenSchema: z.ZodType<ShowWhen> = z.union([
  z.object({ field: z.string(), is: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ field: z.string(), in: z.array(z.union([z.string(), z.number(), z.boolean()])) }),
])

/**
 * The Zod schema every hint object is checked against — at publish
 * (`checkDeclaredSchema`, `./limits.ts`) and when a stored schema is read
 * (`readHints`, below). Unknown keys are STRIPPED, not rejected: a schema
 * published by a newer core must still render on an older Studio.
 */
export const ParamHintsSchema: z.ZodType<ParamHints> = z
  .object({
    kind: z.enum(PARAM_KINDS).optional(),
    unit: z.enum(DURATION_UNITS).optional(),
    extensions: z.array(z.string().regex(/^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/, 'each extension must be a lowercase dotted suffix, e.g. ".txt"')).min(1).max(10).optional(),
    ordered: z.boolean().optional(),
    multiline: z.boolean().optional(),
    group: z.string().optional(),
    advanced: z.boolean().optional(),
    source: z.enum(PARAM_SOURCES).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    showWhen: ShowWhenSchema.optional(),
    enforcement: z.enum(ENFORCEMENT_LEVELS).optional(),
    summary: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'duration' && val.unit === undefined) {
      ctx.addIssue({ code: 'custom', message: "kind: 'duration' requires a unit", path: ['unit'] })
    }
    if (val.kind !== 'duration' && val.unit !== undefined) {
      ctx.addIssue({ code: 'custom', message: "unit is only valid for kind: 'duration'", path: ['unit'] })
    }
    if (val.kind !== 'workspaceFile' && val.extensions !== undefined) {
      ctx.addIssue({ code: 'custom', message: "extensions is only valid for kind: 'workspaceFile'", path: ['extensions'] })
    }
  })

/**
 * Read the hints off a JSON Schema node, safely. Returns `{}` for a node
 * with no hints, malformed hints, or hints naming a value (a `kind`, a
 * `source`, ...) from a vocabulary newer than this build knows — never
 * throws, never propagates junk (plan 95 §5 step 95.1's verifiable result).
 */
export function readHints(node: JsonSchemaNode): ParamHints {
  if (node === null || typeof node !== 'object') return {}
  const raw = (node as Record<string, unknown>)[ENKAKU_META_KEY]
  if (raw === undefined) return {}
  const parsed = ParamHintsSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/** `ui()`'s parameter shape before the overloads narrow it. */
export type UiSpec = { title: string; description?: string } & ParamHints

/**
 * `.meta(ui({ title: 'Save chance', kind: 'chance' }))` — a typed identity
 * function that is where the vocabulary is enforced for the 95% case (plan
 * 95 §3.2). The two overloads below make the invalid combinations
 * unrepresentable rather than merely documented:
 *
 *   - `kind: 'duration'` REQUIRES `unit`.
 *   - every other kind FORBIDS `unit` (`unit?: never`).
 *
 *   - `extensions` belongs to `kind: 'workspaceFile'` alone.
 *
 * A misspelled `kind`, a `unit` on a non-duration, an `extensions` on
 * anything but a workspace file, or `{ kind: 'duration' }` with no unit are
 * all compile errors in the author's own editor — not a runtime surprise at
 * publish or render time.
 *
 * Declared here and re-exported from `@enkaku/sdk` so a script's import
 * allowlist (F9 — a script may import only `@enkaku/sdk` and `zod`) is
 * satisfied without widening it.
 */
export function ui(
  spec: { title: string; description?: string; kind: 'duration'; unit: DurationUnit; extensions?: never } & Omit<ParamHints, 'kind' | 'unit' | 'extensions'>,
): Record<string, unknown>
export function ui(
  spec: { title: string; description?: string; kind: 'workspaceFile'; unit?: never; extensions?: string[] } & Omit<
    ParamHints,
    'kind' | 'unit' | 'extensions'
  >,
): Record<string, unknown>
export function ui(
  spec: { title: string; description?: string; kind?: Exclude<ParamKind, 'duration' | 'workspaceFile'>; unit?: never; extensions?: never } & Omit<
    ParamHints,
    'kind' | 'unit' | 'extensions'
  >,
): Record<string, unknown>
export function ui(spec: UiSpec): Record<string, unknown> {
  const { title, description, ...hints } = spec
  const cleanHints = Object.fromEntries(Object.entries(hints).filter(([, v]) => v !== undefined))
  return {
    title,
    ...(description !== undefined ? { description } : {}),
    [ENKAKU_META_KEY]: cleanHints,
  }
}
