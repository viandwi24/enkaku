import { join } from 'node:path'
import { z } from 'zod'

/**
 * Node state is one JSON file (plan 11 §4.1, renamed from "agent" in plan 61).
 * There is no SQLite on the node: the device registry belongs to the control
 * plane; the node only reports what track-devices shows it.
 */
export const NodeStateSchema = z.object({
  nodeId: z.string(),
  /** The long-lived secret from enrollment (the CP stores only its hash). */
  credential: z.string(),
  controlPlaneUrl: z.string(),
})
export type NodeState = z.infer<typeof NodeStateSchema>

/**
 * The pre-plan-61 `agent.json` adoption (plan 61 §3.3) was removed per the
 * dated follow-up in `00-overview.md` §9 (deadline v0.1.7, now passed). A
 * node upgraded in place from that far back no longer has its old
 * `agent.json` picked up automatically — see `packages/core/src/daemon.ts`'s
 * `/agent/ws` rejection for what such a node now experiences on connect.
 */
export async function loadState(dataDir: string): Promise<NodeState | null> {
  const nodeFile = Bun.file(join(dataDir, 'node.json'))
  if (!(await nodeFile.exists())) return null
  const parsed = NodeStateSchema.safeParse(await nodeFile.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

export async function saveState(dataDir: string, state: NodeState): Promise<void> {
  await Bun.write(join(dataDir, 'node.json'), JSON.stringify(state, null, 2))
}

/**
 * One-shot enrollment: exchange the single-use token for a long-lived
 * credential (spec §14 "tunnel node pakai token").
 */
export async function enroll(opts: {
  controlPlaneUrl: string
  token: string
  name: string
}): Promise<NodeState> {
  const res = await fetch(`${opts.controlPlaneUrl.replace(/\/$/, '')}/api/nodes/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: opts.token, name: opts.name, platform: `${process.platform}-${process.arch}` }),
  })
  const body = (await res.json()) as { nodeId?: string; credential?: string; error?: { message: string } }
  if (!res.ok || !body.nodeId || !body.credential) {
    throw new Error(body.error?.message ?? `enrollment failed: HTTP ${res.status}`)
  }
  return { nodeId: body.nodeId, credential: body.credential, controlPlaneUrl: opts.controlPlaneUrl }
}
