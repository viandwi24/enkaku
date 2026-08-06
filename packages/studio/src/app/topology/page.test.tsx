import { afterEach, describe, expect, test } from 'bun:test'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import TopologyPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `/topology` (plan 47 §3.6) is a pure redirect into the fleet page's wall
 * view — it calls no `api<T>()` of its own (`lib/api.ts`'s `fetchTopology`
 * is a separate, out-of-scope pattern this plan does not migrate). The
 * smoke render plan 72 §4.5 still requires: mount it and confirm it
 * redirects rather than throwing.
 */
describe('TopologyPage — smoke render (redirect shim, no data-fetching of its own)', () => {
  test('replaces into the fleet wall view', () => {
    expect(() => renderWithApi(<TopologyPage />, {})).not.toThrow()
    expect(mockRouter.replace).toHaveBeenCalledWith('/?view=wall&group=cluster')
  })
})
