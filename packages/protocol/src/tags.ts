import { z } from 'zod'

/**
 * Tag normalisation (plan 19 §3.4). Lives here, not in core or Studio, so the
 * two cannot disagree — both import this function and the schema below.
 *
 * Rules, applied in order:
 * 1. Trim outer whitespace.
 * 2. Lowercase.
 * 3. Collapse whitespace touching a `:` — the key:value convention (spec/plan
 *    19 §3.1) reads as one token, so `pool: smoke` becomes `pool:smoke`, not
 *    `pool:-smoke`.
 * 4. Collapse any remaining whitespace run into a single `-`, so a stray
 *    space still produces one legal token instead of being rejected outright.
 */
export function normaliseTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, '-')
}

/**
 * A tag as stored: normalised on write, then validated against the allowed
 * charset. Anything outside `[a-z0-9:._-]`, or longer than 64 characters, or
 * not starting with an alphanumeric, is rejected rather than silently mangled
 * further.
 */
export const TagSchema = z
  .string()
  .transform(normaliseTag)
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/, 'tags may only contain a-z, 0-9, and : . _ -, starting with a letter or digit'))
