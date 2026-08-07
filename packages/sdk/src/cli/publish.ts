import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { z } from 'zod'
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
  const def = built.default as { id: string; version: string; params: unknown; run: unknown } | undefined
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
  // Zod → JSON Schema (Studio uses it to generate the parameter form).
  const paramsSchema = z.toJSONSchema(params)

  const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/scripts`, {
    method: 'POST',
    headers: authHeaders(opts.token),
    body: JSON.stringify({ name: def.id, version: def.version, bundle: built.bundle, source: built.source, paramsSchema }),
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
