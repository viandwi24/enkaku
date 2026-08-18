import { describe, expect, test } from 'bun:test'
import { AgentStateSchema, type AgentState } from './device'
import {
  DEFAULT_DEVICE_PREPARATION,
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  DevicePreparationSchema,
  PreparationComponentStatusSchema,
  PreparationStateSchema,
  type DevicePreparation,
  type PreparationComponentStatus,
} from './device-preparation'

const ALL_STATES: AgentState[] = ['absent', 'provisioning', 'ready', 'outdated', 'failed', 'unsupported', 'consent-required']

describe('PreparationStateSchema (plan 106 §3.1)', () => {
  test('is literally AgentStateSchema, not a parallel enum that can drift', () => {
    // Same reference, not merely the same values — the doc comment's claim
    // ("a re-export, not a parallel z.enum") would be false if this ever
    // became two schemas that happen to agree today.
    expect(PreparationStateSchema).toBe(AgentStateSchema)
  })

  test('parses every state the guest agent AgentState uses', () => {
    for (const state of ALL_STATES) {
      expect(PreparationStateSchema.parse(state)).toBe(state)
    }
  })

  test('rejects an unknown state', () => {
    expect(PreparationStateSchema.safeParse('broken').success).toBe(false)
  })
})

describe('PreparationComponentStatusSchema', () => {
  test('parses the default status', () => {
    expect(PreparationComponentStatusSchema.parse(DEFAULT_PREPARATION_COMPONENT_STATUS)).toEqual(DEFAULT_PREPARATION_COMPONENT_STATUS)
  })

  test('parses a full ready status with a version string', () => {
    const status: PreparationComponentStatus = {
      state: 'ready',
      version: '1.4.2',
      reason: null,
      checkedAt: 1700000000,
      attempts: 0,
      nextAttemptAt: null,
    }
    expect(PreparationComponentStatusSchema.parse(status)).toEqual(status)
  })

  test('parses a failed status with a verbatim reason and bounded-retry bookkeeping', () => {
    const status: PreparationComponentStatus = {
      state: 'failed',
      version: null,
      reason: 'pm install returned exit code 1',
      checkedAt: 1700000000,
      attempts: 3,
      nextAttemptAt: null,
    }
    expect(PreparationComponentStatusSchema.parse(status)).toEqual(status)
  })

  test('rejects a status missing attempts', () => {
    const { attempts: _attempts, ...rest } = DEFAULT_PREPARATION_COMPONENT_STATUS
    expect(PreparationComponentStatusSchema.safeParse(rest).success).toBe(false)
  })
})

describe('DevicePreparationSchema (plan 106 §3.1, §3.2)', () => {
  test('the empty record is the default — no component ever having run', () => {
    expect(DevicePreparationSchema.parse(DEFAULT_DEVICE_PREPARATION)).toEqual({})
  })

  test('keys by an open-ended component id — a future component needs no schema change', () => {
    const preparation: DevicePreparation = {
      'ui-server': { ...DEFAULT_PREPARATION_COMPONENT_STATUS, state: 'ready', version: '2.3.3' },
      'some-future-component': { ...DEFAULT_PREPARATION_COMPONENT_STATUS, state: 'absent' },
    }
    expect(DevicePreparationSchema.parse(preparation)).toEqual(preparation)
  })

  test('rejects a component entry that does not match the shared status shape', () => {
    expect(DevicePreparationSchema.safeParse({ 'ui-server': { state: 'ready' } }).success).toBe(false)
  })
})
