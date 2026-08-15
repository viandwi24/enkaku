import { z } from 'zod'

/**
 * Live progress for the bounded subnet sweep (plan 88 §3.5, §4.5, §4.6,
 * step 88.3) — an operator watching the Rescan / scan-all-networks button,
 * or the cutover wizard's own armed-window poll (plan 88 §3.4 step 3), sees
 * this rather than staring at a spinner for up to five seconds. Broadcast by
 * `packages/core/src/registry/sweep.ts` as each concurrency batch settles,
 * not per address — `total` is every address the sweep will probe (already
 * net of `skipped`), known up front, so `scanned` counts up to it exactly
 * once per sweep.
 */
export const ScanProgressMessage = z.object({
  type: z.literal('scan.progress'),
  payload: z.object({
    scanned: z.number().int().min(0),
    total: z.number().int().min(0),
    answered: z.number().int().min(0),
  }),
})
export type ScanProgressEvent = z.infer<typeof ScanProgressMessage>
