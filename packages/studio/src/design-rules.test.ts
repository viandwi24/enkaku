import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `docs/design.md`'s rules, checked mechanically rather than hoped for
 * (plan 69 §3.6, widened by plan 73 §3.6, §7). All three have shipped
 * broken in this repo before:
 *
 *  - the Tailwind v3 bracket form `bg-[--color-surface]` compiles to
 *    nothing in v4 (silent, no error, no style);
 *  - a plain `<a href="/...">` to an internal route remounts React and
 *    kills the WS/video stream;
 *  - `calc(100vh-…)`/`calc(100dvh-…)` is a hard-coded guess at some other
 *    element's height (plan 73 §3.1's own motivating bug — 91 was a guess
 *    at the header, and it was wrong the moment the header changed).
 *
 * Plan 69 scanned only its own `components/agent`/`app/agents` subtree.
 * That was too narrow: `Transcript.tsx`'s composer wrote its rules, but
 * `agents/detail/page.tsx` reintroduced a viewport `calc()` at line 368 and
 * nothing here caught it. This scans every `.ts`/`.tsx` file under
 * `packages/studio/src`, so the next person reaching for a magic viewport
 * number anywhere in Studio is stopped by a test, not a review.
 */

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...collectSourceFiles(full))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) out.push(full)
  }
  return out
}

const root = import.meta.dir // packages/studio/src/
const files = collectSourceFiles(root)

describe('Studio — design system rules (docs/design.md; plan 69 §3.6, plan 73 §3.6, §7)', () => {
  test('at least one file was actually scanned (a passing test over zero files proves nothing — plan 69\'s own guard, kept)', () => {
    expect(files.length).toBeGreaterThan(0)
    // A sanity floor, not an exact count — this whole module tree has always had far more than a
    // handful of files; a number this low would mean `collectSourceFiles` walked the wrong root.
    expect(files.length).toBeGreaterThan(50)
  })

  test('no Tailwind v3 bracket colour form — `bg-[--color-...]` compiles to nothing in v4, silently', () => {
    const offenders = files.filter((f) => /\[--color-/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('no plain `<a href="/...">` to an internal route — it remounts React and kills the WS/video stream', () => {
    const offenders = files.filter((f) => /<a\s[^>]*href="\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('no viewport calc() — `calc(100vh-…)`/`calc(100dvh-…)` is a guess at some other element\'s height that goes stale the moment that element changes (plan 73 §3.1)', () => {
    const offenders = files.filter((f) => /calc\(100(vh|dvh)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  // Plan 73 §7 — "a test that passes over zero matches proves nothing" applies to THIS test suite
  // too: each rule above is proven to actually catch its pattern against a throwaway fixture file,
  // written and deleted within the test itself, never checked in.
  describe('each rule is proven to actually catch its pattern (a fixture, not just an absence)', () => {
    function withFixture(content: string, run: (path: string) => void) {
      const dir = mkdtempSync(join(tmpdir(), 'enkaku-design-rules-'))
      const path = join(dir, 'fixture.tsx')
      writeFileSync(path, content)
      try {
        run(path)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test('the bracket-colour rule flags a fixture that uses it', () => {
      withFixture('export const x = <div className="bg-[--color-surface]" />\n', (path) => {
        expect(/\[--color-/.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })

    test('the internal-anchor rule flags a fixture that uses it', () => {
      withFixture('export const x = <a href="/devices">go</a>\n', (path) => {
        expect(/<a\s[^>]*href="\//.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })

    test('the viewport-calc rule flags a fixture that uses it', () => {
      withFixture('export const x = <div style={{ height: "calc(100dvh - 91px)" }} />\n', (path) => {
        expect(/calc\(100(vh|dvh)/.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })
  })
})
