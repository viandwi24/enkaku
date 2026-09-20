import { describe, expect, test } from 'bun:test'
import { WarmupSettingsSchema, type WarmupSettings } from './groups'
import type { PlatformId } from './platforms'
import { WARMUP_STYLES, stylesFor } from './warmup-catalog'
import { drawStyle, phaseCount, planWarmup, platformFor, type WarmupDevice } from './warmup'

/** A seeded generator, so every assertion below is about the plan and not about luck. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PLATFORMS: PlatformId[] = ['tiktok', 'instagram', 'youtube']
const settings = (over: Partial<WarmupSettings> = {}): WarmupSettings => WarmupSettingsSchema.parse({ keywords: ['trading', 'forex', 'gold'], ...over })
const fleet = (count: number): WarmupDevice[] => Array.from({ length: count }, (_, i) => ({ deviceId: `d${i}`, number: i + 1 }))
/** 2026-09-20 12:00 UTC — comfortably inside one WIB day. */
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)

describe('D6.2 — the platform group is keyed on the phone number, and shifts daily', () => {
  test('a fleet splits into equal groups', () => {
    const counts: Record<string, number> = {}
    // Numbers 1..81 here on purpose: the point of THIS test is the split being equal.
    for (const device of fleet(81)) {
      const platform = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
      counts[platform as string] = (counts[platform as string] ?? 0) + 1
    }
    expect(Object.values(counts).sort()).toEqual([27, 27, 27])
  })

  test('the same phone on the same day gets the same platform, every time', () => {
    const device = { deviceId: 'd', number: 7 }
    const once = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
    expect(platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW + 3_600_000 })).toBe(once as PlatformId)
  })

  test('the rotation turns over at local midnight, so tomorrow is a different platform', () => {
    const device = { deviceId: 'd', number: 7 }
    const today = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
    const tomorrow = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW + 86_400_000 })
    expect(tomorrow).not.toBe(today as PlatformId)
  })

  test('a second session on the same day uses `slot` to get a different split', () => {
    const device = { deviceId: 'd', number: 7 }
    const first = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
    expect(platformFor({ device, platforms: PLATFORMS, slot: 1, phase: 0, nowMs: NOW })).not.toBe(first as PlatformId)
  })

  /*
    The trap CLAUDE.md devotes a paragraph to. A batch position is reshuffled by
    `order: random` and renumbered whenever a phone is offline, so a rotation
    keyed on it would give one phone the same platform twice and another none —
    with every run green. An unnumbered phone must therefore never be rotated as
    if it were number zero.
  */
  test('the platform follows the NUMBER, not the position in the list', () => {
    /*
      The decisive one. A fleet numbered 1..n makes position and number the same
      thing, so a rotation keyed on either would pass — which is how this defect
      hides. These numbers are scattered, as a real farm's are once phones have
      been added and retired.
    */
    const scattered: WarmupDevice[] = [
      { deviceId: 'a', number: 54 },
      { deviceId: 'b', number: 7 },
      { deviceId: 'c', number: 54 },
      { deviceId: 'd', number: 8 },
    ]
    const at = (i: number) => platformFor({ device: scattered[i] as WarmupDevice, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
    // Same number, different positions — same platform.
    expect(at(0)).toBe(at(2) as PlatformId)
    // Adjacent positions, adjacent numbers — different platforms.
    expect(at(1)).not.toBe(at(3) as PlatformId)
    // And reordering the fleet changes nothing about any of them.
    const reversed = [...scattered].reverse()
    for (const device of reversed) {
      const own = platformFor({ device, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
      const before = platformFor({ device: scattered.find((d) => d.deviceId === device.deviceId) as WarmupDevice, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })
      expect(own).toBe(before as PlatformId)
    }
  })

  /*
    The same fact, through `planWarmup` rather than through `platformFor`.
    Written after a mutation test: keying the plan on the device's POSITION in
    the list left the direct test above green, because that one calls
    `platformFor` itself. The defect would live in the wiring, so the wiring is
    what this covers.
  */
  test('the plan itself follows the number, so reordering the fleet changes nobody', () => {
    const scattered: WarmupDevice[] = [
      { deviceId: 'a', number: 54 },
      { deviceId: 'b', number: 7 },
      { deviceId: 'c', number: 31 },
      { deviceId: 'd', number: 8 },
    ]
    const of = (devices: WarmupDevice[]) => {
      const out = new Map<string, string | null>()
      for (const a of planWarmup({ devices, settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(11) })) out.set(a.deviceId, a.platform)
      return out
    }
    const forward = of(scattered)
    const reversed = of([...scattered].reverse())
    for (const device of scattered) expect(reversed.get(device.deviceId)).toBe(forward.get(device.deviceId) as string | null)
    // And the four are not all on one platform, which a broken key could also produce.
    expect(new Set(forward.values()).size).toBeGreaterThan(1)
  })

  test('a phone with no number gets nothing, and is never rotated as number zero', () => {
    expect(platformFor({ device: { deviceId: 'd', number: null }, platforms: PLATFORMS, slot: 0, phase: 0, nowMs: NOW })).toBeNull()
    const [plan] = planWarmup({ devices: [{ deviceId: 'd', number: null }], settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(1) })
    expect(plan?.platform).toBeNull()
    expect(plan?.steps).toEqual([])
    expect(plan?.note).toContain('no device number')
  })
})

describe('a phone is only sent to a platform it carries', () => {
  /*
    The workflow assumed every phone could do every platform. On a real farm a
    phone labelled only `tiktok` has no YouTube account, and a rotation that
    ignores that sends a third of the fleet to fail on a signed-out app one day
    in three.
  */
  test("a phone's own label comes FIRST, and the rest of the session follows it", () => {
    /*
      The labels order the platforms; they no longer narrow them (0.57.3). The
      owner's instruction was that the operator's choice of phones is the
      choice — *"bisa spesifik choose devices, bisa per labels atau per grup
      atau all devices langsung"* — and a second, invisible filter on top of it
      is how one Start quietly does a third of the job.

      What the label still buys is this: a session with fewer phases than
      platforms covers what the phone is KNOWN for first.
    */
    const device: WarmupDevice = { deviceId: 'd', number: 5, platforms: ['tiktok'] }
    const got = [0, 1, 2].map((phase) => planWarmup({ devices: [device], settings: settings(), platforms: PLATFORMS, phase, nowMs: NOW, random: rng(phase) })[0])
    expect(got[0]?.platform).toBe('tiktok')
    expect(new Set(got.map((g) => g?.platform))).toEqual(new Set(PLATFORMS))
  })

  test('a phone with two platforms still alternates between them', () => {
    const device: WarmupDevice = { deviceId: 'd', number: 5, platforms: ['tiktok', 'youtube'] }
    const seen = new Set([0, 1].map((phase) => planWarmup({ devices: [device], settings: settings(), platforms: PLATFORMS, phase, nowMs: NOW, random: rng(1) })[0]?.platform))
    expect(seen).toEqual(new Set(['tiktok', 'youtube']))
  })

  test('a phone carrying no platform label is still warmed up', () => {
    // It used to be given nothing and a sentence telling the operator to add a
    // label. On a farm whose phones all carry all three accounts that was the
    // whole fleet doing nothing, for a reason the operator did not agree with.
    const device: WarmupDevice = { deviceId: 'd', number: 5, platforms: [] }
    const [plan] = planWarmup({ devices: [device], settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(1) })
    expect(plan?.platform).not.toBeNull()
    expect(plan?.steps.length).toBeGreaterThan(0)
  })

  test('a phone with no platforms listed at all is taken as able to do them all, as before', () => {
    const [plan] = planWarmup({ devices: [{ deviceId: 'd', number: 5 }], settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(1) })
    expect(plan?.platform).not.toBeNull()
  })
})

describe('D6.3 — phases cover every phone on every platform', () => {
  test('three phases give one phone all three platforms', () => {
    const device = { deviceId: 'd', number: 4 }
    const seen = [0, 1, 2].map((phase) => platformFor({ device, platforms: PLATFORMS, slot: 0, phase, nowMs: NOW }))
    expect(new Set(seen).size).toBe(3)
  })

  test('every phone in the fleet covers every platform across the phases', () => {
    for (const device of fleet(9)) {
      const seen = [0, 1, 2].map((phase) => platformFor({ device, platforms: PLATFORMS, slot: 0, phase, nowMs: NOW }))
      expect(new Set(seen).size).toBe(3)
    }
  })

  test('asking for more phases than platforms does not repeat a platform', () => {
    expect(phaseCount(settings({ phases: 3 }), ['tiktok', 'instagram'])).toBe(2)
    expect(phaseCount(settings({ phases: 3 }), PLATFORMS)).toBe(3)
    expect(phaseCount(settings({ phases: 1 }), PLATFORMS)).toBe(1)
  })
})

describe('D6.4 — the style draw is weighted, and redrawn per session', () => {
  test('a weight of zero takes a style out of the draw without removing it from the catalog', () => {
    const weights = { 'tt-a': 0, 'tt-b': 0 }
    const drawn = new Set(Array.from({ length: 50 }, (_, i) => drawStyle('tiktok', weights, rng(i))?.id))
    expect(drawn).toEqual(new Set(['tt-c']))
    expect(stylesFor('tiktok').map((s) => s.id)).toContain('tt-a')
  })

  test('a style the operator has never weighted still joins the draw', () => {
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => drawStyle('instagram', {}, rng(i))?.id))
    expect(drawn).toEqual(new Set(['ig-a', 'ig-b', 'ig-c']))
  })

  test('a heavier weight is drawn more often', () => {
    let heavy = 0
    for (let i = 0; i < 400; i++) if (drawStyle('youtube', { 'yt-a': 10, 'yt-b': 1, 'yt-c': 1 }, rng(i))?.id === 'yt-a') heavy++
    expect(heavy).toBeGreaterThan(250)
  })

  /* A deliberate choice by the operator, so it is reported rather than silently substituted. */
  test('every style turned off is said out loud, not worked around', () => {
    const weights = Object.fromEntries(stylesFor('tiktok').map((s) => [s.id, 0]))
    expect(drawStyle('tiktok', weights, rng(1))).toBeNull()
    const [plan] = planWarmup({ devices: [{ deviceId: 'd', number: 3 }], settings: settings({ styleWeights: weights, slot: 0 }), platforms: ['tiktok'], phase: 0, nowMs: NOW, random: rng(1) })
    expect(plan?.steps).toEqual([])
    expect(plan?.note).toContain('turned off')
  })
})

describe('D6.1, D6.5 — start jitter, shuffle and gaps', () => {
  const plan = (over: Partial<WarmupSettings> = {}, seed = 3) =>
    planWarmup({ devices: fleet(12), settings: settings(over), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(seed) })

  test('the first step of each phone waits a random time inside the jitter window', () => {
    const firsts = plan({ startJitterSec: 120 }).map((a) => a.steps[0]?.atSec ?? 0)
    for (const at of firsts) expect(at).toBeGreaterThanOrEqual(0)
    for (const at of firsts) expect(at).toBeLessThanOrEqual(120)
    expect(new Set(firsts).size).toBeGreaterThan(1)
  })

  test('a jitter of zero starts every phone at once, which is the operator asking for it', () => {
    for (const assignment of plan({ startJitterSec: 0 })) expect(assignment.steps[0]?.atSec).toBe(0)
  })

  test('steps are spaced by a gap drawn from the range', () => {
    for (const assignment of plan({ gapSec: [30, 40], startJitterSec: 0 })) {
      for (let i = 1; i < assignment.steps.length; i++) {
        const gap = (assignment.steps[i]?.atSec ?? 0) - (assignment.steps[i - 1]?.atSec ?? 0)
        expect(gap).toBeGreaterThanOrEqual(30)
        expect(gap).toBeLessThanOrEqual(40)
      }
    }
  })

  test('the activities of a style run in a different order on different phones', () => {
    const orders = new Set(plan().filter((a) => a.steps.length > 2).map((a) => a.steps.map((s) => s.activityId).join('>')))
    expect(orders.size).toBeGreaterThan(1)
  })

  test('a phone does the number of activities the operator asked for, and never one twice', () => {
    // Since 0.57.0 the COUNT is the operator's (`activitiesPerPhone`) and the
    // style only decides what the activities are. Repeating one inside a
    // sequence is the one shape that reads as a script rather than a person,
    // so the top-up from other styles must never do it.
    for (const assignment of plan({ activitiesPerPhone: 5 })) {
      if (assignment.styleId === null) continue
      const ids = assignment.steps.map((step) => step.activityId)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBe(5)
    }
  })

  test('asking for fewer than a style has takes some of it, still shuffled', () => {
    for (const assignment of plan({ activitiesPerPhone: 2 })) {
      if (assignment.styleId === null) continue
      expect(assignment.steps).toHaveLength(2)
    }
  })

  test('the drawn style is where a phone\'s activities come from first', () => {
    // The top-up exists for a style shorter than the number asked for; it must
    // not quietly become the main source and flatten the styles into one pool.
    for (const assignment of plan({ activitiesPerPhone: 1 })) {
      if (assignment.styleId === null) continue
      const style = WARMUP_STYLES.find((entry) => entry.id === assignment.styleId)
      expect(style?.activities.map((activity) => activity.id)).toContain(assignment.steps[0]?.activityId as string)
    }
  })

  test('a phone gets what the platform actually has when it has fewer', () => {
    for (const assignment of plan({ activitiesPerPhone: 12 })) {
      if (assignment.platform === null) continue
      const available = new Set(WARMUP_STYLES.filter((style) => style.platform === assignment.platform).flatMap((style) => style.activities.map((a) => a.id)))
      expect(assignment.steps.length).toBe(Math.min(12, available.size))
    }
  })
})

describe('D6.6 — counts scale with `amount`', () => {
  const videosFor = (amount: number): number[] => {
    const out: number[] = []
    for (let seed = 0; seed < 40; seed++) {
      for (const assignment of planWarmup({ devices: fleet(6), settings: settings({ amount }), platforms: ['tiktok'], phase: 0, nowMs: NOW, random: rng(seed) })) {
        for (const step of assignment.steps) if (typeof step.params.videos === 'number') out.push(step.params.videos)
      }
    }
    return out
  }

  test('a larger amount asks for more', () => {
    const small = videosFor(0.5)
    const large = videosFor(2)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(large)).toBeGreaterThan(mean(small) * 2)
  })

  test('a small amount never asks for zero of something', () => {
    for (const videos of videosFor(0.2)) expect(videos).toBeGreaterThanOrEqual(1)
  })

  /*
    Two members declare a minimum above 1 (`check-notifications` wants
    `maxItems >= 5`, `check-profile` wants `maxRows >= 3`). A low `amount` used
    to draw a value their own schema refuses at dispatch — a failure an operator
    reads as the script being broken. Carried from the rotation's 0.49.0 note.
  */
  test("a small amount still respects a member's own floor", () => {
    for (let seed = 0; seed < 60; seed++) {
      for (const assignment of planWarmup({ devices: fleet(9), settings: settings({ amount: 0.2 }), platforms: ['youtube'], phase: 0, nowMs: NOW, random: rng(seed) })) {
        for (const step of assignment.steps) {
          if (typeof step.params.maxItems === 'number') expect(step.params.maxItems).toBeGreaterThanOrEqual(5)
          if (typeof step.params.maxRows === 'number') expect(step.params.maxRows).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})

describe('the plan itself', () => {
  test('the same seed plans the same session twice', () => {
    const once = planWarmup({ devices: fleet(20), settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(9) })
    const again = planWarmup({ devices: fleet(20), settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(9) })
    expect(once).toEqual(again)
  })

  /* A fleet of eighty where four silently did nothing is the failure this plugin exists to avoid. */
  test('every phone gets an assignment, even the ones that get no work', () => {
    const devices = [...fleet(5), { deviceId: 'no-number', number: null }]
    const plan = planWarmup({ devices, settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(2) })
    expect(plan.map((a) => a.deviceId)).toEqual(devices.map((d) => d.deviceId))
    for (const assignment of plan) expect(assignment.steps.length > 0 || assignment.note !== null).toBe(true)
  })

  test('every step names a real script ref', () => {
    for (const assignment of planWarmup({ devices: fleet(30), settings: settings(), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(5) })) {
      for (const step of assignment.steps) expect(step.script).toMatch(/^(tiktok|instagram|youtube)\/[a-z-]+@latest$/)
    }
  })

  test('the keywords an operator set are the ones that reach the scripts', () => {
    const plan = planWarmup({ devices: fleet(30), settings: settings({ keywords: ['emas', 'saham'] }), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(4) })
    for (const assignment of plan) {
      for (const step of assignment.steps) {
        if (typeof step.params.query === 'string') expect(['emas', 'saham']).toContain(step.params.query)
        if (Array.isArray(step.params.keywords)) expect(step.params.keywords).toEqual(['emas', 'saham'])
      }
    }
  })

  test("the operator's like settings reach the members that accept them", () => {
    const plan = planWarmup({ devices: fleet(30), settings: settings({ like: { chance: 0.42, commentChance: 0.05, keywordBoost: 7 } }), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(6) })
    const steps = plan.flatMap((a) => a.steps)
    const withLikes = steps.filter((s) => 'likeProbability' in s.params)
    expect(withLikes.length).toBeGreaterThan(0)
    for (const step of withLikes) expect(step.params.likeProbability).toBe(0.42)

    // The boost is asserted only where it is SENT, not everywhere a like is:
    // `instagram/watch-stories` takes a like chance and declares no keyword
    // boost at all — it never reads a caption — and sending one would be
    // refused at dispatch. `scripts/check-warmup-params.ts` is what holds that
    // pairing right; this only refuses to assume it.
    /*
      Asserted per MEMBER, because `keywordBoostFactor` means two different
      things. Every pack but TikTok reads it as a multiplier in 1 to 10;
      `tiktok/keyword-videos` reads it as a watch-time TILT in 0 to 1, and
      sending the multiplier there had the farm refuse the job outright.
    */
    const withBoost = steps.filter((s) => 'keywordBoostFactor' in s.params)
    expect(withBoost.length).toBeGreaterThan(0)
    for (const step of withBoost) {
      const tilt = step.script.startsWith('tiktok/keyword-videos')
      expect(step.params.keywordBoostFactor).toBe(tilt ? 0.667 : 7)
    }
  })

  test("and the comment chance reaches every member that accepts one", () => {
    // The gap this closes: eight of nine styles sent the like and not the
    // comment, so a session's keywords tilted what a phone liked and never
    // what it opened and read.
    const plan = planWarmup({ devices: fleet(30), settings: settings({ like: { chance: 0.1, commentChance: 0.33, keywordBoost: 3 } }), platforms: PLATFORMS, phase: 0, nowMs: NOW, random: rng(6) })
    const withComments = plan.flatMap((a) => a.steps).filter((s) => 'commentProbability' in s.params)
    expect(withComments.length).toBeGreaterThan(0)
    for (const step of withComments) expect(step.params.commentProbability).toBe(0.33)
  })
})

describe('the catalog', () => {
  test('every platform has styles, and every style has activities', () => {
    for (const platform of PLATFORMS) {
      const styles = stylesFor(platform)
      expect(styles.length).toBeGreaterThan(0)
      for (const style of styles) expect(style.activities.length).toBeGreaterThan(0)
    }
  })

  test('style and activity ids are unique — `styleWeights` keys on them', () => {
    const styleIds = WARMUP_STYLES.map((s) => s.id)
    expect(new Set(styleIds).size).toBe(styleIds.length)
    const activityIds = WARMUP_STYLES.flatMap((s) => s.activities.map((a) => a.id))
    expect(new Set(activityIds).size).toBe(activityIds.length)
  })

  /*
    Found by checking every param in the catalog against the packs' own schemas
    (2026-09-20), not on a phone. `tiktok/keyword-videos` declares
    `keywordBoostFactor` and NOT `likeProbability`; the catalog was spreading
    both onto it, and an undeclared param is refused at dispatch — so every
    TikTok phone drawn into `tt-b` or `tt-c` would have failed with a validation
    error naming the plugin rather than the line that caused it.
  */
  test('tiktok/keyword-videos is sent the keyword boost but never a like chance', () => {
    const steps = planWarmup({ devices: fleet(40), settings: settings({ like: { chance: 0.5, commentChance: 0.05, keywordBoost: 6 } }), platforms: ['tiktok'], phase: 0, nowMs: NOW, random: rng(8) })
      .flatMap((a) => a.steps)
      .filter((s) => s.script.startsWith('tiktok/keyword-videos'))
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) {
      // The operator's 1-to-10 multiplier, MAPPED onto this member's 0-to-1 tilt: 1 becomes 0, 10 becomes 1.
      expect(step.params.keywordBoostFactor).toBe(0.556)
      expect('likeProbability' in step.params).toBe(false)
    }
  })

  test("an activity's script belongs to the platform its style is for", () => {
    for (const style of WARMUP_STYLES) {
      for (const item of style.activities) expect(item.script.startsWith(`${style.platform}/`)).toBe(true)
    }
  })
})

describe('a phone is never sent to the same platform twice in one session', () => {
  /*
    The failure this guards is silent: three green phases, one account never
    touched and another warmed up twice within the hour. It appeared the moment
    `phases` defaulted to 3 (0.57.0) on a farm whose phones carry two labels.
  */
  const twoLabelFleet = (n: number): WarmupDevice[] =>
    Array.from({ length: n }, (_, i) => ({ deviceId: `d${i}`, number: i + 1, platforms: ['tiktok', 'youtube'] as PlatformId[] }))

  const phasesOf = (device: WarmupDevice['deviceId'], fleet: WarmupDevice[]): (PlatformId | null)[] =>
    [0, 1, 2].map(
      (phase) => planWarmup({ devices: fleet, settings: settings({ phases: 3 }), platforms: [...PLATFORMS], phase, nowMs: 0, random: Math.random }).find((a) => a.deviceId === device)?.platform ?? null,
    )

  test('three phases cover the three platforms once each, never one of them twice', () => {
    const fleet = twoLabelFleet(6)
    for (const device of fleet) {
      const got = phasesOf(device.deviceId, fleet).filter((p): p is PlatformId => p !== null)
      expect(new Set(got).size).toBe(got.length)
      expect(new Set(got)).toEqual(new Set(PLATFORMS))
    }
  })

  test('a fourth phase would repeat, so it gives nothing and says why', () => {
    // `phaseCount` bounds a session to the platforms it covers, so this is the
    // belt to that braces — the guard that makes the no-repeat rule true even
    // if a stored row ever asks for more phases than there are platforms.
    const fleet = twoLabelFleet(2)
    const fourth = planWarmup({ devices: fleet, settings: settings({ phases: 3 }), platforms: ['tiktok', 'youtube'], phase: 2, nowMs: 0, random: Math.random })
    expect(fourth[0]?.platform).toBeNull()
    expect(fourth[0]?.note).toContain('covered them in the earlier phases')
  })
})
