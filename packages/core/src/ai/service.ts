import { generateText } from 'ai'
import type { AiGenerateInput, AiGenerateOutput, AiStatusOutput, Connector, ConnectorKind } from '@enkaku/protocol'
import { createProviderAdapter, pinnedModelFallbackFor } from '../agent/provider'
import type { ConnectorStore } from '../agent/connector-store'
import { EnkakuError } from '../util/errors'

/**
 * `ai.status` / `ai.generate` (plan 317) — text generation over the farm's
 * EXISTING connectors. A plugin never sees an API key: it holds the
 * `ai.generate` permission and calls the capability; this service is the
 * one place that resolves a connector, decrypts its credential
 * (`ConnectorStore.resolveApiKey`, never done here directly), and drives
 * `createProviderAdapter(kind, ...).languageModel(modelId)` through the
 * `ai` package's own `generateText`.
 */

export interface AiTargetSettings {
  connectorId: string | null
  model: string
}

export interface AiTarget {
  connectorId: string
  connectorName: string
  kind: ConnectorKind
  model: string
}

/**
 * PURE — picks which connector and model `ai.generate` uses, given the
 * connector list (already newest-first, `ConnectorStore.list()`'s own
 * order), a predicate for "does this connector have a usable key" (the
 * impure half, injected so this function stays pure and independently
 * testable), and the farm's `ai` settings.
 *
 * `settings.connectorId` set names an EXACT connector: if it exists and has
 * a key, it is used outright; anything else about it (a stale id, a key
 * that was removed) is "not configured" rather than a silent substitution —
 * an operator who named a connector on purpose gets an honest refusal, not
 * a different bill. `settings.connectorId: null` (the default) picks the
 * first connector, in list order, that has a usable key.
 *
 * The model is `settings.model` when non-empty, otherwise the picked
 * connector's own first pinned fallback model.
 */
export function pickAiTarget(connectors: Connector[], keyOf: (connectorId: string) => boolean, settings: AiTargetSettings): AiTarget | null {
  const modelFor = (kind: ConnectorKind): string => {
    if (settings.model) return settings.model
    return pinnedModelFallbackFor(kind)[0]?.id ?? ''
  }

  if (settings.connectorId !== null) {
    const connector = connectors.find((c) => c.id === settings.connectorId)
    if (!connector || !keyOf(connector.id)) return null
    return { connectorId: connector.id, connectorName: connector.name, kind: connector.kind, model: modelFor(connector.kind) }
  }

  const connector = connectors.find((c) => keyOf(c.id))
  if (!connector) return null
  return { connectorId: connector.id, connectorName: connector.name, kind: connector.kind, model: modelFor(connector.kind) }
}

export interface AiServiceDeps {
  connectors: ConnectorStore
  settings: () => AiTargetSettings
  /** Injectable transport, exactly like `ConnectorStoreDeps.fetch` — never hits the network when a fake is supplied. */
  fetch?: typeof fetch
}

export interface AiService {
  status(): AiStatusOutput
  generate(input: AiGenerateInput): Promise<AiGenerateOutput>
}

function resolveTarget(deps: AiServiceDeps): AiTarget | null {
  const connectors = deps.connectors.list()
  return pickAiTarget(connectors, (id) => deps.connectors.resolveApiKey(id) !== null, deps.settings())
}

export function createAiService(deps: AiServiceDeps): AiService {
  return {
    status() {
      const target = resolveTarget(deps)
      if (!target) {
        return {
          configured: false,
          connectorId: null,
          connectorName: null,
          kind: null,
          model: null,
          reason: 'Add an OpenRouter or Anthropic connector on the Agents page, with a key.',
        }
      }
      return {
        configured: true,
        connectorId: target.connectorId,
        connectorName: target.connectorName,
        kind: target.kind,
        model: target.model,
        reason: null,
      }
    },

    async generate(input) {
      const target = resolveTarget(deps)
      if (!target) {
        throw new EnkakuError('E_AI_NOT_CONFIGURED', 'no connector is configured for ai.generate — add one on the Agents page')
      }
      const apiKey = deps.connectors.resolveApiKey(target.connectorId)
      if (!apiKey) {
        throw new EnkakuError('E_AI_NOT_CONFIGURED', 'the configured connector has no usable key')
      }
      const connector = deps.connectors.get(target.connectorId)
      const adapter = createProviderAdapter(target.kind, { apiKey, baseUrl: connector?.baseUrl ?? null, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      try {
        const result = await generateText({
          model: adapter.languageModel(target.model),
          prompt: input.prompt,
          ...(input.system ? { system: input.system } : {}),
          maxOutputTokens: input.maxOutputTokens,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        })
        return { text: result.text, connectorId: target.connectorId, connectorName: target.connectorName, model: target.model }
      } catch (err) {
        throw new EnkakuError('E_AI_FAILED', err instanceof Error ? err.message : String(err), err)
      }
    },
  }
}
