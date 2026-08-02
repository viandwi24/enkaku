import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { z } from 'zod'

export interface PublishOptions {
  entry: string
  farmUrl: string
  token?: string
}

/**
 * `enkaku publish <entry.ts>` (spec §11.4): bundles the script and its deps
 * into one file. The farm only accepts finished bundles, which makes
 * dependencies deterministic and means the runner installs nothing.
 */
export async function publish(opts: PublishOptions): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'enkaku-publish-'))
  const outfile = join(tmp, 'bundle.mjs')
  try {
    // 1. Bundle EVERY dependency (@enkaku/sdk and zod included), nothing external.
    const build = await Bun.build({
      entrypoints: [opts.entry],
      target: 'bun',
      format: 'esm',
      outdir: tmp,
      naming: 'bundle.mjs',
    })
    if (!build.success) {
      throw new Error(`bundling failed:\n${build.logs.map((l) => String(l)).join('\n')}`)
    }

    // 2. Import the bundle on the author's machine → read the default export and validate.
    const mod = (await import(outfile)) as { default?: unknown }
    const def = mod.default as
      | { id: string; version: string; params: unknown; run: unknown }
      | undefined
    if (!def || typeof def.run !== 'function') {
      throw new Error('the entry has no default export produced by defineScript()')
    }
    if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(def.version)) {
      throw new Error(`version "${def.version}" is not semver`)
    }
    const params = def.params as z.ZodTypeAny
    if (!params || typeof params.safeParse !== 'function') {
      throw new Error('`params` must be a Zod schema')
    }

    // 3. Zod → JSON Schema (Studio uses it to generate the parameter form).
    const paramsSchema = z.toJSONSchema(params)

    // 4. POST it to the farm. The entry source ships alongside the bundle so a
    // human can later read what a job ran — the bundle itself is ~500 KB of
    // inlined dependencies and tells you nothing.
    const bundle = await Bun.file(outfile).text()
    const source = await Bun.file(opts.entry).text()
    const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/scripts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ name: def.id, version: def.version, bundle, source, paramsSchema }),
    })
    const body = (await res.json()) as { script?: { id: string }; error?: { code: string; message: string } }
    if (res.status === 409) {
      throw new Error(`${def.id}@${def.version} already exists on the farm — bump the version`)
    }
    if (!res.ok) {
      throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
    }

    // 5. Report the result.
    console.log(`✓ published ${def.id}@${def.version}`)
    console.log(`  id     : ${body.script?.id}`)
    console.log(`  bundle : ${(bundle.length / 1024).toFixed(1)} KB`)
    console.log(`  farm   : ${opts.farmUrl}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
