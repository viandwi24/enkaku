import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { createJobStore, rowToJobDetail } from '../queue/job-store'
import { recordResult } from '../jobs/result-store'
import { createScriptRoutes } from './routes'

/**
 * Plan 97 §4.4, §4.7 — closes the gap the plan's own `> Status:` line named:
 * "three correct steps that have not met" (97.2's `ScriptDefinition<S, R>`,
 * 97.5's read paths, 97.6's `ResultView`) because `scripts.result_schema`
 * did not exist as a column. This test is the proof they finally do:
 *
 *   1. publish a script that DECLARES a `result` schema (`POST /api/scripts`,
 *      through the exact `checkDeclaredSchema` gate a params schema gets),
 *   2. settle a job for it with a value that matches that schema (mirroring
 *      exactly what `child-entry.ts`'s `buildResultOutcome` computes — a real
 *      `safeParse` against the real Zod schema, then `result-store.ts`'s own
 *      `recordResult`, the single function `executor-host.ts`'s settle seam
 *      calls in production — imported here rather than re-implemented),
 *   3. read the job back the same way `GET /api/jobs/:id` does
 *      (`rowToJobDetail`, fed by `scriptNames()`'s own `scripts.result_schema`
 *      selection) and assert `resultSchema` is non-null and the verdict is
 *      `valid`.
 *
 * This does not spawn a real child process (that lives in
 * `packages/session/src/runner/**`, already end-to-end tested by
 * `child-entry.test.ts` for H2's own claims) — it proves the STORAGE half:
 * that a schema published today is the schema a job detail reads back
 * tomorrow, pinned to the version that actually ran.
 */
describe('plan 97 §4.4, §4.7 — a declared result schema survives publish → settle → GET /api/jobs/:id', () => {
  function setUp(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  function withAdmin(inner: Hono<AuthEnv>): Hono<AuthEnv> {
    const wrapper = new Hono<AuthEnv>()
    wrapper.use('*', async (c, next) => {
      c.set('user', { id: 'u1', email: 'u@test', role: 'admin' })
      await next()
    })
    wrapper.route('/', inner)
    return wrapper
  }

  test('publish declares a result; a matching job settles resultStatus: valid with a non-null resultSchema on the pinned row', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'dev-1', stableId: 'stable-1', serial: 'serial-1', label: 'device 1', status: 'idle' }).run()

    // The author's own Zod schema (never sent over the wire itself — only
    // its `io: 'output'` JSON Schema is, exactly as `sdk/src/cli/publish.ts`
    // does at the real publish path).
    const resultSchema = z.object({
      videos: z.number().int(),
      watchSeconds: z.number().int(),
    })
    const resultJsonSchema = z.toJSONSchema(resultSchema, { io: 'output' })

    const app = withAdmin(createScriptRoutes({ db }))
    const publishRes = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'auto-scroll-e2e',
        version: '1.0.0',
        bundle: 'export default { id: "auto-scroll-e2e" }',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
        resultSchema: resultJsonSchema,
      }),
    })
    expect(publishRes.status).toBe(201)
    const published = (await publishRes.json()) as { script: { id: string } }
    const scriptId = published.script.id

    // `GET /:id` — the storage half, in isolation: the published schema
    // reads back exactly as it was sent, non-null.
    const getRes = await app.request(`/${scriptId}`)
    const detail = (await getRes.json()) as { script: { resultSchema: unknown } }
    expect(detail.script.resultSchema).not.toBeNull()
    expect(detail.script.resultSchema).toEqual(resultJsonSchema)

    // "Run it": a value that matches the declared schema, checked the same
    // way the child does (real Zod `safeParse`, never the JSON Schema —
    // F25/F26), then handed to the SAME `recordResult` production uses.
    const value = { videos: 312, watchSeconds: 2520 }
    const parsed = resultSchema.safeParse(value)
    expect(parsed.success).toBe(true)
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length
    const recorded = recordResult({
      value,
      outcome: { status: 'valid', bytes },
      summary: [],
      maxResultBytes: 65_536,
    })
    expect(recorded).not.toBeNull()
    if (!recorded) throw new Error('unreachable')
    expect(recorded.resultStatus).toBe('valid')

    const jobStore = createJobStore(db)
    const job = jobStore.enqueue({ scriptId, deviceId: 'dev-1', params: {}, priority: 0 })
    // `finish()` only settles a `running` row (its own `WHERE status =
    // 'running'` — a freshly enqueued job is `queued`) — `claimNext` is the
    // real path that gets it there, the same one the daemon's dispatch loop
    // uses before a child ever runs.
    const claimed = jobStore.claimNext(300)
    expect(claimed?.job.id).toBe(job.id)
    jobStore.finish(job.id, 'success', {
      result: recorded.result,
      resultStatus: recorded.resultStatus,
      resultBytes: recorded.resultBytes,
      resultSummary: recorded.resultSummary,
      resultIssues: recorded.resultIssues,
    })

    const settled = jobStore.get(job.id)
    expect(settled).not.toBeNull()
    if (!settled) throw new Error('unreachable')

    // The exact lookup `services/job-service.ts`'s `get()` performs before
    // calling `rowToJobDetail` — `scriptNames()` now selects
    // `scripts.result_schema` alongside `name`/`version` (plan 97 §4.4).
    const script = jobStore.scriptNames([settled.scriptId]).get(settled.scriptId)
    const jobDetail = rowToJobDetail(settled, script)

    // The proof this test exists for: 97.2, 97.5 and 97.6 have finally met.
    expect(jobDetail.resultStatus).toBe('valid')
    expect(jobDetail.resultSchema).not.toBeNull()
    expect(jobDetail.resultSchema).toEqual(resultJsonSchema)
    expect(jobDetail.result).toEqual(value)
  })

  test('publishing a result schema that violates the published limits is refused, naming E_RESULT_SCHEMA_INVALID, before it ever reaches storage', async () => {
    const db = setUp()
    const app = withAdmin(createScriptRoutes({ db }))
    // A `__proto__` field name is one of K7's hostile fixtures, reused here
    // for the result half of the same gate a params schema already has —
    // built with `JSON.parse`, never an object literal: `{__proto__: x}` as
    // a literal sets the object's OWN prototype rather than an enumerable
    // key, which `checkDeclaredSchema`'s walk (and `JSON.stringify` itself)
    // would then never see (`schema-form/resolve.test.ts` documents the
    // identical hazard one layer up).
    const hostileResultSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}',
    )
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'hostile-result-e2e',
        version: '1.0.0',
        bundle: 'export default {}',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
        resultSchema: hostileResultSchema,
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RESULT_SCHEMA_INVALID')
  })
})
