import { z } from 'zod'

/**
 * `/api/vms` (plan 402 §4.1) — a virtual device (an Android Emulator instance,
 * plan 400 D1). This mirrors the core's `VmStateSchema`/`VmSpecSchema`
 * (`packages/core/src/vm/types.ts`, plan 401 §4.1) deliberately: protocol is
 * the wire contract, core is the runtime, and the two are kept separate so a
 * core-only runtime detail never leaks onto the wire by accident.
 */
export const VmStateSchema = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type VmState = z.infer<typeof VmStateSchema>

/** The AVD shape an operator asks for. Everything has a default except the name (plan 400 R3, R4, R8). */
export const VmSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(48)
    // avdmanager's own constraint: an AVD name is a path segment.
    .regex(/^[A-Za-z0-9._-]+$/, 'an AVD name may contain only letters, digits, dot, underscore and hyphen'),
  apiLevel: z.number().int().min(24).max(40).default(36),
  variant: z.enum(['google_apis', 'google_apis_playstore', 'default', 'aosp_atd']).default('google_apis'),
  abi: z.enum(['arm64-v8a', 'x86_64']).optional(),
  memoryMb: z.number().int().min(1536).max(8192).default(2048),
  deviceProfile: z.string().min(1).default('pixel_7'),
})
export type VmSpec = z.infer<typeof VmSpecSchema>

/** `GET /api/vms`, `POST /api/vms`, `POST /:id/start`, `POST /:id/stop` (plan 402 §4.2). */
export const VmRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: VmStateSchema,
  consolePort: z.number().int(),
  /** `emulator-<consolePort>` — the adb serial (plan 400 R5). Observational only: it does NOT imply a device row exists (plan 400 D6). */
  serial: z.string(),
  spec: VmSpecSchema,
  message: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
})
export type VmRecord = z.infer<typeof VmRecordSchema>

export const VmListResponseSchema = z.object({ vms: z.array(VmRecordSchema) })
export type VmListResponse = z.infer<typeof VmListResponseSchema>

export const VmResponseSchema = z.object({ vm: VmRecordSchema })
export type VmResponse = z.infer<typeof VmResponseSchema>

/** `POST /api/vms` body. */
export const VmCreateBodySchema = VmSpecSchema
export type VmCreateBody = z.infer<typeof VmCreateBodySchema>
