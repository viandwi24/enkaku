import { z } from 'zod'

/**
 * What an agent *is* (plan 65) — a stored, editable record with its own
 * model, provider connector, credentials-adjacent connector reference,
 * system prompt, context budgets, tool allowlist, device grants and
 * workspace scope. Farm defaults live in `FarmSettings.agentDefaults`
 * (`./settings.ts`); an agent overrides any of them via `settings` below.
 * `resolveAgentConfig` is the ONE place the two are merged (§4.2) — nothing
 * downstream reads `agent.settings` directly.
 *
 * This module ships no LLM call: it is configuration and its resolution
 * only. Plan 66 is the one that actually runs an agent.
 */

export const EffortSchema = z
  .enum(['low', 'medium', 'high'])
  .describe('How hard the model works per turn — a plain three-way choice, not a token budget.')
export type Effort = z.infer<typeof EffortSchema>

/**
 * Farm-wide defaults for agent model, provider, and budgets (§3.1, §3.7) —
 * `FarmSettings.agentDefaults` is literally this schema, exactly like
 * `FarmSettings.defaults` reuses `DeviceSettingsSchema` for devices.
 */
export const AgentDefaultsSchema = z
  .object({
    connectorId: z
      .string()
      .nullable()
      .default(null)
      .describe('Connector used by an agent that does not name its own. Null until one is configured.')
      .meta({ title: 'Default connector' }),
    model: z
      .string()
      .min(1)
      .default('claude-opus-5')
      .describe('Model id used when an agent does not name its own. Model ids carry no date suffix.')
      .meta({ title: 'Default model' }),
    systemPrompt: z
      .string()
      .default('')
      .describe('System prompt used when an agent does not set its own.')
      .meta({ title: 'Default system prompt' }),
    effort: EffortSchema.default('medium').meta({ title: 'Effort' }),
    thinking: z
      .boolean()
      .default(true)
      .describe('Extended thinking (adaptive) on by default.')
      .meta({ title: 'Extended thinking' }),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .default(1_000_000)
      .describe('Total output tokens allowed across one run.')
      .meta({ title: 'Max output tokens' }),
    maxSteps: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe('Model turns allowed in one run. Fails closed: reaching it stops the run with a named reason.')
      .meta({ title: 'Max steps' }),
    maxRunSeconds: z
      .number()
      .int()
      .positive()
      .default(600)
      .describe('Wall-clock budget for one run, in seconds.')
      .meta({ title: 'Max run seconds' }),
    compactAtRatio: z
      .number()
      .min(0)
      .max(1)
      .default(0.7)
      .describe("Fraction of the model's own context window (from GET /v1/models) at which the run compacts.")
      .meta({ title: 'Compact at ratio' }),
    maxConcurrentRuns: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Runs allowed at once for this agent.')
      .meta({ title: 'Max concurrent runs' }),
    /** Plan 70 §3.6 — images kept in the PROVIDER VIEW of a request; the oldest are dropped first and replaced by a text placeholder. The stored messages are untouched. */
    maxImagesPerRequest: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe('Images kept in the provider view of one request. Oldest dropped first, replaced by a placeholder.')
      .meta({ title: 'Max images per request' }),
    /** Plan 70 §3.6 — per-image cap, matching the provider's own hard limit (Anthropic: 5 MiB). An image over this is refused by name (`E_IMAGE_TOO_LARGE`), never silently dropped or truncated. */
    maxImageBytes: z
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024)
      .describe('Per-image byte cap, matching the provider cap. An oversized image is refused by name, not truncated.')
      .meta({ title: 'Max image bytes' }),
  })
  .meta({
    title: 'Agent defaults',
    description: 'Farm-wide defaults for agent model, provider, and budgets — overridden per agent (plan 65 §3.1).',
  })
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>

/**
 * Per-agent overrides (§3.1). Every field is OPTIONAL and carries NO
 * `.default()` — an absent field means "follow the farm default", never a
 * value of its own. This is what makes `maxSteps: 0` distinguishable from
 * "not set": `agent.settings.maxSteps ?? farm.agentDefaults.maxSteps` only
 * falls back on `null`/`undefined`, so an explicit `0` survives (§7's
 * classic-bug test).
 */
export const AgentSettingsSchema = z
  .object({
    effort: EffortSchema.optional().meta({ title: 'Effort' }),
    thinking: z.boolean().optional().describe('Extended thinking (adaptive) for this agent.').meta({ title: 'Extended thinking' }),
    maxOutputTokens: z.number().int().positive().optional().meta({ title: 'Max output tokens' }),
    maxSteps: z.number().int().min(0).optional().meta({ title: 'Max steps' }),
    maxRunSeconds: z.number().int().positive().optional().meta({ title: 'Max run seconds' }),
    compactAtRatio: z.number().min(0).max(1).optional().meta({ title: 'Compact at ratio' }),
    maxConcurrentRuns: z.number().int().min(1).optional().meta({ title: 'Max concurrent runs' }),
    maxImagesPerRequest: z.number().int().min(0).optional().meta({ title: 'Max images per request' }),
    maxImageBytes: z.number().int().positive().optional().meta({ title: 'Max image bytes' }),
  })
  .meta({
    title: 'Agent settings',
    description: 'Per-agent overrides. An unset field follows the farm default (plan 65 §3.1).',
  })
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/** The resolved shape a runtime ever sees (§4.2) — every field concrete, no optionals. */
export const ResolvedAgentConfigSchema = z.object({
  connectorId: z.string().nullable(),
  model: z.string(),
  systemPrompt: z.string(),
  effort: EffortSchema,
  thinking: z.boolean(),
  maxOutputTokens: z.number().int(),
  maxSteps: z.number().int(),
  maxRunSeconds: z.number().int(),
  compactAtRatio: z.number(),
  maxConcurrentRuns: z.number(),
  maxImagesPerRequest: z.number().int(),
  maxImageBytes: z.number().int(),
})
export type ResolvedAgentConfig = z.infer<typeof ResolvedAgentConfigSchema>

/** Path prefixes an actor may read/write in the workspace (plan 64 §3.2). */
export const WorkspaceScopeSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
})
export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>

/** `[a-z0-9]` first, then `[a-z0-9-]`, 1–64 chars — the workspace home (`/agents/<slug>/`) and @mentions both key off this. */
export const AgentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, numbers, and hyphens only, starting with a letter or number')

/**
 * The stored record (§4.1's `ai_agents` table, parsed). `deviceGrants` empty
 * means ALL devices, never none (§3.5) — stated here, in the API, and in the
 * UI, all three, because an ambiguity here is an ambiguity about which
 * phones a model can touch.
 */
export const AgentSchema = z.object({
  id: z.string(),
  slug: AgentSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  colour: z.string().nullable(),
  enabled: z.boolean(),
  /** Null ⇒ farm default (`agentDefaults.connectorId`). */
  connectorId: z.string().nullable(),
  /** Null ⇒ farm default (`agentDefaults.model`). */
  model: z.string().nullable(),
  /** Null ⇒ farm default (`agentDefaults.systemPrompt`). */
  systemPrompt: z.string().nullable(),
  settings: AgentSettingsSchema,
  /** Registry capability ids this agent may call — validated against the live registry at write time. */
  tools: z.array(z.string()),
  /**
   * Registry capability ids that pause for a human decision even when the
   * capability's own `effect` is not `destructive` (plan 66 §3.6) — an
   * operator's own added caution on top of the registry's default gate.
   * Validated against the live registry at write time, same as `tools`.
   */
  requiresApproval: z.array(z.string()),
  /** Device ids this agent may reach. EMPTY MEANS ALL DEVICES (§3.5) — never "no devices". */
  deviceGrants: z.array(z.string()),
  workspaceScope: WorkspaceScopeSchema,
  /** ACL permission names this agent acts with — capped at its owner's own set, at write time AND at execution (§3.5). */
  permissions: z.array(z.string()),
  /**
   * Plan 67 §3.3 — whether a message arriving while this agent's run has ALREADY finished starts a
   * NEW run. `'on-child-result'` (the default) wakes only for a spawn result the agent itself was
   * waiting on — a completion it asked for is exactly the notification it wanted. `'always'` also
   * wakes for a plain `agent.send`/`agent.reply` message; `'never'` only ever appends to the thread.
   * The plan's own reasoning: an unsolicited message waking an idle agent is how a farm develops
   * perpetual motion, so the safer default only fires for the one case that is never unsolicited.
   */
  wakeOnMessage: z.enum(['on-child-result', 'always', 'never']),
  ownerId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Agent = z.infer<typeof AgentSchema>

/** `POST /api/agents` body — everything but `id`/`ownerId`/timestamps, which the server assigns. */
export const AgentWriteInputSchema = z.object({
  slug: AgentSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  colour: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  connectorId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  settings: AgentSettingsSchema.optional(),
  tools: z.array(z.string()).optional(),
  requiresApproval: z.array(z.string()).optional(),
  deviceGrants: z.array(z.string()).optional(),
  workspaceScope: WorkspaceScopeSchema.optional(),
  permissions: z.array(z.string()).optional(),
  wakeOnMessage: z.enum(['on-child-result', 'always', 'never']).optional(),
})
export type AgentWriteInput = z.infer<typeof AgentWriteInputSchema>

/** `PATCH /api/agents/:id` body — the slug cannot change (it is the workspace home). */
export const AgentUpdateInputSchema = AgentWriteInputSchema.omit({ slug: true }).partial()
export type AgentUpdateInput = z.infer<typeof AgentUpdateInputSchema>

/**
 * Farm defaults plus one agent's overrides, merged in the ONE place this
 * happens (§4.2). `farm` is typed structurally rather than as the full
 * `FarmSettings` so this module never imports `./settings` (which imports
 * this module for `AgentDefaultsSchema` — importing back would cycle).
 */
export function resolveAgentConfig(farm: { agentDefaults: AgentDefaults }, agent: Pick<Agent, 'connectorId' | 'model' | 'systemPrompt' | 'settings'>): ResolvedAgentConfig {
  const defaults = farm.agentDefaults
  const s = agent.settings
  return {
    connectorId: agent.connectorId ?? defaults.connectorId,
    model: agent.model ?? defaults.model,
    systemPrompt: agent.systemPrompt ?? defaults.systemPrompt,
    // `??` (nullish coalescing), never `||` — a field explicitly set to a
    // falsy value (`maxSteps: 0`) must NOT fall back to the default. `??`
    // only falls back on `null`/`undefined`, which is exactly what an
    // unset `AgentSettingsSchema` field parses to.
    effort: s.effort ?? defaults.effort,
    thinking: s.thinking ?? defaults.thinking,
    maxOutputTokens: s.maxOutputTokens ?? defaults.maxOutputTokens,
    maxSteps: s.maxSteps ?? defaults.maxSteps,
    maxRunSeconds: s.maxRunSeconds ?? defaults.maxRunSeconds,
    compactAtRatio: s.compactAtRatio ?? defaults.compactAtRatio,
    maxConcurrentRuns: s.maxConcurrentRuns ?? defaults.maxConcurrentRuns,
    maxImagesPerRequest: s.maxImagesPerRequest ?? defaults.maxImagesPerRequest,
    maxImageBytes: s.maxImageBytes ?? defaults.maxImageBytes,
  }
}

// ---------------------------------------------------------------------------
// Connectors — a configured provider endpoint plus credential (§3.2, §3.6).
// ---------------------------------------------------------------------------

export const ConnectorKindSchema = z.enum(['anthropic', 'openrouter'])
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>

export const ConnectorStatusSchema = z.enum(['unknown', 'ok', 'unauthenticated', 'unreachable'])
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>

/**
 * The public shape of a connector — NEVER carries the credential itself
 * (§3.6, criterion 4). `configured`/`hint` are the only signal a caller gets
 * about whether (and roughly which) secret is stored.
 */
export const ConnectorSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  kind: ConnectorKindSchema,
  baseUrl: z.string().nullable(),
  configured: z.boolean(),
  /** A masked tail of the stored credential, e.g. "sk-ant-…7Xq2" — never the value itself. Null when unconfigured. */
  hint: z.string().nullable(),
  status: ConnectorStatusSchema,
  statusMessage: z.string().nullable(),
  checkedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
})
export type Connector = z.infer<typeof ConnectorSchema>

/** `POST /api/connectors` — `credential` is write-only and never echoed back. */
export const ConnectorWriteInputSchema = z.object({
  name: z.string().min(1),
  kind: ConnectorKindSchema,
  baseUrl: z.string().url().nullable().optional(),
  credential: z.string().min(1).optional(),
})
export type ConnectorWriteInput = z.infer<typeof ConnectorWriteInputSchema>

export const ConnectorUpdateInputSchema = ConnectorWriteInputSchema.omit({ kind: true }).partial()
export type ConnectorUpdateInput = z.infer<typeof ConnectorUpdateInputSchema>

export const ModelInfoSchema = z.object({
  id: z.string(),
  contextWindow: z.number().int().positive(),
  supportsThinking: z.boolean(),
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

/** `GET /api/connectors/:id/models` — `fallback: true` names a pinned list served because the live call failed (criterion 7). */
export const ModelListResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  fallback: z.boolean(),
})
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>

export const ConnectorTestResultSchema = z.object({
  status: ConnectorStatusSchema,
  message: z.string().nullable(),
})
export type ConnectorTestResult = z.infer<typeof ConnectorTestResultSchema>
