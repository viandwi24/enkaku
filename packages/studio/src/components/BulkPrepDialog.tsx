'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEVICE_PREP_KEYS,
  KeepAwakeModeSchema,
  RotationModeSchema,
  TextInputModeSchema,
  classifyDevicePrepApply,
  type DeviceInfo,
  type DevicePrepApplyResult,
  type DevicePrepKey,
  type DevicePrepPatch,
  type GroupInfo,
  type KeepAwakeMode,
  type RotationApplyResult,
  type RotationMode,
  type TextInputMode,
} from '@enkaku/protocol'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
  useAction,
} from '@enkaku/ui'
import { OutcomeSummary, type OutcomeCounts } from '@/components/bulk/OutcomeSummary'
import { SkippedGroups, deviceNameIn, type NamedOutcome } from '@/components/bulk/SkippedGroups'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { runAction, awaitOperation } from '@/lib/actions'
import { resolveTargetDeviceIds } from '@/lib/operations'

/**
 * Set one preparation setting across a selection, through
 * `POST /api/devices/prep/apply`.
 *
 * **Why it exists.** The farm default (`FarmSettings.defaults`) is
 * copy-on-admission — *"Devices already registered keep their own settings"* —
 * so on a farm whose phones are all already enrolled, changing it changes
 * nothing. `prep.rotation` and its four siblings could only be set one device
 * at a time through the device panel: twenty phones, twenty saves, for one
 * checkbox.
 *
 * Composed like every other bulk dialog here rather than as a new pattern: a
 * module-scope `TARGET_ALLOW`, `useTargetSelection` + `TargetPicker`, `reset()`
 * on open, the dialog stays open and swaps its body form → report, and the
 * footer swaps Cancel/Apply → Retry/Close.
 *
 * **Three things are specific to this action.**
 *
 * 1. **Each setting is opted into, one at a time.** The switch on the left of a
 *    row is not decoration and it is not a value — it is whether that key is
 *    in the request at all. An unticked row is absent from the body, and the
 *    core writes only what it receives. Sending the whole `prep` block would
 *    quietly overwrite four settings the operator never touched on every
 *    selected device.
 * 2. **Rotation has a live effect and the other four do not.** A rotation
 *    change reaches a phone that is streaming RIGHT NOW; `keepAwake`,
 *    animations, screen-off and text input are read when a session starts, so
 *    they take effect on the device's next session. The form says which is
 *    which before the operator commits, not afterwards.
 * 3. **A busy device is saved, not skipped, and the report says both halves.**
 *    Nothing here pre-empts a running job (spec §10.1). The setting is written;
 *    the live re-lock waits for the job's next session; the device is named.
 *    "Applied to 20 devices" over a mix of applied / no session / busy / the
 *    phone declined is precisely what this report refuses to say.
 */
const TARGET_ALLOW: Target[] = ['single', 'group', 'devices']

/** Whether a key's effect is live on a streaming device, or waits for the next session. */
const LIVE_NOW: Record<DevicePrepKey, boolean> = {
  disableAnimations: false,
  keepAwake: false,
  standbyScreenOff: false,
  rotation: true,
  textInput: false,
}

const KEY_TITLE: Record<DevicePrepKey, string> = {
  disableAnimations: 'Disable animations',
  keepAwake: 'Keep the screen awake',
  standbyScreenOff: 'Turn the device screen off while streaming',
  rotation: 'Screen rotation',
  textInput: 'Text input',
}

/**
 * A failure code's plain-language half. The server's own message is appended
 * verbatim after it and is what distinguishes two devices that failed for the
 * same coded reason — identical reasons collapse into one row, a different one
 * stays visible (`SkippedGroups` groups on the exact text).
 */
const CODE_LABEL: Record<string, string> = {
  E_DEVICE_NOT_FOUND: 'No such device',
  device_not_found: 'No such device',
  E_PREP_SAVE_FAILED: 'The setting could not be saved',
  E_SETTINGS_UNREADABLE: 'This device’s stored settings could not be read',
  E_ROTATION_FAILED: 'The rotation lock could not be applied',
}

/**
 * The `settings` verb's own `detail` shape on a `done` result
 * (`packages/core/src/actions/impl/settings.ts`'s `SettingsResult`) —
 * mirrored here rather than imported, since Studio does not depend on
 * `packages/core`. `changed` entries are dotted (`prep.rotation`), the
 * merge's own "which keys were sent" record across every settings block, not
 * this dialog's bare `DevicePrepKey` — the `prep.` ones are picked back out
 * below.
 */
interface SettingsActionDetail {
  changed: string[]
  rotation: RotationApplyResult | null
}

/** One `ActionResult` from the `settings` verb, reshaped into the row `classifyDevicePrepApply`/`SkippedGroups` already know how to render. */
function toPrepResult(r: { deviceId: string; status: string; message?: string; code?: string; detail?: unknown }): DevicePrepApplyResult {
  if (r.status !== 'done') {
    return { deviceId: r.deviceId, saved: false, changed: [], rotation: null, error: { code: r.code ?? r.status, message: r.message ?? r.status } }
  }
  const detail = r.detail as SettingsActionDetail
  const changed = detail.changed.filter((c) => c.startsWith('prep.')).map((c) => c.slice('prep.'.length)) as DevicePrepKey[]
  return { deviceId: r.deviceId, saved: true, changed, rotation: detail.rotation, error: null }
}

export function BulkPrepDialog({
  open,
  onOpenChange,
  devices,
  allDevices,
  groups = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pre-filled default target — still fully editable through the picker below. */
  devices: DeviceInfo[]
  /** The whole pool `TargetPicker`'s Group/Multiple devices modes choose from. Defaults to `devices` for a caller not yet updated to pass the whole fleet. */
  allDevices?: DeviceInfo[]
  groups?: GroupInfo[]
}) {
  const pool = allDevices ?? devices
  const { run, isPending } = useAction()

  // Which keys go in the body. Every one starts OFF: a dialog that opens with
  // a setting pre-ticked is a dialog that writes a setting nobody chose.
  const [included, setIncluded] = useState<Record<DevicePrepKey, boolean>>({
    disableAnimations: false,
    keepAwake: false,
    standbyScreenOff: false,
    rotation: false,
    textInput: false,
  })
  const [rotation, setRotation] = useState<RotationMode>('lock-portrait')
  const [keepAwake, setKeepAwake] = useState<KeepAwakeMode>('while-charging')
  const [textInput, setTextInput] = useState<TextInputMode>('auto')
  const [disableAnimations, setDisableAnimations] = useState(true)
  const [standbyScreenOff, setStandbyScreenOff] = useState(false)
  const [results, setResults] = useState<DevicePrepApplyResult[] | null>(null)

  const targetSelection = useTargetSelection({ usableCount: allDevices ? allDevices.length : Number.POSITIVE_INFINITY, groups })
  const { target, deviceId, deviceIds, groupId, resolvedCount, hasTarget, fleetConfirmed } = targetSelection

  // Plan 124 §4.4, step 124.3 — the report below is the only consumer, and it
  // needs the two-field form (number apart from label) that `NamedOutcome`
  // carries so `SkippedGroups` can dim the number. There is no prose site in
  // this dialog that names a single device, so no composed-string twin here.
  const deviceName = (id: string) => deviceNameIn(pool, id)

  // Re-default whenever the dialog OPENS — never on every render, which would
  // stomp an operator's own edit the moment the device list refreshed
  // underneath them.
  useEffect(() => {
    if (!open) return
    setResults(null)
    targetSelection.reset({
      devices: pool,
      allow: TARGET_ALLOW,
      initialDeviceId: devices[0]?.id ?? null,
      initialSelectedIds: devices.length > 1 ? devices.map((d) => d.id) : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const setKey = (key: DevicePrepKey, on: boolean) => setIncluded((prev) => ({ ...prev, [key]: on }))

  /**
   * The exact body's `prep` half — built by asking each row whether it is
   * ticked, one key at a time, so an untouched setting is ABSENT rather than
   * present-and-defaulted. This mirrors the core's merge line for line, and
   * for the same reason: a spread of a five-key object whose unticked members
   * are `undefined` would be indistinguishable from this until it reached a
   * schema with defaults, at which point it silently becomes a reset.
   */
  function prepBody(): DevicePrepPatch {
    const patch: DevicePrepPatch = {}
    if (included.disableAnimations) patch.disableAnimations = disableAnimations
    if (included.keepAwake) patch.keepAwake = keepAwake
    if (included.standbyScreenOff) patch.standbyScreenOff = standbyScreenOff
    if (included.rotation) patch.rotation = rotation
    if (included.textInput) patch.textInput = textInput
    return patch
  }

  const chosenKeys = DEVICE_PREP_KEYS.filter((key) => included[key])

  const targetDeviceIds = useMemo(
    () => resolveTargetDeviceIds({ target, deviceId, deviceIds, groupId }, pool),
    [target, deviceId, deviceIds, groupId, pool],
  )

  const canSubmit = hasTarget && fleetConfirmed && chosenKeys.length > 0 && targetDeviceIds.length > 0

  /**
   * One submit for both the first run and a retry. A retry sends ONLY the
   * devices it names, and its rows replace those devices' rows in the report —
   * the ones that already worked are neither re-sent nor forgotten.
   *
   * Plan 207 §4.2, §4.9 — `POST /api/devices/prep/apply` is gone; this is now
   * the actions API's own `settings` verb (`runAction('settings', target,
   * { settings: { prep: patch } })`), settled via `awaitOperation`. Each
   * `ActionResult` is reshaped back into the same `DevicePrepApplyResult`
   * row this dialog's report already knew how to render (`changed`/
   * `rotation` on a `done` result's own `detail`, an `error` object
   * otherwise) — `classifyDevicePrepApply` and `SkippedGroups` below are
   * unchanged.
   */
  const submit = (ids: string[], actionKey: string) =>
    run(
      actionKey,
      async () => {
        const response = await runAction('settings', { deviceIds: ids }, { settings: { prep: prepBody() } })
        const operation = await awaitOperation(response.operationId)
        return operation.results.map(toPrepResult)
      },
      {
        failure: 'Could not apply the prep settings',
        onSuccess: (rows) =>
          setResults((prev) => {
            if (!prev) return rows
            const fresh = new Map(rows.map((r) => [r.deviceId, r]))
            return prev.map((r) => fresh.get(r.deviceId) ?? r)
          }),
      },
    )

  // ---- the report ----
  const report = useMemo(() => {
    if (!results) return null
    const failed: NamedOutcome[] = []
    const deferred: NamedOutcome[] = []
    let ok = 0
    let noSession = 0
    let unchanged = 0
    let relocked = 0
    for (const r of results) {
      const outcome = classifyDevicePrepApply(r)
      const named = deviceName(r.deviceId)
      if (outcome === 'failed') {
        const reason = r.error
          ? `${CODE_LABEL[r.error.code] ?? r.error.code} — ${r.error.message}`
          : `The screen did not re-lock${r.rotation?.reason ? ` — ${r.rotation.reason}` : ''}. The setting is saved and applies to this device’s next session.`
        failed.push({ deviceId: r.deviceId, ...named, reason })
        continue
      }
      if (outcome === 'deferred') {
        deferred.push({
          deviceId: r.deviceId,
          ...named,
          reason: `Saved, but the screen was not re-locked — ${r.rotation?.reason ?? 'a job is running on this device'}.`,
        })
        continue
      }
      ok += 1
      if (r.changed.length === 0) unchanged += 1
      if (r.rotation?.state === 'no-session') noSession += 1
      if (r.rotation?.state === 'applied') relocked += 1
    }
    const counts: OutcomeCounts = { ok, failed: failed.length, skipped: deferred.length, total: results.length }
    const retryIds = [...failed, ...deferred].map((e) => e.deviceId)
    return { counts, failed, deferred, ok, noSession, unchanged, relocked, retryIds }
  }, [results, pool])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setResults(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Prep settings on {resolvedCount} device{resolvedCount === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>
            Only the settings you switch on below are written. Every other setting on every selected device is left
            exactly as it is. Each device reports its own outcome — this dialog stays open to show it, named device by
            named device.
          </DialogDescription>
        </DialogHeader>

        {!report ? (
          <div className="@container space-y-3">
            <div className="space-y-2">
              <PrepRow
                keyName="rotation"
                on={included.rotation}
                onToggle={(v) => setKey('rotation', v)}
                description="The only setting here that reaches a phone that is streaming right now. It is never applied to a device running a job — that waits for the job’s next session."
              >
                <EnumSelect
                  id="bulk-prep-rotation"
                  disabled={!included.rotation}
                  value={rotation}
                  onChange={(v) => {
                    const parsed = RotationModeSchema.safeParse(v)
                    if (parsed.success) setRotation(parsed.data)
                  }}
                  options={[
                    ['device', 'Follow the device'],
                    ['lock-portrait', 'Lock portrait'],
                    ['lock-landscape', 'Lock landscape'],
                    ['lock-current', 'Lock whatever it is now'],
                  ]}
                />
              </PrepRow>

              <PrepRow
                keyName="keepAwake"
                on={included.keepAwake}
                onToggle={(v) => setKey('keepAwake', v)}
                description="Applied when a session opens, and put back when it closes."
              >
                <EnumSelect
                  id="bulk-prep-keep-awake"
                  disabled={!included.keepAwake}
                  value={keepAwake}
                  onChange={(v) => {
                    const parsed = KeepAwakeModeSchema.safeParse(v)
                    if (parsed.success) setKeepAwake(parsed.data)
                  }}
                  options={[
                    ['off', 'Off'],
                    ['while-charging', 'While charging'],
                    ['always', 'Always'],
                  ]}
                />
              </PrepRow>

              <PrepRow
                keyName="disableAnimations"
                on={included.disableAnimations}
                onToggle={(v) => setKey('disableAnimations', v)}
                description="Turned off before a job runs, on the device’s next session."
              >
                <BoolSelect
                  id="bulk-prep-animations"
                  disabled={!included.disableAnimations}
                  value={disableAnimations}
                  onChange={setDisableAnimations}
                  onLabel="Disable them"
                  offLabel="Leave them on"
                />
              </PrepRow>

              <PrepRow
                keyName="standbyScreenOff"
                on={included.standbyScreenOff}
                onToggle={(v) => setKey('standbyScreenOff', v)}
                description="Blanks the physical panel while mirroring continues. Takes effect on the device’s next session."
              >
                <BoolSelect
                  id="bulk-prep-standby"
                  disabled={!included.standbyScreenOff}
                  value={standbyScreenOff}
                  onChange={setStandbyScreenOff}
                  onLabel="Screen off"
                  offLabel="Screen on"
                />
              </PrepRow>

              <PrepRow
                keyName="textInput"
                on={included.textInput}
                onToggle={(v) => setKey('textInput', v)}
                description="Which keyboard types during a session, so non-ASCII text can be sent. Takes effect on the device’s next session."
              >
                <EnumSelect
                  id="bulk-prep-text-input"
                  disabled={!included.textInput}
                  value={textInput}
                  onChange={(v) => {
                    const parsed = TextInputModeSchema.safeParse(v)
                    if (parsed.success) setTextInput(parsed.data)
                  }}
                  options={[
                    ['auto', 'Automatic'],
                    ['agent', 'The guest agent’s keyboard'],
                    ['device', 'The device’s own keyboard'],
                  ]}
                />
              </PrepRow>
            </div>

            {chosenKeys.length === 0 ? (
              <p className="text-[11.5px] text-fg-subtle">
                Nothing is switched on yet, so this would write nothing. Switch on the settings you want applied.
              </p>
            ) : (
              <p className="rounded border border-line bg-surface-2/50 px-2.5 py-2 text-[11.5px] leading-relaxed text-fg-muted">
                {chosenKeys.length === 1 ? 'One setting' : `${chosenKeys.length} settings`} will be written:{' '}
                <span className="text-fg">{chosenKeys.map((key) => KEY_TITLE[key]).join(', ')}</span>. The other{' '}
                {DEVICE_PREP_KEYS.length - chosenKeys.length} are not part of this request and are not touched.
                {chosenKeys.some((key) => LIVE_NOW[key])
                  ? ' A device that is streaming right now re-locks immediately; one running a job keeps the setting and applies it on the job’s next session.'
                  : ' None of them changes a screen that is streaming right now — they are read when a session starts.'}
              </p>
            )}

            <TargetPicker selection={targetSelection} devices={pool} groups={groups} allow={TARGET_ALLOW} />
          </div>
        ) : (
          <div className="space-y-3">
            <OutcomeSummary counts={report.counts} label="Prep settings progress" />
            {report.counts.skipped > 0 && (
              <p className="rounded border border-led-warn/35 bg-led-warn/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-led-warn">
                {report.counts.skipped} device{report.counts.skipped === 1 ? ' is' : 's are'} running a job.{' '}
                <span className="font-medium">The setting is saved on {report.counts.skipped === 1 ? 'it' : 'them'}</span> — only
                the live screen was left alone, and the lock applies on the job’s next session. Nothing was taken from a
                running job.
              </p>
            )}
            {report.noSession > 0 && (
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                {report.noSession} of the {report.ok} that saved had no session open, so no screen moved — the lock
                applies to their next session.
              </p>
            )}
            {report.relocked > 0 && (
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                {report.relocked} screen{report.relocked === 1 ? '' : 's'} re-locked while you watched.
              </p>
            )}
            {report.unchanged > 0 && (
              <p className="text-[11.5px] leading-relaxed text-fg-subtle">
                {report.unchanged} already held {report.unchanged === 1 ? 'this value' : 'these values'} — nothing to change there.
              </p>
            )}
            <SkippedGroups failed={report.failed} skipped={report.deferred} />
            {report.failed.length === 0 && report.deferred.length === 0 && (
              <p className="text-[11.5px] text-fg-subtle">Every device in the selection took the settings.</p>
            )}
          </div>
        )}

        <DialogFooter>
          {!report ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submit(targetDeviceIds, 'bulk-prep')} disabled={!canSubmit || isPending('bulk-prep')}>
                {isPending('bulk-prep') ? 'Applying…' : `Apply to ${resolvedCount} device${resolvedCount === 1 ? '' : 's'}`}
              </Button>
            </>
          ) : (
            <>
              {report.retryIds.length > 0 && (
                <Button
                  variant="outline"
                  disabled={isPending('bulk-prep-retry')}
                  onClick={() => void submit(report.retryIds, 'bulk-prep-retry')}
                >
                  {isPending('bulk-prep-retry')
                    ? 'Retrying…'
                    : `Retry the ${report.retryIds.length} that did not apply`}
                </Button>
              )}
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One setting: the switch that decides whether the key is IN THE REQUEST, the
 * name, one line of what it does and when it takes effect, and the value
 * control — which stays disabled until the row is switched on, so a value
 * nobody opted into can never look like a value that is about to be written.
 *
 * The value control drops below the label under ~28rem of dialog width, and
 * the query is a `@container` one: this lives inside a modal, so a `lg:` here
 * would be answering a question about the window, which is a different
 * question with a different answer.
 */
function PrepRow({
  keyName,
  on,
  onToggle,
  description,
  children,
}: {
  keyName: DevicePrepKey
  on: boolean
  onToggle: (on: boolean) => void
  description: string
  children: ReactNode
}) {
  const title = KEY_TITLE[keyName]
  return (
    <div className={cn('rounded-md border px-2.5 py-2', on ? 'border-line bg-surface-2/40' : 'border-line/60')}>
      <div className="flex items-start gap-2.5">
        <Switch checked={on} onCheckedChange={onToggle} aria-label={`Apply ${title.toLowerCase()} to the selection`} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1.5 @sm:flex-row @sm:items-center @sm:justify-between">
            <div className="min-w-0">
              <p className={cn('text-[12.5px] font-medium', on ? 'text-fg' : 'text-fg-muted')}>{title}</p>
              {LIVE_NOW[keyName] ? (
                <p className="text-[11px] text-led-ok">Applies to a live session</p>
              ) : (
                <p className="text-[11px] text-fg-subtle">Applies on the next session</p>
              )}
            </div>
            <div className="shrink-0">{children}</div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">{description}</p>
        </div>
      </div>
    </div>
  )
}

function EnumSelect({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  options: Array<[string, string]>
  disabled: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="h-8 w-full text-[12.5px] @sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A boolean rendered as two named choices rather than a second switch beside the include switch — two switches in one row is a coin flip about which one means what. */
function BoolSelect({
  id,
  value,
  onChange,
  onLabel,
  offLabel,
  disabled,
}: {
  id: string
  value: boolean
  onChange: (value: boolean) => void
  onLabel: string
  offLabel: string
  disabled: boolean
}) {
  return (
    <>
      <Label htmlFor={id} className="sr-only">
        {onLabel}
      </Label>
      <EnumSelect
        id={id}
        disabled={disabled}
        value={value ? 'on' : 'off'}
        onChange={(v) => onChange(v === 'on')}
        options={[
          ['on', onLabel],
          ['off', offLabel],
        ]}
      />
    </>
  )
}
