import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { DEFAULT_PREPARATION_COMPONENT_STATUS, type DevicePreparation } from '@enkaku/protocol'
import type { AuthEnv } from '../auth/middleware'
import { requirePermission } from '../auth/middleware'
import type { Db } from '../db'
import { devices } from '../db/schema'
import { GUEST_AGENT_COMPONENT_ID } from '../device/preparation/guest-agent-status'
import type { PreparationRunner } from '../device/preparation/runner'
import { EnkakuError } from '../util/errors'

/**
 * Device preparation's HTTP surface (plan 106 §3.3, §4) — what step 106.3
 * (the popup, NOT this step) will render. This step exposes it because the
 * plan is explicit that the runner is the thing that "exposes" a clearable
 * bound, not the popup: `GET` reads the per-component record, `POST`
 * without a component id runs every registered component for the device
 * (the "on demand" hook, §3.5), `POST .../:componentId/retry` runs exactly
 * one component with `force: true` — the operator-facing retry that clears
 * that component's exhausted bound (§3.3), without disturbing any other
 * component's own state.
 */
export interface DevicePreparationRoutesDeps {
  db: Db
  runner: PreparationRunner
  /**
   * Plan 106 §5 step 106.5: the guest agent is authoritative on
   * `devices.preparation['guest-agent']` (`agent-provisioner.ts`'s
   * `writeCached`), but keeps its OWN specialised execution/bounded-retry
   * engine rather than running through `runner`'s generic per-component
   * loop — its pass needs a live `hello()` handshake and capability
   * negotiation the generic `PreparationComponent` contract has no room
   * for (see `agent-provisioner.ts`'s own doc comment). It is deliberately
   * NOT registered in `preparation/registry.ts`, so `runner.ensureComponent`
   * has no entry for `'guest-agent'` and would 404. Bridged here instead,
   * so the SAME popup and the SAME retry button work for every component
   * including this one — an operator should never need to know that guest
   * agent's pass runs through a different engine underneath. Optional so
   * every existing test/call site (which predates this bridge) keeps
   * constructing this router unchanged.
   */
  agentProvisioner?: {
    ensure: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown>
    /** Plan 106 §5 step 106.7 — optional so every pre-106.7 call site (real or test-double) keeps constructing this router unchanged. */
    runningSince?: (deviceId: string) => number | null
  }
}

/**
 * Overlays `runner.runningSince(deviceId)` (and, when bridged, the guest
 * agent's own `agentProvisioner.runningSince`) onto a persisted preparation
 * record — plan 106 §5 step 106.7. This is a READ-time overlay only: it
 * never writes `state: 'provisioning'` back to `devices.preparation` (see
 * `runner.ts`'s `runningSince` doc comment for why), so a device with a pass
 * genuinely executing right now reads `provisioning` from `GET
 * /:id/preparation` for exactly as long as that is true, and reverts to
 * whatever the last COMPLETED pass actually decided the instant it is not.
 */
function overlayInFlight(deps: DevicePreparationRoutesDeps, id: string, preparation: DevicePreparation): DevicePreparation {
  const next: DevicePreparation = { ...preparation }
  for (const [componentId, startedAt] of Object.entries(deps.runner.runningSince(id))) {
    next[componentId] = { ...(next[componentId] ?? DEFAULT_PREPARATION_COMPONENT_STATUS), state: 'provisioning', checkedAt: startedAt }
  }
  const guestAgentStartedAt = deps.agentProvisioner?.runningSince?.(id) ?? null
  if (guestAgentStartedAt !== null) {
    next[GUEST_AGENT_COMPONENT_ID] = { ...(next[GUEST_AGENT_COMPONENT_ID] ?? DEFAULT_PREPARATION_COMPONENT_STATUS), state: 'provisioning', checkedAt: guestAgentStartedAt }
  }
  return next
}

export function createDevicePreparationRoutes(deps: DevicePreparationRoutesDeps): { routes: Hono<AuthEnv> } {
  const app = new Hono<AuthEnv>()
  const { db, runner } = deps

  const assertDeviceExists = (id: string): void => {
    const row = db.select({ id: devices.id }).from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
  }

  app.get('/:id/preparation', requirePermission('device.view'), async (c) => {
    const id = c.req.param('id')
    assertDeviceExists(id)
    const preparation = await runner.status(id)
    return c.json(overlayInFlight(deps, id, preparation))
  })

  // On-demand, whole-device pass (§3.5's third hook — admission and
  // reconnect are `daemon.ts`'s job; this is the operator's own "check now").
  // Does NOT force by default — an operator opening the popup should see
  // the real cached state, not restart every component's bound. Pass
  // `?force=1` to run regardless of a standing bound (mirrors
  // `POST /api/guest-agent/provision`'s own `force: true`).
  app.post('/:id/preparation', requirePermission('device.settings'), async (c) => {
    const id = c.req.param('id')
    assertDeviceExists(id)
    const opts = c.req.query('force') === '1' ? { force: true } : undefined
    // `agentProvisioner`'s own pass writes straight into `devices.preparation`
    // (`writeCached`, plan 106 §5 step 106.5) — run it alongside the generic
    // registry's own components so a whole-device "check now" covers guest
    // agent too, then re-read the merged record rather than trusting
    // `runner.ensure()`'s return value, which predates that write.
    const [, preparation] = await Promise.all([
      deps.agentProvisioner?.ensure(id, opts) ?? Promise.resolve(undefined),
      runner.ensure(id, opts),
    ])
    const merged = deps.agentProvisioner ? await runner.status(id) : preparation
    return c.json(merged)
  })

  // The operator-facing retry (§3.3): clears exactly ONE component's
  // exhausted bound, never the whole device's preparation record.
  app.post('/:id/preparation/:componentId/retry', requirePermission('device.settings'), async (c) => {
    const id = c.req.param('id')
    const componentId = c.req.param('componentId')
    assertDeviceExists(id)
    // Guest agent's bound is cleared through its own engine (see
    // `DevicePreparationRoutesDeps.agentProvisioner`'s doc comment) — it is
    // not registered in `runner`'s component roster, so `ensureComponent`
    // would 404 for it.
    if (componentId === GUEST_AGENT_COMPONENT_ID && deps.agentProvisioner) {
      await deps.agentProvisioner.ensure(id, { force: true })
      const preparation = await runner.status(id)
      const status = preparation[GUEST_AGENT_COMPONENT_ID]
      if (!status) throw new EnkakuError('preparation_component_not_found', `no such preparation component: ${componentId}`)
      return c.json(status)
    }
    const status = await runner.ensureComponent(id, componentId, { force: true })
    return c.json(status)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) {
      const status = err.code === 'device_not_found' || err.code === 'preparation_component_not_found' ? 404 : 500
      return c.json(err.toJSON(), status as 404)
    }
    throw err
  })

  return { routes: app }
}
