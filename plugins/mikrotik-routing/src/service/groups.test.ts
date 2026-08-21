import { describe, expect, test } from 'bun:test'
import {
  conflict,
  decideActivation,
  describeConflicts,
  devicesOf,
  GROUP_KEY_PREFIX,
  GroupSchema,
  groupIdFromKey,
  groupKeyFor,
  overlappingDeviceIds,
  readGroup,
  writeGroup,
  type Group,
} from './groups'

/**
 * Step 122.7's PURE LOGIC portion — plan 122 §4.6 (groups, the exclusivity
 * invariant, the activation transaction) and §4.9 (the `group:<id>` KV
 * shape). No I/O anywhere in `groups.ts`; every test here is a plain
 * function call.
 */

function makeGroup(id: string, deviceIds: string[], overrides: Partial<Group> = {}): Group {
  return {
    id,
    name: overrides.name ?? id,
    note: overrides.note ?? '',
    entries: deviceIds.map((deviceId) => ({ deviceId, lanIp: `10.0.0.${deviceId}`, pathId: 'via-modem1' })),
    active: overrides.active ?? false,
    onDeactivate: overrides.onDeactivate ?? 'remove-rules',
    failoverPolicy: overrides.failoverPolicy ?? 'none',
    updatedAt: overrides.updatedAt ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

describe('group key helpers', () => {
  test('groupKeyFor / groupIdFromKey round-trip', () => {
    expect(groupKeyFor('jadwal-1')).toBe('group:jadwal-1')
    expect(groupIdFromKey('group:jadwal-1')).toBe('jadwal-1')
  })

  test('groupIdFromKey rejects a key with no prefix', () => {
    expect(groupIdFromKey('config')).toBeNull()
    expect(groupIdFromKey('jadwal-1')).toBeNull()
  })

  test('groupIdFromKey rejects the bare prefix with no id', () => {
    expect(groupIdFromKey(GROUP_KEY_PREFIX)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// readGroup / writeGroup — the read-time-default discipline
// ---------------------------------------------------------------------------

describe('readGroup', () => {
  test('a well-formed value reads back exactly', () => {
    const stored = {
      name: 'Jadwal-1',
      note: 'weekday rotation',
      entries: [
        { deviceId: 'flip4-01', lanIp: '192.168.10.201', pathId: 'via-modem1' },
        { deviceId: 'flip4-02', lanIp: '192.168.10.202', pathId: 'via-modem2' },
      ],
      active: true,
      onDeactivate: 'disable-rules',
      failoverPolicy: 'substitute',
      updatedAt: 1_700_000_000,
    }
    expect(readGroup('jadwal-1', stored)).toEqual({
      id: 'jadwal-1',
      name: 'Jadwal-1',
      note: 'weekday rotation',
      entries: [
        { deviceId: 'flip4-01', lanIp: '192.168.10.201', pathId: 'via-modem1' },
        { deviceId: 'flip4-02', lanIp: '192.168.10.202', pathId: 'via-modem2' },
      ],
      active: true,
      onDeactivate: 'disable-rules',
      failoverPolicy: 'substitute',
      updatedAt: 1_700_000_000,
    })
  })

  test('id always comes from the caller, never from the stored value', () => {
    const stored = { id: 'someone-elses-id', name: 'Jadwal-1' }
    expect(readGroup('jadwal-1', stored).id).toBe('jadwal-1')
  })

  const junkValues: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not an object'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
  ]

  for (const [label, value] of junkValues) {
    test(`${label} reads as an empty, inactive group rather than throwing`, () => {
      const group = readGroup('jadwal-1', value)
      expect(group).toEqual({
        id: 'jadwal-1',
        name: '',
        note: '',
        entries: [],
        active: false,
        onDeactivate: 'remove-rules',
        failoverPolicy: 'none',
        updatedAt: 0,
      })
    })
  }

  test('an unrecognised onDeactivate/failoverPolicy value falls back rather than being kept', () => {
    const group = readGroup('g', { onDeactivate: 'delete-everything', failoverPolicy: 'yolo' })
    expect(group.onDeactivate).toBe('remove-rules')
    expect(group.failoverPolicy).toBe('none')
  })

  test('a negative or non-integer updatedAt falls back to 0', () => {
    expect(readGroup('g', { updatedAt: -5 }).updatedAt).toBe(0)
    expect(readGroup('g', { updatedAt: 1.5 }).updatedAt).toBe(0)
    expect(readGroup('g', { updatedAt: 'yesterday' }).updatedAt).toBe(0)
  })

  test('entries is defensive against a non-array and against junk entries inside it', () => {
    expect(readGroup('g', { entries: 'not an array' }).entries).toEqual([])
    expect(readGroup('g', { entries: null }).entries).toEqual([])
    expect(
      readGroup('g', {
        entries: [
          { deviceId: 'flip4-01', lanIp: '10.0.0.1', pathId: 'via-modem1' }, // kept
          { deviceId: '', pathId: 'via-modem1' }, // dropped — no device
          { deviceId: 'flip4-02' }, // dropped — no path
          'not an object', // dropped
          null, // dropped
        ],
      }).entries,
    ).toEqual([{ deviceId: 'flip4-01', lanIp: '10.0.0.1', pathId: 'via-modem1' }])
  })

  test('a dropped entry’s lanIp defaults to empty when the field is missing rather than rejecting the whole entry', () => {
    expect(readGroup('g', { entries: [{ deviceId: 'flip4-01', pathId: 'via-modem1' }] }).entries).toEqual([{ deviceId: 'flip4-01', lanIp: '', pathId: 'via-modem1' }])
  })
})

describe('writeGroup / GroupSchema round-trip', () => {
  const fixtures: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['an array', [1, 2, 3]],
    ['a well-formed row', { name: 'Jadwal-1', entries: [{ deviceId: 'a', lanIp: '10.0.0.1', pathId: 'p1' }], active: true, onDeactivate: 'disable-rules', failoverPolicy: 'substitute', updatedAt: 5 }],
    ['a row with junk entries mixed in', { entries: [{ deviceId: 'a', pathId: 'p1' }, 'junk', { deviceId: '', pathId: 'p1' }] }],
  ]

  for (const [label, value] of fixtures) {
    test(`readGroup(...) piped through writeGroup always satisfies GroupSchema — ${label}`, () => {
      const stored = writeGroup(readGroup('g', value))
      const parsed = GroupSchema.safeParse(stored)
      expect(parsed.success).toBe(true)
    })
  }

  test('writeGroup only carries the three named entry fields, dropping anything an entry object was extended with in memory', () => {
    const group = readGroup('g', { entries: [{ deviceId: 'a', lanIp: '10.0.0.1', pathId: 'p1' }] })
    const stored = writeGroup(group)
    expect(stored.entries).toEqual([{ deviceId: 'a', lanIp: '10.0.0.1', pathId: 'p1' }])
  })
})

// ---------------------------------------------------------------------------
// The conflict algebra — §4.6's worked example, both directions
// ---------------------------------------------------------------------------

describe('devicesOf / overlappingDeviceIds / conflict', () => {
  // The owner's own usage shape (plan 122 §4.6): Jadwal-1/2 both cover
  // devices 1-5, Jadwal-3/4 both cover devices 6-10.
  const devices1to5 = ['flip4-01', 'flip4-02', 'flip4-03', 'flip4-04', 'flip4-05']
  const devices6to10 = ['flip4-06', 'flip4-07', 'flip4-08', 'flip4-09', 'flip4-10']

  const jadwal1 = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1' })
  const jadwal2 = makeGroup('jadwal-2', devices1to5, { name: 'Jadwal-2' })
  const jadwal3 = makeGroup('jadwal-3', devices6to10, { name: 'Jadwal-3' })
  const jadwal4 = makeGroup('jadwal-4', devices6to10, { name: 'Jadwal-4' })

  test('devicesOf deduplicates', () => {
    const dup = makeGroup('g', ['a', 'b', 'a'])
    expect(devicesOf(dup)).toEqual(new Set(['a', 'b']))
  })

  test('same-device-set groups conflict: Jadwal-1 <-> Jadwal-2', () => {
    expect(conflict(jadwal1, jadwal2)).toBe(true)
    expect(conflict(jadwal2, jadwal1)).toBe(true) // symmetric
  })

  test('same-device-set groups conflict: Jadwal-3 <-> Jadwal-4', () => {
    expect(conflict(jadwal3, jadwal4)).toBe(true)
  })

  test('disjoint-device-set groups do NOT conflict, in every cross pairing', () => {
    expect(conflict(jadwal1, jadwal3)).toBe(false)
    expect(conflict(jadwal1, jadwal4)).toBe(false)
    expect(conflict(jadwal2, jadwal3)).toBe(false)
    expect(conflict(jadwal2, jadwal4)).toBe(false)
  })

  test('overlappingDeviceIds names the exact devices, sorted, not just "conflict"', () => {
    expect(overlappingDeviceIds(jadwal1, jadwal2)).toEqual(devices1to5.slice().sort())
  })

  test('overlappingDeviceIds is empty for disjoint groups', () => {
    expect(overlappingDeviceIds(jadwal1, jadwal3)).toEqual([])
  })

  test('a partial overlap reports only the shared devices, not the union', () => {
    const a = makeGroup('a', ['x', 'y', 'z'])
    const b = makeGroup('b', ['y', 'z', 'w'])
    expect(overlappingDeviceIds(a, b)).toEqual(['y', 'z'])
    expect(conflict(a, b)).toBe(true)
  })

  test('a group does not conflict with an empty group, or with itself', () => {
    const empty = makeGroup('empty', [])
    expect(conflict(jadwal1, empty)).toBe(false)
    expect(conflict(jadwal1, jadwal1)).toBe(true) // set-theoretically true — decideActivation excludes self by id, not this predicate
  })
})

// ---------------------------------------------------------------------------
// decideActivation — the activation decision and the force path
// ---------------------------------------------------------------------------

describe('decideActivation', () => {
  const devices1to5 = ['flip4-01', 'flip4-02', 'flip4-03', 'flip4-04']
  const devices6to10 = ['flip4-06', 'flip4-07']

  test('clean when there are no active groups at all', () => {
    const candidate = makeGroup('jadwal-2', devices1to5, { name: 'Jadwal-2' })
    expect(decideActivation(candidate, [], false)).toEqual({ kind: 'clean' })
  })

  test('clean when every active group is disjoint from the candidate — many groups active at once', () => {
    const candidate = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1' })
    const active = [makeGroup('jadwal-3', devices6to10, { name: 'Jadwal-3', active: true }), makeGroup('jadwal-4', devices6to10, { name: 'Jadwal-4', active: true })]
    expect(decideActivation(candidate, active, false)).toEqual({ kind: 'clean' })
  })

  test('refuse, naming the conflicting group and the exact overlapping devices, when force is false', () => {
    const candidate = makeGroup('jadwal-2', devices1to5, { name: 'Jadwal-2' })
    const activeJadwal1 = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1', active: true })
    const decision = decideActivation(candidate, [activeJadwal1], false)
    expect(decision).toEqual({
      kind: 'refuse',
      conflicts: [{ group: activeJadwal1, overlappingDeviceIds: devices1to5.slice().sort() }],
    })
  })

  test('force names exactly which active groups would be deactivated, computed but not applied', () => {
    const candidate = makeGroup('jadwal-2', devices1to5, { name: 'Jadwal-2' })
    const activeJadwal1 = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1', active: true })
    const decision = decideActivation(candidate, [activeJadwal1], true)
    expect(decision).toEqual({
      kind: 'force',
      toDeactivate: [{ group: activeJadwal1, overlappingDeviceIds: devices1to5.slice().sort() }],
    })
  })

  test('a candidate conflicting with two different active groups on different devices reports both, in order', () => {
    const candidate = makeGroup('mixed', ['flip4-01', 'flip4-06'], { name: 'Mixed' })
    const activeA = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1', active: true })
    const activeB = makeGroup('jadwal-3', devices6to10, { name: 'Jadwal-3', active: true })
    const decision = decideActivation(candidate, [activeA, activeB], false)
    expect(decision.kind).toBe('refuse')
    if (decision.kind !== 'refuse') throw new Error('unreachable')
    expect(decision.conflicts).toEqual([
      { group: activeA, overlappingDeviceIds: ['flip4-01'] },
      { group: activeB, overlappingDeviceIds: ['flip4-06'] },
    ])
  })

  test('re-activating an already-active group is never a conflict against its own prior activation', () => {
    const candidate = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1', active: true })
    // The caller's own "currently active" list includes the candidate itself,
    // as it would in practice: the group being re-activated is already active.
    const active = [candidate]
    expect(decideActivation(candidate, active, false)).toEqual({ kind: 'clean' })
  })

  test('an inactive group in the supplied list is never treated as a conflict, even if its device set overlaps', () => {
    const candidate = makeGroup('jadwal-2', devices1to5, { name: 'Jadwal-2' })
    const inactiveOverlap = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1', active: false })
    expect(decideActivation(candidate, [inactiveOverlap], false)).toEqual({ kind: 'clean' })
  })

  test('force with no actual conflict is still clean, not an empty force', () => {
    const candidate = makeGroup('jadwal-1', devices1to5, { name: 'Jadwal-1' })
    const active = [makeGroup('jadwal-3', devices6to10, { name: 'Jadwal-3', active: true })]
    expect(decideActivation(candidate, active, true)).toEqual({ kind: 'clean' })
  })
})

// ---------------------------------------------------------------------------
// describeConflicts — the exact wording bar §4.6 sets
// ---------------------------------------------------------------------------

describe('describeConflicts', () => {
  test("matches plan 122 §4.6's own worked example verbatim", () => {
    const jadwal1 = makeGroup('jadwal-1', ['flip4-03', 'flip4-04'], { name: 'Jadwal-1' })
    const conflicts = [{ group: jadwal1, overlappingDeviceIds: ['flip4-03', 'flip4-04'] }]
    expect(describeConflicts('Jadwal-2', conflicts)).toBe('Jadwal-2 conflicts with active Jadwal-1 on flip4-03, flip4-04')
  })

  test('joins more than one simultaneous conflict into one sentence', () => {
    const a = makeGroup('a', [], { name: 'Jadwal-1' })
    const b = makeGroup('b', [], { name: 'Jadwal-3' })
    const conflicts = [
      { group: a, overlappingDeviceIds: ['flip4-01'] },
      { group: b, overlappingDeviceIds: ['flip4-06'] },
    ]
    expect(describeConflicts('Mixed', conflicts)).toBe('Mixed conflicts with active Jadwal-1 on flip4-01; active Jadwal-3 on flip4-06')
  })
})
