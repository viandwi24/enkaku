import { describe, expect, test } from 'bun:test'
import type { Selector } from '@enkaku/protocol'
import { matches, scoreContent } from './index'
import { makeRng, pickWatchMs, pngSize } from './human'
import { ACK_SELECTORS, DENY_SELECTORS, nextDialogAction } from './dialogs'

describe('keyword matching', () => {
  const KEYWORDS = ['trade', 'trading', 'xau', 'usd', 'scalping', 'swing', 'smc', 'ict']

  /**
   * The short trading acronyms are the whole reason this is not a plain `includes`. A false hit
   * does not merely miss — it tilts an unrelated video towards a long watch, which teaches the feed
   * the opposite of what the operator asked for.
   */
  test('short keywords do not match inside unrelated words', () => {
    for (const hay of ['predictions daily', 'addictive content', 'the victim', 'cosmetics haul']) {
      expect(scoreContent(hay, KEYWORDS, [])).toBe(0)
    }
  })

  test('short keywords still match when a separator is punctuation, not a space', () => {
    expect(matches('xau_ict setup', 'ict')).toBe(true)
    expect(matches('usd/jpy', 'usd')).toBe(true)
  })

  test('long keywords match inside a run-together handle, where nobody typed a space', () => {
    expect(matches('goldxauusdtrader', 'xauusd')).toBe(true)
    expect(scoreContent('scalpingsignals', KEYWORDS, [])).toBeGreaterThan(0)
  })

  test('a blocked word wins over any number of keyword hits', () => {
    expect(scoreContent('xau trading scalping', KEYWORDS, ['scalping'])).toBe(-1)
  })

  test('score counts distinct hits, so a stronger signal tilts further', () => {
    expect(scoreContent('trading xau', KEYWORDS, [])).toBe(2)
  })
})

describe('watch-time tilt', () => {
  /**
   * The tilt must SHIFT the distribution, never replace it. A matched video that is always watched
   * long and an unmatched one always skipped produces a perfectly bimodal watch time — a sharper
   * fingerprint than no randomisation at all, because no person is that consistent.
   */
  const sample = (tilt: number): Record<string, number> => {
    const rng = makeRng(12345)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const { label } = pickWatchMs(rng, tilt)
      counts[label] = (counts[label] ?? 0) + 1
    }
    return counts
  }

  test('a positive tilt raises long watches without eliminating short ones', () => {
    const tilted = sample(0.9)
    expect((tilted.engaged ?? 0) + (tilted.hooked ?? 0)).toBeGreaterThan(0)
    expect(tilted.skip ?? 0).toBeGreaterThan(0)
  })

  test('a negative tilt raises skips without eliminating long watches', () => {
    const tilted = sample(-0.9)
    expect(tilted.skip ?? 0).toBeGreaterThan(0)
    expect((tilted.watch ?? 0) + (tilted.engaged ?? 0) + (tilted.hooked ?? 0)).toBeGreaterThan(0)
  })

  test('a positive tilt produces more long watches than a negative one', () => {
    const long = (c: Record<string, number>) => (c.engaged ?? 0) + (c.hooked ?? 0)
    expect(long(sample(0.9))).toBeGreaterThan(long(sample(-0.9)))
  })

  test('the same seed replays the same sequence', () => {
    const a = makeRng(7)
    const b = makeRng(7)
    expect([pickWatchMs(a).ms, pickWatchMs(a).ms]).toEqual([pickWatchMs(b).ms, pickWatchMs(b).ms])
  })
})

describe('frame size from a screenshot', () => {
  // `DeviceApi` exposes no frame size and `find()` refuses viewport-sized containers, so the PNG
  // header is where the geometry comes from. Getting it wrong aims every swipe at the wrong place.
  test('reads width and height out of the IHDR', () => {
    const png = new Uint8Array(24)
    const dv = new DataView(png.buffer)
    dv.setUint32(0, 0x89504e47)
    dv.setUint32(16, 720)
    dv.setUint32(20, 1640)
    expect(pngSize(png)).toEqual({ width: 720, height: 1640 })
  })

  test('refuses anything that is not a PNG rather than guessing', () => {
    expect(pngSize(new Uint8Array(24))).toBeNull()
    expect(pngSize(new Uint8Array(4))).toBeNull()
  })
})

describe('dialog dismiss selectors — the safety invariant', () => {
  const textOf = (sel: Selector): string | undefined => ('text' in sel ? sel.text : undefined)
  const ackTexts = ACK_SELECTORS.map(textOf).filter((t): t is string => t !== undefined)
  const denyTexts = DENY_SELECTORS.map(textOf).filter((t): t is string => t !== undefined)

  /**
   * This is the one property the whole "tap a button in a modal" mechanism depends on: it must
   * never be possible for the same label to read as both "acknowledge" and "deny", because
   * `clearBlockingDialog` tries ACK first and returns on the first match — a duplicate would make
   * DENY's branch dead code, silently.
   */
  test('ACK and DENY selectors are disjoint', () => {
    const denyKeys = new Set(DENY_SELECTORS.map((sel) => JSON.stringify(sel)))
    for (const sel of ACK_SELECTORS) expect(denyKeys.has(JSON.stringify(sel))).toBe(false)
  })

  /**
   * The load-bearing rule from the plugin's own comments: neither list may ever contain a label
   * that grants, buys, subscribes, or follows. Checked as an exact (case-insensitive) label match,
   * not a substring — `DENY_SELECTORS` legitimately contains "Jangan izinkan" ("don't allow"),
   * which contains the substring "izinkan" while meaning the opposite of granting it.
   */
  test('neither list contains a label that grants, buys, subscribes, or follows', () => {
    const granting = new Set(['izinkan', 'allow', 'ikuti', 'follow', 'beli', 'berlangganan'])
    for (const t of [...ackTexts, ...denyTexts]) {
      expect(granting.has(t.trim().toLowerCase())).toBe(false)
    }
  })

  test('"Mengerti" — the label confirmed on hardware — is present in ACK', () => {
    expect(ackTexts).toContain('Mengerti')
  })
})

describe('nextDialogAction — escalation for "the feed nodes are not there"', () => {
  test('below the two-in-a-row threshold, keep going', () => {
    expect(nextDialogAction(0, 0)).toBe('continue')
    expect(nextDialogAction(1, 0)).toBe('continue')
    expect(nextDialogAction(1, 3)).toBe('continue')
  })

  test('two consecutive blind reads trigger a sweep, regardless of how many already happened', () => {
    expect(nextDialogAction(2, 0)).toBe('sweep')
    expect(nextDialogAction(2, 1)).toBe('sweep')
    expect(nextDialogAction(2, 2)).toBe('sweep')
  })

  test('three fruitless sweeps stop the run as blocked instead of trying a fourth', () => {
    expect(nextDialogAction(2, 3)).toBe('blocked')
    expect(nextDialogAction(3, 5)).toBe('blocked')
  })

  test('a successful read resets both counters, which overrides any prior sweep count', () => {
    // consecutiveBlind back to 0 after signals.ok === true — even with sweeps still at 3, the
    // ladder starts over rather than staying latched in a blocked state.
    expect(nextDialogAction(0, 3)).toBe('continue')
  })
})
