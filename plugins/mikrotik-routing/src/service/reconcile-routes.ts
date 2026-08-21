import type { PluginRequest, PluginResponse } from '@enkaku/sdk'
import type { ReconcileLoop } from './reconcile'

/**
 * The "Reconcile now" route — plan 122 §5 step 122.9's explicit path, so an
 * operator does not have to wait for the interval (§4.7). One route, backed
 * by the SAME `ReconcileLoop` `src/index.ts` starts at setup: calling it
 * shares the loop's single-flight guard and notify-dedup state with the
 * scheduled timer (`reconcile.ts`'s own header) rather than running a second,
 * disconnected reconcile pass.
 *
 * `plugin.runtime`, not `script.view` — the same reasoning
 * `apply-routes.ts`'s own `apply` route gives: a tick MAY write to the router
 * (`config.autoRepair`), so the permission at stake is "may this person
 * change what this plugin's own service is doing to the router", exactly
 * `plugin.runtime`'s job, even on a tick that turns out to change nothing.
 */
export interface ReconcileRoutesHost {
  onRequest(
    id: string,
    handler: (request: PluginRequest, signal: AbortSignal) => PluginResponse | void | Promise<PluginResponse | void>,
    opts?: { permission?: string; methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; timeoutMs?: number; description?: string },
  ): void
}

export const RECONCILE_ROUTES = { reconcile: 'reconcile' } as const

export const RECONCILE_ROUTE_PERMISSIONS: Record<keyof typeof RECONCILE_ROUTES, string> = {
  reconcile: 'plugin.runtime',
}

/** Registers the one route on a live service context, against the given loop. */
export function registerReconcileRoutes(host: ReconcileRoutesHost, loop: ReconcileLoop): void {
  host.onRequest(
    RECONCILE_ROUTES.reconcile,
    async () => ({ body: await loop.reconcileNow() }),
    {
      methods: ['POST'],
      permission: RECONCILE_ROUTE_PERMISSIONS.reconcile,
      description: 'Runs one reconcile tick right now — the exact §4.7 drift table, reported (and, if config.autoRepair is on and §3.2 is ok, repaired for missing-rule/wrong-path only) rather than waiting for the interval.',
    },
  )
}
