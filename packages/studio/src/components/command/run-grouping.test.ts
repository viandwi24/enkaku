import { describe, expect, test } from 'bun:test'
import type { CommandMember } from '@enkaku/protocol'
import { groupMembers } from './run-grouping'

function member(overrides: Partial<CommandMember> = {}): CommandMember {
  return {
    deviceId: 'd',
    seq: 0,
    stageIndex: 0,
    status: 'ok',
    exitCode: 0,
    durationMs: 100,
    outputHash: 'h1',
    truncated: false,
    skip: null,
    error: null,
    ...overrides,
  }
}

describe('groupMembers', () => {
  test('a failing device sorts above a succeeding one', () => {
    const groups = groupMembers([
      member({ deviceId: 'ok-1', status: 'ok', outputHash: 'h1' }),
      member({ deviceId: 'bad-1', status: 'failed', exitCode: 1, outputHash: 'h2' }),
    ])
    expect(groups.map((g) => g.kind)).toEqual(['failed', 'ok'])
  })

  test('identical outputs collapse into one ok group (H1)', () => {
    const members = Array.from({ length: 91 }, (_, i) => member({ deviceId: `d${i}`, status: 'ok', outputHash: 'same-hash' }))
    const groups = groupMembers(members)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.members).toHaveLength(91)
  })

  test('a skipped device is grouped by its reason, and the reason text is on the group', () => {
    const groups = groupMembers([
      member({ deviceId: 'a', status: 'skipped', skip: { code: 'not_lease_holder', message: 'another client is controlling this device' } }),
      member({ deviceId: 'b', status: 'skipped', skip: { code: 'not_lease_holder', message: 'another client is controlling this device' } }),
      member({ deviceId: 'c', status: 'skipped', skip: { code: 'device_unavailable', message: 'the device is unavailable (status offline)' } }),
    ])
    const skipGroups = groups.filter((g) => g.kind === 'skipped')
    expect(skipGroups).toHaveLength(2)
    expect(skipGroups[0]?.title).toBe('another client is controlling this device')
    expect(skipGroups[0]?.members).toHaveLength(2)
  })

  test('exceptions rank above in-progress, which ranks above ok', () => {
    const groups = groupMembers([
      member({ deviceId: 'a', status: 'ok' }),
      member({ deviceId: 'b', status: 'pending' }),
      member({ deviceId: 'c', status: 'running' }),
      member({ deviceId: 'd', status: 'cancelled' }),
      member({ deviceId: 'e', status: 'skipped', skip: { code: 'x', message: 'x' } }),
      member({ deviceId: 'f', status: 'failed', exitCode: 1 }),
    ])
    expect(groups.map((g) => g.kind)).toEqual(['failed', 'skipped', 'cancelled', 'running', 'pending', 'ok'])
  })

  test('two different failures (different exit codes, no output) do not merge', () => {
    const groups = groupMembers([
      member({ deviceId: 'a', status: 'failed', exitCode: 1, outputHash: null }),
      member({ deviceId: 'b', status: 'failed', exitCode: 2, outputHash: null }),
    ])
    expect(groups.filter((g) => g.kind === 'failed')).toHaveLength(2)
  })

  test('a thrown error groups separately from a non-zero exit', () => {
    const groups = groupMembers([
      member({ deviceId: 'a', status: 'failed', exitCode: null, error: 'adb: device offline mid-command', outputHash: null }),
      member({ deviceId: 'b', status: 'failed', exitCode: 1, outputHash: 'h9' }),
    ])
    expect(groups.filter((g) => g.kind === 'failed')).toHaveLength(2)
  })
})
