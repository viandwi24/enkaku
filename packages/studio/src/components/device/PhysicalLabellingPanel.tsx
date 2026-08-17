'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { DeviceLabelStateSchema, type DeviceLabelMode, type DeviceLabelState } from '@enkaku/protocol'
import { LabelPreview } from '@/components/device/LabelPreview'
import { LabelStateBadge } from '@/components/device/LabelStateBadge'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { Button, Switch, ConfirmDialog, api, describeApiError, relativeTime } from '@enkaku/ui'

function readDraftLabelling(draft: Record<string, unknown>): { mode: DeviceLabelMode; showName: boolean } {
  const raw = (draft.labelling ?? {}) as { mode?: DeviceLabelMode; showName?: boolean }
  return { mode: raw.mode ?? 'off', showName: raw.showName ?? true }
}

/**
 * The device Settings tab's "Physical labelling" section (plan 89 §3.4,
 * §3.5, §3.6, §3.8, §5 step 89.8) — the SAME split-schema-plus-extra shape
 * `DeviceVideoFields` uses: `SchemaForm` still draws `mode`/`showName` (spec
 * §19 — no hand-built control for a value the schema already describes),
 * this component only adds what a schema cannot: a content preview, the
 * live applied state, and the two actions that reach past `mode`/`showName`
 * into the labelling SERVICE itself (`Re-apply`/`Clear`, plan 89 §4.6).
 *
 * Three things this component exists to get right, named directly by this
 * step's own brief:
 *
 * 1. **Two tiers, no silent fallback (§3.5).** `LabelStateBadge` renders
 *    `applied`/`stale`/`partial`/`unavailable` as five different, truthfully
 *    coloured words — never flattened into one green tick.
 * 2. **The preview is a preview of CONTENT, not of PIXELS (§3.4).** This
 *    workspace has no font and no rasteriser (F11) — the real image is
 *    rendered on the device, by the device's own font engine. `LabelPreview`
 *    says so in its own caption rather than pretending to be a screenshot.
 * 3. **Opt-in, stated where it is decided (§3.6, §3.8).** The banner below
 *    says plainly that turning this on writes to the phone and outlives the
 *    session — the same fact the admit dialog's checkbox states up front,
 *    repeated here because a farm default can turn this on for a device
 *    whose operator never saw that dialog.
 */
export function PhysicalLabellingPanel({
  device,
  schema,
  draft,
  onChange,
  onSubmit,
  onReset,
  busy,
  dirty,
  labelState,
  onLabelStateChange,
}: {
  device: { id: string; label: string; number: number | null; screenW: number | null; screenH: number | null }
  schema: JsonSchemaNode
  draft: Record<string, unknown>
  onChange(next: unknown): void
  onSubmit(): void
  onReset(): void
  busy: boolean
  dirty: boolean
  /** `null` until the first `GET .../label` resolves. */
  labelState: DeviceLabelState | null
  /** Lifted to the caller so `DeviceHeader`'s own badge (a sibling, not a child, of this panel) stays in sync without a second fetch — the CALLER already fetches the initial value once on load, so this panel fetches nothing on mount, only on an explicit action or "Check now". */
  onLabelStateChange(next: DeviceLabelState): void
}) {
  const [actionBusy, setActionBusy] = useState<'apply' | 'clear' | 'refresh' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { mode, showName } = readDraftLabelling(draft)

  const refresh = async () => {
    setActionBusy('refresh')
    setActionError(null)
    try {
      const state = await api(`/api/devices/${device.id}/label`, DeviceLabelStateSchema)
      onLabelStateChange(state)
    } catch (err) {
      setActionError(describeApiError(err))
    } finally {
      setActionBusy(null)
    }
  }

  const reapply = async () => {
    setActionBusy('apply')
    setActionError(null)
    try {
      const state = await api(`/api/devices/${device.id}/label/apply`, DeviceLabelStateSchema, { method: 'POST' })
      onLabelStateChange(state)
      if (state.state === 'applied') toast.success('Label applied')
      else if (state.state === 'partial') toast.warning(`Only partially applied — ${state.reason ?? 'see the badge below'}`)
      else if (state.state === 'unavailable') toast.error(`Could not label this device — ${state.reason ?? 'unavailable'}`)
    } catch (err) {
      setActionError(describeApiError(err))
    } finally {
      setActionBusy(null)
    }
  }

  const clear = async (restoreOriginal: boolean) => {
    setActionBusy('clear')
    setActionError(null)
    try {
      const state = await api(`/api/devices/${device.id}/label/clear`, DeviceLabelStateSchema, {
        method: 'POST',
        json: { restoreOriginal },
      })
      onLabelStateChange(state)
      toast.success(restoreOriginal ? 'Restored the original' : 'Cleared to the system default')
    } catch (err) {
      setActionError(describeApiError(err))
    } finally {
      setActionBusy(null)
    }
  }

  const [restoreOnClear, setRestoreOnClear] = useState(false)
  const canRestore = labelState?.originalCaptured === true

  return (
    <div className="space-y-5">
      {/* §3.6, §3.8 — stated where the choice is made, not only in a doc:
          this writes to the phone and outlives the session, the lease, and
          the core process, and clearing it later is a separate, explicit
          action. */}
      <p className="rounded-lg border bg-surface-2/40 px-3 py-2.5 text-[12px] leading-relaxed text-fg-muted">
        Turning this on writes to the phone itself, not just to this session — it stays on screen after you close
        this tab, after the lease ends, even across a restart of Enkaku. "Wallpaper" replaces the phone's wallpaper
        and needs the guest agent; "Lock screen" writes one line of text under the lock-screen clock and needs
        nothing installed, but a device without the guest agent cannot use "Wallpaper" and will report so rather
        than quietly using the lesser tier.
      </p>

      <SchemaForm schema={schema} value={draft} onChange={onChange} />

      <div className="flex flex-wrap items-start gap-5 rounded-lg border p-3.5">
        <LabelPreview
          name={showName ? device.label : null}
          number={device.number}
          showName={showName}
          screenW={device.screenW}
          screenH={device.screenH}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="rack-label">Current state</p>
          {mode === 'off' ? (
            <p className="text-[12.5px] text-fg-muted">Labelling is off for this device — nothing is written to it.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <LabelStateBadge state={labelState} />
                {(!labelState || labelState.state === 'unknown') && (
                  <span className="text-[12px] text-fg-subtle">Not yet checked</span>
                )}
              </div>
              {labelState?.appliedAt && (
                <p className="text-[11.5px] text-fg-subtle">Last applied {relativeTime(labelState.appliedAt)}</p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionBusy !== null || dirty || device.number === null}
                  title={device.number === null ? 'This device has no number assigned yet' : dirty ? 'Save your changes first' : undefined}
                  onClick={() => void reapply()}
                >
                  {actionBusy === 'apply' ? 'Applying…' : 'Re-apply label'}
                </Button>
                <Button size="sm" variant="ghost" disabled={actionBusy !== null} onClick={() => void refresh()}>
                  {actionBusy === 'refresh' ? 'Checking…' : 'Check now'}
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="ghost" className="text-led-danger" disabled={actionBusy !== null}>
                      Clear label…
                    </Button>
                  }
                  title={`Clear ${device.label}'s label?`}
                  description={
                    <div className="space-y-3">
                      <p>
                        {canRestore
                          ? 'Removes the label. You can restore what was on this phone before labelling started, or reset it to the system default.'
                          : "Removes the label and resets this phone to the system default — the original could not be saved when labelling was first turned on for this device, so it cannot be restored."}
                      </p>
                      {canRestore && (
                        <label className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-[12.5px]">
                          <span>Restore the original</span>
                          <Switch checked={restoreOnClear} onCheckedChange={setRestoreOnClear} aria-label="Restore the original" />
                        </label>
                      )}
                    </div>
                  }
                  confirmLabel="Clear"
                  onConfirm={() => clear(canRestore && restoreOnClear)}
                />
              </div>
            </>
          )}
          {actionError && <p className="text-[10.5px] text-led-danger">{actionError}</p>}
        </div>
      </div>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-bg py-3">
        <Button type="button" onClick={onSubmit} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onReset} disabled={busy || !dirty}>
          Discard changes
        </Button>
        {!dirty && <span className="text-[12px] text-fg-subtle">No changes</span>}
      </div>
    </div>
  )
}
