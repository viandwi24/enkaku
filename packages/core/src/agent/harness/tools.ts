import { tool, jsonSchema, type ToolSet } from 'ai'
import { toJsonSchema, type ConnectorKind } from '@enkaku/protocol'
import type { AnyCoreCapability } from '../../capability/types'

/**
 * The capability registry → the harness's `ToolSet` (plan 76 §3.2, §4.1).
 *
 * §3.2's own pseudocode shows `execute: (args) => invoke(cap, ctx, args)` —
 * a tool call landing directly in `invoke()` from inside the AI SDK's own
 * tool-execution machinery. This module deliberately does NOT do that: it
 * declares each tool's schema (name, description, input) so the model can
 * SEE and CALL it, but supplies no `execute` at all, so the AI SDK never
 * auto-runs one.
 *
 * Reason, recorded rather than silently deviating: `agent_messages.seq` is
 * monotonic and `extractPendingToolCalls` (`harness/run.ts`, ported
 * unchanged from `agent/loop/context.ts`'s sibling) finds "what's still
 * pending" by scanning for a `tool_use` with no `tool_result` AFTER it in
 * seq order. The assistant's OWN message (the one carrying the `tool_use`
 * blocks) can only be persisted once its full content is known, which is
 * after `runAgentLoop`'s one step finishes — but the AI SDK begins running a
 * tool's `execute` concurrently with the REST of that same step's stream
 * (potentially before the assistant message is persisted), so an `execute`
 * that called `invoke()` and persisted its own `tool_result` synchronously
 * would race the assistant-message write and could land a lower `seq` than
 * the `tool_use` that supposedly produced it — corrupting the append-only
 * order `extractPendingToolCalls` depends on.
 *
 * So every tool call — not only ones needing approval — is deferred: the
 * harness step ends with the assistant's `tool_use` block(s) and NO
 * `tool_result`; `harness/run.ts`'s outer loop persists that assistant
 * message first, then resolves every pending call itself (approval gate,
 * activity admission, and `invoke()` — the SAME logic `agent/loop/run.ts`'s
 * `processPendingCalls` always used, moved here almost unchanged) before the
 * next model call. Every capability still reaches `invoke()` and ONLY
 * `invoke()` — criterion 2 — just not synchronously inside the AI SDK's own
 * tool step.
 *
 * Anthropic tool names must match `^[a-zA-Z0-9_-]{1,128}$` — capability ids
 * like `device.tap` are not legal, so dots become underscores on the wire;
 * the returned map resolves a wire name back to the real capability id.
 */
export interface ToolSetResult {
  tools: ToolSet
  /** wire tool name → capability id. */
  capabilityIdForToolName: Map<string, string>
}

/**
 * `connectorKind` is used for exactly one thing: Anthropic's prompt cache
 * breakpoint (plan 65 §3.4) lands on the LAST tool's own
 * `providerOptions.anthropic.cacheControl` — `agent/provider/anthropic.ts`'s
 * old `.stream()` used to place it there itself; now that `harness/run.ts`
 * hands this `ToolSet` straight to `runAgentLoop`, the breakpoint has to be
 * baked into the tool definitions themselves. OpenRouter (and any future
 * kind) gets no such annotation.
 */
export function buildToolSet(capabilities: AnyCoreCapability[], connectorKind?: ConnectorKind): ToolSetResult {
  const sorted = [...capabilities].sort((a, b) => a.id.localeCompare(b.id))
  const capabilityIdForToolName = new Map<string, string>()
  const tools: ToolSet = {}
  sorted.forEach((cap, index) => {
    const name = cap.id.replace(/\./g, '_')
    if (capabilityIdForToolName.has(name)) {
      throw new Error(`tool name collision: capability "${cap.id}" sanitises to the same wire name "${name}" as another tool`)
    }
    capabilityIdForToolName.set(name, cap.id)
    const isLast = index === sorted.length - 1
    tools[name] = tool({
      description: cap.description,
      inputSchema: jsonSchema(toJsonSchema(cap.input) as Record<string, unknown>),
      // No `execute` — see the module comment. The AI SDK declares the tool
      // to the model and leaves it unexecuted; `harness/run.ts` resolves it.
      ...(isLast && connectorKind === 'anthropic' ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } : {}),
    })
  })
  return { tools, capabilityIdForToolName }
}
