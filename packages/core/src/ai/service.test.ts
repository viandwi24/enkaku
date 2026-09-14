import { describe, expect, test } from 'bun:test'
import type { Connector } from '@enkaku/protocol'
import { EnkakuError } from '../util/errors'
import { createAiService, pickAiTarget } from './service'

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'c1',
    name: 'main',
    kind: 'anthropic',
    baseUrl: null,
    configured: true,
    hint: 'sk-…abcd',
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    createdAt: 0,
    ...overrides,
  }
}

describe('pickAiTarget — pure target selection (plan 317)', () => {
  test('null settings.connectorId picks the first connector (list order = newest first) that has a key', () => {
    const newest = connector({ id: 'newest', createdAt: 200 })
    const older = connector({ id: 'older', createdAt: 100 })
    const picked = pickAiTarget([newest, older], () => true, { connectorId: null, model: '' })
    expect(picked?.connectorId).toBe('newest')
  })

  test('null settings.connectorId skips a connector with no usable key', () => {
    const noKey = connector({ id: 'no-key' })
    const hasKey = connector({ id: 'has-key' })
    const picked = pickAiTarget([noKey, hasKey], (id) => id === 'has-key', { connectorId: null, model: '' })
    expect(picked?.connectorId).toBe('has-key')
  })

  test('no connector has a key ⇒ null', () => {
    const picked = pickAiTarget([connector()], () => false, { connectorId: null, model: '' })
    expect(picked).toBeNull()
  })

  test('an explicit connectorId is used outright when it has a key', () => {
    const a = connector({ id: 'a' })
    const b = connector({ id: 'b' })
    const picked = pickAiTarget([a, b], () => true, { connectorId: 'b', model: '' })
    expect(picked?.connectorId).toBe('b')
  })

  test('an explicit connectorId with no key is refused, never substituted for another connector', () => {
    const a = connector({ id: 'a' })
    const b = connector({ id: 'b' })
    const picked = pickAiTarget([a, b], (id) => id === 'a', { connectorId: 'b', model: '' })
    expect(picked).toBeNull()
  })

  test('an explicit connectorId naming an unknown connector is refused', () => {
    const picked = pickAiTarget([connector({ id: 'a' })], () => true, { connectorId: 'ghost', model: '' })
    expect(picked).toBeNull()
  })

  test('an empty settings.model falls back to the connector kind\'s own pinned model', () => {
    const picked = pickAiTarget([connector({ kind: 'anthropic' })], () => true, { connectorId: null, model: '' })
    expect(picked?.model).toBeTruthy()
    expect(picked?.kind).toBe('anthropic')
  })

  test('a non-empty settings.model always wins', () => {
    const picked = pickAiTarget([connector()], () => true, { connectorId: null, model: 'claude-custom' })
    expect(picked?.model).toBe('claude-custom')
  })
})

function fakeConnectors(list: Connector[], keys: Record<string, string | null>) {
  return {
    list: () => list,
    get: (id: string) => list.find((c) => c.id === id) ?? null,
    resolveApiKey: (id: string) => keys[id] ?? null,
  }
}

describe('createAiService — status() (plan 317)', () => {
  test('not configured: names the fix', () => {
    const service = createAiService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connectors: fakeConnectors([], {}) as any,
      settings: () => ({ connectorId: null, model: '' }),
    })
    const status = service.status()
    expect(status.configured).toBe(false)
    expect(status.reason).toBeTruthy()
    expect(status.connectorId).toBeNull()
  })

  test('configured: names the connector, kind and model', () => {
    const c = connector({ id: 'c1', name: 'main', kind: 'openrouter' })
    const service = createAiService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connectors: fakeConnectors([c], { c1: 'a-real-key' }) as any,
      settings: () => ({ connectorId: null, model: '' }),
    })
    const status = service.status()
    expect(status.configured).toBe(true)
    expect(status.connectorId).toBe('c1')
    expect(status.connectorName).toBe('main')
    expect(status.kind).toBe('openrouter')
    expect(status.reason).toBeNull()
  })
})

describe('createAiService — generate() refuses when not configured (plan 317)', () => {
  test('E_AI_NOT_CONFIGURED when no connector has a key', async () => {
    const service = createAiService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connectors: fakeConnectors([connector()], {}) as any,
      settings: () => ({ connectorId: null, model: '' }),
    })
    await expect(service.generate({ prompt: 'hi', maxOutputTokens: 400 })).rejects.toThrow(EnkakuError)
    await expect(service.generate({ prompt: 'hi', maxOutputTokens: 400 })).rejects.toMatchObject({ code: 'E_AI_NOT_CONFIGURED' })
  })
})
