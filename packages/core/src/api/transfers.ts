import { Hono } from 'hono'
import { TransfersResponseSchema } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import type { TransferRegistry } from '../device/transfer-registry'
import { typedJson } from './typed-json'

export interface TransferRegistryRoutesDeps {
  registry: TransferRegistry
}

/**
 * `GET /api/transfers` (plan 107 §3.1, §3.4, §4, step 107.2) — mounted at
 * `/api/transfers` in `server/http.ts`, distinct from `api/transfer.ts`'s
 * `createTransferRoutes` (which is mounted at `/api/devices` and does the
 * work: `POST /:id/install|push|pull`). This file only reads the registry
 * `daemon.ts`'s single `transferBroadcast` object already keeps up to date
 * (see `device/transfer-registry.ts`'s own doc comment for why hooking it
 * there — rather than threading a new dependency through nine call sites —
 * is the one seam that reaches every caller for free).
 *
 * No permission gate beyond `authMiddleware` (applied to all of `/api/*`) —
 * the same bar `GET /api/jobs` and `GET /api/batches`
 * already hold: seeing THAT something is running is not the same authority
 * as `canUseFiles`, which gates STARTING a transfer.
 */
export function createTransferRegistryRoutes(deps: TransferRegistryRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  app.get('/', (c) => typedJson(c, TransfersResponseSchema, { transfers: deps.registry.list() }))

  return app
}
