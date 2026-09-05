import { z } from 'zod'

/**
 * The `vm` subsystem — plan 401. Creates an AVD, starts a headless emulator,
 * waits for it to finish booting, stops it, and deletes it. Its job ends the
 * moment the emulator reports `sys.boot_completed=1` (plan 400 D2, §3.1 of
 * plan 401): discovery, admission, and the device row are the existing
 * reconciler's job and need no change here.
 */

/** What a VM row can be. `failed` carries a message; every other state is self-explanatory. */
export const VmStateSchema = z.enum(['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
export type VmState = z.infer<typeof VmStateSchema>

/** The AVD shape an operator asks for. Everything has a default except the name. */
export const VmSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(48)
    // avdmanager's own constraint: an AVD name is a path segment.
    .regex(/^[A-Za-z0-9._-]+$/, 'an AVD name may contain only letters, digits, dot, underscore and hyphen'),
  apiLevel: z.number().int().min(24).max(40).default(36),
  variant: z.enum(['google_apis', 'google_apis_playstore', 'default', 'aosp_atd']).default('google_apis'),
  /** Omitted → derived from `process.arch` (plan 401 §3.5). */
  abi: z.enum(['arm64-v8a', 'x86_64']).optional(),
  /** Emulator flag `-memory`, bounded by the emulator itself (plan 400 R8). API 37+ enforces ≥ 4096 (R2). */
  memoryMb: z.number().int().min(1536).max(8192).default(2048),
  /** An `avdmanager list device` id, e.g. `pixel_7`. Unverified ids are rejected by avdmanager, not by us. */
  deviceProfile: z.string().min(1).default('pixel_7'),
})
export type VmSpec = z.infer<typeof VmSpecSchema>

export interface VmRecord {
  id: string
  name: string
  state: VmState
  /** Even console port in 5554–5682. The adb serial is `emulator-<consolePort>` (plan 400 R5). */
  consolePort: number
  /** Denormalised for display and for the device link; always `emulator-${consolePort}`. */
  serial: string
  spec: VmSpec
  message: string | null
  createdAt: Date
  startedAt: Date | null
}

/**
 * Plan 400 D7: this interface has exactly one implementation. It exists so the
 * manager's supervision logic is testable against a fake, and because plan 400 D1
 * names redroid-on-a-Linux-node as a real future. It is NOT a plugin surface.
 */
export interface VmProvider {
  /** Creates the on-disk AVD. Idempotent on `spec.name` — an existing AVD of that name is an error, not an overwrite. */
  create(spec: VmSpec): Promise<void>
  /** Starts the emulator headless on `consolePort` and returns once the process is spawned — NOT once it has booted. */
  start(spec: VmSpec, consolePort: number): Promise<VmHandle>
  /** Graceful stop; falls back to a kill after `graceMs`. */
  stop(handle: VmHandle, graceMs: number): Promise<void>
  /** Deletes the on-disk AVD. Never called while the VM is running. */
  destroy(spec: VmSpec): Promise<void>
}

export interface VmHandle {
  consolePort: number
  /** Runtime only — never persisted (plan 401 §3.3). */
  kill(signal?: NodeJS.Signals): void
  /** Resolves when the child exits, whoever caused it. */
  exited: Promise<number>
}
