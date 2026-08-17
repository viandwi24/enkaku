import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EmbeddedPack } from '../embedded'
import type { Logger } from '../util/logger'
import type { PluginRuntime } from './runtime'
import { seedEmbeddedPacks } from './seed-embedded'

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
}

/** Records what the seeder asked for; `rows` stands in for the `plugins` table. */
function fakeRuntime(opts: { failVerify?: boolean } = {}) {
  const staged: string[] = []
  const verified: string[] = []
  /** Per staged key, the `ui/` payload the seeder handed over — `path` plus the bytes, decoded. */
  const stagedUi = new Map<string, { path: string; text: string }[]>()
  const rows = new Map<string, { id: string }>()
  const runtime = {
    get: (name: string, version: string) => (rows.get(`${name}@${version}`) ?? null) as never,
    stage: async (input: { name: string; version: string; bundle: string; ui?: readonly { path: string; data: Uint8Array }[] }) => {
      const key = `${input.name}@${input.version}`
      if (rows.has(key)) throw new Error(`${key} already exists`)
      staged.push(key)
      stagedUi.set(key, (input.ui ?? []).map((a) => ({ path: a.path, text: new TextDecoder().decode(a.data) })))
      const row = { id: `id-${key}` }
      rows.set(key, row)
      return row as never
    },
    verify: async (pluginId: string) => {
      verified.push(pluginId)
      return (opts.failVerify ? { ok: false, error: 'boom' } : { ok: true, scripts: [] }) as never
    },
  } as unknown as PluginRuntime
  return { runtime, staged, stagedUi, verified, rows }
}

async function withDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-seed-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function packsIn(dir: string): Promise<EmbeddedPack[]> {
  const a = join(dir, 'a.mjs')
  const b = join(dir, 'b.mjs')
  await Bun.write(a, 'export default { id: "alpha" }')
  await Bun.write(b, 'export default { id: "beta" }')
  return [
    { name: 'alpha', version: '1.0.0', path: a },
    { name: 'beta', version: '2.0.0', path: b },
  ]
}

describe('seedEmbeddedPacks', () => {
  test('stages and verifies every pack on a fresh data dir', async () => {
    await withDataDir(async (dir) => {
      const { runtime, staged, verified } = fakeRuntime()
      await seedEmbeddedPacks({ runtime, packs: await packsIn(dir), dataDir: dir, log: silent })

      expect(staged).toEqual(['alpha@1.0.0', 'beta@2.0.0'])
      expect(verified).toEqual(['id-alpha@1.0.0', 'id-beta@2.0.0'])
      expect(await Bun.file(join(dir, 'seeded-packs.json')).json()).toEqual(['alpha@1.0.0', 'beta@2.0.0'])
    })
  })

  test('a second boot seeds nothing', async () => {
    await withDataDir(async (dir) => {
      const packs = await packsIn(dir)
      const first = fakeRuntime()
      await seedEmbeddedPacks({ runtime: first.runtime, packs, dataDir: dir, log: silent })

      const second = fakeRuntime()
      await seedEmbeddedPacks({ runtime: second.runtime, packs, dataDir: dir, log: silent })
      expect(second.staged).toEqual([])
    })
  })

  test('a pack the operator removed is NOT resurrected', async () => {
    await withDataDir(async (dir) => {
      const packs = await packsIn(dir)
      const { runtime, rows } = fakeRuntime()
      await seedEmbeddedPacks({ runtime, packs, dataDir: dir, log: silent })

      // The operator deletes beta; its row is gone but the marker remains.
      rows.delete('beta@2.0.0')
      const after = fakeRuntime()
      await seedEmbeddedPacks({ runtime: after.runtime, packs, dataDir: dir, log: silent })
      expect(after.staged).toEqual([])
    })
  })

  test('a new version of an already-seeded pack IS seeded', async () => {
    await withDataDir(async (dir) => {
      const packs = await packsIn(dir)
      await seedEmbeddedPacks({ runtime: fakeRuntime().runtime, packs, dataDir: dir, log: silent })

      const upgraded = packs.map((p) => (p.name === 'alpha' ? { ...p, version: '1.1.0' } : p))
      const next = fakeRuntime()
      await seedEmbeddedPacks({ runtime: next.runtime, packs: upgraded, dataDir: dir, log: silent })
      expect(next.staged).toEqual(['alpha@1.1.0'])
    })
  })

  test('a pack that fails verification is recorded, not retried every boot', async () => {
    await withDataDir(async (dir) => {
      const packs = await packsIn(dir)
      await seedEmbeddedPacks({ runtime: fakeRuntime({ failVerify: true }).runtime, packs, dataDir: dir, log: silent })

      const second = fakeRuntime({ failVerify: true })
      await seedEmbeddedPacks({ runtime: second.runtime, packs, dataDir: dir, log: silent })
      expect(second.staged).toEqual([])
    })
  })

  /**
   * Plan 111 step 111.7. An embedded pack used to be one `.mjs`, which was
   * true while every shipped pack was tier A. Proxy Manager's screen is a
   * React module now, so a pack seeded WITHOUT its `ui/` payload has a `react`
   * view whose script 404s — an error panel on a fresh install, for a pack the
   * release itself put there and the operator never chose.
   */
  test('a tier-C pack’s ui/ payload reaches stage(), with the package-relative name intact', async () => {
    await withDataDir(async (dir) => {
      const js = join(dir, 'ui-index.js')
      const css = join(dir, 'ui-index.css')
      await Bun.write(js, 'window.__enkaku__.register("main", () => null)')
      await Bun.write(css, '.pm{color:red}')
      const packs: EmbeddedPack[] = [
        {
          name: 'alpha',
          version: '1.0.0',
          path: join(dir, 'a.mjs'),
          // `name` is what the package calls the asset (`react.entry` names
          // it); `path` is where the embedded bytes are.
          ui: [
            { name: 'index.js', path: js },
            { name: 'index.css', path: css },
          ],
        },
      ]
      await Bun.write(join(dir, 'a.mjs'), 'export default { id: "alpha" }')

      const { runtime, stagedUi } = fakeRuntime()
      await seedEmbeddedPacks({ runtime, packs, dataDir: dir, log: silent })

      expect(stagedUi.get('alpha@1.0.0')).toEqual([
        { path: 'index.js', text: 'window.__enkaku__.register("main", () => null)' },
        { path: 'index.css', text: '.pm{color:red}' },
      ])
    })
  })

  test('a pack with no ui/ stages exactly as it always did', async () => {
    await withDataDir(async (dir) => {
      const { runtime, stagedUi } = fakeRuntime()
      await seedEmbeddedPacks({ runtime, packs: await packsIn(dir), dataDir: dir, log: silent })
      expect(stagedUi.get('alpha@1.0.0')).toEqual([])
    })
  })

  test('an unreadable bundle does not stop the packs after it', async () => {
    await withDataDir(async (dir) => {
      const packs = await packsIn(dir)
      const broken = [{ name: 'gone', version: '0.1.0', path: join(dir, 'missing.mjs') }, ...packs]
      const { runtime, staged } = fakeRuntime()
      await seedEmbeddedPacks({ runtime, packs: broken, dataDir: dir, log: silent })

      expect(staged).toEqual(['alpha@1.0.0', 'beta@2.0.0'])
      // The failure is not recorded, so a fixed build retries it next boot.
      expect(await Bun.file(join(dir, 'seeded-packs.json')).json()).not.toContain('gone@0.1.0')
    })
  })
})
