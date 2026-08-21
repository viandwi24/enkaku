/**
 * The one place an error crossing the REST boundary is turned into something
 * safe to log or show an operator — the same shape `plugins/proxy-manager`'s
 * `service/errors.ts` uses for the identical reason (plan 122 task brief:
 * "see how errors.ts's scrubSecrets handles this and follow it").
 *
 * ## Why a re-word rather than a re-throw
 *
 * `MikrotikRestDriver` sends an HTTP Basic Auth header on every request. The
 * primary defence is that no code path in this package ever interpolates the
 * password into a string — nothing here builds an error message, a log line,
 * or a doctor report by concatenating `config.password` into text.
 * `scrubSecrets` is defence in depth for the paths this package does not own
 * (a runtime error's own `.message`, a thrown value from `fetch` itself) —
 * it is not a licence to interpolate a password and clean it up afterwards.
 */

/** `message` off an unknown throwable, and nothing else off it. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'unknown error'
}

/**
 * Replace every occurrence of a secret with a marker.
 *
 * Longest-first, so a password that is a prefix of another secret does not
 * leave the tail behind; short values are skipped entirely, because
 * substring-replacing a three-character secret would mangle unrelated text
 * into unreadability while proving nothing — the same threshold
 * `plugins/proxy-manager/src/service/errors.ts`'s `scrubSecrets` uses.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const usable = secrets.filter((s) => typeof s === 'string' && s.length >= 8).sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of usable) out = out.split(secret).join('«redacted»')
  return out
}

/**
 * What went wrong talking to the router, classified coarsely enough for
 * `doctor()` to tell "never reached the router" apart from "reached it, but
 * the credentials or the request were refused" apart from "reached it,
 * authenticated, but the response could not be parsed as the shape this
 * driver expects."
 *
 * `parse` failures are the ones plan 122's own hard constraint calls out by
 * name: a router on a different RouterOS version returning a different shape
 * must fail as a NAMED parse error here, never silently produce garbage the
 * caller mistakes for a real inventory.
 */
export type MikrotikRestErrorKind = 'network' | 'auth' | 'http' | 'parse'

export class MikrotikRestError extends Error {
  readonly kind: MikrotikRestErrorKind
  readonly status?: number

  constructor(kind: MikrotikRestErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'MikrotikRestError'
    this.kind = kind
    this.status = status
  }
}
