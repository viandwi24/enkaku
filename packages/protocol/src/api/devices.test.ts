import { describe, expect, test } from 'bun:test'
import {
  AgentProvisionReportSchema,
  DeviceNetworkStatusResponseSchema,
  GuestAgentStatusResponseSchema,
  GuestAgentSummaryResponseSchema,
} from './devices'

/**
 * Plan 90 §5 step 90.6 — the one thing this step MUST do: widen
 * `GuestAgentStatusResponseSchema.state` to carry `outdated`/`failed`
 * (the states `AgentProvisioner` already computes, F10/F11) without breaking
 * the pre-plan-90 five values Studio's `AgentStateBadge`/`NetworkPanel`
 * already parse and render branches against. Both halves — the schema and
 * every Studio branch — are exercised together: this file proves the
 * schema PARSES; `AgentPanel.test.tsx` proves it RENDERS.
 */
describe('GuestAgentStatusResponseSchema — widened for plan 90 §3.8 (F10, F11)', () => {
  test('every pre-plan-90 state still parses (no regression)', () => {
    for (const state of ['not-installed', 'installed', 'ready', 'unreachable', 'unsupported'] as const) {
      expect(GuestAgentStatusResponseSchema.parse({ state })).toEqual({ state })
    }
  })

  test('a response carrying "outdated" parses', () => {
    const body = {
      state: 'outdated',
      appVersion: '1.0.0',
      androidSdkInt: 33,
      capabilities: ['socks5-route'],
      reason: 'installed build does not match the pinned manifest artefact',
    }
    expect(GuestAgentStatusResponseSchema.parse(body)).toMatchObject(body)
  })

  test('a response carrying "failed" parses', () => {
    const body = { state: 'failed', reason: 'E_CHECKSUM_MISSING: no sha256 pinned for this build' }
    expect(GuestAgentStatusResponseSchema.parse(body)).toMatchObject(body)
  })

  test('an unrecognised state is still rejected — this is a widen, not an open string', () => {
    expect(GuestAgentStatusResponseSchema.safeParse({ state: 'something-else' }).success).toBe(false)
  })

  test('the §4.7 extension fields (versionCode/checkedAt/attempts/nextAttemptAt) are optional — no producer on this endpoint yet', () => {
    const parsed = GuestAgentStatusResponseSchema.parse({ state: 'ready' })
    expect(parsed.versionCode).toBeUndefined()
    expect(parsed.checkedAt).toBeUndefined()
    // When a future wiring DOES send them, they parse too.
    const withExtension = GuestAgentStatusResponseSchema.parse({
      state: 'outdated',
      versionCode: 12,
      checkedAt: 1_700_000_000,
      attempts: 1,
      nextAttemptAt: 1_700_000_060,
    })
    expect(withExtension.versionCode).toBe(12)
    expect(withExtension.nextAttemptAt).toBe(1_700_000_060)
  })
})

describe('DeviceNetworkStatusResponseSchema.recovery — plan 90 §3.7 rule 5 (fixes F20)', () => {
  const base = {
    engine: 'vpn-helper' as const,
    config: null,
    enabled: false,
    observed: null,
    drift: false,
    sessionId: null,
    failClosed: true,
    health: 'unknown' as const,
    checks: [],
    lastError: null,
    exitHistory: [],
  }

  test('null recovery parses — no automatic recovery has ever run for this route', () => {
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery: null }).recovery).toBeNull()
  })

  test('a mid-backoff recovery block parses', () => {
    const recovery = { attempts: 2, maxAttempts: 3, nextAttemptAt: 1_700_000_014, exhausted: false, reconnectCycles: 1 }
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery }).recovery).toEqual(recovery)
  })

  test('an exhausted recovery block parses', () => {
    const recovery = { attempts: 3, maxAttempts: 3, nextAttemptAt: 1_700_000_480, exhausted: true, reconnectCycles: 0 }
    expect(DeviceNetworkStatusResponseSchema.parse({ ...base, recovery }).recovery).toEqual(recovery)
  })
})

describe('AgentProvisionReportSchema / GuestAgentSummaryResponseSchema — plan 90 §4.7', () => {
  test('a fleet-wide provision report parses, including outdated/failed results', () => {
    const report = {
      total: 3,
      results: [
        { deviceId: 'dev-1', state: 'ready' as const, reason: null },
        { deviceId: 'dev-2', state: 'outdated' as const, reason: 'version mismatch' },
        { deviceId: 'dev-3', state: 'failed' as const, reason: 'install failed' },
      ],
    }
    expect(AgentProvisionReportSchema.parse(report)).toEqual(report)
  })

  test('the summary parses byState/byVersion as open string-keyed counts', () => {
    const summary = { total: 20, byState: { ready: 18, outdated: 2 }, byVersion: { '1.2.0': 18, '1.1.0': 2 } }
    expect(GuestAgentSummaryResponseSchema.parse(summary)).toEqual(summary)
  })
})
