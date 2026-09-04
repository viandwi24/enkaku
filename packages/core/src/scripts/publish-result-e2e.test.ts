import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { openDb, runMigrations, type Db } from '../db'
import { devices, plugins, scripts } from '../db/schema'
import { createJobStore, rowToJobDetail } from '../queue/job-store'
import { recordResult } from '../jobs/result-store'
import { getScriptDetail } from './service'

/**
 * Plan 97 §4.4, §4.7, updated by plan 210 (the per-script publish route is
 * removed: a member row is written only by `plugins/runtime.ts`'s
 * `writeScriptRows`, so this test seeds the row itself rather than through
 * the deleted `POST /api/scripts`) — proves the STORAGE half: a `resultSchema` a plugin member
 * declares is the schema a job detail reads back tomorrow, pinned to the
 * version that actually ran.
 *
 *   1. seed a plugin member row declaring a `result` schema,
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
 * `child-entry.test.ts` for H2's own claims).
 */
describe('plan 97 §4.4, §4.7 — a declared result schema survives seed → settle → GET /api/jobs/:id', () => {
  function setUp(): Db {
    const opened = openDb(':memory:')
    runMigrations(opened.db)
    return opened.db
  }

  test('a plugin member declaring a result; a matching job settles resultStatus: valid with a non-null resultSchema on the pinned row', async () => {
    const db = setUp()
    db.insert(devices).values({ id: 'dev-1', stableId: 'stable-1', serial: 'serial-1', label: 'device 1', status: 'online' }).run()

    // The author's own Zod schema (never sent over the wire itself — only
    // its `io: 'output'` JSON Schema is, exactly as `sdk/src/cli/publish.ts`
    // does at the real publish path).
    const resultSchema = z.object({
      videos: z.number().int(),
      watchSeconds: z.number().int(),
    })
    const resultJsonSchema = z.toJSONSchema(resultSchema, { io: 'output' })

    db.insert(plugins)
      .values({
        id: 'p-fixture',
        name: 'demo',
        version: '1.0.0',
        title: null,
        description: null,
        bundle: 'export {}',
        source: null,
        bundleHash: 'deadbeef',
        status: 'active',
        verifiedAt: new Date(),
        verifyError: null,
        verifyErrorCode: null,
        manifest: { scripts: [{ id: 'auto-scroll-e2e' }] },
        resetPackages: null,
        createdBy: null,
        createdAt: new Date(),
      })
      .run()

    const scriptId = 'demo-auto-scroll-e2e-1.0.0'
    db.insert(scripts)
      .values({
        id: scriptId,
        name: 'demo/auto-scroll-e2e',
        version: '1.0.0',
        bundle: 'export default { id: "auto-scroll-e2e" }',
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
        resultSchema: resultJsonSchema,
        enabled: true,
        createdAt: new Date(),
        pluginId: 'p-fixture',
        exportId: 'auto-scroll-e2e',
      })
      .run()

    // The storage half, in isolation: the seeded schema reads back exactly
    // as it was written, non-null.
    const detail = getScriptDetail(db, scriptId)
    expect(detail?.resultSchema).not.toBeNull()
    expect(detail?.resultSchema).toEqual(resultJsonSchema)

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

  // Plan 210: `POST /api/scripts` (the per-script publish route this test's
  // own hostile-schema case exercised) is gone. `checkDeclaredSchema`'s hostile-
  // schema refusal is still exercised where it still runs — the plugin
  // verify child (`plugins/verify-child.ts`) and `POST /api/workflows`
  // (`api/workflows.test.ts`).
})
