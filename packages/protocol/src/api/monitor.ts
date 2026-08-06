import { z } from 'zod'
import { ArtifactInfoSchema } from '../messages/job'

/** `POST /api/devices/:id/monitor/save`. */
export const MonitorSaveResponseSchema = z.object({ artifact: ArtifactInfoSchema })
