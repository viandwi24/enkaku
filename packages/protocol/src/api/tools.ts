import { z } from 'zod'

/** `GET /api/health` (`packages/core/src/server/http.ts`). */
export const HealthResponseSchema = z.object({
  ok: z.boolean().optional(),
  version: z.string().optional(),
  adb: z.object({ state: z.string(), serverVersion: z.string().nullable().optional() }).optional(),
  mode: z.string().optional(),
  deviceCount: z.number().optional(),
  uptimeMs: z.number().optional(),
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
