import { describe, expect, test } from 'bun:test'
import type { DeviceRow } from '../../db/schema'
import { createLogger } from '../../util/logger'
import { deriveGuestAgentIdentity, deriveGuestAgentPreparation, GUEST_AGENT_COMPONENT_ID } from './guest-agent-status'

/**
 * Plan 106 §5 step 106.5: `devices.preparation['guest-agent']` is the
 * authoritative state store for the guest agent; `devices.agent` is a
 * narrowed identity-only cache. These two functions are the ONE place that
 * combines them (or, for a pre-106.5 row, bridges from the legacy shape) —
 * `agent-provisioner.ts` and `registry/device-registry.ts` both go through
 * them rather than reading either column directly.
 */

function row(overrides: Partial<Pick<DeviceRow, 'preparation' | 'agent'>>): Pick<DeviceRow, 'preparation' | 'agent'> {
  return { preparation: null, agent: null, ...overrides }
}

describe('deriveGuestAgentPreparation', () => {
  test('never provisioned (both columns null) reads absent', () => {
    expect(deriveGuestAgentPreparation(row({})).state).toBe('absent')
  })

  test('reads a real preparation entry when one exists — the primary, authoritative path', () => {
    const r = row({
      preparation: { [GUEST_AGENT_COMPONENT_ID]: { state: 'ready', version: '1.0.0', reason: null, checkedAt: 5, attempts: 0, nextAttemptAt: null } },
      // A stale/contradictory devices.agent must never win once a real entry exists.
      agent: { appVersion: '9.9.9', versionCode: 1, androidSdkInt: 1, capabilities: [] } as unknown as DeviceRow['agent'],
    })
    const status = deriveGuestAgentPreparation(r)
    expect(status).toEqual({ state: 'ready', version: '1.0.0', reason: null, checkedAt: 5, attempts: 0, nextAttemptAt: null })
  })

  test('falls back to a legacy full-shape devices.agent when no preparation entry exists — the migration-continuity path', () => {
    const r = row({
      agent: {
        state: 'failed',
        appVersion: '2.0.0',
        versionCode: 4,
        androidSdkInt: 31,
        capabilities: ['socks5-route'],
        reason: 'corrupt APK',
        checkedAt: 1_000,
        attempts: 3,
        nextAttemptAt: null,
      } as unknown as DeviceRow['agent'],
    })
    const status = deriveGuestAgentPreparation(r)
    expect(status).toEqual({ state: 'failed', version: '2.0.0', reason: 'corrupt APK', checkedAt: 1_000, attempts: 3, nextAttemptAt: null })
  })

  test('a corrupt preparation column falls through to the legacy devices.agent value rather than losing it', () => {
    const r = row({
      preparation: { garbage: true } as unknown as DeviceRow['preparation'],
      agent: { state: 'ready', appVersion: '1.0.0', versionCode: 1, androidSdkInt: 30, capabilities: [], reason: null, checkedAt: 1, attempts: 0, nextAttemptAt: null } as unknown as DeviceRow['agent'],
    })
    // `{ garbage: true }`'s value fails `PreparationComponentStatusSchema`
    // (a boolean is not the expected object shape), so `DevicePreparationSchema`
    // — a record over EVERY value — fails validation for the whole column,
    // not just the `garbage` key. Either that or a genuinely absent entry,
    // the legacy fallback must fire the same way.
    expect(deriveGuestAgentPreparation(r).state).toBe('ready')
  })

  test('a corrupt legacy devices.agent value (fails validation) reads as the safe default rather than throwing', () => {
    const r = row({ agent: { nonsense: 1 } as unknown as DeviceRow['agent'] })
    expect(deriveGuestAgentPreparation(r, createLogger('t')).state).toBe('absent')
  })
})

describe('deriveGuestAgentIdentity', () => {
  test('never provisioned reads the default (all null / empty)', () => {
    expect(deriveGuestAgentIdentity(row({}))).toEqual({ appVersion: null, versionCode: null, androidSdkInt: null, capabilities: [] })
  })

  test('reads the narrowed post-106.5 shape', () => {
    const r = row({ agent: { appVersion: '1.2.3', versionCode: 7, androidSdkInt: 34, capabilities: ['egress-probe'] } as unknown as DeviceRow['agent'] })
    expect(deriveGuestAgentIdentity(r)).toEqual({ appVersion: '1.2.3', versionCode: 7, androidSdkInt: 34, capabilities: ['egress-probe'] })
  })

  test('extracts the identity subset from a legacy full-shape row too — Zod strips the extra state/reason/etc. keys rather than rejecting them', () => {
    const r = row({
      agent: {
        state: 'ready',
        appVersion: '1.2.3',
        versionCode: 7,
        androidSdkInt: 34,
        capabilities: ['egress-probe'],
        reason: null,
        checkedAt: 1,
        attempts: 0,
        nextAttemptAt: null,
      } as unknown as DeviceRow['agent'],
    })
    expect(deriveGuestAgentIdentity(r)).toEqual({ appVersion: '1.2.3', versionCode: 7, androidSdkInt: 34, capabilities: ['egress-probe'] })
  })
})
