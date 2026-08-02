import { join } from 'node:path'
import { z } from 'zod'

/**
 * Agent state is one JSON file (plan 11 §4.1). There is no SQLite on the agent:
 * the device registry belongs to the control plane; the agent only reports
 * what track-devices shows it.
 */
export const AgentStateSchema = z.object({
  agentId: z.string(),
  /** The long-lived secret from enrollment (the CP stores only its hash). */
  credential: z.string(),
  controlPlaneUrl: z.string(),
})
export type AgentState = z.infer<typeof AgentStateSchema>

export async function loadState(dataDir: string): Promise<AgentState | null> {
  const file = Bun.file(join(dataDir, 'agent.json'))
  if (!(await file.exists())) return null
  const parsed = AgentStateSchema.safeParse(await file.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

export async function saveState(dataDir: string, state: AgentState): Promise<void> {
  await Bun.write(join(dataDir, 'agent.json'), JSON.stringify(state, null, 2))
}

/**
 * One-shot enrollment: exchange the single-use token for a long-lived
 * jangka panjang (spec §14 "tunnel agent pakai token").
 */
export async function enroll(opts: {
  controlPlaneUrl: string
  token: string
  name: string
}): Promise<AgentState> {
  const res = await fetch(`${opts.controlPlaneUrl.replace(/\/$/, '')}/api/agents/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: opts.token, name: opts.name, platform: `${process.platform}-${process.arch}` }),
  })
  const body = (await res.json()) as { agentId?: string; credential?: string; error?: { message: string } }
  if (!res.ok || !body.agentId || !body.credential) {
    throw new Error(body.error?.message ?? `enrollment failed: HTTP ${res.status}`)
  }
  return { agentId: body.agentId, credential: body.credential, controlPlaneUrl: opts.controlPlaneUrl }
}
