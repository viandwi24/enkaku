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
/**
 * `POST /api/vms` — the spec, with `apiLevel` optional.
 *
 * The stored spec always carries a number; a REQUEST need not. Defaulting it
 * to a fixed 36 in the schema meant a host whose only installed system image
 * was android-35 got `avdmanager`'s raw "Package path is not valid" after
 * pressing Create — a default chosen without looking at the machine it runs
 * on. Left out, the route picks the newest api level actually installed for
 * the requested variant and ABI.
 */
export const VmCreateBodySchema = VmSpecSchema.extend({ apiLevel: z.number().int().min(24).max(40).optional() })
export type VmCreateBody = z.infer<typeof VmCreateBodySchema>

/**
 * `GET /api/vms/sdk` — what the host actually has, so Studio can say what is
 * missing instead of an operator finding out from a failed create.
 *
 * `source` is which tier answered (`ENKAKU_ANDROID_SDK_PATH`, the standard
 * env vars, or the per-OS default), because "the SDK is at X" and "the SDK is
 * at X *because you set this variable*" are different facts when X is wrong.
 */
export const AndroidSdkStatusSchema = z.object({
  /** Absent when no tier found a root at all. */
  root: z.string().nullable(),
  /** The JDK `sdkmanager` will run under — it is a Java program, and a host with none fails only after the button is pressed unless this is on screen. */
  javaHome: z.string().nullable(),
  source: z.enum(['override', 'env', 'default', 'managed', 'missing']),
  emulator: z.boolean(),
  sdkmanager: z.boolean(),
  avdmanager: z.boolean(),
  /** `android-35`, `android-36`, … — the platforms present, so the UI can offer an API level that will actually work. */
  platforms: z.array(z.string()),
  /** `system-images;android-35;google_apis;arm64-v8a` style ids, already assembled. */
  systemImages: z.array(z.string()),
  /** The one thing to do next, in words. Null when nothing is missing. */
  remedy: z.string().nullable(),
  /** Where a `target: 'managed'` install would put things. */
  managedRoot: z.string(),
  /** True when that directory holds packages and is NOT the resolved root — the case where an install visibly changes nothing above. */
  managedRootInstalled: z.boolean().default(false),
})
export type AndroidSdkStatus = z.infer<typeof AndroidSdkStatusSchema>
export const AndroidSdkStatusResponseSchema = z.object({ sdk: AndroidSdkStatusSchema })

export const SdkInstallBodySchema = z
  .object({
    /** Never a path. Two destinations, both chosen by the server. */
    target: z.enum(['detected', 'managed']).default('detected'),
    packages: z.array(z.enum(['emulator', 'platform-tools', 'cmdline-tools'])).default([]),
    systemImage: z
      .object({
        apiLevel: z.number().int().min(24).max(40),
        variant: z.enum(['google_apis', 'google_apis_playstore', 'default', 'aosp_atd']).default('google_apis'),
        abi: z.enum(['arm64-v8a', 'x86_64']),
      })
      .optional(),
    /** The caller's own acceptance of the Android SDK Terms, for this request. No default: accepting a licence on someone's behalf is a legal act. */
    acceptLicenses: z.boolean(),
  })
  .strict()
export type SdkInstallBody = z.infer<typeof SdkInstallBodySchema>

export const SdkInstallResponseSchema = z.object({ operationId: z.string() })
