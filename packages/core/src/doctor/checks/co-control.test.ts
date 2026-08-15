import { describe, expect, test } from 'bun:test'
import { fakeDoctorContext } from '../test-helpers'
import { coControlCheck } from './co-control'

const ZERO_LANES = {
  pointer: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
  keys: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
  text: { depth: 0, waitMsP50: 0, waitMsP95: 0, refusals: 0 },
}

const ALL_CLEAR = {
  lanes: ZERO_LANES,
  assistsActive: 0,
  mirrorGroups: 0,
  mirrorMembers: 0,
  mirrorFanoutMsP50: 0,
  mirrorFanoutMsP95: 0,
  queueWaitMs: 5_000,
  uncollectedGrants: 0,
  orphanedMirrorGroups: 0,
}

describe('co-control check (plan 91 §4.10, §5 step 91.10, tests H2/H4)', () => {
  test('skips when no core is running — observability is only known while it is up', async () => {
    const result = await coControlCheck.run(fakeDoctorContext({ coControl: { probe: async () => null } }))
    expect(result.status).toBe('skip')
  })

  test('ok, no remedy, on an all-clear farm with no active lanes/grants/groups', async () => {
    const ctx = fakeDoctorContext({ coControl: { probe: async () => ALL_CLEAR } })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.remedy).toBeUndefined()
    expect(result.observed).toContain('assists=0')
    expect(result.observed).toContain('queueWaitMs=5000')
  })

  test('ok with real traffic that stays comfortably under half the wait budget (H2)', async () => {
    const ctx = fakeDoctorContext({
      coControl: {
        probe: async () => ({
          ...ALL_CLEAR,
          lanes: { ...ZERO_LANES, pointer: { depth: 1, waitMsP50: 20, waitMsP95: 90, refusals: 0 } },
          assistsActive: 1,
        }),
      },
    })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('ok')
    expect(result.observed).toContain('pointer: depth=1 p50=20ms p95=90ms refusals=0')
  })

  test('warns, never fails, when a lane p95 exceeds half the queueWaitMs budget — names the lane', async () => {
    const ctx = fakeDoctorContext({
      coControl: {
        probe: async () => ({
          ...ALL_CLEAR,
          lanes: { ...ZERO_LANES, pointer: { depth: 3, waitMsP50: 1200, waitMsP95: 4800, refusals: 2 } },
          queueWaitMs: 5_000,
        }),
      },
    })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('pointer')
    expect(result.remedy).toContain('4800ms')
  })

  test('a lane exactly AT half the budget does not warn — only strictly over does', async () => {
    const ctx = fakeDoctorContext({
      coControl: {
        probe: async () => ({
          ...ALL_CLEAR,
          lanes: { ...ZERO_LANES, keys: { depth: 0, waitMsP50: 10, waitMsP95: 2_500, refusals: 0 } },
          queueWaitMs: 5_000,
        }),
      },
    })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('ok')
  })

  test('warns and names the count when grants are uncollected (a leak: the reaper should have swept them)', async () => {
    const ctx = fakeDoctorContext({ coControl: { probe: async () => ({ ...ALL_CLEAR, uncollectedGrants: 2 }) } })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('2 assist grant(s)')
    expect(result.remedy).toContain('strand a device')
  })

  test('warns and names the count when mirror groups are orphaned (owner connection gone)', async () => {
    const ctx = fakeDoctorContext({ coControl: { probe: async () => ({ ...ALL_CLEAR, orphanedMirrorGroups: 3 }) } })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('3 mirror group(s)')
    expect(result.remedy).toContain('owner')
  })

  test('all three problems at once still produce exactly one warn result, with all three named in the remedy', async () => {
    const ctx = fakeDoctorContext({
      coControl: {
        probe: async () => ({
          ...ALL_CLEAR,
          lanes: { ...ZERO_LANES, text: { depth: 5, waitMsP50: 3_000, waitMsP95: 4_900, refusals: 10 } },
          uncollectedGrants: 1,
          orphanedMirrorGroups: 1,
        }),
      },
    })
    const result = await coControlCheck.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.remedy).toContain('text')
    expect(result.remedy).toContain('1 assist grant(s)')
    expect(result.remedy).toContain('1 mirror group(s)')
  })
})
