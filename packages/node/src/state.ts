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
 * The shape written by a pre-plan-61 `@enkaku/agent` build — kept only for
 * the one-time adoption below (plan 61 §3.3). Never written by this package.
 */
const LegacyAgentStateSchema = z.object({
  agentId: z.string(),
  credential: z.string(),
  controlPlaneUrl: z.string(),
})

export async function loadState(dataDir: string): Promise<NodeState | null> {
  const nodeFile = Bun.file(join(dataDir, 'node.json'))
  if (await nodeFile.exists()) {
    const parsed = NodeStateSchema.safeParse(await nodeFile.json().catch(() => null))
    return parsed.success ? parsed.data : null
  }
  // Plan 61 §3.3 compatibility window: a node upgraded in place still has the
  // pre-rename `agent.json` on disk. Adopt it once and rewrite it as
  // `node.json` so the node keeps its credential — it does not re-enroll and
  // does not appear as a second row in the control plane's node list. The
  // stale `agent.json` is left alone rather than deleted: nothing here should
  // ever delete somebody's file.
  const legacyFile = Bun.file(join(dataDir, 'agent.json'))
  if (!(await legacyFile.exists())) return null
  const legacy = LegacyAgentStateSchema.safeParse(await legacyFile.json().catch(() => null))
  if (!legacy.success) return null
  const state: NodeState = {
    nodeId: legacy.data.agentId,
    credential: legacy.data.credential,
    controlPlaneUrl: legacy.data.controlPlaneUrl,
  }
  await saveState(dataDir, state)
  return state
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
