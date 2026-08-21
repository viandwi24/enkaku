import { describe, expect, test } from 'bun:test'
import {
  CONFIG_KEY,
  DEFAULT_PLUGIN_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  DEFAULT_RECONCILE_INTERVAL_SEC,
  DEFAULT_ROUTER_TIMEOUT_MS,
  ROUTER_KEY,
  isRouterConfigured,
  readPluginConfig,
  readRouterConfig,
  writePluginConfig,
  writeRouterConfig,
} from './shared'

/**
 * Step 122.3's slice of the KV data model (§4.9): the two keys, and the
 * defensive read/write pair each follows `plugins/proxy-manager/src/
 * shared.ts`'s `readProxyRecord`/`writeProxyRecord` discipline — this file
 * proves that discipline rather than assuming it, the same way that pack's
 * own `record.test.ts` does for its record.
 */

describe('the two KV keys (§4.9)', () => {
  test('are the plain strings §4.9 names, and are disjoint', () => {
    expect(CONFIG_KEY).toBe('config')
    expect(ROUTER_KEY).toBe('router')
    expect(CONFIG_KEY).not.toBe(ROUTER_KEY)
  })
})

describe('readPluginConfig / writePluginConfig', () => {
  test('a fresh read of nothing (undefined/null) is the plan’s own stated defaults', () => {
    expect(readPluginConfig(undefined)).toEqual(DEFAULT_PLUGIN_CONFIG)
    expect(readPluginConfig(null)).toEqual(DEFAULT_PLUGIN_CONFIG)
  })

  test('defaults: reconcile 60s, confirm on, auto-repair off — §4.4/§4.7', () => {
    expect(DEFAULT_PLUGIN_CONFIG).toEqual({ reconcileIntervalSec: DEFAULT_RECONCILE_INTERVAL_SEC, requireConfirm: true, autoRepair: false })
    expect(DEFAULT_RECONCILE_INTERVAL_SEC).toBe(60)
  })

  test('write ∘ read round-trips a valid value exactly', () => {
    const config = { reconcileIntervalSec: 120, requireConfirm: false, autoRepair: true }
    expect(readPluginConfig(writePluginConfig(config))).toEqual(config)
  })

  test('a junk value (array, string, number) degrades to defaults rather than throwing', () => {
    expect(readPluginConfig([1, 2, 3])).toEqual(DEFAULT_PLUGIN_CONFIG)
    expect(readPluginConfig('nope')).toEqual(DEFAULT_PLUGIN_CONFIG)
    expect(readPluginConfig(42)).toEqual(DEFAULT_PLUGIN_CONFIG)
  })

  test('a per-field junk value defaults just that field, not the whole record', () => {
    expect(readPluginConfig({ reconcileIntervalSec: 'soon', requireConfirm: 'yes', autoRepair: 1 })).toEqual(DEFAULT_PLUGIN_CONFIG)
  })

  test('reconcileIntervalSec out of [5, 3600] falls back to the default rather than being clamped silently', () => {
    expect(readPluginConfig({ reconcileIntervalSec: 0 }).reconcileIntervalSec).toBe(DEFAULT_RECONCILE_INTERVAL_SEC)
    expect(readPluginConfig({ reconcileIntervalSec: 100_000 }).reconcileIntervalSec).toBe(DEFAULT_RECONCILE_INTERVAL_SEC)
    expect(readPluginConfig({ reconcileIntervalSec: 5 }).reconcileIntervalSec).toBe(5)
    expect(readPluginConfig({ reconcileIntervalSec: 3600 }).reconcileIntervalSec).toBe(3600)
  })
})

describe('readRouterConfig / writeRouterConfig', () => {
  test('a fresh read of nothing is the plan’s own stated defaults — every field blank/off, per §4.10’s "no reveal route"', () => {
    expect(readRouterConfig(undefined)).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(DEFAULT_ROUTER_CONFIG).toEqual({ baseUrl: '', username: '', password: '', tls: false, timeoutMs: DEFAULT_ROUTER_TIMEOUT_MS })
  })

  test('write ∘ read round-trips a valid connection exactly, password included', () => {
    const config = { baseUrl: '192.168.10.1', username: 'enkaku', password: 'sup3r-secret', tls: true, timeoutMs: 4_000 }
    expect(readRouterConfig(writeRouterConfig(config))).toEqual(config)
  })

  test('the write shape carries no field beyond MikrotikRestConfig’s own five — never leaks an extra key onto the secret row', () => {
    const written = writeRouterConfig({ baseUrl: 'r', username: 'u', password: 'p', tls: false, timeoutMs: 1000 })
    expect(Object.keys(written).sort()).toEqual(['baseUrl', 'password', 'timeoutMs', 'tls', 'username'])
  })

  test('a junk value degrades to defaults rather than throwing', () => {
    expect(readRouterConfig('not an object')).toEqual(DEFAULT_ROUTER_CONFIG)
    expect(readRouterConfig([1, 2])).toEqual(DEFAULT_ROUTER_CONFIG)
  })

  test('timeoutMs out of [500, 60000] falls back to the default rather than being clamped silently', () => {
    expect(readRouterConfig({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_ROUTER_TIMEOUT_MS)
    expect(readRouterConfig({ timeoutMs: 999_999 }).timeoutMs).toBe(DEFAULT_ROUTER_TIMEOUT_MS)
  })
})

describe('isRouterConfigured', () => {
  test('false for the default (nothing saved yet)', () => {
    expect(isRouterConfigured(DEFAULT_ROUTER_CONFIG)).toBe(false)
  })

  test('false when any of baseUrl/username/password is blank', () => {
    const full = { baseUrl: 'r', username: 'u', password: 'p', tls: false, timeoutMs: 1000 }
    expect(isRouterConfigured({ ...full, baseUrl: '' })).toBe(false)
    expect(isRouterConfigured({ ...full, baseUrl: '   ' })).toBe(false)
    expect(isRouterConfigured({ ...full, username: '' })).toBe(false)
    expect(isRouterConfigured({ ...full, password: '' })).toBe(false)
  })

  test('true once all three are present — tls/timeoutMs never gate this', () => {
    expect(isRouterConfigured({ baseUrl: 'r', username: 'u', password: 'p', tls: false, timeoutMs: 1000 })).toBe(true)
  })
})
