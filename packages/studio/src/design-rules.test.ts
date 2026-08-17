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

  /**
   * Plan 101 (M66) §3.1, step 101.1/101.3 — the whole reason the visual
   * refresh costs one file (`globals.css`) instead of 125: every component
   * names a colour token, never states one. `collectSourceFiles` only
   * matches `.ts`/`.tsx` (never `.css`), so `globals.css` itself — the one
   * file allowed to carry the new palette's raw values — is never scanned
   * here by construction, not by an exclusion list that could rot.
   */
  test('no hex colour literal anywhere under packages/studio/src outside globals.css (plan 101 §3.1, §6) — a hex written today survives the migration unchanged', () => {
    // `agents/detail/page.tsx`'s `#7c6df2` is an `<Input placeholder>` example
    // value for an AGENT'S OWN custom colour field (something an operator
    // types in, unrelated to this app's design tokens) — a false positive
    // for this rule, not an exception TO it, so it is named here rather than
    // weakening the regex for every other file.
    const ALLOWED = new Set([join(root, 'app/agents/detail/page.tsx')])
    const offenders = files.filter((f) => !ALLOWED.has(f) && /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  /**
   * Plan 101 §3.6, §4.4 — `backdrop-filter` is permitted on exactly one
   * static element, the sidebar (`AppShell.tsx`). The wall already decodes
   * 24–40 simultaneous H.264 streams (plan 100 §3.1: browser decode
   * capacity, not bandwidth, is the binding constraint), and backdrop-filter
   * forces a compositing layer — repeating it per device would spend
   * exactly what plan 100 was built to win back. This asserts the rule
   * mechanically because this codebase has already recorded two cases
   * (hotfix §96.22, §96.25) of a rule nobody re-checked quietly ceasing to
   * be true.
   */
  test('no backdrop-filter on any per-device component — WallTile, DeviceCard, DeviceTile, LiveView (plan 101 §3.6)', () => {
    // Scoped to the per-device surfaces the acceptance criterion (§6) names
    // — not "every file but AppShell": a once-per-PAGE element like
    // `PageHeader`'s sticky header is a different cost class entirely and
    // is not what this rule is about. `WallTile.tsx` carried a pre-existing
    // `backdrop-blur-sm` on its per-tile action overlay before plan 101
    // removed it — exactly the "a rule nobody re-checked quietly ceased to
    // be true" pattern hotfix §96.22/§96.25 already recorded.
    const perDeviceFiles = [
      join(root, 'components/wall/WallTile.tsx'),
      join(root, 'components/DeviceCard.tsx'),
      join(root, 'components/topology/DeviceTile.tsx'),
      join(root, 'components/LiveView.tsx'),
    ]
    for (const f of perDeviceFiles) expect(files).toContain(f) // the list itself must not silently go stale
    const offenders = perDeviceFiles.filter((f) => /backdrop-(filter|blur|saturate)|backdropFilter/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('AppShell.tsx carries the one permitted backdrop-filter — the sidebar (plan 101 §3.6, §4.2)', () => {
    const appShell = join(root, 'components/layout/AppShell.tsx')
    expect(files).toContain(appShell)
    expect(/backdrop-(filter|blur|saturate)|backdropFilter/.test(readFileSync(appShell, 'utf8'))).toBe(true)
  })

  /**
   * Plan 101 §3.2, §6 — `led-active` and `led-off` have NO counterpart in
   * `refs/ui`, because that mockup never had to render an idle rack.
   * `led-active` distinguishes a device that is streaming from one that is
   * merely healthy; `led-off` distinguishes a device with no signal from one
   * in trouble. A wall that cannot tell "asleep" from "broken" is a
   * regression no amount of polish repays.
   *
   * A palette rewrite is exactly the change that drops a token only one
   * screen uses, and both survived plan 101 — but nothing was actually
   * checking. `docs/design.md` claimed this suite asserted their survival
   * before this test existed, which is the same defect the claim warns
   * about: a guarantee written down and never wired up.
   *
   * Asserted against `globals.css` itself (the only file allowed to define a
   * palette value, per the hex rule above) rather than against a component,
   * so deleting the token fails here even if every current consumer is
   * deleted in the same change.
   */
  test('led-active and led-off still exist and are distinct from each other and from led-ok/led-danger (plan 101 §3.2)', () => {
    const css = readFileSync(join(root, 'app/globals.css'), 'utf8')
    const valueOf = (token: string): string | null => new RegExp(`--color-${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? null

    for (const token of ['led-active', 'led-off', 'led-ok', 'led-warn', 'led-danger']) {
      expect(valueOf(token), `--color-${token} must stay defined in globals.css`).not.toBeNull()
    }

    // Distinctness, not mere presence: re-pointing `led-off` at `led-ok` would
    // satisfy a presence check while destroying the exact signal the token
    // exists to carry.
    const values = ['led-active', 'led-off', 'led-ok', 'led-warn', 'led-danger'].map(valueOf)
    expect(new Set(values).size).toBe(values.length)
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

    test('the hex-literal rule flags a fixture that uses it (plan 101 §3.1)', () => {
      withFixture('export const x = <div style={{ background: "#181818" }} />\n', (path) => {
        expect(/#[0-9a-fA-F]{3,8}\b/.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })

    test('the backdrop-filter rule flags a fixture using the inline-style prop', () => {
      withFixture('export const x = <div style={{ backdropFilter: "blur(20px)" }} />\n', (path) => {
        expect(/backdrop-(filter|blur|saturate)|backdropFilter/.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })

    test('the backdrop-filter rule flags a fixture using a Tailwind backdrop-blur/-saturate utility class (plan 101 §3.6)', () => {
      withFixture('export const x = <div className="backdrop-blur-[20px] backdrop-saturate-[150%]" />\n', (path) => {
        expect(/backdrop-(filter|blur|saturate)|backdropFilter/.test(readFileSync(path, 'utf8'))).toBe(true)
      })
    })
  })
})
