import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createKvApiFor } from './kv-client'
import type { KvCall } from './ipc'

describe('createKvApiFor (plan 79 §4.4)', () => {
  test('get() validates the stored value against the caller schema and returns it typed', async () => {
    const api = createKvApiFor('device', async <T>(call: KvCall) => {
      expect(call).toEqual({ op: 'get', scope: 'device', key: 'session' })
      return { userId: 'u1' } as T
    })
    const value = await api.get('session', z.object({ userId: z.string() }))
    expect(value).toEqual({ userId: 'u1' })
  })

  test('get() returns null when the store has nothing for the key', async () => {
    const api = createKvApiFor('global', async <T>() => null as T)
    expect(await api.get('missing', z.string())).toBeNull()
  })

  // Criterion 11: a stored value that no longer matches the caller's schema throws, naming the key.
  test('get() throws E_KV_SCHEMA_MISMATCH naming the key when the stored JSON does not match the schema', async () => {
    const api = createKvApiFor('device', async <T>() => ({ wrong: 'shape' }) as T)
    let caught: unknown
    try {
      await api.get('session', z.object({ userId: z.string() }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('kv.get("session")')
    expect((caught as { code?: string }).code).toBe('E_KV_SCHEMA_MISMATCH')
  })

  test('getRaw() skips schema validation entirely', async () => {
    const api = createKvApiFor('device', async <T>() => ({ anything: 42 }) as T)
    expect(await api.getRaw('k')).toEqual({ anything: 42 })
  })

  test('set() forwards secret/ttlSec options only when given', async () => {
    const calls: KvCall[] = []
    const api = createKvApiFor('global', async <T>(call: KvCall) => {
      calls.push(call)
      return { version: 1 } as T
    })
    await api.set('token', 'abc', { secret: true, ttlSec: 60 })
    await api.set('plain', 'x')
    expect(calls[0]).toEqual({ op: 'set', scope: 'global', key: 'token', value: 'abc', secret: true, ttlSec: 60 })
    expect(calls[1]).toEqual({ op: 'set', scope: 'global', key: 'plain', value: 'x' })
  })

  // Plan 112 step 112.2 — `hint: false` is how a caller storing a CREDENTIAL declines the row's
  // `${first 7}…${last 4}` display hint. Omitting it must stay indistinguishable from every call
  // written before the option existed, so the absent field and `true` mean the same thing.
  test('set()/setIfVersion() forward `hint` only when given, and never invent `hint: true`', async () => {
    const calls: KvCall[] = []
    const api = createKvApiFor('global', async <T>(call: KvCall) => {
      calls.push(call)
      return { version: 1 } as T
    })
    await api.set('credential', { password: 'p' }, { secret: true, hint: false })
    await api.set('api-key', 'sk-abc', { secret: true })
    await api.setIfVersion('credential', { password: 'p2' }, 1, { secret: true, hint: false })
    expect(calls[0]).toEqual({ op: 'set', scope: 'global', key: 'credential', value: { password: 'p' }, secret: true, hint: false })
    expect(calls[1]).toEqual({ op: 'set', scope: 'global', key: 'api-key', value: 'sk-abc', secret: true })
    expect(calls[1]).not.toHaveProperty('hint')
    expect(calls[2]).toEqual({ op: 'setIfVersion', scope: 'global', key: 'credential', value: { password: 'p2' }, expectedVersion: 1, secret: true, hint: false })
  })

  test('setIfVersion() passes expectedVersion through and surfaces a null "lost the race"', async () => {
    const api = createKvApiFor('device', async <T>() => null as T)
    expect(await api.setIfVersion('k', 'v', 3)).toBeNull()
  })

  test('increment() defaults `by` to unset (server applies its own default)', async () => {
    const calls: KvCall[] = []
    const api = createKvApiFor('device', async <T>(call: KvCall) => {
      calls.push(call)
      return 5 as T
    })
    expect(await api.increment('counter')).toBe(5)
    expect(calls[0]).toEqual({ op: 'increment', scope: 'device', key: 'counter' })
  })

  test('list() forwards prefix/limit/cursor only when given', async () => {
    const calls: KvCall[] = []
    const api = createKvApiFor('global', async <T>(call: KvCall) => {
      calls.push(call)
      return { items: [], nextCursor: null } as T
    })
    await api.list({ prefix: 'p:', limit: 10, cursor: 'abc' })
    expect(calls[0]).toEqual({ op: 'list', scope: 'global', prefix: 'p:', limit: 10, cursor: 'abc' })
  })
})
