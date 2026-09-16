import { describe, expect, test } from 'bun:test'
import {
  ExcludeRuleSchema,
  NO_EXCLUDES,
  SKIPPED_BY_HAND,
  describeRule,
  excludedFor,
  inGroup,
  isEmptyRule,
  needsFleet,
  skipNoteFor,
  type ExcludableDevice,
} from './excludes'

function phone(input: Partial<ExcludableDevice> & { id: string }): ExcludableDevice {
  return { labels: [], group: null, ...input }
}

describe('the stored rule', () => {
  test('an empty rule parses, and is what a session written before skips existed means', () => {
    expect(ExcludeRuleSchema.parse({})).toEqual(NO_EXCLUDES)
    expect(isEmptyRule(NO_EXCLUDES)).toBe(true)
    expect(needsFleet(NO_EXCLUDES)).toBe(false)
  })

  test('a 0.45.0 rule with no group half still parses, as no group rules', () => {
    expect(ExcludeRuleSchema.parse({ devices: { 'dev-1': ['youtube'] }, labels: [] }).groups).toEqual([])
  })

  test('only the two rules that match on something the phone carries need the fleet read', () => {
    expect(needsFleet(ExcludeRuleSchema.parse({ devices: { 'dev-1': ['youtube'] } }))).toBe(false)
    expect(needsFleet(ExcludeRuleSchema.parse({ labels: [{ label: 'no-youtube', platforms: ['youtube'] }] }))).toBe(true)
    expect(needsFleet(ExcludeRuleSchema.parse({ groups: [{ group: 'batch-b', platforms: ['tiktok'] }] }))).toBe(true)
  })

  test('a key this build does not know is refused rather than silently ignored', () => {
    expect(ExcludeRuleSchema.safeParse({ devices: {}, labels: [], groups: [], everything: true }).success).toBe(false)
  })

  test('a label rule naming no platform is refused — it would read as a rule and do nothing', () => {
    expect(ExcludeRuleSchema.safeParse({ labels: [{ label: 'no-youtube', platforms: [] }] }).success).toBe(false)
  })
})

describe('which platforms a phone skips', () => {
  test('a label rule ignores case and spacing, exactly as the platform labels do', () => {
    // The same `labelKey` the router matches `tiktok`/`Tik Tok` with, so a rule written on one screen
    // and a label typed on another cannot disagree. Case and whitespace only: a hyphen is a character
    // an operator typed on purpose, and collapsing it would silently merge two different labels.
    const rule = ExcludeRuleSchema.parse({ labels: [{ label: 'No YouTube', platforms: ['youtube'] }] })
    for (const [name, expected] of [
      ['NOYOUTUBE', ['youtube']],
      ['No YouTube', ['youtube']],
      ['no youtube', ['youtube']],
      ['no-youtube', []],
    ] as const) {
      expect({ name, skips: [...excludedFor(phone({ id: 'd', labels: [{ name }] }), rule).keys()] }).toEqual({ name, skips: [...expected] })
    }
  })

  test('the label an operator actually typed matches itself, hyphen and all', () => {
    const rule = ExcludeRuleSchema.parse({ labels: [{ label: 'no-youtube', platforms: ['youtube'] }] })
    expect([...excludedFor(phone({ id: 'd', labels: [{ name: 'NO-YouTube' }] }), rule).keys()]).toEqual(['youtube'])
    expect([...excludedFor(phone({ id: 'd', labels: [{ name: 'no youtube' }] }), rule).keys()]).toEqual([])
  })

  test('a group rule matches the group by its id or by its name', () => {
    const rule = ExcludeRuleSchema.parse({ groups: [{ group: 'grp-7', platforms: ['tiktok'] }] })
    const byName = ExcludeRuleSchema.parse({ groups: [{ group: 'Batch B', platforms: ['tiktok'] }] })
    const device = phone({ id: 'd', group: { id: 'grp-7', name: 'Batch B' } })
    expect([...excludedFor(device, rule).keys()]).toEqual(['tiktok'])
    expect([...excludedFor(device, byName).keys()]).toEqual(['tiktok'])
    expect(inGroup(phone({ id: 'd' }), 'grp-7')).toBe(false)
  })

  test('the three rules are a union — a phone covered by all of them skips each platform once', () => {
    const rule = ExcludeRuleSchema.parse({
      groups: [{ group: 'Batch B', platforms: ['tiktok'] }],
      labels: [{ label: 'no-youtube', platforms: ['youtube'] }],
      devices: { 'dev-1': ['instagram'] },
    })
    const found = excludedFor(phone({ id: 'dev-1', labels: [{ name: 'no-youtube' }], group: { id: 'g', name: 'Batch B' } }), rule)
    expect([...found.keys()].sort()).toEqual(['instagram', 'tiktok', 'youtube'])
  })

  test('the most specific rule wins the WORDING, so a skip always names the decision its operator made', () => {
    const rule = ExcludeRuleSchema.parse({
      groups: [{ group: 'Batch B', platforms: ['youtube'] }],
      labels: [{ label: 'no-youtube', platforms: ['youtube'] }],
      devices: { 'dev-1': ['youtube'] },
    })
    const device = phone({ id: 'dev-1', labels: [{ name: 'no-youtube' }], group: { id: 'g', name: 'Batch B' } })
    expect(excludedFor(device, rule).get('youtube')).toBe(skipNoteFor({ kind: 'by-hand' }, 'youtube'))
    // Drop the by-hand half and the label speaks; drop that too and the group does.
    expect(excludedFor(device, { ...rule, devices: {} }).get('youtube')).toBe(skipNoteFor({ kind: 'label', label: 'no-youtube' }, 'youtube'))
    expect(excludedFor(device, { ...rule, devices: {}, labels: [] }).get('youtube')).toBe(skipNoteFor({ kind: 'group', group: 'Batch B' }, 'youtube'))
  })

  test('a group rule quotes the group\'s OWN name, not the id the picker sent', () => {
    const rule = ExcludeRuleSchema.parse({ groups: [{ group: 'grp-7', platforms: ['tiktok'] }] })
    expect(excludedFor(phone({ id: 'd', group: { id: 'grp-7', name: 'Batch B' } }), rule).get('tiktok')).toContain('"Batch B" group')
  })

  test('a phone none of the rules names skips nothing', () => {
    const rule = ExcludeRuleSchema.parse({ labels: [{ label: 'no-youtube', platforms: ['youtube'] }] })
    expect(excludedFor(phone({ id: 'other', labels: [{ name: 'tiktok' }] }), rule).size).toBe(0)
  })
})

describe('what a skip says', () => {
  test('every reason names the platform, says nothing failed, and says what undoes it', () => {
    for (const note of [
      skipNoteFor({ kind: 'by-hand' }, 'youtube'),
      skipNoteFor({ kind: 'label', label: 'no-youtube' }, 'youtube'),
      skipNoteFor({ kind: 'group', group: 'Batch B' }, 'youtube'),
      SKIPPED_BY_HAND,
    ]) {
      expect({ failed: note.includes('nothing failed'), enable: note.includes('Enable') }).toEqual({ failed: true, enable: true })
    }
    expect(skipNoteFor({ kind: 'label', label: 'no-youtube' }, 'youtube')).toContain('YouTube')
  })

  test('the one-line description names each half, and an empty rule says so', () => {
    expect(describeRule(NO_EXCLUDES)).toBe('no skips')
    const rule = ExcludeRuleSchema.parse({
      groups: [{ group: 'Batch B', platforms: ['tiktok'] }],
      labels: [{ label: 'no-youtube', platforms: ['youtube'] }],
      devices: { 'dev-1': ['instagram'] },
    })
    expect(describeRule(rule)).toBe('group "Batch B" → tiktok · label "no-youtube" → youtube · 1 phone by hand')
  })
})
