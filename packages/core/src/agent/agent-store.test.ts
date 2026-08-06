import { describe, expect, test } from 'bun:test'
import { buildCoreCapabilityRegistry } from '../capability'
import { openDb, runMigrations, type Db } from '../db'
import { devices, users } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { agentCanReachDevice, createAgentStore, defaultWorkspaceScope, effectivePermissions } from './agent-store'

const registry = buildCoreCapabilityRegistry()

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, store: createAgentStore({ db: opened.db, registry }) }
}

function seedUser(db: Db, id: string, role: 'admin' | 'operator') {
  db.insert(users).values({ id, email: `${id}@example.com`, role, passwordHash: null, createdAt: new Date() }).run()
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: id, serial: id, label: id, ownerId: null }).run()
}

describe('agent store — create/read (plan 65 §4.1, §4.5, §5.5)', () => {
  test('creates an agent and reads it back', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'triage', name: 'Triage bot' }, 'u1')
    expect(agent.slug).toBe('triage')
    expect(agent.name).toBe('Triage bot')
    expect(agent.ownerId).toBe('u1')
    expect(store.get(agent.id)).toEqual(agent)
  })

  test('a new agent with no explicit workspaceScope gets write /agents/<slug>/, read / (criterion 11)', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'my-agent', name: 'My Agent' }, 'u1')
    expect(agent.workspaceScope).toEqual(defaultWorkspaceScope('my-agent'))
    expect(agent.workspaceScope.read).toEqual(['/'])
    expect(agent.workspaceScope.write).toEqual(['/agents/my-agent/'])
  })

  test('a new agent with no device grants has an empty deviceGrants array — meaning ALL devices (criterion 10)', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a1', name: 'A1' }, 'u1')
    expect(agent.deviceGrants).toEqual([])
    expect(agentCanReachDevice(agent, 'any-device-id-at-all')).toBe(true)
  })

  test('an agent granted specific devices can reach only those (criterion 10)', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    seedDevice(db, 'dev-1')
    seedDevice(db, 'dev-2')
    const agent = store.create({ slug: 'a2', name: 'A2', deviceGrants: ['dev-1'] }, 'u1')
    expect(agentCanReachDevice(agent, 'dev-1')).toBe(true)
    expect(agentCanReachDevice(agent, 'dev-2')).toBe(false)
  })

  test('a duplicate slug is refused', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    store.create({ slug: 'dup', name: 'First' }, 'u1')
    expect(() => store.create({ slug: 'dup', name: 'Second' }, 'u1')).toThrow(EnkakuError)
  })
})

describe('agent store — write-time validation (§4.5)', () => {
  test('an unknown capability id in tools is refused with a 400-shaped error naming it', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    try {
      store.create({ slug: 'a3', name: 'A3', tools: ['not.a.real.capability'] }, 'u1')
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('E_UNKNOWN_CAPABILITY')
      expect((err as EnkakuError).message).toContain('not.a.real.capability')
    }
  })

  test('a real capability id in tools is accepted', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const anyCap = registry.all()[0]
    if (!anyCap) throw new Error('registry has no capabilities to test against')
    const agent = store.create({ slug: 'a4', name: 'A4', tools: [anyCap.id] }, 'u1')
    expect(agent.tools).toEqual([anyCap.id])
  })

  test('an unknown device id in deviceGrants is refused', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    expect(() => store.create({ slug: 'a5', name: 'A5', deviceGrants: ['does-not-exist'] }, 'u1')).toThrow(EnkakuError)
    try {
      store.create({ slug: 'a5', name: 'A5', deviceGrants: ['does-not-exist'] }, 'u1')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_UNKNOWN_DEVICE')
    }
  })

  test('a workspace scope prefix outside the tree (relative, ".." segment) is refused', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    expect(() =>
      store.create({ slug: 'a6', name: 'A6', workspaceScope: { read: ['/'], write: ['/../etc/'] } }, 'u1'),
    ).toThrow(EnkakuError)
  })

  test('an operator cannot give an agent a permission they do not hold (criterion 9, refused at creation)', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    try {
      // settings.manage is admin-only under the static ACL — an operator owner cannot grant it.
      store.create({ slug: 'a7', name: 'A7', permissions: ['settings.manage'] }, 'u1')
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('E_OVER_PRIVILEGED')
    }
  })

  test('an admin CAN give an agent an admin-only permission', () => {
    const { db, store } = setUp()
    seedUser(db, 'admin1', 'admin')
    const agent = store.create({ slug: 'a8', name: 'A8', permissions: ['settings.manage'] }, 'admin1')
    expect(agent.permissions).toEqual(['settings.manage'])
  })

  test('an unrecognised permission NAME (typo) is refused distinctly from over-privilege', () => {
    const { db, store } = setUp()
    seedUser(db, 'admin1', 'admin')
    try {
      store.create({ slug: 'a9', name: 'A9', permissions: ['settingz.manage'] }, 'admin1')
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('E_UNKNOWN_PERMISSION')
    }
  })
})

describe('effectivePermissions — live capping at execution (criterion 9)', () => {
  test('an operator-held permission is granted; the agent has it', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a10', name: 'A10', permissions: ['fs.write'] }, 'u1')
    expect(effectivePermissions(agent, 'operator')).toEqual(['fs.write'])
  })

  test('demoting the owner after creation narrows the agent live, without a second write', () => {
    const { db, store } = setUp()
    seedUser(db, 'admin1', 'admin')
    const agent = store.create({ slug: 'a11', name: 'A11', permissions: ['settings.manage'] }, 'admin1')
    // The owner is later demoted to operator (simulated by evaluating effectivePermissions against 'operator' directly).
    expect(effectivePermissions(agent, 'operator')).toEqual([])
    // ...but is fully restored if the owner is an admin again — this is a LIVE recomputation, not a cached snapshot.
    expect(effectivePermissions(agent, 'admin')).toEqual(['settings.manage'])
  })

  test('an owner with no role at all (deleted user) grants nothing', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a12', name: 'A12', permissions: ['fs.read'] }, 'u1')
    expect(effectivePermissions(agent, null)).toEqual([])
  })
})

describe('agent store — update', () => {
  test('updating one field leaves the others untouched', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a13', name: 'A13', description: 'original' }, 'u1')
    const updated = store.update(agent.id, { name: 'A13 renamed' })
    expect(updated.name).toBe('A13 renamed')
    expect(updated.description).toBe('original')
    expect(updated.slug).toBe('a13')
  })

  test('clearing tools back to an empty array is accepted (no validation to fail against)', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const anyCap = registry.all()[0]
    if (!anyCap) throw new Error('registry has no capabilities to test against')
    const agent = store.create({ slug: 'a14', name: 'A14', tools: [anyCap.id] }, 'u1')
    const updated = store.update(agent.id, { tools: [] })
    expect(updated.tools).toEqual([])
  })

  test('updating with an unknown capability id is refused, leaving the stored agent unchanged', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a15', name: 'A15' }, 'u1')
    expect(() => store.update(agent.id, { tools: ['no.such.capability'] })).toThrow(EnkakuError)
    expect(store.get(agent.id)?.tools).toEqual([])
  })

  test('updating a nonexistent agent throws agent_not_found', () => {
    const { store } = setUp()
    try {
      store.update('does-not-exist', { name: 'x' })
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('agent_not_found')
    }
  })
})

describe('agent store — delete', () => {
  test('removes the agent', () => {
    const { db, store } = setUp()
    seedUser(db, 'u1', 'operator')
    const agent = store.create({ slug: 'a16', name: 'A16' }, 'u1')
    store.remove(agent.id)
    expect(store.get(agent.id)).toBeNull()
  })
})
