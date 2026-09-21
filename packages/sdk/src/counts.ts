/**
 * Reading a count a phone drew on its screen — views, plays, likes.
 *
 * Every platform this farm touches writes the same number differently, and the
 * differences are not cosmetic: `1.655` is one thousand six hundred and
 * fifty-five on an Indonesian TikTok and one point six five five on an
 * English YouTube. Get it wrong by that factor and a recap reports a video as
 * a thousand times more watched than it is.
 *
 * ## The rule, and why it is this one
 *
 * There are two shapes, and the MAGNITUDE WORD decides which:
 *
 * - **No magnitude word** (`420`, `1.655`, `1,234`) — the number is exact and
 *   every separator in it is a thousands separator, whichever way round the
 *   locale writes them. Strip them all.
 * - **A magnitude word** (`140,1 rb`, `246 thousand`, `1.2M`) — the number is
 *   rounded for display, so at most one separator can be a decimal point: the
 *   LAST one, and only when one or two digits follow it. Anything earlier is
 *   still grouping.
 *
 * That rule needs no locale flag, which matters because the locale is not
 * ours to know: the same farm runs phones set to `id-ID` and to `en-US`, and
 * an app can be translated independently of the system.
 *
 * ## `approx`
 *
 * A number read through a magnitude word has lost its tail — `140,1 rb` is
 * anything from 140,050 to 140,149 — and a caller merging two readings has to
 * know that, or it will report growth that is only rounding. So the reading
 * says how it was read rather than pretending to a precision it does not have.
 *
 * Measured, not guessed. Every form in the tests below was read off the
 * owner's moto g06 power on 2026-09-21: the TikTok profile grid (`id-ID`),
 * the Instagram profile Reels tab, and a YouTube channel's Videos and Shorts
 * tabs (`en-US`).
 */

/** What a magnitude word multiplies by. Longest spellings first — `mi` must never win over `miliar`. */
const MAGNITUDES: readonly (readonly [RegExp, number])[] = [
  [/^(?:t|tn|triliun|trillion)$/i, 1e12],
  [/^(?:b|bn|miliar|milyar|billion)$/i, 1e9],
  [/^(?:jt|juta|million|mio)$/i, 1e6],
  [/^m$/i, 1e6],
  [/^(?:rb|ribu|k|thousand)$/i, 1e3],
]

export interface CountReading {
  /** The number, or `null` when the text carried no number at all. */
  value: number | null
  /** True when a magnitude word rounded it — `140,1 rb` is not 140,100 exactly. */
  approx: boolean
}

/** The magnitude a word names, or `null` when it names none. */
function magnitudeOf(word: string): number | null {
  for (const [pattern, factor] of MAGNITUDES) if (pattern.test(word)) return factor
  return null
}

/**
 * Read a count out of whatever the phone drew.
 *
 * The text may carry anything around the number — `8 penayangan`,
 * `246 thousand views`, `View Count 140.` — and only the first number-shaped
 * run and the word that follows it are read.
 */
export function parseCount(text: string): CountReading {
  // Non-breaking spaces are what Indonesian builds put between the number and
  // its magnitude word (`140,1 rb`), and a plain `\s` does not match them
  // in every engine this bundle runs in. Normalise once, here.
  const normal = text.replace(/[   ]/g, ' ').trim()
  const found = /(\d[\d.,  ]*)\s*([\p{L}]*)/u.exec(normal)
  if (!found) return { value: null, approx: false }

  const digits = (found[1] ?? '').replace(/[\s ]/g, '').replace(/[.,]+$/, '')
  const factor = magnitudeOf(found[2] ?? '')

  if (factor === null) {
    // Exact: every separator groups. `1.655` is 1655 and `1,234` is 1234.
    const plain = digits.replace(/[.,]/g, '')
    if (plain === '') return { value: null, approx: false }
    const value = Number(plain)
    return { value: Number.isFinite(value) ? value : null, approx: false }
  }

  // Rounded: the last separator is a decimal point when one or two digits
  // follow it, and grouping otherwise.
  const decimal = /[.,](\d{1,2})$/.exec(digits)
  const whole = decimal ? digits.slice(0, digits.length - (decimal[1] as string).length - 1) : digits
  const base = Number(`${whole.replace(/[.,]/g, '')}.${decimal ? decimal[1] : '0'}`)
  if (!Number.isFinite(base)) return { value: null, approx: false }
  return { value: Math.round(base * factor), approx: true }
}


/**
 * The count that sits immediately BEFORE a word — `246 thousand views`.
 *
 * This exists because of a real misreading. A YouTube Shorts cell describes
 * itself as `2026 Solar Eclipse @ 50,000 Feet, 246 thousand views - play
 * Short`, and handing that whole sentence to `parseCount` answers 2026: the
 * TITLE's own numbers come first. A count in a sentence is only findable by
 * the word it belongs to, so the caller names that word and this reads
 * backwards from it.
 *
 * `word` matches the label in every language the caller expects — `views`,
 * `penayangan`, `x ditonton`. The last occurrence wins, because a title can
 * contain the word too.
 */
export function countBefore(text: string, word: RegExp): CountReading {
  const normal = text.replace(/[   ]/g, ' ')
  const flags = word.flags.includes('g') ? word.flags : `${word.flags}g`
  const label = new RegExp(word.source, flags)
  let at: number | null = null
  for (let hit = label.exec(normal); hit !== null; hit = label.exec(normal)) at = hit.index
  if (at === null) return { value: null, approx: false }
  const before = normal.slice(0, at)
  // The number and its own magnitude word, at the very end of what precedes the label.
  const found = /(\d[\d.,]*)\s*([\p{L}]*)\s*$/u.exec(before)
  if (!found) return { value: null, approx: false }
  return parseCount(`${found[1]} ${found[2] ?? ''}`)
}
