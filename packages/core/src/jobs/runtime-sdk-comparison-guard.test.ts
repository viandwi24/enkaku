import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * S2 (plan 98 §3.3): "Capabilities gate features; versions never." The ONE
 * sanctioned comparison against a script's declared SDK major —
 * `checkRuntimeMajor`'s own `major >= SCRIPT_RUNTIME_MIN_MAJOR && major <=
 * SCRIPT_RUNTIME_MAJOR` — lives in `packages/protocol/src/runtime-envelope.ts`
 * (step 98.1), OUTSIDE the two packages this guard walks. Everywhere else in
 * `core`/`session`, a version-skew question is answered the OTHER way
 * already: the runtime refuses a specific call with a code
 * (`E_KV_UNAVAILABLE`, `E_JOBS_UNAVAILABLE`, `E_TRANSFER_UNAVAILABLE`,
 * `job-runner.ts:163-179`) rather than a caller comparing a version number
 * first — capability gating, which needs no list to keep in sync and already
 * works for an old bundle on a new core and vice versa. This is the acceptance
 * criterion 13 guard ("no core or session source file compares an SDK
 * version"), modelled directly on plan 90's own `appVersion` precedent,
 * `packages/drivers/src/network/guest-agent/version-skew-guard.test.ts` — the
 * SAME walk-src/strip-comments/pattern-match shape, the field name swapped
 * from `appVersion` to `sdk` (`RuntimeEnvelope.sdk` / `ResolvedRuntime.sdk`,
 * always reached via a `.sdk` property chain in this codebase — `entry.runtime
 * ?.sdk`, `named?.runtime?.sdk`, `resolved.sdk` — never a bare destructured
 * identifier, which is why this guard matches `.sdk` rather than a bare
 * `\bsdk\b` word: the bare word ALSO appears for unrelated things this guard
 * must not flag — Android's own `ro.build.version.sdk` (`session/probe.ts`)
 * and the `'sdk'` input-mode string literal (`'uhid' | 'sdk' | 'aoa'`,
 * `session/types.ts`/`session.ts`) — neither of which is ever written as
 * `.sdk` (a property access), so scoping to that substring avoids both
 * false-positive classes without special-casing either file by name.
 *
 * A call site merely PASSING `.sdk` as an argument (`checkRuntimeMajor(entry
 * .runtime?.sdk)`, this plan's own step 98.6/98.7 wiring in `job-service.ts`/
 * `triggers.ts`) is not a comparison and does not trip this guard — only an
 * operator or method reaching for a relational/equality operator, or a
 * string/semver-comparison method, right next to `.sdk` does.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
/** Acceptance criterion 13's own wording: "no CORE OR SESSION source file". */
const TARGET_PACKAGES = ['core', 'session']

/** Every non-test `.ts` file under `dir`, recursively — production code only, not a test file talking ABOUT the rule. */
function listImplementationFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listImplementationFiles(full))
      continue
    }
    if (!entry.endsWith('.ts')) continue
    if (entry.endsWith('.test.ts') || entry.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

/**
 * Strips `//` line comments and block comments so a doc comment ABOUT the
 * rule (this file's own reasoning, echoed in `job-runner.ts`'s doc comments)
 * never trips the guard, exactly like `version-skew-guard.test.ts`'s own
 * `stripComments`. String/template literals are tracked and copied through
 * untouched, so a real comparison built from one still counts.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '')
          i += 2
          continue
        }
        out += source[i]
        i++
      }
      if (i < n) {
        out += source[i]
        i++
      }
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Every shape S2 forbids: `.sdk` on either side of a relational/equality operator, or as the receiver/argument of a string/semver-comparison method. */
const COMPARISON_PATTERNS: RegExp[] = [
  // .sdk === / !== / == / != / >= / <= / > / < ...
  /\.sdk\b\s*(===|!==|==|!=|>=|<=|>|<)/,
  // ... === / !== / == / != / >= / <= / > / < ...sdk (only word/dot/optional-chain chars between the operator and the field)
  /(===|!==|==|!=|>=|<=|>|<)\s*[\w.?]*\.sdk\b/,
  // .sdk.startsWith(...) / .localeCompare(...) / etc — string-comparison methods
  /\.sdk\b\s*\.\s*(startsWith|endsWith|includes|localeCompare)\s*\(/,
  // a version-comparison helper called with .sdk as an argument
  /\b(compareVersions|semverGte|semverLte|semverGt|semverLt|semverCompare|semver)\b[^\n;]*\.sdk\b/,
]

function findComparisons(code: string): string[] {
  const hits: string[] = []
  for (const line of code.split('\n')) {
    for (const pattern of COMPARISON_PATTERNS) {
      const m = pattern.exec(line)
      if (m) hits.push(m[0].trim())
    }
  }
  return hits
}

describe('workspace guard — S2 (plan 98 §3.3): no source file in packages/core or packages/session compares runtime.sdk', () => {
  test('no file under packages/{core,session}/src reaches for a version comparison on .sdk', () => {
    const offenders: Array<{ file: string; hits: string[] }> = []
    for (const pkg of TARGET_PACKAGES) {
      const srcDir = join(REPO_ROOT, 'packages', pkg, 'src')
      let isDir: boolean
      try {
        isDir = statSync(srcDir).isDirectory()
      } catch {
        isDir = false // must not throw if a target package ever loses its src/ — that is not this guard's job to catch
      }
      if (!isDir) continue
      for (const file of listImplementationFiles(srcDir)) {
        const code = stripComments(readFileSync(file, 'utf8'))
        const hits = findComparisons(code)
        if (hits.length > 0) offenders.push({ file: relative(REPO_ROOT, file), hits })
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? undefined
        : `S2 violated — runtime.sdk is compared instead of gating on a capability code:\n${offenders
            .map((o) => `  ${o.file}: ${o.hits.join(', ')}`)
            .join('\n')}`,
    ).toEqual([])
  })

  test('sanity: the guard\'s own patterns actually catch a comparison — proves the test is not vacuously green', () => {
    const offending = [
      'if (entry.runtime.sdk >= 2) { /* ... */ }',
      'const ok = job.runtime?.sdk === 1',
      'while (resolved.sdk < MIN) {}',
      "entry.runtime.sdk.startsWith('2')",
      'semverGte(entry.runtime.sdk, "2.0.0")',
    ]
    for (const line of offending) {
      expect(findComparisons(stripComments(line)), line).not.toEqual([])
    }
  })

  test('sanity: a mere pass-through (the real 98.6/98.7 wiring shape) does not trip the guard', () => {
    const safe = [
      "checkRuntimeMajor(entry.runtime?.sdk)",
      "checkRuntimeMajor(named?.runtime?.sdk)",
      "sdk: override?.sdk ?? script?.sdk ?? SCRIPT_RUNTIME_MAJOR,",
      "client.exec(serial, 'getprop ro.build.version.sdk', { profile: 'probe' })",
      "preferredInputMode: 'uhid' | 'sdk' | 'aoa'",
      "mode === 'sdk'",
    ]
    for (const line of safe) {
      expect(findComparisons(stripComments(line)), line).toEqual([])
    }
  })
})
