import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ScriptsPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

beforeEach(() => {
  mockRouter.replace.mockClear()
})
afterEach(cleanup)

/**
 * `/scripts` is a redirect since the Scripts list was merged into `/plugins`
 * (owner's own ask, 2026-08-17). It fetches nothing of its own, so the smoke
 * render plan 72 §4.5 requires is exactly this: mount it and confirm it
 * redirects rather than throwing — the same shape `/topology` has carried
 * since plan 47 §3.6.
 */
describe('ScriptsPage — redirect into the merged Plugins & scripts screen', () => {
  test('replaces into /plugins', () => {
    setSearchParams({})
    expect(() => renderWithApi(<ScriptsPage />, {})).not.toThrow()
    expect(mockRouter.replace).toHaveBeenCalledWith('/plugins')
  })

  test('carries the query over — `?device=` is what makes the Run flow open its dialog on arrival', () => {
    setSearchParams({ device: 'dev-1' })
    renderWithApi(<ScriptsPage />, {})
    expect(mockRouter.replace).toHaveBeenCalledWith('/plugins?device=dev-1')
  })

  test('carries `?cluster=` over too', () => {
    setSearchParams({ cluster: 'cl-1' })
    renderWithApi(<ScriptsPage />, {})
    expect(mockRouter.replace).toHaveBeenCalledWith('/plugins?cluster=cl-1')
  })
})
