# Plan 215 — MVP wave 3 : Device Control — the floating window and the input model

> Status: draft — not started; written 2026-09-03 by the plan author for the MVP series
> Depends on: plan 214 (the Devices screen: the table, the Screens grid, the selection model, the bulk pill, and the double-click that opens this window), plan 209 (`input.touch`, `input.scroll`, `input.keyEvent`, `input.pinch`, `clipboard.set`, `clipboard.changed`, `packages/protocol/src/keys.ts`, the UHID keyboard, and `LiveView`'s rewired pointer and key handlers), plan 208 (the session-scoped inspector, `E_INSPECTOR_STARTING`, attach-to-running), plan 207 (`POST /api/actions/<verb>`, `runOnDevice`, `awaitOperation`, the generic action set's verbs), plan 206 (always-on sessions, `stream.started.substitute`), plan 205 (activities, `deviceState`, `device.activity`, the control marker), plan 204 (tokens, Phosphor icons, the re-skinned primitives), plan 203 (the latency estimator and the overlay), plan 213 (the shell, `lib/overlays.ts`, `scripts/check-routes.ts`), plan 211 (jobs and runs: `GET /api/jobs?deviceId=`, the run paths, re-run through `run-script` with `jobId`).
> Spec references: `docs/mvp/08-device-control.md` (entire: §1.1 the pointer table, §1.2 the focus rule, the three keyboard layers and the hotkey table, §1.3 clipboard both ways, §1.4 the toolbar, §1.5 one device, §3 removed, §4 acceptance, §5 open points), `docs/mvp/design_handoff_enkaku_openpf/README.md:230-293` ("Floating window: Device Control", quoted verbatim in §4), `docs/mvp/15-ui-migration.md` §0 (the Device Control paragraph), §0.1 items 2, 3, 4 and 5, §1 rows "Mirror", "State dot colours", "Device page", "DevicePicker in Device Control", "Generic action set versus MVP 07 verbs", §3 step 4, `docs/mvp/02-inspector-readiness.md` §4 phase 1 (the inspector this window drives), `docs/mvp/14-jobs-and-runs.md` §2 (the Jobs section's rows and what "Run again" means), `docs/mvp/13-removal-register.md` A.6 row "The whole device page and its 12 tabs" and A.8 (the last item, the `compact` keyboard disable), `docs/mvp/16-consolidated-plan.md` §1 (Surfaces), §2 (the "Device Control input" and "Navigation" rows), §3 wave 3. Where `docs/spec.md` still describes a device page, `docs/mvp/16` wins (plan 200 header) until plan 202 rewrites it. External facts: R2 and R6 from plan 200 §5.
> Ships: packages/studio/src/components/device-control/DeviceControl.tsx

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | The window carries the handoff's own measurements, as literals, in one file | `h-[calc(100vh-48px)]`, `max-h-[640px]`, `rounded-window`, `shadow-window`, `bg-panel`, `border-border-2`, `w-[52px]`, `w-[274px]`, `h-11`, `h-10`, `w-[306px]` | `rg -n -e "calc\(100vh-48px\)" -e "max-h-\[640px\]" -e "w-\[52px\]" -e "w-\[274px\]" -e "w-\[306px\]" packages/studio/src/components/device-control` prints at least one line for each of the five | [ ] |
| G2 | The width follows the handoff formula | `max(560 * (w/h) + 36, 380) + 52 + 274`; a 9:19.5 device gives **706** px and a 4:3 device gives **1108.67** px | `rg -n "Math.max\(560 \* ratio \+ 36, 380\) \+ 52 \+ 274" packages/studio/src/components/device-control/geometry.ts` prints 1 line; `bun -e "const w=(r)=>Math.max(560*r+36,380)+52+274;console.log(w(9/19.5).toFixed(2),w(4/3).toFixed(2))"` prints `706.00 1108.67` | [ ] |
| G3 | The window is draggable by either header strip and Escape resets the offset | drag offset state `{x,y}` reset to `{0,0}` on close; `document`-level `mousemove`/`mouseup`; `cursor-grab` on both strips | `rg -n "cursor-grab" packages/studio/src/components/device-control/DeviceControl.tsx` prints 2 lines; §7.4 smoke steps 3 and 4 | owner |
| G4 | The window is not a modal: no backdrop, and the page under it stays interactive | 0 scrim elements, 0 `aria-modal`, 0 focus trap | `rg -n -e "aria-modal" -e "bg-scrim" -e "DialogOverlay" -e "SheetOverlay" packages/studio/src/components/device-control` prints nothing; §7.4 smoke step 2 | [ ] |
| G5 | Retargeting keeps the selection when the new device is in it and collapses to it when it is not | `retargetSelection('b', ['a','b'])` = `['a','b']`; `retargetSelection('c', ['a','b'])` = `['c']` | `rg -n "export function retargetSelection" packages/studio/src/components/device-control/retarget.ts` prints 1 line (Studio has no tests, plan 200 §8.3); §7.4 smoke step 5 exercises both branches | owner |
| G6 | The hotkey table is one exported constant in `@enkaku/protocol` with 12 rows, no duplicate chord, and every `code` in plan 209's `DOM_CODES` | `DEVICE_CONTROL_HOTKEYS.length === 12`; 12 distinct `${alt}${shift}${code}` keys; every `code` satisfies `isDomCode` | `bun test packages/protocol/src/hotkeys.test.ts` passes its 3 tests | [ ] |
| G7 | Every rail button and every hotkey tooltip reads its chord from that table, never from a literal | 0 hand-written chord strings in the window | `rg -n -e "'Alt\+" -e '"Alt\+' -e "Cmd\+" packages/studio/src/components/device-control` prints nothing | [ ] |
| G8 | Focus is taken on click, framed, and released three ways | `ring-2 ring-accent` while focused; released by outside click, by `Alt+Shift+K`, and on close | `rg -n "ring-2 ring-accent" packages/studio/src/components/device-control/Cast.tsx` prints 1 line; §7.4 smoke step 6 | owner |
| G9 | While focus is held, every key is swallowed by the canvas, including Tab | `preventDefault()` and `stopPropagation()` on both `keydown` and `keyup`; `Tab` reaches the device as `input.keyEvent` | `rg -n "stopPropagation" packages/studio/src/components/device-control/use-cast.ts` prints at least 2 lines; §7.4 smoke steps 7 and 8 | owner |
| G10 | Typing a sentence appears character by character on the device | every character painted before the next key at 5 characters per second; no batching | §7.4 smoke step 7, lab device | owner |
| G11 | Tab moves focus on the device and Ctrl+A selects all | both observed in a form on the device | §7.4 smoke step 8, lab device | owner |
| G12 | The wheel scrolls at the pointer and Shift+wheel scrolls horizontally | a list moves on every wheel tick | §7.4 smoke step 9, lab device | owner |
| G13 | Right click is Back, middle click is Home, Ctrl+drag pinches | three gestures, three device reactions | §7.4 smoke step 10, lab device | owner |
| G14 | The clipboard crosses in both directions | copy on the device then `Alt+C` puts the text on the host clipboard; `Alt+V` pastes the host clipboard into a device field | §7.4 smoke step 11, lab device | owner |
| G15 | The Inspector tab captures a tree, selects a node in it, and draws that node's bounds on the snapshot | one `inspect.dump` per Capture; the selected node draws a `1.5px solid var(--accent)` rectangle over `var(--accent-a2)` | `rg -n "accent-a2" packages/studio/src/components/device-control/Inspector.tsx` prints 1 line; §7.4 smoke step 12 | owner |
| G16 | A job's compact detail stops a running job and re-runs a settled one | Stop posts `/api/jobs/:id/cancel`; Re-run posts `/api/actions/run-script` with `jobId` | `rg -n -e "/cancel" -e "runAction\('run-script'" packages/studio/src/components/device-control/DeviceJobs.tsx` prints 2 lines; §7.4 smoke step 13 | owner |
| G17 | With several devices selected the host banner appears and input fans out client side, with no server object | banner text `Mirroring input to N other selected devices · N+1 under control`; one `input.*` message per member; 0 `input.mirror` messages | `rg -n "input.mirror" packages/studio/src` prints nothing; §7.4 smoke step 14 | owner |
| G18 | The Files section lists a directory on the device and navigates into a folder | breadcrumb `sdcard / Download`; header `N items · X% free`; folders navigate | §7.4 smoke step 15, lab device | owner |
| G19 | The 12-tab device page is gone | directory absent | `test ! -d packages/studio/src/app/device` | [ ] |
| G20 | The old three-panel popup is gone | directory absent | `test ! -d packages/studio/src/components/device-popup` | [ ] |
| G21 | The route script no longer excuses `/device` | one fewer exemption | `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt` and exits 0 | [ ] |
| G22 | No control-vocabulary leftovers in the new surface | 0 matches | `rg -n -i -e "take control" -e "\blease" -e "\bholder\b" -e "\bassist" -e "co-control" -e "\bcluster" -e "\bpopup\b" -e "\bmodal\b" packages/studio/src/components/device-control` prints nothing | [ ] |
| G23 | The generic action set has exactly one definition | 12 entries, one file | `rg -n "GENERIC_ACTIONS" packages/studio/src --glob '!**/generic-actions.ts'` prints only import lines; `rg -c "id: '" packages/studio/src/lib/generic-actions.ts` prints `12` | [ ] |
| G24 | No Studio test file is added by this plan | 0 files | `rg --files packages/studio/src -g '*.test.ts' -g '*.test.tsx' \| wc -l` prints `0` | [ ] |
| G25 | The workspace typechecks | 0 errors | `bun run typecheck` exits 0 | [ ] |
| G26 | The input leg has a number in the strip | the stats strip's right-aligned figure is present and the tooltip repeats plan 203's honesty sentence | §7.4 smoke step 16 records the figure into §11 | owner |

## 1. Goals

1. Device Control is a floating window built to the handoff's measurements, opened by double-clicking a device, deliberately not a modal: no backdrop, and the Devices screen under it stays fully interactive (`README.md:232-234`).
2. The whole MVP 08 input model lives in it: the focus rule, the three keyboard layers, the full hotkey table as one exported constant shared by the tooltips, the pointer table (wheel, mouse buttons, pinch, live drag), and the clipboard in both directions.
3. The three columns exist exactly as drawn: the 52 px shortcut rail with its ten Phosphor buttons, the cast column with the 40 px stats strip and a cast surface at the device's exact aspect ratio, and the 274 px info column with the header, the `[i]` popover, the meta strip and the three compact tabs.
4. The three tabs are Actions (the generic action set, same order, same icons), Inspector (Snapshot, UI nodes, Node details) and Device (a container with a Jobs and a Files section).
5. Mirror returns as a client-side fan-out (MVP 15 §1): the host banner appears when several devices are selected, every `input.*` message is duplicated to each other member, each member gets its own control marker from plan 205's admission path, and there is no server-side mirror object of any kind.
6. The device page and its 12 tabs, and the old three-panel popup, are deleted, with `scripts/check-routes.ts` pruned so the exemption cannot rot (MVP 13 A.6, MVP 15 §1 row "Device page").
7. `LiveView`'s stream, decode, input and focus machinery becomes one hook that both this window and plan 214's Screens tile call, so there is exactly one cast implementation in Studio.

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The action dialogs behind the twelve rows (Run script, Install apk, Adb command, Upload file, Move group, Settings, Forget) and the DevicePicker as their first row | plan 216. This plan renders the rows and calls one `onAction(id, params?)` prop; the Devices screen owns the handler |
| The Jobs page, the run picker, the timeline and the artifacts grid; "Open full detail" is a `next/link` to `/jobs/detail?id=` and nothing more | plan 218 |
| The Devices screen itself: the table, the Screens grid, the group tabs, the discovery sheet, the marquee, the bulk pill | plan 214. This plan changes exactly two things there: the double-click handler calls `retargetSelection`, and the bulk menu imports `GENERIC_ACTIONS` |
| A server-side mirror object, a mirror group, a `mirror.*` or `input.mirror` message, or any grant | never. Plan 205 deleted them; MVP 15 §1 says the fan-out is client side, with no server object |
| A "Take control" affordance, a lease banner, an assist offer, a release countdown, in any form | never. Plan 205 deleted the model; `Do not` lines repeat this in §5 |
| New driver or scrcpy work: the UHID keyboard, `input.pinch`, `input.scroll`, `clipboard.changed` on the wire | plan 209 shipped all four; this plan only sends them |
| The inspector engine, its prewarm, its idle-wait configuration, `E_INSPECTOR_STARTING` on the server | plan 208; this plan renders the states it publishes |
| A first-party `ui-tree` engine and push-based `waitFor` | plans 221 and 222 |
| Recordings: the Record mode, the record panel, the recorder popover | deferred (MVP 15 §0.1.5); the code stays parked |
| The Console, saved commands, command runs | removed entirely by plan 207 (MVP 15 §0.1.4) |
| A cloud (node-owned) device's Device Control: the inspector and the shell-backed Files section refuse on a `nodeId` device | post-MVP (MVP 16 §1). The window renders, the Inspector and Files sections say why they cannot run |
| Settings for the hotkey modifier and the soft-keyboard-with-hardware preference (MVP 08 §2 Settings row) | plan 212 owns the settings schema; §9 Q1 and Q2 carry the two fields |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03)

**The window that exists.** `packages/studio/src/components/device-popup/DevicePopup.tsx` (1 560 lines) is the current device surface. Its own header says what it is not: `:124-126`, "`resize` and the drag affordance belong to the CONTAINER, never to an individual panel — so resizing (there is no drag-to-move yet) moves/resizes all three together." It is three independent bordered panels in a transparent container (`:118-122`), not one window; the container is `packages/studio/src/components/device-popup/DevicePopup.tsx:972`, `<div className="pointer-events-none fixed inset-x-[4vw] top-1/2 z-40 -translate-y-1/2 @container">`, and the resizable box is `:1037`, `className="pointer-events-auto mx-auto flex w-max max-w-full items-stretch gap-3 overflow-hidden resize-y @max-[600px]:w-full @max-[600px]:flex-col"`. It is mounted from the Devices screen at `packages/studio/src/app/page.tsx:1734`, `<DevicePopup deviceId={focusId} devices={devices ?? []} selectedIds={selectedIds} onClose={clearFocus} />`, driven by `?focus=<id>` (`app/page.tsx:729`). Its Escape rule is a `window` bubble-phase listener at `:686-691` and `:706-710`, documented as a three-claimant table at `:134-166`.

**The action list.** `packages/studio/src/components/device-popup/ActionsList.tsx:148-150` states the fixed order verbatim: "`Reconnect · Disconnect · [Move to the network…, USB only] · Install apk · Adb command · Run script · Wake/Sleep · Assist · Files · Jobs · Settings · Forget · Open full device page`, in that exact order." That list is not the handoff's generic action set and is replaced by it.

**The shortcut rail.** `packages/studio/src/components/device-popup/HardwareRail.tsx:75-83` draws nine buttons: Power, Volume up, Volume down, Mute, Back, Home, Recents, Sleep, Wake, plus `ClipboardButton` (`HardwareRail.tsx:6`, `import { ClipboardButton } from '@/components/device/ClipboardButton'`). The handoff's rail is ten buttons in a different order and swaps Sleep and Wake for Rotate and Brightness.

**The cast.** `packages/studio/src/components/LiveView.tsx` (1 333 lines) is the only cast in Studio. It owns: `stream.start`/`stream.stop` and the `video.frame` subscription (`:432-583`); the fps window (`:527-531`, `while (frameTimes.length > 0 && now - frameTimes[0]! > 3000) frameTimes.shift()` then `setFps(Number((frameTimes.length / 3).toFixed(1)))`); the staleness watchdog (`:806-824`, a 1 s interval writing `staleSec`); the input send path (`:685-713` `sendInputAction`, `:715-722` `onPointerDown`, `:725-735` `onPointerMove`, `:737-769` `onPointerUp`, `:857-889` `onKeyDown`, `:891-895` `sendKey`, `:839-855` `pasteFromClipboard`); and its chrome, which is everything else: the status readout row (`:988-1104`), the error, WebRTC-degrade, control-unavailable and text-notice banners (`:1106-1137`), the `hardware` rail (`:1207`), the nav and power rows plus the clipboard button (`:1310-1330`) and the instructional caption at `:1324-1328`, `'Click to tap, drag to swipe, type while the canvas is focused. Esc sends Back.'`. Its canvas is `:1155-1161`, `tabIndex={compact ? -1 : 0}` with `onKeyDown={compact ? undefined : onKeyDown}`: the `compact` keyboard disable MVP 13 A.8 assigns to this plan. Its three importers are `components/wall/WallTile.tsx:10`, `components/device/ScreenCard.tsx:4` and `components/device-popup/DevicePopup.tsx:24`.

Plans 203, 205, 206 and 209 have already rewritten the parts of that file this plan reuses: plan 203 §4.11 adds the latency estimator and the overlay, plan 205 step 205.11 deletes the `mirror` prop and every lease handler, plan 206 §4.9 deletes the wake panel and `session.progress`, plan 209 §4.13 replaces the pointer and key handlers with `input.touch`, `input.scroll` and `input.keyEvent` and deletes the 500 ms text debounce. Plan 209 §2 hands this plan, by name, "the focus frame, hotkey table (`Alt+H`, `Alt+C`, `Alt+V`, release chord), toolbar buttons, mouse buttons (right click → Back, middle click → Home), Ctrl/Alt+drag pinch gestures, the soft-keyboard hint and `OPEN_HARD_KEYBOARD_SETTINGS` toggle, the `compact` keyboard disable", and §4.13's closing line reads "The `compact` guards are untouched (plan 215 removes the keyboard one). Nothing here builds a focus frame or a hotkey."

**The inspector UI.** `packages/studio/src/components/InspectorPanel.tsx` (1 148 lines), signature at `:316-334`, props `{ deviceId, canUse, onTakeControl, takeControlDisabledReason, visible }`. It attaches with a 50 s budget at `:461`, `ws.request({ type: 'inspect.attach', id: newId(), payload: { deviceId } }, 50_000)`; dumps at `:572`, `ws.request({ type: 'inspect.dump', id: newId(), payload: { deviceId, requestId, screenshot: true } })`; reads the snapshot PNG off `CHANNEL.SNAPSHOT` at `:522`, `if (buf.length === 0 || buf[0] !== CHANNEL.SNAPSHOT) return`; detaches at `:495`, `ws.send({ type: 'inspect.detach', payload: { deviceId } })`; and follows with a self-scheduling poll gated by `shouldPoll` (`:176-186`, `:639-660`). Its node-detail field list is `:101-108` (`resourceId`, `text`, `desc`, `className`, `packageName`, `bounds`, `clickable`, `enabled`). Two props of its signature (`onTakeControl`, `takeControlDisabledReason`) are lease-era and plan 205 already reduces `canUse` to "the device is online".

**The jobs list.** `packages/studio/src/components/JobsList.tsx:185` is the shared table; `:205`, `if (filter?.deviceId) q.deviceId = filter.deviceId`; `:228`, `api(\`/api/jobs?${qs}\`, JobsPageResponseSchema)`; `:217`, `api(\`/api/jobs/${j.jobId}/cancel\`, JobCancelResponseSchema, { method: 'POST' })`; `:301`, a `next/link` to `/device?id=...` which this plan's deletion of that route invalidates. It is also used by `app/jobs/page.tsx:9`, `app/scripts/detail/page.tsx:42` and `app/batches/detail/page.tsx:44`, all owned by plans 217 and 218, so it stays.

**There is no on-device file browser.** `packages/studio/src/components/FilesPanel.tsx:79` is install, push and pull only: `:52-58` uploads a multipart artifact, `:139` installs it, `:161` pushes it, `:179` pulls one path. There is no directory listing route, no capability, and no WS message: `rg -n "files/list|listDir|readdir" packages/core/src/api packages/protocol/src/api` finds nothing, and `packages/core/src/capability/device-files.ts` exports exactly two capabilities, `device.push` (`:14`) and `device.pull` (`:30`). The handoff's Files section therefore needs a mechanism this plan chooses (D9).

**The device page.** `packages/studio/src/app/device/page.tsx:731-751` lists the twelve tabs: `control`, `jobs`, `monitor`, `crashes`, `terminal`, `files`, `network`, `agent`, `identity`, `logs`, `storage`, `settings`. Plan 213's `scripts/check-routes.ts` already names this plan as its owner: `docs/plans/213-mvp-studio-shell.md:1043`, `'/device': 'plan 215: Device Control is the device surface; the device page and its route go (MVP 15 §1)'`.

**What plans 203 to 213 leave for this plan to call.** `deviceState(info)` returning `'free' | 'controlled' | 'job' | 'offline' | 'warn'` in `packages/protocol/src/activity.ts` (plan 205 §12 moves it there out of Studio); `DeviceActivity`, `LastControl`, `device.activity` (plan 205 §4.1); `stream.started.substitute: 'wall'` and `stream.meta.quality` (plan 206 §4.x, quoted in §3.2 D6); `E_INSPECTOR_STARTING` (plan 208 §4.11); `DOM_CODES`, `KEY_TABLE`, `isDomCode`, `KeyMetaSchema` in `packages/protocol/src/keys.ts` and the four input messages (plan 209 §4.4, §4.5); `createLatencyEstimator`, `LatencySummary`, `LatencyOverlay` (plan 203 §4.9, §4.10); `runAction`, `runOnDevice`, `awaitOperation`, `ActionRefusedError` in `packages/studio/src/lib/actions.ts` (plan 207 §4.9); `useOverlay`, `registerOverlay` in `packages/studio/src/lib/overlays.ts` (plan 213 §4.9); `StatusDot`, `Badge`, `Tabs` with `variant="compact"`, `Popover`, `Tooltip`, `Button` with `size="icon-lg"`, and the Phosphor barrel `@enkaku/ui/icons` (plan 204 §4.5, §4.6).

### 3.2 Decisions

**D1. One window element, not three panels.** The handoff is explicit: one `position: fixed` box, centred by `top/left: 50%` plus a translate carrying the drag offset, `height: calc(100vh - 48px)`, `max-height: 640px`, `border-radius: 18px`, `box-shadow: 0 30px 80px #00000033`, `background: var(--panel)`, `border: 1px solid var(--border-2)` (`README.md:236-238`). The three-panel container and its `resize-y` handle go; the size is derived, not dragged.

**D2. Not a modal, and nothing about it is one.** No overlay element, no `aria-modal`, no focus trap, no `Dialog`. Escape is registered through plan 213's `useOverlay('window', true, close)` so the shell's single tiered listener owns the key, and the canvas's own `preventDefault()` (D4) is what makes Escape mean Back while the cast has focus, exactly the `defaultPrevented` rule `docs/plans/213-mvp-studio-shell.md` §4.9 rule 2 already states. Closing resets the drag offset to `{ x: 0, y: 0 }`, per `README.md:242`, "Escape closes it and resets the drag offset."

**D3. The width is a pure function of the live aspect ratio.** `README.md:240-241`: "**Width follows the device's screen aspect ratio**: `max(560 * (w/h) + 36, 380) + 52 + 274` px, so the cast column fits the panel height without overflowing." The ratio comes from the live stream (`stream.started`/`stream.meta` width and height), never from `DeviceInfo.screenW/screenH`, which goes stale on rotation. That is the same rule `LiveView.tsx:613-621` already states for its own sizing effect, and it is why a rotation resizes the window within the same render as the picture. Before the first frame the ratio falls back to `9 / 19.5`, giving 706 px.

**D4. The focus model is a property of the cast, and it is honest about the browser.** MVP 08 §1.2: "while Device Control has focus, every key goes to the device. Focus is taken by clicking the screen and shown by a visible frame; it is released by clicking outside, by the release chord, or when the modal closes. The browser never sees a key while focus is held, including Tab and browser shortcuts." Implementation: `tabIndex={0}` on the canvas; `focus()` on `pointerdown`; a `ring-2 ring-accent` frame while `document.activeElement` is the canvas; `preventDefault()` **and** `stopPropagation()` on `keydown` and `keyup`, which stops Tab moving focus, stops the page's own shortcuts, and stops the shell's Escape tier. What a web page cannot intercept, and this plan does not claim to: the browser's reserved chords (`Ctrl/Cmd+W`, `Ctrl/Cmd+T`, `Ctrl/Cmd+N`, `Ctrl/Cmd+Shift+Q`, F11 on some platforms) and the OS's own. `Alt+Shift+K` is the release chord; an outside `mousedown` blurs; unmount blurs and sends `releaseKeys` by sending `up` for every key still down, the discipline plan 209 §4.13 already put in `onBlur`.

**D5. The hotkey modifier default is Alt on every platform, and the table lives in `@enkaku/protocol`.** MVP 08 §1.2 asks for one table in the protocol package "so scripts and docs read the same list", and §5 leaves "Alt everywhere, or Cmd on macOS" open. This plan ships **Alt everywhere** as the default and records the macOS question as §9 Q1, because Cmd on macOS would swallow `Cmd+C`, `Cmd+V` and `Cmd+A`, which are three of the four keyboard behaviours MVP 08 §4 lists as acceptance ("Ctrl+A selects all", "copy on the device"). The one modifier chord that is not `Alt` is plan 209's existing paste chord, `Ctrl/Cmd+V`, which pastes the host clipboard: it is kept exactly as 209 shipped it and is listed in the table as a second binding of the same action.

**D6. The stats strip states the substitution instead of hiding it.** Plan 206 §4.9 says, of `stream.started.substitute`: "no UI in this plan (plan 215 adds the sharpness readout)". While `substitute === 'wall'` the codec cell reads `H.264 · wall` with the tooltip "A sharper picture is starting. This is the Screens stream meanwhile."; on `stream.meta` carrying `quality: 'control'` it returns to `H.264`. When `degradedReason === 'control_encoder_unavailable'` it stays `H.264 · wall` with the tooltip "This device cannot run a second encoder, so Device Control shows the Screens stream." The dot and the word "Streaming" never change: the picture is live in all three cases, and a degrade that is announced is not an error (`docs/design.md`'s rule, and plan 206 §8's own row).

**D7. The strip's latency figure is a sum of plan 203's medians, and it says so.** The handoff draws a right-aligned "524 ms". The only number Studio can produce is the sum of the four legs plan 203's estimator measures (`deviceToHost`, `hostToBrowser`, `decode`, `decodeToPaint`), each of the first two anchored to the fastest frame seen. The cell renders `${Math.round(sum)} ms`, or `–` while either offset is still estimating, and its tooltip carries plan 203's own caption sentence verbatim: "device→host and host→browser are relative to the fastest frame seen, not absolute. Glass-to-glass needs a camera." The full nine-row overlay (plan 203 §4.10, plus plan 209's `input (host)` row) stays available on the cast surface behind the same `latencyOverlay` preference.

**D8. One cast, called from two places.** `LiveView.tsx`'s stream, decode, estimator, staleness, pointer, wheel, key, focus and clipboard machinery moves into one hook, `packages/studio/src/components/device-control/use-cast.ts`. `LiveView.tsx` keeps its path and its export name (so plan 214's Screens tile keeps compiling) and shrinks to the tile: the hook in read-only mode, the canvas, and the tile's own centre text. `device-control/Cast.tsx` calls the same hook with input and focus on and draws the handoff's stats strip and cast surface. Duplicating a second stream lifecycle for the window would be two watchdogs, two estimators and two `stream.start` paths per device, which is the exact defect plan 206 removes on the server.

**D9. The Files section runs through plan 207's `adb` action, not a new route.** There is no directory-listing API (§3.1) and building one is core work no MVP document assigns. Plan 207 ships `POST /api/actions/adb` with a per-device `detail` of `{ exitCode, stdout, stderr, truncated, durationMs }` (`docs/plans/207-mvp-actions-api-and-groups.md:412`) and `runOnDevice` already polls the operation to `done`. One command per navigation returns both the listing and the free space:

```
ls -lA -- '<path>'; echo '@@enkaku-df@@'; df -k '<path>' | tail -n 1
```

Toybox `ls -l` prints eight whitespace-separated fields before the name (mode, links, user, group, size, date, time, name), so the parser splits with a limit of 8 and treats the eighth chunk as the name, cutting a symlink at `" -> "`. `df -k` line 1 field 5 is the used percentage; "X% free" is `100 - used`. The cost is one activity marker of kind `command` and one operation poll per navigation, which is the honest price of not inventing a route in a Studio plan.

**D10. The Inspector tab captures on demand; it does not follow.** The handoff draws Snapshot with a **Capture** action, a node tree and node details. There is no follow toggle, no history strip and no selector-candidate testing: those belong to the script-authoring surface, not to a 274 px column. `inspect.attach` runs once when the tab is first shown (plan 208 made attach a no-op on a running engine, so the cost is a round trip), `inspect.dump` with `screenshot: true` runs on Capture and on the first attach, and `inspect.detach` runs when the window closes. `E_INSPECTOR_STARTING` renders as the sentence the core sends plus a Retry, never as a failure: plan 208 §4.11 makes it a distinct code precisely so a client can say "still starting" instead of "unavailable".

**D11. The mirror is a loop over ids in the send function, and nothing else.** MVP 15 §1: "Mirror returns as a client-side fan-out of `input.*` to the selection (exactly what MVP 07 §1.4 and MVP 08 §1.5 anticipated), with no grants and no server object: each member simply gets a control marker (MVP 04)." So `use-cast`'s sender takes a `targets: readonly string[]` and sends the identical payload once per target, host first, with the host's own `deviceId` swapped per message. Coordinates are normalised (`NormPointSchema`), so no geometry translation is needed and nothing has to know another device's screen size, exactly the reasoning `LiveView.tsx:680-683` already records. Two things never fan out: `clipboard.set` (the rule plan 91 §3.10 established and MVP 08 §1.3 keeps, since a paste is one operator's private text) and every REST action (they take their own target, MVP 07). Plan 205's admission path gives each member a control marker for free, because a control marker is created by the first `input.*` from a client.

**D12. Retargeting is a pure function, exported, called by the Devices screen.** `README.md:243-245`: "Double-clicking a **different** device switches the window to it. If that device was already part of the selection the selection is kept (host just moves); if it was not, the selection collapses to just that device." The rule belongs where the double-click is, which is plan 214's screen, so this plan ships the rule as `retargetSelection(next, selected)` and changes the one call site.

**D13. The state dot's tooltip is derived from the activity list, in the Screens view's wording.** The handoff gives two wordings for the same dot: the Device Control header's ("Job running · tiktok_warmup.py", "Held 4:55", "Free · idle", "No link", `README.md:262-265`) and the Screens card's ("Job · tiktok_warmup.py", "Controlled by rz@studio", "Free · idle", "Last seen 12m ago", `README.md:157-160`). "Held" is forbidden vocabulary (plan 200 §2.4) and the two must not disagree, so the Screens wording wins and one function produces both. The handoff's own rule stands either way: "the state is expressed by the dot, never by a stray text label" (`README.md:265`).

**D14. The rail's Rotate and Brightness use what already exists.** Rotate cycles `settings.prep.rotation` through `lock-portrait → lock-landscape → device` with the same call `components/device/RotationQuickAction.tsx:119` already makes, `api(\`/api/devices/${deviceId}\`, DeviceResponseSchema, { method: 'PATCH', json: { settings: nextSettings } })`. Brightness has no implementation anywhere in the repo, so it runs one `adb` action that reads and writes in a single shell round trip (§4.6), cycling 32 → 128 → 255. The three panel hotkeys (`Alt+N`, `Alt+M`, `Alt+O`) likewise run `cmd statusbar expand-notifications` / `expand-settings` / `collapse` through the `adb` action rather than adding three WS messages MVP 08 §2 never asked for.

**D15. The handoff's rail wins over MVP 08 §1.4's toolbar list.** MVP 15 §0 reconciles them already ("a 52 px hardware shortcut rail (Power, Volume, Mute, Back, Home, Recents, Rotate, Brightness, Clipboard)"). The MVP 08 items with no rail button are placed as follows, and nothing is silently dropped:

| MVP 08 §1.4 item | Where it lands |
|---|---|
| Back, Home, Recents, Power, Volume up, Volume down, Rotate | rail buttons 5, 6, 7, 1, 2, 3, 8 |
| Paste, Copy | the Clipboard rail button's popover (button 10), and `Alt+V` / `Alt+C` |
| Screenshot | the Actions tab (`screenshot`, one of the twelve) |
| Keep awake | the Actions tab (`sleep` and its inverse are the generic verbs; MVP 15 §1 "Wake is implicit under MVP 11") |
| Fullscreen | `Alt+F` on the cast surface; no button, because the rail is ten buttons in the handoff |
| Keyboard (soft-keyboard toggle) | §9 Q2: the preference is per device and belongs to plan 221's guest agent work; the window shows nothing for it |
| Record | deferred with recordings (MVP 15 §0.1.5) |
| Show/hide the toolbar (`Alt+K`) | dropped: the rail is always visible, so the chord would toggle nothing |

## 4. Technical design

### 4.1 The handoff, quoted

`docs/mvp/design_handoff_enkaku_openpf/README.md:230-293`, in full, as the specification this section implements:

> ## Floating window: Device Control
>
> Opened by **double-clicking** a device (table row or card). Deliberately **not a modal**: there is no
> backdrop and the page stays fully interactive — the operator can keep scrolling, filtering, and
> selecting while it is open.
>
> - `position: fixed`, centered via `top/left: 50%` + a translate that also carries the drag offset;
>   `height: calc(100vh - 48px)`, `max-height: 640px`, `border-radius: 18px`,
>   `box-shadow: 0 30px 80px #00000033`, `background: var(--panel)`, `border: 1px solid var(--border-2)`.
> - **Draggable** by either header strip (`cursor: grab`; mousemove/mouseup on `document`).
> - **Width follows the device's screen aspect ratio**: `max(560 * (w/h) + 36, 380) + 52 + 274` px, so the
>   cast column fits the panel height without overflowing.
> - Escape closes it and resets the drag offset.
> - Double-clicking a **different** device switches the window to it. If that device was already part of
>   the selection the selection is kept (host just moves); if it was not, the selection collapses to
>   just that device.
>
> **Three columns.**
>
> 1. **Shortcut rail** — `width: 52px`, `background: var(--panel-2)`. 34×34 buttons, `border-radius: 10px`,
>    16px icons, `var(--dim)`: Power, Volume up, Volume down, Mute, Back, Home, Recents, Rotate,
>    Brightness, Clipboard (`ph-power`, `ph-speaker-high`, `ph-speaker-low`, `ph-speaker-slash`,
>    `ph-caret-left`, `ph-circle`, `ph-square`, `ph-clock-counter-clockwise`, `ph-sun`, `ph-clipboard`).
>
> 2. **Cast column** — `background: var(--muted)`. A 40px stats strip on `var(--panel)` (all items
>    `flex: none`, `white-space: nowrap`): green dot + "Streaming", "5.3 fps", resolution (`Geist Mono`),
>    "H.264", and right-aligned "524 ms". Below, the cast surface: the device's exact aspect ratio,
>    `border-radius: 18px`, `border: 1px solid var(--border-2)`, `box-shadow: 0 8px 24px #00000014`.
>    Live = clean surface labelled "Android cast · 1080x2400"; offline/unauthorized = stripe pattern with
>    the state text. **No instructional caption under the cast** — hints live in the drag tooltip only.
>
> 3. **Info column** — `width: 274px`.
>    - Header (44px): state dot · `#11` (11px `var(--faint)`) · **DEV-011** (14px/600, uppercased) ·
>      spacer · **[i]** info button · ✕ close. Hovering the dot shows the same state tooltip as the cards
>      ("Job running · tiktok_warmup.py", "Held 4:55", "Free · idle", "No link") — the state is expressed
>      by the dot, never by a stray text label.
>    - **[i] popover** (306px): "This device" — cluster, stable id, endpoint, api level, screen, density,
>      guest agent — then "Active engines" — transport `ADB (USB)`, video `scrcpy (H.264, low latency)`,
>      input `scrcpy UHID (hardware-like)`, inspection `UI server (persistent)` — and a **Change** button.
>    - Meta strip: battery (colored, 500), temperature, Android version.
>    - **Compact tabs** (chips, `padding: 4px 10px`, `border-radius: 7px`, 12px; active
>      `background: var(--accent-soft)`, `color: var(--accent)`): **Actions · Inspector · Device**.
>      They are intentionally small — a full segmented control ate the space the content needs.
>    - **Actions** — the generic action set, same order, same icons.
>    - **Inspector** — three stacked parts: **Snapshot** (a small 9:19.5 thumbnail with the selected
>      node's bounds drawn as a `1.5px solid var(--accent)` / `var(--accent-a2)` rectangle, plus a
>      **Capture** action), **UI nodes** (an indented, clickable tree — 12px indent per depth,
>      `Geist Mono` 11.5px, selected row `var(--accent-soft)`), and **Node details** (class, resource id,
>      text, bounds, clickable, enabled, package, depth).
>    - **Device** — a generic container tab, not one tab per feature. Inside, a small chip switch selects
>      the section: **Jobs** or **Files** (more sections can be added here without touching the tab bar).
>      - *Jobs*: the device's jobs, unfiltered (no All/Running chips — that belongs on the Jobs page).
>        Each row: state dot + script name + a sub-line (step and %, queue position, or finish time).
>        Opening one shows a **compact** detail — state badge beside the name, progress bar when running,
>        then just Job id / Trigger / Started / Duration — with **Stop | Cancel | Re-run** plus **Logs**
>        buttons and an **Open full detail** button that navigates to the Jobs page for that job.
>      - *Files*: an on-device browser — breadcrumb (`sdcard / Download`, segments clickable),
>        "N items · X% free", **Upload file**, then rows with type icons (`ph-folder-simple` amber,
>        `ph-image`, `ph-package`, `ph-film-slate`, `ph-file`), name, size · time, and a trailing caret
>        (folders) or `ph-dots-three` (files). Folders navigate.
>    - When more than one device is selected, a **host banner** sits under the meta strip:
>      `background: var(--warn-soft)`, `border-radius: 10px`, `ph-broadcast` + "**Host device**" +
>      "Mirroring input to N other selected devices · N+1 under control". The double-clicked device is
>      the host; input mirrors to the rest of the selection.

Two words in that text are forbidden vocabulary and are translated, not copied: "cluster" becomes **group** (MVP 15 §0.1.3) and "Held 4:55" becomes the Screens view's own "Controlled by ..." (D13). Everything else is implemented as written.

### 4.2 File structure

```
packages/protocol/src/
  hotkeys.ts                                        NEW  DEVICE_CONTROL_HOTKEYS, HotkeyId, chordLabel
  hotkeys.test.ts                                   NEW  3 tests (the only test in this plan)
  index.ts                                          CHANGED  export * from './hotkeys'
packages/studio/src/
  components/device-control/
    DeviceControl.tsx                               NEW  the window (the shipped artefact)
    geometry.ts                                     NEW  castWidthPx, windowWidthPx
    retarget.ts                                     NEW  retargetSelection
    use-cast.ts                                     NEW  the stream, decode, input and focus hook
    Cast.tsx                                        NEW  the cast column: stats strip + cast surface
    ShortcutRail.tsx                                NEW  the 52px rail, ten buttons
    ClipboardPopover.tsx                            NEW  the rail's Clipboard button popover
    InfoPopover.tsx                                 NEW  the 306px [i] popover
    DeviceActions.tsx                               NEW  the Actions tab
    Inspector.tsx                                   NEW  the Inspector tab
    DeviceTab.tsx                                   NEW  the Device tab container + chip switch
    DeviceJobs.tsx                                  NEW  the Jobs section and the compact detail
    DeviceFiles.tsx                                 NEW  the Files section
    files-parse.ts                                  NEW  the `ls -lA` / `df -k` parser
    state-tooltip.ts                                NEW  the dot's tooltip sentence
  lib/generic-actions.ts                            NEW  GENERIC_ACTIONS, the one list
  components/LiveView.tsx                           CHANGED  becomes the Screens tile over use-cast
  app/page.tsx                                      CHANGED  renders DeviceControl; double-click calls retargetSelection
  app/device/                                       DELETED  the 12-tab page
  components/device-popup/                          DELETED  the whole directory
  components/device/ScreenCard.tsx                  DELETED
  components/device/DeviceHeader.tsx                DELETED
  components/device/ClipboardButton.tsx             DELETED
  components/InspectorPanel.tsx                     DELETED
  components/FilesPanel.tsx                         DELETED
scripts/check-routes.ts                             CHANGED  the '/device' PENDING_REMOVAL row is deleted
```

### 4.3 `packages/protocol/src/hotkeys.ts` (new, complete)

```ts
import { z } from 'zod'
import { DomCodeSchema, type DomCode } from './keys'

/**
 * The Device Control hotkey table (MVP 08 §1.2), in the protocol package so
 * the window's tooltips, the docs and any future script helper read one list
 * (MVP 08 §1.2: "the map is one table in `@enkaku/protocol` so scripts and
 * docs read the same list").
 *
 * The modifier is Alt on every platform (plan 215 §3.2 D5). Cmd on macOS is
 * §9 Q1: it would swallow Cmd+A, Cmd+C and Cmd+V, three of the four
 * behaviours MVP 08 §4 lists as acceptance for the passthrough layer.
 *
 * `Escape` is the one row with no modifier, and the one row that only fires
 * while the cast has focus: it is Back on the device, which is why the
 * window's own Escape (close) is left to the shell's tiered listener and
 * never fires while the canvas has the key (plan 215 §3.2 D2, D4).
 */
export const HOTKEY_IDS = [
  'back',
  'home',
  'recents',
  'power',
  'rotate',
  'notifications',
  'settings-panel',
  'collapse-panels',
  'fullscreen',
  'clipboard-copy',
  'clipboard-paste',
  'release-focus',
] as const
export const HotkeyIdSchema = z.enum(HOTKEY_IDS)
export type HotkeyId = (typeof HOTKEY_IDS)[number]

export interface Hotkey {
  id: HotkeyId
  /** `KeyboardEvent.code`; the same vocabulary `KEY_TABLE` uses (plan 209 §4.4). */
  code: DomCode
  alt: boolean
  shift: boolean
  /** What the operator is told this does. Used verbatim in the tooltip. */
  label: string
}

export const DEVICE_CONTROL_HOTKEYS: readonly Hotkey[] = [
  { id: 'back', code: 'Escape', alt: false, shift: false, label: 'Back' },
  { id: 'home', code: 'KeyH', alt: true, shift: false, label: 'Home' },
  { id: 'recents', code: 'KeyS', alt: true, shift: false, label: 'Recent apps' },
  { id: 'power', code: 'KeyP', alt: true, shift: false, label: 'Power' },
  { id: 'rotate', code: 'KeyR', alt: true, shift: false, label: 'Rotate' },
  { id: 'notifications', code: 'KeyN', alt: true, shift: false, label: 'Notifications' },
  { id: 'settings-panel', code: 'KeyM', alt: true, shift: false, label: 'Quick settings' },
  { id: 'collapse-panels', code: 'KeyO', alt: true, shift: false, label: 'Collapse panels' },
  { id: 'fullscreen', code: 'KeyF', alt: true, shift: false, label: 'Fullscreen' },
  { id: 'clipboard-copy', code: 'KeyC', alt: true, shift: false, label: 'Copy the device clipboard' },
  { id: 'clipboard-paste', code: 'KeyV', alt: true, shift: false, label: 'Paste to the device' },
  { id: 'release-focus', code: 'KeyK', alt: true, shift: true, label: 'Release the keyboard' },
]

const CODE_LABEL: Partial<Record<DomCode, string>> = { Escape: 'Esc' }

/** `Alt+Shift+K`, `Esc`. One renderer, so a tooltip can never disagree with the table. */
export function chordLabel(h: Hotkey): string {
  const parts: string[] = []
  if (h.alt) parts.push('Alt')
  if (h.shift) parts.push('Shift')
  parts.push(CODE_LABEL[h.code] ?? h.code.replace(/^Key/, ''))
  return parts.join('+')
}

export function hotkeyFor(e: { code: string; altKey: boolean; shiftKey: boolean }): Hotkey | null {
  return DEVICE_CONTROL_HOTKEYS.find((h) => h.code === e.code && h.alt === e.altKey && h.shift === e.shiftKey) ?? null
}

export { DomCodeSchema }
```

Exported from `packages/protocol/src/index.ts` by name (`HOTKEY_IDS`, `HotkeyIdSchema`, `DEVICE_CONTROL_HOTKEYS`, `chordLabel`, `hotkeyFor`, types `HotkeyId`, `Hotkey`). `export-uniqueness.test.ts` requires the names to be unique across the package; none exists today.

`packages/protocol/src/hotkeys.test.ts` (the only test this plan writes; see §7.1 for why it is in scope):

| Test name | Asserts |
|---|---|
| `the table has one row per hotkey id and no duplicate chord` | `DEVICE_CONTROL_HOTKEYS.length === HOTKEY_IDS.length` and `new Set(rows.map((h) => \`${h.alt}:${h.shift}:${h.code}\`)).size === 12` |
| `every code is a code plan 209's key table can send` | `DEVICE_CONTROL_HOTKEYS.every((h) => isDomCode(h.code))` |
| `chordLabel renders the modifier order Alt then Shift` | `chordLabel(byId('release-focus')) === 'Alt+Shift+K'`; `chordLabel(byId('back')) === 'Esc'` |

### 4.4 `packages/studio/src/components/device-control/geometry.ts` (new, complete)

```ts
/**
 * The handoff's own width formula (README.md:240-241): the cast column is
 * sized from the device's live aspect ratio so it fits the 640px window
 * height without overflowing, then the 52px rail and the 274px info column
 * are added. Derived from the LIVE stream size, never from
 * `DeviceInfo.screenW/screenH`, which goes stale on rotation (plan 215 §3.2 D3).
 */
export const RAIL_WIDTH_PX = 52
export const INFO_WIDTH_PX = 274
/** The cast column's own floor and the height budget the 560 comes from. */
export const CAST_MIN_WIDTH_PX = 380

/** `max(560 * (w/h) + 36, 380)`. */
export function castWidthPx(ratio: number): number {
  return Math.max(560 * ratio + 36, CAST_MIN_WIDTH_PX)
}

/** The whole window: `max(560 * (w/h) + 36, 380) + 52 + 274`. */
export function windowWidthPx(ratio: number): number {
  return Math.max(560 * ratio + 36, 380) + 52 + 274
}

/** Before the first frame: a 9:19.5 phone, which resolves to the 380px floor and a 706px window. */
export const DEFAULT_RATIO = 9 / 19.5
```

`windowWidthPx` carries the formula as one literal expression so G2's `rg` can match it; `castWidthPx` is the same arithmetic named for the column and is what the cast surface's `max-width` uses.

### 4.5 `packages/studio/src/components/device-control/use-cast.ts` (new)

The whole of `LiveView`'s machinery, as a hook. Signature:

```ts
export interface CastStats {
  streaming: boolean
  connected: boolean
  fps: number
  width: number
  height: number
  codec: 'png' | 'h264'
  /** Plan 206: the wall encoder is standing in while the control encoder starts. */
  substitute: boolean
  /** Plan 206: this device cannot run a second encoder; `substitute` is permanent. */
  encoderUnavailable: boolean
  /** Seconds since the last frame; the staleness watchdog (LiveView.tsx:806-824). */
  staleSec: number
  /** Sum of plan 203's four medians, or null while either offset is estimating (plan 215 §3.2 D7). */
  latencyMs: number | null
  summary: LatencySummary | null
  /** `stream.ended`'s reason, or null. */
  stopped: string | null
  error: string | null
  notice: string | null
}

export interface UseCastOptions {
  deviceId: string
  quality: Quality
  /** `false` for the Screens tile: no pointer, no wheel, no keyboard, no focus. */
  interactive: boolean
  /**
   * Every device this canvas drives. `[deviceId]` for one device; the host
   * first followed by every other selected device for the mirror fan-out
   * (plan 215 §3.2 D11). `clipboard.set` never uses it.
   */
  targets: readonly string[]
  /** Ask for a fresh keyframe on a false→true transition (LiveView.tsx:590-596). */
  active?: boolean
  latencyOverlay?: boolean
  /** The window's own rotate action (§4.7), so the `rotate` hotkey and the rail button run one code path. */
  onRotate?: () => void
}

export interface UseCast {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  stats: CastStats
  focused: boolean
  /** Bind onto the `<canvas>`: pointer, wheel, key, focus and blur. */
  canvasProps: React.HTMLAttributes<HTMLCanvasElement> & { tabIndex: number }
  /** `input.key` to every target. Used by the rail and by the hotkey table. */
  sendKey: (keycode: number) => void
  /** Reads the browser clipboard and pastes it to the HOST device only. */
  pasteFromClipboard: () => Promise<void>
  /** The last `clipboard.changed` this device pushed, for Alt+C. */
  deviceClipboard: string | null
  copyDeviceClipboard: () => Promise<void>
  releaseFocus: () => void
  requestFullscreen: () => void
  retry: () => void
}

export function useCast(opts: UseCastOptions): UseCast
```

What moves in, verbatim in behaviour, from `LiveView.tsx` as plans 203, 205, 206 and 209 leave it:

| From | What |
|---|---|
| `:409-583` | the `stream.start` effect, the `video.frame` binary subscription, `stream.meta`, `stream.ended`, the reconnect resubscribe |
| `:527-531` | the 3 second fps window |
| `:806-824` | the 1 second staleness interval writing `staleSec` |
| plan 203 §4.11 | `createLatencyEstimator`, `noteSeqGap`, `noteKeyframeRequest`, the 500 ms summary tick |
| plan 209 §4.13 | `pointersRef`/`slotFor`/`sendTouch`, the wheel listener with `{ passive: false }`, `onKeyDown`/`onKeyUp`/`onBlur`, `pasteFromClipboard` |
| `:590-596` | the visibility keyframe |

What is new in the hook, and only in the hook:

1. **The fan-out.** Every `ws.send` of an `input.*` message goes through one private `sendInput(payload)` that loops `for (const id of opts.targets) ws.send({ type, payload: { ...payload, deviceId: id } })`. `clipboard.set` and `clipboard.get` call `ws.request` with `opts.deviceId` directly and are not routed through it (D11).
2. **The focus model** (D4): `focused` state driven by `focus`/`blur` on the canvas; `onPointerDown` calls `e.currentTarget.focus()`; `keydown`/`keyup` call `preventDefault()` and `stopPropagation()` before anything else when `interactive && focused`; a `mousedown` listener on `document` (capture phase) blurs the canvas when the target is outside it; `releaseFocus()` blurs; unmount blurs.
3. **The hotkeys** (D5): inside `onKeyDown`, after `preventDefault`, `const hk = hotkeyFor(e)`; when it is non-null the hook runs the action for `hk.id` and returns without sending a key event. The paste chord `(e.metaKey || e.ctrlKey) && e.code === 'KeyV'` keeps plan 209's behaviour and is checked first.

| `hk.id` | Action |
|---|---|
| `back` | `sendKey(KEYCODES.BACK)` (only while focused; this is the `Escape` row) |
| `home` | `sendKey(KEYCODES.HOME)` |
| `recents` | `sendKey(KEYCODES.APP_SWITCH)` |
| `power` | `sendKey(KEYCODES.POWER)` |
| `rotate` | `opts.onRotate?.()` (the window passes the PATCH from §4.6) |
| `notifications` / `settings-panel` / `collapse-panels` | `runOnDevice('adb', id, { cmd })` per target, `cmd` = `cmd statusbar expand-notifications` / `expand-settings` / `collapse` |
| `fullscreen` | `requestFullscreen()` on the canvas's parent |
| `clipboard-copy` | `copyDeviceClipboard()` |
| `clipboard-paste` | `pasteFromClipboard()` |
| `release-focus` | `releaseFocus()` |

4. **The pointer table** (MVP 08 §1.1), completing what plan 209 left: on `pointerdown`, `e.button === 2` sends `input.key BACK` and returns; `e.button === 1` sends `input.key HOME` and returns; `contextmenu` on the canvas is `preventDefault()`ed so the right button reaches the handler. `(e.ctrlKey || e.metaKey || e.altKey) && e.button === 0` starts a **pinch** drag instead of a touch stream: the origin is the canvas centre for Ctrl/Cmd and the drag's start point for Alt, and on `pointerup` one `input.pinch` is sent with `center`, `scaleFrom` = the start radius and `scaleTo` = the end radius, each expressed as a fraction of `min(width, height)` and clamped to `0.02..0.5` by plan 209's schema.
5. **`clipboard.changed`** (plan 209 §4.5, D10 there): the message subscription stores the last value in `deviceClipboard`; `copyDeviceClipboard()` writes it with `navigator.clipboard.writeText`, which needs a user gesture, which the hotkey is (MVP 08 §1.3).

### 4.6 `DeviceControl.tsx`, the window shell

```tsx
'use client'

/**
 * Device Control (MVP 08, design handoff README.md:230-293). A floating
 * window over the Devices screen, opened by double-clicking a device.
 *
 * Deliberately not a modal: no backdrop, no focus trap, no `aria-modal`, and
 * the screen underneath stays live and interactive. Escape is registered
 * through the shell's tiered listener (`lib/overlays.ts`), so a popover
 * inside the window closes before the window does, and the cast's own
 * `preventDefault()` is what makes Escape mean Back while the picture has
 * the keyboard.
 */
export function DeviceControl({ deviceId, selectedIds, onClose, onRetarget, onAction }: {
  deviceId: string
  /** The Devices screen's selection. The host is `deviceId`; the rest are mirror members (§4.12). */
  selectedIds: readonly string[]
  onClose: () => void
  /** Plan 216 wires the dialogs; until then the Devices screen's own bulk handler runs. */
  onAction: (id: GenericActionId, params?: Record<string, unknown>) => void
  onRetarget?: (deviceId: string) => void
}) {
```

Structure and the exact classes (Tailwind v4 names from plan 204 §4.3; arbitrary values only for sizes, never for colours):

| Element | Classes / style | Handoff line |
|---|---|---|
| root | `fixed left-1/2 top-1/2 z-50 flex h-[calc(100vh-48px)] max-h-[640px] overflow-hidden rounded-window border border-border-2 bg-panel shadow-window` plus `style={{ width: windowWidthPx(ratio), transform: \`translate(calc(-50% + ${drag.x}px), calc(-50% + ${drag.y}px))\` }}` | `:236-238`, `:240-241` |
| rail | `flex w-[52px] shrink-0 flex-col items-center gap-1 bg-panel-2 py-2` | `:249-250` |
| cast column | `flex min-w-0 flex-1 flex-col bg-muted` | `:257` |
| stats strip | `flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 text-meta text-dim [&>*]:shrink-0 [&>*]:whitespace-nowrap` | `:257-259` |
| info column | `flex w-[274px] shrink-0 flex-col border-l border-line` | `:266` |
| info header | `flex h-11 shrink-0 cursor-grab items-center gap-2 border-b border-line px-3` | `:267-268` |

**Drag.** Both header strips (the stats strip and the info header) carry `cursor-grab`, `onMouseDown={startDrag}` and `data-drag-handle`. `startDrag` records `{ mx: e.clientX - drag.x, my: e.clientY - drag.y }` and adds `mousemove` and `mouseup` listeners on `document` (`README.md:239`); `mouseup` removes them. The stats strip's own children are `pointer-events-none` except the codec and latency cells' tooltip triggers, so a drag started on the strip is never eaten by a readout. `title` on the handles is the drag tooltip the handoff reserves for hints: `Drag to move. Double-click another device to switch this window to it.`

**Escape and close.** `useOverlay('window', true, close)` where `close()` sets `drag` to `{ x: 0, y: 0 }` and calls `onClose()`. Nothing else in this file listens on `document` for a key.

**Ratio.** `const ratio = stats.width > 0 ? stats.width / stats.height : DEFAULT_RATIO`, from `useCast`'s stats, so a rotation resizes the window in the same render as the picture (D3).

**Retarget.** The window does not watch for double-clicks; the Devices screen does. `onRetarget` exists so the window can be told which device it now shows; in practice plan 214's screen re-renders `DeviceControl` with a new `deviceId`, and every hook keyed on `deviceId` restarts, which is the whole retarget.

### 4.7 `ShortcutRail.tsx`

Ten buttons, in the handoff's order, `Button` with `variant="ghost" size="icon-lg"` (34x34, radius 10, plan 204 §4.6) and `className="text-dim"`, icons at `className="size-4"` (16px). Each has a `Tooltip` whose content is `label` plus, when the action has a hotkey, ` · ${chordLabel(hk)}` read from `DEVICE_CONTROL_HOTKEYS`. No chord string is ever written in this file (G7).

| # | Icon (`@enkaku/ui/icons`) | Label | Action |
|---|---|---|---|
| 1 | `PowerIcon` | Power | `sendKey(KEYCODES.POWER)` |
| 2 | `SpeakerHighIcon` | Volume up | `sendKey(KEYCODES.VOLUME_UP)` |
| 3 | `SpeakerLowIcon` | Volume down | `sendKey(KEYCODES.VOLUME_DOWN)` |
| 4 | `SpeakerSlashIcon` | Mute | `sendKey(KEYCODES.VOLUME_MUTE)` |
| 5 | `CaretLeftIcon` | Back | `sendKey(KEYCODES.BACK)` |
| 6 | `CircleIcon` | Home | `sendKey(KEYCODES.HOME)` |
| 7 | `SquareIcon` | Recents | `sendKey(KEYCODES.APP_SWITCH)` |
| 8 | `ClockCounterClockwiseIcon` | Rotate | `PATCH /api/devices/:id` with `settings.prep.rotation` cycled `lock-portrait → lock-landscape → device` (D14) |
| 9 | `SunIcon` | Brightness | one `adb` action (below) |
| 10 | `ClipboardIcon` | Clipboard | opens `ClipboardPopover` |

Buttons 1 to 7 fan out to every target (they are `input.key`). Buttons 8, 9 and 10 act on the host device only: a rotation, a brightness write and a clipboard read are per-device REST or request/reply, not `input.*`, and MVP 07's rule is that anything that is not `input.*` takes its own target.

The Brightness command, one shell round trip that reads the current value before writing (D14):

```
b=$(settings get system screen_brightness 2>/dev/null); b=${b:-128};
if [ "$b" -lt 96 ]; then n=128; elif [ "$b" -lt 200 ]; then n=255; else n=32; fi;
settings put system screen_brightness_mode 0; settings put system screen_brightness $n; echo $n
```

sent as `runOnDevice('adb', deviceId, { cmd })`; the returned `detail.stdout` is shown in the button's tooltip as `Brightness ${n}` until the next press.

`ClipboardPopover.tsx`: a `Popover` (`w-[260px]`), `data-menu-root="1"`, `useOverlay('menu', open, close)`. It shows the device clipboard (`clipboard.get`, request/reply, or the last `clipboard.changed`) in a read-only mono block with a Copy button, and a `Textarea` plus a Send button that calls `ws.request({ type: 'clipboard.set', id: newId(), payload: { deviceId, text, paste: true } })`. It replaces `components/device/ClipboardButton.tsx`.

### 4.8 `Cast.tsx`, the cast column

**Stats strip**, left to right, every item `shrink-0 whitespace-nowrap`:

| Cell | Content | Empty state |
|---|---|---|
| dot + word | `<StatusDot state="free" className="size-2" />` when `streaming && staleSec < 5`, `state="offline"` otherwise; the word `Streaming`, or `No frames for {staleSec}s` when `staleSec >= 5`, or `Not streaming` | |
| fps | `{fps} fps` | `0.0 fps` |
| resolution | `<span className="font-mono">{width}x{height}</span>` | `–` |
| codec | `H.264`, or `H.264 · wall` while `substitute` or `encoderUnavailable` (D6), with the tooltip that case names; `screencap` when `codec === 'png'` | |
| latency | `ml-auto` + `{Math.round(latencyMs)} ms`, tooltip = plan 203's caption sentence (D7) | `–` |

**Cast surface**: a centred box at the device's exact aspect ratio, `rounded-window border border-border-2 shadow-cast overflow-hidden` (`README.md:256-257`, `border-radius: 18px`, `1px solid var(--border-2)`, `0 8px 24px #00000014` which plan 204 names `--shadow-cast`), `style={{ aspectRatio: \`${width} / ${height}\`, maxWidth: castWidthPx(ratio) - 36 }}`, holding the `<canvas>` at `h-full w-full object-contain bg-black outline-none` plus `ring-2 ring-accent` while `focused`.

Not live: the same stripe pattern the Screens card uses, `repeating-linear-gradient(135deg, var(--muted-2) 0 3px, transparent 3px 6px)` at `opacity: 0.7`, with the centre text `Disconnected` (11px `text-dim`) or `Unauthorized` (11px `text-warn`), matching `README.md:155-156`.

**No instructional caption anywhere under the cast** (`README.md:259`). `LiveView.tsx:1324-1328`'s sentence is deleted with the rest of its chrome (§10).

The latency overlay (plan 203 §4.10 as extended by plan 209 §4.14) renders inside the cast surface, absolutely positioned, only while the `latencyOverlay` preference is on.

### 4.9 The info column

**Header (44 px)**: `<StatusDot state={deviceState(device)} ring title={stateTooltip(device)} />` (plan 205's `deviceState`, plan 204's `StatusDot`), then `#{String(device.number ?? 0).padStart(2, '0')}` at `font-mono text-label text-faint`, then the name at `text-name font-semibold uppercase truncate`, then `flex-1`, then the `[i]` button (`InfoIcon`, `variant="ghost" size="icon-sm"`) and the close button (`XIcon`).

`state-tooltip.ts`, one function, the Screens view's wording (D13):

```ts
/** README.md:157-160's wording, which is also the Screens card's, so the two dots never disagree. */
export function stateTooltip(d: Pick<DeviceInfo, 'status' | 'activities' | 'lastSeen'>, now: number): string
```

| Condition | Sentence |
|---|---|
| a `job` or `workflow-job` activity | `Job · ${activity.label}` |
| a `control` activity | `Controlled by ${activity.actor.label}` |
| `status === 'quarantined'` | `Unauthorized` |
| `status === 'offline'` | `Last seen ${ago}` , or `No link` when `lastSeen` is null |
| otherwise | `Free · idle` |

**`[i]` popover** (`InfoPopover.tsx`, `w-[306px]`, `data-menu-root="1"`, `useOverlay('menu', open, close)`): two labelled sections and a button.

| Section | Rows |
|---|---|
| This device | group (`device.group?.name ?? 'No group'`), stable id (mono), endpoint (`device.connection.address` or the serial, mono), api level, screen (`${screenW}x${screenH}`), density, guest agent (from `fetchGuestAgentStatus(deviceId)`, `packages/studio/src/lib/api.ts:306`; `Not installed` when absent) |
| Active engines | transport, video, input, inspection, read from `DeviceDetail`'s `transport`, `display` (or `liveDisplay` when it differs, with the live one shown and the configured one in the tooltip), `input`, `inspection` |
| Change | `Button variant="outline" size="sm"` calling `onAction('settings')`, which plan 216's dialog answers |

The four engine rows keep the labels `components/device/DeviceHeader.tsx:100-105`'s `ENGINE_ROWS` already uses (`transport`, `video`, `input`, `inspection`), so the popover and the Settings dialog name the same four things.

**Meta strip**: one row, `text-meta`, battery percentage at `font-medium` coloured by the table's own thresholds (`<20%` `text-danger`, `<45%` `text-warn`, else `text-accent`, `README.md:133-134`), temperature (`text-danger` above 42 degrees), and the Android version.

**Host banner** (only while `selectedIds.length > 1`): under the meta strip, `flex items-center gap-2 rounded-button bg-warn-soft px-2.5 py-2 text-meta text-warn`, `<BroadcastIcon className="size-4" />`, `<b>Host device</b>`, then `Mirroring input to ${others} other selected devices · ${others + 1} under control`, where `others = selectedIds.length - 1` (`README.md:290-293`).

**Compact tabs**: `<Tabs>` with `<TabsList variant="compact">` and three triggers, `Actions`, `Inspector`, `Device` (plan 204 §4.6 gives `variant="compact"` exactly the handoff's `padding: 4px 10px`, `border-radius: 7px`, 12px and the active `accent-soft`/`accent`).

### 4.10 The Actions tab and the one action list

`packages/studio/src/lib/generic-actions.ts` (new, complete):

```ts
import { BroomIcon, CameraIcon, DownloadSimpleIcon, FolderSimpleIcon, GearIcon, ArrowsClockwiseIcon, MoonIcon, PlayIcon, PlugsIcon, TerminalIcon, TrashIcon, UploadSimpleIcon, type Icon } from '@enkaku/ui'
import type { ActionVerb } from '@enkaku/protocol'

/**
 * The generic action set (design handoff README.md:189-196): "The same twelve
 * actions appear in the bulk menu and in Device Control → Actions, so
 * selecting one device and selecting twenty behave identically."
 *
 * One list, one order, one set of icons. The bulk pill's menu and Device
 * Control's Actions tab both render THIS array; a second copy is the exact
 * defect the handoff's sentence rules out.
 */
export interface GenericAction {
  id: ActionVerb
  label: string
  icon: Icon
  /** Rendered in `text-danger`; the handoff paints only Forget this way. */
  danger?: boolean
}

export const GENERIC_ACTIONS: readonly GenericAction[] = [
  { id: 'reconnect', label: 'Reconnect', icon: ArrowsClockwiseIcon },
  { id: 'disconnect', label: 'Disconnect', icon: PlugsIcon },
  { id: 'install', label: 'Install apk', icon: DownloadSimpleIcon },
  { id: 'adb', label: 'Adb command', icon: TerminalIcon },
  { id: 'run-script', label: 'Run script', icon: PlayIcon },
  { id: 'screenshot', label: 'Screenshot', icon: CameraIcon },
  { id: 'sleep', label: 'Sleep', icon: MoonIcon },
  { id: 'set-group', label: 'Move group', icon: FolderSimpleIcon },
  { id: 'push', label: 'Upload file', icon: UploadSimpleIcon },
  { id: 'clear-cache', label: 'Clear cache', icon: BroomIcon },
  { id: 'settings', label: 'Settings', icon: GearIcon },
  { id: 'forget', label: 'Forget', icon: TrashIcon, danger: true },
]
export type GenericActionId = GenericAction['id']
```

`set-group` is MVP 15 §1's own mapping of the handoff's "Move group" onto MVP 07's verb list ("`move-group` is `set-cluster`", renamed `set-group` by plan 207's `ACTION_VERBS`). `push` is "Upload file".

`DeviceActions.tsx` renders one row per entry: `flex w-full items-center gap-2.5 rounded-button px-2.5 py-[9px] text-row hover:bg-muted` (the handoff's "Rows: `padding: 9px 10px`, `border-radius: 10px`, 13px, hover `background: var(--muted)`", `README.md:198`), icon at `size-4`, `text-danger` when `danger`. Each row calls `onAction(a.id)`; the window's own prop passes it straight up. This plan opens no dialog.

### 4.11 `Inspector.tsx`

State: `{ status, engineId, reason, tree, frameSize, snapshotUrl, selected: number[] | null, capturing, error }`.

Lifecycle, per plan 208:

1. First time the tab is shown: `ws.request({ type: 'inspect.attach', id: newId(), payload: { deviceId } }, 50_000)`; on `inspect.status` store `state`, `engineId`, `reason`. `state: 'starting'` pushes (no `id`) update the sentence only.
2. On attach `ready`, and on every **Capture**: `ws.request({ type: 'inspect.dump', id: newId(), payload: { deviceId, requestId, screenshot: true } })`; the `inspect.tree` reply gives `root`, `frameSize`, `at`, `tookMs`; the PNG arrives on the binary channel with `buf[0] === CHANNEL.SNAPSHOT && buf[1] === requestId` and becomes a `blob:` URL (revoked when replaced).
3. On unmount, or when the window closes: `ws.send({ type: 'inspect.detach', payload: { deviceId } })`.
4. A rejected request whose `code` is `E_INSPECTOR_STARTING` renders the message plus a **Retry** button and no error styling (D10). Any other code renders as an error with the reason the core sent.
5. `device.nodeId !== null` (a cloud device) renders "Inspection runs on the host that owns this device." and no Capture button, matching the reason `components/device/DeviceHeader.tsx:93-97` already records for the disabled Inspect mode ("Set only for a node-owned (cloud) device: there is no local `Inspector` to attach to").

Rendering, the handoff's three stacked parts (`README.md:274-278`):

| Part | Detail |
|---|---|
| Snapshot | a 9:19.5 box (`aspect-[9/19.5] w-[104px] rounded-inner border border-border-2 overflow-hidden relative`) holding the PNG at `h-full w-full object-contain`; the selected node draws `<div>` positioned by `bounds` scaled by `frameSize`, `border-[1.5px] border-accent bg-accent-a2`; beside it a **Capture** `Button variant="outline" size="sm"` with `CameraIcon` |
| UI nodes | a scrolling `max-h-[220px]` list, one row per node in depth-first order, `style={{ paddingLeft: depth * 12 }}`, `font-mono text-[11.5px]`, row text `${shortClassName(node.className)}${label ? ` "${label}"` : ''}`; the selected row `bg-accent-soft text-accent`; clicking selects |
| Node details | a definition list, eight rows in this order: class, resource id, text, bounds, clickable, enabled, package, depth; values `font-mono text-[11px]`, empty values render `–` |

`shortClassName` and the "first non-empty of resourceId / text / desc" label rule are copied from `components/InspectorPanel.tsx:66-77` before that file is deleted.

### 4.12 `DeviceTab.tsx`, `DeviceJobs.tsx`, `DeviceFiles.tsx`

`DeviceTab.tsx` is the container the handoff insists on ("a generic container tab, not one tab per feature", `README.md:279-280`): a `TabsList variant="compact"` with `Jobs` and `Files`, and nothing else. Adding a third section later touches this file only.

**`DeviceJobs.tsx`.** List: `api(\`/api/jobs?deviceId=${id}&limit=20\`, JobsPageResponseSchema)` (plan 211 §4.6 keeps the query parameter), refreshed by the `job.status` WS message for this device. One row per job: `<StatusDot state={...} />` + the script name (`font-mono text-body`) + a sub-line indented 14 px (`text-meta text-faint`):

| Job state | Sub-line |
|---|---|
| running, `kind === 'workflow'` | `step ${stepSeq} of ${total} · ${pct}%` |
| running, script | `${phase} · ${elapsed}` |
| queued | `position ${n}` when the payload carries one, else `queued` |
| settled | `${finishedAtHHMM} · ${duration}` |
| failed | `${error} · ${finishedAtHHMM}` |

Clicking a row opens the compact detail in place (a back chevron returns to the list): the state `Badge` beside the name on the same line, a `Progress` bar while running, then exactly four rows, Job id, Trigger, Started, Duration, then the buttons:

| Button | Shown when | Call |
|---|---|---|
| Stop | the latest run is running | `POST /api/jobs/:id/cancel` |
| Cancel | the latest run is queued | `POST /api/jobs/:id/cancel` |
| Re-run | the latest run has settled | `runAction('run-script', { deviceIds: [deviceId] }, { jobId })` (MVP 14 §2: "Run again ... is the same verb ... with `jobId` set, which tells the core to add a run instead of creating a job") |
| Logs | always | expands `GET /api/jobs/:id/runs/:runId/logs` inline, newest last, `font-mono text-[11px]` |
| Open full detail | always | `<Link href={\`/jobs/detail?id=${jobId}\`}>` |

Stop and Cancel are one call with two labels because there is one verb: a running job is stopped and a queued job is cancelled, and the handoff draws both because the row can be in either state. Never render both.

**`DeviceFiles.tsx`.** State `{ path, entries, freePct, loading, error }`, starting at `/sdcard`. One navigation is one `runOnDevice('adb', deviceId, { cmd })` with the command in D9. `files-parse.ts` exports:

```ts
export interface DeviceFileEntry {
  name: string
  kind: 'dir' | 'file'
  /** Bytes, or null when `ls` printed something unparseable. */
  size: number | null
  /** `YYYY-MM-DD HH:MM` as toybox prints it, or null. */
  modified: string | null
}
/** Splits on the `@@enkaku-df@@` marker: `ls -lA` above, one `df -k` line below. */
export function parseFilesOutput(stdout: string): { entries: DeviceFileEntry[]; freePct: number | null }
```

Rules: skip the `total N` line; split each row on whitespace with a limit of 8 and take the eighth chunk as the name; `kind` is `dir` when the mode's first character is `d`; a mode starting with `l` cuts the name at `" -> "` and takes `kind` from whether the target ends in `/`, defaulting to `file`; sort directories first then by name, case-insensitively; `freePct` is `100 - Number(field5.replace('%',''))` from the `df` line, or null when it does not parse.

Rendering (`README.md:286-289`): a breadcrumb of clickable segments (`sdcard / Download`) where the last is not a link; a line reading `${entries.length} items · ${freePct}% free` (` · free space unknown` when null); an **Upload file** `Button variant="outline" size="sm"` with `UploadSimpleIcon` calling `onAction('push', { remotePath: path })`; then rows with the type icon, name, `${size} · ${modified}`, and a trailing `CaretRightIcon` for a folder or `DotsThreeIcon` for a file. Folders navigate. Icons by extension: `.png .jpg .jpeg .gif .webp` `ImageIcon`; `.apk` `PackageIcon`; `.mp4 .mkv .webm .mov` `FilmSlateIcon`; otherwise `FileIcon`; a directory is `FolderSimpleIcon` at `text-warn` (the handoff's amber).

The file row's trailing `DotsThreeIcon` is drawn but inert in this plan: the per-file menu (download, delete, push here) is plan 216's, and a button that opens nothing would be worse than an affordance that is visibly not yet wired. Recorded in §11's "Observed, not done".

### 4.13 `retarget.ts` (new, complete)

```ts
/**
 * Design handoff README.md:243-245: "Double-clicking a different device
 * switches the window to it. If that device was already part of the
 * selection the selection is kept (host just moves); if it was not, the
 * selection collapses to just that device."
 *
 * Called by the Devices screen's double-click handler (plan 214's screen);
 * the window itself only ever receives the resulting `deviceId`.
 */
export function retargetSelection(next: string, selected: readonly string[]): string[] {
  return selected.includes(next) ? [...selected] : [next]
}
```

### 4.14 `LiveView.tsx`, rewritten as the Screens tile

Props become `{ deviceId: string; active?: boolean; className?: string }`. The body is `useCast({ deviceId, quality: 'wall', interactive: false, targets: [deviceId], active })`, a `<canvas ref={canvasRef} className="h-full w-full object-contain" aria-label="Device screen" />` at the stream's aspect ratio, and the tile's own centre text when not live (`Disconnected` / `Unauthorized`, 11 px, unauthorized in `text-warn`, `README.md:155-156`). Everything else in the file goes; the deleted parts are listed in §10.

Deleted exports that have callers outside this file: `markLiveViewIntent` (called by `components/wall/WallTile.tsx:10` and `components/device-popup/DevicePopup.tsx:24`). The popup is deleted by this plan; the tile is plan 214's, so step 215.10 removes the call from whichever file plan 214 left as the Screens tile, found with `rg -n "markLiveViewIntent" packages/studio/src`.

### 4.15 The Devices screen, two changes only

1. Where plan 214's screen renders the control surface, it renders `<DeviceControl deviceId={focusId} selectedIds={selectedIds} onClose={clearFocus} onAction={runBulkAction} />` in place of `<DevicePopup ... />` (`packages/studio/src/app/page.tsx:1734` as of today).
2. Its double-click handler calls `setSelected(retargetSelection(id, selected))` before setting the focused device.

If plan 214 has already replaced `app/page.tsx`'s double-click handler with its own, the same two edits go into whatever file it left; find it with `rg -n "DevicePopup|onDoubleClick|onDblClick" packages/studio/src`.

## 5. Implementation steps

Every step: read the file before editing, match on the quoted content, and run only what that step names.

### 215.1 The hotkey table in the protocol

- Files created: `packages/protocol/src/hotkeys.ts` (§4.3, complete), `packages/protocol/src/hotkeys.test.ts` (§4.3's three tests).
- Files changed: `packages/protocol/src/index.ts` (add `export * from './hotkeys'` beside the `./keys` export plan 209 added).
- Files deleted: none.
- Test file: `packages/protocol/src/hotkeys.test.ts`.
- Verifiable result: `bun test packages/protocol/src/hotkeys.test.ts` passes 3 tests; G6.
- Do not: add a platform branch that swaps Alt for Cmd. The default is Alt everywhere and the macOS variant is §9 Q1; a branch now would have to be unpicked when that question is answered.

### 215.2 The geometry and the retarget rule

- Files created: `packages/studio/src/components/device-control/geometry.ts` (§4.4, complete), `packages/studio/src/components/device-control/retarget.ts` (§4.13, complete).
- Files changed: none.
- Test file: none. Studio has zero tests (plan 200 §8.3).
- Verifiable result: G2's two commands; `bun run typecheck` clean.
- Do not: put the formula in `@enkaku/protocol` to make it testable. It is a layout constant of one screen, and moving it would give a wire package a reason to know about pixels.

### 215.3 The cast hook

- Files created: `packages/studio/src/components/device-control/use-cast.ts` (§4.5).
- Files changed: none yet (`LiveView.tsx` is rewritten in 215.10, after the hook exists).
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean with the hook exported and no importer yet.
- Do not: change any behaviour while moving it. The fps window, the 1 second staleness interval, the estimator wiring and plan 209's pointer, wheel and key handlers move verbatim; the only new code is the fan-out loop, the focus model, the hotkey dispatch and the three pointer-table rows (right click, middle click, pinch). If a moved line needs to change to compile, say so in §11.

### 215.4 The window shell

- Files created: `packages/studio/src/components/device-control/DeviceControl.tsx` (§4.6), `ShortcutRail.tsx` and `ClipboardPopover.tsx` (§4.7), `Cast.tsx` (§4.8).
- Files changed: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; G1 and G4's `rg` lines; the window renders with the three columns at the handoff's widths.
- Do not: add a backdrop, an `aria-modal`, a focus trap, or a `Dialog`. Do not install a `document` `keydown` listener for Escape: `useOverlay('window', ...)` is the only registration, and the shell owns the key (plan 213 §4.9).

### 215.5 The info column

- Files created: `packages/studio/src/components/device-control/InfoPopover.tsx`, `state-tooltip.ts` (§4.9).
- Files changed: `DeviceControl.tsx` (compose the header, the popover, the meta strip, the host banner and the tab bar).
- Test file: none.
- Verifiable result: G22's grep is clean for the new directory; the host banner appears only while `selectedIds.length > 1`.
- Do not: write "Held 4:55" or any wording with "held", "holder" or "cluster" in it, even though the handoff's Device Control paragraph uses two of them. §3.2 D13 and plan 200 §2.4 decide this, and G22 fails the build over it.

### 215.6 The Actions tab and the one action list

- Files created: `packages/studio/src/lib/generic-actions.ts` (§4.10, complete), `packages/studio/src/components/device-control/DeviceActions.tsx`.
- Files changed: plan 214's bulk-pill menu, to import `GENERIC_ACTIONS` instead of its own list. Find it with `rg -n "Reconnect" packages/studio/src/app packages/studio/src/components --glob '!**/device-control/**'` and delete the duplicate array it holds.
- Test file: none.
- Verifiable result: G23's two commands.
- Do not: implement any of the twelve actions here. Every row calls `onAction(id)` and stops. Plan 216 owns the dialogs; a "just this one is easy" direct call would put a second, divergent code path beside the bulk menu's.

### 215.7 The Inspector tab

- Files created: `packages/studio/src/components/device-control/Inspector.tsx` (§4.11).
- Files changed: `DeviceControl.tsx` (mount it under the Inspector tab).
- Files deleted: none yet (`components/InspectorPanel.tsx` goes in 215.11, once nothing imports it).
- Test file: none.
- Verifiable result: `bun run typecheck` clean; G15's `rg`; §7.4 smoke step 12.
- Do not: carry over the old panel's follow poll, its 20-entry dump history, or its selector-candidate "Test on device" strip. The handoff draws Capture, a tree and details; a self-scheduling dump loop inside a 274 px column spends a phone's time on a tree nobody is reading, which is exactly what `shouldPoll` existed to prevent.

### 215.8 The Device tab: Jobs

- Files created: `packages/studio/src/components/device-control/DeviceTab.tsx`, `DeviceJobs.tsx` (§4.12).
- Files changed: `DeviceControl.tsx`.
- Test file: none.
- Verifiable result: G16's `rg`; §7.4 smoke step 13.
- Do not: render All/Running filter chips ("that belongs on the Jobs page", `README.md:281`), and do not reuse `components/JobsList.tsx`: it is the full table, it is paginated, it links to `/device?id=` which this plan deletes, and plans 217 and 218 own it.

### 215.9 The Device tab: Files

- Files created: `packages/studio/src/components/device-control/DeviceFiles.tsx`, `files-parse.ts` (§4.12).
- Files changed: `DeviceTab.tsx`.
- Test file: none. `parseFilesOutput` is not on plan 200 §8.3's critical list, so it is not tested; §8 carries the risk and §7.4 step 15 is its check.
- Verifiable result: `bun run typecheck` clean; §7.4 smoke step 15.
- Do not: add a core route, a capability, or a WS message for listing a directory. §3.2 D9 chose plan 207's `adb` action precisely so this Studio plan adds no server surface.

### 215.10 `LiveView` becomes the Screens tile

- Files created: none.
- Files changed: `packages/studio/src/components/LiveView.tsx` (rewritten per §4.14); whichever file plan 214 left as the Screens tile (today `components/wall/WallTile.tsx:10`), to drop the `markLiveViewIntent` import and call and to pass the new props.
- Files deleted: none.
- Test file: none.
- Verifiable result: `bun run typecheck` clean; `rg -n "markLiveViewIntent|clickIntentMarks|MANUAL_GESTURE|TEXT_DEBOUNCE_MS|fitContainer|configuredDisplay" packages/studio/src` prints nothing.
- Do not: rename or move `LiveView.tsx`. Keeping the path and the export name is what stops this plan editing plan 214's tile beyond one import line.

### 215.11 Delete the popup, the device page, and the five components they owned

- Files created: none.
- Files changed: `packages/studio/src/app/page.tsx` per §4.15 (or plan 214's replacement); `scripts/check-routes.ts` (delete the `'/device'` row from `PENDING_REMOVAL`).
- Files deleted: `packages/studio/src/app/device/` (the whole directory), `packages/studio/src/components/device-popup/` (the whole directory), `packages/studio/src/components/device/ScreenCard.tsx`, `packages/studio/src/components/device/DeviceHeader.tsx`, `packages/studio/src/components/device/ClipboardButton.tsx`, `packages/studio/src/components/InspectorPanel.tsx`, `packages/studio/src/components/FilesPanel.tsx`.
- Test file: none.
- Verifiable result: G19, G20, G21; `bun run typecheck` clean.
- Do not: keep `DeviceDetailInfo`. Its eight fields are `DeviceDetailSchema`'s (`packages/protocol/src/api/devices.ts:66-82`), whose own doc comment already names the Studio interface as the copy; every remaining importer (today `components/wall/DeviceContextMenu.tsx:7`, `components/device/DeviceNumberField.tsx:7`) switches to `type DeviceDetail = z.infer<typeof DeviceDetailSchema>` from `@enkaku/protocol`. Do not leave a re-export shim behind either directory (plan 200 §2.1: replace, never version).

### 215.12 The forbidden-vocabulary and route sweep

- Files created: none.
- Files changed: whatever the greps in §10.3 find.
- Test file: none.
- Verifiable result: every §10 proof command prints nothing (or its stated output); `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt`; `bun run typecheck` clean.
- Do not: silence a grep by renaming a variable while leaving the behaviour. If a hit is a real consumer outside this plan's scope, report it in §11 rather than deleting it.

## 6. Acceptance criteria

1. Double-clicking a device on the Devices screen opens one floating window with three columns at 52, `max(560*(w/h)+36, 380)` and 274 pixels, `height: calc(100vh - 48px)` capped at 640, 18 px radius, `0 30px 80px #00000033`, on `var(--panel)` inside `1px solid var(--border-2)`.
2. There is no backdrop. While the window is open the Devices screen scrolls, filters and selects normally.
3. Dragging either header strip moves the window; releasing anywhere stops it; Escape closes it and the next open is centred again.
4. Double-clicking a second device that is in the selection moves the window and leaves the selection alone; double-clicking one that is not collapses the selection to it.
5. A 9:19.5 device gives a 706 px window; a 4:3 device gives a 1109 px window.
6. Clicking the cast takes focus, draws an accent frame, and from then on every key reaches the device: a typed sentence appears character by character, Tab moves focus in a device form, arrows move the cursor, Ctrl+A selects all, Shift+arrow extends a selection. Clicking outside, `Alt+Shift+K`, or closing the window releases it.
7. The wheel scrolls at the pointer and Shift+wheel scrolls horizontally; right click is Back; middle click is Home; Ctrl+drag pinches a map.
8. `Alt+C` puts the device's last copied text on the host clipboard; `Alt+V` pastes the host clipboard into the focused device field; every other row of `DEVICE_CONTROL_HOTKEYS` does what its `label` says, and every rail tooltip shows the chord from the same table.
9. The stats strip reads a green dot, "Streaming", the frame rate, the resolution in mono, the codec, and a right-aligned latency figure whose tooltip says the number is relative, not glass to glass. While the control encoder is starting the codec cell says `H.264 · wall`.
10. There is no instructional caption under the cast.
11. The header shows the state dot, the zero-padded device number in mono, the uppercased name, `[i]` and close. Hovering the dot gives the same sentence the Screens card gives.
12. The `[i]` popover is 306 px and lists group, stable id, endpoint, api level, screen, density and guest agent, then the four active engines, then Change.
13. Actions lists the twelve generic actions in the handoff's order with the handoff's icons, and the bulk pill's menu renders the same array.
14. Inspector captures a tree, the tree indents 12 px per depth in 11.5 px mono, selecting a node highlights the row and draws its bounds on the 9:19.5 snapshot, and the eight detail rows are class, resource id, text, bounds, clickable, enabled, package, depth.
15. Device shows a Jobs or Files chip switch. Jobs lists the device's jobs unfiltered with a state dot, the script name and a sub-line; opening one shows the compact detail with Stop or Cancel, Re-run, Logs and Open full detail. Files shows a breadcrumb, `N items · X% free`, Upload file, and typed rows where folders navigate.
16. Selecting several devices and double-clicking one shows the warn-tinted host banner reading `Mirroring input to N other selected devices · N+1 under control`, and a tap on the cast lands on every selected device.
17. `packages/studio/src/app/device` and `packages/studio/src/components/device-popup` do not exist, `scripts/check-routes.ts` no longer excuses `/device`, and it prints `routes ok: 6 in nav, 10 exempt`.
18. `bun run typecheck` is clean and `packages/studio` contains zero test files.

## 7. Test plan

### 7.1 What is tested, and why exactly one thing is

Studio and `@enkaku/ui` have **zero tests** (plan 200 §8.3). No `*.test.tsx`, no `*.test.ts` under `packages/studio` or `packages/ui`, no happy-dom, no testing-library, no `[test].preload`. Everything in §4.4 to §4.15 is verified by `bun run typecheck`, the handoff measurements as `rg` proofs in §0, and the owner smoke in §7.4.

The one exception is `packages/protocol/src/hotkeys.test.ts`. It is in scope because the table is protocol vocabulary shared with plan 209's `KEY_TABLE`: a `code` that is in the hotkey table but not in `DOM_CODES` is a chord that silently does nothing on a device, and no typecheck catches it. Three tests, listed in §4.3.

### 7.2 Scoped commands, one at a time, never concurrently

```bash
bun run typecheck
bun test packages/protocol/src/hotkeys.test.ts
bun run scripts/check-routes.ts        # expected: routes ok: 6 in nav, 10 exempt, exit 0
```

Never a bare `bun test` (`CLAUDE.md`; plan 200 §2.3).

### 7.3 Route-script regression

```bash
# the exemption must be gone, not merely unused
rg -n "'/device'" scripts/check-routes.ts          # expected: no output
mkdir -p packages/studio/src/app/device && printf 'export default function P(){return null}\n' > packages/studio/src/app/device/page.tsx
bun run scripts/check-routes.ts; echo "exit=$?"    # expected: a line naming /device, exit=1
rm -rf packages/studio/src/app/device
bun run scripts/check-routes.ts; echo "exit=$?"    # expected: routes ok: 6 in nav, 10 exempt, exit=0
```

### 7.4 Owner smoke, lab device attached

Run against a real device with `bun run dev` and `bun run dev:studio`. Numbered so a failure can be reported by number. Steps 7 to 16 need `ENKAKU_TEST_DEVICE=1` conditions in the sense that they need a phone; they are run by the owner, not by an agent.

1. Open the Devices screen with at least three devices. Double-click one. The window opens centred, three columns, no backdrop. Measure the window's width in the browser inspector: a 9:19.5 phone gives 706 px. Record the number in §11.
2. With the window open, scroll the device table, type in the toolbar search, and click a row. All three work. (G4)
3. Drag the window by the stats strip, then by the info header. Both move it. (G3)
4. Press Escape with the cast **not** focused: the window closes. Reopen: it is centred again, not where it was dragged to. (G3)
5. Select devices A and B. Double-click A, then double-click B: the window switches and A and B stay selected. Now double-click C, which is not selected: the window switches and the selection is only C. (G5)
6. Click the cast: an accent frame appears. Click the device table: the frame goes. Click the cast again, press `Alt+Shift+K`: the frame goes. (G8)
7. With the cast focused, open a text field on the device and type a sentence at a normal pace. Every character appears as it is typed, none batched. (G10)
8. In a form on the device, press Tab: focus moves on the device, not in the browser. Press the arrows, then Ctrl+A, then Shift+arrow. All four behave. (G9, G11)
9. Open a long list on the device. Roll the wheel over the cast: it scrolls. Hold Shift and roll: it scrolls sideways. (G12)
10. Right click the cast: the device goes back. Middle click: the device goes home. Open a map, hold Ctrl and drag: it zooms. (G13)
11. Copy text on the device, press `Alt+C`, paste into a host editor: the text arrives. Copy text on the host, focus a device field, press `Alt+V`: the text arrives. (G14)
12. Open Inspector, press Capture. A tree appears. Click a node: its row highlights and an accent rectangle draws over the snapshot at that node's bounds. The eight detail rows fill in. (G15)
13. Open Device, Jobs. Run a script on the device from the Actions tab. The row appears with a red dot and a sub-line. Open it: Stop is offered. Press Stop: the job cancels. Open it again: Re-run is offered. Press Re-run: the run count goes up and no new row appears. (G16)
14. Select five devices, double-click one. The warn banner reads "Mirroring input to 4 other selected devices · 5 under control". Tap the cast: all five devices react. Open the Devices screen's activity column: all five carry a control activity. (G17)
15. Open Device, Files. The breadcrumb reads `sdcard`, the header reads `N items · X% free`, folders show an amber folder icon and a caret. Click `Download`: the breadcrumb becomes `sdcard / Download` and the listing changes. (G18)
16. Read the stats strip's latency figure after ten seconds of dragging, and its tooltip. Paste both into §11. (G26)

### 7.5 Processes

Every process started for the smoke is dead before the report: `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plan 214's Devices screen and this window fight over the selection: the window mirrors to `selectedIds` while the screen is still changing it under the operator's marquee. | The window never writes the selection. It reads `selectedIds` and calls `retargetSelection` only through the screen's own double-click handler (§4.15). A marquee that changes the selection while the window is open changes who the mirror reaches, which is what the banner's live count is for. |
| The mirror fans input to a device the operator forgot was selected. | The banner is permanent while `selectedIds.length > 1`, states the exact count, and is painted `warn-soft`. It is the only warn-coloured element in the window. |
| `parseFilesOutput` has no test and toybox's `ls -l` differs by OEM. | §7.4 step 15 is its check on the lab device, and a row that does not parse is dropped rather than rendered wrong. If a farm's phones print a different format, the fix is one function. Recorded as an accepted gap in §11. |
| The Files section costs one `command` activity and one operation poll per directory. | It is a person navigating, not a loop. If it proves noisy, the alternative is a core route, which is a later plan's decision, not a silent change here. |
| A browser reserved chord (`Ctrl+W`) closes the tab while the cast has focus, and the operator believes the window swallowed it. | §3.2 D4 states the limit; the Actions tab and the rail cover every device action that matters without a chord; nothing in the UI claims otherwise. |
| Deleting `FilesPanel.tsx` removes the only install and push UI before plan 216's dialogs exist. | Both plans are stage 6 and both are in wave 3's gate; the wave does not close with a hole. The `install` and `push` verbs already work over `POST /api/actions/<verb>` from plan 207, so nothing on the server regresses. Called out in §2 and repeated in §11. |
| The cast hook is a large move, and a behaviour lost in the move is invisible to a typecheck. | 215.3's "Do not" makes the move verbatim and requires any forced change to be reported. §7.4 steps 7 to 13 exercise every moved input path on a real phone. |
| Alt chords collide with a device that uses Alt itself. | Alt combinations are rare on Android and every hotkey has a rail button or an Actions row behind it. §9 Q1 keeps the modifier open. |
| `stream.started.substitute` never resolves, so the strip reads `H.264 · wall` forever on a healthy device. | Plan 206 sends `stream.meta` with `quality: 'control'` on the switch and with `quality: 'wall'` plus a `detail` when the control encoder fails after the substitution was announced; the strip reads both, and the permanent case has its own tooltip (D6). |

## 9. Open questions

1. **The hotkey modifier on macOS.** MVP 08 §5 point 1 proposes "Alt on Windows and Linux, Cmd on macOS, user-switchable". This plan ships Alt everywhere (§3.2 D5) because Cmd would swallow `Cmd+A`, `Cmd+C` and `Cmd+V`, three of MVP 08 §4's own acceptance behaviours. If the CEO wants Cmd on macOS, the decision also has to say what happens to those three chords, and plan 212 gains the per-user setting.
2. **The soft-keyboard-with-hardware preference.** MVP 08 §1.2's UHID side effect (Android may hide the soft keyboard when a virtual hardware keyboard appears) needs a per-device preference and an `OPEN_HARD_KEYBOARD_SETTINGS` toggle. The handoff's rail has no button for it and MVP 08 §2 puts the field in Settings. Not built here; plan 212 owns the field and plan 221 owns the guest agent side. Does the window need a one-time hint in the meantime?
3. **The first-open hotkey overlay.** MVP 08 §5 point 2 proposes showing the hotkey table once, dismissable, with the table available from the toolbar. The handoff draws neither an overlay nor a table affordance, and its own rule is that hints live in the drag tooltip only. Not built; the table is in the tooltips instead.
4. **The per-file menu in Files.** The handoff draws `ph-dots-three` on a file row but does not say what it opens (download, delete, push to here). §4.12 draws it inert and leaves the menu to plan 216. Which items does it hold?
5. **The 274 px column at 960 px viewport width.** The handoff is desktop-first at 1280 to 1600 px and "usable down to ~960px", but a 4:3 device makes this window 1109 px wide before the browser chrome. Does the window clamp to the viewport (the picture letterboxes) or scroll? This plan clamps with `max-w-[calc(100vw-24px)]` and lets `object-contain` letterbox, which is the behaviour `LiveView.tsx:972-981` already reasoned its way to for the popup; confirm it is what the designer meant.

## 10. Removed

### 10.1 Files and directories

| What | Where it was | Proof |
|---|---|---|
| The 12-tab device page and its route | `packages/studio/src/app/device/` (`page.tsx:731-751` lists the tabs) | `test ! -d packages/studio/src/app/device` |
| The three-panel device popup and everything only it used | `packages/studio/src/components/device-popup/` (10 components after plan 201 deleted their tests: `DevicePopup.tsx`, `ActionsList.tsx`, `AdbCommandDialog.tsx`, `ControlState.tsx`, `HardwareRail.tsx`, `JobDetailPanel.tsx`, `PreparationPanel.tsx`, `ReadPopups.tsx`, `SettingsPopup.tsx`, `SidePanel.tsx`; plan 205 deletes `ControlState.tsx` before this plan runs) | `test ! -d packages/studio/src/components/device-popup` |
| `ScreenCard` and `ScreenMode` (the Live / Inspect / Record mode switch, and the lease banner plan 205 already emptied) | `packages/studio/src/components/device/ScreenCard.tsx:11`, `:53` | `test ! -e packages/studio/src/components/device/ScreenCard.tsx`; `rg -n "ScreenCard\|ScreenMode" packages/studio/src` prints nothing |
| `DeviceHeader`, `DeviceDetailsPopover`, `ViewersPopover`, `BatteryTempInline`, `ENGINE_ROWS`, `mmss` and the `DeviceDetailInfo` interface | `packages/studio/src/components/device/DeviceHeader.tsx:77-105` | `test ! -e packages/studio/src/components/device/DeviceHeader.tsx`; `rg -n "DeviceDetailInfo" packages/studio/src` prints nothing |
| `ClipboardButton` | `packages/studio/src/components/device/ClipboardButton.tsx`, imported at `device-popup/HardwareRail.tsx:6` and `LiveView.tsx:1321` | `test ! -e packages/studio/src/components/device/ClipboardButton.tsx` |
| The old inspector panel: the follow poll, the 20-entry dump history, the selector-candidate strip, the `onTakeControl` props | `packages/studio/src/components/InspectorPanel.tsx` (1 148 lines; `shouldPoll` `:176`, `HISTORY_LIMIT` `:305`, `testOnDevice` `:668`) | `test ! -e packages/studio/src/components/InspectorPanel.tsx`; `rg -n "shouldPoll\|InspectorPanel" packages/studio/src` prints nothing |
| `FilesPanel` (install, push and pull as a panel) | `packages/studio/src/components/FilesPanel.tsx:79` | `test ! -e packages/studio/src/components/FilesPanel.tsx` |

### 10.2 Exports, props and copy inside files that survive

| What | Where it was | Proof |
|---|---|---|
| `markLiveViewIntent`, `clickIntentMarks`, `takeClickIntentMark`, `CLICK_INTENT_TTL_MS`, `formatClickToPaint` and the `click→paint` readout (MVP 01's latency overlay replaces it) | `LiveView.tsx:88-130`, `:1089-1102` | `rg -n "markLiveViewIntent\|clickIntentMarks\|click→paint" packages/studio/src` prints nothing |
| `LiveView`'s props `inputEnabled`, `onActivity`, `autoReconnect`, `quality`, `compact`, `rail`, `fitContainer`, `configuredDisplay`, `provisioning` | `LiveView.tsx:168-283` | `rg -n "fitContainer\|configuredDisplay\|provisioning=" packages/studio/src` prints nothing |
| The `compact` keyboard disable (MVP 13 A.8's last item) | `LiveView.tsx:1157-1161`, `tabIndex={compact ? -1 : 0}` and `onKeyDown={compact ? undefined : onKeyDown}` | `rg -n "compact \? undefined" packages/studio/src` prints nothing |
| The instructional caption under the cast (`README.md:259`, "No instructional caption under the cast") | `LiveView.tsx:1324-1328`, `'Click to tap, drag to swipe, type while the canvas is focused. Esc sends Back.'` | `rg -n "Click to tap, drag to swipe" packages/studio/src` prints nothing |
| `LiveView`'s own hardware, nav and power button rows and the `keyButton` renderer (the shortcut rail replaces them) | `LiveView.tsx:897-940`, `:1207`, `:1310-1330` | `rg -n "keyButton" packages/studio/src` prints nothing |
| The `/device?id=` link in the jobs table | `components/JobsList.tsx:301`, `href={\`/device?id=${encodeURIComponent(j.deviceId)}\`}` | `rg -n "/device\?id=" packages/studio/src` prints nothing |
| The `'/device'` exemption in the route script | `scripts/check-routes.ts`'s `PENDING_REMOVAL` (plan 213 §4.10) | `rg -n "'/device'" scripts/check-routes.ts` prints nothing; `bun run scripts/check-routes.ts` prints `routes ok: 6 in nav, 10 exempt` |
| A second copy of the generic action set | plan 214's bulk-pill menu | `rg -n "Install apk" packages/studio/src --glob '!**/lib/generic-actions.ts'` prints nothing |

### 10.3 Forbidden vocabulary for this area (plan 200 §2.4)

```bash
GREP_215() {
  rg -n -i \
    -e "take control" -e "\blease" -e "\bholder\b" -e "\bassist" -e "co-control" -e "\bgrant\b" \
    -e "\bcluster" -e "\bpopup\b" -e "\bmodal\b" -e "device page" -e "input\.mirror" -e "mirror group" \
    packages/studio/src/components/device-control packages/studio/src/lib/generic-actions.ts packages/protocol/src/hotkeys.ts
}
GREP_215   # expected: no output
```

Plus, workspace wide, the two words this plan is responsible for retiring:

```bash
rg -n "input\.mirror|mirror\.start|mirror\.stop" packages apps plugins scripts   # expected: no output
rg -n -i "device popup|DevicePopup" packages apps plugins scripts docs/plans/215-mvp-device-control.md --glob '!docs/archive/**'   # expected: no output outside this plan's §3
```

## 11. Handoff report

- **Checklist**:
- **Commits**:
- **Typecheck**:
- **Tests run**:
- **Removed, proven**:
- **Discrepancies between plan and code**:
- **Observed, not done**:
- **Open questions hit**:
- **Processes**:
