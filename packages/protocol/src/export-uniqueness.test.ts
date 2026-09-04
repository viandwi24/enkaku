import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * No two modules in this package may export the same NAME.
 *
 * This is not style policing — it is a correctness guard, paid for once
 * already. `JobNodesResponseSchema` was declared twice with DIFFERENT shapes
 * (`messages/job.ts`'s `{ jobId, nodes, finalized }` and `api/jobs.ts`'s
 * `{ items, finalized }`), and because `index.ts` re-exports `./messages/job`
 * by explicit name while `./api` arrives through `export * from './api'`, the
 * explicit re-export silently SHADOWED the star one: every
 * `import { JobNodesResponseSchema } from '@enkaku/protocol'` in the workspace
 * got the wrong schema. TypeScript reports nothing for that — a star export
 * losing to a named one is legal — so the only visible symptoms were a
 * typecheck failure inside `packages/core`'s route and a Studio caller that
 * gave up and redeclared the schema locally rather than importing it. A
 * validated response parsed against the shadowed schema fails at RUNTIME, in
 * production, with a body that is perfectly correct.
 *
 * The check is deliberately name-only and file-pair-based: two files, one
 * name, fail — regardless of whether the shapes happen to agree today, since
 * two declarations that agree now are exactly the pair that silently diverges
 * later.
 */

const SRC = import.meta.dir

/**
 * Names allowed to appear in more than one module, each with the reason it
 * cannot be collapsed. Empty on purpose: every duplicate found when this
 * guard was written was a genuine bug and was removed in the same change.
 * Adding an entry here is a claim that two modules MUST own the same name —
 * write the reason next to it, or fix the duplicate instead.
 */
const ALLOWED_DUPLICATES: Record<string, string> = {}

/** Every `.ts` source file in the package, tests and barrels excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && entry !== 'index.ts') out.push(full)
  }
  return out
}

/**
 * Top-level `export <keyword> <Name>` declarations. Re-export lists
 * (`export { A } from './b'`) are deliberately NOT collected: they name a
 * declaration that already lives somewhere else, and counting them would flag
 * every barrel as a duplicate of the module it forwards.
 */
const DECLARATION = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

function declaredExports(source: string): string[] {
  return [...source.matchAll(DECLARATION)].map((m) => m[1] as string)
}

describe('exported names are unique across the package', () => {
  test('no name is declared by two modules', () => {
    const owners = new Map<string, Set<string>>()
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file)
      for (const name of declaredExports(readFileSync(file, 'utf8'))) {
        const set = owners.get(name) ?? new Set<string>()
        set.add(rel)
        owners.set(name, set)
      }
    }

    const collisions = [...owners]
      .filter(([name, files]) => files.size > 1 && !(name in ALLOWED_DUPLICATES))
      .map(([name, files]) => `${name} → ${[...files].join(', ')}`)
      .sort()

    expect(collisions).toEqual([])
  })

  test('the scan actually reads this package — a sanity floor, so a broken walk cannot pass vacuously', () => {
    const files = sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(50)
    const jobs = files.find((f) => relative(SRC, f) === join('api', 'jobs.ts'))
    expect(jobs).toBeDefined()
    // The canary names a real export of `api/jobs.ts`; if that export is ever
    // renamed, pick another one from the same file rather than deleting the
    // assertion — its whole job is to fail loudly when the walk stops reading.
    // `JobNodesResponseSchema` was the original canary and went away with plan
    // 211's node -> step rename (plan 200 §2.4).
    expect(declaredExports(readFileSync(jobs as string, 'utf8'))).toContain('JobsPageResponseSchema')
  })

  test('a duplicate IS detected — the regression this guard exists for', () => {
    const a = 'export const JobNodesResponseSchema = z.object({})\n'
    const b = 'export const JobNodesResponseSchema = z.object({})\nexport type JobNodesResponse = never\n'
    const shared = declaredExports(a).filter((n) => declaredExports(b).includes(n))
    expect(shared).toEqual(['JobNodesResponseSchema'])
  })
})
