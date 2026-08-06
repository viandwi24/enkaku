import type { ConnectorKind, ResolvedAgentConfig } from '@enkaku/protocol'

/**
 * Builds the `providerOptions` the harness's `LoopConfig.providerOptions`
 * (and therefore every `streamText` call `runAgentLoop` makes) is given —
 * the per-connector-kind fields `agent/provider/anthropic.ts`'s old
 * `buildAnthropicStreamParams`/`agent/provider/openrouter.ts`'s `.stream()`
 * used to set directly. Moving here rather than back into the provider
 * files keeps a provider adapter down to `listModels`/`countTokens`/
 * `languageModel` (plan 76 §3.5) — it no longer has an opinion about a
 * request's shape at all.
 *
 * `onCheckpoint` is used NOWHERE in this port. `harness/run.ts` calls
 * `runAgentLoop` once per model turn with `maxSteps: 1` — Enkaku's own outer
 * loop (`executeRun`) decides whether to continue, exactly as
 * `agent/loop/run.ts` always did, so the harness's own multi-step ceiling
 * and its audited checkpoint extension (`agent-core.ts`'s `evaluateCheckpoint`)
 * never come into play at all. This is deliberate, not an oversight: the
 * checkpoint auditor can EXTEND a step budget, and the earlier analysis
 * found it fails open in two places — a verdict that fails to parse, and an
 * auditor that throws — both falling through to "continue". With its
 * shipped settings that is 550 model turns. `docs/plans/00-overview.md`'s
 * rule for this repo is that no error path may produce more budget, so this
 * hook is never wired to anything (plan 76 §3.3, criterion 6).
 */
export function buildProviderOptions(kind: ConnectorKind, config: Pick<ResolvedAgentConfig, 'effort' | 'thinking'>): Record<string, Record<string, unknown>> {
  if (kind === 'anthropic') {
    return {
      anthropic: {
        // NEVER `{ type: 'enabled', budgetTokens }` — rejected with a 400 on Opus 5.
        thinking: config.thinking ? { type: 'adaptive' as const } : { type: 'disabled' as const },
        effort: config.effort,
        fallbacks: 'default' as const,
      },
    }
  }
  if (kind === 'openrouter') {
    return config.thinking ? { openrouter: { reasoning: { enabled: true, effort: config.effort } } } : {}
  }
  return {}
}
