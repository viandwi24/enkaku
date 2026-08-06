import { describe, expect, test } from 'bun:test'
import { AgentDefaultsSchema, AgentSettingsSchema, resolveAgentConfig } from './agent'

const defaults = () => AgentDefaultsSchema.parse({})
const noOverrides = () => AgentSettingsSchema.parse({})

function agent(overrides: { connectorId?: string | null; model?: string | null; systemPrompt?: string | null; settings?: unknown } = {}) {
  return {
    connectorId: overrides.connectorId ?? null,
    model: overrides.model ?? null,
    systemPrompt: overrides.systemPrompt ?? null,
    settings: AgentSettingsSchema.parse(overrides.settings ?? {}),
  }
}

describe('resolveAgentConfig', () => {
  test('an agent with no overrides resolves to every farm default', () => {
    const farm = { agentDefaults: defaults() }
    const resolved = resolveAgentConfig(farm, agent())
    expect(resolved).toEqual({
      connectorId: null,
      model: farm.agentDefaults.model,
      systemPrompt: farm.agentDefaults.systemPrompt,
      effort: farm.agentDefaults.effort,
      thinking: farm.agentDefaults.thinking,
      maxOutputTokens: farm.agentDefaults.maxOutputTokens,
      maxSteps: farm.agentDefaults.maxSteps,
      maxRunSeconds: farm.agentDefaults.maxRunSeconds,
      compactAtRatio: farm.agentDefaults.compactAtRatio,
      maxConcurrentRuns: farm.agentDefaults.maxConcurrentRuns,
      maxImagesPerRequest: farm.agentDefaults.maxImagesPerRequest,
      maxImageBytes: farm.agentDefaults.maxImageBytes,
    })
  })

  test('overriding one field changes only that field', () => {
    const farm = { agentDefaults: defaults() }
    const resolved = resolveAgentConfig(farm, agent({ settings: { maxSteps: 12 } }))
    expect(resolved.maxSteps).toBe(12)
    expect(resolved.maxRunSeconds).toBe(farm.agentDefaults.maxRunSeconds)
    expect(resolved.effort).toBe(farm.agentDefaults.effort)
    expect(resolved.model).toBe(farm.agentDefaults.model)
  })

  test('every field can be independently overridden', () => {
    const farm = { agentDefaults: defaults() }
    const a = agent({
      connectorId: 'conn-1',
      model: 'claude-sonnet-5',
      systemPrompt: 'You are a triage agent.',
      settings: {
        effort: 'high',
        thinking: false,
        maxOutputTokens: 42,
        maxSteps: 5,
        maxRunSeconds: 30,
        compactAtRatio: 0.5,
        maxConcurrentRuns: 3,
        maxImagesPerRequest: 4,
        maxImageBytes: 1024,
      },
    })
    const resolved = resolveAgentConfig(farm, a)
    expect(resolved).toEqual({
      connectorId: 'conn-1',
      model: 'claude-sonnet-5',
      systemPrompt: 'You are a triage agent.',
      effort: 'high',
      thinking: false,
      maxOutputTokens: 42,
      maxSteps: 5,
      maxRunSeconds: 30,
      compactAtRatio: 0.5,
      maxConcurrentRuns: 3,
      maxImagesPerRequest: 4,
      maxImageBytes: 1024,
    })
  })

  test('a partial override leaves the rest inherited', () => {
    const farm = { agentDefaults: defaults() }
    const resolved = resolveAgentConfig(farm, agent({ model: 'claude-sonnet-5', settings: { effort: 'low' } }))
    expect(resolved.model).toBe('claude-sonnet-5')
    expect(resolved.effort).toBe('low')
    expect(resolved.systemPrompt).toBe(farm.agentDefaults.systemPrompt)
    expect(resolved.thinking).toBe(farm.agentDefaults.thinking)
    expect(resolved.maxSteps).toBe(farm.agentDefaults.maxSteps)
  })

  // §7's named case: a field explicitly set to a falsy value must NOT
  // silently inherit the default. `maxSteps: 0` is the plan's own example —
  // "0 remaining steps", a real and meaningful value, not "unset".
  test('maxSteps: 0 is honoured, not treated as unset', () => {
    const farm = { agentDefaults: defaults() }
    expect(farm.agentDefaults.maxSteps).not.toBe(0) // sanity: the default itself is non-zero
    const resolved = resolveAgentConfig(farm, agent({ settings: { maxSteps: 0 } }))
    expect(resolved.maxSteps).toBe(0)
  })

  test('thinking: false is honoured, not treated as unset (another falsy override)', () => {
    const farm = { agentDefaults: defaults() }
    expect(farm.agentDefaults.thinking).toBe(true) // sanity: default is true
    const resolved = resolveAgentConfig(farm, agent({ settings: { thinking: false } }))
    expect(resolved.thinking).toBe(false)
  })

  test('compactAtRatio: 0 is honoured, not treated as unset', () => {
    const farm = { agentDefaults: defaults() }
    const resolved = resolveAgentConfig(farm, agent({ settings: { compactAtRatio: 0 } }))
    expect(resolved.compactAtRatio).toBe(0)
  })

  test('an unset AgentSettings field is undefined, not defaulted, before resolution', () => {
    const settings = noOverrides()
    expect(settings.maxSteps).toBeUndefined()
    expect(settings.effort).toBeUndefined()
  })

  test('two agents on two connectors and two models resolve independently', () => {
    const farm = { agentDefaults: defaults() }
    const cheap = agent({ connectorId: 'conn-cheap', model: 'claude-haiku-4-5' })
    const expensive = agent({ connectorId: 'conn-expensive', model: 'claude-opus-5', settings: { effort: 'high' } })
    const resolvedCheap = resolveAgentConfig(farm, cheap)
    const resolvedExpensive = resolveAgentConfig(farm, expensive)
    expect(resolvedCheap.connectorId).toBe('conn-cheap')
    expect(resolvedCheap.model).toBe('claude-haiku-4-5')
    expect(resolvedExpensive.connectorId).toBe('conn-expensive')
    expect(resolvedExpensive.model).toBe('claude-opus-5')
    expect(resolvedExpensive.effort).toBe('high')
    expect(resolvedCheap.effort).toBe(farm.agentDefaults.effort)
  })
})
