#!/usr/bin/env bun
/**
 * spec-check.ts — plan 84 (M49) §4.4 "Closing the loop", step 84.6.
 *
 * 86 plans were written and executed by agents, and none of them was
 * responsible for keeping `docs/spec.md` true — no step in the Definition of
 * Done asked for it. That is why `spec.md` drifted (plan 84 §3.6): the
 * failure is structural, and amending the spec once without changing the
 * loop guarantees a repeat within weeks. This script is the loop-closer.
 *
 * It fails — reports, for now; see FAIL_ON_GAP below — when a table, route,
 * or `page.tsx` screen exists whose name appears NOWHERE in `docs/spec.md`
 * and has NO `DIV-` row in `docs/spec-divergences.md`.
 *
 * It is deliberately dumb: a name-presence check, not comprehension. Plan 84
 * §4.4 says this in so many words — a dumb check that runs is worth more
 * than a smart one that does not. Resist the urge to make any pass here
 * "smarter"; that is how a check like this stops running at all.
 *
 * Table pitfall (do not reintroduce): a prior audit extracted table names
 * with `grep -A1 'sqliteTable('`, which also captures quoted strings on the
 * FOLLOWING line — including column literals — and invented phantom tables
 * (`id`, `stable_id`). Plan 84 §3 documents the mistake so it is not
 * repeated. This script matches the FIRST ARGUMENT of `sqliteTable(`
 * directly with a regex that spans the `(` to the opening quote, tolerating
 * the whitespace/newline Drizzle's multi-line call style puts between them —
 * never the following line's content.
 *
 * Route pitfall (accepted, not fixed): routes are mounted through nested
 * `app.route('/', ...)` composition (three files — devices.ts, guest-agent.ts,
 * device-identity.ts — mount extra routes at the shared `/api/devices`
 * prefix from server/http.ts), so recovering each endpoint's fully-composed
 * path mechanically is not a "dumb" check anymore, it is a small router
 * simulator. This script instead extracts each literal `app.<method>('...')`
 * call and treats its own static path segments (params and '*' stripped) as
 * its "name" — no prefix composition. This deliberately UNDER-reports: a
 * route can look "documented" because one of its own segments (e.g.
 * `/:id/reset` → `reset`) happens to appear in spec.md prose for unrelated
 * reasons. That is accepted on purpose — plan 84 §4.4 and §8 are explicit
 * that a check which cries wolf gets disabled, and under-reporting here is
 * the safe direction. See extractRoutes() below.
 *
 * Usage: bun run scripts/spec-check.ts   (wired as `bun run spec:check`)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

// ---------------------------------------------------------------------------
// The switch. Exit code 0 today: 29+ divergence rows are open (plan 84 §3),
// so a hard failure would block every commit on day one (plan 84 §4.4). Flip
// this to `true` — and ONLY this — once `docs/spec-divergences.md` has zero
// open (undecided) rows and the register itself is complete (plan 84 §9 Q4).
// ---------------------------------------------------------------------------
const FAIL_ON_GAP = false

const ROOT = join(import.meta.dir, '..')
const SPEC_PATH = join(ROOT, 'docs/spec.md')
const DIVERGENCES_PATH = join(ROOT, 'docs/spec-divergences.md')
const SCHEMA_PATH = join(ROOT, 'packages/core/src/db/schema.ts')
const STUDIO_APP_DIR = join(ROOT, 'packages/studio/src/app')
const API_DIR = join(ROOT, 'packages/core/src/api')
const HTTP_PATH = join(ROOT, 'packages/core/src/server/http.ts')

export interface Item {
  kind: 'table' | 'screen' | 'route'
  /** What gets checked for presence — a table name, a screen route, or `METHOD path`. */
  label: string
  /** The literal token(s) checked against spec.md / the register. Plural for screens/routes. */
  tokens: string[]
  source: string
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// --- Pass 1: tables -----------------------------------------------------

/**
 * The first argument of every `sqliteTable(` call in schema.ts. Matches
 * `sqliteTable(` through any whitespace/newline straight to the opening
 * quote, so it lands on the table name whether the call is written
 * single-line (`sqliteTable('x', {`) or Drizzle's multi-line style
 * (`sqliteTable(\n  'x',\n  {`) — and never drifts onto a later line the way
 * `grep -A1` did (see file header).
 */
export function extractTableNames(schemaSrc: string): Item[] {
  const re = /sqliteTable\(\s*['"]([a-zA-Z0-9_]+)['"]/g
  const items: Item[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(schemaSrc))) {
    const name = m[1]
    if (!name) continue
    items.push({ kind: 'table', label: name, tokens: [name], source: 'packages/core/src/db/schema.ts' })
  }
  return items
}

// --- Pass 2: screens ------------------------------------------------------

function findPageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) findPageFiles(full, out)
    else if (entry.name === 'page.tsx') out.push(full)
  }
  return out
}

export function extractScreens(appDir: string): Item[] {
  return findPageFiles(appDir).map((file) => {
    // `(^|[\\/])page\.tsx$` — the root page.tsx has no separator before its
    // filename (`relative()` returns bare "page.tsx"), so the separator in
    // the match has to be optional or the root route never strips down to "".
    const rel = relative(appDir, file).replace(/(^|[\\/])page\.tsx$/, '')
    const routePath = rel === '' ? '/' : `/${rel.split('\\').join('/')}`
    const segments = routePath.split('/').filter(Boolean)
    // The app root has no directory name of its own to check — 'home' is a
    // deliberate, documented stand-in rather than a guess at spec wording.
    const tokens = segments.length > 0 ? segments : ['home']
    return { kind: 'screen', label: routePath, tokens, source: relative(ROOT, file) }
  })
}

// --- Pass 3: routes ---------------------------------------------------------

/** Only route-registration calls: `app.<method>('path', ...)` at (whitespace-only) line start. */
const ROUTE_LINE_RE = /^[ \t]*app\.(get|post|put|patch|delete)\(\s*(['"])([^'"]*)\2/

export function extractRoutesFromFile(file: string): Item[] {
  const src = readOptional(file)
  if (src === null) return []
  const rel = relative(ROOT, file)
  const items: Item[] = []
  src.split('\n').forEach((line, i) => {
    const m = ROUTE_LINE_RE.exec(line)
    if (!m) return
    const method = m[1]?.toUpperCase() ?? ''
    const routePath = m[3] ?? ''
    if (routePath === '*') return // the Studio static-file catch-all, not an API endpoint
    const segments = routePath.split('/').filter((s) => s.length > 0 && !s.startsWith(':'))
    // No static segment (e.g. the route is just '/' or a bare param) — fall
    // back to the file's own name so it isn't silently unmatchable.
    const tokens = segments.length > 0 ? segments : [basename(file, '.ts')]
    items.push({ kind: 'route', label: `${method} ${routePath}`, tokens, source: `${rel}:${i + 1}` })
  })
  return items
}

function extractRoutes(): Item[] {
  const apiFiles = existsSync(API_DIR)
    ? readdirSync(API_DIR)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => join(API_DIR, f))
    : []
  const files = [...apiFiles, HTTP_PATH]
  return files.flatMap(extractRoutesFromFile)
}

// --- Matching ---------------------------------------------------------------

/** Case-insensitive substring presence — deliberately dumb, per the file header. */
export function mentionedIn(tokens: string[], haystackLower: string): boolean {
  return tokens.some((t) => t.length > 0 && haystackLower.includes(t.toLowerCase()))
}

/**
 * Only lines that look like an actual register row (they mention a `DIV-`
 * id) count as coverage — so a name that merely happens to appear in the
 * register's preamble prose doesn't count as "decided".
 */
export function divergenceRowLines(divergencesSrc: string): string[] {
  return divergencesSrc
    .split('\n')
    .filter((line) => /DIV-\d+/.test(line))
    .map((line) => line.toLowerCase())
}

/**
 * The check's whole verdict in one place: an item is a gap unless its name
 * is mentioned in spec.md OR in some `DIV-` row of the register.
 * `divergencesSrc` is `null` when the register file does not exist yet
 * (plan 84's register is written by a separate step of this same plan) —
 * that degrades to "zero rows", never a crash.
 */
export function computeGaps(items: Item[], specSrc: string, divergencesSrc: string | null): Item[] {
  const specLower = specSrc.toLowerCase()
  const rows = divergencesSrc === null ? [] : divergenceRowLines(divergencesSrc)
  const registerLower = rows.join('\n')
  return items.filter((item) => !mentionedIn(item.tokens, specLower) && !mentionedIn(item.tokens, registerLower))
}

function main() {
  const specSrc = readOptional(SPEC_PATH)
  const divergencesSrc = readOptional(DIVERGENCES_PATH)
  const schemaSrc = readOptional(SCHEMA_PATH)

  if (specSrc === null) {
    console.error(`spec:check — ${relative(ROOT, SPEC_PATH)} not found; cannot check anything against it.`)
    process.exit(1)
  }
  if (schemaSrc === null) {
    console.error(`spec:check — ${relative(ROOT, SCHEMA_PATH)} not found; cannot check tables.`)
    process.exit(1)
  }

  const registerMissing = divergencesSrc === null

  const tables = extractTableNames(schemaSrc)
  const screens = existsSync(STUDIO_APP_DIR) ? extractScreens(STUDIO_APP_DIR) : []
  const routes = extractRoutes()

  const all: Item[] = [...tables, ...screens, ...routes]
  const gaps = computeGaps(all, specSrc, divergencesSrc)

  const byKind = (kind: Item['kind']) => gaps.filter((g) => g.kind === kind)

  console.log('spec:check — plan 84 (M49) §4.4: a name-presence check, not comprehension.')
  console.log('')
  console.log(`  tables scanned:  ${tables.length}  (packages/core/src/db/schema.ts)`)
  console.log(`  screens scanned: ${screens.length}  (packages/studio/src/app/**/page.tsx)`)
  console.log(`  routes scanned:  ${routes.length}  (packages/core/src/api/*.ts, server/http.ts — see file header on why this is a lower bound)`)
  console.log('')

  if (registerMissing) {
    console.log(`  NOTE: ${relative(ROOT, DIVERGENCES_PATH)} does not exist yet.`)
    console.log('        Treating it as zero rows — nothing is recorded as a known divergence yet.')
    console.log('')
  }

  console.log(`GAP: ${gaps.length} name(s) appear in neither docs/spec.md nor a DIV- row.`)
  console.log(`  tables:  ${byKind('table').length}`)
  console.log(`  screens: ${byKind('screen').length}`)
  console.log(`  routes:  ${byKind('route').length}`)

  if (gaps.length > 0) {
    console.log('')
    console.log('  first 20:')
    for (const g of gaps.slice(0, 20)) {
      console.log(`    [${g.kind}] ${g.label}  (${g.source})`)
    }
    if (gaps.length > 20) console.log(`    ... and ${gaps.length - 20} more`)
  }

  console.log('')
  if (FAIL_ON_GAP) {
    if (gaps.length > 0) {
      console.error('spec:check — FAILING: FAIL_ON_GAP is true and the gap above is non-zero.')
      process.exit(1)
    }
    console.log('spec:check — passing: FAIL_ON_GAP is true and the register is complete.')
    process.exit(0)
  }

  console.log('spec:check — WARNING ONLY (FAIL_ON_GAP=false, see the constant at the top of this file). Exiting 0.')
  process.exit(0)
}

// Guarded so the test file can `import` these functions without running the
// CLI (which reads the real repo and calls `process.exit`) as a side effect.
if (import.meta.main) main()
