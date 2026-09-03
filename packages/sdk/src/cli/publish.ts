import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { z } from 'zod'
import { checkDeclaredSchema } from '@enkaku/protocol'
import { isPlugin } from '../plugin'
import { buildUiAssets } from './build-ui'
import { PACKAGE_CONTENT_TYPE, writeEnkakuPackage, type UiAsset } from './enkaku-package'

export interface PublishOptions {
  entry: string
  farmUrl: string
  token?: string
  /**
   * Stage the bundle without verifying it in the same call (plan 82 §5 step
   * 12). Mainly for scripting a publish pipeline that wants to kick off
   * verification separately (`POST /api/plugins/:id/verify`).
   */
  stageOnly?: boolean
}

export interface BuiltEntry {
  bundle: string
  source: string
  default: unknown
  /**
   * The project's built `ui/` payload (plan 111 §4.4), empty for a project
   * with no `ui/` directory — which is what decides whether this publish goes
   * out as a `.enkaku` archive or as the original JSON body.
   */
  ui: UiAsset[]
}

/** Bundles EVERY dependency (`@enkaku/sdk` and `zod` included), nothing external — the farm only ever accepts a finished bundle, so the runner installs nothing. Exported for `dev.ts`, which does the identical local build on every change. */
function describeBuildFailure(err: unknown): string {
  const errors = (err as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) => (e instanceof Error ? e.message : String(e))).join('\n')
  }
  return err instanceof Error ? err.message : String(err)
}

export async function buildEntry(entry: string, tmp: string): Promise<BuiltEntry> {
  const outfile = join(tmp, 'bundle.mjs')
  let build: Awaited<ReturnType<typeof Bun.build>>
  try {
    build = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      format: 'esm',
      outdir: tmp,
      naming: 'bundle.mjs',
    })
  } catch (err) {
    // *(measured, Bun 1.3.14)* a resolution/export failure REJECTS with an
    // `AggregateError` rather than resolving `{ success: false }`, and that
    // error's own `message` is the useless "Bundle failed" — the real one
    // ("No matching export in ... for import ...") is on `.errors`. Worth
    // unwrapping rather than passing through: since plan 110 removed
    // `defineScript`, `import { defineScript } from '@enkaku/sdk'` is the
    // single most likely reason an author lands here, and "Bundle failed"
    // tells them nothing about it.
    throw new Error(`bundling failed:\n${describeBuildFailure(err)}`)
  }
  if (!build.success) {
    throw new Error(`bundling failed:\n${build.logs.map((l) => String(l)).join('\n')}`)
  }
  // Import on the author's machine → read the default export and validate its shape.
  const mod = (await import(outfile)) as { default?: unknown }
  const bundle = await Bun.file(outfile).text()
  const source = await Bun.file(entry).text()
  // The React half is built by the SAME function `dev` uses, in the same call,
  // so a publish and a dev push can never ship different assets for one commit.
  const ui = await buildUiAssets(entry, tmp)
  return { bundle, source, default: mod.default, ui }
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
function warnAboutRefinements(schema: unknown, what: 'params' | 'result', scriptId: string): void {
  const paths = findRefinementPaths(schema)
  if (paths.length === 0) return
  console.log(
    `warning: script "${scriptId}": ${what} carries ${paths.length} refinement${paths.length === 1 ? '' : 's'} that the run form cannot evaluate (${paths.join(', ')}). Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.`,
  )
}

/**
 * Publish path 3 of 3 (plan 95 §4.9, §5 step 95.5) — the SAME
 * `checkDeclaredSchema` gate the plugin verify child runs
 * (`plugins/verify-child-entry.ts`), but LOCALLY: the author sees a refused
 * publish in their own terminal, before any network call, rather than only a
 * failed verification a round trip later. A `'group'` finding is the
 * non-consecutive-group WARNING (plan 95 §3.5, "warns... so the author can
 * reorder or accept it") — printed, publish continues; every other finding
 * refuses the publish outright (no request is ever sent).
 *
 * Plan 110 §4.2 moved this from the deleted single-script publish path onto
 * EVERY member of the plugin, which is the only thing there is left to publish. It runs
 * over all members before the first byte is sent, so an author fixing two
 * scripts is not made to publish twice to find the second one.
 */
function checkAndReportParamsSchema(paramsSchema: unknown, scriptId: string): void {
  const findings = checkDeclaredSchema(paramsSchema)
  const warnings = findings.filter((f) => f.limit === 'group')
  const blocking = findings.filter((f) => f.limit !== 'group')
  for (const w of warnings) {
    console.log(`warning: script "${scriptId}": ${w.path || '(root)'}: ${w.message}`)
  }
  if (blocking.length > 0) {
    const lines = blocking.map((f) => `  ${f.path || '(root)'}: ${f.message}`).join('\n')
    throw new Error(`script "${scriptId}": params schema violates the published limits (plan 95 §3.8) — nothing was published:\n${lines}`)
  }
}

/**
 * Plan 97 §4.4, §4.7, §5 step 97.2 — the result half of the SAME gate,
 * checked at its OWN call site rather than sharing `checkAndReportParamsSchema`
 * (a params schema and a result schema are never the same declaration, and
 * the two messages below name which one failed).
 */
function checkAndReportResultSchema(resultSchema: unknown, scriptId: string): void {
  const findings = checkDeclaredSchema(resultSchema)
  const warnings = findings.filter((f) => f.limit === 'group')
  const blocking = findings.filter((f) => f.limit !== 'group')
  for (const w of warnings) {
    console.log(`warning: script "${scriptId}": (result) ${w.path || '(root)'}: ${w.message}`)
  }
  if (blocking.length > 0) {
    const lines = blocking.map((f) => `  ${f.path || '(root)'}: ${f.message}`).join('\n')
    throw new Error(`script "${scriptId}": result schema violates the published limits (plan 97 §3.8) — nothing was published:\n${lines}`)
  }
}

/**
 * The refusal plan 110 §4.2 / criterion 6 specifies, and the whole of the
 * "Hard" reading of decision A on the CLI side: a script cannot be published
 * outside a plugin, so an entry whose default export is not a `definePlugin()`
 * result is refused rather than silently wrapped (the rejected option, §3.1).
 *
 * The message carries the wrapper itself, not a pointer to it. An author who
 * hits this is one paste away from a working entry without opening a single
 * doc — which is the only thing that makes a hard removal cheap enough to be
 * the right call.
 */
export const NOT_A_PLUGIN_MESSAGE = `the entry's default export is not a plugin — and a script cannot be published on its own (plan 110 §3.1).

Wrap what you have in a plugin — four lines:

  import { definePlugin } from '@enkaku/sdk'

  export default definePlugin({
    id: 'my-plugin',
    version: '1.0.0',
    scripts: [{ id: 'my-script', title: 'My script', description: 'What it does', params, run }],
  })

Or scaffold a project that already publishes: enkaku init my-plugin`

/**
 * `enkaku publish <entry.ts>` (spec §11.4): bundles the entry and its deps
 * into one file. The farm only accepts finished bundles, which makes
 * dependencies deterministic and means the runner installs nothing.
 *
 * Plan 110 §4.2, criterion 6 — there is no branch left. The entry's default
 * export is a `definePlugin()` result or the publish is refused: a script
 * cannot be published outside a plugin, so `POST /api/plugins` (stage, then
 * verify in the same call unless `--stage-only`) is the only endpoint this
 * command has. Detected with `isPlugin()`, the SAME structural check
 * `child-entry.ts`'s loader makes — one definition of "is this a plugin," not
 * two.
 */
export async function publish(opts: PublishOptions): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'enkaku-publish-'))
  try {
    const built = await buildEntry(opts.entry, tmp)
    if (!isPlugin(built.default)) throw new Error(NOT_A_PLUGIN_MESSAGE)
    await publishPlugin(built, opts)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Every member's declared schemas, checked LOCALLY before the first byte is
 * sent (plan 95 §4.9, plan 97 §4.4 — see `checkAndReportParamsSchema`). This
 * is the deleted single-script path's old publish-time gate, now applied
 * where the scripts actually live.
 *
 * A plugin publish sends only the bundle: the farm derives `paramsSchema`/
 * `resultSchema` in its verify child, and gates them there too. So this is
 * not the enforcement — it is the author seeing the same refusal in their own
 * terminal instead of in a verify report.
 */
function checkMemberSchemas(scripts: readonly { id: string; params?: unknown; result?: unknown }[]): void {
  for (const script of scripts) {
    const params = script.params as z.ZodTypeAny | undefined
    if (params && typeof params.safeParse === 'function') {
      warnAboutRefinements(params, 'params', script.id)
      // `io: 'input'` (plan 95 §3.2, §4.9, fixes F2): a params schema
      // describes what a person TYPES. The default `io: 'output'` puts every
      // `.default()` field into `required`, which is why every defaulted
      // parameter used to be published as mandatory — the root of F16's
      // shipped bug.
      checkAndReportParamsSchema(z.toJSONSchema(params, { io: 'input' }), script.id)
    }
    if (script.result !== undefined) {
      const result = script.result as z.ZodTypeAny
      warnAboutRefinements(result, 'result', script.id)
      // A result schema always publishes with `io: 'output'`, never
      // `'input'` — a defaulted result FIELD is already applied by the time
      // `run()` resolves, so it belongs in `required` (F24, the reciprocal
      // of why a params schema needs `'input'`).
      checkAndReportResultSchema(z.toJSONSchema(result, { io: 'output' }), script.id)
    }
  }
}

async function publishPlugin(built: BuiltEntry, opts: PublishOptions): Promise<void> {
  // `isPlugin()` already narrowed the shape enough to know this has `id`/`version`/`scripts` —
  // `definePlugin()` itself validated everything else (id shape, semver, unique member ids, a
  // matching member version) on the author's own machine, at import time, before this ever ran.
  const def = built.default as { id: string; version: string; scripts: { id: string; params?: unknown; result?: unknown }[] }

  // Before any network call — a refusal here sends nothing at all.
  checkMemberSchemas(def.scripts)

  // TWO TRANSPORTS, ONE ROUTE (plan 108 §3.8, plan 111 §5 step 111.6). A
  // project with a `ui/` directory ships as a raw `.enkaku` archive, because
  // that is the only shape `POST /api/plugins` accepts assets in; a project
  // without one keeps the original JSON body, byte for byte. The branch is on
  // "did this build produce any assets", not on a flag, so an author never has
  // to know which transport their project uses.
  const base = opts.farmUrl.replace(/\/$/, '')
  const res =
    built.ui.length > 0
      ? await fetch(`${base}/api/plugins${opts.stageOnly ? '?stageOnly=1' : ''}`, {
          method: 'POST',
          headers: { 'content-type': PACKAGE_CONTENT_TYPE, ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
          body: writeEnkakuPackage({ name: def.id, version: def.version, source: built.source, scripts: built.bundle, ui: built.ui }),
        })
      : await fetch(`${base}/api/plugins`, {
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
  if (built.ui.length > 0) {
    const uiBytes = built.ui.reduce((n, a) => n + a.data.length, 0)
    console.log(`  ui     : ${built.ui.length} file${built.ui.length === 1 ? '' : 's'}, ${(uiBytes / 1024).toFixed(1)} KB (sent as a .enkaku package)`)
  }
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
