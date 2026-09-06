/**
 * `AGENTS.md` and `CLAUDE.md` are the same document addressed to two agents.
 * This asserts they have not drifted apart, and exits non-zero when they have.
 *
 * ## Why this is a CI job and not a convention
 *
 * They drifted, badly, and nothing noticed. By 2026-09-06 `AGENTS.md` still
 * said the release workflow does not build the guest agent APK (it does), that
 * CI runs a Studio test suite (deleted), and that the live plan series is
 * `01..16` (it is 200-224, 300-312, 400-404, 500-501, 600). It was also
 * missing three rules `CLAUDE.md` had gained. An agent reading it works from a
 * map of a repository that no longer exists — and the failure is silent,
 * because a stale instruction file produces confidently wrong work rather
 * than an error.
 *
 * Keeping them in sync by hand failed once already. A guard costs one CI step.
 *
 * ## What is allowed to differ
 *
 * Exactly the two header lines that name the addressee, and nothing else. If a
 * genuine per-agent difference is ever needed, add it to `ALLOWED_DIFFS` with
 * the reason — deliberately awkward, so the default stays "one document".
 *
 * Usage: bun run scripts/check-agent-docs.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

/** Each pair is one line permitted to differ: what `AGENTS.md` says, and what `CLAUDE.md` says. */
const ALLOWED_DIFFS: ReadonlyArray<{ agents: string; claude: string; why: string }> = [
  { agents: '# AGENTS.md', claude: '# CLAUDE.md', why: 'the filename heading' },
  {
    agents: 'This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.',
    claude: 'This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.',
    why: 'the addressee',
  },
]

function normalise(text: string, side: 'agents' | 'claude'): string[] {
  return text.split('\n').map((line) => {
    const rule = ALLOWED_DIFFS.find((d) => d[side] === line)
    return rule ? `<<allowed: ${rule.why}>>` : line
  })
}

const agents = normalise(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'), 'agents')
const claude = normalise(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), 'claude')

const problems: string[] = []
for (let i = 0; i < Math.max(agents.length, claude.length); i++) {
  const a = agents[i]
  const c = claude[i]
  if (a === c) continue
  if (a === undefined) problems.push(`line ${i + 1}: only in CLAUDE.md — ${JSON.stringify(c)}`)
  else if (c === undefined) problems.push(`line ${i + 1}: only in AGENTS.md — ${JSON.stringify(a)}`)
  else problems.push(`line ${i + 1}:\n    AGENTS.md: ${JSON.stringify(a)}\n    CLAUDE.md: ${JSON.stringify(c)}`)
}

if (problems.length > 0) {
  console.error(`error: AGENTS.md and CLAUDE.md have drifted (${problems.length} line${problems.length === 1 ? '' : 's'}):\n`)
  // Capped: a wholesale rewrite of one file would otherwise print the whole
  // document, and the first few lines are enough to see what happened.
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`)
  if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`)
  console.error('\n  Edit one, then copy it to the other — they are one document with two addressees.')
  console.error('  A genuine per-agent difference goes in ALLOWED_DIFFS in this script, with its reason.')
  process.exit(1)
}

console.log(`  AGENTS.md and CLAUDE.md agree (${claude.length} lines, ${ALLOWED_DIFFS.length} allowed differences)`)
