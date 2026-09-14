import { AiGenerateInputSchema, AiGenerateOutputSchema, AiStatusInputSchema, AiStatusOutputSchema } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { defineCapability } from './types'

/**
 * `ai.status` / `ai.generate` (plan 317) — text generation over the farm's
 * existing connectors. A plugin never sees an API key or picks a provider
 * directly: it holds the `ai.generate` permission and calls one of these
 * two, exactly the one-line delegation `notify.send` (`capability/notify.ts`)
 * already demonstrates — everything that matters (which connector, which
 * model, the actual provider call) lives in `ai/service.ts`.
 */

export const aiStatus = defineCapability({
  id: 'ai.status',
  input: AiStatusInputSchema,
  output: AiStatusOutputSchema,
  permission: 'ai.generate',
  deadline: 10_000,
  effect: 'read',
  description: "Whether `ai.generate` is configured on this farm, and which connector/model it would use — check this before calling `ai.generate` so a refusal never surprises a caller who could have asked first.",
  handler: (ctx) => {
    if (!ctx.ai) throw new EnkakuError('E_NOT_SUPPORTED', 'ai.generate is not available on this host')
    return Promise.resolve(ctx.ai.status())
  },
})

export const aiGenerate = defineCapability({
  id: 'ai.generate',
  input: AiGenerateInputSchema,
  output: AiGenerateOutputSchema,
  permission: 'ai.generate',
  deadline: 120_000,
  effect: 'write',
  description:
    "Generate text through the farm's configured AI connector (Anthropic or OpenRouter — Settings → Connectors decides which, or `ai.status` names the automatic choice). Spends the connector's own budget, so it is a write, not a read. Refuses with E_AI_NOT_CONFIGURED when no connector has a usable key.",
  handler: (ctx, input) => {
    if (!ctx.ai) throw new EnkakuError('E_NOT_SUPPORTED', 'ai.generate is not available on this host')
    return ctx.ai.generate(input)
  },
})

export const AI_CAPABILITIES = [aiStatus, aiGenerate]
