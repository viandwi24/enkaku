import { describe, expect, test } from 'bun:test'
import { workTargetMissing } from './schedules'

/*
  The gap this closes, in the owner's own farm: a warm-up schedule kept but
  DISABLED, pointing at a workflow about to be retired. A script target has said
  "this no longer resolves" since plan 95, through `resolvesTo: null`. A workflow
  target said nothing — `resolvesTo` is null for it meaning "not applicable" — so
  the row looked exactly like a healthy one, and a disabled schedule never fires
  to discover otherwise.
*/
describe('workTargetMissing — a schedule whose work has gone', () => {
  const store = (names: string[]) => ({ get: (name: string) => (names.includes(name) ? { name } : null) })

  test('a workflow that is still there is not missing', () => {
    expect(workTargetMissing({ workflowName: 'warmup-rotation' }, store(['warmup-rotation']))).toBe(false)
  })

  test('a workflow that has gone is missing', () => {
    expect(workTargetMissing({ workflowName: 'warmup-rotation' }, store([]))).toBe(true)
  })

  test('a schedule with no workflow target is never missing', () => {
    // Script and agent targets answer this question elsewhere; answering it
    // here too would mark every script schedule broken.
    expect(workTargetMissing(null, store([]))).toBe(false)
  })

  /*
    A core wired without a workflow store cannot answer. It says "no": marking
    every workflow schedule broken because of how this core was assembled is a
    louder lie than saying nothing.
  */
  test('a core that cannot answer says no', () => {
    expect(workTargetMissing({ workflowName: 'warmup-rotation' }, undefined)).toBe(false)
  })

  test('the name is matched exactly, not by prefix', () => {
    expect(workTargetMissing({ workflowName: 'warmup' }, store(['warmup-rotation']))).toBe(true)
  })
})
