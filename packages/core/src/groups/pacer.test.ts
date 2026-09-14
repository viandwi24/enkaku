import { describe, expect, test } from 'bun:test'
import { drawIntervalMs, ladderRung, planSequentialStep, type SequentialMember } from './pacer'

/**
 * Plan 316 — sub-groups and phases one after another, the owner's warm-up model: every sub-group of a phase in turn,
 * then the next phase. `planSequentialStep` is the whole decision; the pacer only applies it.
 */
describe('planSequentialStep — sequential sub-groups and phases', () => {
  const run = (batchRepeat: number, status: string, held = false) => ({ batchRepeat, status, held })
  const m = (deviceId: string, wave: number, ...runs: SequentialMember['runs'][number][]): SequentialMember => ({ deviceId, wave, runs })

  test('while sub-group 1 is running, sub-group 2 stays held', () => {
    const members = [m('a', 0, run(0, 'running')), m('b', 0, run(0, 'success')), m('c', 1, run(0, 'queued', true))]
    expect(planSequentialStep(members, 3)).toEqual({ kind: 'wait' })
  })

  test('a released run that has not started yet still counts as its sub-group going', () => {
    const members = [m('a', 0, run(0, 'queued')), m('c', 1, run(0, 'queued', true))]
    expect(planSequentialStep(members, 1)).toEqual({ kind: 'wait' })
  })

  test('when every member of sub-group 1 has settled — failures included — sub-group 2 is released', () => {
    const members = [m('a', 0, run(0, 'success')), m('b', 0, run(0, 'failed')), m('c', 1, run(0, 'queued', true)), m('d', 2, run(0, 'queued', true))]
    expect(planSequentialStep(members, 3)).toEqual({ kind: 'release', repeat: 0, wave: 1 })
  })

  test('only after the LAST sub-group of a phase settles does the next phase start', () => {
    const phaseOneDone = [m('a', 0, run(0, 'success')), m('c', 1, run(0, 'expired')), m('d', 2, run(0, 'success'))]
    expect(planSequentialStep(phaseOneDone, 3)).toEqual({ kind: 'next-phase', repeat: 1 })
  })

  test('the next phase walks its sub-groups again, reading only its own runs', () => {
    const members = [m('a', 0, run(0, 'success'), run(1, 'success')), m('c', 1, run(0, 'success'), run(1, 'queued', true))]
    expect(planSequentialStep(members, 3)).toEqual({ kind: 'release', repeat: 1, wave: 1 })
  })

  test('the last phase settling is done, never a fourth phase', () => {
    const members = [m('a', 0, run(0, 'success'), run(1, 'success'), run(2, 'success'))]
    expect(planSequentialStep(members, 3)).toEqual({ kind: 'done' })
  })

  test('a held run that was cancelled does not hold the batch forever', () => {
    const members = [m('a', 0, run(0, 'success')), m('c', 1, run(0, 'cancelled', true))]
    expect(planSequentialStep(members, 2)).toEqual({ kind: 'next-phase', repeat: 1 })
  })

  test('it is idempotent: after a release the same view waits instead of releasing twice', () => {
    const released = [m('a', 0, run(0, 'success')), m('c', 1, run(0, 'queued', false))]
    expect(planSequentialStep(released, 1)).toEqual({ kind: 'wait' })
  })

  test('80 phones in sub-groups of 27, three phases: nine releases and two phase starts, in order', () => {
    const repeatCount = 3
    const members: SequentialMember[] = Array.from({ length: 80 }, (_, i) => m(`d${i}`, ladderRung(i, 27), run(0, 'queued', ladderRung(i, 27) > 0)))
    const steps: string[] = []
    for (let guard = 0; guard < 50; guard++) {
      // Everything released runs and succeeds; the planner decides the rest.
      for (const member of members) {
        const last = member.runs.at(-1)!
        if (last.status === 'queued' && !last.held) (member.runs as SequentialMember['runs'][number][])[member.runs.length - 1] = run(last.batchRepeat, 'success')
      }
      const step = planSequentialStep(members, repeatCount)
      if (step.kind === 'done') break
      if (step.kind === 'release') {
        steps.push(`p${step.repeat}w${step.wave}`)
        for (const member of members) {
          const last = member.runs.at(-1)!
          if (member.wave === step.wave && last.batchRepeat === step.repeat && last.held) (member.runs as SequentialMember['runs'][number][])[member.runs.length - 1] = run(step.repeat, 'queued', false)
        }
      }
      if (step.kind === 'next-phase') {
        steps.push(`phase${step.repeat}`)
        for (const member of members) (member.runs as SequentialMember['runs'][number][]).push(run(step.repeat, 'queued', member.wave > 0))
      }
    }
    expect(steps).toEqual(['p0w1', 'p0w2', 'phase1', 'p1w1', 'p1w2', 'phase2', 'p2w1', 'p2w2'])
    expect(members.every((member) => member.runs.length === 3 && member.runs.every((r) => r.status === 'success'))).toBe(true)
  })
})

/**
 * The per-device start delay (2026-09-06).
 *
 * `drawIntervalMs` is the one piece of arithmetic behind both the interval
 * between repetitions and the new per-device delay, so it is worth pinning on
 * its own: the rest of `planFirst` is a database walk that a unit test would
 * only restate.
 */
describe('drawIntervalMs — the draw behind a per-device start delay', () => {
  test('a range gives a value inside it, inclusive at both ends', () => {
    const seen = new Set<number>()
    for (let r = 0; r < 200; r++) {
      const v = drawIntervalMs(10_000, 30_000, () => r * 7919)
      expect(v).toBeGreaterThanOrEqual(10_000)
      expect(v).toBeLessThanOrEqual(30_000)
      seen.add(v)
    }
    // Different draws, not one value repeated — the whole point is that two
    // devices do not start at the same instant.
    expect(seen.size).toBeGreaterThan(1)
  })

  test('min === max is a fixed delay, not a coin flip', () => {
    expect(drawIntervalMs(5_000, 5_000, () => 12345)).toBe(5_000)
  })

  test('a zero range is no delay at all — today’s behaviour, unchanged', () => {
    expect(drawIntervalMs(0, 0, () => 999)).toBe(0)
  })

  test('an inverted range collapses to the lower bound rather than throwing', () => {
    // The schema refuses this at the boundary; the arithmetic still has to be
    // total, because a batch row written before that check existed can hold one.
    expect(drawIntervalMs(30_000, 10_000, () => 42)).toBe(30_000)
  })
})

/**
 * Sub-groups (the client's "subgrup"): the same ladder, stepping once per
 * WAVE instead of once per phone.
 *
 * Pinned here for the same reason `drawIntervalMs` is: it is the arithmetic
 * that decides when a phone is allowed to start, and the rest of `planFirst`
 * is a database walk a unit test would only restate.
 */
describe('ladderRung — how many devices share one rung', () => {
  test('waveSize 1 is a rung per phone — every batch written before sub-groups existed', () => {
    expect([0, 1, 2, 3].map((i) => ladderRung(i, 1))).toEqual([0, 1, 2, 3])
  })

  test('waveSize 10 sends 70 phones out in seven waves, not a 70-rung staircase', () => {
    expect(ladderRung(0, 10)).toBe(0)
    expect(ladderRung(9, 10)).toBe(0)
    expect(ladderRung(10, 10)).toBe(1)
    expect(ladderRung(69, 10)).toBe(6)
    // The point of the whole feature: at a 30 s rung the last phone waits
    // three minutes, not thirty-five.
    expect(ladderRung(69, 10) * 30_000).toBe(180_000)
  })

  test('a wave larger than the fleet is one wave, not an error', () => {
    expect([0, 5, 40].map((i) => ladderRung(i, 1000))).toEqual([0, 0, 0])
  })

  test('a zero or negative wave size reads as 1 rather than dividing by zero', () => {
    // A row written before the column existed, or one that reached here from
    // some other path, must still produce a number.
    expect(ladderRung(7, 0)).toBe(7)
    expect(ladderRung(7, -3)).toBe(7)
  })
})
