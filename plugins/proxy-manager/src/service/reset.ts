import { z } from 'zod'
import type { PluginResetItem, PluginResetReport } from '@enkaku/protocol'
import { ASSIGNMENT_KEY, proxyKeyFor } from '../shared'
import { messageOf } from './errors'
import type { ProxyRuntime, ProxyView } from './supervisor'

/**
 * **Reset data** — what this pack undoes, one moment before the farm deletes
 * everything it stored.
 *
 * ## Why this handler has to exist at all
 *
 * The owner's own example, and it is not incidental: *"contoh ketika plugin
 * proxy manager di reset, selain hapus semua data, plugin proxy manager juga
 * harus set network proxy ke off dulu ke device yang pernah diassign ke proxy
 * yang diatur dalam proxy manager, jadi biar ga error."*
 *
 * This pack's `assigned` rows are the **only** record of which phones it
 * pointed at a proxy. The farm knows a route exists on a device — that is on
 * the device's own row, stamped *set by proxy-manager* — but nothing else in
 * the farm knows which catalogue entry it came from or that it belongs to this
 * pack's bookkeeping at all. Delete the assignments without turning the routes
 * off and every one of those phones is carrying a live route that nothing left
 * on the farm can explain: the exact orphan class the network layer's
 * `pendingClear` machinery exists to close, re-opened through the front door.
 *
 * ## The order, and why it is this way round
 *
 * **Devices first, bridges second.** In HTTP mode a phone dials this pack's own
 * loopback bridge over `adb reverse`; stopping the bridge first would leave the
 * phone pointed at a dead port for however long the un-routing takes. Turning
 * the phone off the route first, then closing the listener nobody is dialling
 * any more, is the sequence with no window in it.
 *
 * ## What it refuses to touch
 *
 * A device whose route this pack **did not set** is left exactly as it is, and
 * reported as such. `setBy` is checked on every device before anything is
 * cleared: an operator who set their own proxy by hand on a phone that also
 * happens to carry one of this pack's assignment notes has not asked for it to
 * be turned off, and a reset that un-routed it would be this plugin reaching
 * past its own record and into the operator's. There is no orphan in that case
 * either — the farm's own device row records that route, with the person's name
 * on it.
 *
 * ## Offline phones, which is the normal case rather than the exception
 *
 * On a real farm most devices are away. `device.network.clear` follows the
 * disarm-direction admission rule (`capability/device-network.ts`), so an
 * offline phone is not refused: the farm records the teardown as a
 * `pendingClear` debt on the device's own row and settles it — with a real
 * teardown, not a bookkeeping-only clear — the next time that device is
 * admitted. That is reported as `pending`, never as `cleared`, because the
 * phone has not been told yet.
 *
 * `pending` is what makes it safe for the farm to delete this pack's data
 * anyway: the obligation has MOVED to the device row, which outlives the
 * plugin's namespace. `failed` is the other case — a phone somebody is driving
 * right now, a lock held by an incumbent route — where nothing recorded the
 * debt, and the farm keeps every row rather than deleting the only record of
 * it.
 *
 * ## Idempotent, because an operator will press it again
 *
 * Every step is safe to repeat. `device.network.clear` is idempotent by
 * contract (a device with no route is left alone rather than reported as an
 * error), a stop on a bridge that is already down is a no-op, and a second pass
 * over a phone that was cleared on the first reports `unchanged` rather than
 * doing anything. A pass that half-completed leaves the data in place, which is
 * exactly the state a re-run needs to finish the job.
 */

/** What this handler needs from a `PluginServiceContext`, structurally — so a test supplies three functions, not a runtime. */
export interface ResetHost {
  storage: {
    forDevice(deviceId: string): { getRaw(key: string): Promise<unknown> }
  }
  farm: {
    call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T>
  }
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }
}

/** The two supervisor methods this needs. Narrowed so the test does not have to build a live one. */
export interface ResetSupervisor {
  snapshot(): ProxyView[]
  stop(id: string, opts?: { force?: boolean }): Promise<ProxyRuntime>
}

/**
 * `device.list`, read the same way `apply.ts` reads it and for the same reason:
 * `z.looseObject` on the items, because the farm's own output schema can change
 * under a pack published months ago and a strict object would turn every future
 * field into this pack refusing to work.
 */
const DeviceListSchema = z.object({
  items: z.array(z.looseObject({ id: z.string(), stableId: z.string(), label: z.string().optional() })),
})

/**
 * The half of `GET/DELETE /api/devices/:id/network` this handler decides on.
 *
 * `pendingClear` is the field that separates a debt from a success, so it is
 * read explicitly rather than left to the loose spread: a farm that predates it
 * answers without the key, which reads as `undefined` — "nothing is owed" — and
 * that is the honest reading of that silence, exactly as the protocol's own
 * `.default(null)` says.
 */
const NetworkStatusSchema = z.looseObject({
  engine: z.string(),
  enabled: z.boolean(),
  setBy: z.object({ kind: z.string(), id: z.string(), at: z.number() }).nullable().optional(),
  pendingClear: z.object({ reason: z.string(), since: z.number() }).nullable().optional(),
})

/** The assignment row, read defensively for the same reason `apply.ts` reads it defensively: this is the pack's own scratch space and an operator with `kv.manage` can put anything in it. */
function assignedKeyOf(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const proxy = (value as { proxy?: unknown }).proxy
  return typeof proxy === 'string' ? proxy : ''
}

/** This pack's own principal, as the farm stamps it onto a route it set. */
const OWN_PRINCIPAL = { kind: 'plugin', id: 'proxy-manager' } as const

/** Who set the route on a phone, written for a person. */
function describeSetBy(setBy: { kind: string; id: string } | null | undefined): string {
  if (!setBy) return 'something that left no attribution'
  if (setBy.kind === 'plugin') return `the “${setBy.id}” plugin`
  return `${setBy.id}, by hand`
}

export async function resetProxyManager(host: ResetHost, supervisor: ResetSupervisor): Promise<PluginResetReport> {
  const items: PluginResetItem[] = []

  // ---- 1. the phones ------------------------------------------------------

  /**
   * The farm's own device list is the only way this pack learns a device exists
   * — it has no database and no adb — and it is what maps a `stableId` to the
   * row id every device API is keyed by.
   *
   * A failure HERE is not an item, it is the end of the pass: without the list
   * there is no way to know which phones were assigned, and reporting "0
   * devices, all clean" off a call that failed would be the single most
   * dangerous sentence this file could produce. It throws, the farm reports the
   * handler as errored, and nothing is deleted.
   */
  const devices = await host.farm.call('device.list', {}, DeviceListSchema)

  for (const device of devices.items) {
    let assigned = ''
    try {
      assigned = assignedKeyOf(await host.storage.forDevice(device.id).getRaw(ASSIGNMENT_KEY))
    } catch (err) {
      // An unreadable row is a phone this pack may well have routed and can no
      // longer account for. Reported as a failure rather than skipped: "I could
      // not read my own note about this device" must not be indistinguishable
      // from "this device was never assigned".
      items.push({
        kind: 'device',
        id: device.stableId,
        ...(device.label ? { label: device.label } : {}),
        outcome: 'failed',
        message: `This device's assignment note could not be read (${messageOf(err)}), so there is no way to tell whether this plugin routed it. Nothing was changed on the phone.`,
      })
      continue
    }
    // Never assigned by this pack, so there is nothing of this pack's on it.
    // Not reported at all: a forty-device farm where three were assigned should
    // show three rows, not forty, and thirty-seven "not mine" lines would bury
    // the three that matter.
    if (!assigned) continue

    const label = device.label && device.label.length > 0 ? device.label : device.stableId
    const item = (outcome: PluginResetItem['outcome'], message: string): void => {
      items.push({ kind: 'device', id: device.stableId, label, outcome, message })
    }

    try {
      const status = await host.farm.call('device.network.get', { deviceId: device.id }, NetworkStatusSchema)

      // Nothing armed and nothing owed — the note is bookkeeping about a route
      // that is not there. The note goes with the rest of the data; the phone
      // needs no visit.
      if (!status.enabled && !status.pendingClear) {
        item('unchanged', `Noted against “${assigned}”, and this phone is not carrying a route — nothing had to be turned off. The note goes with the rest of the data.`)
        continue
      }

      // Somebody else's route. Left alone, deliberately — see this file's
      // header. There is no orphan here: the farm's own device row records it,
      // with whoever set it named on it.
      const setBy = status.setBy ?? null
      if (!(setBy && setBy.kind === OWN_PRINCIPAL.kind && setBy.id === OWN_PRINCIPAL.id)) {
        item(
          'unchanged',
          `Noted against “${assigned}”, but the ${status.engine} route on this phone was set by ${describeSetBy(setBy)} — not by this plugin — so it was left exactly as it is. Turn it off from the device's own Network panel if that is what you want.`,
        )
        continue
      }

      const after = await host.farm.call('device.network.clear', { deviceId: device.id }, NetworkStatusSchema)
      if (after.pendingClear) {
        /**
         * The phone was not reached. This is `pending` and NEVER `cleared`: the
         * route is still live on the device until the debt settles, and the
         * whole point of the outcome vocabulary is that a farm-recorded debt
         * and a delivered teardown are not worded as one thing.
         *
         * It is also not `failed`, because the obligation has genuinely moved
         * somewhere that outlives this plugin's data — the device's own row —
         * and the farm settles it with a real teardown on that device's next
         * admission, with or without this plugin.
         */
        item(
          'pending',
          `This phone could not be reached, so its ${status.engine} route is still live: ${after.pendingClear.reason}. The farm has recorded the teardown against the device and will carry it out the next time the device is admitted — it is not waiting on this plugin, and it survives this reset.`,
        )
        continue
      }
      item('cleared', `The ${status.engine} route this plugin applied for “${assigned}” was turned off on the phone, and the settings the farm found there before it ever wrote one were restored.`)
    } catch (err) {
      /**
       * A refusal from the farm — somebody is driving the phone right now
       * (`admitMember` working exactly as designed), an incumbent route holding
       * the `network-route` lock, a device forgotten between the list and this
       * call. Each one is a product outcome and each one leaves the phone
       * carrying a route nothing has recorded as owed, which is precisely
       * `failed`: the farm will keep every row of this plugin's data because of
       * it, and pressing Reset again once the phone is free will finish the job.
       */
      const code = (err as { code?: unknown } | null)?.code
      host.log.warn('reset could not turn a device’s route off', { deviceId: device.id, proxy: assigned, code: typeof code === 'string' ? code : null })
      item(
        'failed',
        `The route this plugin applied for “${assigned}” could NOT be turned off${typeof code === 'string' && code.length > 0 ? ` (${code})` : ''}: ${messageOf(err)}. This phone is still carrying it, and nothing has recorded that a teardown is owed — so none of this plugin's data was deleted. Clear whatever is in the way and reset again.`,
      )
    }
  }

  // ---- 2. the bridges -----------------------------------------------------

  /**
   * A listener with no record behind it is its own orphan: the catalogue row
   * that explains why port 9902 is bound is about to be deleted, and this
   * service stays loaded afterwards, so nothing would ever close it short of a
   * plugin reload.
   *
   * `force: true` rather than a drain, and the reason is the same one that
   * makes this a reset: the record is going away, so there is no arrangement
   * left for a live tunnel to finish under. Waiting `drainMs` per bridge for
   * connections that are about to have nothing to connect to would only make an
   * operator watch a spinner.
   *
   * The supervisor's own entries are left alone here. `refresh()` — which every
   * one of this pack's routes calls before it does anything — drops an entry
   * whose record is gone and whose listener is down, so the ghosts clear
   * themselves the next time the screen is opened, and the one case it
   * deliberately keeps (a record deleted while its port is still bound) is
   * exactly the case this loop has just made impossible.
   */
  for (const view of supervisor.snapshot()) {
    if (view.runtime.state === 'stopped') continue
    const key = proxyKeyFor(view.id)
    const label = view.record.label && view.record.label.length > 0 ? view.record.label : view.id
    try {
      const runtime = await supervisor.stop(view.id, { force: true })
      items.push({
        kind: 'resource',
        id: key,
        label,
        outcome: 'cleared',
        message: `The bridge for “${key}” was listening on port ${view.runtime.port ?? '(unknown)'} and has been stopped${runtime.state === 'stopped' ? '' : ` (it reports “${runtime.state}”)`}. Live tunnels through it were destroyed rather than drained — its record is being deleted, so there was nothing left for them to finish under.`,
      })
    } catch (err) {
      items.push({
        kind: 'resource',
        id: key,
        label,
        outcome: 'failed',
        message: `The bridge for “${key}” could not be stopped: ${messageOf(err)}. Its port is still bound and its record is about to have been deleted, so nothing was deleted — reload this plugin, which closes every listener it owns, and reset again.`,
      })
    }
  }

  host.log.info('reset pass finished', {
    devices: items.filter((i) => i.kind === 'device').length,
    bridges: items.filter((i) => i.kind === 'resource').length,
    failed: items.filter((i) => i.outcome === 'failed').length,
    pending: items.filter((i) => i.outcome === 'pending').length,
  })

  return {
    items,
    note:
      items.length === 0
        ? 'No device was noted against a proxy and no bridge was listening, so there was nothing on any phone or on this machine to undo.'
        : `${items.filter((i) => i.kind === 'device').length} device${items.filter((i) => i.kind === 'device').length === 1 ? '' : 's'} noted against a proxy, and ${items.filter((i) => i.kind === 'resource').length} bridge${items.filter((i) => i.kind === 'resource').length === 1 ? '' : 's'} that was listening.`,
  }
}
