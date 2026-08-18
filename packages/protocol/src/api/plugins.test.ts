import { describe, expect, test } from 'bun:test'
import {
  classifyPluginVersionRemoval,
  comparePluginVersions,
  PLUGIN_VERSION_KEEP_ACTIVE,
  PLUGIN_VERSION_KEEP_DISABLED,
  PLUGIN_VERSION_KEEP_LATEST,
  PLUGIN_VERSION_KEEP_UNRECOGNISED,
  PLUGIN_VERSION_KEEP_VERIFYING,
  PluginBulkRemoveBodySchema,
  PluginBulkRemoveResponseSchema,
  planPluginVersionRemoval,
  type PluginVersionCandidate,
} from './plugins'

/**
 * The shared half of bulk plugin-version removal. Everything here is called by
 * BOTH sides — the core plans a deletion with it, Studio writes its confirm
 * dialog with it — so a failure in this file is a promise the dialog makes that
 * the server does not keep, which is the specific failure the shared rule exists
 * to make impossible.
 */

const row = (version: string, status: string, id = version): PluginVersionCandidate => ({ id, version, status })

describe('comparePluginVersions', () => {
  test('orders by numeric core, not lexically', () => {
    // The whole reason a comparator exists: string order puts 1.10.0 before
    // 1.9.0, and "latest" would then keep the wrong row.
    expect(comparePluginVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(comparePluginVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(comparePluginVersions('1.2.3', '1.2.3')).toBe(0)
  })

  test('a prerelease sorts below the release it precedes (semver §11.3)', () => {
    expect(comparePluginVersions('1.2.0-rc.1', '1.2.0')).toBe(-1)
    expect(comparePluginVersions('1.2.0-rc.1', '1.2.0-rc.2')).toBe(-1)
  })

  test('build metadata is ignored, so two rows differing only by it compare equal', () => {
    expect(comparePluginVersions('1.2.0+dev.3', '1.2.0')).toBe(0)
  })

  test('a version that does not parse sorts BELOW every one that does', () => {
    // Fails in the safe direction: an unreadable row must never be mistaken for
    // the newest one, because the newest one is the row that gets kept.
    expect(comparePluginVersions('not-a-version', '0.0.1')).toBe(-1)
    expect(comparePluginVersions('0.0.1', 'not-a-version')).toBe(1)
  })
})

describe('planPluginVersionRemoval — scope "all"', () => {
  test('takes every version, including the active one, oldest first', () => {
    const rows = [row('1.0.0', 'superseded'), row('2.0.0', 'active'), row('1.5.0', 'failed')]
    const plan = planPluginVersionRemoval(rows, 'all')
    expect(plan.keep).toEqual([])
    expect(plan.remove.map((r) => r.version)).toEqual(['1.0.0', '1.5.0', '2.0.0'])
  })
})

describe('planPluginVersionRemoval — scope "except-latest"', () => {
  test('keeps the newest and takes the rest', () => {
    const rows = [row('1.0.0', 'superseded'), row('1.1.0', 'superseded'), row('1.2.0', 'active')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove.map((r) => r.version)).toEqual(['1.0.0', '1.1.0'])
    // 1.2.0 is BOTH newest and active; the more specific reason wins, because
    // "this one is live" is what an operator pruning history needs to hear.
    expect(plan.keep.map((k) => [k.candidate.version, k.code])).toEqual([['1.2.0', PLUGIN_VERSION_KEEP_ACTIVE]])
  })

  /**
   * The trap this whole design exists for. After a rollback the ACTIVE version
   * is older than the LATEST one, and a naive "keep the newest" prune would
   * delete the row the farm is currently running.
   */
  test('when a rollback has left an older version active, it keeps BOTH that row and the newest', () => {
    const rows = [row('1.0.0', 'superseded'), row('1.1.0', 'active'), row('1.2.0', 'superseded'), row('1.3.0', 'superseded')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove.map((r) => r.version)).toEqual(['1.0.0', '1.2.0'])
    expect(plan.keep.map((k) => [k.candidate.version, k.code])).toEqual([
      ['1.1.0', PLUGIN_VERSION_KEEP_ACTIVE],
      ['1.3.0', PLUGIN_VERSION_KEEP_LATEST],
    ])
    // Named, so the dialog can say WHY each survivor survived.
    expect(plan.keep.find((k) => k.candidate.version === '1.1.0')!.message).toContain('running')
  })

  test('keeps a disabled row — it is the only version POST /:name/enable can reach', () => {
    const rows = [row('1.0.0', 'disabled'), row('1.1.0', 'superseded'), row('1.2.0', 'superseded')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove.map((r) => r.version)).toEqual(['1.1.0'])
    expect(plan.keep.map((k) => k.code).sort()).toEqual([PLUGIN_VERSION_KEEP_DISABLED, PLUGIN_VERSION_KEEP_LATEST].sort())
  })

  test('keeps a row that is mid-verify', () => {
    const rows = [row('1.0.0', 'verifying'), row('1.1.0', 'superseded'), row('1.2.0', 'active')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove.map((r) => r.version)).toEqual(['1.1.0'])
    expect(plan.keep.map((k) => k.code)).toContain(PLUGIN_VERSION_KEEP_VERIFYING)
  })

  /**
   * `plugins.status` is a plain `text` column, so the allowlist — not a denylist
   * of statuses to protect — is what keeps an unreadable row out of the delete
   * list. The failure mode this refuses is silent and permanent.
   */
  test('keeps a status this build does not recognise, and says so', () => {
    const rows = [row('1.0.0', 'quarantined'), row('1.1.0', 'superseded'), row('1.2.0', 'active')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove.map((r) => r.version)).toEqual(['1.1.0'])
    const kept = plan.keep.find((k) => k.candidate.version === '1.0.0')!
    expect(kept.code).toBe(PLUGIN_VERSION_KEEP_UNRECOGNISED)
    expect(kept.message).toContain('quarantined')
  })

  test('a plugin whose only version is live has nothing to prune — and no keep is silently dropped', () => {
    const rows = [row('1.0.0', 'active')]
    const plan = planPluginVersionRemoval(rows, 'except-latest')
    expect(plan.remove).toEqual([])
    expect(plan.keep).toHaveLength(1)
  })

  test('every candidate appears exactly once across remove and keep, in both scopes', () => {
    const rows = [row('0.9.0', 'failed'), row('1.0.0', 'superseded'), row('1.1.0', 'disabled'), row('1.2.0', 'staged'), row('1.3.0', 'superseded')]
    for (const scope of ['all', 'except-latest'] as const) {
      const plan = planPluginVersionRemoval(rows, scope)
      const seen = [...plan.remove.map((r) => r.id), ...plan.keep.map((k) => k.candidate.id)].sort()
      expect(seen).toEqual(rows.map((r) => r.id).sort())
    }
  })

  test('the plan is stable when two rows carry version strings the comparator reads as equal', () => {
    const rows = [row('1.0.0+dev.1', 'superseded', 'b'), row('1.0.0', 'superseded', 'a')]
    const first = planPluginVersionRemoval(rows, 'except-latest')
    const second = planPluginVersionRemoval([...rows].reverse(), 'except-latest')
    expect(first.remove.map((r) => r.id)).toEqual(second.remove.map((r) => r.id))
    expect(first.keep.map((k) => k.candidate.id)).toEqual(second.keep.map((k) => k.candidate.id))
  })
})

describe('the bulk report envelope', () => {
  test('classifies the three outcomes, skip before error', () => {
    const base = { id: 'x', version: '1.0.0', status: 'superseded', kvDeleted: 0 }
    expect(classifyPluginVersionRemoval({ ...base, skip: null, error: null })).toBe('removed')
    expect(classifyPluginVersionRemoval({ ...base, skip: { code: 'plugin_kept_latest', message: 'm' }, error: null })).toBe('kept')
    expect(classifyPluginVersionRemoval({ ...base, skip: null, error: { code: 'script_in_use', message: 'm' } })).toBe('failed')
  })

  test('a partial success parses, and results.length equals total — a kept row is a result, never an omission', () => {
    const body = {
      plugin: 'tiktok',
      scope: 'except-latest',
      total: 3,
      webhooksDeleted: 0,
      results: [
        { id: 'a', version: '1.0.0', status: 'superseded', kvDeleted: 0, skip: null, error: null },
        { id: 'b', version: '1.1.0', status: 'superseded', kvDeleted: 0, skip: null, error: { code: 'script_in_use', message: '1 job' } },
        { id: 'c', version: '1.2.0', status: 'active', kvDeleted: 0, skip: { code: 'plugin_kept_active', message: 'live' }, error: null },
      ],
    }
    const parsed = PluginBulkRemoveResponseSchema.parse(body)
    expect(parsed.results).toHaveLength(parsed.total)
    expect(parsed.results.map(classifyPluginVersionRemoval)).toEqual(['removed', 'failed', 'kept'])
  })

  test('the body refuses a scope it does not define', () => {
    expect(PluginBulkRemoveBodySchema.safeParse({ scope: 'all' }).success).toBe(true)
    expect(PluginBulkRemoveBodySchema.safeParse({ scope: 'except-latest', deleteKv: true }).success).toBe(true)
    expect(PluginBulkRemoveBodySchema.safeParse({ scope: 'everything' }).success).toBe(false)
    expect(PluginBulkRemoveBodySchema.safeParse({}).success).toBe(false)
  })
})
