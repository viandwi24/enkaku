import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeGaps,
  divergenceRowLines,
  extractRoutesFromFile,
  extractScreens,
  extractTableNames,
  mentionedIn,
  type Item,
} from './spec-check'

// Every fixture below lives under a fresh temp directory — none of this
// depends on the real docs/spec.md or docs/spec-divergences.md. The latter
// is Plan 84's own audit deliverable and is being written by a separate,
// concurrent worker while this test suite runs; a test that read it would be
// asserting against a moving target.

describe('extractTableNames — the grep -A1 phantom-table pitfall (plan 84 §3)', () => {
  test('matches only the first argument of sqliteTable(, never a column literal on the next line', () => {
    // Shaped exactly like the bug: `grep -A1 'sqliteTable('` plus
    // `grep -oE "'[a-z_]+'"` over both lines picks up 'id' and 'stable_id'
    // from the very next line's column definitions, because -A1 grabs that
    // line unconditionally. The real schema.ts is single-line for some
    // tables and multi-line for others (plan 84 §3 measured both), so the
    // fixture covers both shapes.
    const schemaSrc = `
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  stableId: text('stable_id').notNull().unique(),
})

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id').notNull(),
  },
)
`
    const names = extractTableNames(schemaSrc).map((item) => item.label)
    expect(names).toEqual(['devices', 'jobs'])
    expect(names).not.toContain('id')
    expect(names).not.toContain('stable_id')
    expect(names).not.toContain('script_id')
  })

  test('an empty schema yields no tables', () => {
    expect(extractTableNames('export const x = 1\n')).toEqual([])
  })
})

describe('mentionedIn', () => {
  test('true when any token appears as a case-insensitive substring', () => {
    expect(mentionedIn(['Devices'], 'the devices table holds every phone')).toBe(true)
  })

  test('false when no token appears', () => {
    expect(mentionedIn(['workspace_files'], 'the devices table holds every phone')).toBe(false)
  })

  test('empty tokens never match', () => {
    expect(mentionedIn([], 'anything at all')).toBe(false)
  })
})

describe('divergenceRowLines', () => {
  test('keeps only lines that mention a DIV- id, not preamble prose', () => {
    const src = `# Spec divergence register

This file records every divergence. Later rows get appended below.

| DIV-001 | §12 | workspace_files | nothing | ... | medium | needs-owner | |
| DIV-002 | §19 | /nodes | nothing | ... | medium | code-wins | |
`
    const lines = divergenceRowLines(src)
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('workspace_files')
    expect(lines[1]).toContain('/nodes')
  })

  test('a file with no DIV- rows yields an empty list', () => {
    expect(divergenceRowLines('# empty register\n\nNothing recorded yet.\n')).toEqual([])
  })
})

describe('computeGaps — the exact behaviour step 84.6 requires', () => {
  const specSrc = '# Enkaku spec\n\nThe devices table is described in §12. Jobs are described in §13.\n'

  function item(kind: Item['kind'], label: string): Item {
    return { kind, label, tokens: [label], source: 'fixture' }
  }

  test('fails (is reported as a gap) on a name present in neither the spec nor the register', () => {
    const items = [item('table', 'workspace_files')]
    const gaps = computeGaps(items, specSrc, null)
    expect(gaps.map((g) => g.label)).toEqual(['workspace_files'])
  })

  test('passes (is not a gap) once a DIV- row in the register covers it', () => {
    const divergencesSrc = '| DIV-014 | none | workspace_files | nothing | the AI agent VFS | medium | needs-owner | |\n'
    const items = [item('table', 'workspace_files')]
    const gaps = computeGaps(items, specSrc, divergencesSrc)
    expect(gaps).toEqual([])
  })

  test('passes when the name is simply in spec.md, register absent entirely', () => {
    const items = [item('table', 'devices')]
    // `null` is the exact shape main() passes when docs/spec-divergences.md
    // does not exist yet — must degrade gracefully, not throw.
    expect(() => computeGaps(items, specSrc, null)).not.toThrow()
    expect(computeGaps(items, specSrc, null)).toEqual([])
  })

  test('a mix: only the undocumented, unregistered item is reported', () => {
    const divergencesSrc = '| DIV-001 | none | nodes | nothing | the cloud tunnel table | medium | needs-owner | |\n'
    const items = [item('table', 'devices'), item('table', 'nodes'), item('table', 'workspace_files')]
    const gaps = computeGaps(items, specSrc, divergencesSrc)
    expect(gaps.map((g) => g.label)).toEqual(['workspace_files'])
  })
})

describe('extractScreens', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-check-screens-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('derives a route path and tokens from directory structure, and fixes the root page.tsx edge case', () => {
    writeFileSync(join(dir, 'page.tsx'), 'export default function Home() { return null }\n')
    mkdirSync(join(dir, 'agents', 'approvals'), { recursive: true })
    writeFileSync(join(dir, 'agents', 'page.tsx'), 'export default function Agents() { return null }\n')
    writeFileSync(join(dir, 'agents', 'approvals', 'page.tsx'), 'export default function Approvals() { return null }\n')

    const screens = extractScreens(dir)
    const byLabel = Object.fromEntries(screens.map((s) => [s.label, s]))

    expect(screens.length).toBe(3)

    // Root: must NOT leak "page.tsx" into the route label (regression check
    // for the bug this script's own author found while writing it — the
    // root page has no path separator before its filename, so a naive
    // `/page\.tsx$` strip left "/page.tsx" as the "route").
    expect(byLabel['/']).toBeDefined()
    expect(byLabel['/']!.tokens).toEqual(['home'])

    expect(byLabel['/agents']).toBeDefined()
    expect(byLabel['/agents']!.tokens).toEqual(['agents'])

    expect(byLabel['/agents/approvals']).toBeDefined()
    expect(byLabel['/agents/approvals']!.tokens).toEqual(['agents', 'approvals'])
  })
})

describe('extractRoutesFromFile', () => {
  let file: string

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'spec-check-routes-')), 'widgets.ts')
  })

  afterEach(() => {
    rmSync(file, { force: true })
  })

  test('extracts app.<method>(path) route registrations, skips the static catch-all, falls back to the filename for param-only paths', () => {
    const src = `import { Hono } from 'hono'

export function createWidgetRoutes() {
  const app = new Hono()

  app.get('/', (c) => c.json([]))
  app.post('/:id/reset', (c) => c.json({}))
  app.get('*', (c) => c.text('not an api route'))

  // not a route registration — must not be picked up
  const widgets = new Map()
  widgets.get('id')

  return app
}
`
    writeFileSync(file, src)
    const routes = extractRoutesFromFile(file)

    expect(routes.map((r) => r.label)).toEqual(['GET /', 'POST /:id/reset'])
    // '/' has no static segment, so it falls back to the file's own basename.
    expect(routes[0]!.tokens).toEqual(['widgets'])
    // '/:id/reset' has one static segment once the param is stripped.
    expect(routes[1]!.tokens).toEqual(['reset'])
  })

  test('a file with no routes yields an empty list, not a crash', () => {
    writeFileSync(file, 'export const nothing = 1\n')
    expect(extractRoutesFromFile(file)).toEqual([])
  })

  test('a missing file yields an empty list, not a crash (mirrors readOptional degrading gracefully)', () => {
    expect(extractRoutesFromFile(join(tmpdir(), 'this-file-does-not-exist-spec-check.ts'))).toEqual([])
  })
})
