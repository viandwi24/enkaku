import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { AgentDefaultsSchema, resolveAgentConfig } from '@enkaku/protocol'
import { buildCoreCapabilityRegistry } from '../capability'
import { openDb, runMigrations, type Db } from '../db'
import { users } from '../db/schema'
import { createAgentStore } from './agent-store'
import { createConnectorStore } from './connector-store'

/**
 * Plan 65 §7's integration cases: create an agent, override two settings,
 * read it back resolved; create two agents on two connectors and confirm
 * independent resolution. Exercises the real stores end to end (SQLite +
 * the real capability registry + the real secrets store), not just the
 * pure `resolveAgentConfig` unit tests in `@enkaku/protocol`.
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  db.insert(users).values({ id: 'u1', email: 'u1@test', role: 'operator', passwordHash: null, createdAt: new Date() }).run()
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-agent-integration-test-'))
  const agentStore = createAgentStore({ db, registry: buildCoreCapabilityRegistry() })
  const connectorStore = createConnectorStore({ db, dataDir })
  return { db, agentStore, connectorStore }
}

describe('integration — create, override, read back resolved (plan 65 §7)', () => {
  test('an agent with two overridden settings resolves with exactly those two changed', () => {
    const { agentStore } = setUp()
    const farm = { agentDefaults: AgentDefaultsSchema.parse({}) }
    const created = agentStore.create({ slug: 'overrider', name: 'Overrider', settings: { maxSteps: 7, effort: 'high' } }, 'u1')

    const readBack = agentStore.get(created.id)
    expect(readBack).not.toBeNull()
    const resolved = resolveAgentConfig(farm, readBack!)
    expect(resolved.maxSteps).toBe(7)
    expect(resolved.effort).toBe('high')
    // Everything else still follows the farm default.
    expect(resolved.model).toBe(farm.agentDefaults.model)
    expect(resolved.maxRunSeconds).toBe(farm.agentDefaults.maxRunSeconds)
    expect(resolved.thinking).toBe(farm.agentDefaults.thinking)
  })

  test('two agents on two different connectors and models resolve independently, both persisted and read back', () => {
    const { agentStore, connectorStore } = setUp()
    const farm = { agentDefaults: AgentDefaultsSchema.parse({}) }

    const cheapConnector = connectorStore.create({ name: 'cheap-connector', kind: 'anthropic', credential: 'sk-ant-cheap' })
    const expensiveConnector = connectorStore.create({ name: 'expensive-connector', kind: 'anthropic', credential: 'sk-ant-expensive' })

    const cheapAgent = agentStore.create({ slug: 'cheap-agent', name: 'Cheap Agent', connectorId: cheapConnector.id, model: 'claude-haiku-4-5' }, 'u1')
    const expensiveAgent = agentStore.create(
      { slug: 'expensive-agent', name: 'Expensive Agent', connectorId: expensiveConnector.id, model: 'claude-opus-5', settings: { effort: 'high' } },
      'u1',
    )

    const cheapReadBack = agentStore.get(cheapAgent.id)!
    const expensiveReadBack = agentStore.get(expensiveAgent.id)!

    const cheapResolved = resolveAgentConfig(farm, cheapReadBack)
    const expensiveResolved = resolveAgentConfig(farm, expensiveReadBack)

    expect(cheapResolved.connectorId).toBe(cheapConnector.id)
    expect(cheapResolved.model).toBe('claude-haiku-4-5')
    expect(cheapResolved.effort).toBe(farm.agentDefaults.effort) // inherited

    expect(expensiveResolved.connectorId).toBe(expensiveConnector.id)
    expect(expensiveResolved.model).toBe('claude-opus-5')
    expect(expensiveResolved.effort).toBe('high')

    // Neither resolution leaked into the other.
    expect(cheapResolved.connectorId).not.toBe(expensiveResolved.connectorId)
    expect(cheapResolved.model).not.toBe(expensiveResolved.model)
  })
})
