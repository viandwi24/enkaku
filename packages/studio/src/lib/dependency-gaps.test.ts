import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plan 93 §5, step 93.11's own brief: two of this step's Studio surfaces
 * (`ArtifactPicker`'s "choose existing" tab, and `app/batches/detail/page.tsx`'s
 * collected-files table + "Download all") depend on step 93.10 — a
 * concurrently-running step this file's package does not own
 * (`packages/core/src/api/batches.ts`, `packages/core/src/api/artifacts.ts`).
 * At the time 93.11 was built, per 93.12's own status paragraph checked
 * directly against the tree: `GET /api/batches/:id/artifacts` and
 * `.../artifacts.zip` did not exist, and `GET /api/artifacts` had no
 * `?kind=upload`.
 *
 * Rather than silently stub around the gap, this file makes it
 * self-detecting — reading the real source text (never importing either
 * module: `packages/core` is out of this step's file ownership, and an
 * import would risk a build-time coupling this step must not create) so a
 * failing assertion here can only ever mean "the dependency has not landed
 * yet", exactly the "self-detecting, not self-breaking" shape
 * `saved-commands-mount.test.ts` / `workflows-wiring.test.ts` already
 * established for the identical situation on the core side.
 *
 * **Resolved before this step finished**: 93.10 landed all three (route
 * registrations plus `?kind=upload`) later in the same session, and every
 * test below now passes for real — kept as a permanent regression guard
 * (not deleted) since a future refactor of either core file could silently
 * rename a route string these Studio surfaces depend on by exact path.
 */

const CORE_SRC = join(import.meta.dir, '..', '..', '..', 'core', 'src')

function readCoreFile(relPath: string): string {
  return readFileSync(join(CORE_SRC, relPath), 'utf8')
}

/**
 * A real ROUTE REGISTRATION, not merely a mention — `batches.ts` already
 * has a doc comment naming `GET /:id/artifacts.zip` (its pre-flight
 * `E_TRANSFER_TOO_LARGE` mapping's own explanation) well before the route
 * itself exists, which would make a plain `.toContain('/:id/artifacts')`
 * check a false pass on the comment alone. Matches `app.get('/:id/artifacts'`
 * (with either quote style), the same shape every other route in this file
 * already uses (see `app.get('/', ...)` / `app.get('/:id', ...)` above it).
 */
function hasRoute(src: string, method: 'get' | 'post', path: string): boolean {
  return src.includes(`app.${method}('${path}'`) || src.includes(`app.${method}("${path}"`)
}

describe('step 93.10 dependency gaps (core files this step does not own)', () => {
  test('GET /api/batches/:id/artifacts exists — used by the collected-files table', () => {
    const src = readCoreFile('api/batches.ts')
    expect(hasRoute(src, 'get', '/:id/artifacts')).toBe(true)
  })

  test('GET /api/batches/:id/artifacts.zip exists — used by "Download all"', () => {
    const src = readCoreFile('api/batches.ts')
    expect(hasRoute(src, 'get', '/:id/artifacts.zip')).toBe(true)
  })

  test('GET /api/artifacts accepts ?kind=upload (F14) — used by ArtifactPicker\'s "choose existing" tab', () => {
    const src = readCoreFile('api/artifacts.ts')
    expect(src.includes("query('kind')") || src.includes('query("kind")')).toBe(true)
  })
})
