'use client'

import { useEffect, useState } from 'react'
import { ScreenShare, X } from 'lucide-react'
import { DeviceDetailResponseSchema, type DeviceInfo } from '@enkaku/protocol'
import type { DeviceDetailInfo } from '@/components/device/DeviceHeader'
import { SidePanel } from '@/components/device-popup/SidePanel'
import { LoadingRows, Button, DeviceName, api, formatDeviceName } from '@enkaku/ui'

/** `w-72` (288px) plus the panel's own border — kept in sync with `SidePanel`'s wrapper below rather than measured, so the viewport clamp below never has to guess at a number the JSX also hardcodes. */
const PANEL_WIDTH_PX = 290
/** A generous cap, not a measured height — twelve action rows plus a header comfortably fit under this; the panel's own `overflow-hidden` + `SidePanel`'s Actions tab `overflow-y-auto` (unchanged, reused) is what actually keeps a taller list on-screen, the same safety net `DevicePopup`'s aside already relies on. */
const PANEL_MAX_HEIGHT_PX = 560

/**
 * The right-click menu on the device grid (plan 101 §3.9, step 101.5, G15),
 * **rebuilt on plan 103's own `SidePanel`/`ActionsList` for step 103.10** —
 * the owner's own ask, verbatim: *"harapan saya ini dihapus digantikan list
 * action yang kaya di popup, jadi sama gitu list actions nya bukan beda beda
 * kaya gini, kalau di device popup panel 3 ada panel cardnya, ada tabs nya,
 * ada list action dan inspector dll nah itu saya mau ada juga di dropdown
 * saat klik kanan juga."* Right-clicking a tile used to open a hand-written,
 * seven-item list (`DeviceContextMenuItem[]`, built by `app/page.tsx`) with
 * its own wording — "Wake selected", "Install on selected…" — worded for a
 * SELECTION, while the device popup's own Actions tab (`ActionsList.tsx`)
 * had twelve rows worded for ONE device. Two vocabularies for the same
 * device was the defect; this file is the fix — it renders panel 3's own
 * card header and `SidePanel`, not a copy of either.
 *
 * **Why this was not buildable before plan 104.** The two lists diverged
 * because neither carried a TARGET — the old menu acted on whatever
 * `app/page.tsx`'s own `selectedIds` happened to be, `ActionsList` acted on
 * whatever single `deviceId` it was mounted with. Plan 104 dissolved that:
 * every multi-device dialog now carries a `TargetPicker` whose default is
 * filled from context (104 §3.2), so a row can be worded once, singularly
 * ("Install apk"), and still act on eight devices when eight are selected.
 * `ActionsList.tsx`'s own file header records the one further fix this step
 * needed beyond reuse: Wake/Sleep and Forget did not carry a target at all
 * before this pass (they always acted on the one focused device), which
 * would have silently reintroduced exactly the "acts on the wrong set"
 * defect this merge exists to remove — see that file for the fix.
 *
 * **The one judgement call this step names, decided rather than left an
 * accident of what was easy to mount: Inspector is not reachable from here.**
 * `SidePanel`'s new `tabs` prop (see that file's own doc comment) is passed
 * `['actions']`. Reasoning, not a shortcut: plan 103 §3.4's own test for
 * what belongs beside the phone is "does this need to be open *while you are
 * touching the phone*?" — Inspector's whole value is watching the UI tree
 * change AS you tap the screen, which is why the device popup pairs it with
 * a live `LiveView` panel right beside it. This menu has no screen at all —
 * it is a small popover anchored at the cursor, not a floating control
 * surface — and it is dismissed on the very next outside click, which an
 * operator inspecting a live UI tree would trigger constantly just by
 * looking away. Mounting a live `inspect.attach` subscription (`InspectorPanel`'s
 * own effect) here would attach and detach on nearly every open, a real cost
 * with no screen to show the result against and nothing to justify it.
 * Actions needs none of that: every row opens its OWN self-contained,
 * non-modal dialog (plan 103 §3.2) that stands on its own regardless of
 * whether a phone is visible nearby, which is why Actions survives this
 * merge and Inspector does not. If Inspector work is wanted on a device
 * reached this way, "Open full device page" (row 12) and a double-click
 * (which opens the real popup, screen included) both still exist.
 *
 * **This surface never claims control of a device on its own** — unlike
 * `DevicePopup`, which historically auto-claimed an idle device on open;
 * under the device activity model (plan 205 §4.9) there is nothing left to
 * pre-claim at all, since any operator may act on an online device
 * immediately. `canUseLive` is always `false` here regardless: Files/Settings
 * render read-only and `AdbCommandDialog`'s `single` mode shows the device's
 * live transcript with its input box honestly disabled — a glance, not a
 * session, since a right-click is often dismissed with Escape or a click
 * elsewhere without touching anything.
 *
 * **No live WS subscription for the fetched device.** `DevicePopup` tracks
 * `device.status`/`device.activity` for its whole (often
 * minutes-long) session; this menu fetches the device's detail once on open
 * and again only after a mutating action explicitly asks for it
 * (`onDeviceReloaded`, the same re-fetch `DevicePopup` uses for the fields a
 * WS broadcast does not carry — Reconnect/Disconnect/Settings). Given this
 * surface is normally on screen for seconds, not minutes, a brief staleness
 * is an accepted, stated trade rather than an oversight.
 *
 * **Every old entry, mapped, per this step's own instruction that an entry
 * with no stated destination is an entry silently removed:**
 *
 * | Old entry | Where it lives now |
 * |---|---|
 * | Run command… | `ActionsList`'s "Adb command" row → `AdbCommandDialog`, `TargetPicker`-driven (already N-device capable). |
 * | Install on selected… | `ActionsList`'s "Install apk" row → `InstallBatchDialog` (already N-device capable). |
 * | Wake selected | `ActionsList`'s Wake/Sleep row(s) — now candidate-set-aware (see that file). |
 * | Sleep selected | Same row(s). |
 * | Forget selected | `ActionsList`'s "Forget" row — now opens `BulkForgetDialog` at more than one candidate (see that file). |
 * | Push file… | **Dropped from this menu, not from the app.** No row in `ActionsList`'s fixed twelve ever carried this (plan 104 §10 already recorded the gap); the Wall's own floating selection toolbar (`app/page.tsx`, unchanged) still calls `setBulkTransferOpen('push')` directly — a route removed, not a capability lost. |
 * | Pull file… | Same as Push file…, `setBulkTransferOpen('pull')`. |
 * | Apply labels | **Dropped from this menu, not from the app**, for the identical reason — no `ActionsList` row exists for the farm's bulk labelling-mode apply, and the selection toolbar's own "Apply labels" button (`applyLabelsToSelected`) is untouched by this step. |
 *
 * No `backdrop-filter` (an opaque `bg-surface`, matching the popup's own
 * aside) — this panel does not scale with device count either.
 */
export function DeviceContextMenu({
  x,
  y,
  deviceId,
  devices,
  selectedIds,
  onClose,
}: {
  x: number
  y: number
  deviceId: string
  /** The Wall's full (unfiltered) device list — `ActionsList`'s own `TargetPicker`-driven rows need the whole pool to pick from, not just this one device. */
  devices: DeviceInfo[]
  /**
   * The page's current selection — already correct by construction: plan
   * 101 step 101.5's own right-click rule (`app/page.tsx`'s
   * `handleDeviceContextMenu`) keeps the WHOLE selection when the
   * right-clicked device was already in it, and collapses it to just this
   * device otherwise. This component trusts that invariant rather than
   * re-deriving it.
   */
  selectedIds: readonly string[]
  onClose: () => void
}) {
  const [deviceDetail, setDeviceDetail] = useState<DeviceDetailInfo | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDeviceDetail(null)
    setFetchError(null)
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => {
        if (!cancelled) setDeviceDetail(b.device)
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [deviceId])

  // Escape closes this panel — but ONLY if nothing else already claimed the
  // key, the SAME rule 1 `DevicePopup.tsx`'s own precedence table documents:
  // an open non-modal dialog (Run script, Install apk, …) is a real Radix
  // `Dialog` even though it renders no backdrop, and its own `DismissableLayer`
  // attaches a capture-phase Escape handler that calls `preventDefault()`
  // before this bubble-phase listener ever runs. Without this check, Escape
  // while "Run script" is open would close BOTH the dialog and this whole
  // panel at once — the exact bug rule 1 exists to prevent, reproduced here
  // because this surface now hosts the same non-modal dialogs the popup does.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function reloadDevice() {
    void api(`/api/devices/${deviceId}`, DeviceDetailResponseSchema)
      .then((b) => setDeviceDetail(b.device))
      .catch(() => undefined)
  }

  const label = deviceDetail?.label ?? deviceId
  // Plan 124 §4.4 Group B, step 124.2 — the composed `#7 Galaxy A15` string.
  // This menu is opened by right-clicking one tile in a rack of physically
  // identical phones, which is precisely the case where naming it by label
  // alone identifies nothing. `deviceDetail?.number` is `undefined` until the
  // detail fetch above lands (and `null` for a device whose reservation was
  // released); `formatDeviceName` treats both as "no number" and renders the
  // bare label, so this never flashes `#undefined` on open (criterion 7).
  const deviceName = formatDeviceName(deviceDetail?.number, label)
  const header = selectedIds.length > 1 ? `${selectedIds.length} devices selected` : deviceName

  // Clamped to the viewport (plan 101's own `x+2/y+2` offset kept as the
  // starting point) — the old item list was small enough to never need
  // this; a full `SidePanel` card is not. `window` is safe to read here:
  // this component only ever mounts from a live mouse event
  // (`app/page.tsx`'s `contextMenu` state starts `null`), never during the
  // static export's own server-side render pass.
  const left = Math.min(x + 2, window.innerWidth - PANEL_WIDTH_PX - 8)
  const top = Math.min(y + 2, window.innerHeight - 40)

  return (
    <>
      {/* A full-screen click-catcher closes the menu on any outside click or
          a second right-click elsewhere — unchanged from before this step.
          `z-40` (not the old `z-[55]`) so a non-modal dialog opened from
          inside this panel (Run script, Install apk, … — all `z-50`, `ui/
          dialog.tsx`) renders ABOVE it rather than being buried underneath;
          the panel below shares this z-index and paints on top of this
          element by DOM order alone, the same way `DevicePopup`'s own
          single `z-40` container already sits above the Wall and below
          every dialog it opens. */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        role="region"
        aria-label={`Device actions — ${header}`}
        className="fixed z-40 flex w-72 flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl"
        style={{ left, top, maxHeight: PANEL_MAX_HEIGHT_PX }}
      >
        {/* Panel 3's own header shape, reused literally (`DevicePopup.tsx`'s
            aside header) — the device label (or "N devices selected", the
            old menu's own header rule) and a Close button; no shared title
            bar, matching the popup's own "no chrome outside the panel"
            rule. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <ScreenShare className="size-4 shrink-0 text-accent-strong" aria-hidden />
            {/* Plan 124 §3.2 — the multi-device header is a plain count and
                names no device, so it stays a bare span; the single-device
                header is a name and therefore renders through `<DeviceName>`,
                which dims the number into its own span instead of running it
                into the label. The two branches cannot share one element:
                `<DeviceName>` is the flex item that has to shrink here, and
                nesting it inside a `truncate` span would leave it sized by
                its own content and overflowing rather than ellipsised. */}
            {selectedIds.length > 1 ? (
              <span className="truncate text-[13px] font-medium">{header}</span>
            ) : (
              <DeviceName number={deviceDetail?.number} label={label} className="text-[13px] font-medium" />
            )}
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} className="shrink-0">
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        {fetchError && <p className="shrink-0 border-b px-3 py-1.5 text-[11.5px] text-led-danger">{fetchError}</p>}

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {deviceDetail ? (
            <SidePanel
              deviceId={deviceId}
              device={deviceDetail}
              devices={devices}
              selectedIds={selectedIds}
              canUseLive={false}
              onDeviceReloaded={reloadDevice}
              onForgotten={onClose}
              tabs={['actions']}
            />
          ) : (
            !fetchError && <LoadingRows rows={4} />
          )}
        </div>
      </div>
    </>
  )
}
