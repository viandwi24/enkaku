'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { SettingsResponseSchema, isHighConsequence, type ActionResult, type GroupInfo, type DeviceInfo } from '@enkaku/protocol'
import { ActionResults } from '@/components/actions/ActionResults'
import { EmptyState, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, api, formatDeviceName, useAction } from '@enkaku/ui'
import { TargetPicker } from '@/components/target/TargetPicker'
import { useTargetSelection, type Target } from '@/components/target/useTargetSelection'
import { AdbEndpointCard } from '@/components/terminal/AdbEndpointCard'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { runAction, awaitOperation } from '@/lib/actions'
import { ws } from '@/lib/ws'

const TARGET_ALLOW: Target[] = ['single', 'group', 'devices']

/** The `adb` verb's `detail` shape on a `done` result (`packages/core/src/actions/impl/shell.ts`'s `ShellRunResult`) — mirrored here rather than imported, since Studio does not depend on `packages/core`. */
const ShellRunResultSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
})

/**
 * The device popup's "Adb command" row — plan 103 §9 Q4, answered
 * 2026-08-16. The owner, twice: *"fitur terminal keknya jadi satu aja
 * dengan adb command ga sih? terus bentuknya modal juga dan bisa deteksi
 * device juga, jadi bisa running banyak devices"*, then, seeing it still a
 * side-panel tab: *"terminal kenapa masih ada tab nya? ... ketika di tekan
 * muncul popup modal tersendiri ... seperti install apk mendukung opsi
 * specific device, multiple device atau cluster ... tapi outputnya harus
 * bisa dilihat langsung juga?"* This is that modal — it replaces the
 * `SidePanel`'s old Terminal TAB entirely (`SidePanel.tsx`'s own doc
 * comment records the removal).
 *
 * **Two shapes behind one `TargetPicker` (plan 104), not two features
 * wearing one name.** §9 Q4 itself named the tension: an interactive
 * session on one device and a fan-out command across a target set are
 * genuinely different, and the resolution is which surface answers which —
 * not picking a winner between them.
 *
 * - **`single`** renders `TerminalPane` UNCHANGED — the same interactive,
 *   multi-command session with a live transcript and arrow-up history
 *   (plan 26 §4.5, plan 93 §3.5). This is also the answer to "do not
 *   silently drop the interactive session" (the owner's own instruction on
 *   this pass): it has not moved or lost anything, it is simply this
 *   modal's single-device shape instead of a side-panel tab reached by a
 *   separate click.
 * - **`group`/`devices`** dispatches the actions API's own `adb` verb
 *   (`POST /api/actions/adb`, plan 207 §4.2, §4.9) — the same `command`
 *   activity and per-device operation registry every other async verb
 *   uses, polled by `awaitOperation` (1s interval) and rendered through
 *   `ActionResults`, with each device's stdout/stderr shown under its own
 *   row. This replaced the fleet command console entirely (plan 207 §4.7):
 *   no history, no saved commands, no staging, no cancel/continue — an
 *   `adb` run is one bounded fan-out, start to finish.
 *
 * `TerminalPane`'s own `canType` only ever reflects whether the FOCUSED
 * device is online (`canUseLive`, `DevicePopup.tsx`'s `online`) — switching
 * `single` mode to a different device in the picker still shows its
 * transcript live (everyone watching a device sees it, plan 26 §3.8) but the
 * input box stays honestly disabled for a device that is offline.
 *
 * **`single` mode also carries `AdbEndpointCard` (plan 103 §5, closing step
 * 103.11's audit row 8, 2026-08-17)** — the activity-gated `adb connect`
 * endpoint, above `TerminalPane`, gated on the SAME `shell.endpointEnabled`
 * farm switch the device page's own Terminal tab reads. This is where the
 * card belongs now: it was always "beside the Terminal tab" (its own file
 * header), and the Terminal tab's device-aware successor is this modal's
 * `single` mode, not a side-panel tab any more (§9 Q4 above).
 */
export function AdbCommandDialog({
  deviceId,
  devices,
  selectedIds = [],
  groups = [],
  canUseLive,
  open,
  onOpenChange,
}: {
  /** The popup's own focused device — `single` mode's default, and the only device `canType` can ever be true for. */
  deviceId: string
  /** The Wall's whole pool — `TargetPicker`'s `devices`/`group` modes need it, same as `ActionsList`'s other multi-device rows. */
  devices: DeviceInfo[]
  /** The Wall's own live selection, unioned with `deviceId` before becoming the picker's pre-fill (plan 104 §3.2). */
  selectedIds?: readonly string[]
  groups?: GroupInfo[]
  /** `iHoldControl && !busy` on the focused device — gates `TerminalPane`'s input box in `single` mode. */
  canUseLive: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { run, isPending } = useAction()
  const [shellMode, setShellMode] = useState<'off' | 'admin' | 'operator' | 'all'>('admin')
  // Plan 103 §5, closing step 103.11's audit row 8 — the SAME farm switch
  // `app/device/page.tsx`'s own Terminal tab reads for `AdbEndpointCard`
  // below.
  const [endpointEnabled, setEndpointEnabled] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  const [cmd, setCmd] = useState('')
  const [results, setResults] = useState<ActionResult[] | null>(null)

  const targetSelection = useTargetSelection({ usableCount: devices.length, groups })
  const { target, deviceId: singleDeviceId, deviceIds, groupId, hasTarget, fleetConfirmed, resolvedCount } = targetSelection

  // Re-default and clear any run every time the dialog OPENS — the same
  // shape `InstallBatchDialog` uses (plan 104 §3.2): nothing else selected
  // on the Wall behind this popup lands `single` on the focused device; N
  // devices selected arrive pre-filled, still fully editable.
  //
  // Plan 103 §5 step 103.10 — dedupe BEFORE checking length, not after.
  // The old `selectedIds.length > 0 ? [...new Set(...)] : undefined` checked
  // the RAW selection's length first, so a caller whose own selection is
  // JUST this device (`selectedIds: [deviceId]` — exactly what a right-click
  // on a not-yet-selected tile produces, plan 101 §5 step 101.5's own rule)
  // still took the `devices`-mode branch with a redundant one-device
  // pre-fill, instead of `single` — the wrong default for what is, in
  // substance, "nothing else selected". `ActionsList.tsx`'s own
  // `candidateIds` fixes the identical shape for its Wake/Sleep/Forget rows;
  // this is the same fix for this dialog's own default.
  useEffect(() => {
    if (!open) return
    setCmd('')
    setResults(null)
    const candidateIds = [...new Set([deviceId, ...selectedIds])]
    const initialSelectedIds = candidateIds.length > 1 ? candidateIds : undefined
    targetSelection.reset({ devices, allow: TARGET_ALLOW, initialDeviceId: deviceId, initialSelectedIds })
    void api('/api/settings', SettingsResponseSchema)
      .then((b) => {
        setShellMode(b.settings.shell.mode)
        setEndpointEnabled(b.settings.shell.endpointEnabled)
      })
      .catch(() => undefined)
      .finally(() => setSettingsLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleOpenChange(o: boolean): void {
    onOpenChange(o)
    if (!o) setResults(null)
  }

  async function handleRunClick(): Promise<void> {
    if (!hasTarget || !cmd.trim()) return
    const targetBody = target === 'group' ? { groupId } : { deviceIds: target === 'single' ? [singleDeviceId] : deviceIds }
    await run(
      'start',
      async () => {
        const response = await runAction('adb', targetBody, { cmd: cmd.trim() })
        const operation = await awaitOperation(response.operationId, { intervalMs: 1000 })
        setResults(operation.results)
      },
      { failure: 'Could not start the command' },
    )
  }

  /**
   * Plan 124 §4.4 Group D, step 124.4 — the report's own label lookup,
   * composing the number the same way every other bulk report in this
   * codebase does.
   */
  function deviceLabel(devId: string): string {
    const d = devices.find((dev) => dev.id === devId)
    return d ? formatDeviceName(d.number, d.label) : devId
  }

  const shellOff = shellMode === 'off'
  const hc = isHighConsequence(cmd)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
      <DialogContent overlay={false} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Adb command</DialogTitle>
          <DialogDescription>
            Run a shell command on this device, several, or a group — each device reports its own result.
          </DialogDescription>
        </DialogHeader>

        {!settingsLoaded ? (
          <p className="text-[11.5px] text-fg-subtle">Loading…</p>
        ) : shellOff ? (
          <EmptyState title="Device shell access is turned off" description="Turn it on from Settings → Device terminal." />
        ) : (
          <div className="space-y-3">
            <TargetPicker selection={targetSelection} devices={devices} groups={groups} allow={TARGET_ALLOW} singleLabel="Device" devicesLabel="Devices" />

            {target === 'single' ? (
              singleDeviceId ? (
                <div className="space-y-3">
                  {/* Row 8 (audit) — the activity-gated `adb connect`
                      endpoint, gated on the farm's `shell.endpointEnabled`
                      exactly like the device page's own Terminal tab.
                      `canOpen` mirrors `TerminalPane`'s own `canType`
                      below — a picked device other than the popup's own
                      focused one stays honestly closed, same reasoning. */}
                  {endpointEnabled && (
                    <AdbEndpointCard deviceId={singleDeviceId} clientId={ws.getSessionId()} canOpen={singleDeviceId === deviceId && canUseLive} />
                  )}
                  <div className="max-h-[26rem] overflow-y-auto rounded-lg border">
                    <TerminalPane
                      deviceId={singleDeviceId}
                      canType={singleDeviceId === deviceId && canUseLive}
                      onRunAsStream={() =>
                        toast.info('Open Jobs → Monitor from the Actions list to watch this as a live stream.', {
                          description: 'Reachable from this device’s own popup now — no need to leave for the full device page.',
                        })
                      }
                    />
                  </div>
                </div>
              ) : (
                <EmptyState title="No device to target" description="Pick a device above." />
              )
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="popup-adb-cmd" className="text-[11.5px] text-fg-muted">
                    Command
                  </Label>
                  <Input
                    id="popup-adb-cmd"
                    value={cmd}
                    onChange={(e) => setCmd(e.target.value)}
                    placeholder="getprop ro.build.version.release"
                    className="readout h-8 text-[12.5px]"
                  />
                  {/* A usability guard, never a security control (`high-consequence.ts`'s own
                      doc comment) — the server does not know this list exists. Stated inline
                      rather than behind a second confirm dialog: with the fleet console gone,
                      an operator who runs it anyway sees the same warning either way. */}
                  {hc.hit && (
                    <p className="text-[11.5px] text-led-warn">
                      This command matches a pattern that is often destructive or disruptive. Double-check the target before running it.
                    </p>
                  )}
                </div>

                <Button size="sm" onClick={() => void handleRunClick()} disabled={!hasTarget || !cmd.trim() || !fleetConfirmed || isPending('start')}>
                  {isPending('start') ? 'Starting…' : 'Run'}
                </Button>

                {results && (
                  <div className="space-y-3">
                    <ActionResults results={results} nameOf={deviceLabel} />
                    {results
                      .filter((r) => r.status === 'done')
                      .map((r) => {
                        const parsed = ShellRunResultSchema.safeParse(r.detail)
                        if (!parsed.success || (!parsed.data.stdout && !parsed.data.stderr)) return null
                        return (
                          <div key={r.deviceId} className="rounded-lg border bg-surface p-2.5">
                            <p className="mb-1 text-[11px] font-medium text-fg-muted">{deviceLabel(r.deviceId)}</p>
                            {parsed.data.stdout && (
                              <pre className="readout whitespace-pre-wrap text-[11.5px] text-fg">{parsed.data.stdout}</pre>
                            )}
                            {parsed.data.stderr && (
                              <pre className="readout whitespace-pre-wrap text-[11.5px] text-led-danger">{parsed.data.stderr}</pre>
                            )}
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
