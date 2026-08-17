'use client'

import { Loader2 } from 'lucide-react'
import {
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  DevicePreparationSchema,
  PreparationComponentStatusSchema,
  type DevicePreparation,
  type PreparationComponentStatus,
  type PreparationState,
} from '@enkaku/protocol'
import { Button, cn, ErrorState, LoadingRows, api, useAction, duration, relativeTime } from '@enkaku/ui'
import { usePreparation } from '@/lib/use-preparation'
import { useNow } from '@/lib/useNow'

/**
 * The device popup's Preparation section (plan 106 §3.3, §5 step 106.3) —
 * what the owner asked for verbatim: *"kalau ada proses install apk yang
 * error atau gagal ini bisa di lihat mana apk yang gagal dan statenya bisa
 * diulangi lagi diliat dari popup list action ini."* Before this step the
 * only way to see `devices.preparation` was `curl` — `GET`/`POST
 * /api/devices/:id/preparation` and `POST .../:componentId/retry` (plan 106
 * §5 step 106.2) existed with no button anywhere in Studio.
 *
 * **Where this lives, decided (§3.3's own instruction to weigh a
 * `SettingsPopup` section against a `SidePanel` tab):** a `SettingsPopup`
 * section, not a `SidePanel` tab. `SidePanel`'s own file header states the
 * test plainly — Actions/Inspector/Record earn a panel beside the live
 * screen because each "needs to be open WHILE touching the phone" (you tap
 * and watch the UI tree change; you record by interacting). Preparation
 * fails that test the same way Monitor did when it joined `JobsPopup`
 * instead of becoming a 13th `ActionsList` row (`docs/design.md`'s own
 * words: "you READ it, nothing needs touching on the phone meanwhile") —
 * retrying a component's install runs in the background on the core, not
 * against a live picture the operator is watching. `SettingsPopup` already
 * grew past its original six sections for exactly this reason (General,
 * Video, Timing), so a tenth section costs nothing structurally, and
 * §4.2's "displace, not append" rule governs `ActionsList`'s twelve FIXED
 * rows specifically, not this popup's own section count.
 *
 * **Every component the endpoint can report gets a row, including the
 * guest agent — which is not in `preparation/registry.ts`'s array (plan 106
 * §5 step 106.5's own deliberate divergence).** `GET .../preparation`
 * returns whatever is in `devices.preparation` today, keyed by componentId;
 * this panel does not merely iterate that record; it FORCES `guest-agent`
 * to always render a row, synthesising the same `absent`-state default the
 * protocol package itself ships (`DEFAULT_PREPARATION_COMPONENT_STATUS`)
 * for the rare case a device has never had a single agent-provisioner pass
 * (every admission/reconnect hook already runs one, so this is a startup
 * race, not a steady state) — a surface that only rendered whatever keys
 * happened to be in the response would silently omit the exact component
 * the owner's own report named first. `ui-server` and any future registry
 * entry render from the response's own keys, in a fixed order for the two
 * known components followed by anything this build of Studio does not
 * recognise yet — labelled with its raw id rather than hidden, the same
 * "never drop an unrecognised value" rule `planField`'s escape hatches
 * follow (`docs/design.md`).
 *
 * **A `provisioning` row gets a live indicator and its elapsed time (plan
 * 106 §5 step 106.7)** — the owner's own follow-up ask: *"terus di popupnya
 * juga ada gitu entah ditaruh dimana progress installing preparationnya?"*
 * `usePreparation` (`@/lib/use-preparation`) is the shared source (see its
 * own doc comment for why it polls rather than only listening for events —
 * there is no event for a pass STARTING, only for one finishing). No byte
 * progress is shown, ever: `ComponentRow`'s own comment states why a
 * percentage would be fabricated.
 */

const KNOWN_ORDER = ['guest-agent', 'ui-server']

const KNOWN_LABELS: Record<string, string> = {
  'guest-agent': 'Guest agent',
  // Matches `packages/core/src/device/preparation/ui-server-component.ts`'s
  // own `label` verbatim — this one component covers what an operator might
  // call either "atx" or "ui automator"; it is never presented as two.
  'ui-server': 'UI server (openatx)',
}

function humanizeComponentId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/** Exported so `DevicePopup.tsx`'s screen-panel overlay names a component the SAME way this panel does — one label map, not two that can drift apart. */
export function componentLabel(id: string): string {
  return KNOWN_LABELS[id] ?? humanizeComponentId(id)
}

/** Ordered rows: the two known components first (guest agent always present, even absent from the response), then anything else, alphabetically. */
function orderedComponentIds(preparation: DevicePreparation): string[] {
  const rest = Object.keys(preparation)
    .filter((id) => !KNOWN_ORDER.includes(id))
    .sort((a, b) => a.localeCompare(b))
  const known = KNOWN_ORDER.filter((id) => id === 'guest-agent' || id in preparation)
  return [...known, ...rest]
}

const STATE_LABEL: Record<PreparationState, string> = {
  absent: 'not installed',
  provisioning: 'installing…',
  ready: 'ready',
  outdated: 'update available',
  failed: 'failed',
  unsupported: 'unsupported',
}

const STATE_TONE: Record<PreparationState, string> = {
  absent: 'text-fg-subtle border-line bg-transparent',
  provisioning: 'text-led-active border-led-active/35 bg-led-active/10',
  ready: 'text-led-ok border-led-ok/35 bg-led-ok/10',
  outdated: 'text-led-warn border-led-warn/35 bg-led-warn/10',
  failed: 'text-led-danger border-led-danger/40 bg-led-danger/10',
  unsupported: 'text-fg-subtle border-line bg-transparent',
}

function PreparationStateBadge({ state }: { state: PreparationState }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
        STATE_TONE[state],
      )}
    >
      {state === 'provisioning' ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
      )}
      {STATE_LABEL[state]}
    </span>
  )
}

/**
 * One action per state — `absent`/`outdated`/`failed` are the three a
 * retry can actually change; `provisioning` is already a pass in flight
 * (retrying it would only race the runner's own dedup), `ready` needs
 * nothing, and `unsupported` is terminal by construction (plan 106 §3.2:
 * an old device is not a broken one, and there is nothing a retry could do
 * about an SDK floor).
 */
function retryLabel(state: PreparationState): string | null {
  switch (state) {
    case 'absent':
      return 'Check now'
    case 'outdated':
      return 'Update'
    case 'failed':
      return 'Retry'
    case 'provisioning':
    case 'ready':
    case 'unsupported':
      return null
  }
}

function ComponentRow({
  id,
  status,
  disabled,
  busy,
  now,
  onRetry,
}: {
  id: string
  status: PreparationComponentStatus
  disabled: boolean
  busy: boolean
  /** `useNow()`'s ticking value — only read while `status.state === 'provisioning'`, for the elapsed-time readout below. */
  now: number
  onRetry: () => void
}) {
  const label = retryLabel(status.state)
  const provisioning = status.state === 'provisioning'
  return (
    <div className="rounded-lg border bg-surface p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium">{componentLabel(id)}</span>
        <PreparationStateBadge state={status.state} />
      </div>
      {status.reason && <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">{status.reason}</p>}
      {/* No byte progress exists for an install — `ui-server-component.ts`
          installs through one opaque `hostAdb(['install', …])` call, and
          `agent-provisioner.ts`'s own pass has no tick either (plan 106 §5
          step 106.7). An indeterminate spinner (the badge above) plus
          elapsed time is the honest ceiling — never a percentage bar with
          nothing behind it. */}
      {provisioning && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
          Running for <span className="readout">{duration(status.checkedAt, null, now)}</span> — no progress percentage
          is available for this install, only whether it is still running.
        </p>
      )}
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[11px] text-fg-subtle">version</dt>
          <dd className="readout min-w-0 truncate text-[11.5px]" title={status.version ?? '—'}>
            {status.version ?? '—'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-[11px] text-fg-subtle">{provisioning ? 'started' : 'last checked'}</dt>
          <dd className="readout min-w-0 truncate text-[11.5px]">{relativeTime(status.checkedAt)}</dd>
        </div>
      </dl>
      {label && (
        <div className="mt-3 border-t pt-3">
          <Button size="sm" variant={status.state === 'failed' ? 'outline' : 'secondary'} disabled={disabled || busy} onClick={onRetry}>
            {busy ? `${label}…` : label}
          </Button>
        </div>
      )}
    </div>
  )
}

export function PreparationPanel({
  deviceId,
  deviceLabel,
  canUse,
}: {
  deviceId: string
  deviceLabel: string
  /** Same server-authoritative gate every other mutating Settings section reads (`AgentPanel`, `NetworkPanel`, `IdentityPanel`). */
  canUse: boolean
}) {
  // Plan 106 §5 step 106.7: the SAME hook the screen-panel overlay uses
  // (`DevicePopup.tsx`), so both surfaces read one source of truth rather
  // than two independently-computed ideas of "is this installing right
  // now" — see the hook's own doc comment for the polling-vs-events split.
  const { preparation, loadError, reload, patch, replace } = usePreparation(deviceId)
  const { run, isPending } = useAction()
  const now = useNow(1000)

  const retryComponent = (id: string) =>
    run(`retry-${id}`, () => api(`/api/devices/${deviceId}/preparation/${id}/retry`, PreparationComponentStatusSchema, { method: 'POST' }), {
      success: `${componentLabel(id)} rechecked on ${deviceLabel}`,
      failure: `Could not recheck ${componentLabel(id)}`,
      onSuccess: (status) => patch(id, status),
    })

  const checkNow = () =>
    run('check-now', () => api(`/api/devices/${deviceId}/preparation`, DevicePreparationSchema, { method: 'POST' }), {
      success: `Preparation rechecked on ${deviceLabel}`,
      failure: 'Could not recheck preparation',
      onSuccess: replace,
    })

  const disabled = !canUse

  if (loadError) return <ErrorState message={loadError} onRetry={reload} />
  if (preparation === null) return <LoadingRows rows={2} />

  const ids = orderedComponentIds(preparation)

  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Every on-device piece this farm installs — the guest agent, the UI inspector, and anything registered after
        them — with its own state, its own reason when something failed, and a Retry that clears only that
        component&apos;s bound. A failed component never blocks this device: it still streams and runs work that
        does not need it.
      </p>
      {disabled && (
        <p className="rounded-lg border bg-surface px-3.5 py-2.5 text-[12px] text-fg-muted">
          Take control of this device to retry a component.
        </p>
      )}
      <div className="flex justify-end">
        {/* "Recheck all", not "Check now" — a per-component row can ALSO read
            "Check now" (`retryLabel`'s `absent` case), and the two must stay
            visually and textually distinct rather than colliding. */}
        <Button size="sm" variant="ghost" disabled={disabled || isPending('check-now')} onClick={checkNow}>
          {isPending('check-now') ? 'Rechecking…' : 'Recheck all'}
        </Button>
      </div>
      <div className="space-y-2.5">
        {ids.map((id) => (
          <ComponentRow
            key={id}
            id={id}
            status={preparation[id] ?? DEFAULT_PREPARATION_COMPONENT_STATUS}
            disabled={disabled}
            busy={isPending(`retry-${id}`)}
            now={now}
            onRetry={() => void retryComponent(id)}
          />
        ))}
      </div>
    </div>
  )
}
