import { z } from 'zod'

/**
 * The action recorder's runtime bounds (plan 94; parked as a feature by
 * plan 210, its bounds still enforced). Plan 212 §4.1 turns every one of
 * these into a constant (`RECORDING_*`, `packages/core/src/config/
 * constants.ts`) - this bare, unrendered shape is what
 * `packages/core/src/recording/{service,session}.ts` still read, built from
 * those constants at the daemon wiring boundary.
 */
export const RecordingSettingsSchema = z.object({
  anchorQuietMs: z.number().int().min(0).max(10_000).default(400),
  anchorMinIntervalMs: z.number().int().min(0).max(60_000).default(1_500),
  longPressMs: z.number().int().min(200).max(10_000).default(400),
  maxSteps: z.number().int().min(1).max(2_000).default(500),
  maxDurationSec: z.number().int().min(1).max(86_400).default(900),
  captureScreenshots: z.boolean().default(true),
})
export type RecordingSettings = z.infer<typeof RecordingSettingsSchema>
