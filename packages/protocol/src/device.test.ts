import { describe, expect, test } from 'bun:test'
import { AgentStateSchema, AgentStatusSchema, DEFAULT_AGENT_STATUS, DeviceInfoSchema, type AgentState, type AgentStatus, type LeaseHolder } from './device'
import { MAIN_EVENT_KINDS } from './messages/device-event'

const ALL_AGENT_STATES: AgentState[] = ['absent', 'provisioning', 'ready', 'outdated', 'failed', 'unsupported', 'consent-required']

/**
 * The guest agent's provisioning state (plan 90 §3.8, §4.3) — a device
 * property, narrow on `DeviceInfo` by design (the fleet payload carries only
 * the chip, never the version/capability list — see that field's own doc
 * comment).
 */
describe('AgentStateSchema', () => {
  test('parses every state in the plan 90 §3.8 enum', () => {
    for (const state of ALL_AGENT_STATES) {
      expect(AgentStateSchema.parse(state)).toBe(state)
    }
  })

  test('rejects an unknown state rather than silently accepting it', () => {
    expect(AgentStateSchema.safeParse('installed').success).toBe(false)
  })
})

describe('AgentStatusSchema', () => {
  test('DEFAULT_AGENT_STATUS parses as its own schema (round-trips)', () => {
    expect(AgentStatusSchema.parse(DEFAULT_AGENT_STATUS)).toEqual(DEFAULT_AGENT_STATUS)
  })

  test('a full ready status parses', () => {
    const status: AgentStatus = {
      state: 'ready',
      appVersion: '1.2.0',
      versionCode: 12,
      androidSdkInt: 34,
      capabilities: ['socks5-route', 'text-input'],
      reason: null,
      checkedAt: 1_700_000_000,
      attempts: 0,
      nextAttemptAt: null,
    }
    expect(AgentStatusSchema.parse(status)).toEqual(status)
  })

  test('an unknown capability in the stored value fails validation — a corrupt/future-build row must not silently parse as current', () => {
    const status = { ...DEFAULT_AGENT_STATUS, capabilities: ['not-a-real-capability'] }
    expect(AgentStatusSchema.safeParse(status).success).toBe(false)
  })
})

describe('DeviceInfoSchema.agent', () => {
  const BASE = {
    id: 'dev-1',
    stableId: 'stable-1',
    serial: 'serial-1',
    label: 'Test Phone',
    androidVersion: '15',
    apiLevel: 35,
    screenW: 1080,
    screenH: 2400,
    density: 420,
    status: 'idle',
    lastSeen: 1_700_000_000,
  }

  test('defaults to absent when omitted — an existing test/fallback that constructs a DeviceInfo without it still parses (plan 90 §4.7)', () => {
    const info = DeviceInfoSchema.parse(BASE)
    expect(info.agent).toBe('absent')
  })

  test('every production state round-trips', () => {
    for (const agent of ALL_AGENT_STATES) {
      expect(DeviceInfoSchema.parse({ ...BASE, agent }).agent).toBe(agent)
    }
  })
})

describe('DeviceInfoSchema.assistedBy (plan 91 §3.2, §3.4 item 4, F25)', () => {
  const BASE = {
    id: 'dev-1',
    stableId: 'stable-1',
    serial: 'serial-1',
    label: 'Test Phone',
    androidVersion: '15',
    apiLevel: 35,
    screenW: 1080,
    screenH: 2400,
    density: 420,
    status: 'busy',
    lastSeen: 1_700_000_000,
  }

  test('defaults to an empty array when omitted — an existing test/fallback that constructs a DeviceInfo without it still parses', () => {
    const info = DeviceInfoSchema.parse(BASE)
    expect(info.assistedBy).toEqual([])
  })

  test('carries one or more assisting holders, each non-takeable', () => {
    const holder: LeaseHolder = {
      kind: 'user',
      id: 'client-1',
      label: 'Rina',
      runId: null,
      takeable: false,
      acquiredAt: 1_700_000_000,
      expiresAt: 1_700_000_300,
    }
    const info = DeviceInfoSchema.parse({ ...BASE, assistedBy: [holder] })
    expect(info.assistedBy).toEqual([holder])
  })

  test('assistedBy and heldBy are independent — a busy device can be held by a job and assisted by a user at the same time', () => {
    const job: LeaseHolder = {
      kind: 'job',
      id: 'job-1',
      label: 'checkout@1.4.2',
      runId: null,
      takeable: false,
      acquiredAt: 1_700_000_000,
      expiresAt: null,
    }
    const assist: LeaseHolder = {
      kind: 'user',
      id: 'client-1',
      label: 'Rina',
      runId: null,
      takeable: false,
      acquiredAt: 1_700_000_100,
      expiresAt: 1_700_000_400,
    }
    const info = DeviceInfoSchema.parse({ ...BASE, heldBy: job, assistedBy: [assist] })
    expect(info.heldBy).toEqual(job)
    expect(info.assistedBy).toEqual([assist])
  })
})

describe('DeviceInfoSchema.number (plan 89 §3.1, §3.2, §3.3, §4.3)', () => {
  const BASE = {
    id: 'dev-1',
    stableId: 'stable-1',
    serial: 'serial-1',
    label: 'Test Phone',
    androidVersion: '15',
    apiLevel: 35,
    screenW: 1080,
    screenH: 2400,
    density: 420,
    status: 'idle',
    lastSeen: 1_700_000_000,
  }

  test('defaults to null when omitted — an existing test/fallback that constructs a DeviceInfo without it still parses', () => {
    const info = DeviceInfoSchema.parse(BASE)
    expect(info.number).toBeNull()
  })

  test('a positive integer round-trips', () => {
    const info = DeviceInfoSchema.parse({ ...BASE, number: 7 })
    expect(info.number).toBe(7)
  })

  test('zero is rejected — §4.3\'s "never zero-padded" reading of the field assumes every real number is >= 1', () => {
    expect(DeviceInfoSchema.safeParse({ ...BASE, number: 0 }).success).toBe(false)
  })

  test('a negative number is rejected', () => {
    expect(DeviceInfoSchema.safeParse({ ...BASE, number: -3 }).success).toBe(false)
  })

  test('a non-integer number is rejected', () => {
    expect(DeviceInfoSchema.safeParse({ ...BASE, number: 3.5 }).success).toBe(false)
  })

  test('explicit null parses — the released-reservation case (§3.2)', () => {
    const info = DeviceInfoSchema.parse({ ...BASE, number: null })
    expect(info.number).toBeNull()
  })
})

describe('MAIN_EVENT_KINDS (plan 90 §4.3)', () => {
  test('device.agent is a recognised main-stream kind', () => {
    expect(MAIN_EVENT_KINDS).toContain('device.agent')
  })

  test('clipboard.overwritten is NOT a recognised main-stream kind — it recorded the text ladder\'s clipboard-paste rung, which was proven architecturally unreachable and removed (docs/plans/96-m61-hotfixes.md §96.7, §96.8)', () => {
    expect(MAIN_EVENT_KINDS).not.toContain('clipboard.overwritten')
  })
})
