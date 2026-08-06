import { z } from 'zod'
import { DeviceInfoSchema, LeaseHolderSchema } from '../device'
import { DeviceEventSchema } from '../messages/device-event'
import { DeviceReadinessSchema } from '../readiness'
import { NetworkEngineIdSchema, RouteCheckSchema } from '../network'
import { ViewerSchema } from '../messages/presence'
import { pageSchema } from './pagination'

/** `GET /api/devices/:id`, `POST /api/devices/discovered/:stableId/admit`. */
export const DeviceResponseSchema = z.object({ device: DeviceInfoSchema })

/**
 * `GET /api/devices/:id`, as consumed by the device page — the same route as
 * `DeviceResponseSchema` above, but with the four engine-name fields plus
 * `nodeId` the screen card also reads (`DeviceDetailInfo` in
 * `packages/studio/src/components/device/DeviceHeader.tsx`).
 */
export const DeviceDetailSchema = DeviceInfoSchema.extend({
  transport: z.string(),
  display: z.string(),
  input: z.string(),
  inspection: z.string(),
  settings: z.unknown(),
  nodeId: z.string().nullable(),
})
export const DeviceDetailResponseSchema = z.object({ device: DeviceDetailSchema })

/** `GET /api/devices/blocked`. */
export const BlockedDeviceSchema = z.object({
  stableId: z.string(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  blockedAt: z.number(),
  blockedBy: z.string().nullable(),
})
export const DevicesBlockedResponseSchema = z.object({ blocked: z.array(BlockedDeviceSchema) })

/** `GET /api/devices/:id/viewers`. */
export const DeviceViewersResponseSchema = z.object({ viewers: z.array(ViewerSchema) })

/** `GET/PUT /api/devices/:id/readiness`. */
export const DeviceReadinessResponseSchema = z.object({ readiness: DeviceReadinessSchema })

/** `GET /api/devices/:id/history-counts`. */
export const HistoryCountsSchema = z.object({
  jobs: z.number(),
  artifacts: z.number(),
  events: z.number(),
})
export const DeviceHistoryCountsResponseSchema = z.object({ counts: HistoryCountsSchema })

/** `PUT /api/devices/:id/tags`. */
export const DeviceTagsResponseSchema = z.object({ tags: z.array(z.string()) })

/**
 * `GET /api/devices/:id/events` — the keyset envelope, plus legacy
 * `events`/`nextBefore` keys the route still sends alongside it (kept "for
 * one release" per plan 30 §3.3; out of scope for this plan to remove).
 * Extra keys are simply not part of this schema — Zod ignores them.
 */
export const DeviceEventsResponseSchema = pageSchema(DeviceEventSchema).extend({
  /** Older/narrower reads (`CrashesPanel.tsx`) claim only `items`, ignoring `nextCursor`/`total` — a valid subset. */
})

/** `POST /api/clusters/:id/devices` — moving devices into (or out of) a cluster. */
export const ClusterMoveResponseSchema = z.object({
  moved: z.array(z.object({ deviceId: z.string(), from: z.string().nullable() })),
})

// ---- Network route + guest agent (`packages/core/src/api/guest-agent.ts`) ----
// Deliberately NOT the same shape as `NetworkStatusSchema` in `../network`
// (that one is the tunnel/wire shape used between core and node) — the HTTP
// route's `NetworkStatusResult` names its declared config `config`, not
// `declared`, and adds `sessionId`/`failClosed`/`exitHistory`.

export const DeviceNetworkConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
  credentialRef: z.string().optional(),
  udpMode: z.enum(['udp', 'tcp']),
  expect: z
    .object({
      country: z.string(),
      region: z.string().optional(),
      city: z.string().optional(),
      asn: z.number().optional(),
      isp: z.string().optional(),
    })
    .optional(),
  onGeoFail: z.enum(['report', 'hold']),
})

export const DeviceNetworkObservedSchema = z.object({
  up: z.boolean(),
  state: z.enum(['up', 'held', 'down']).optional(),
  upstream: z.string().optional(),
  stats: z.array(z.number()).optional(),
})

export const DeviceGeoObservationSchema = z.object({
  address: z.string(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  asn: z.number().nullable(),
  isp: z.string().nullable(),
  at: z.number(),
})

/** `GET/POST /api/devices/:id/network(/enable|/disable)` — bare, no wrapper. */
export const DeviceNetworkStatusResponseSchema = z.object({
  engine: NetworkEngineIdSchema,
  config: DeviceNetworkConfigSchema.nullable(),
  enabled: z.boolean(),
  observed: DeviceNetworkObservedSchema.nullable(),
  drift: z.boolean(),
  sessionId: z.string().nullable(),
  failClosed: z.boolean(),
  health: z.enum(['ok', 'unverified', 'degraded', 'unknown']),
  checks: z.array(RouteCheckSchema),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  exitHistory: z.array(DeviceGeoObservationSchema),
})

/** `GET/POST/DELETE /api/devices/:id/guest-agent` — bare, no wrapper. */
export const GuestAgentStatusResponseSchema = z.object({
  state: z.enum(['not-installed', 'installed', 'ready', 'unreachable', 'unsupported']),
  appVersion: z.string().optional(),
  androidSdkInt: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  reason: z.string().optional(),
})
