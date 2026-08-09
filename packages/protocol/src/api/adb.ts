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
  /**
   * The shared `/ws` transport's own health (plan 85 §3.6, §4.6) — measures,
   * rather than picks between, H1 (control replies queued behind video on
   * the shared socket) and H2 (a silent-but-open socket the client cannot
   * detect on its own). `watchdogReconnects` counts connection churn the
   * SERVER can observe (opens beyond peak concurrency) — it can never be
   * attributed to the client's silence watchdog specifically, since
   * `ClientMessage` deliberately carries no such signal; the browser console
   * is the source of truth for a genuinely watchdog-caused reconnect.
   */
  transport: z.object({
    connections: z.number(),
    bufferedBytesMax: z.number(),
    bufferedBytesP95: z.number(),
    videoBytesPerSec: z.number(),
    controlReplyMsP50: z.number(),
    controlReplyMsP95: z.number(),
    watchdogReconnects: z.number(),
  }),
  /** `packages/core/src/device/host-adb.ts`'s `HostAdb.stats()`, verbatim (plan 85 §3.4, §4.6). */
  hostAdb: z.object({
    running: z.number(),
    maxConcurrent: z.number(),
    installsRunning: z.number(),
    longLived: z.number(),
  }),
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
