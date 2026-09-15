/**
 * A pure planner for "human" typing (client request, 2026-09-15): `ctx.device.type`'s opt-in mode
 * that makes automated text entry look like a person typing rather than a machine — a human
 * cadence, occasional typos that get backspaced and retyped, a bit more delay at the end of a word
 * than mid-word, and every few words a chance of a longer "thinking" pause.
 *
 * This module ONLY plans: given the text, the resolved options and an rng, it returns an ordered
 * list of steps (`type` / `delete` / `pause`) with no I/O and no engine dependency, so it is fully
 * unit-testable without a device, a session, or even `@enkaku/protocol`. `device-executor.ts`
 * (`@enkaku/session`) is the thin executor that runs a plan against whichever `InputSink` the
 * call resolved to.
 *
 * Deliberately NOT wired into any engine here: an engine that cannot send a delete (there is none
 * today — every `InputSink.key()` is mandatory, so `KeyCode.DEL` always works) or that can only
 * commit a whole string in one shot (the guest-agent IME rung, `commitViaAgent`) cannot run this
 * plan's `delete` steps at all — the executor decides that, this module never does.
 */

/** One planned action. `delayMs` is the pause AFTER performing this step, before the next one. */
export type HumanTypeStep =
  | { kind: 'type'; text: string; delayMs: number }
  | { kind: 'delete'; count: number; delayMs: number }
  | { kind: 'pause'; delayMs: number }

export interface HumanTypingOptions {
  /** Delay range between ordinary characters, in ms. Default `[70, 220]` — slower than the plain
   * `perCharMs` default (`[40, 140]`, plan 40) because this mode's whole point is "not too fast". */
  perCharMs?: [number, number]
  /** Extra delay added on top of the last character of a WORD (not every character) — the
   * "different delay per word, not only per character" requirement. Default `[80, 300]`. */
  extraPerWordMs?: [number, number]
  /** A longer pause checked at a word boundary, every `everyWords` words. */
  thinkingPause?: {
    /** Chance of a pause firing at an eligible boundary. Default `0.2`. */
    probability?: number
    /** How many words between eligibility checks. Default `5`. */
    everyWords?: number
    /** Pause duration range, in ms. Default `[400, 1800]`. */
    ms?: [number, number]
  }
  /** A plausible QWERTY-neighbour typo, always corrected before the plan ends. */
  typo?: {
    /** Chance a given word gets a typo. Default `0.08`. */
    probability?: number
    /** How many further (correct) characters get typed past the typo before it is "noticed" and
     * backspaced — sampled per typo. Default `[0, 2]`. */
    noticeAfterChars?: [number, number]
  }
  /**
   * A guard, not an exact budget (plan text: "bounded... unless asked"): once the running planned
   * delay would cross this, thinking pauses and further typos stop being scheduled and remaining
   * characters use the FAST end of their delay ranges — so a long caption cannot run for minutes by
   * accident. Default `120_000` (2 minutes). Raise it to actually ask for a longer run.
   */
  maxTotalMs?: number
  /** Deterministic planning: same seed, same text, same options ⇒ the same plan. Omit for a plan
   * that draws from `Math.random` (a real script does not need to reproduce it). */
  seed?: number
}

type ResolvedThinkingPause = { probability: number; everyWords: number; ms: [number, number] }
type ResolvedTypo = { probability: number; noticeAfterChars: [number, number] }

export interface ResolvedHumanTypingOptions {
  perCharMs: [number, number]
  extraPerWordMs: [number, number]
  thinkingPause: ResolvedThinkingPause
  typo: ResolvedTypo
  maxTotalMs: number
}

const DEFAULTS: ResolvedHumanTypingOptions = {
  perCharMs: [70, 220],
  extraPerWordMs: [80, 300],
  thinkingPause: { probability: 0.2, everyWords: 5, ms: [400, 1800] },
  typo: { probability: 0.08, noticeAfterChars: [0, 2] },
  maxTotalMs: 120_000,
}

/** `true` takes every default; an options object overrides only the fields it names, nested
 * objects included — `{ typo: { probability: 0 } }` keeps the default `noticeAfterChars`. */
export function resolveHumanTypingOptions(opts: true | HumanTypingOptions | undefined): ResolvedHumanTypingOptions {
  if (opts === true || opts === undefined) return DEFAULTS
  return {
    perCharMs: opts.perCharMs ?? DEFAULTS.perCharMs,
    extraPerWordMs: opts.extraPerWordMs ?? DEFAULTS.extraPerWordMs,
    thinkingPause: {
      probability: opts.thinkingPause?.probability ?? DEFAULTS.thinkingPause.probability,
      everyWords: opts.thinkingPause?.everyWords ?? DEFAULTS.thinkingPause.everyWords,
      ms: opts.thinkingPause?.ms ?? DEFAULTS.thinkingPause.ms,
    },
    typo: {
      probability: opts.typo?.probability ?? DEFAULTS.typo.probability,
      noticeAfterChars: opts.typo?.noticeAfterChars ?? DEFAULTS.typo.noticeAfterChars,
    },
    maxTotalMs: opts.maxTotalMs ?? DEFAULTS.maxTotalMs,
  }
}

/** mulberry32 — small, fast, and enough entropy for this: a plan only needs to be reproducible
 * under a seed, never cryptographically sound. No seeded rng helper existed anywhere else in the
 * workspace to reuse (checked before writing this one). */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Physical QWERTY adjacency — a plausible wrong neighbour for a real typo, not a random letter. */
const QWERTY_NEIGHBORS: Record<string, string[]> = {
  q: ['w', 'a'],
  w: ['q', 'e', 's', 'a'],
  e: ['w', 'r', 'd', 's'],
  r: ['e', 't', 'f', 'd'],
  t: ['r', 'y', 'g', 'f'],
  y: ['t', 'u', 'h', 'g'],
  u: ['y', 'i', 'j', 'h'],
  i: ['u', 'o', 'k', 'j'],
  o: ['i', 'p', 'l', 'k'],
  p: ['o', 'l'],
  a: ['q', 'w', 's', 'z'],
  s: ['a', 'w', 'e', 'd', 'z', 'x'],
  d: ['s', 'e', 'r', 'f', 'x', 'c'],
  f: ['d', 'r', 't', 'g', 'c', 'v'],
  g: ['f', 't', 'y', 'h', 'v', 'b'],
  h: ['g', 'y', 'u', 'j', 'b', 'n'],
  j: ['h', 'u', 'i', 'k', 'n', 'm'],
  k: ['j', 'i', 'o', 'l', 'm'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k'],
}

/** A plausible wrong neighbour for `ch`, preserving case; `null` when `ch` is not a letter this
 * map covers (digits, punctuation, whitespace — none of those get typo'd). */
function neighborFor(ch: string, rng: () => number): string | null {
  const lower = ch.toLowerCase()
  const options = QWERTY_NEIGHBORS[lower]
  if (!options || options.length === 0) return null
  const pick = options[Math.min(options.length - 1, Math.floor(rng() * options.length))]!
  return ch === lower ? pick : pick.toUpperCase()
}

const sample = (range: [number, number], rng: () => number): number => {
  const [lo, hi] = range
  return lo + rng() * Math.max(0, hi - lo)
}

const sampleInt = (range: [number, number], rng: () => number): number => {
  const [lo, hi] = range
  return Math.round(lo + rng() * Math.max(0, hi - lo))
}

export interface HumanTypingPlan {
  steps: HumanTypeStep[]
  typosSimulated: number
  pauses: number
  /** Sum of every step's `delayMs` — the plan's own estimate of how long it will take, excluding
   * whatever the engine itself costs to run each step. */
  totalMs: number
}

/**
 * Split into word / separator tokens, splitting on whitespace RUNS while keeping them (so joining
 * every token back together reproduces `text` exactly) — never on a code point boundary, so a
 * surrogate pair or any other multi-unit character always stays inside one token.
 */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0)
}

/**
 * Plans `text` as an ordered list of `HumanTypeStep`s (see the module header). Pure: the same
 * text, options and rng always produce the same plan.
 */
export function planHumanTyping(text: string, opts: true | HumanTypingOptions | undefined, rngIn?: () => number): HumanTypingPlan {
  const resolved = resolveHumanTypingOptions(opts)
  const seed = opts !== true && opts !== undefined ? opts.seed : undefined
  const rng = rngIn ?? (seed !== undefined ? createSeededRng(seed) : Math.random)

  const steps: HumanTypeStep[] = []
  let typosSimulated = 0
  let pauses = 0
  let totalMs = 0
  let wordsSinceCheck = 0
  let capped = false

  const pushDelay = (extra: number): number => {
    // Once the guard trips, everything still needs SOME value (a real gap between keystrokes),
    // but sampling stops and the fast end of the range is used instead.
    totalMs += extra
    if (totalMs >= resolved.maxTotalMs) capped = true
    return extra
  }

  const charDelay = (): number => (capped ? resolved.perCharMs[0] : sample(resolved.perCharMs, rng))

  for (const token of tokenize(text)) {
    const isWord = !/^\s+$/.test(token)
    const chars = [...token]

    if (!isWord) {
      // A whitespace run: typed like ordinary characters, no typo/word-pause logic.
      for (const ch of chars) {
        steps.push({ kind: 'type', text: ch, delayMs: pushDelay(charDelay()) })
      }
      continue
    }

    // Decide, once per word, whether a typo happens and where.
    let typoIndex = -1
    if (!capped && rng() < resolved.typo.probability) {
      const candidates = chars.map((c, i) => i).filter((i) => QWERTY_NEIGHBORS[chars[i]!.toLowerCase()])
      if (candidates.length > 0) {
        typoIndex = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]!
      }
    }

    if (typoIndex === -1) {
      // No typo in this word — type every character in order.
      for (let i = 0; i < chars.length; i++) {
        const isLastChar = i === chars.length - 1
        const extra = isLastChar ? sample(resolved.extraPerWordMs, rng) : 0
        steps.push({ kind: 'type', text: chars[i]!, delayMs: pushDelay(charDelay() + (capped ? 0 : extra)) })
      }
    } else {
      typosSimulated++
      const remainingAfterTypo = chars.length - 1 - typoIndex
      const noticeAfter = Math.min(remainingAfterTypo, Math.max(0, sampleInt(resolved.typo.noticeAfterChars, rng)))

      // 1. Correct prefix, up to (not including) the typo position.
      for (let i = 0; i < typoIndex; i++) {
        steps.push({ kind: 'type', text: chars[i]!, delayMs: pushDelay(charDelay()) })
      }
      // 2. The wrong character itself.
      const wrong = neighborFor(chars[typoIndex]!, rng) ?? chars[typoIndex]!
      steps.push({ kind: 'type', text: wrong, delayMs: pushDelay(charDelay()) })
      // 3. `noticeAfter` further REAL characters, typed as if the mistake had not been seen yet.
      for (let i = 0; i < noticeAfter; i++) {
        steps.push({ kind: 'type', text: chars[typoIndex + 1 + i]!, delayMs: pushDelay(charDelay()) })
      }
      // 4. Notice — backspace the wrong character and everything typed past it.
      steps.push({ kind: 'delete', count: 1 + noticeAfter, delayMs: pushDelay(sample(resolved.perCharMs, rng)) })
      // 5. Retype the same span correctly.
      for (let i = 0; i <= noticeAfter; i++) {
        steps.push({ kind: 'type', text: chars[typoIndex + i]!, delayMs: pushDelay(charDelay()) })
      }
      // 6. The rest of the word, unaffected.
      for (let i = typoIndex + noticeAfter + 1; i < chars.length; i++) {
        const isLastChar = i === chars.length - 1
        const extra = isLastChar ? sample(resolved.extraPerWordMs, rng) : 0
        steps.push({ kind: 'type', text: chars[i]!, delayMs: pushDelay(charDelay() + (capped ? 0 : extra)) })
      }
      // A word whose typo's retype covers the LAST character never reaches step 6's loop (nothing
      // left after it), so its word-delay would otherwise be dropped entirely — add it here instead.
      if (!capped && typoIndex + noticeAfter === chars.length - 1) {
        const last = steps[steps.length - 1]!
        if (last.kind === 'type') {
          const extra = sample(resolved.extraPerWordMs, rng)
          last.delayMs += extra
          totalMs += extra
          if (totalMs >= resolved.maxTotalMs) capped = true
        }
      }
    }

    wordsSinceCheck++
    if (!capped && wordsSinceCheck >= resolved.thinkingPause.everyWords) {
      wordsSinceCheck = 0
      if (rng() < resolved.thinkingPause.probability) {
        pauses++
        steps.push({ kind: 'pause', delayMs: pushDelay(sample(resolved.thinkingPause.ms, rng)) })
      }
    }
  }

  return { steps, typosSimulated, pauses, totalMs }
}

/** Applies a plan to a starting string, exactly as an engine would (append `type.text`, drop the
 * last `delete.count` characters) — the same function the executor's mental model uses, exposed
 * here so a test can assert the final text without re-deriving the append/delete semantics. */
export function applyHumanTypingPlan(steps: HumanTypeStep[]): string {
  let buf = ''
  for (const step of steps) {
    if (step.kind === 'type') buf += step.text
    else if (step.kind === 'delete') buf = [...buf].slice(0, Math.max(0, [...buf].length - step.count)).join('')
  }
  return buf
}
