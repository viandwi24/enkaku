import { z } from 'zod'

/** `GET /api/health` (`packages/core/src/server/http.ts`). */
export const HealthResponseSchema = z.object({
  ok: z.boolean().optional(),
  version: z.string().optional(),
  adb: z.object({ state: z.string(), serverVersion: z.string().nullable().optional() }).optional(),
  mode: z.string().optional(),
  deviceCount: z.number().optional(),
  uptimeMs: z.number().optional(),
  /**
   * How many plugin rows are in `failed` — the sidebar's farm-health warning
   * badge (plan 82 criterion 30), moved onto this response by plan 126 §3.5,
   * step 126.5.
   *
   * **Why it lives on health rather than staying a `GET /api/plugins` read.**
   * `AppShell` needed exactly this one integer and was downloading the whole
   * plugin list on every Studio page to derive it — at the time, every
   * plugin's full built bundle, ~1 MB per version row (plan 126 §0.4). The
   * shell already polls this route for `version` and `mode`, so carrying the
   * count here deletes a request rather than shrinking one.
   *
   * **Optional, like every other field on this schema, and deliberately so.**
   * A Studio build talking to an older core must still parse this document —
   * `app/nodes/page.tsx` reads it through this schema and would lose the
   * whole page if one missing field failed the parse. Absent therefore means
   * "this core does not report it", which a client must render as "no badge",
   * never as a confident zero: the core only sets it when it has a database
   * to count (see `HttpDeps.failedPluginCount` in
   * `packages/core/src/server/http.ts`).
   */
  failedPlugins: z.number().int().nonnegative().optional(),
})

/** `POST /api/nodes`. */
export const NodeCreateResponseSchema = z.object({ nodeId: z.string(), token: z.string() })

/** `GET /api/tools` (`packages/core/src/toolchain`'s HTTP routes). */
export const ToolEntrySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  swappable: z.boolean(),
  managedByCore: z.boolean(),
  activeVersion: z.string().nullable(),
  installed: z.array(
    z.object({ version: z.string(), active: z.boolean(), sha256: z.string().nullable(), installedAt: z.number().nullable() }),
  ),
  available: z.array(z.object({ version: z.string(), knownGood: z.boolean(), installable: z.boolean() })),
  health: z.object({ ok: z.boolean(), checkedAt: z.number(), detail: z.string() }).nullable(),
})
export const ToolsResponseSchema = z.object({ tools: z.array(ToolEntrySchema) })

/** `GET /api/doctor` — `c.json(result)`, bare, mirrors `packages/core/src/doctor/types.ts`. */
export const DoctorCheckResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'skip']),
  observed: z.string(),
  remedy: z.string().optional(),
})
export const DoctorResponseSchema = z.object({
  results: z.array(DoctorCheckResultSchema),
  exitCode: z.union([z.literal(0), z.literal(1)]),
})
