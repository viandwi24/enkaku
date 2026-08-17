import { afterEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { JobNodesResponseSchema, type WorkflowDoc } from '@enkaku/protocol'
import { BadResponseError } from './actions'
import { estimateWorkflowDuration, fetchAllPages } from './api'

/**
 * `fetchAllPages`'s optional parser (plan 95 §5 step 95.5, fixes F8): an
 * author-controlled `paramsSchema` (F7) used to reach a caller like
 * `RunScriptDialog`'s `ScriptRow` through a bare `as` cast with nothing
 * checking its shape. Passing a Zod schema as the third argument now
 * validates every item instead.
 */
describe('fetchAllPages — no parser (unchanged behaviour)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns items across pages, un-validated, exactly as before', async () => {
    let call = 0
    globalThis.fetch = mock(async () => {
      call++
      const body = call === 1 ? { items: [{ id: 'a' }], nextCursor: 'c1' } : { items: [{ id: 'b' }], nextCursor: null }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const items = await fetchAllPages<{ id: string }>('/api/whatever')
    expect(items).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})

describe('fetchAllPages — with a parser', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const RowSchema = z.object({ id: z.string(), n: z.number() })

  function stub(items: unknown[]): void {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ items, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  }

  test('valid items parse through and are returned typed', async () => {
    stub([{ id: 'a', n: 1 }, { id: 'b', n: 2 }])
    const items = await fetchAllPages('/api/rows', undefined, RowSchema)
    expect(items).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 2 }])
  })

  test('an item that fails the schema throws BadResponseError — not silently skipped', async () => {
    stub([{ id: 'a', n: 1 }, { id: 'b', n: 'not-a-number' }])
    await expect(fetchAllPages('/api/rows', undefined, RowSchema)).rejects.toBeInstanceOf(BadResponseError)
  })

  test('validation runs across every page, not just the first', async () => {
    let call = 0
    globalThis.fetch = mock(async () => {
      call++
      const body = call === 1 ? { items: [{ id: 'a', n: 1 }], nextCursor: 'c1' } : { items: [{ id: 'b', n: 'bad' }], nextCursor: null }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    await expect(fetchAllPages('/api/rows', undefined, RowSchema)).rejects.toBeInstanceOf(BadResponseError)
  })
})

/**
 * `JobNodesResponseSchema` as it resolves THROUGH the `@enkaku/protocol`
 * barrel (plan 99 §4.9, step 99.10) — pinned against the real
 * `{ items, finalized }` shape `GET /api/jobs/:id/nodes` returns
 * (`packages/core/src/services/job-service.ts`'s `nodes()`).
 *
 * Imported from the package root, not from a submodule, deliberately: the
 * name was once declared twice inside `@enkaku/protocol` and the barrel
 * resolved it to the wrong, `{ jobId, nodes, finalized }`-shaped one, which
 * would make `api()`'s `safeParse` throw `BadResponseError` on every correct
 * response and silently empty the node timeline. This is the Studio-side
 * guard for that; `packages/protocol/src/export-uniqueness.test.ts` is the
 * package-side one.
 */
describe('JobNodesResponseSchema — the REAL wire shape (plan 99 §4.9, step 99.10)', () => {
  test('parses the real { items, finalized } envelope', () => {
    const body = {
      items: [
        {
          seq: 0,
          nodeId: 'scroll1',
          kind: 'script',
          scriptId: 's1',
          scriptName: 'tiktok/auto-scroll',
          scriptVersion: '1.0.0',
          status: 'success',
          duration: { startedAt: 100, finishedAt: 110, elapsedMs: 10_000 },
          attempts: { current: 1, total: 3, lastError: null },
          output: { value: { videos: 12 }, truncated: null, error: null, verdict: null },
          resumedFromJobId: null,
          resumedFromNode: null,
        },
      ],
      finalized: true,
    }
    const parsed = JobNodesResponseSchema.parse(body)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.finalized).toBe(true)
  })

  test('the once-shadowing { jobId, nodes, finalized } shape does NOT parse — proving the barrel resolves the right schema', () => {
    const removedShape = { jobId: 'job-1', nodes: [], finalized: true }
    expect(JobNodesResponseSchema.safeParse(removedShape).success).toBe(false)
  })
})

describe('estimateWorkflowDuration (plan 99 §3.11, §4.11, step 99.10)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function baseDoc(nodes: WorkflowDoc['nodes']): WorkflowDoc {
    return { schema: 1, name: 'wf', version: '1.0.0', title: '', description: '', params: [], nodes, maxSteps: 50 }
  }

  test('sums resolvable node timeouts, skipping gates (they cost nothing)', async () => {
    const doc = baseDoc([
      { kind: 'script', id: 'a', title: '', script: 'tiktok/auto-scroll@1.0.0', params: {}, onFailure: { go: 'fail' } },
      { kind: 'gate', id: 'g', title: '', when: { left: { const: 1 }, op: 'eq', right: { const: 1 } }, then: { go: 'continue' }, else: { go: 'stop' }, message: '' },
      { kind: 'script', id: 'b', title: '', script: 'tiktok/searched-follow@2.0.0', params: {}, onFailure: { go: 'fail' } },
    ])
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      const u = String(url)
      const timeoutMs = u.includes('id-a') ? 60_000 : u.includes('id-b') ? 120_000 : null
      return new Response(JSON.stringify({ script: { runtime: { timeoutMs } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const resolveScriptId = (ref: string) => (ref.startsWith('tiktok/auto-scroll') ? 'id-a' : ref.startsWith('tiktok/searched-follow') ? 'id-b' : null)
    const est = await estimateWorkflowDuration(doc, resolveScriptId)
    expect(est.nodeCount).toBe(3)
    expect(est.totalMs).toBe(180_000)
    expect(est.unknownNodes).toEqual([])
  })

  test('an unresolvable ref and an undeclared timeout both land in unknownNodes, never silently zero', async () => {
    const doc = baseDoc([
      { kind: 'script', id: 'unresolved', title: '', script: 'ghost/script@9.9.9', params: {}, onFailure: { go: 'fail' } },
      { kind: 'script', id: 'no-timeout', title: '', script: 'tiktok/report@1.0.0', params: {}, onFailure: { go: 'fail' } },
    ])
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ script: { runtime: null } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch

    const resolveScriptId = (ref: string) => (ref.startsWith('tiktok/report') ? 'id-report' : null)
    const est = await estimateWorkflowDuration(doc, resolveScriptId)
    expect(est.totalMs).toBe(0)
    expect(est.unknownNodes.sort()).toEqual(['no-timeout', 'unresolved'])
  })

  test('a fetch failure degrades to unknown rather than throwing', async () => {
    const doc = baseDoc([{ kind: 'script', id: 'a', title: '', script: 'tiktok/x@1.0.0', params: {}, onFailure: { go: 'fail' } }])
    globalThis.fetch = mock(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const est = await estimateWorkflowDuration(doc, () => 'id-a')
    expect(est.unknownNodes).toEqual(['a'])
    expect(est.totalMs).toBe(0)
  })
})
