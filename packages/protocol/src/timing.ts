import { z } from 'zod'

/**
 * The resolved shape behind one of the three named touch profiles
 * (`TouchProfileSchema` in `./settings.ts`; the tuples themselves live in
 * `packages/core/src/config/constants.ts`'s `TOUCH_PROFILES`, plan 212 §4.4).
 *
 * This is a RUNTIME shape, not a form: unlike its pre-212 ancestor
 * (`TimingSettingsSchema`, a titled, farm/device-editable settings block), it
 * carries no `ui()` and no `.meta({ title })` — a touch profile is chosen by
 * name (`jobRunner.touchProfile` / `overrides.touchProfile`), never edited
 * field by field, so nothing here needs a form control.
 */
export const TimingSettingsSchema = z.object({
  tapJitterMs: z.tuple([z.number(), z.number()]).default([40, 120]).describe('Random range for how long a tap is held, in milliseconds'),
  betweenActionMs: z.tuple([z.number(), z.number()]).default([300, 900]).describe('Random range for the pause between actions, in milliseconds'),
  coordJitterPx: z.number().default(2).describe('Random offset applied to the tap point, in pixels'),
  gestureCurvature: z.number().min(0).max(0.5).default(0.08).describe('How far a swipe bows away from a straight line, as a fraction of its length.'),
  gestureSampleIntervalMs: z
    .number()
    .int()
    .min(4)
    .max(50)
    .default(8)
    .describe('Interval between touch-move events. Android needs several to compute a release velocity.'),
  perCharMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([40, 140]).describe('Delay range between characters when typing.'),
})
export type TimingSettings = z.infer<typeof TimingSettingsSchema>
