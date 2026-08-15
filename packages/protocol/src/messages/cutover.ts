import { z } from 'zod'
import { CutoverStateSchema } from '../api/devices'

/**
 * The USB → network cutover wizard's live progress (plan 88 §3.4, §4.6, §5
 * step 88.5) — broadcast on every step transition and every armed-window
 * poll, so a second browser tab (or the same tab after a reload) sees
 * exactly the state `packages/core/src/registry/cutover.ts`'s in-memory
 * `CutoverManager` holds. There is no snapshot replay on `/ws` (spec's own
 * rule), which is why `POST .../connection/cutover`'s response carries the
 * same `CutoverState` shape for the tab that started it.
 */
export const DeviceCutoverMessage = z.object({
  type: z.literal('device.cutover'),
  payload: z.object({ state: CutoverStateSchema }),
})
export type DeviceCutoverEvent = z.infer<typeof DeviceCutoverMessage>
