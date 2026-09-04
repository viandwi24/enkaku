import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `createWorkflowRoutes` (`workflows.ts`, plan 99 §4.5, §4.9, §5 step 99.6)
 * is a pure function of its deps — fully covered by this package's own unit
 * tests. What it can never prove on its own is that `daemon.ts`'s ONE real
 * `createApp({...})` call actually constructs a real instance and passes it
 * as `workflowRoutes`. `daemon.ts` was held by a concurrent worker for the
 * whole of this step (`packages/protocol/src/workflow-check.ts`,
 * `packages/core/src/api/workflows.ts`, `packages/core/src/server/http.ts`,
 * `packages/core/src/scripts/routes.ts` were not), so `HttpDeps.workflowRoutes`
 * was made OPTIONAL (`server/http.ts`'s own doc comment on that field) rather
 * than reaching for a file this step does not own — exactly the pattern
 * `docs/plans/96-m61-hotfixes.md` records three workers using successfully
 * on 2026-08-13 for the identical class of problem (a mechanism proven
 * correct in isolation, never reaching its one production call site).
 *
 * This test is the self-detecting half of that pattern, in the style
 * `packages/core/src/daemon-wiring.test.ts` and
 * `packages/core/src/tools/adb-server-control.test.ts` already established
 * for "a rule about ONE production file's actual text, not about a
 * mechanism": it reads the real `daemon.ts` source and fails, by name, for
 * as long as the wiring below is missing. A NEW file rather than an
 * addition to the shared `daemon-wiring.test.ts` — that file was being
 * edited by other concurrent workers throughout this step, and a fresh file
 * carries the same "read the real file" guarantee with zero merge risk
 * against them.
 *
 * The exact two-line fix, verbatim (see this step's own report for the
 * same text):
 *
 *   import { createWorkflowRoutes } from './api/workflows'
 *
 * and, inside the `createApp({ ... })` call, beside `scriptRoutes:`:
 *
 *   workflowRoutes: createWorkflowRoutes({ db, registry: scriptRegistry, audit }),
 */

const daemonSource = readFileSync(join(import.meta.dir, '..', 'daemon.ts'), 'utf8')

/** Extracts the balanced-brace call `name({ ... })` starting at `name({` — same helper `daemon-wiring.test.ts` uses, duplicated rather than imported since that file is not in this step's ownership and importing a `.test.ts` helper across files is not a pattern this codebase uses elsewhere. */
function extractCall(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`daemon.ts no longer contains ${JSON.stringify(marker)} — this test needs updating alongside that change`)
  const openBrace = start + marker.length - 1
  expect(source[openBrace]).toBe('{')
  let depth = 0
  let i = openBrace
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(openBrace, i + 1)
}

describe('daemon.ts wiring — /api/workflows (plan 99 §4.5, §4.9, §5 step 99.6)', () => {
  test('daemon.ts imports createWorkflowRoutes from ./api/workflows', () => {
    expect(daemonSource).toContain("import { createWorkflowRoutes } from './api/workflows'")
  })

  test("createApp({...}) passes a real workflowRoutes — without it, POST /api/workflows 404s through http.ts's catch-all forever", () => {
    const call = extractCall(daemonSource, 'const app = createApp({')
    expect(call).toContain('workflowRoutes:')
    expect(call).toContain('createWorkflowRoutes(')
    // `registry: scriptRegistry` — not a fresh instance, not `undefined` —
    // the SAME registry `scriptRoutes`/`pluginRoutes`/every other resolver
    // in this file already shares (F17: one door).
    expect(call).toContain('registry: scriptRegistry')
    // Plan 210 §4.4, §4.5 — `store: workflowStore`, the one instance
    // `createWorkflowStore(db)` builds beside `scriptRegistry`.
    expect(call).toContain('store: workflowStore')
  })
})
