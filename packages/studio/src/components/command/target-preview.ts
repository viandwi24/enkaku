import type { ClusterInfo, CommandTarget, DeviceInfo } from '@enkaku/protocol'
import { formatDeviceName } from '@enkaku/ui'

/**
 * The command console's target-resolution PREVIEW (plan 93 §3.14 guard 1,
 * §3.16, step 93.7) — "a target preview, always... names every device that
 * will and will not receive the command... the guard that stops the mistake
 * most often, because most fleet mistakes are targeting mistakes."
 *
 * There is no dedicated preview endpoint (93.4's REST surface only resolves
 * a target as a side effect of actually starting a run, inside
 * `POST /api/command-runs`). This is a CLIENT-SIDE approximation built from
 * the devices list Studio already has — the same data `DevicePicker` and the
 * fleet page already render — mirroring `resolveTarget`'s own exclusion rule
 * (`packages/core/src/clusters/resolve.ts`, plan 93 §0 finding F30): only
 * `offline`/`quarantined` devices are excluded outright, with the identical
 * short reason words that function uses. A `busy`/`manual` device is NOT
 * excluded here — the runner attempts it and skips it live if the lease
 * cannot be admitted (plan 93 §3.8's `admitMember`), so this preview shows
 * those as ATTEMPTED WITH A CAUTION rather than promising an outcome this
 * client cannot know in advance (a lease can change between this preview and
 * the moment the run actually reaches that device).
 */

export interface TargetPreviewEntry {
  device: DeviceInfo
  reason: string
}

export interface TargetPreview {
  /** Every device the target selects, before any status is considered. */
  matched: DeviceInfo[]
  /** Will be SENT to the server — `resolveTarget`'s own `usable` set. */
  willAttempt: DeviceInfo[]
  /** Never sent — offline or quarantined, the exact two reasons `resolveTarget` excludes on. */
  excluded: TargetPreviewEntry[]
  /** Sent, but likely to come back `skipped` at run time — busy, or held by someone else right now. */
  caution: TargetPreviewEntry[]
}

const EMPTY_PREVIEW: TargetPreview = { matched: [], willAttempt: [], excluded: [], caution: [] }

/** Tags use AND semantics — a device must carry every tag (`clusters/resolve.ts`'s `resolveTarget`, unchanged here). */
export function matchesTarget(device: DeviceInfo, target: CommandTarget): boolean {
  if ('deviceIds' in target) return target.deviceIds.includes(device.id)
  if ('clusterId' in target) return device.cluster?.id === target.clusterId
  return target.tags.length > 0 && target.tags.every((t) => device.tags.includes(t))
}

export function computeTargetPreview(devices: DeviceInfo[], target: CommandTarget | null, mySessionId: string | null): TargetPreview {
  if (!target) return EMPTY_PREVIEW
  const matched = devices.filter((d) => matchesTarget(d, target))
  const willAttempt: DeviceInfo[] = []
  const excluded: TargetPreviewEntry[] = []
  const caution: TargetPreviewEntry[] = []

  for (const d of matched) {
    if (d.status === 'offline') {
      excluded.push({ device: d, reason: 'offline' })
      continue
    }
    if (d.status === 'quarantined') {
      excluded.push({ device: d, reason: 'quarantined' })
      continue
    }
    willAttempt.push(d)
    if (d.status === 'busy') {
      caution.push({ device: d, reason: 'an automation job is running — may be skipped' })
    } else if (d.status === 'manual' && !(d.heldBy?.kind === 'user' && d.heldBy.id === mySessionId)) {
      const who = d.heldBy ? `held by ${d.heldBy.label}` : 'held by another client'
      caution.push({ device: d, reason: `${who} — may be skipped` })
    }
  }

  return { matched, willAttempt, excluded, caution }
}

/**
 * A short, human summary of a `CommandTarget` for a history row or a saved
 * command — resolves labels when it can, falls back to the raw id/count
 * otherwise.
 *
 * Plan 124 §4.4 Group D, step 124.4 — each device name is composed through
 * `formatDeviceName`, so a history row reads `#7 Galaxy A15, #12 Galaxy A15`
 * instead of the same model name twice. This is a `.join(', ')` summary and
 * therefore needs the `string` form of the rule (§3.2), not `<DeviceName>`.
 *
 * The cluster and tag branches are untouched on purpose: neither names a
 * device, and a cluster is not a phone.
 */
export function describeCommandTarget(target: CommandTarget, devices: DeviceInfo[], clusters: ClusterInfo[]): string {
  if ('clusterId' in target) {
    const cluster = clusters.find((c) => c.id === target.clusterId)
    return cluster ? `cluster ${cluster.name}` : `cluster ${target.clusterId}`
  }
  if ('tags' in target) {
    return target.tags.join(', ')
  }
  const byId = new Map(devices.map((d) => [d.id, d]))
  // A saved command outlives the devices it names (that is the whole reason
  // this function has a fallback at all), so an id with no device left
  // resolves to the bare id — never `#undefined`, never a number invented
  // from somewhere else.
  const labels = target.deviceIds.map((id) => {
    const d = byId.get(id)
    return d ? formatDeviceName(d.number, d.label) : id
  })
  if (labels.length <= 3) return labels.join(', ')
  return `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`
}
