import { z } from 'zod'
import { AgentDefaultsSchema } from './agent'
import { JsonSchemaNodeSchema } from './api/json-schema'

/**
 * Farm-level agent settings (MVP 12 §5, plan 212 §4.7) - rendered by the
 * Agents page's Settings tab (plan 220), not by farm Settings.
 * `AgentDefaultsSchema` is unchanged; only its home moves out of
 * `FarmSettingsSchema`.
 *
 * Named `FarmAgentSettingsSchema`, not `AgentSettingsSchema`: `./agent.ts`
 * already exports `AgentSettingsSchema`/`AgentSettings` for ONE agent's own
 * per-agent settings block (`Agent.settings`) - a real, pre-existing name
 * this plan must not collide with.
 */
export const FarmAgentSettingsSchema = z.object({
  defaults: AgentDefaultsSchema.default(() => AgentDefaultsSchema.parse({})).meta({
    title: 'Agent defaults',
    description: 'Model, provider connector, and budgets a new agent inherits until it overrides them.',
  }),
  scheduled: z
    .object({
      spendCapOutputTokensPer24h: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe('Farm-wide output tokens allowed for SCHEDULED agent runs in a rolling 24 hours. Never applies to an interactive chat run.')
        .meta({ title: 'Spend cap - scheduled runs only' }),
      maxConcurrentScheduledRuns: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe('Scheduled agent runs allowed at once, farm-wide.')
        .meta({ title: 'Max concurrent scheduled runs' }),
    })
    .default({ spendCapOutputTokensPer24h: null, maxConcurrentScheduledRuns: 3 })
    .meta({ title: 'Scheduled agents' }),
})
export type FarmAgentSettings = z.infer<typeof FarmAgentSettingsSchema>
export const defaultFarmAgentSettings = (): FarmAgentSettings => FarmAgentSettingsSchema.parse({})

export const FarmAgentSettingsResponseSchema = z.object({ settings: FarmAgentSettingsSchema, schema: JsonSchemaNodeSchema })
export const UpdateFarmAgentSettingsResponseSchema = z.object({ settings: FarmAgentSettingsSchema })
