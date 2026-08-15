import type { CommandMember } from '@enkaku/protocol'

/**
 * Plan 93 §3.15, step 93.7 — "the report: how N results are shown without
 * drowning anyone." Grouped by outcome, then by identical output (H1): on a
 * homogeneous farm 100 rows collapse to three, and failures/skips always
 * sort above successes ("one red dot among a dozen devices has to catch the
 * eye immediately" — docs/design.md's own rule, restated in the plan).
 *
 * Pure and independently testable — no DOM, no fetch — so the sort/grouping
 * property can be pinned without rendering anything.
 */

export type OutcomeGroupKind = 'failed' | 'skipped' | 'cancelled' | 'running' | 'pending' | 'ok'

export interface OutcomeGroup {
  key: string
  kind: OutcomeGroupKind
  /** What the row shows — an error/exit summary, a skip reason, or "ok". */
  title: string
  members: CommandMember[]
}

const RANK: Record<OutcomeGroupKind, number> = { failed: 0, skipped: 1, cancelled: 2, running: 3, pending: 4, ok: 5 }

export function groupMembers(members: CommandMember[]): OutcomeGroup[] {
  const byKey = new Map<string, OutcomeGroup>()
  const order: OutcomeGroup[] = []

  const bucket = (kind: OutcomeGroupKind, subKey: string, title: string): OutcomeGroup => {
    const key = `${kind}|${subKey}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, kind, title, members: [] }
      byKey.set(key, g)
      order.push(g)
    }
    return g
  }

  for (const m of members) {
    if (m.status === 'failed') {
      const subKey = m.error ?? m.outputHash ?? `exit-${m.exitCode ?? 'null'}`
      const title = m.error ? `error — ${m.error}` : `exit ${m.exitCode ?? '?'}`
      bucket('failed', subKey, title).members.push(m)
    } else if (m.status === 'skipped') {
      const subKey = m.skip?.code ?? 'skipped'
      bucket('skipped', subKey, m.skip?.message ?? 'skipped').members.push(m)
    } else if (m.status === 'cancelled') {
      bucket('cancelled', 'cancelled', 'cancelled').members.push(m)
    } else if (m.status === 'running') {
      bucket('running', 'running', 'running…').members.push(m)
    } else if (m.status === 'pending') {
      bucket('pending', 'pending', 'waiting…').members.push(m)
    } else {
      const subKey = m.outputHash ?? 'no-output'
      bucket('ok', subKey, 'ok').members.push(m)
    }
  }

  // Exceptions first, always (design.md's rule); within a kind, the biggest
  // group first — the one "91 identical results" example from §3.15's own
  // sketch, where the huge ok group sits last and collapsed.
  return order.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.members.length - a.members.length)
}
