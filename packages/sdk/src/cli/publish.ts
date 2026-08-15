import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { z } from 'zod'
import { checkDeclaredSchema, type SchemaCheckFinding } from '@enkaku/protocol'
import { isPlugin } from '../plugin'

export interface PublishOptions {
  entry: string
  farmUrl: string
  token?: string
  /**
   * Plugin only (plan 82 §5 step 12): stage the bundle without verifying it
   * in the same call. Mainly for scripting a publish pipeline that wants to
   * kick off verification separately (`POST /api/plugins/:id/verify`) —
   * ignored for a standalone script, which has no separate verify step.
   */
  stageOnly?: boolean
}

export interface BuiltEntry {
  bundle: string
  source: string
  default: unknown
}

/** Bundles EVERY dependency (`@enkaku/sdk` and `zod` included), nothing external — shared by a standalone script and a plugin, which publish through different endpoints but bundle identically. Exported for `dev.ts`, which does the identical local build on every change. */
export async function buildEntry(entry: string, tmp: string): Promise<BuiltEntry> {
  const outfile = join(tmp, 'bundle.mjs')
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    outdir: tmp,
    naming: 'bundle.mjs',
  })
  if (!build.success) {
    throw new Error(`bundling failed:\n${build.logs.map((l) => String(l)).join('\n')}`)
  }
  // Import on the author's machine → read the default export and validate its shape.
  const mod = (await import(outfile)) as { default?: unknown }
  const bundle = await Bun.file(outfile).text()
  const source = await Bun.file(entry).text()
  return { bundle, source, default: mod.default }
}

function authHeaders(token: string | undefined): Record<string, string> {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

/**
 * Zod v4 internals, read defensively (never a type import — `_zod` is not
 * part of the public API and this is advisory diagnostics, not a contract).
 * `.refine()`/`.superRefine()` both compile down to one check kind
 * (`check: 'custom'`) on `def.checks`, distinct from a `.min()`/`.max()`/
 * `.regex()` check (`'greater_than'`, `'less_than'`, ...) — *(measured)*
 * against this workspace's installed Zod, the same way plan 95 §0's other
 * findings were.
 */
interface ZodInternal {
  _zod?: { def?: Record<string, unknown> }
}

function hasCustomCheck(schema: unknown): boolean {
  const checks = (schema as ZodInternal)?._zod?.def?.checks
  if (!Array.isArray(checks)) return false
  return checks.some((check) => (check as ZodInternal)?._zod?.def?.check === 'custom')
}

/**
 * Walks the LIVE Zod schema tree — never the JSON Schema output, which
 * silently drops `.refine()`/`.superRefine()` with no `unrepresentable`
 * signal at all (plan 95 §3.6) — collecting one path per refinement found.
 * `'(top level)'` for a refine on the object itself
 * (`z.object({...}).refine(...)`, plan 94 §4.9's `intervalMs` shape). Bounded
 * by depth and never follows `z.lazy()` — this is publish-time author
 * guidance, not a safety boundary that must handle a hostile schema.
 */
function findRefinementPaths(schema: unknown, path = '', depth = 0, out: string[] = []): string[] {
  if (depth > 20 || schema === null || typeof schema !== 'object') return out
  const def = (schema as ZodInternal)._zod?.def
  if (!def) return out

  if (hasCustomCheck(schema)) out.push(path || '(top level)')

  const shape = def.shape
  if (shape !== null && typeof shape === 'object') {
    for (const [key, child] of Object.entries(shape as Record<string, unknown>)) {
      findRefinementPaths(child, path ? `${path}.${key}` : key, depth + 1, out)
    }
  }
  if (def.innerType !== undefined) findRefinementPaths(def.innerType, path, depth + 1, out)
  if (def.element !== undefined) findRefinementPaths(def.element, path ? `${path}[]` : '[]', depth + 1, out)
  if (def.valueType !== undefined) findRefinementPaths(def.valueType, path ? `${path}[]` : '[]', depth + 1, out)
  if (Array.isArray(def.items)) def.items.forEach((item, i) => findRefinementPaths(item, path ? `${path}[${i}]` : `[${i}]`, depth + 1, out))
  if (Array.isArray(def.options)) def.options.forEach((opt) => findRefinementPaths(opt, path, depth + 1, out))
  return out
}

/**
 * Prints the warning §3.6 specifies — this is the difference between a
 * limitation and a trap: `.refine()`/`.superRefine()` are enforced by the
 * child (the real Zod schema) but invisible to the run form and to
 * `validateAgainstSchema` (`@enkaku/protocol/schema/validate.ts`), so an operator
 * who satisfies every field the FORM checks can still watch the job die on
 * one it could not. No-op when there is nothing to warn about.
 */
function warnAboutRefinements(params: unknown): void {
  const paths = findRefinementPaths(params)
  if (paths.length === 0) return
  console.log(
    `warning: params carries ${paths.length} refinement${paths.length === 1 ? '' : 's'} that the run form cannot evaluate (${paths.join(', ')}). Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.`,
  )
}

/**
 * Publish path 3 of 3 (plan 95 §4.9, §5 step 95.5) — the SAME
 * `checkDeclaredSchema` gate `POST /api/scripts` and the plugin verify child
 * run, but LOCALLY: the author sees a refused publish in their own
 * terminal, before any network call, rather than only a 400 weeks later. A
 * `'group'` finding is the non-consecutive-group WARNING (plan 95 §3.5,
 * "warns... so the author can reorder or accept it") — printed, publish
 * continues; every other finding refuses the publish outright (no request
 * is ever sent).
 */
function checkAndReportParamsSchema(paramsSchema: unknown): void {
  const findings = checkDeclaredSchema(paramsSchema)
  const warnings = findings.filter((f) => f.limit === 'group')
  const blocking = findings.filter((f) => f.limit !== 'group')
  for (const w of warnings) {
    console.log(`warning: ${w.path || '(root)'}: ${w.message}`)
  }
  if (blocking.length > 0) {
    const lines = blocking.map((f) => `  ${f.path || '(root)'}: ${f.message}`).join('\n')
    throw new Error(`params schema violates the published limits (plan 95 §3.8) — nothing was published:\n${lines}`)
  }
}

/**
 * Plan 97 §4.4, §4.7, §5 step 97.2 — the result half of the SAME gate,
 * checked at its OWN call site rather than sharing `checkAndReportParamsSchema`
 * (a params schema and a result schema are never the same declaration, and
 * the two messages below name which one failed).
 */
function checkAndReportResultSchema(resultSchema: unknown): void {
  const findings = checkDeclaredSchema(resultSchema)
  const warnings = findings.filter((f) => f.limit === 'group')
  const blocking = findings.filter((f) => f.limit !== 'group')
  for (const w of warnings) {
    console.log(`warning: (result) ${w.path || '(root)'}: ${w.message}`)
  }
  if (blocking.length > 0) {
    const lines = blocking.map((f) => `  ${f.path || '(root)'}: ${f.message}`).join('\n')
    throw new Error(`result schema violates the published limits (plan 97 §3.8) — nothing was published:\n${lines}`)
  }
}

/**
 * `enkaku publish <entry.ts>` (spec §11.4): bundles the entry and its deps
 * into one file. The farm only accepts finished bundles, which makes
 * dependencies deterministic and means the runner installs nothing.
 *
 * Plan 82 §5 step 12: the entry's default export decides the endpoint — a
 * `definePlugin()` result (a `scripts` array) publishes through
 * `POST /api/plugins` (stage, then verify in the same call unless
 * `--stage-only`); a `defineScript()` result (a `run` function) keeps
 * publishing through `POST /api/scripts`, unchanged. Detected with
 * `isPlugin()`, the SAME structural check `child-entry.ts`'s loader makes —
 * one definition of "is this a plugin," not two.
 */
export async function publish(opts: PublishOptions): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'enkaku-publish-'))
  try {
    const built = await buildEntry(opts.entry, tmp)
    if (isPlugin(built.default)) {
      await publishPlugin(built, opts)
    } else {
      await publishScript(built, opts)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function publishScript(built: BuiltEntry, opts: PublishOptions): Promise<void> {
  const def = built.default as
    | { id: string; version: string; params: unknown; result?: unknown; run: unknown; runtime?: unknown }
    | undefined
  if (!def || typeof def.run !== 'function') {
    throw new Error('the entry has no default export produced by defineScript() or definePlugin()')
  }
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(def.version)) {
    throw new Error(`version "${def.version}" is not semver`)
  }
  const params = def.params as z.ZodTypeAny
  if (!params || typeof params.safeParse !== 'function') {
    throw new Error('`params` must be a Zod schema')
  }
  // Checked LOCALLY, before the network call (plan 95 §4.9), so the author
  // sees it in their own terminal rather than only in a run dialog weeks
  // later.
  warnAboutRefinements(params)
  // Zod → JSON Schema (Studio uses it to generate the parameter form).
  // `io: 'input'` (plan 95 §3.2, §4.9, fixes F2): a params schema describes
  // what a person TYPES. The default `io: 'output'` puts every `.default()`
  // field into `required`, which is why every defaulted parameter used to be
  // published as mandatory — the root of F16's shipped bug.
  const paramsSchema = z.toJSONSchema(params, { io: 'input' })
  // Checked LOCALLY too, before the network call (plan 95 §4.9) — see
  // `checkAndReportParamsSchema`'s own doc comment.
  checkAndReportParamsSchema(paramsSchema)

  // Plan 97 §4.4, §4.7, §5 step 97.2 (fixes F1, F5) — OPTIONAL, and checked
  // at its own call site (never sharing the params call above, F24): a
  // result schema always publishes with `io: 'output'`, never `'input'` —
  // a defaulted result FIELD is already applied by the time `run()`
  // resolves, so it belongs in `required` (F24's own reasoning, the mirror
  // image of why a params schema needs `'input'`).
  let resultSchema: unknown = null
  if (def.result !== undefined) {
    const result = def.result as z.ZodTypeAny
    warnAboutRefinements(result)
    resultSchema = z.toJSONSchema(result, { io: 'output' })
    checkAndReportResultSchema(resultSchema)
  }

  const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/scripts`, {
    method: 'POST',
    headers: authHeaders(opts.token),
    // `def.runtime` (plan 98 §4.2, §4.5) is already folded and shape-validated by `defineScript`
    // on THIS machine — sent as-is; the farm independently re-validates it too (§3.7's "never
    // trust the SDK's own checks alone" reasoning, applied here the same way it already is for
    // `paramsSchema`).
    body: JSON.stringify({
      name: def.id,
      version: def.version,
      bundle: built.bundle,
      source: built.source,
      paramsSchema,
      resultSchema,
      runtime: def.runtime ?? null,
    }),
  })
  const body = (await res.json()) as { script?: { id: string }; error?: { code: string; message: string } }
  if (res.status === 409) {
    throw new Error(`${def.id}@${def.version} already exists on the farm — bump the version`)
  }
  if (!res.ok) {
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
  }

  console.log(`✓ published ${def.id}@${def.version}`)
  console.log(`  id     : ${body.script?.id}`)
  console.log(`  bundle : ${(built.bundle.length / 1024).toFixed(1)} KB`)
  console.log(`  farm   : ${opts.farmUrl}`)
}

async function publishPlugin(built: BuiltEntry, opts: PublishOptions): Promise<void> {
  // `isPlugin()` already narrowed the shape enough to know this has `id`/`version`/`scripts` —
  // `definePlugin()` itself validated everything else (id shape, semver, unique member ids, a
  // matching member version) on the author's own machine, at import time, before this ever ran.
  const def = built.default as { id: string; version: string; scripts: { id: string }[] }

  const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/plugins`, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({
      name: def.id,
      version: def.version,
      bundle: built.bundle,
      source: built.source,
      ...(opts.stageOnly ? { stageOnly: true } : {}),
    }),
  })
  const body = (await res.json()) as {
    plugin?: { id: string; status: string }
    verify?: { ok: boolean; scripts: { id: string }[]; error?: string; errorCode?: string }
    error?: { code: string; message: string }
  }
  if (res.status === 409) {
    throw new Error(`${def.id}@${def.version} already exists on the farm — bump the version`)
  }
  if (!res.ok) {
    throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
  }

  console.log(`✓ staged plugin ${def.id}@${def.version} (${def.scripts.length} script${def.scripts.length === 1 ? '' : 's'})`)
  console.log(`  id     : ${body.plugin?.id}`)
  console.log(`  bundle : ${(built.bundle.length / 1024).toFixed(1)} KB`)
  console.log(`  farm   : ${opts.farmUrl}`)
  if (opts.stageOnly) {
    console.log('  status : staged (--stage-only — verify and activate separately)')
    return
  }
  if (!body.verify) return
  if (body.verify.ok) {
    console.log(`  status : verified — ${body.verify.scripts.map((s) => s.id).join(', ')}`)
    console.log(`  next   : POST ${opts.farmUrl}/api/plugins/${body.plugin?.id}/activate (or the Plugins page)`)
  } else {
    console.log(`  status : ${body.plugin?.status ?? 'failed'} — ${body.verify.errorCode ?? 'E_PLUGIN_VERIFY_FAILED'}`)
    console.log(`  error  : ${body.verify.error ?? '(no message)'}`)
    process.exitCode = 1
  }
}
