import { z } from 'zod'
import { AgentSchema } from '../agent'

/** `GET /api/agents` (`packages/core/src/api/agents.ts`). */
export const ListAgentsResponseSchema = z.object({ agents: z.array(AgentSchema) })

/** `GET/POST/PATCH /api/agents(/:id)` — every one of those routes returns `{agent}`. */
export const AgentResponseSchema = z.object({ agent: AgentSchema })
