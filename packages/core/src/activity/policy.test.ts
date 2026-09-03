import { describe, expect, test } from 'bun:test'
import type { ActivityKind, DeviceActivity } from '@enkaku/protocol'
import { evaluate, POLICY, type ControlPolicySettings, type Decision } from './policy'

const ALLOW: ControlPolicySettings = { overControl: 'allow', idleSec: 30 }

function activity(kind: ActivityKind, id = `${kind}:1`): DeviceActivity {
  return {
    id,
    kind,
    label: `label for ${kind}`,
    actor: { kind: 'user', id: 'client-1', label: 'Rina' },
    startedAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  }
}

/**
 * MVP 04 §1.3's matrix, transcribed as 30 explicit cells (six starting rows
 * x five existing columns, `job`/`workflow-job` asserted identically where
 * the row or column is shared) plus the `prep` and `agent` rows marked
 * proposed (§9 Q1).
 */
const EXISTING_COLUMNS: ActivityKind[] = ['job', 'install', 'control', 'command', 'prep']
const STARTING_ROWS: ActivityKind[] = ['job', 'install', 'control', 'command', 'transfer', 'wake']

describe('evaluate — the policy matrix (MVP 04 §1.3)', () => {
  test.each(STARTING_ROWS.flatMap((starting) => EXISTING_COLUMNS.map((existing) => [starting, existing] as const)))(
    '%s over %s',
    (starting, existing) => {
      const expected = POLICY[starting]?.[existing] ?? 'allow'
      const result = evaluate(starting, [activity(existing)], ALLOW)
      expect(result.decision).toBe(expected)
      if (existing === 'job') {
        // job and workflow-job share a row and a column.
        expect(evaluate(starting, [activity('workflow-job')], ALLOW).decision).toBe(expected)
      }
    },
  )

  test('prep row is proposed: forbidden under job/workflow-job/install/prep, allowed under control/command', () => {
    expect(evaluate('prep', [activity('job')], ALLOW).decision).toBe('forbid')
    expect(evaluate('prep', [activity('workflow-job')], ALLOW).decision).toBe('forbid')
    expect(evaluate('prep', [activity('install')], ALLOW).decision).toBe('forbid')
    expect(evaluate('prep', [activity('prep')], ALLOW).decision).toBe('forbid')
    expect(evaluate('prep', [activity('control')], ALLOW).decision).toBe('allow')
    expect(evaluate('prep', [activity('command')], ALLOW).decision).toBe('allow')
  })

  test('agent row is proposed: same shape as control — warn under job/install, allow under control/command/prep', () => {
    expect(evaluate('agent', [activity('job')], ALLOW).decision).toBe('warn')
    expect(evaluate('agent', [activity('install')], ALLOW).decision).toBe('warn')
    expect(evaluate('agent', [activity('control')], ALLOW).decision).toBe('allow')
    expect(evaluate('agent', [activity('command')], ALLOW).decision).toBe('allow')
    expect(evaluate('agent', [activity('prep')], ALLOW).decision).toBe('allow')
  })
})

describe('evaluate — control over control follows settings.overControl, never the table', () => {
  test.each(['allow', 'warn', 'forbid'] as const)('overControl=%s', (overControl) => {
    const settings: ControlPolicySettings = { overControl, idleSec: 30 }
    expect(evaluate('control', [activity('control')], settings).decision).toBe(overControl)
  })
})

describe('evaluate — selfIds, exclusiveWith, worst-wins, allow message', () => {
  test('selfIds skips the caller\'s own marker', () => {
    const result = evaluate('job', [activity('control', 'control:client-1')], ALLOW, { selfIds: ['control:client-1'] })
    expect(result.decision).toBe('allow')
  })

  test('exclusiveWith forces forbid regardless of the table', () => {
    const result = evaluate('transfer', [activity('control')], ALLOW, { exclusiveWith: ['control'] })
    expect(result.decision).toBe('forbid')
  })

  test('the worst decision wins across a mixed list', () => {
    const result = evaluate('job', [activity('control'), activity('command'), activity('prep')], ALLOW)
    // job over control=allow, job over command=warn, job over prep=warn -> worst is warn
    expect(result.decision).toBe('warn')
  })

  test('forbid beats warn when both are present', () => {
    const result = evaluate('job', [activity('command'), activity('install')], ALLOW)
    expect(result.decision).toBe('forbid')
    expect(result.conflicting?.kind).toBe('install')
  })

  test('conflicting names the activity that produced the worst decision', () => {
    const install = activity('install')
    const result = evaluate('job', [install], ALLOW)
    expect(result.conflicting).toEqual(install)
  })

  test('allow has an empty message and no conflicting activity', () => {
    const result = evaluate('transfer', [], ALLOW)
    expect(result).toEqual({ decision: 'allow', message: '' })
  })
})

describe('SENTENCES wording', () => {
  test('warn on control/agent mentions interference; warn otherwise mentions starting anyway', () => {
    const control = activity('job')
    expect(evaluate('control', [control], ALLOW, {}).decision).toBe('warn')
    const msg = evaluate('control', [control], ALLOW).message
    expect(msg).toContain('your taps will interfere')
    const msg2 = evaluate('command', [control], ALLOW).message
    expect(msg2).toContain('starting command anyway')
  })

  test('forbid names the conflicting activity and says it must end first', () => {
    const msg = evaluate('job', [activity('job')], ALLOW).message
    expect(msg).toContain('cannot start until it ends')
  })
})

// Exercise the Decision type is exactly the three-value union.
const _decisions: Decision[] = ['allow', 'warn', 'forbid']
void _decisions
