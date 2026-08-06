import type { Context } from 'hono'
import type { z } from 'zod'

/**
 * Ties a route's success response to the SAME envelope schema
 * `@enkaku/protocol` declares and Studio's `api()` parses against (plan 72
 * §3.2, criterion 6) — as a TYPE constraint only. `schema` is never called;
 * `data` is checked structurally against `z.output<S>` at compile time, so
 * a response shape that drifts from its schema is a `bun run typecheck`
 * failure in the SAME run that already checks Studio, not a second runtime
 * validation pass on data the core already constructed itself. The boundary
 * this plan is about is the one Studio crosses parsing an HTTP response;
 * the core does not need to re-validate its own output at request time.
 *
 * `status` mirrors Hono's own `c.json(data, status)` second parameter — kept
 * as a plain `number` (rather than importing Hono's `StatusCode` union) to
 * match this codebase's existing `as 400`-style call sites, which already
 * work around the same typing friction.
 */
export function typedJson<S extends z.ZodType>(c: Context, _schema: S, data: z.output<S>, status?: number) {
  return c.json(data, status as never)
}
