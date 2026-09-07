import { z } from 'zod'
import { LabelInfoSchema } from '../labels'

/** `POST /api/labels`, `PATCH /api/labels/:id`. */
export const LabelResponseSchema = z.object({ label: LabelInfoSchema })

/** `GET /api/labels` — the whole palette of labels in the farm, each with its device count. */
export const LabelsResponseSchema = z.object({ labels: z.array(LabelInfoSchema) })
