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
 * `enkaku publish <entry.ts>` (spec §11.4): bundle script + deps jadi satu
 * file, farm hanya menerima bundle jadi → dependency deterministik, runner
 * tidak perlu install apa pun.
 */
export async function publish(opts: PublishOptions): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'enkaku-publish-'))
  const outfile = join(tmp, 'bundle.mjs')
  try {
    // 1. bundle SEMUA dependency (termasuk @enkaku/sdk & zod), tanpa external.
    const build = await Bun.build({
      entrypoints: [opts.entry],
      target: 'bun',
      format: 'esm',
      outdir: tmp,
      naming: 'bundle.mjs',
    })
    if (!build.success) {
      throw new Error(`bundle gagal:\n${build.logs.map((l) => String(l)).join('\n')}`)
    }

    // 2. import bundle di mesin author → ambil default export & validasi.
    const mod = (await import(outfile)) as { default?: unknown }
    const def = mod.default as
      | { id: string; version: string; params: unknown; run: unknown }
      | undefined
    if (!def || typeof def.run !== 'function') {
      throw new Error('entry tidak punya default export hasil defineScript()')
    }
    if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(def.version)) {
      throw new Error(`version "${def.version}" bukan semver`)
    }
    const params = def.params as z.ZodTypeAny
    if (!params || typeof params.safeParse !== 'function') {
      throw new Error('`params` harus schema Zod')
    }

    // 3. Zod → JSON Schema (dipakai Studio untuk auto-generate form param).
    const paramsSchema = z.toJSONSchema(params)

    // 4. POST ke farm.
    const bundle = await Bun.file(outfile).text()
    const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/scripts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ name: def.id, version: def.version, bundle, paramsSchema }),
    })
    const body = (await res.json()) as { script?: { id: string }; error?: { code: string; message: string } }
    if (res.status === 409) {
      throw new Error(`versi ${def.id}@${def.version} sudah ada di farm — naikkan version`)
    }
    if (!res.ok) {
      throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
    }

    // 5. Laporkan hasil.
    console.log(`✓ published ${def.id}@${def.version}`)
    console.log(`  id     : ${body.script?.id}`)
    console.log(`  bundle : ${(bundle.length / 1024).toFixed(1)} KB`)
    console.log(`  farm   : ${opts.farmUrl}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
