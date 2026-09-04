import { describe, expect, test } from 'bun:test'
import {
  ACTION_VERBS,
  ActionRequestSchema,
  ActionResultStatusSchema,
  ActionVerbSchema,
  DeviceSettingsPatchSchema,
  TargetSchema,
} from './actions'
import { DeviceSettingsSchema } from './settings'

/** One minimal, valid body per verb — the params `ActionRequestSchema` requires beside `target`. */
const MINIMAL_PARAMS: Record<(typeof ACTION_VERBS)[number], Record<string, unknown>> = {
  'run-script': { scriptId: 's1' },
  'run-workflow': { workflowName: 'w1' },
  install: { artifactId: 'a1' },
  push: { artifactId: 'a1', remotePath: '/sdcard/x' },
  pull: { remotePath: '/sdcard/x' },
  adb: { cmd: 'echo hi' },
  wake: {},
  sleep: {},
  reconnect: {},
  disconnect: {},
  cutover: { medium: 'wired' },
  forget: {},
  block: {},
  unquarantine: {},
  'set-network': { route: { engine: 'none' } },
  'set-label': {},
  'clear-label': {},
  'set-group': { groupId: 'g1' },
  'set-tags': { tags: ['a'] },
  prepare: {},
  'retry-prepare': { component: 'guest-agent' },
  'install-agent': {},
  'uninstall-agent': {},
  reprofile: {},
  screenshot: {},
  'clear-cache': { package: 'com.example' },
  settings: { settings: {} },
}

describe('ActionVerbSchema', () => {
  // The plan's §0 goal checklist says 26; its own §4.1 verb list and MVP
  // 07 §1.1's source list both name 25 (run-script, run-workflow, install,
  // push, pull, adb, wake, sleep, reconnect, disconnect, cutover, forget,
  // block, unquarantine, set-network, set-label, clear-label, set-group,
  // set-tags, prepare, retry-prepare, reprofile, screenshot, clear-cache,
  // settings). Recorded as a plan/plan discrepancy in §11; the verb table
  // is the fact this test pins.
  test('has exactly 27 verbs', () => {
    expect(ACTION_VERBS.length).toBe(27)
  })

  test('an unknown verb fails', () => {
    expect(ActionVerbSchema.safeParse('nuke').success).toBe(false)
  })
})

describe('ActionRequestSchema — every verb parses a minimal valid body', () => {
  for (const verb of ACTION_VERBS) {
    test(`${verb} parses`, () => {
      const result = ActionRequestSchema.safeParse({ verb, target: { deviceIds: ['d1'] }, ...MINIMAL_PARAMS[verb] })
      expect(result.success).toBe(true)
    })
  }
})

describe('TargetSchema', () => {
  test('refuses an empty object', () => {
    expect(TargetSchema.safeParse({}).success).toBe(false)
  })

  test('refuses an empty deviceIds array', () => {
    expect(TargetSchema.safeParse({ deviceIds: [] }).success).toBe(false)
  })

  test('accepts deviceIds, groupId, tags', () => {
    expect(TargetSchema.safeParse({ deviceIds: ['d1'] }).success).toBe(true)
    expect(TargetSchema.safeParse({ groupId: 'g1' }).success).toBe(true)
    expect(TargetSchema.safeParse({ tags: ['t1'] }).success).toBe(true)
  })
})

describe('run-script — exactly one of scriptId or scriptRef', () => {
  test('both scriptId and scriptRef fails', () => {
    const result = ActionRequestSchema.safeParse({
      verb: 'run-script',
      target: { deviceIds: ['d1'] },
      scriptId: 's1',
      scriptRef: 's1@1.0.0',
    })
    expect(result.success).toBe(false)
  })

  test('neither scriptId nor scriptRef fails', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'run-script', target: { deviceIds: ['d1'] } })
    expect(result.success).toBe(false)
  })

  test('exactly one succeeds', () => {
    expect(
      ActionRequestSchema.safeParse({ verb: 'run-script', target: { deviceIds: ['d1'] }, scriptId: 's1' }).success,
    ).toBe(true)
    expect(
      ActionRequestSchema.safeParse({ verb: 'run-script', target: { deviceIds: ['d1'] }, scriptRef: 's1@1.0.0' }).success,
    ).toBe(true)
  })
})

describe('cutover — medium required to start, not to cancel', () => {
  test('op start without medium fails', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'cutover', target: { deviceIds: ['d1'] }, op: 'start' })
    expect(result.success).toBe(false)
  })

  test('op cancel without medium passes', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'cutover', target: { deviceIds: ['d1'] }, op: 'cancel' })
    expect(result.success).toBe(true)
  })

  test('default op is start, so medium is required by default', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'cutover', target: { deviceIds: ['d1'] } })
    expect(result.success).toBe(false)
  })
})

describe('set-network — route required for op: set', () => {
  test('op set without route fails', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'set-network', target: { deviceIds: ['d1'] }, op: 'set' })
    expect(result.success).toBe(false)
  })

  test('op enable without route passes', () => {
    const result = ActionRequestSchema.safeParse({ verb: 'set-network', target: { deviceIds: ['d1'] }, op: 'enable' })
    expect(result.success).toBe(true)
  })
})

describe('DeviceSettingsPatchSchema — a two-level partial of DeviceSettingsSchema', () => {
  test('the key set matches DeviceSettingsSchema.shape exactly', () => {
    expect(Object.keys(DeviceSettingsPatchSchema.shape).sort()).toEqual(Object.keys(DeviceSettingsSchema.shape).sort())
  })

  test('every block and every field inside it is optional; an empty patch parses', () => {
    expect(DeviceSettingsPatchSchema.safeParse({}).success).toBe(true)
  })

  test('a partial nested block (one field of many) parses', () => {
    const result = DeviceSettingsPatchSchema.safeParse({ prep: { keepAwake: 'always' } })
    expect(result.success).toBe(true)
  })
})

describe('ActionResultStatusSchema', () => {
  test('accepts exactly the six values', () => {
    const values = ['accepted', 'skipped', 'forbidden', 'warned', 'done', 'failed']
    for (const value of values) expect(ActionResultStatusSchema.safeParse(value).success).toBe(true)
    expect(ActionResultStatusSchema.safeParse('running').success).toBe(false)
  })
})
