import { describe, expect, test } from 'bun:test'
import { WorkflowDocSchema, type WorkflowDoc } from '@enkaku/protocol'
import { openDb, runMigrations } from '../db'
import { createPinStore } from './pins'
import { simulateWorkflow } from './simulate'
import type { ScriptEntry, ScriptRegistry } from '../scripts/registry'

function startNode(next: string) {
  return { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, next }
}

function scriptNode(id: string, overrides: Record<string, unknown> = {}) {
  return { kind: 'script', id, title: '', ui: { x: 0, y: 0 }, script: `demo/${id}@1.0.0`, params: {}, ...overrides }
}

function doc(nodes: Record<string, unknown>[], overrides: Record<string, unknown> = {}): WorkflowDoc {
  return WorkflowDocSchema.parse({
    schema: 2,
    name: 'sim-doc',
    title: '',
    description: '',
    params: [],
    entry: 'start',
    nodes,
    maxSteps: 50,
    ...overrides,
  })
}

/** A registry where every script's `resultSchema` is `{ type: 'object', properties: { videos: { type: 'array', items: { type: 'number' } } } }`, unless `schemas` overrides one by node script ref. `null` in `schemas` means "declares no result shape" (G5's stop case). */
function fakeRegistry(schemas: Record<string, unknown> = {}): ScriptRegistry {
  const resolveCalls: string[] = []
  return {
    list: () => ({ items: [], nextCursor: null, total: 0 }),
    get: () => null,
    resolve: (ref) => {
      resolveCalls.push(String(ref))
      const [name, version] = String(ref).split('@')
      const resultSchema = Object.prototype.hasOwnProperty.call(schemas, String(ref))
        ? schemas[String(ref)]
        : { type: 'object', properties: { videos: { type: 'array', items: { type: 'number' } } } }
      return {
        id: `script-${name}`,
        name: name ?? 'demo',
        version: version ?? '1.0.0',
        origin: 'plugin',
        pluginName: 'demo',
        exportId: null,
        enabled: true,
        paramsSchema: null,
        resultSchema,
        runtime: null,
      } as ScriptEntry
    },
    bundlePath: async () => '/dev/null',
    invalidate: () => {},
  }
}

function setUp(schemas: Record<string, unknown> = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  return { pins: createPinStore(opened.db), registry: fakeRegistry(schemas) }
}

describe('simulateWorkflow', () => {
  test('value precedence: mock over pin over sample', () => {
    const { pins, registry } = setUp()
    pins.set('sim-doc', 's1', { pinned: true }, null)
    const document = doc([startNode('s1'), scriptNode('s1')])

    // No mock: the stored pin wins.
    const withPin = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    expect(withPin.status).toBe('success')
    expect(withPin.steps[0]?.source).toBe('pin')
    expect(withPin.steps[0]?.output).toEqual({ pinned: true })

    // A mock for the same node overrides the stored pin.
    const withMock = simulateWorkflow({ doc: document, params: {}, mocks: { s1: { mocked: true } } }, { pins, registry })
    expect(withMock.steps[0]?.source).toBe('mock')
    expect(withMock.steps[0]?.output).toEqual({ mocked: true })
  })

  test('value precedence: no pin or mock falls back to a sample derived from resultSchema', () => {
    const { pins, registry } = setUp()
    const document = doc([startNode('s1'), scriptNode('s1')])
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    expect(result.status).toBe('success')
    expect(result.steps[0]?.source).toBe('sample')
    expect(result.steps[0]?.output).toEqual({ videos: [0] })
  })

  test('touches nothing: a driver stub that throws on any call is never invoked', () => {
    const { pins, registry } = setUp()
    // simulateWorkflow's signature accepts only { pins, registry } — there is
    // no way to hand it a driver, adb client, or session manager at all. This
    // test documents that constraint by using a registry whose bundlePath
    // (the ONE method that would touch a file/device path) throws if called.
    const throwingRegistry: ScriptRegistry = {
      ...registry,
      bundlePath: async () => {
        throw new Error('simulateWorkflow must never touch a bundle, a device, or a child process')
      },
    }
    const document = doc([startNode('s1'), scriptNode('s1')])
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry: throwingRegistry })
    expect(result.status).toBe('success')
  })

  test('gates, switches and set evaluate for real against simulated values', () => {
    const { pins, registry } = setUp()
    const document = doc([
      startNode('s1'),
      scriptNode('s1', { next: 'gate1' }),
      {
        kind: 'gate',
        id: 'gate1',
        title: '',
        ui: { x: 0, y: 0 },
        when: { left: { from: 's1', path: 'videos.0' }, op: 'eq', right: { const: 0 } },
        then: 'set1',
        else: undefined,
      },
      { kind: 'set', id: 'set1', title: '', ui: { x: 0, y: 0 }, assignments: [{ name: { const: 'report.ok' }, value: { const: true } }], keepOnlySet: true, next: undefined },
    ])
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    expect(result.status).toBe('success')
    const gateStep = result.steps.find((s) => s.nodeId === 'gate1')
    // The sample for `videos` is `[0]`, so `videos.0 eq 0` is true — the gate
    // takes `then`, computed by the SAME `evaluatePredicate` the executor uses.
    expect(gateStep?.takenEdge).toBe('then')
    const setStep = result.steps.find((s) => s.nodeId === 'set1')
    expect(setStep?.output).toEqual({ report: { ok: true } })
  })

  test('stops with a reason: a script node with no result shape, no pin, and no mock halts the simulation, naming the node', () => {
    const { pins, registry } = setUp({ 'demo/s1@1.0.0': null })
    const document = doc([startNode('s1'), scriptNode('s1')])
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    expect(result.status).toBe('stopped')
    if (result.status === 'stopped') {
      expect(result.stoppedAtNodeId).toBe('s1')
      expect(result.reason).toContain('s1')
      expect(result.reason.toLowerCase()).toContain('result shape')
    }
  })

  test('determinism: two simulations of the same document give the same answer', () => {
    const { pins, registry } = setUp()
    const document = doc([
      startNode('sw'),
      {
        kind: 'switch',
        id: 'sw',
        title: '',
        ui: { x: 0, y: 0 },
        mode: 'weighted',
        cases: [
          { weight: 1, to: 'a', label: '' },
          { weight: 1, to: 'b', label: '' },
        ],
      },
      { kind: 'finish', id: 'a', title: '', ui: { x: 0, y: 0 }, status: 'succeed', message: '' },
      { kind: 'finish', id: 'b', title: '', ui: { x: 0, y: 0 }, status: 'succeed', message: '' },
    ])
    const first = simulateWorkflow({ doc: document, params: {}, seed: 42, now: 1000 }, { pins, registry })
    const second = simulateWorkflow({ doc: document, params: {}, seed: 42, now: 1000 }, { pins, registry })
    expect(first).toEqual(second)
  })

  test('delay skipping: resolves instantly and records the duration it would have waited', async () => {
    const { pins, registry } = setUp()
    const document = doc([
      startNode('dl'),
      { kind: 'delay', id: 'dl', title: '', ui: { x: 0, y: 0 }, ms: { const: 60_000 }, maxMs: 300_000, next: undefined },
    ])
    const startedAt = Date.now()
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    const elapsed = Date.now() - startedAt
    expect(result.status).toBe('success')
    expect(elapsed).toBeLessThan(1000)
    const delayStep = result.steps.find((s) => s.nodeId === 'dl')
    expect(delayStep?.skippedMs).toBe(60_000)
    expect(delayStep?.output).toEqual({ ms: 60_000 })
  })

  test('never counts as real: a simulation carries no trigger of its own — that is a storage-layer concern, not this pure function’s', () => {
    const { pins, registry } = setUp()
    const document = doc([startNode('s1'), scriptNode('s1')])
    const result = simulateWorkflow({ doc: document, params: {} }, { pins, registry })
    // simulateWorkflow itself never writes a `jobs`/`job_runs` row — nothing
    // in its result carries a runId, a jobId, or a device id (G1's "0 session
    // opens" extends to "0 database writes of a real run's shape" — the
    // storage wrapper that persists this result as `trigger: 'simulate'` is
    // a separate, explicit step, never implied by calling this function).
    expect(result).not.toHaveProperty('runId')
    expect(result).not.toHaveProperty('jobId')
    expect(result).not.toHaveProperty('deviceId')
  })
})
