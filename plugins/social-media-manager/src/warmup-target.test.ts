import { describe, expect, test } from 'bun:test'
import { EVERY_PHONE, NO_GROUP, WarmupTargetSchema, describeTarget, reachesNothing, resolveWarmupTarget, type TargetableDevice } from './warmup-target'

const device = (id: string, labels: string[] = [], group: string | null = null): TargetableDevice => ({
  id,
  labels: labels.map((name) => ({ name })),
  group: group === null ? null : { id: `g-${group}`, name: group },
})

const fleet: TargetableDevice[] = [
  device('a', ['tiktok'], 'batch-a'),
  device('b', ['youtube'], 'batch-a'),
  device('c', ['tiktok', 'banned'], 'batch-b'),
  device('d', [], null),
]

const target = (over: Record<string, unknown>) => WarmupTargetSchema.parse(over)
const ids = (devices: readonly TargetableDevice[]): string[] => devices.map((d) => d.id)

describe('resolveWarmupTarget — the four questions an operator has', () => {
  test('every phone', () => {
    expect(ids(resolveWarmupTarget(fleet, EVERY_PHONE).chosen)).toEqual(['a', 'b', 'c', 'd'])
  })

  test('only these phones', () => {
    const { chosen, left } = resolveWarmupTarget(fleet, target({ mode: 'devices', deviceIds: ['b', 'd'] }))
    expect(ids(chosen)).toEqual(['b', 'd'])
    expect(left.find((v) => v.device.id === 'a')?.reason).toContain('not one of the phones')
  })

  test('every phone except these', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ exceptDeviceIds: ['a', 'c'] })).chosen)).toEqual(['b', 'd'])
  })

  test('only this label', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ mode: 'labels', labels: ['tiktok'] })).chosen)).toEqual(['a', 'c'])
  })

  test('every phone except a label', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ exceptLabels: ['banned'] })).chosen)).toEqual(['a', 'b', 'd'])
  })

  test('only this device group, and a group matches by name or by id', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ mode: 'groups', groups: ['batch-a'] })).chosen)).toEqual(['a', 'b'])
    expect(ids(resolveWarmupTarget(fleet, target({ mode: 'groups', groups: ['g-batch-b'] })).chosen)).toEqual(['c'])
  })

  test('every phone except a group', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ exceptGroups: ['batch-a'] })).chosen)).toEqual(['c', 'd'])
  })
})

describe('resolveWarmupTarget — the rules that decide the hard cases', () => {
  test('an exception beats the include that named the same phone', () => {
    // "Everything in this group except that one" is the commonest thing an
    // operator wants, and it is only expressible if the exception wins.
    const { chosen, left } = resolveWarmupTarget(fleet, target({ mode: 'devices', deviceIds: ['a', 'b'], exceptDeviceIds: ['b'] }))
    expect(ids(chosen)).toEqual(['a'])
    expect(left.find((v) => v.device.id === 'b')?.reason).toContain('left out of this session by name')
  })

  test('a start that excluded a phone says so differently from an exception that pulled it out', () => {
    // Two different mistakes to have made: a label you forgot to add, versus an
    // exception you forgot to remove. One sentence for both would hide it.
    const { left } = resolveWarmupTarget(fleet, target({ mode: 'labels', labels: ['youtube'], exceptLabels: ['banned'] }))
    expect(left.find((v) => v.device.id === 'a')?.reason).toContain("carries none of this session's labels")
    expect(left.find((v) => v.device.id === 'c')?.reason).toContain("carries none of this session's labels")
  })

  test('labels match any, not all, and ignore case and spacing', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ mode: 'labels', labels: ['TikTok', 'YouTube'] })).chosen)).toEqual(['a', 'b', 'c'])
  })

  test('a mode that names nothing reaches nothing, and every phone is told why', () => {
    // Silently reaching the whole fleet would be the dangerous reading: an
    // operator who picked "only these labels" and ticked none meant none.
    const { chosen, left } = resolveWarmupTarget(fleet, target({ mode: 'labels', labels: [] }))
    expect(chosen).toEqual([])
    expect(left).toHaveLength(4)
    expect(left[0]?.reason).toContain('names no label')
    expect(reachesNothing(target({ mode: 'labels', labels: [] }))).toBe(true)
    expect(reachesNothing(EVERY_PHONE)).toBe(false)
  })

  test('every phone is accounted for, chosen or left', () => {
    const { chosen, left } = resolveWarmupTarget(fleet, target({ mode: 'labels', labels: ['tiktok'], exceptLabels: ['banned'] }))
    expect(chosen.length + left.length).toBe(fleet.length)
  })
})

describe('describeTarget', () => {
  test('reads as the sentence the operator wrote', () => {
    expect(describeTarget(EVERY_PHONE)).toBe('Every phone')
    expect(describeTarget(target({ exceptDeviceIds: ['a'] }))).toBe('Every phone, except 1 named phone')
    expect(describeTarget(target({ mode: 'labels', labels: ['tiktok'], exceptLabels: ['banned'] }))).toBe('Phones labelled "tiktok", except anything labelled "banned"')
    expect(describeTarget(target({ mode: 'devices', deviceIds: ['a', 'b'] }))).toBe('2 phones chosen by hand')
  })
})

describe('the "no group" chip', () => {
  test('resolves to the phones in no group at all, on this side too', () => {
    // The picker's choice is STORED and resolved again whenever a schedule
    // fires, so the literal has to mean the same thing here as in Studio —
    // otherwise a session covering the ungrouped phones covers nobody the
    // second time it runs.
    const { chosen } = resolveWarmupTarget(fleet, target({ mode: 'groups', groups: [NO_GROUP] }))
    expect(ids(chosen)).toEqual(['d'])
  })

  test('and excludes them the same way', () => {
    expect(ids(resolveWarmupTarget(fleet, target({ exceptGroups: [NO_GROUP] })).chosen)).toEqual(['a', 'b', 'c'])
  })
})
