import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptRow } from '../db/schema'
import { materializeBundle, materializeBundleText } from './bundle-cache'

function row(overrides: Partial<ScriptRow>): ScriptRow {
  return {
    id: 'id-1',
    kind: 'script',
    name: 'checkout',
    version: '1.0.0',
    bundle: 'export default { id: "checkout" }',
    source: null,
    paramsSchema: null,
    resultSchema: null,
    runtime: null,
    enabled: true,
    createdBy: null,
    createdAt: null,
    pluginId: null,
    exportId: null,
    ...overrides,
  }
}

const dirs: string[] = []
function tmpDataDir(): string {
  const dir = join('/tmp', `enkaku-bundle-cache-test-${crypto.randomUUID()}`)
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('materializeBundle — content-addressed (plan 82 §4.5)', () => {
  test('the same bundle bytes produce the same file regardless of script id/version', async () => {
    const dataDir = tmpDataDir()
    const bundle = 'export default { id: "shared-plugin-bundle" }'
    const paths = await Promise.all(
      Array.from({ length: 20 }, (_, i) => row({ id: `script-${i}`, version: `1.0.${i}`, bundle })).map((r) =>
        materializeBundle(dataDir, r),
      ),
    )
    const unique = new Set(paths)
    expect(unique.size).toBe(1) // criterion 4 — one file, not twenty

    const files = readdirSync(join(dataDir, 'cache', 'bundles'))
    expect(files).toHaveLength(1)
  })

  test('different bundle bytes produce different files', async () => {
    const dataDir = tmpDataDir()
    const pathA = await materializeBundle(dataDir, row({ bundle: 'export default { id: "a" }' }))
    const pathB = await materializeBundle(dataDir, row({ bundle: 'export default { id: "b" }' }))
    expect(pathA).not.toBe(pathB)
  })

  test('the file is actually readable and holds the exact bundle text', async () => {
    const dataDir = tmpDataDir()
    const bundle = 'export default { id: "checkout" }'
    const path = await materializeBundle(dataDir, row({ bundle }))
    expect(await Bun.file(path).text()).toBe(bundle)
  })

  test('a dev slot build (materializeBundleText) lands in the SAME cache and file shape as a published one', async () => {
    const dataDir = tmpDataDir()
    const bundle = 'export default { id: "same-bytes" }'
    const published = await materializeBundle(dataDir, row({ bundle }))
    const dev = await materializeBundleText(dataDir, bundle)
    expect(dev).toBe(published)
  })
})
