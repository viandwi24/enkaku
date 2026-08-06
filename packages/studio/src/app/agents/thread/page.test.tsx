import { afterEach, describe, expect, test } from 'bun:test'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import ThreadPage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `/agents/thread` (plan 69 §status note) is now just a redirect shim into
 * the workbench — it calls no `api<T>()` of its own, so there is nothing to
 * migrate here. This is the smoke render plan 72 §4.5 still requires: mount
 * it, and confirm it redirects rather than throwing.
 */
describe('ThreadPage — smoke render (redirect shim, no data-fetching of its own)', () => {
  test('with an agentId: replaces into the workbench route', () => {
    setSearchParams({ agentId: 'agent-1', id: 'thread-1' })
    expect(() => renderWithApi(<ThreadPage />, {})).not.toThrow()
    expect(mockRouter.replace).toHaveBeenCalledWith('/agents/detail?id=agent-1&thread=thread-1')
  })

  test('without an agentId: replaces back to the agents list', () => {
    setSearchParams({})
    expect(() => renderWithApi(<ThreadPage />, {})).not.toThrow()
    expect(mockRouter.replace).toHaveBeenCalledWith('/agents')
  })
})
