import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import { applyNow, loadFleet, previewPlan, type ApplyDeps, type ApplyHost } from './apply'

/**
 * The write half's three HTTP routes — plan 122 §5 step 122.6.
 *
 * | method + path | handler id | permission |
 * |---|---|---|
 * | `GET  …/http/fleet` | `fleet` | `script.view` |
 * | `POST …/http/plan` | `plan` | `script.view` |
 * | `POST …/http/apply` | `apply` | `plugin.runtime` |
 *
 * `fleet`/`plan` are `script.view` — the permission an operator already
 * needed to open this screen at all, `handlers.ts`'s own reasoning for its
 * three read routes. `apply` is `plugin.runtime`: `plugins/proxy-manager`'s
 * own precedent for "this changes what a plugin's own resource is doing"
 * (its `start`/`stop`/`restart`/`resetFailover` routes, never `plugin.data`,
 * because the operator is not editing a record here). There is no
 * device-facing ACL permission to reuse the way `proxy-manager`'s own
 * `apply` route reuses `device.network` — this plugin never touches a device
 * (§3.1, §4.10), so the only real permission at stake is "may this person
 * change what this plugin's own service is doing to the router", which is
 * exactly `plugin.runtime`'s job.
 *
 * Every route answers a `200`-shaped `{ ok: false, code, message }` on
 * refusal rather than throwing — the same discipline `handlers.ts`'s own
 * three routes follow, and `apply.ts`'s own functions never throw.
 */
export interface ApplyRoutesHost extends ApplyHost {
  onRequest(
    id: string,
    handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>,
    opts?: { permission?: string; methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; timeoutMs?: number; description?: string },
  ): void
}

export const APPLY_ROUTES = { fleet: 'fleet', plan: 'plan', apply: 'apply' } as const

export const APPLY_ROUTE_PERMISSIONS: Record<keyof typeof APPLY_ROUTES, string> = {
  fleet: 'script.view',
  plan: 'script.view',
  apply: 'plugin.runtime',
}

/**
 * Register the three routes on a live service context.
 *
 * `deps` is the same injectable seam `handlers.ts`'s `registerRouterRoutes`
 * uses (`createDriver`/`deriveCoreAddress`) — a test supplies a fake driver
 * and a fixed core address, never opening a socket.
 */
export function registerApplyRoutes(host: ApplyRoutesHost, deps: ApplyDeps = {}): void {
  host.onRequest(
    APPLY_ROUTES.fleet,
    async () => ({ body: await loadFleet(host, deps) }),
    {
      methods: ['GET'],
      permission: APPLY_ROUTE_PERMISSIONS.fleet,
      description: 'Every device, its resolved LAN address (§3.4) and its noted assignment — the Assignments tab’s initial load, in one round trip.',
    },
  )

  host.onRequest(
    APPLY_ROUTES.plan,
    async () => ({ body: await previewPlan(host, deps) }),
    {
      methods: ['POST'],
      permission: APPLY_ROUTE_PERMISSIONS.plan,
      description: 'The §4.4 diff over the currently-noted assignments — a preview, never a write.',
    },
  )

  host.onRequest(
    APPLY_ROUTES.apply,
    // `forceDownPaths` (plan 131 §3.4) — endpoint keys the operator has
    // explicitly chosen to write even though their path is down. Parsed
    // defensively: a body that is absent, unparseable, or carries anything
    // other than an array of strings yields NO forced keys, so a malformed
    // request degrades to the ordinary, safe apply rather than being refused
    // or — far worse — forcing something nobody asked for.
    async (req) => {
      const forced = await readForcedDownPaths(req)
      return { body: await applyNow(host, { ...deps, ...(forced.size > 0 ? { forceDownPaths: forced } : {}) }) }
    },
    {
      methods: ['POST'],
      permission: APPLY_ROUTE_PERMISSIONS.apply,
      description: 'Executes the exact plan `plan` previews — refused, not attempted, while §3.2’s local-exception check is not ok (acceptance criterion 1). An optional `{ forceDownPaths: string[] }` body writes those endpoints over a DOWN path, which the plan then shows as a real create/update rather than a skip (plan 131 §3.4).',
    },
  )
}

/**
 * The one place the request body is read. Never throws: plan 122's own rule is
 * that these routes do not throw, and an operator's apply must not fail
 * because a body was malformed — it falls back to forcing nothing.
 */
async function readForcedDownPaths(req: unknown): Promise<ReadonlySet<string>> {
  try {
    const body = await (req as { json?: () => Promise<unknown> } | null)?.json?.()
    const raw = (body as { forceDownPaths?: unknown } | null)?.forceDownPaths
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((k): k is string => typeof k === 'string' && k.length > 0))
  } catch {
    return new Set()
  }
}
