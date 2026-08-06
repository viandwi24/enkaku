import { z } from 'zod'

/** `GET /api/adb/stats` (`packages/core/src/api/adb-stats.ts`). */
export const AdbStatsResponseSchema = z.object({
  global: z.object({
    maxConcurrent: z.number(),
    auto: z.boolean(),
    inFlight: z.number(),
    waiting: z.number(),
  }),
  streams: z.object({
    maxStreams: z.number(),
    maxStreamsPerDevice: z.number(),
    active: z.number(),
    perDevice: z.record(z.string(), z.number()),
  }),
  idleSessions: z.array(z.unknown()),
  devices: z.array(
    z.object({
      deviceId: z.string(),
      label: z.string(),
      queueDepth: z.number(),
      execMsP50: z.number().nullable(),
      execMsP95: z.number().nullable(),
      counts: z.object({ ok: z.number(), timeout: z.number(), busy: z.number(), error: z.number() }),
      consecutiveFailures: z.number(),
    }),
  ),
})

/** `GET/POST /api/devices/:id/adb-endpoint`. */
export const AdbEndpointStateSchema = z.object({
  host: z.string(),
  port: z.number(),
  connections: z.number(),
  openedAt: z.number(),
  expiresAt: z.number(),
})
export const AdbEndpointResponseSchema = z.object({ endpoint: AdbEndpointStateSchema.nullable() })

/** `POST /api/devices/:id/adb-endpoint`. */
export const AdbEndpointCreateResponseSchema = z.object({
  host: z.string(),
  port: z.number(),
  expiresAt: z.number(),
  command: z.string(),
})
