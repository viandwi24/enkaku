import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * R2 (plan 90 §3.9): "Capabilities gate features. Versions never do." No host code compares
 * `appVersion` — not with `>=`, not with `startsWith`, not at all; `hello().capabilities` is the
 * only thing anything conditions on (the same rule `egress-probe`/`route-hold`/`mock-location`
 * already followed before this plan existed — see `client.ts`'s per-method doc comments). This is
 * what lets a farm run mixed agent versions with no version matrix to maintain.
 *
 * `appVersion` itself is legitimate — F11 makes it a visible, displayed field
 * (`GuestAgentStatusResult.appVersion`, `AgentStatus.appVersion`) — so this guard does not forbid
 * the string outright the way `adb-server-control.test.ts`'s `kill-server` guard forbids ITS
 * string. It forbids exactly one thing: using it as an operand of a comparison. Modelled on that
 * same file's workspace-wide walk (plan 01 §398/§494, plan 88 §3.10/§4.8/§5 step 88.9) — a guard
 * that walks `src/` itself rather than enumerating files by name, so a new offending file falls
 * under it automatically, and a guard that strips comments the same way so a rule explanation
 * ("never compare appVersion") does not trip itself.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
/** R2 names these two packages explicitly; a workspace-wide walk (every package) is step 90.2's
 * job, not a wider claim this test does not need to make. */
const TARGET_PACKAGES = ['core', 'drivers']

/** Every non-test `.ts` file under `dir`, recursively. `.test.ts` is excluded deliberately — a
 * test file's job is to talk ABOUT the rule (this file's own name mentions `appVersion` in
 * prose), which is not the same as production code reaching for a version comparison. */
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
 * Strips `//` line comments and `/* *\/` block comments so a doc comment ABOUT the rule (this
 * file's own reasoning, reproduced as a `client.ts` doc comment) never trips the guard — same
 * technique and same "di luar komentar" qualifier `adb-server-control.test.ts` uses. String and
 * template literals are tracked and copied through untouched, so a real comparison built from a
 * template literal still counts.
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

/**
 * Every shape R2 forbids: `appVersion` (or `.appVersion`) on either side of a relational or
 * equality operator, or as the receiver/argument of a string-comparison method. Deliberately does
 * NOT match a bare presence check like `appVersion != null` differently from a real version
 * comparison — R2's own wording is "not at all", so this guard does not try to be clever about
 * which comparisons are "really" about the version string and which are not. A file that needs a
 * presence check reaches for `appVersion == null` at its own risk of tripping this test; the fix
 * is the same either way, a `capabilities` check instead.
 */
const COMPARISON_PATTERNS: RegExp[] = [
  // appVersion === / !== / == / != / >= / <= / > / < ...
  /\bappVersion\b\s*(===|!==|==|!=|>=|<=|>|<)/,
  // ... === / !== / == / != / >= / <= / > / < appVersion  (only word/dot chars between the
  // operator and the field, so this does not reach across unrelated code on the same line)
  /(===|!==|==|!=|>=|<=|>|<)\s*[\w.]*\bappVersion\b/,
  // appVersion.startsWith(...) / .localeCompare(...) / etc — string-comparison methods
  /\bappVersion\b\s*\.\s*(startsWith|endsWith|includes|localeCompare)\s*\(/,
  // a version-comparison helper called with appVersion as an argument
  /\b(compareVersions|semverGte|semverLte|semverGt|semverLt|semverCompare|semver)\b[^\n;]*\bappVersion\b/,
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

describe('workspace guard — R2 (plan 90 §3.9): no source file in packages/core or packages/drivers compares appVersion', () => {
  test('no file under packages/{core,drivers}/src reaches for a version comparison on appVersion', () => {
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
        : `R2 violated — appVersion is compared instead of gating on capabilities:\n${offenders
            .map((o) => `  ${o.file}: ${o.hits.join(', ')}`)
            .join('\n')}`,
    ).toEqual([])
  })
})
