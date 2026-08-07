import type { JobInfo } from '@enkaku/protocol'

/**
 * Every descendant of `jobId`, at any depth, from a flat list of jobs
 * sharing one trigger chain's root (plan 81 §3.2, §4.5). Mirrors
 * `lib/agent-tree.ts`'s `subtreeOf`, walking `triggeredByJobId` instead of
 * `parentRunId`.
 *
 * `nodes` is expected to be `GET /api/jobs?rootJobId=<chain's root>`'s
 * result — every job sharing that root EXCEPT the root's own row (its
 * `rootJobId` is null, by design; see `db/schema.ts`'s comment). Walking
 * from `jobId` rather than filtering the whole list by `rootJobId` again is
 * what keeps this correct for a NON-root job too: `nodes` also contains
 * that job's siblings and their own descendants, which this must not
 * include.
 */
export function descendantsOf(nodes: JobInfo[], jobId: string): JobInfo[] {
  const byParent = new Map<string, JobInfo[]>()
  for (const n of nodes) {
    if (!n.triggeredByJobId) continue
    const list = byParent.get(n.triggeredByJobId) ?? []
    list.push(n)
    byParent.set(n.triggeredByJobId, list)
  }
  const out: JobInfo[] = []
  const queue = [...(byParent.get(jobId) ?? [])]
  while (queue.length > 0) {
    const n = queue.shift()!
    out.push(n)
    queue.push(...(byParent.get(n.jobId) ?? []))
  }
  return out
}
