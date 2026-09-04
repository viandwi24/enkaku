import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_EXAMPLE_PATH = join(import.meta.dir, '../../../../.env.example')
const CONSTANTS_SOURCE_PATH = join(import.meta.dir, 'constants.ts')

describe('packages/core/src/config/constants.ts (plan 212 §212.2)', () => {
  test('every override name appears in .env.example', () => {
    const source = readFileSync(CONSTANTS_SOURCE_PATH, 'utf8')
    const envExample = readFileSync(ENV_EXAMPLE_PATH, 'utf8')
    const names = new Set([...source.matchAll(/'(ENKAKU_[A-Z0-9_]+)'/g)].map((m) => m[1]))
    expect(names.size).toBeGreaterThan(0)
    const missing: string[] = []
    for (const name of names) {
      if (!envExample.includes(name)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  test('an out-of-range override throws E_BAD_CONFIG', async () => {
    process.env.ENKAKU_ADB_TCP_PORT = '70000'
    try {
      let threw: unknown
      try {
        await import(`./constants.ts?bust=${Math.random()}`)
      } catch (err) {
        threw = err
      }
      expect(threw).toBeDefined()
      const { EnkakuError } = await import('../util/errors')
      expect(threw).toBeInstanceOf(EnkakuError)
      expect((threw as InstanceType<typeof EnkakuError>).code).toBe('E_BAD_CONFIG')
      expect((threw as InstanceType<typeof EnkakuError>).message).toContain('ENKAKU_ADB_TCP_PORT')
    } finally {
      delete process.env.ENKAKU_ADB_TCP_PORT
    }
  })

  test('an applied override is reported', async () => {
    process.env.ENKAKU_WALL_DECODE_TILE_CEILING = '32'
    try {
      const mod = await import(`./constants.ts?bust=${Math.random()}`)
      expect(mod.WALL_DECODE_TILE_CEILING).toBe(32)
      expect(mod.appliedSupportOverrides().get('ENKAKU_WALL_DECODE_TILE_CEILING')).toBe('32')
    } finally {
      delete process.env.ENKAKU_WALL_DECODE_TILE_CEILING
    }
  })
})
