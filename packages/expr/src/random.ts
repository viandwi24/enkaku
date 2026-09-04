// A small, pure PRNG for `$random` (plan 300 D4 rule 5, plan 304 §3.4).
//
// `$random` must be reproducible on a replay or a resumed run: two calls with
// the same run `seed` and the same step `seq` return the same value, always
// — no host entropy source, no `Math.random`, no state carried between
// calls. `deriveRandom` is therefore a pure function of its two integer
// inputs, not a generator object with internal state: mulberry32, seeded by
// XOR-folding `seed` and `seq` into one 32-bit word.

/** One mulberry32 step from a 32-bit integer state — deterministic, fast, good enough for "a bounded expression wants a number", not cryptographic. */
function mulberry32(state: number): number {
  let t = (state + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * `$random` for step `seq` of a run whose own seed is `seed` (plan 304 §3.4).
 * Pure: the same `(seed, seq)` pair always returns the same value in
 * `[0, 1)`. `seed`/`seq` are folded into one 32-bit state with a large odd
 * multiplier so nearby `seq` values (every real run's own sequence) do not
 * produce visibly correlated output.
 */
export function deriveRandom(seed: number, seq: number): number {
  const folded = (Math.imul(seed | 0, 0x9e3779b1) ^ (seq | 0)) | 0
  return mulberry32(folded)
}
