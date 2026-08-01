import { join } from 'node:path'
import { z } from 'zod'

/**
 * State agent = satu file JSON (plan 11 §4.1). Tidak ada SQLite di agent:
 * device registry milik control plane; agent hanya melaporkan apa yang dia
 * lihat dari track-devices.
 */
export const AgentStateSchema = z.object({
  agentId: z.string(),
  /** Secret jangka panjang hasil enrollment (hash-nya disimpan di CP). */
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
 * Enrollment sekali jalan: tukar token sekali-pakai dengan credential
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
    throw new Error(body.error?.message ?? `enrollment gagal: HTTP ${res.status}`)
  }
  return { agentId: body.agentId, credential: body.credential, controlPlaneUrl: opts.controlPlaneUrl }
}
