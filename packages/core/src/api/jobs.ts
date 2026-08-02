import { Hono } from 'hono'
import { JobStatusSchema } from '@enkaku/protocol'
import { z } from 'zod'
import type { JobService } from '../services/job-service'
import { EnkakuError } from '../util/errors'

const EnqueueBody = z.object({
  scriptId: z.string().min(1),
  deviceId: z.string().min(1),
  params: z.unknown(),
  priority: z.number().int().optional(),
})

const ERROR_STATUS: Record<string, number> = {
  device_not_found: 404,
  job_not_found: 404,
  unknown_script: 400,
  invalid_job_params: 400,
  job_not_cancellable: 409,
  device_unavailable: 409,
  device_busy: 409,
}

export function createJobRoutes(service: JobService): Hono {
  const app = new Hono()

  app.post('/', async (c) => {
    const body = EnqueueBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: { code: 'E_BAD_REQUEST', message: 'a body of { scriptId, deviceId, params } is required' } }, 400)
    }
    const job = service.enqueue(body.data)
    return c.json({ job }, 201)
  })

  app.get('/', (c) => {
    const status = JobStatusSchema.safeParse(c.req.query('status'))
    const result = service.list({
      deviceId: c.req.query('deviceId') ?? undefined,
      status: status.success ? status.data : undefined,
      limit: Number.parseInt(c.req.query('limit') ?? '50', 10) || 50,
      offset: Number.parseInt(c.req.query('offset') ?? '0', 10) || 0,
    })
    return c.json(result)
  })

  app.get('/:id', (c) => {
    const job = service.get(c.req.param('id'))
    if (!job) return c.json({ error: { code: 'job_not_found', message: 'no such job' } }, 404)
    return c.json({ job })
  })

  app.post('/:id/cancel', (c) => c.json({ job: service.cancel(c.req.param('id')) }))

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    }
    throw err
  })

  return app
}
