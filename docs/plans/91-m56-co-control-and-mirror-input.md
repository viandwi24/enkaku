# Plan 91 — M56 : Co-control, and one operator driving many phones

> Status: partial — steps 91.1 through 91.11 are all done, see their own checklists below — **91.11 (documentation and spec) is this pass's own work and closes the plan.** Kept `partial`, not `implemented`, on purpose: every step is implemented and tested in software (`bash scripts/typecheck.sh`, `bun test`, `bun run --cwd packages/studio test` all green against the working tree this status describes, modulo the two pre-existing, unrelated failures named at the end of 91.11's own status note). What remains, in full, is hardware confirmation — nothing left is a design question or an unbuilt mechanism — gathered into one consolidated table immediately above §6 (Acceptance criteria) rather than left scattered one per step, mirroring plan 90's own precedent; every per-step note stays exactly where it is, cross-referenced rather than replaced. 91.11 itself: `docs/spec.md` §10.1 is amended verbatim per §3.4 and a new §10.5 defines the co-control grant in full (what it is, what it grants, what it explicitly does not, its five-path lifetime); §11.3 names the third actor (an assisting operator, five input verbs, never a shell); `packages/session/README.md` (new) documents the input arbiter's three lanes; `packages/core/README.md` documents the grant, mirror groups, and the new `coControl`/`mirror` settings; `docs/guide/install.md` gains "Assisting a running job" and "Controlling many devices" sections; `docs/plans/00-overview.md` §2 gets this plan's row. Full detail in 91.11's own status note near the end of this preamble, directly above its checklist. Step 91.1 lands `packages/session/src/input-arbiter.ts`, threads `DeviceSession.arbiter` through `session.ts`, and migrates every production caller of the raw `InputSink` it could find except the node package's own (deliberately, per §2's non-goals — see 91.1's own note). Step 91.2 lands `packages/core/src/lease/co-control.ts` (grant/release/TTL reaper/`onPrimaryEnded` subordination/`maxConcurrentPerDevice`/`releaseAllForClient`/`assistedBy`, all four end reasons proven in `co-control.test.ts`, plus a fifth beyond the checklist — a takeover of the manual lease also ends a subordinate grant), wires `lease-manager.ts`'s new `onPrimaryEnded` hook (fired unconditionally from `release()` and from `clearJobLease()`, not merely from the pre-existing `onManualRevoked`, which stays silent on a plain voluntary release) with no signature change to any existing `LeaseManager` method, and constructs/starts/stops it in `daemon.ts` (`daemon-wiring.test.ts` pins the construction call, the settings it reads, the reaper start/stop, and the `onPrimaryEnded`/`onManualTakenOver` wiring). Step 91.4 closes both gaps 91.2/91.3 deliberately left open, plus its own checklist: (a) **the two deferred wirings** — `WsHandlerDeps` (`packages/core/src/server/ws-handlers.ts`) now carries optional `coControl`/`coControlMode` fields (optional, not required, so every pre-existing test fixture in this file kept compiling unchanged — the same "omitted means off" convention every other optional dep here uses); `daemon.ts` passes both into `createWsMessageHandler(...)`, the "NOT WIRED YET" marker comment above `attachWsRouter` is deleted, and `daemon-wiring.test.ts`'s pinning test now asserts the real wiring instead of the gap (plus a new test pinning that `createCoControlManager(...)`'s `onGranted`/`onReleased` hooks broadcast `assist.changed` via `hub.broadcast` — wired at construction, not only from the WS `assist.*` handlers, so TTL expiry/disconnect/primary-ended all reach every viewer too, not only the two explicit messages); the twelve co-control messages (`assist.*`, `mirror.*`, `input.mirror*`) are now in `ClientMessageSchema`/`ServerMessageSchema` (`packages/protocol/src/index.ts`, additive-only, appended after a fresh read per this repo's rule on that file) — `mirror.*`'s own WS-handler cases do not exist yet (step 91.7), so those message types are reachable-but-unhandled for now, the same as any other not-yet-implemented union member in this router. (b) **91.4's own checklist**: the `input.*` branch resolves one `InputSource` via the §3.2 fallback (`checkInputAllowed` first, `coControl.checkAssistAllowed` only as a fallback after it fails) — `touchManual` stays for the lease path, the assist path calls `coControl.touch` instead; `assist.start`/`assist.stop` handlers, gated by `canAssist(role, coControlMode)`, honouring the script's `assist` declaration through `co-control.ts`'s existing (permissive-until-91.5) `scriptAssistPolicy` hook, replying `assist.started`/`assist.stopped` and (via the daemon-level `onGranted`/`onReleased` hooks) broadcasting `assist.changed`; `handleClose` now also calls `deps.coControl?.releaseAllForClient(state.clientId)`, mirroring the lease manager's own WS-close cleanup; `packages/core/src/api/devices.ts` gains an optional `assistedByOf` dep, threaded through daemon.ts as `(deviceId) => coControl.assistedBy(deviceId)`, and populated in all three `rowToDeviceInfo` call sites this router owns (`infoWithTags`, `GET /`, `GET /:id`) — **known gap, flagged rather than silently left**: `topology.ts`/`clusters.ts`/`capability/context.ts` also call `rowToDeviceInfo` with their own `heldByOf`, but are outside this step's file-ownership list (`registry/device-registry.ts` likewise) and were NOT touched, so a device's `assistedBy` still reads `[]` on the Topology view, a cluster's device list, and the capability layer even while genuinely being assisted — a future step (or the plan's Studio step, 91.6) needs to either thread `assistedByOf` through those three call sites too or note it as an accepted gap. The containment test (`packages/core/src/server/ws-handlers.assist.test.ts`, new) proves, in one test, that a client holding ONLY an assist grant is refused `shell.exec`/`inspect.attach`/`clipboard.set`/`POST /:id/push`/`POST /:id/adb-endpoint` (all five, same device, all `device_busy`) while its `input.tap` succeeds — **no security finding**: all five surfaces refuse exactly as F1 requires, because none of their call sites was touched. A second test in the same file proves the fallback never masks the original refusal for a client holding no grant at all. `bash scripts/typecheck.sh`, `bun test` (3662 pass), `bun run --cwd packages/studio test` (655 pass) and `bun run --cwd packages/studio build` are all green. Step 91.7 (the mirror engine, core-side) is also done, see its own checklist below: `packages/core/src/mirror/group.ts` (new) implements `start`'s §3.9 resolution table, `dispatch`'s per-lane orientation gate/aspect flagging/auto-drop, `reconcile` (F27's re-admit), and `stop`/`stopAllForClient` — `resolveOne` is the one function both `start` and `reconcile` call, and `dispatch` trusts the authorization it already established rather than re-checking `checkInputAllowed`/`checkAssistAllowed` per action. `ws-handlers.ts` gains the `mirror.start`/`mirror.stop`/`input.mirror` cases, a `states` dep (new — the first thing in this router that needs a device's raw status rather than one client's authorization answer), and a `lease`-mode mirror member now gets the identical `lease.changed`/viewer-fanout/event/audit treatment a single-device `lease.acquire` already gives itself (a real gap this step found: unlike co-control, `lease-manager.ts` has no centrally-wired "just acquired" hook at all). `daemon.ts` wires `states`/`mirrorSettings` into the WS handler and threads `host`'s existing `onJobFinished` into a new `reconcileMirrorForDevice` forward-ref, so an `internal:install` job ending re-admits any mirror member that was skipped for it, with no client asking; `daemon-wiring.test.ts` pins both. `packages/core/src/mirror/group.test.ts` (new, 13 tests) is built against REAL `LeaseManager`/`CoControlManager`/`DeviceStateMachine` instances, not hand-rolled fakes, and proves the step's own scenario verbatim (10 devices, 2 offline/1 busy/1 rotated/1 installing/5 ordinary → one `mirror.started` naming all 10; a tap reaches 5 and reports 5 non-deliveries with codes; a key reaches the rotated device too; three failures drop a member with one `mirror.changed`; solo hits exactly one device) plus node-owned refusal, the per-member `assist_not_allowed` role gate, the `mirror.maxDevices` whole-request refusal, and F27 re-admit via `reconcile`. `bash scripts/typecheck.sh`, `bun test` (3753 pass — the only 2 failures anywhere are plan 99's in-progress `api/workflows-wiring.test.ts`, confirmed unrelated by mtime), `bun run --cwd packages/studio test` (657 pass) and `bun run --cwd packages/studio build` are all green. **Known gap, flagged rather than silently left**: mirrored actions write no `device_events`/audit row at all (`group.ts`'s `dispatch` never calls `recorder.record`/`audit.record`, matching §4.7's own literal pseudocode) — a mirrored tap is therefore invisible to `GET /api/jobs/:id/assists` even after step 91.5 lands. **Closed by step 91.5** (see its own paragraph below for the full reasoning): `group.ts`'s `dispatch` now records ONE `device_events` row per successfully-delivered per-device action — deliberately not one aggregate row for the whole mirrored action — and increments `jobs.assistCount` for every `assist`-mode member whose primary hold is a job, so a mirrored assist action is exactly as attributable as a single-device one, and reaches `GET /api/jobs/:id/assists` the same way. Step 91.6 (Studio: assisting one device) is also done, see its own checklist below: `packages/studio/src/app/device/page.tsx` now computes `inputEnabled = (iHoldControl && !busy) || iAmAssisting`, keeps its own assist grant in state (`assisting: { expiresAt, primary } | null`, ms epoch like every other lease-adjacent timer on this page), reads `coControl.mode`/`grantTtlSec` alongside `shellMode`/`transferEnabled` from the existing `/api/settings` fetch, and handles `assist.changed` (patches `device.assistedBy` live — the same shape `lease.changed` already gives `heldBy`) and `assist.stopped` (unicast to the assisting connection only, per that message's own doc comment — clears local state and shows a notice for every reason except `released`, which is the operator's own deliberate "Stop assisting" click and needs none). `packages/studio/src/components/device/AssistDialog.tsx` (new) is the §3.12 warning, modelled on `TakeControlDialog.tsx`: it names the primary holder (in practice always the running script's `name@version`, since this step's one entry point — `ScreenCard`'s pre-assist banner — only offers Assist while `jobRunning`) and the grant's TTL in human words (`humanTtl`, exported and unit-tested: "5 minutes" for the shipped default, `Xm Ys` otherwise), sends `assist.start` over `ws.request`, and surfaces every refusal code (`assist_not_allowed`/`assist_taken`/`assist_denied_by_script`/`device_not_held`) as the dialog's own error text rather than throwing — it never calls `lease.acquire`/`lease.release`, proven by a page-level test asserting no `lease.*` message is ever sent across the whole confirm flow. `ScreenCard.tsx` gains the pre-assist banner (§3.4 item 1 — a non-blocking chip beside the mode buttons, naming the running script, with the Assist button beside it, disabled-with-a-reason rather than hidden when `coControl.mode` is `off`) and the assisting chrome (§3.4 item 2 — a `--color-led-warn` border around the video, a persistent `.rack-label` reading "Assisting — the job still has control", the grant's own `.readout` countdown reusing `DeviceHeader`'s existing `mmss`, and a "Stop assisting" action sending `assist.stop`) — the status rail itself is untouched (§3.4 item 3, proven by a test asserting no `.status-rail` class changes). `HolderBadge.tsx` gains a `variant: 'assists'` (amber, worded "Assisting —"/"Assisted by" rather than "Controlled by"/"Running"/"Driven by", since an assist is never a takeover — `takeable` is always `false`), and `DeviceCard.tsx`/`WallTile.tsx`/`DeviceHeader.tsx` all render `DeviceInfo.assistedBy` through it beside `heldBy`, exactly as F25 promised — checked against REAL producers before writing a single line: `assistedByOf` was already threaded through all four routers (`devices.ts`, `topology.ts`, `clusters.ts`, `capability/context.ts`) by the time this step started, closing 91.4's own flagged gap, so nothing here renders a permanent placeholder. `bash scripts/typecheck.sh` (`studio` OK; `core` carries two pre-existing, self-documented "fails on purpose"/"not a regression" gaps from concurrent 91.5 and plan-99 work, reproduced twice ~20s apart with shifting line numbers confirming live concurrent edits, neither in a file this step touched), `bun test` (3777 pass / 2 fail — the same two self-flagged core gaps, not `packages/core/src/mirror/group.test.ts` or `ws-handlers.assist.test.ts`, whose TS errors do not block `bun test`'s looser transpile), `bun run --cwd packages/studio test` (699 pass / 0 fail, up from 657 — 42 new tests: `AssistDialog.test.tsx`, `ScreenCard.test.tsx`, `HolderBadge.test.tsx` all new, plus additions to `DeviceCard.test.tsx`/`WallTile.test.tsx`/`DeviceHeader.test.tsx`/`device/page.test.tsx`) and `bun run --cwd packages/studio build` (run alone, per this plan series' own convention) are all green. **Known gaps, flagged rather than silently left**: (1) `packages/studio/src/app/page.tsx` (the devices list, which also feeds the Wall) is outside this step's file-ownership list and was not touched — it already has a `lease.changed` branch patching `heldBy` live (`app/page.tsx:199-211`) but no equivalent for `assist.changed`, so the devices list and Wall only pick up a NEW `assistedBy` on their next `/api/devices` fetch or `device.added`/`device.status` refresh, not live the instant a grant starts or ends; a future step should add the missing branch beside the existing one. (2) Not fixed, and not introduced by this step: `WallTile.tsx`'s root element is itself a `next/link`, and `HolderBadge` renders a `job`/`agent` holder as its own nested `<Link>` — invalid HTML (`<a>` inside `<a>`), a React hydration warning — a latent defect this step's own tests were the first to reach (no prior `WallTile` test ever exercised a `job`/`agent` `heldBy`); this step's own `WallTile.test.tsx` addition sidesteps it with a `user`-kind holder rather than silently asserting through a warning, and leaves `WallTile.tsx` itself unchanged since fixing the nesting is outside 91.6's scope. **Both closed 2026-08-13** by a later worker assigned exactly these two gaps plus a third (`DevicePicker.tsx` rendered `heldBy` via `HolderBadge` but never `assistedBy` — not previously named in this note, found alongside the other two while auditing every `HolderBadge` call site) — see `docs/plans/96-m61-hotfixes.md` §96.12 for the full account: gap (1) is now a plain `assist.changed` branch in `page.tsx`'s `ws.on` callback, mirroring `lease.changed` exactly; gap (2) is fixed by giving `HolderBadge` an `asLink` prop (default `true`, unchanged for every other caller) that `WallTile` now passes `false` — a `job`/`agent` holder renders as a plain, non-interactive `<span>` there instead of a nested `<Link>`, and `WallTile.test.tsx`'s `user`-kind workaround test is replaced with two tests using real `job`/`agent` holders, proving the fix directly rather than continuing to avoid the case. Step 91.5 (attribution, fixes F17/F19/F24) is also done, see its own checklist below: `packages/core/src/db/schema.ts` gains `jobs.assistCount` (migration `0046_watery_quentin_quire.sql`, plain `ALTER TABLE jobs ADD assist_count integer DEFAULT 0`, generated via `bun run --cwd packages/core db:generate`, never hand-written — `migration-watermark.test.ts`'s own header explains why); `packages/protocol/src/messages/job.ts`'s `JobInfoSchema` carries it (never null, `0` for every pre-existing row). `ws-handlers.ts`'s `input.*` branch resolves one `assistJobId` (null unless the source is `assist` AND the primary hold is actually a job — §3.9's "manual, held by someone else" row has no job to attribute to, correctly) right where it already resolves `source`/`touchManual`/`coControl.touch`, and: (a) increments `jobs.assistCount` with a plain `COALESCE(...,0)+1` update; (b) fires `deps.onAssist?.(assistJobId, {at, actor})`, the new optional hook that is step 91.5's own half of F20/F21's "the core tells a running job something happened" mechanism; (c) spreads `assistMeta` (`{assist: true, jobId}` or `{}`) into all five of F16's existing per-verb `recorder.record` meta objects — the ONLY change made to those five call sites. `control.assist.started`/`control.assist.ended` join `MAIN_EVENT_KINDS`, and are recorded, together with a `device.assist` audit row (the new `AuditAction` literal), from three of the four places a grant can start or end: `assist.start` ('started'), `assist.stop` ('released', only when `release()` actually returned true), and `handleClose` ('disconnected', via a new read-only `CoControlManager.grantsForClient(clientId)` — added because `releaseAllForClient` has no return value to report what it ended, called BEFORE that release so the grant's `jobId`/`primaryKind` are still known). **Known gap, flagged rather than silently left**: the remaining two `AssistEndReason`s — `ttl` and `primary_ended` — are NOT recorded as `control.assist.ended`/`device.assist`, because their only trigger point is `co-control.ts`'s reaper and `lease-manager.ts`'s `onPrimaryEnded` hook, both reaching the outside world only through `daemon.ts`'s `createCoControlManager(...)`'s `onGranted`/`onReleased` closures (today wired ONLY to `hub.broadcast({type:'assist.changed'})`, step 91.4's own work) — a file this step was told not to touch. A self-detecting test (`daemon-wiring.test.ts`, new describe block "attribution... SELF-DETECTING, currently fails on purpose") pins the exact line still needed: `onAssist: (jobId, e) => host.notifyAssist(jobId, e)` inside `createWsMessageHandler({...})` — this is a SEPARATE gap from the ttl/primary_ended one above (it is what makes `ctx.onAssist` reachable at all in a real boot), also requiring one `daemon.ts` line this step could not add itself. `GET /api/jobs/:id/assists` (`packages/core/src/api/jobs.ts`) needed no new dependency threading at all: `JobStore.assists(jobId)` (new, `queue/job-store.ts`) closes over the SAME `db` the store already has, doing the indexed range scan exactly as §3.5's SQL describes (`idx_device_events_tail(deviceId, stream, at)`, `actor IS NULL OR actor NOT LIKE 'job:%'`, no JSON extraction) and reusing `api/device-events.ts`'s `toDeviceEvent` (newly exported) rather than duplicating the row mapping; `JobService.assists(jobId)` is the one place that turns "no such job" into `job_not_found` (`jobStore.assists` itself returns `[]` for both "no assists" and "no such job"), and the route is a two-line `service.assists(id)` call — `service` was already a positional argument to `createJobRoutes`, so this needed no `JobRoutesDeps` change and no daemon.ts wiring either. `packages/session/src/runner/ipc.ts` gains `ParentToChildSchema`'s `assist` variant (the SECOND unsolicited push ever, after `abort`) and `ready`'s `assist: 'allow'|'deny'` field; `child-entry.ts` handles both directions (a module-level `assistHandlers` array delivered to on `t === 'assist'`; `BundleDef.assist` reported in `ready`); `packages/sdk/src/types.ts` gains `ScriptContext.onAssist`/`ScriptDefinition.assist`. `packages/session/src/runner/job-runner.ts` gains `RunningJob.notifyAssist`/`JobRunner.notifyAssist`, wired with a SECOND ref-cell (`assistNotifier`, alongside the existing `aborter`) through both `runAttempt` call sites (the full attempt and the finish-only retry) — deliberately NOT routed through `doAbort`: an assist is never an abort, so it skips every grace/kill timer entirely, a plain `send({t:'assist',...})`. `packages/core/src/jobs/executor.ts`'s `ExecutorContext` gains `onAssist`, mirroring `onCrash` exactly; `executor-host.ts` gains a SECOND handler map (`assistHandlers`, beside `crashHandlers`, cleared at the same two places) and `notifyAssist(jobId, e)`, shaped identically to `notifyCrash`; `executors/script.ts` registers `ctx.onAssist?.((e) => deps.runner.notifyAssist(job.id, e))` beside its existing `ctx.onCrash?.(...)` registration — **NOT independently unit-tested at this exact line**, matching the pre-existing precedent that `ctx.onCrash`'s own identical registration also has no dedicated test in `executors/script.test.ts` (the wiring is proven correct at both neighbouring layers instead: `executor-host.test.ts`'s new `notifyAssist` block, `job-runner.test.ts`'s new `notifyAssist` block, both against real-shaped harnesses). Step 91.8 (Studio: selection, the badge, the wall — Part 2's surface, fixes F11, F12) is also done, see its own checklist below: `packages/studio/src/app/page.tsx`'s `selectedIds` is migrated off a hand-rolled `Set<string>` onto a plain `string[]` feeding a new `useBulkSelection(filteredIds, selectedIds, setSelectedIds)` instance (`filteredIds` — the CURRENTLY FILTERED device list, the same "select all means what's on screen" rule `ToolsSection`/`AccessSection` in `agents/detail/page.tsx` already use) — `bulk.toggleAll`/`bulk.allChecked` back a new "Select all"/"Clear all" ghost button beside "Cancel", and both the "Select devices" toggle and the Wake/Sleep/Install/Forget toolbar are no longer gated to `view === 'list'` (F11): one shared selection array now drives List's `DeviceCard` checkboxes and the Wall's new checkboxes identically, and persists across a view switch by construction (it never got reset). `?focus=<id>` (§3.11, F13) is read straight off `useSearchParams()` — deliberately NOT mirrored into local state the way `view`/`group` are, since §3.11 itself calls the mechanism URL-driven — and written through a new `setFocus`/`router.replace`, preserving `view`/`group`. A new `packages/studio/src/components/wall/SelectionCursorBadge.tsx` is the owner's own *"mouse akan ada indikator device yang terseleksi berapa"*: mounted once by the dashboard (view-agnostic, not Wall-only, since selection now works in both), it tracks `mousemove` only while active, renders nothing at a count of zero or before the first move, and sits offset +16px/+16px from the raw cursor position AND `pointer-events-none` — structurally incapable of covering the pointer target, not merely styled to look like it tries — with its only motion a plain CSS `transition` that `globals.css`'s existing global `prefers-reduced-motion` rule already cuts to near-zero, no new media query needed. `packages/studio/src/components/wall/WallTile.tsx` gains `selectable`/`selected`/`onToggleSelect` (mirroring `DeviceCard`'s own shape) and a `selected` outline (`border-accent ring-1 ring-accent`, `docs/design.md`'s "interactive" colour rather than a status LED one); because the tile's root is itself a `next/link`, the selection toggle is a `<label>`+`<input type=checkbox>` whose own click calls `preventDefault`+`stopPropagation`+`onToggleSelect` directly rather than relying on `onChange` (which would never fire once the checkbox's native toggle is itself cancelled by that same `preventDefault`) — the identical reasoning the tile's pre-existing "Show live" button already established. Double-click (F13) is the harder half: the browser fires `click` before `dblclick`, so adding `onDoubleClick` next to a `Link` whose `onClick` already navigates would navigate away on the FIRST click of every double-click before `dblclick` could ever fire — `WallTile` now intercepts `onClick`, always calls `preventDefault()`, and defers the actual `router.push` by `DOUBLE_CLICK_WINDOW_MS` (220ms, comfortably under every OS's own double-click interval); `onDoubleClick` cancels that pending timer and calls `onFocus()` instead, and both handlers bail out (mirroring `next/link`'s own `isModifiedEvent`) on a ctrl/cmd/shift/alt/middle click, which still opens in a new tab untouched. The focused tile renders the **Controlling here** placeholder in place of `LiveView` (stops decoding — §3.11's own "the one decoder that matters moves to the focus overlay," 91.9's own component, "instead of doubling up"). `packages/studio/src/components/wall/Wall.tsx` threads `selectable`/`selectedIds`/`onToggleSelect`/`focusId`/`onFocus` straight through to each `WallTile`. Rendered Studio tests, all green: `WallTile.test.tsx` (16→27 tests) proves the checkbox (absent unless `selectable`, toggles without navigating), the selected outline, the "Controlling here" placeholder (and that an unfocused or not-live tile never shows it) — and, the pairing this step's own brief named as the one that protects the existing product, BOTH a genuine `userEvent.dblClick` (the real click-click-dblclick sequence a browser fires, unlike `fireEvent.doubleClick`'s single synthetic event) calling `onFocus` and never navigating, AND a plain `fireEvent.click` still navigating (`router.push('/device?id=…')`, proven via the `@/lib/test/nav` mock this file did not previously need — `WallTile` did not call `useRouter()` before this step). `Wall.test.tsx` gains a wiring-only block proving `Wall` passes each prop to the RIGHT tile, not merely some tile. `SelectionCursorBadge.test.tsx` (new, 7 tests) proves the inactive/zero-count/no-position-yet cases render nothing, the badge sits offset from (never at) the raw cursor position, carries `pointer-events-none`, and tracks across repeated moves. `page.test.tsx` gains a describe block (4 tests) proving selection survives a List→Wall→List round trip off the one array, the cursor badge's live count, "Select all" selecting every currently-filtered device, and a (mocked-tile) double-click setting `?focus=` on the URL via `mockRouter.replace`. `bash scripts/typecheck.sh`: studio OK (`core` carries the SAME pre-existing, unrelated `api/jobs.ts` TS2739 gap from concurrent plan-99 work — a file and an area this step never touched, confirmed by mtime and by this step's own file-ownership list). `bun test`: 3879 pass / 1 fail — the one failure is plan 99's own self-detecting workflow-resume gap (`GET /:id/nodes and POST /:id/resume`), not this step's; the `daemon-wiring.test.ts` `onAssist` guard this step's brief said to leave alone and only report on is GREEN as of this step's finish (another worker closed it during this session — `daemon.ts:2209` now reads `onAssist: (jobId, e) => host.notifyAssist(jobId, e)`, this step touched neither the line nor the file). `bun run --cwd packages/studio test`: first observed at 727 pass / 6 fail, all six in `AdbServerCard.test.tsx` — a file this step never touched and does not import anything this step changed, tracing instead to the concurrently in-flight `packages/protocol` edit (789/274 uncommitted lines in `settings.ts`/`index.ts` at that moment, a package explicitly outside this step's file-ownership list); re-run twice more after that edit settled and both came back 733 pass / 0 fail, confirming it was transient concurrent-worker noise, not a regression this step introduced. `bun run --cwd packages/studio build` (run alone, per this plan series' own convention) is green. **Known gap, flagged rather than silently left**: `?focus=` has no way to clear itself within this step — the focus overlay that reads it, offers `Esc`/a close affordance, and requests `control` quality is 91.9's own component; until it lands, a tile a double-click focused stays the "Controlling here" placeholder (correctly reflecting the URL) with no in-UI way back except editing the URL by hand, exactly matching this plan's own step boundary (91.9's checklist owns the overlay, not this one). Step 91.10 (observability, tests H2/H4) is also done, see its own checklist below, alongside closing the one deliberate-guard gap step 91.5 left for a later worker. **Task A**: `daemon.ts`'s `createWsMessageHandler({...})` call gains `onAssist: (jobId, e) => host.notifyAssist(jobId, e),` beside its pre-existing `onJobCrash` neighbour — the exact line `daemon-wiring.test.ts`'s self-detecting "attribution... SELF-DETECTING, currently fails on purpose" block named — and that describe block is flipped from pinning the absence to pinning the real wiring (plus a neighbour-anchoring assertion, the same style `onManualTakenOver`'s own block already uses), so it still fails if a future edit drops the line. **Zero deliberate-guard failures remain anywhere in the tree traceable to this plan.** **Task B**: `packages/core/src/api/adb-stats.ts` gains the `input` block exactly per §4.10 (`lanes` keyed by `InputLane`, `assistsActive`, `mirrorGroups`, `mirrorMembers`, `mirrorFanoutMsP50`/`P95`), plus two fields beyond the plan's own literal pseudocode that its remedy text needs — `queueWaitMs` (the farm's CONFIGURED `coControl.queueWaitMs`, so the doctor check compares like-for-like without a second fetch) and two leak-detector counts, `uncollectedGrants`/`orphanedMirrorGroups`. The computation itself lives in a new `inputStats()` on `ws-handlers.ts`'s returned object (the identical forward-ref pattern `transportStats()` already established, wired into `daemon.ts` the same way): every local `DeviceSession` carries its OWN three-lane arbiter (91.1) — there is no farm-wide arbiter and raw per-action wait samples never leave `input-arbiter.ts` — so `depth`/`refusals` are summed across every live session and `waitMsP50`/`waitMsP95` take the WORST (max) value observed among them, a deliberate decision documented at the call site: for H2's purpose ("is a lane's wait budget under threat anywhere on the farm"), the worst lane is the actionable number, not an average smoothed by mostly-idle devices. `co-control.ts` gains `activeGrantCount()` (pruned, farm-wide) and `rawGrantSnapshot()` (the ONE read in that file that deliberately does NOT prune first, because the entire point of the "uncollected grants" leak detector is to catch a grant the reaper has not collected yet). `mirror/group.ts` gains `allGroups()` (id/ownerClientId/memberCount, for the "orphaned" cross-reference against `ws-handlers.ts`'s own live `conns` map) and `stats()` (group/member counts plus `fanoutMsP50`/`P95`, sampled from `dispatch`'s own real wall-clock `Promise.all` duration, bounded 500 samples the same way `input-arbiter.ts`'s `MAX_WAIT_SAMPLES` is) — `dispatch`'s catch block also gained the rate-limited `E_INPUT_BUSY` warn (mirrored actions never reach `ws-handlers.ts`'s own catch, since `group.ts` already swallows a per-member failure into a `MirrorResult` rather than throwing, so the single-device warn added to `ws-handlers.ts`'s one outer catch cannot cover this path — a second, independently rate-limited warn was required, not optional). The rate limit itself is 10s per `(deviceId, lane)` key (single-device path) / `(groupId, deviceId, lane)` key (mirror path), proven with a REAL refusal — a hung `InputSink.tap` plus `maxQueueDepth: 0` forces the real arbiter to reject with a genuine `E_INPUT_BUSY`, not a synthetic error standing in for one. `packages/core/src/doctor/checks/co-control.ts` (new) reads `ctx.coControl.probe()` (a new `DoctorContext` namespace, `types.ts`/`context.ts` extended with the identical optional/`null`-degrades-to-`skip` contract `streams`/`hostAdb`/`adbHealth` already use) and reports `warn` — never `fail`, matching `streamsCheck`'s own precedent that budget pressure and a leak are both actionable-but-not-fatal — when a lane's `waitMsP95` exceeds half the configured budget, or either leak count is nonzero, naming the lane/counts in the remedy; registered in `checks/index.ts` (13→14 checks). `render.test.ts`'s "never runs adb kill-server" guard file list gains `checks/co-control.ts`, and its `unhappyContext()` fixture gains a `coControl` override that trips all three conditions at once — required, not optional, since that file's own "every check that resolves warn/fail carries a remedy" test would otherwise fail against the new check's default `skip`. **A real gap found and flagged, not fixed (outside this step's file-ownership boundary)**: `packages/session/src/manager.ts`'s `SessionManagerDeps` has no `arbiterQueueWaitMs`/`arbiterMaxQueueDepth`/`onAction` field at all — `session.ts`'s own header comment on `DEFAULT_ARBITER_QUEUE_WAIT_MS`/`DEFAULT_ARBITER_MAX_QUEUE_DEPTH` says outright that these are "stand-in defaults... used until a later step threads the real farm setting through `SessionManagerDeps` → `CreateSessionDeps`", and no later step has yet. `daemon.ts`'s own `createSessionManager({...})` call (confirmed by reading it directly) passes neither. This means `coControl.queueWaitMs`/`coControl.maxQueueDepth` — shipped in settings since 91.3, changeable from Studio — have never actually reached the real arbiter on any device session in this codebase: every session runs against the hardcoded `5_000`ms / `32` defaults regardless of what an operator configures. This step's own `input.queueWaitMs` and the `co-control` doctor check's budget comparison are therefore honest about what the operator ASKED for, not (yet) about what the arbiter actually ENFORCES — stated here rather than silently building an accurate-looking check on top of an inert setting. Closing it needs `packages/session/src/manager.ts` (and threading the accessor through `daemon.ts`'s `createSessionManager({...})` call), both outside this step's file list. Verified against a REAL running core, not only the unit-testing helpers that compute these numbers: `ENKAKU_DATA_DIR=/tmp/enkaku-91-10-verify ENKAKU_PORT=7799 bun run --cwd packages/core src/index.ts` (no device attached), `curl -s http://127.0.0.1:7799/api/adb/stats` returned the real, live `input` block verbatim (all-zero, honestly, with no device/grant/group yet), and `bun run packages/core/src/index.ts doctor` against that same live core printed `[ ok ] Assist and Mirror (co-control) pointer: depth=0 p50=0ms p95=0ms refusals=0, keys: depth=0 p50=0ms p95=0ms refusals=0, text: depth=0 p50=0ms p95=0ms refusals=0 — assists=0 mirrorGroups=0 mirrorMembers=0 queueWaitMs=5000` — the process was then killed and its death confirmed with `ps`, and the temp data dir removed. Tests, all new and passing: `co-control.test.ts` (+3: `activeGrantCount`, `rawGrantSnapshot` both overdue-but-uncollected and reaper-collected), `mirror/group.test.ts` (+3: `allGroups`, `stats`, the rate-limited mirror-path warn), `packages/core/src/doctor/checks/co-control.test.ts` (new, 8 tests), `packages/core/src/server/ws-handlers.observability.test.ts` (new, 6 tests, built the same way `ws-handlers.assist.test.ts` is — real `LeaseManager`/`CoControlManager`/`DeviceStateMachine`), `adb-stats.test.ts` (+2: zero-fill and live pass-through for `input`). **A second cross-package regression found and fixed, entirely within this step's own files**: `packages/protocol/src/api/adb.ts`'s `AdbStatsResponseSchema.input` was first added as a REQUIRED field (matching its `transport`/`hostAdb`/`adbHealth` siblings) — `bun run --cwd packages/studio test` immediately dropped from 733 pass to 727 pass / 6 fail, all six in `AdbServerCard.test.tsx`, because `AdbServerCard.tsx` parses this exact schema (`api('/api/adb/stats', AdbStatsResponseSchema)`) against a `statsBody()` test fixture this step's file-ownership boundary forbids editing (`packages/studio/**`). Fixed by making `input` `.optional()` — deliberately the one field in this schema that is, with a doc comment explaining why — since the real server ALWAYS sends it (zero-filled via `adb-stats.ts`'s own `ZERO_INPUT`, the identical contract `ZERO_TRANSPORT`/`ZERO_HOST_ADB`/`ZERO_ADB_HEALTH` already use), so nothing about what the server produces changed, only what a consumer's schema is permitted to omit; re-ran `bun run --cwd packages/studio test` and confirmed 733 pass / 0 fail, with zero edits to `packages/studio/**`. `bash scripts/typecheck.sh`: every package OK except `core`, which carries exactly one pre-existing, unrelated error — `packages/core/src/api/jobs.ts(204,49)`, a `JobNodesSummary`-shaped mismatch, reproduced twice ~20s apart at the identical line (stable, not shifting), in a file `git status` shows as currently uncommitted with a five-minutes-old mtime at the time of this check — the concurrent worker holding `jobs.ts`/`job-service.ts`/`job-store.ts`/`protocol/messages/job.ts`/`protocol/api/jobs.ts`'s own in-flight work, explicitly outside this step's file-ownership list and never touched by it. `bun test`: 3879 pass / 1 fail across three consecutive runs (one run showed a second, non-reproducing failure traced to a transient `EPERM: operation not permitted, rename` in `tools/provision.test.ts`, the exact class of concurrent-worker filesystem noise this plan series' own testing-discipline note warns about) — the one STABLE failure is plan 99's own pre-existing, self-detecting `GET /:id/nodes and POST /:id/resume` workflow-resume gap, not this step's. `bun run --cwd packages/studio test`: 733 pass / 0 fail (see the regression-and-fix account above). `bun run --cwd packages/studio build`, run alone per this plan series' own convention, is green.

**The mirror aggregate-vs-per-device decision (91.7's own flagged gap, closed here).** §4.7's literal "dispatch in full" pseudocode calls neither `recorder.record` nor `audit.record`, and 91.7 built it exactly that way, flagging the omission rather than guessing. Read against the real code, an aggregate row (one row per mirror ACTION, naming the device count) turns out to be the dishonest shape, not the cheap one: `device_events` has no field for "N devices" — every row belongs to exactly one `deviceId` — so an aggregate row parked on the focus device would leave every OTHER member's OWN Device Log tab blind to input it visibly received, and would make a mirrored assist on a job-busy member invisible to `GET /api/jobs/:id/assists`, which finds assists strictly by `deviceId`. **Decision: PER-DEVICE rows.** `MirrorManagerDeps` gains `recorder: Pick<EventRecorder,'record'>` and `incrementAssistCount: (jobId) => void`, both wired inside `createWsMessageHandler` itself (the `MirrorManager` is constructed there, not in `daemon.ts` — no daemon.ts touch needed for any of this). `dispatch`'s per-device success branch now records the SAME `kind`/meta shape the single-device `input.*` branch uses (via a new `inputEventFor(action, session)` helper, deliberately duplicating `mapNormToDevice` the same way this file's header comment already justifies for `applyAction` — importing it would make the module genuinely circular), plus `meta.mirrored: true`/`groupId`, plus `meta.assist`/`jobId` and the `jobs.assistCount` increment for an `assist`-mode member whose primary hold is a job — recorded on DELIVERY SUCCESS (inside the `try`, after `applyAction` resolves), not before like the single-device path: `dispatch` already trusts the authorization `start`/`reconcile` established, so the only thing left to report honestly is whether the action actually reached the device, and an `E_DEVICE_NOT_READY` member never did. `audit.record` is deliberately still NOT called per mirrored action, for the same reason the single-device `input.*` branch never audits routine input either — audit is for the grant/release boundary, not every tap. **Write amplification, stated plainly**: up to `mirror.maxDevices` (20 default, 64 ceiling) `device_events` rows per mirrored action, all landing in the SAME buffered-transaction recorder every concurrent human operator's input already shares (one transaction per 250ms/200-row flush, `events/recorder.ts`) — identical cost to 20 separate operators tapping 20 separate devices today, not a new scaling problem this plan introduces.

Studio: `DeviceLog.tsx` gains `control.assist.started`/`control.assist.ended` in `KIND_LABEL`/`KIND_TONE`/`summarize()` (amber for started, matching the assisting chrome's `--color-led-warn`; muted for ended). `JobsList.tsx` (the one shared job-row component, per its own header comment) gains an "assisted" pill beside the script link, shown only when `assistCount > 0`, with a tooltip naming the count. `app/jobs/detail/page.tsx` gains an "Assisted by" card in the aside (hidden entirely when `assists.length === 0`, matching the existing `hasLineage` card's own convention), fetching `GET /api/jobs/:id/assists` unconditionally alongside the job's lineage — one line per action naming the verb, the actor, and how long ago. `app/settings/page.tsx`'s `AuditSection` — F24's own target — gains `meta` on its local `AuditEntry` interface and a new `AuditRow` subcomponent with the same expandable-disclosure pattern `DeviceLog.tsx`'s `EventRow` already established (a chevron toggle, shown only when `meta` is non-empty, revealing formatted JSON) — this is what makes a `device.assist` audit row's `jobId` legible at all, not just "which device". `bash scripts/typecheck.sh` (every package OK), `bun test` (3781 pass — the only 2 failures anywhere are this step's own deliberate self-detecting `daemon-wiring.test.ts` gap above, and plan 99's pre-existing, unrelated `executor-kind-dispatch.test.ts` guard, confirmed by mtime to predate and be untouched by this step — NOTE: the file name in this step's own brief was `api/workflows-wiring.test.ts`, which now passes on its own; the plan-99 guard moved/renamed to `jobs/executor-kind-dispatch.test.ts` sometime during this session, the exact kind of drift this step's brief warned to expect), `bun run --cwd packages/studio test` (699 pass — the new `DeviceLog.test.tsx`/`jobs/page.test.tsx`/`jobs/detail/page.test.tsx`/`settings/page.test.tsx` cases all included in that count already, since 91.6 landed concurrently and left it at 699 too) and, run alone per this plan series' own convention, `bun run --cwd packages/studio build` are all green.

**Verifiable result — proven in software, hardware part pending.** The plan's own §5 step 91.5 acceptance text — "run a job, assist it three times, let it finish: `jobs.assistCount` is 3; `GET /api/jobs/:id/assists` returns exactly those three actions with the operator's id; the job detail page shows them; the audit log names the device and the job" — is proven end to end in software against REAL SQLite tables (`packages/core/src/server/ws-handlers.assist.test.ts`'s new "assist attribution" describe block: a real `jobStore`, a real `device_events` write/flush/read round trip via a real `createEventRecorder`, three real `input.tap` messages while assisting, then `jobStore.get(jobId).assistCount === 3` and `jobStore.assists(jobId)` returning exactly those three rows with `actor: 'operator-1'`) plus the Studio-side render of both the job detail card and the job-row badge (`app/jobs/detail/page.test.tsx`, `app/jobs/page.test.tsx`). **Pending — owner to run**, the one part that genuinely needs a physical device (never attempted by this step, per this plan's own hardware-honesty rule):

1. `bun run dev` (core on :7700) and `bun run dev:studio` (Studio on :3001), a real enrolled device.
2. Publish or run any script that holds the device for at least a minute (e.g. `internal:sleep` with `durationMs: 90000`) — `POST /api/jobs` or the Run dialog.
3. While it runs, open the device page as a SECOND browser session (or an incognito window, to get a second `clientId`), click **Assist**, confirm the dialog, and send three taps/keys through the live canvas.
4. Let the job finish naturally.
5. Check, in order: `GET /api/jobs/:id` → `assistCount: 3`; `GET /api/jobs/:id/assists` → three items, `actor` naming the operator; the job detail page's **Assisted by** card lists the same three; Settings → Audit shows two `device.assist` rows (started, ended) whose expanded `meta` names the job.

| Step | Expected | Observed |
|---|---|---|
| 1–4 | job runs ~90s, assisted 3× mid-run | *(owner to run)* |
| 5a `assistCount` | `3` | *(owner to run)* |
| 5b `/assists` | 3 items, operator's id | *(owner to run)* |
| 5c job detail card | 3 rows shown | *(owner to run)* |
| 5d audit log | 2 `device.assist` rows, `meta.jobId` matches | *(owner to run)* |

**Verifiable result (91.10) — proven in software; the "under a real assist" hardware half pending.** The plan's own step 91.10 acceptance text — "`GET /api/adb/stats | jq '.input'` reports per-lane depth and percentiles under a real assist, and `enkaku doctor` reports a clean co-control section" — is proven in two layers. First, against a REAL running core with no device attached (2026-08-13, `ENKAKU_DATA_DIR=/tmp/enkaku-91-10-verify ENKAKU_PORT=7799 bun run --cwd packages/core src/index.ts`): `curl -s http://127.0.0.1:7799/api/adb/stats` returned the live `input` block verbatim, and `bun run packages/core/src/index.ts doctor` against that same core printed `[ ok ] Assist and Mirror (co-control) pointer: depth=0 p50=0ms p95=0ms refusals=0, keys: depth=0 p50=0ms p95=0ms refusals=0, text: depth=0 p50=0ms p95=0ms refusals=0 — assists=0 mirrorGroups=0 mirrorMembers=0 queueWaitMs=5000` — a clean co-control section, read from the real HTTP surface, not the helper that computes it. Second, the mechanisms that need real INPUT TRAFFIC (not just a running core) to move off zero — lane depth/wait percentiles, the budget warn, the two leak detectors, the rate-limited `E_INPUT_BUSY` warn — are proven against the real production code path in `ws-handlers.observability.test.ts` and `mirror/group.test.ts`, including a genuinely refused action (a hung `InputSink.tap` plus `maxQueueDepth: 0`), not a synthetic error standing in for one. **Pending — owner to run**, the parts that genuinely need physical devices (never attempted by this step, per this plan's own hardware-honesty rule):

1. `bun run dev` (core on :7700), at least two enrolled devices (one to assist, one or more to mirror).
2. Publish/run a script holding the first device for at least 60s (`internal:sleep`, `durationMs: 60000`).
3. While it runs, assist it (as in 91.5's own pending steps above) with a rapid burst of taps/swipes — enough that the pointer lane actually queues at least once (a single isolated tap will not).
4. Separately, start a mirror group across the other device(s) (`mirror.start`) and send a few `input.mirror` actions (`mirror.maxDevices` from the default settings is enough headroom).
5. `GET /api/adb/stats | jq '.input'` — confirm `lanes.pointer.depth`/`waitMsP50`/`waitMsP95` moved off zero during step 3's burst, and `mirrorGroups`/`mirrorMembers`/`mirrorFanoutMsP50`/`mirrorFanoutMsP95` reflect step 4's group.
6. `enkaku doctor` immediately after — a healthy, everyday assist/mirror session must NOT trip the lane-budget warn; confirm the co-control section still reads `ok`.
7. Deliberately leave a browser tab open with an active mirror group, then kill that tab's process abruptly (not a clean window close, e.g. `kill -9` the browser process or pull the network) rather than clicking away — this is the one scenario `stopAllForClient`'s ordinary WS-close cleanup does NOT reach. Re-run `enkaku doctor` and confirm the co-control section now `warn`s, naming `orphanedMirrorGroups`; reconnect (or wait for the group's own natural end) and confirm it clears back to `ok`.

| Step | Expected | Observed |
|---|---|---|
| 5 lane stats move | `lanes.pointer.depth`/`waitMsP50`/`waitMsP95` > 0 during the assist burst | *(owner to run)* |
| 5 mirror counts | `mirrorGroups`/`mirrorMembers` match the group started in step 4 | *(owner to run)* |
| 6 healthy session stays clean | doctor's co-control line stays `ok` through an ordinary assist/mirror session | *(owner to run)* |
| 7 orphan leak detected | doctor's co-control line `warn`s, naming `orphanedMirrorGroups`, after the abrupt tab kill | *(owner to run)* |
| 7 orphan leak clears | doctor's co-control line returns to `ok` once the group ends | *(owner to run)* |

**Known gap, flagged rather than silently left (outside this step's file-ownership boundary)**: `packages/session/src/manager.ts`'s `SessionManagerDeps` has no `arbiterQueueWaitMs`/`arbiterMaxQueueDepth`/`onAction` field, and `session.ts`'s own header comment on `DEFAULT_ARBITER_QUEUE_WAIT_MS`/`DEFAULT_ARBITER_MAX_QUEUE_DEPTH` says outright these are "stand-in defaults... used until a later step threads the real farm setting through `SessionManagerDeps` → `CreateSessionDeps`" — no step has yet, `daemon.ts`'s own `createSessionManager({...})` call passes neither. `coControl.queueWaitMs`/`coControl.maxQueueDepth` (settings.ts, shipped since 91.3, changeable from Studio) have therefore never reached the real arbiter on any device session in this codebase — every session runs against the hardcoded `5_000`ms/`32` defaults regardless of farm configuration. This step's `input.queueWaitMs` and the `co-control` doctor check's budget comparison are honest about what the operator ASKED FOR, not yet about what the arbiter actually ENFORCES. Fixing it needs `packages/session/src/manager.ts` plus a `daemon.ts` accessor — the former outside this step's file list.

**Closed 2026-08-13** — see `docs/plans/96-m61-hotfixes.md` §96.13 for the full account. `SessionManagerDeps` gained `arbiterQueueWaitMs`/`arbiterMaxQueueDepth` (both `() => number`, forwarded unresolved into `CreateSessionDeps`, never captured), and `daemon.ts`'s real `createSessionManager({...})` call now passes `arbiterQueueWaitMs: () => settingsStore.get().coControl.queueWaitMs` / `arbiterMaxQueueDepth: () => settingsStore.get().coControl.maxQueueDepth`, beside the existing `idleTtlSec`/`maxIdleSessions` accessors. `coControl.queueWaitMs`/`coControl.maxQueueDepth` now reach every real session's arbiter, read fresh on every submission (a setting changed while a session is already open takes effect for that same session immediately — proven, not assumed, by `packages/core/src/daemon-wiring.test.ts`'s new "input arbiter settings" block, which builds a real `SessionManager` wired the way `daemon.ts` wires it and mutates the "farm setting" after the session is already acquired). §96.13 also separately investigated the `onAction` seam this paragraph named alongside the two accessors above: it had no producer (no field on `SessionManagerDeps`/`CreateSessionDeps` was ever wired to it, by anyone) and no consumer (attribution, §3.5, was built through `ws-handlers.ts`'s own inline `recorder.record` calls instead, never through this callback) — genuinely dead code, not merely unwired, so it was removed rather than wired to a producer nothing would have consumed. `coControl.maxConcurrentPerDevice` — a THIRD setting this paragraph did not name — was checked during the same pass and found to be unrelated to the arbiter entirely (it bounds `CoControlManager`'s concurrent assist-grant count, `packages/core/src/lease/co-control.ts`) and already fully wired via `daemon.ts:1090`'s `createCoControlManager({...})` call since step 91.2/91.4 — no gap there.

**Step 91.9 (Studio: the focus overlay and the function rail, Part 3) is also done — DONE 2026-08-13**, see its own checklist below. `packages/studio/src/components/wall/FocusOverlay.tsx` (new) is the thing 91.8's own flagged gap named: `?focus=` now has a way to close itself. It is deliberately NOT a `Dialog` — no `AlertDialog`/`Dialog` wrapper, no focus trap, no full-screen backdrop — a plain `fixed`, centred, natively-resizable (`resize` + explicit `width`/`height`, not `inset-*` on all four sides, which would fight the browser's own resize handle) panel floating over the still-live, still-mounted Wall, rendered by `app/page.tsx` only when `view === 'wall' && focusId`. **The Esc-vs-BACK collision, resolved without touching `LiveView`'s own binding**: a `window`-level `keydown` listener closes the overlay on `Escape` UNLESS `e.defaultPrevented` is already `true` — which it is precisely when `LiveView`'s own `onKeyDown` (bound to the canvas element, itself only reachable when `inputEnabled` is true and the canvas has focus) already turned that same keystroke into `BACK` and called `preventDefault()` first. Because React 17+ delegates synthetic events at the tree's root — strictly upstream of the canvas but strictly downstream of `window` in bubble order — the root's (and therefore the canvas's) handler always runs before this component's own `window` listener sees the event, so checking `defaultPrevented` is a complete, accurate answer with no coupling to `LiveView`'s internals at all; proven in both directions by `FocusOverlay.escape.test.tsx` against a REAL (unmocked) `LiveView`, not merely asserted. **Quick control, not a takeover**: §3.11's own nine-item rail table has no "Take control" entry, so an idle focus device is claimed automatically on open (`lease.acquire`, no confirmation — mirroring the owner's own "double-click to focus remote control" instruction, §0.3) and a device already held by a job or another person is never auto-claimed or taken over from here — Assist, reusing `AssistDialog`/`ScreenCard`'s established chrome verbatim (not reimplemented), is the only way in. **The rail's nine items, F26 in practice**: Back/Home/Recents, Power/Volume/Mute, Wake/Sleep and Clipboard need no new code at all — they are already inside `LiveView`'s own non-`compact` chrome, and rendering an ordinary `<LiveView quality="control">` here IS the reuse; Rotate is `RotationQuickAction`, placed in the sidebar unchanged; Open full device page is a plain `next/link`. Only Assist, Mirror (on/off + live member count + the per-action result strip) and End task are new, exactly the plan's own exception list. **Mirror fan-out required one deliberate, additive change to `LiveView.tsx`** (in-scope: it is one of this step's three owned files): a new optional `mirror?: { groupId, solo, onResult }` prop. When present, the single function every pointer/key send already funnelled through in spirit but not in code (`sendInputAction`, new) routes the SAME action through one `input.mirror` envelope instead of `input.<verb>`, per §3.8's "the browser sends one message regardless of member count" — `text` is handled by its own branch in `flushText` for the same reason (the single-device path's request/reply text-ladder result has no equivalent when the action fans out to N devices, each potentially resolving a different rung). `clipboard.set` is untouched and never routed through this prop — §3.10 forbids mirroring it structurally, and this file does not create a path around that. Every pre-existing caller (`ScreenCard`, `WallTile`) passes no `mirror` prop at all, so `mirror ? ... : ordinary single-device send` is unreachable-when-absent, not merely usually-false — the full pre-91.9 studio test suite (733 tests) stayed green with zero changes needed to any of them. Solo (§3.9) is `Alt` held (tracked via `window` keydown/keyup/blur listeners, cleared on blur so an Alt-Tab away never leaves it stuck) OR the rail's own "Focused only" `Switch`, either narrowing ONE dispatched action to `soloDeviceId: deviceId` without leaving Mirror mode. **The result strip is the thing 91.7's own per-device-result guarantee becomes visible to a human**: `LiveView`'s `mirror.onResult` callback (fired from its own `ws.on` subscription on `input.mirror.result`, matched by `groupId` via a ref to dodge the same stale-closure trap `iHoldControlRef` already documents in `app/device/page.tsx`) is forwarded straight to the rail's own state, rendered as `{ok}/{total}`, click-to-expand naming the failed device labels and their refusal codes — never silently absorbed. Turning Mirror on opens a group confirmation (`AlertDialog`, the same controlled-externally shape `app/jobs/detail/page.tsx`'s own cancel-with-descendants dialog already uses, not the generic `ConfirmDialog`, whose self-managed `open` state does not compose with a `Switch`-driven open) naming the candidate count and a client-side estimate of the free/assist/skipped split (from `DeviceInfo.status`, honest about being an estimate — the REAL per-device resolution is `mirror.start`'s own response, read the moment it lands). Closing the overlay (unmount, not merely switching focus to a different tile within it — a Mirror group is a property of the whole panel session, not of whichever member happens to be on screen) sends `mirror.stop` for any group still open, so no group outlives the panel driving it, the client-side counterpart of 91.10's own "orphaned mirror groups" leak detector. **Verifiable result, proven exactly as specified, not merely asserted**: `FocusOverlay.test.tsx`'s own decoder-count test mounts 8 REAL (unmocked at the composition level — only `LiveView` itself is stubbed to record every mount) `WallTile`s at `live=true`, one of them `focused` to match the overlay's own `deviceId`, alongside a real `FocusOverlay` for that same device, and asserts exactly 8 distinct `LiveView` mounts total, with the focused device's own id appearing exactly once (from the overlay, never from its own now-suppressed tile) — the plan's own "8 tiles live, opening the overlay leaves the browser decoding 8 streams, not 9" acceptance, read off a mount count rather than a screenshot. `bash scripts/typecheck.sh`: every package OK except `core`, which carries exactly one pre-existing, unrelated error at the time of this check — `packages/core/src/api/jobs.ts(204,49)`, the same `JobNodesSummary`-shaped mismatch 91.8's own account already named, in a file this step's file-ownership list explicitly forbids touching and never touched (an earlier `typecheck` run mid-session also showed several unrelated `runtime`-property errors in `packages/core/src/plugins/runtime.test.ts`/`schedules/runner.test.ts`/`scripts/bundle-cache.test.ts`/`scripts/registry.test.ts` — all in files `git status` shows as uncommitted, concurrent-worker noise that had resolved itself by the next run, exactly the drift this plan series warns to expect). `bun test`: 3933 pass / 0 fail (up from the 3879/1 baseline this step inherited — the one previously-known failure, plan 99's workflow-resume gap, was closed by a concurrent worker during this session; confirmed stable across three consecutive runs). `bun run --cwd packages/studio test`: 757 pass / 0 fail against this step's own three files alone (up from the 733 baseline) — 24 new tests across `FocusOverlay.test.tsx` (15, `LiveView` mocked — loading/chrome, quick control, Assist, Mirror on/off/confirm/count/result-strip/stop-on-unmount, End task, and the decoder-count verifiable result), `FocusOverlay.escape.test.tsx` (2, `LiveView` real — both directions of the Esc/BACK precedence), and `LiveView.test.tsx` (new, 7 — the `mirror` prop's own direct coverage: a tap/keycode/typed-text action routes through one `input.mirror` envelope instead of `input.<verb>` while a group is set, `soloDeviceId` is added only when solo is on, `input.mirror.result` reaches `onResult` only for the matching `groupId`, `clipboard.set` is never routed through it, and the ordinary no-`mirror`-prop path is unchanged — proving the change LiveView.tsx itself carries, not only that `FocusOverlay` passes the right prop). One flake found and fixed DURING this step, not left for the owner: `FocusOverlay.test.tsx`'s End-task test originally waited only for the confirmation `AlertDialog` to unmount, which occasionally missed its default `waitFor` window under this session's heavy concurrent-worker CPU load (reproduced twice across ~15 repeated runs); fixed by waiting on the `POST /api/jobs/:id/cancel` call itself first (the direct signal) before the dialog's own animated unmount, confirmed stable across 5 further consecutive full-suite runs. By the time of the LAST full run (other workers' concurrent, unrelated Studio test files landing throughout this session), the whole `packages/studio` suite read 770 pass / 0 fail. `bun run --cwd packages/studio build`, run alone per this plan series' own convention, is green — one transient failure was observed and is recorded here rather than hidden: a concurrent worker's own `app/workflows/page.tsx` (plan 99, entirely outside this step's file-ownership list) briefly had a real `tsc` error mid-edit, made the build fail once, and was gone on an immediate re-run — the same class of collision `00-overview.md`'s testing-discipline note warns this step's brief to expect, not a regression this step introduced.

**Verifiable result (91.9) — proven in software; the physical-wall part pending, per this plan's own hardware-honesty rule (never attempted by this step).**

1. `bun run dev` (core on :7700) and `bun run dev:studio` (Studio on :3001), at least 8 enrolled devices, some idle and at least one running a long script (`internal:sleep`, `durationMs: 90000`, on at least one).
2. Open the Wall (`/?view=wall`). Confirm 8 (or `wall.maxTiles`) tiles are live.
3. Double-click an IDLE tile. Confirm the overlay opens, the tile behind it switches to the "Controlling here" placeholder, and a tap/swipe/key press on the overlay's canvas reaches the real phone with no confirmation dialog (quick control, §3.11).
4. Double-click the BUSY tile instead (close the first overlay via `Esc` or the × button first). Confirm the pre-assist banner naming the running script, that input is off until Assist is confirmed, and that confirming flips it on.
5. Select 3+ idle devices on the Wall (checkboxes), double-click one of them to focus it, then toggle Mirror on in the rail. Confirm the group confirmation names the count, and after confirming, a tap on the focused device's canvas visibly reaches all 3 phones' screens.
6. Hold Alt and tap again — confirm only the focused phone reacts, not the other two.
7. Release Alt, tap again — confirm all 3 react again, and the result strip reads `3/3`.
8. Click End task on the device from step 4 (if still assisting a running job) — confirm the job stops and the banner clears.
9. Press `Esc` while the canvas has focus and input is enabled — confirm Android's own Back navigates on the phone and the overlay stays open. Click elsewhere in the overlay (off the canvas) and press `Esc` again — confirm the overlay closes this time.

| Step | Expected | Observed |
|---|---|---|
| 3 quick control | idle tile → instant working canvas, tile shows placeholder | *(owner to run)* |
| 4 Assist gate | busy tile → banner, input off until confirmed | *(owner to run)* |
| 5 mirror fan-out | one tap visibly reaches all 3 selected phones | *(owner to run)* |
| 6 solo (Alt) | only the focused phone reacts | *(owner to run)* |
| 7 result strip | reads `3/3` after an all-succeed action | *(owner to run)* |
| 8 End task | job stops, banner clears | *(owner to run)* |
| 9 Esc precedence | canvas focused → Back on phone, overlay stays; canvas unfocused → overlay closes | *(owner to run)* |

**Step 91.11 (documentation and spec) is done, 2026-08-13 — this plan's last step.** This step touches only documentation: `docs/spec.md`, this plan document, `docs/plans/00-overview.md`, `packages/session/README.md`, `packages/core/README.md`, `docs/guide/install.md` — no source file was edited, per this pass's own explicit instruction (three concurrent workers held `daemon.ts`, `clusters/dispatch.ts`, `queue/**`, `services/**`, `protocol/**`, `studio/**` at the time).

`docs/spec.md` §10.1's busy-rejection sentence is amended **verbatim** per this plan's own §3.4 text: "unless that client holds a co-control grant on the device (§10.5), which authorises the five manual input verbs and nothing else." A new §10.5 ("The co-control grant (Assist)") states what the grant is (a third authorisation object, not a lease variant, not a `DeviceStatus` value), what it grants (exactly five input verbs, proven by the containment test), what it explicitly does not do (five bullet points: never changes `DeviceStatus`, never touches the lease, is never a takeover, is not the reach of a shell, defaults to one concurrent assister), its gating (the farm switch plus the permission plus the per-script opt-out), and its five-path lifetime (TTL, WS close, voluntary release, the primary hold ending the ordinary way, and a lease takeover — named as five, not the `co-control.ts` doc comment's own "four," because the takeover path is a fifth wiring point 91.2's worker found and added, distinct from the "primary hold ending" bucket the doc comment groups it under) — closing with the Mirror paragraph, since Mirror rides on the identical grant mechanism rather than a second lock. §11.3 gains a full paragraph naming the third actor (an assisting operator, holding no lease at all) beside the script author and the leased operator, stating plainly that its reach is five input verbs and never a shell, and citing the same structural proof (the containment test) rather than a policy promise. §12.4's pre-existing terse Assist bullet (added by an earlier reconciliation pass, which is why `spec:check` was already GAP 0 before this step touched anything) is lightly rewritten to point at §10.5/§11.3 instead of standing alone. `bun run spec:check` reports **GAP 0** both before and after this step's edits — verified by running it prior to any change, confirming the pre-existing stub already satisfied the mechanical name-presence check, and again afterward to confirm the fuller sections did not somehow regress it.

`packages/session/README.md` **did not exist before this step** (only `adb`, `core`, `drivers`, `node`, `probe-server`, `sdk`, `studio`, `toolchain` had one) — created new, documenting the input arbiter's three lanes and why (the table from §3.3, the non-preemptive priority rule, the bounded-and-named refusal), `DeviceSession.arbiter`'s wiring (including the `arbiterQueueWaitMs`/`arbiterMaxQueueDepth` gap 91.10 itself flagged and its 2026-08-13 closure, `docs/plans/96-m61-hotfixes.md` §96.13), and a short note on `orientation.ts` since it is this package's other new top-level file this session (untracked in git status at the start of this pass). It states explicitly, per this task's own fact-check: **there is no `onAction` callback** in the shipped arbiter — `input-arbiter.ts`'s own header comment already records that the original sketch was removed 2026-08-13 as dead code (no producer, no consumer; attribution went through `ws-handlers.ts`'s inline recorder calls and `mirror/group.ts`'s own `dispatch` instead) — confirmed by reading `src/input-arbiter.ts` directly rather than trusting the plan's own §4.1 draft, which still shows the `onAction` field in its code sketch.

`packages/core/README.md` gains a new "Co-control (Assist) and mirror groups (plan 91)" section (appended after the existing "Connection..." plan-88 section, matching this README's running plan-by-plan structure): the grant's shape and its five end-paths (cross-referencing the takeover finding the same way spec.md's §10.5 does), the containment test, attribution (`jobs.assistCount`, `GET /api/jobs/:id/assists`, the `device.assist` audit rows and which two end reasons are NOT audited and why), mirror groups' resolution table and per-lane orientation gate, **the per-device-not-aggregate recording decision** with `mirror/group.ts`'s own reasoning restated (an aggregate row has no honest single `deviceId` to live under, and would leave every non-focused member's own Device Log blind — closed by 91.5, not 91.7, which flagged the gap and left it), the write-amplification honesty note, a table of the real `coControl`/`mirror` settings and their real defaults (checked directly against `packages/protocol/src/settings.ts` rather than transcribed from this plan's own §4.5 draft — all five `coControl` fields and all four `mirror` fields match the draft's defaults exactly, so no correction was needed there, only confirmation), and the `GET /api/adb/stats` `input` block plus the `enkaku doctor` co-control check.

`docs/guide/install.md` gains two new sections between "The guest agent" and "adb endpoint (power users)": **"Assisting a running job"** (what Assist is, that it does not pause or take the job's lease, the 5-minute idle TTL, one assister at a time, where the record of it shows up — the job detail page's Assisted-by card, the assist-count badge, the audit log — and the two switches that gate it) and **"Controlling many devices"** (selecting on the Wall, the cursor badge, double-click to open the focus panel, quick control vs. the Assist confirmation, the Mirror toggle and its group confirmation naming the lease/assist/skipped split, the orientation-mismatch withholding, the "driving by sight, not by proof" honesty note with the Solo/Alt escape hatch, the per-action result strip's "never silent" guarantee, and what Mirror deliberately does not carry — verified against real Studio label strings, `"Select devices"`/`"Select all"`/`"Clear all"`/`"Controlling here"`/`"Focused only"`, rather than invented copy). The claim that bulk install already has its own reported path was checked against the real code (`InstallBatchDialog.tsx`, F27) before being stated as fact, and the claim that shell/clipboard/reboot do NOT yet have one was checked against plan 93's own status line (`> Status: not started`) rather than assumed from this plan's §3.10 non-goals table alone — an earlier draft of this section overclaimed all four had a bulk path and was corrected before this step finished.

`docs/plans/00-overview.md` §2 gains one row for this plan, positioned after plan 86's row (the table's last existing row; plans 79–83/85/87–99 are not yet in this table at all, which is a pre-existing gap this step's scope did not include closing — only "a row for this plan" was asked for).

**Facts double-checked against the code rather than transcribed from the plan's own draft text, per this pass's explicit instruction that the plan text is stale in places:**
1. The containment test's five refused surfaces and their shared `device_busy` code were read directly from `packages/core/src/server/ws-handlers.assist.test.ts` (`shell.exec`, `inspect.attach`, `clipboard.set`, `POST /:id/push`, `POST /:id/adb-endpoint`), not copied from §4.3's prose.
2. The five-not-four end-reason count was derived from reading `lease/co-control.ts`'s own header comment (which still says "four independent paths") alongside `lease-manager.ts`'s `onManualTakenOver`/`onPrimaryEnded` wiring and `daemon.ts:1026-1059`, confirming the takeover path is real, separately wired, and not one of the doc comment's original four categories.
3. `mirror/group.ts`'s own header doc comment was read for the per-device-recording reasoning rather than re-deriving it from §4.7.
4. `onAction`'s removal was confirmed by reading `input-arbiter.ts`'s current header comment directly, which names `docs/plans/96-m61-hotfixes.md` §96.13 as the removal record.
5. The three-rung (not four-rung) text ladder is plan 90's own subject, not this plan's — checked (`docs/plans/96-m61-hotfixes.md` §96.7/§96.8) only to make sure nothing written here contradicts it; nothing in this step's own additions mentions the text ladder at all.
6. `packages/protocol/src/settings.ts`'s real `coControl`/`mirror` blocks were read directly (line-for-line against the plan's §4.5 draft) rather than assumed identical.

**One drafting correction made during this step, recorded rather than silently fixed:** the install guide's first draft of "Controlling many devices" claimed a shell command, clipboard paste, install, and reboot each already had "their own reported, confirmed path elsewhere in Studio" — checking plan 93 (`93-m58-command-console-and-bulk-operations.md`, `> Status: not started`) showed that is true only for bulk install (`InstallBatchDialog.tsx`/F27); the sentence was rewritten before publishing to name only the one that is real today and to say plainly that the other three are expected, not shipped.

**Conditions flagged in this pass's own brief, checked directly rather than assumed:** `bash scripts/typecheck.sh` still fails at `packages/core/src/api/jobs.ts` — the pre-existing duplicate-schema defect the brief named, confirmed still present (its line number drifted between runs, 204→213, confirming active concurrent edits) — a defect the repo owner is arbitrating, not this step's. The `bun test` case the brief warned might still be failing as a deliberate self-detecting guard pinning a `daemon.ts` line — checked directly, and it was **already green** by the time this step ran: a concurrent worker closed that line during this same session (see 91.5's own status paragraph above, and Task A of 91.10's, both of which independently confirm the same `onAssist` wiring landing). This step's own full verification run (below) additionally found a **second, currently-failing** typecheck error in `clusters/dispatch.ts`, not named in the brief — reported there rather than silently folded into "the one known issue." Neither is fixed by this step, and neither traces to any file this step touched (`docs/spec.md`, this plan document, `docs/plans/00-overview.md`, `packages/session/README.md`, `packages/core/README.md`, `docs/guide/install.md` — all pure documentation).

**Verified, this step's own pass, 2026-08-13, and re-verified after the tree kept moving under it (this workspace has multiple concurrent workers active, per this pass's own brief):** `bun run spec:check` — **GAP 0**, checked before and after this step's edits, unchanged. `bash scripts/check-plan-status.sh` — **passes** ("every plan that declares an artefact agrees with the code"; this plan itself prints as `PARTIAL`, kept there deliberately rather than `implemented`, since its own leading status word is what routes it past the script's exists-on-disk check for a multi-artefact `Ships:` line — see the note on why `partial` was kept, above).

`bash scripts/typecheck.sh` — **fails**, run three times across this step's own pass, stable on **two** errors, neither this step's and neither in a file this step's allowlist permitted touching: every package OK except `core`, which fails at (1) `packages/core/src/api/jobs.ts` — the pre-existing `TS2739` `JobNodesSummary`-shaped mismatch this pass's brief named up front, whose line number **moved between runs** (204 → 213), confirming the file is being actively edited by the concurrent session arbitrating it, exactly as the brief said; and (2) `packages/core/src/clusters/dispatch.ts`/`dispatch.test.ts` — a **second, previously-unseen** `TS2741` (`Property 'runtimeOverride' is missing`), reproduced identically on three separate runs several minutes apart, in the exact file this pass's brief named as held by a concurrent worker (plan 98's `runtime`/`maxConcurrent` resolution work landing on the `jobs` row shape faster than `clusters/dispatch.ts`'s own callers were updated for it) — not this step's file, not this step's regression, reported here because this step's own brief asks for anything found while reading to be reported rather than silently absorbed into "pre-existing."

`bun test` — **volatile across this same window**, consistent with the same concurrent editing: an early re-run read **3943 pass / 17 fail**, every failure inside `services/job-service.test.ts`/`api/jobs-workflow-resume.integration.test.ts` (plan 98/99's own `runtime`/`resume` surface, not this step's); re-running those two files in isolation 20s later came back **39 pass / 0 fail**, and a full re-run immediately after read **3963 pass / 0 fail** — confirming transient concurrent-worker noise catching a schema mid-edit, not a regression this step introduced (this step touched no source file at all). The self-detecting `daemon.ts`-line guard this pass's own brief flagged as possibly still red had already gone green by the time this step started (a concurrent worker closed the line it pins during this same session).

`bun run --cwd packages/studio test` — **804 pass, 0 fail**, ~1795 `expect()` calls across 107 files, stable across two runs. No source file was touched by this step, so none of the volatility above is a surprise: every number reflects the tree this step found at the moment it looked, not a change this step made to it.
> Depends on: Plan 04 (the state machine, lease and queue this amends), Plan 18 (the device event log the attribution is written to), Plan 26 (the `shell.mode` + role-permission pattern the farm switch copies), Plan 42 (the Wall and the shared idle session), Plan 71 (`heldBy`, and the takeover dialog whose copy this plan's confirmation is modelled on), Plan 85 (the transport budget and the `/api/adb/stats` instrumentation the fan-out is argued against). None of them has to change first.
> Spec references: §9 (input injection modes), §10.1 (the device state machine, and "control messages are rejected while `busy`" — **amended by this plan**, §3.4), §10.2 (lease plus heartbeat), §11.3 (trust model: the authenticated leased operator is a trusted operator), §13 (the Core ⇄ Studio protocol), §16 (NFR targets)
> Ships: packages/session/src/input-arbiter.ts, packages/core/src/lease/co-control.ts, packages/core/src/server/ws-handlers.ts (input.* fallback, assist.start/assist.stop, mirror.start/mirror.stop/input.mirror, inputStats()), packages/core/src/api/devices.ts (assistedBy), packages/core/src/mirror/group.ts (mirror groups), packages/core/src/api/adb-stats.ts (the input block), packages/core/src/doctor/checks/co-control.ts, packages/studio/src/components/device/AssistDialog.tsx (the §3.12 confirmation), packages/studio/src/components/device/ScreenCard.tsx (the pre-assist banner and the assisting chrome), packages/studio/src/components/wall/FocusOverlay.tsx (the focus overlay and function rail), packages/studio/src/components/LiveView.tsx (the `mirror` prop, §3.8's fan-out)

---

## 0. Evidence

Written from the code. Every claim is either **CONFIRMED** (a file and a line
says so) or **HYPOTHESIS** (a mechanism that fits, has not been observed, and
is therefore instrumented in §5 before anything is built on it).

The two things this plan is built from are the owner's own words, quoted in
§0.3, and the gap map's verdict on item 11 — *"Structurally absent, not just
missing UI"*.

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | `checkInputAllowed(deviceId, clientId)` is the single input gate, and it is consulted by **six** call sites whose blast radii are wildly different: manual input, an inspector dump, a clipboard write, a free-form shell command, file transfer, and a whole adb endpoint. Widening it widens all six at once. | `packages/core/src/lease/lease-manager.ts:279-299`; callers `packages/core/src/server/ws-handlers.ts:963` (`shell.exec`), `:1133` (`input.*`), `:1241` (`inspect.*`), `:1439` (`clipboard.set`), `packages/core/src/api/transfer.ts:81`, `packages/core/src/api/adb-endpoint.ts:68` |
| **F2** | Two more callers pass the **lease holder's own** clientId rather than the caller's, using the gate purely as a device-status test. They would silently inherit any widening of it. | `packages/core/src/api/guest-agent.ts:778`, `packages/core/src/api/device-identity.ts:90` |
| **F3** | `busy` short-circuits **before the lease is read at all** — status alone returns `device_busy`. Today no client of any kind can send input to a device a job holds. | `packages/core/src/lease/lease-manager.ts:282-284` |
| **F4** | Leases are exclusive per-device CAS locks. A job's hold is never takeable, whatever a client passes. | `acquireManual` `packages/core/src/lease/lease-manager.ts:163-226`; the `busy` refusal `:171-175`; the compare-and-swap `:176-209`; `toHolder` sets `takeable: false` for `kind: 'job'` `:44-53` |
| **F5** | **There is exactly one `DeviceSession` per device, shared by every viewer and refcounted.** A job running on a phone and an operator watching it already hold the same `InputSink`. Co-control needs no new transport, no second session, no second video stream. | `packages/session/src/manager.ts:64-77`, `:246-288`, `:309-311` |
| **F6** | **The `InputSink` has no serialisation of any kind, and every pointer action is a multi-write sequence over one shared virtual pointer (`UHID_POINTER_ID = 1`).** A tap is `write(down)` → `await Bun.sleep(hold)` → `write(up)`; a swipe is down + N moves + up; a gesture is down + up to 300 moves + up. Two overlapping callers interleave on one pointer. | `packages/drivers/src/input/scrcpy-input.ts:4`, `:49-54` (tap), `:56-72` (swipe), `:90-108` (gesture), and the UHID overrides `:168-180`, `:182-196`, `:205-225` |
| **F7** | Video keeps running while a device is `busy` (spec §10.1) and Studio disables input **purely by prop** — `LiveView` never reads a lease or a status itself. | `packages/studio/src/components/LiveView.tsx:66-99`, and every input path early-returns on it: `:295`, `:305`, `:317`, `:385`, `:405`. Computed at `packages/studio/src/app/device/page.tsx:372` — `inputEnabled = iHoldControl && !busy` |
| **F8** | **Coordinates are already normalised 0..1 on the wire.** The client normalises against the *displayed* size and clamps; the core maps to device pixels per device. This is the single most important fact in Part 2. | `packages/protocol/src/messages/input.ts:3-6`, `:7`, `:42-47`; client `packages/studio/src/components/LiveView.tsx:285-292`; core `packages/core/src/server/ws-handlers.ts:105-112` |
| **F9** | `session.frameSize` is that device's **latest** frame dimensions, rewritten on every rotation or resize — so `mapNormToDevice` is already rotation-correct *per device*. | `packages/session/src/session.ts:78-79`, `:386-395`, `:428`; call sites `packages/core/src/server/ws-handlers.ts:1161`, `:1171-1172`, `:1186` |
| **F10** | Every `input.*` message carries exactly one `deviceId` and resolves to exactly one session. There is no fan-out anywhere in the core, the session manager, or Studio. | `packages/core/src/server/ws-handlers.ts:1126-1141`; `packages/session/src/manager.ts:309-311` |
| **F11** | The wall tile hard-codes `inputEnabled={false}`, and multi-select is hidden entirely in Wall view. There is no wall-level input surface to extend. | `packages/studio/src/components/wall/WallTile.tsx:94`; `packages/studio/src/app/page.tsx:384` |
| **F12** | Multi-select exists only on the devices **list**, hand-rolled as a `Set<string>`, and does not use the repo's own tri-state helper. Its bulk toolbar is Wake / Sleep / Install / Forget. | `packages/studio/src/app/page.tsx:85-87`, `:306-317`, `:532-561`; checkbox `packages/studio/src/components/DeviceCard.tsx:71-81`; the unused helper `packages/studio/src/hooks/use-bulk-selection.ts:34-64` |
| **F13** | A single click on a wall tile is a full `next/link` navigation to `/device?id=…`; there is **no `onDoubleClick` handler anywhere in Studio** (repo-wide search: zero hits). | `packages/studio/src/components/wall/WallTile.tsx:74-80` |
| **F14** | Video frames and JSON share one WebSocket; `MAX_BUFFERED` is 512 KB since plan 85, and `/api/adb/stats` already reports `transport.bufferedBytesP95` and `controlReplyMsP50/P95`. Fan-out can therefore be argued with real instrumentation rather than assertion. | `packages/core/src/api/adb-stats.ts:22-30`, `:105`; plan 85 §3.6 |
| **F15** | A manual gesture is the operator's **real** pointer trace, batched at 8 ms and capped at 300 samples by both the client and the schema. | `packages/studio/src/components/LiveView.tsx:30`, `:33`, `:304-314`; `packages/protocol/src/messages/input.ts:49-52` |
| **F16** | Every input is already recorded with an actor, after the gate passes and before the device is awaited, through a buffered recorder. `actor` is documented as "userId, `'job:<id>'`, or null when the core itself is the actor". | `packages/core/src/events/recorder.ts:5-16`, `:42-59`, `:69-79`; `packages/core/src/server/ws-handlers.ts:1155-1160`, `:1162-1168`; `packages/protocol/src/messages/device-event.ts:58`; `packages/core/src/db/schema.ts:494` |
| **F17** | **There is no `job_events`, `job_logs`, or `job_notes` table.** The only durable per-job attachments are the `jobs` row itself and an `artifacts` row. | `packages/core/src/db/schema.ts:212-310` (jobs), `:408-427` (artifacts); repo-wide search for the three table names: zero hits |
| **F18** | `device_events` is indexed on `(deviceId, stream, at)`, and the `jobs` row carries `deviceId`, `startedAt` and `finishedAt`. "Which non-job input happened on this device while this job ran" is therefore an **indexed range scan over data that already exists**. | `packages/core/src/db/schema.ts:485-508`; `:217`, `:226-227` |
| **F19** | Input-stream device events are GC'd after **3 days** by default; main-stream after 30. Any attribution that has to outlive a job cannot live only in the input stream. | `packages/protocol/src/settings.ts:614-620`, `:652` |
| **F20** | `ParentToChildSchema` has exactly **one** unsolicited push — `abort`, carrying a five-value reason enum and nothing else. Every other variant is a correlated reply or the one-time `init` handshake. There is no core→script data channel. | `packages/session/src/runner/ipc.ts:208-251`, specifically `:249` |
| **F21** | The precedent for "the core tells a running job something happened" is the crash path: crash watcher → `ExecutorHost.notifyCrash` → `ctx.onCrash` → `runner.abort(jobId, 'crashed')` → `{ t: 'abort', reason: 'crashed' }`, and the child **still runs `finish()`**. | `packages/core/src/jobs/executor-host.ts:64-77`, `:101`, `:206-208`; `packages/core/src/jobs/executors/script.ts:51` |
| **F22** | `finish()` runs on abort in-process, and if the child died first, in a **fresh finish-only process** with `priorError` threaded in. This is why the repo rule "`finish()` must be stateless and idempotent" exists. | `packages/session/src/runner/child-entry.ts:436-447`; `packages/session/src/runner/job-runner.ts:771-789` |
| **F23** | `shell.mode` + `canUseShell(role, mode)` is the established shape for "a farm switch plus a role permission, checked together, server-authoritative". This plan copies it rather than inventing a second shape. | `packages/protocol/src/settings.ts:35`, `:844-847`; `packages/core/src/auth/acl.ts:186-190`; used at `packages/core/src/server/ws-handlers.ts:953-958` |
| **F24** | `audit.record`'s `meta` is written to `audit_log` but **dropped by the API schema** — `AuditEntrySchema` has no `meta` field, so Studio's audit table structurally cannot render it. | `packages/core/src/auth/audit.ts:117-142`; `packages/core/src/db/schema.ts:465-478`; `packages/protocol/src/api/auth.ts:12-19`; `packages/studio/src/app/settings/page.tsx:990-1030` |
| **F25** | `DeviceInfo.heldBy` already carries the holder to every surface (wall tile, device card, picker, header) and `lease.changed` pushes it live, with no polling. A second field beside it reaches all the same surfaces for free. | `packages/protocol/src/device.ts:19-32`, `:84`; `packages/core/src/server/ws-handlers.ts:787-790`; `packages/studio/src/components/HolderBadge.tsx:15-53` |
| **F26** | Rotation lock, Wake/Sleep, Back/Home/Recents, Power/Volume/Mute and clipboard all already ship. Part 3's function rail is a **rearrangement**, not thirteen new features. | `packages/session/src/orientation.ts`; `packages/studio/src/components/device/RotationQuickAction.tsx`; `packages/studio/src/components/LiveView.tsx:410-414` (nav), `:420-425` (hardware), `:432-435` (wake/sleep), `:613` (clipboard) |
| **F27** | Bulk APK install already ships as an ordinary batch job whose `scriptId` is the literal `'internal:install'`. "Is this device mid-install?" is answerable from the `jobs` row with no new bookkeeping. | `packages/studio/src/components/InstallBatchDialog.tsx:45-53`; `packages/core/src/daemon.ts:731`; `packages/core/src/db/schema.ts:216` |
| **F28** | `DEVICE_CALL_ARGS` is the repo's own precedent for "one schema, two consumers" — the IPC union and the capability registry are both built from it rather than declaring the same seventeen operations twice. | `packages/session/src/runner/ipc.ts:11-17`, `:19-52` |

### 0.2 Hypotheses (instrument before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | F6's interleaving would present as a **silently wrong gesture**, not an error: the pointer teleports mid-drag, the touch bit is cleared by one caller's `up` in the middle of another's swipe, and the app receives a fling nobody sent. It has never been observed because two input sources have never been possible. | The UHID pointer is a single kernel input device with a single position and a single touch bit (`scrcpy-input.ts:4`, `:175-179`). Nothing in the byte stream identifies a caller. | 91.1 builds the arbiter *first* and unit-tests the interleaving directly, with a fake sink that records ordering. 91.10's `/api/adb/stats` `input` block then reports how often the lanes actually contend in the field. |
| **H2** | A human's assist action will typically wait **less than one job action** before running, because the arbiter's lanes are per-resource and a job's individual actions are short (a tap holds 40–120 ms, a swipe defaults to 300 ms). | `sampleHoldMs` `packages/drivers/src/input/scrcpy-input.ts:15`, `:25-29`; `InputSwipeMessage.durationMs` defaults to 300 (`packages/protocol/src/messages/input.ts:20`). The pathological case is `typeText`, which is why it is on its own lane (§3.3). | 91.10 records `waitMsP50`/`waitMsP95` per lane. §7.3's assist rung reads them. If p95 exceeds the 5 s refusal budget, the lane split is wrong and §9 Q3 takes over. |
| **H3** | Normalised fan-out is correct for the owner's fleet **because the selected phones are running the same app on the same screen**, and degrades to "geometrically consistent, semantically wrong" the moment they diverge. | F8: a normalised point is a fraction of the frame, so it tracks a scaling layout exactly and tracks an absolute physical position not at all. | 91.7 does not try to detect divergence (it cannot). It makes divergence *visible*: every member keeps a live tile, and §3.9's solo modifier exists precisely for the moment an operator sees one. |
| **H4** | The dominant cost of a 20-device mirror is **video, not input**. Input is one message in, N short writes out, over N already-open per-device scrcpy sockets. | F14 (one shared socket, 512 KB budget) plus the arithmetic in §3.8. Video at `control` quality is 4 Mbit/s per device (`packages/session/src/session.ts:29-32`). | 91.9 keeps every non-focused member at `wall` quality by construction; 91.10 reads `transport.videoBytesPerSec` and `bufferedBytesP95` at the 20-device rung of §7.3. |

### 0.3 What the owner asked for, and what each sentence maps to

> "Control dan lease itu memang perlu untuk job dll, tapi khusus untuk control layar casting ini punya hak penuh."

→ The lease stays. A *second*, narrower authorisation covers screen control only (§3.2).

> "Jadi ketika mau control, kasih alert atau warning saja — kalau client bilang yes, berarti control-nya tetap di yang saat ini control, tapi user tetap bisa touch dll."

→ An explicit confirmation, and **the lease does not move** — `acquireManual` is never called, `DeviceStatus` never changes, the job's lease keeps its holder and its expiry (§3.2, §3.5).

> "Contoh: ada job yang sedang take control. Job ini stuck di suatu aplikasi karena ada modal, atau misalnya butuh saya untuk volume up."

→ The two named actions are a **tap** and a **key**. They land on different arbiter lanes, so the volume press does not even queue behind the job's pointer work (§3.3).

> "Di device list bisa seleksi banyak device, mouse akan ada indikator device yang terseleksi berapa. Lalu double-click di salah satu device agar fokus remote satu device tersebut."

→ Selection moves into Wall view (F11, F12), gains a cursor-anchored count badge, and double-click opens a focus overlay (F13 — there is no double-click handler to conflict with).

> "Jadi misal 10 device terseleksi, saya buka device pertama, lalu di device pertama saya tekan tombol Home, semua device yang terseleksi ikut ke Home."

→ The Home key is the easy case and works perfectly: a keycode has no geometry (§3.7). The taps are the hard case, and §3.7 is where that is argued.

---

## 1. Goals

- **A human can reach into a device a job is driving, without taking it.** After
  one confirmation that names the job, an operator can tap, swipe, type and
  press keys on a `busy` device. The job's lease is untouched: same holder,
  same expiry, no state transition, no revocation.
- **Two input sources never corrupt each other.** Every input action — a tap, a
  swipe, a gesture, a key, a string — is atomic against every other action on
  the same device, and the atomicity is enforced in one place rather than by
  each caller being careful.
- **Nothing widens by accident.** Co-control grants exactly five verbs. `shell.exec`,
  `inspect.*`, `clipboard.set`, the adb endpoint, and install/push/pull are
  reachable only by the lease holder, exactly as today, and a test proves it.
- **A job that was helped says so.** Reading a job's record shows that a human
  intervened, who, when, and what they did — on the job's own row, not only in
  a device log that is GC'd in three days (F19).
- **A script can react, and does not have to.** The core tells a running job
  that a human intervened; a script that never asks keeps running exactly as
  before. `finish()` stays stateless and idempotent.
- **One operator drives many phones from one view.** Select N devices on the
  Wall, double-click one to focus it, and every input goes to all N — with a
  per-device result for every action, never silence.
- **Fan-out is correct across different screens, or it refuses.** A normalised
  action lands in the same UI position on every member; a member whose
  orientation disagrees is skipped by name for pointer actions and still
  receives keys and text.
- **The dangerous things cannot be mirrored at all**, structurally, not by
  convention (§3.10).
- **All of it is measurable**: lane depth, wait percentiles, refusals, fan-out
  latency, and per-device outcomes, in `/api/adb/stats` and in `enkaku doctor`.

## 2. Non-goals

- **Not a change to what a lease is.** `acquireManual`, the CAS, the takeover
  dialog and the reaper are untouched. This plan adds an object beside the
  lease; it does not modify one.
- **Not a multi-device lease.** No distributed lock, no atomic N-device
  acquisition. §3.6 argues why.
- **Not bulk commands.** Reboot, ADB command box, install APK, push/pull,
  clipboard export, "run on all" — **plan 93**. They already have, or need, a
  batch report; mirroring them would create a second, unreported bulk path
  (F27).
- **Not recording or replaying actions.** Auto Swipe, Action Record, Execute
  Action/Task, Quick Phrase, App List — **plan 94**.
- **Not an on-device IME.** Switch Input Method — **plan 90** (guest agent).
- **Not video quality controls or wall density.** The focus overlay hands
  quality between tiles using the mechanism that already exists
  (`upgradeToControl`, `packages/session/src/manager.ts:220-244`); tunable
  profiles are **plan 92**.
- **Not transport work.** Whether video moves to its own socket is plan 85
  §85.7b's gated decision, informed by **plan 88**. This plan only measures.
- **Not device naming or badges.** Sequence numbers, connection-type chips —
  **plan 89**.
- **Not agents.** An agent already holds an ordinary manual lease
  (`AGENT_LEASE_PREFIX`, `packages/core/src/lease/lease-manager.ts:28`), so it
  is assistable by the same rule as a person, with no agent-specific code. A
  *reverse* facility — an agent assisting a human — is not built.
- **Not cloud/node devices.** `RemoteSessions` exposes only `frameSize` and
  `input` (`packages/core/src/server/ws-handlers.ts:176-181`), with no
  arbiter and no session-local state. A node-owned device is refused from a
  mirror group by name (`node_owned`), never silently dropped. §9 Q5.

## 3. Context and design decisions

### 3.1 The thing that is actually missing is not a permission

The obvious shape for co-control is "let `checkInputAllowed` return `ok` for a
second client". It is wrong twice over.

First, **it widens six unrelated surfaces at once** (F1, F2). The same function
authorises a tap and a free-form root-equivalent shell command. Spec §11.3 is
explicit that a leased operator has "the same reach as a local `adb shell`" —
that is a deliberate, documented trust decision about *the lease holder*, and
extending it to "whoever confirmed a dialog while a job was running" is not the
same decision at all.

Second, and worse, **it produces a device that misbehaves rather than a device
that is shared** (F6, H1). There is one `InputSink` per device (F5) and it has
no serialisation. Authorising a second caller without serialising the two is
how you get a phone that receives a fling nobody sent.

So this plan has two halves that must land together, and the order matters: the
**arbiter** (§3.3) makes concurrent input *safe*, and the **grant** (§3.2)
makes it *authorised*. Building the second without the first would ship the
owner's feature and a silent corruption defect in the same commit.

### 3.2 Co-control is a third authorisation object, not a state and not a flag

**Decision.** A **co-control grant** is a new object, keyed `(deviceId,
clientId)`, with these properties, each of which is the answer to a specific
failure mode:

| Property | Value | Why |
|---|---|---|
| Effect on `DeviceStatus` | **none** | The device really *is* `busy` — a job owns it. `DeviceStatus` answers "who owns this device", and co-control does not change the answer. A sixth status would ripple into the scheduler's `d.status='idle'` SQL (spec §10.3), every Studio filter, `acquireManual`'s four branches, and the wall — for a fact that is not about ownership. |
| Effect on the lease | **none** | `acquireManual` is never called. `leases` is never written. The job's holder and `expiresAt` are exactly what they were. |
| Scope | exactly `input.tap`, `input.swipe`, `input.gesture`, `input.key`, `input.text` | The five verbs a human needs to dismiss a modal or press volume up. Nothing else, by construction (§3.10). |
| Lifetime | `coControl.grantTtlSec`, default **300 s**, refreshed on every accepted action | Answers "someone left it open and forgot". The refresh is the same shape as `touchManual` (`packages/core/src/lease/lease-manager.ts:228-233`). |
| Subordination | revoked the instant the **primary hold** ends | A grant may only exist while somebody else holds the device. When the job finishes the device is `idle`, and the correct route is the ordinary `lease.acquire`. Without this rule, a grant is a backdoor lease that outlives the thing it was subordinate to. |
| On WS close | revoked, like `releaseAllForClient` | `packages/core/src/lease/lease-manager.ts:242-246` is the pattern. |
| Concurrency | `coControl.maxConcurrentPerDevice`, default **1** | Two humans on one pointer is safe (the arbiter serialises it) but unattributable *to the humans*: neither can tell whose tap moved the screen. A second operator is refused with `assist_taken`, naming who holds it — the same shape as `device_held_by_other` (`lease-manager.ts:180`). Raising it above 1 is possible and is a deliberate choice. |

**Naming.** The concept is co-control; the user-facing verb is **Assist**.
`docs/design.md` requires a verb to keep its name through the whole flow, so:
the button says *Assist*, the state says *Assisting*, the device event is
`control.assist.started`, the audit action is `device.assist`, the refusal code
is `assist_taken`. One word, everywhere. "Assist" is chosen over "co-control"
in the UI because it says what the operator is doing (helping) rather than
naming a mechanism, which is `docs/design.md`'s "name things from the user's
side" rule. **DECIDED (2026-08-12, §9 Q1): the owner confirmed "Assist."**

**Where the gate lives.** `checkInputAllowed` is **not modified**. A second
function, `checkAssistAllowed(deviceId, clientId)`, is added beside it, and
**only** `ws-handlers.ts:1133`'s `input.*` branch consults it — as a fallback,
after `checkInputAllowed` has already failed:

```ts
let allowed = deps.leases.checkInputAllowed(deviceId, state.clientId)
let source: InputSource = { kind: 'lease', id: state.clientId, userId: state.userId }
if (!allowed.ok) {
  const assist = deps.coControl.checkAssistAllowed(deviceId, state.clientId)
  if (assist.ok) {
    allowed = assist
    source = { kind: 'assist', id: state.clientId, userId: state.userId }
  }
}
if (!allowed.ok) { sendError(ws, allowed.code, allowed.message, msgId); return }
```

The property this buys is the important one: **a future call site that copies
the existing `checkInputAllowed` pattern gets the strict behaviour by default.**
Five of the six existing call sites (F1) and both status-test callers (F2) are
untouched by construction, not by discipline. Fail-safe is the default and
widening is opt-in, one branch at a time, visibly.

### 3.3 The input arbiter: three lanes, because a pointer is stateful and a keycode is not

**The problem** (F6, H1). `tap` is `write(down)` → `await` → `write(up)`.
`swipe` is `write(down)` → N × (`await`, `write(move)`) → `write(up)`. Both run
against one virtual pointer with one position and one touch bit. Interleave
them and the result is not "two taps"; it is one incoherent gesture.

**The naive fix** is a per-device mutex around all input. That is correct and
badly wrong for UX: a script's `typeText` of 200 characters at 80 ms each is
**16 seconds** during which the human's volume-up press is blocked — and volume
up is one of the two examples the owner gave.

**Decision.** Serialise on the **resource**, not on the device. Three
independent FIFO lanes per device:

| Lane | Verbs | Why it is separable |
|---|---|---|
| `pointer` | `tap`, `swipe`, `gesture` | Stateful: down/move/up on `UHID_POINTER_ID` (`packages/drivers/src/input/scrcpy-input.ts:4`, `:175-179`). Must be atomic. |
| `keys` | `key` | `injectKeycode` down + up, ~30 ms (`scrcpy-input.ts:74-78`). Stateful but tiny. **Not overridden by `ScrcpyUhidInput`** — only the pointer is UHID, so a key never touches the pointer's state. |
| `text` | `text`, `typeText` | `injectText` is a single stateless control message per call (`scrcpy-input.ts:80-82`, `:116-124`). |

This is not a convenience split; it is what the wire actually permits. A key
event arriving during a touch drag is exactly what a real phone sees when
someone presses volume while dragging — Android handles it because hardware
does it. The owner's stuck-job example therefore costs the human **zero wait**.

**The arbiter's remaining rules:**

- **Non-preemptive priority.** An `assist` action jumps ahead of *queued*
  actions from a `job` or `agent` source, but never interrupts a *running* one.
  A human is there to unstick; making them queue behind a retry loop defeats
  the purpose. Preempting mid-gesture would reintroduce exactly the defect the
  arbiter exists to prevent.
- **Bounded, and it says so.** `coControl.queueWaitMs` (default **5000**) and
  `coControl.maxQueueDepth` (default **32**). An action that waits longer is
  refused with `E_INPUT_BUSY` and a message that names what it waited for —
  *"the job's swipe is still running (waited 5.0 s)"* — never queued forever,
  never dropped in silence.
- **Attribution is structural.** Every submission carries an `InputSource`.
  The arbiter is therefore the one place that knows, for every byte written to
  a device, who asked for it. §3.5 reads from exactly this.
- **`adb-input` is unaffected and still correct.** The fallback engine goes
  through `adb shell input`, already serialised by the per-device command queue
  (spec §10.4). The arbiter is a redundant safety net there, not a second
  queue.

### 3.4 `busy` keeps its meaning; spec §10.1 gains a sentence

Spec §10.1 currently reads: *"While `busy`, control messages from a client are
rejected by the core (not merely disabled in the UI). The video stream keeps
running, so a client can still watch the automation."*

**Decision.** The first sentence is amended, and a new §10.5 defines the grant.
The amendment is deliberately narrow:

> While `busy`, control messages from a client are **rejected by the core**
> (not merely disabled in the UI) — **unless that client holds a co-control
> grant on the device (§10.5), which authorises the five manual input verbs
> and nothing else.** The video stream keeps running, so a client can still
> watch the automation.

`busy` still means "a job owns this device". Nothing about the scheduler, the
queue, the wall's status badge or `heldBy` changes. Per `00-overview.md` §7
item 8, this lands in the same commit as the code.

**How Studio says it.** Today `inputEnabled = iHoldControl && !busy`
(`packages/studio/src/app/device/page.tsx:372`), and a job-held device shows a
disabled Control button with a tooltip (`DeviceHeader.tsx:348-369`). After this
plan:

1. **Before assisting** — the screen card carries a non-blocking banner (not an
   overlay that eats clicks): *"`checkout@1.4.2` is running on this device."*
   with an **Assist** button beside it. Input stays off. The existing disabled
   Control button and its tooltip are unchanged — taking control and assisting
   are different actions and must not be confused for one another.
2. **While assisting** — the canvas becomes interactive; the card gains a
   1 px `--color-led-warn` border and a persistent `.rack-label` reading
   `ASSISTING — THE JOB STILL HAS CONTROL`, with the grant's remaining time in
   `.readout` beside it (the same `mmss` helper the lease countdown already
   uses, `packages/studio/src/components/device/DeviceHeader.tsx:96-98`).
   Amber, because `docs/design.md` reserves saturated colour for status and
   this is a live, unusual, self-expiring condition — not an accent.
3. **The status rail is not touched.** The device is busy and its rail says so.
   Adding a second colour to the signature element for a transient condition
   would spend the one thing `docs/design.md` says not to spend.
4. **Everyone else sees it.** `DeviceInfo` gains `assistedBy: LeaseHolder[]`
   beside `heldBy`, which reaches the wall tile, the device card, the picker
   and the header with no new plumbing (F25).

### 3.5 Attribution: the job's own record, without a new table

The requirement is that *"a job that mysteriously succeeded because someone
tapped a modal is a lie in the history"*. There is no `job_events` table (F17),
and the input event stream is GC'd in three days (F19). Three layers, each
answering a different question:

1. **"Was this job assisted at all?"** — a new `jobs.assistCount` integer column,
   defaulted 0, incremented on every accepted assist action. On the row itself,
   so every job list can badge it with no join, and so it survives event GC and
   is deleted by job retention, with the job, where it belongs. This is exactly
   the shape `jobs.infraAttempts` already has
   (`packages/core/src/db/schema.ts:249-255`).
2. **"What exactly did they do, and when?"** — the existing `device_events`
   rows. `input.*` is already recorded with `actor` (F16); this plan adds
   `meta.assist: true` and `meta.jobId`. The **query** needs no JSON extraction
   and no new index (F18):
   ```sql
   SELECT * FROM device_events
   WHERE device_id = :jobDeviceId AND stream = 'input'
     AND at BETWEEN :jobStartedAt AND :jobFinishedAt
     AND (actor IS NULL OR actor NOT LIKE 'job:%')
   ORDER BY at
   ```
   That is an indexed range scan on `idx_device_events_tail(deviceId, stream, at)`.
   Any non-job input on that device during that job's run **is** an assist, by
   definition. Exposed as `GET /api/jobs/:id/assists` and rendered as a section
   on the job detail page.
3. **"Who, farm-wide?"** — one `audit_log` row per grant, `action:
   'device.assist'`, `target: deviceId`. Because `meta` is written but never
   returned (F24), and the jobId is exactly the part that makes this row worth
   reading, `AuditEntrySchema` gains `meta` in this plan
   (`packages/protocol/src/api/auth.ts:12-19`) and Studio's audit table renders
   it in an expandable cell, the same way `DeviceLog` already renders event
   meta (`packages/studio/src/components/DeviceLog.tsx:221`).

Plus the two bookend main-stream events, mirroring `control.acquired` /
`control.released` exactly: `control.assist.started` and
`control.assist.ended` (with `reason: 'released' | 'ttl' | 'disconnected' |
'primary_ended'`).

### 3.6 Does the job find out? Yes — and it does nothing unless it asked to

The options run from "never told" to "aborted". Both ends are wrong:

- **Never told** is wrong because a script that just had the screen moved under
  it may now be asserting against a state that no longer exists, and it has no
  way to even know it should re-check.
- **Aborted** is wrong because it destroys the feature. The owner's entire
  premise is *"control-nya tetap di yang saat ini control"* — the job keeps
  going. And killing the job is already possible two ways (`POST
  /api/jobs/:id/cancel`, and this plan's own End task button, §3.11), so a
  farm setting that turns *help* into a *kill* would duplicate an existing
  control while making the new one dangerous.

**Decision.** The core pushes a new `ParentToChild` variant — the second
unsolicited push ever (F20), modelled precisely on the `abort`/`onCrash`
precedent (F21):

```ts
z.object({ t: z.literal('assist'), at: z.number().int(), actor: z.string().nullable() })
```

The child parses `ParentToChildSchema` with `safeParse` and ignores unknown
messages by design (`packages/session/src/runner/ipc.ts:4-6`), so this is
additive and safe. `ScriptContext` gains `onAssist?(cb): void`
(`packages/sdk/src/types.ts:262-275`). A script that registers nothing is
affected in **no** way — same code path, same timing, same result.

**Why this does not violate the `finish()` rule.** `finish()` must be stateless
and idempotent because it may run twice, in two different processes (F22). A
human intervention does not change that: it is not an abort, it starts no
second process, and it never causes `finish()` to be invoked. The rule is
untouched, and this plan says so explicitly so the next reader does not have to
re-derive it.

**Per-script opt-out.** `ScriptDefinition` gains `assist?: 'allow' | 'deny'`,
default `'allow'`, carried on the existing `ready` IPC message alongside
`timeout`, `retries` and `reset` (`packages/session/src/runner/ipc.ts:149-181`)
— the same mechanism, no new channel. `'deny'` disables the Assist button with
a tooltip naming the script, per `docs/design.md`'s quality floor. A denying
script is still cancellable; refusing help is not refusing control.

**Farm-wide switch.** `coControl.mode: 'off' | 'admin' | 'operator'`, default
`'operator'`, plus a `device.assist` permission, checked together by
`canAssist(role, mode)` — the exact shape of `shell.mode` and `canUseShell`
(F23). Not a new pattern; the existing one.

### 3.7 Mirror geometry: normalised is already right, orientation is a gate, aspect is a warning

This is the crux, and F8 does most of the work: **coordinates on the wire are
already normalised 0..1**, and each device's own `mapNormToDevice(pos,
session.frameSize)` uses that device's own live frame size (F9). A tap sent
verbatim to 20 devices already lands at the same *fraction* of each screen,
whatever the resolution or density. Nothing needs to be recomputed per device.

What normalisation does **not** solve, and what this plan does about each:

1. **Orientation.** Device A portrait (1080×2400) and device B landscape
   (2400×1080) both accept (0.5, 0.9) and both put it "near the bottom" — but
   B's bottom is a different physical edge showing a different layout.
   **Decision: gate, do not transform.** Rotating the coordinate 90° would
   land it in the geometrically corresponding place, which is almost never the
   semantically corresponding UI element, because a landscape layout is a
   *different layout*, not a rotated one. A member whose orientation disagrees
   with the focused device is **skipped for pointer actions**, with the named
   reason `orientation_mismatch` shown on its tile, and the operator can fix it
   with the rotation lock that already ships (F26). Being refused and told is
   honest; being transformed and wrong is not.
   **The gate is per-lane**: keys and text still go through, because a keycode
   has no geometry. This is why the owner's own Home-button example works on
   every member regardless of orientation.
2. **Aspect ratio.** A 20:9 and a 16:9 phone showing the same app agree on
   where a centred button is and disagree slightly on where a bottom-anchored
   one is. **Decision: report, do not block.** At `mirror.start`, each member's
   `max(w,h)/min(w,h)` is compared to the focused device's; a difference above
   `mirror.aspectTolerance` (default **0.05**) flags that member once, as a
   persistent chip on its tile. Input still goes, because for a scaling layout
   it is right, and because blocking on a 5 % geometry difference would exclude
   most real fleets. The operator is told which members are the risky ones
   **once, up front**, not per tap.
3. **Different app state.** Undetectable at the input layer (H3), and this plan
   does not pretend otherwise. The mitigation is visibility (every member keeps
   a live tile) plus the solo escape hatch (§3.9).
4. **Density.** Irrelevant. Every value on the wire is either a fraction
   (position), a duration in ms, a keycode, or a string. None is a pixel.

### 3.8 Where fan-out happens: the core, and the arithmetic says so

**Decision.** One `input.mirror` message in; N parallel arbiter submissions out;
one `input.mirror.result` back. The browser sends **one** message per action,
regardless of N.

The alternative — the browser sending N `input.*` messages — is measurably
worse on the one shared resource:

- A manual gesture is up to 300 samples (F15), roughly 30 bytes each ≈ **9 KB**.
  Browser fan-out to 20 devices is **180 KB per gesture** onto a socket whose
  `MAX_BUFFERED` is 512 KB and which also carries H.264 (F14). Core fan-out is
  9 KB in, ~800 bytes of results out.
- Head-of-line blocking on that socket is a *measured* concern, not a
  theoretical one: plan 85 §3.6 dropped `MAX_BUFFERED` from 4 MB to 512 KB
  specifically to shorten the queue in front of control replies, and
  `/api/adb/stats` reports `controlReplyMsP95` so the effect is readable
  (F14).

Downstream of the core, fan-out costs almost nothing, and this is worth stating
because it is not obvious: scrcpy control messages go over **each device's own
already-open scrcpy socket**, not the adb exec queue. A mirrored swipe consumes
**zero** `adb.maxConcurrent` and **zero** `adb.maxStreams` (spec §10.4). A
300 ms swipe is `max(2, round(300/16))` ≈ 19 pointer reports per device
(`packages/drivers/src/input/scrcpy-input.ts:58`, `:184`); 20 devices is 380
`write()` calls spread over 300 ms — about 1.3 kHz on the core's event loop.

The real cost is video (H4), which is why §3.9's focus overlay keeps every
non-focused member at `wall` quality by construction.

### 3.9 Leases at scale: mirroring rides on co-control, and no new lock is invented

**Decision.** The operator acquires **no** multi-device lease. `mirror.start`
resolves each selected device independently, in one call, and reports the
outcome per device:

| Device state | What the operator gets | Member mode |
|---|---|---|
| `idle` | an ordinary manual lease, exactly as today | `lease` |
| `manual`, held by this same client | the lease they already have | `lease` |
| `busy` (a job) | a co-control grant, after the group confirmation | `assist` |
| `manual`, held by someone else | a co-control grant (§3.2's rules apply) | `assist` |
| `offline` / `quarantined` | nothing | `skipped: unavailable` |
| running an `internal:install` job (F27) | nothing, and it rejoins when the install ends | `skipped: installing` |
| orientation ≠ focused device's | pointer actions only are withheld | `partial: orientation_mismatch` |
| node-owned (§2) | nothing | `skipped: node_owned` |

**Why not N atomic leases.** Acquiring N exclusive locks atomically across
devices is a distributed-locking problem whose failure modes are all bad:
partial acquisition leaves the operator half-armed; rollback races another
operator; and two operators mirroring overlapping sets can deadlock. None of
that complexity buys anything, because a mirror does not *need* exclusivity —
it needs *permission to send input*, which is precisely what a co-control grant
is. Every member device still has exactly one lease with exactly one holder,
completely unchanged. This is the payoff for designing the grant as a
subordinate object in §3.2 rather than as a lease variant.

**Solo.** Holding `Alt` (or toggling **Focused only** in the rail) sends the
next action to the focused device alone. This exists because H3 is honest:
divergence is undetectable, so the operator needs a one-keystroke way to act on
what they can see.

**Auto-drop.** A member that fails **3 consecutive** mirrored actions
(`mirror.dropAfterConsecutiveFailures`) leaves the group, with one toast naming
it. Continuing to "send" to a device that is not receiving is the silence this
plan exists to remove.

### 3.10 What must never mirror, and why it cannot

Three of these are enforced by the design rather than by a rule, which is the
point of §3.2's narrow grant scope:

| Never mirrored | Why | How it is prevented |
|---|---|---|
| `shell.exec` | Arbitrary root-equivalent commands × 20. Spec §11.3's trust decision is about *the lease holder*. | Structurally: `ws-handlers.ts:963` still calls `checkInputAllowed` and is never given the assist fallback. |
| `clipboard.set` | Writes device state, and the round trip is a sequenced, timed protocol (`packages/scrcpy/src/control/index.ts:104-118`). Pasting one string into 20 clipboards is a bulk data write. | Structurally: `ws-handlers.ts:1439` untouched. Bulk clipboard is plan 93. |
| `inspect.*` | Seizes the instrumentation lock on 20 devices; it is a *read*, and a read of whatever is on screen (spec §11.3). | Structurally: `ws-handlers.ts:1241` untouched. |
| `install` / `push` / `pull` | Already have a reported batch path (F27). A second, unreported one is the anti-goal. | Structurally: not among the five verbs; `api/transfer.ts:81` untouched. |
| `lease.acquire` with `takeOverFrom` | A mirror must never displace anyone. | `mirror.start` never passes `takeOverFrom`. A held device becomes an `assist` member or nothing. |
| Wake/Sleep, reboot, forget, block | Fleet commands need a confirmation naming the count and a per-device report — that is plan 93's shape, not an input verb's. | Not among the five verbs. |
| Pointer actions to an orientation-mismatched member | §3.7. | The per-lane gate in `mirror.start`'s member resolution. |

**The one that cannot be blocked here.** A tap that opens "delete account" is
indistinguishable at the input layer from a tap that dismisses a modal. The
honest answer is that the mitigation is not at this layer: it is (a) the group
confirmation naming the exact device count, (b) every member keeping a live
tile so divergence is *seen*, and (c) solo. Claiming otherwise would be the
half-feature the owner's standing order forbids.

### 3.11 The focused control window (Part 3)

**Decision.** An in-page **focus overlay** on the Wall route
(`/?view=wall&focus=<id>`), not a modal and not a navigation:

- **Not a `Dialog`.** No focus trap, no `aria-modal`. The wall stays mounted
  and live behind it — which is the whole point, and which also means the WS
  and the video survive (the constraint in `CLAUDE.md` is about `<a>` vs
  `next/link` remounting; a React overlay in the same route does not remount).
- **Double-click opens it** (F13 — nothing to conflict with). **Single click
  still navigates** to `/device?id=…`, unchanged, so no existing behaviour
  regresses.
- **URL-driven**, so it survives a reload and is linkable, matching Studio's
  existing static-export query-param convention (`/device?id=`).
- **The focused device's own wall tile becomes a "Controlling here"
  placeholder** — the competitor's behaviour, and simultaneously the
  efficiency measure: that tile stops decoding while the overlay takes the
  `control`-quality upgrade through the mechanism that already exists
  (`upgradeToControl`, `packages/session/src/manager.ts:220-244`). One decoder
  moves; none is added.
- **Resizable and dismissible** with `Esc`. Note that `Esc` is currently bound
  to `BACK` inside `LiveView` (`packages/studio/src/components/LiveView.tsx:397`),
  so the overlay must claim it only when the canvas does not have focus — a
  real collision, called out here rather than discovered later.

**The function rail** ships only what already exists or what this plan builds
(F26). Everything else is listed in §2 with its owning plan:

| Rail item | Source |
|---|---|
| Assist / Stop assisting | this plan |
| Mirror on/off, member count, Focused only | this plan |
| End task (cancel the running job) | this plan's button over the existing `POST /api/jobs/:id/cancel` (`packages/core/src/api/jobs.ts:180-200`) |
| Back / Home / Recents | exists — `LiveView.tsx:410-414` |
| Power / Volume up / Volume down / Mute | exists — `LiveView.tsx:420-425` |
| Wake / Sleep | exists — `LiveView.tsx:432-435` |
| Rotate | exists — `RotationQuickAction.tsx` |
| Clipboard | exists — `LiveView.tsx:613` |
| Open full device page | a link to `/device?id=…` |

No disabled placeholders for unbuilt features. A rail of greyed buttons teaches
nothing and violates `docs/design.md`'s "a control that cannot be used is
genuinely disabled" only in spirit — but a rail of *thirteen* of them is just
noise.

### 3.12 The confirmation

`docs/design.md`: ordinary sentences, no Title Case, name the thing at stake,
say what happens next. The single-device dialog:

> **Assist Pixel 7 while its job keeps control?**
>
> `checkout@1.4.2` is running on this device and keeps control of it.
> Assisting lets you tap, swipe, type and press keys on the same screen at the
> same time as the job.
>
> The job is not paused and is not cancelled. Everything you do is recorded on
> the job's record, so its result can be read honestly afterwards.
>
> Assisting stops on its own after 5 minutes without input.
>
> [ Cancel ] [ **Assist** ]

The group dialog, for `mirror.start`, is **one** dialog and states the split:

> **Control 18 devices at once?**
>
> 12 devices are free and you will take control of them.
> 6 devices are running jobs — you will assist those, and the jobs keep
> control.
> 2 devices are not included: 1 is offline, 1 is installing an app.
>
> Everything you tap, swipe, type or press goes to all 18 at once. Hold Alt to
> send only to the device you are looking at.
>
> [ Cancel ] [ **Control 18 devices** ]

**Scope.** Per `(device, primary holder)`. If the job ends and another starts,
the dialog returns, because the thing at stake changed and the copy names it.
Assisting the same device again while the same job still holds it, inside the
grant's life, shows nothing.

**Suppression.** No "don't ask again". The dialog names a specific script on a
specific phone; a permanent suppression means confirming something you have not
read, and a stray tap on a running automation cannot be undone —
`docs/design.md` reserves `ConfirmDialog` for exactly that. The 5-minute
activity-refreshed TTL means a working operator sees it about once per idle
gap, not once per tap, which is the real ergonomic answer.

## 4. Technical design

### 4.1 The input arbiter (`packages/session/src/input-arbiter.ts`, new)

```ts
export type InputLane = 'pointer' | 'keys' | 'text'

/** Who asked for this action. The `id` is the same identifier `Lease.holder`
 * uses, so an arbiter record and a lease record name the same thing. */
export interface InputSource {
  kind: 'lease' | 'assist' | 'job' | 'agent'
  id: string
  userId: string | null
}

export interface LaneStats {
  depth: number
  running: { source: InputSource; verb: string; sinceMs: number } | null
  waitMsP50: number
  waitMsP95: number
  refusals: number
}

export interface InputArbiter {
  /** An `InputSink` façade bound to one source. Every verb goes through the lane queue. */
  for(source: InputSource): InputSink
  stats(): Record<InputLane, LaneStats>
}

export function createInputArbiter(
  sink: InputSink,
  opts: {
    queueWaitMs: () => number      // read fresh, like every other farm setting
    maxQueueDepth: () => number
    log: Logger
    /** One callback per completed action — the attribution feed (§3.5). */
    onAction?: (e: {
      lane: InputLane
      source: InputSource
      verb: string
      waitedMs: number
      ranMs: number
    }) => void
  },
): InputArbiter
```

Refusals throw `SessionError('E_INPUT_BUSY', …)` with a message naming the
blocking action and the wait. Priority order within a lane: `assist` > `lease` >
`job` = `agent`, FIFO within a priority, **never preemptive**.

`DeviceSession` gains `arbiter: InputArbiter` beside its existing `input`
(`packages/session/src/session.ts:78-79` region). Per `00-overview.md` §4.3
("replace, never version"), **every** existing `session.input.*` call site
migrates to `session.arbiter.for(source).*` in the same commit — the ws-handler
(`ws-handlers.ts:1169`, `:1179`, `:1194`, `:1204`, `:1211`, `:1220`) and the
device executor (`packages/session/src/device-executor.ts`). `session.input`
remains the raw sink, used only by the arbiter itself.

### 4.2 The co-control grant store (`packages/core/src/lease/co-control.ts`, new)

```ts
export interface CoControlGrant {
  deviceId: string
  /** The WS connection's clientId — the same key `Lease.holder` uses for a manual lease. */
  clientId: string
  userId: string | null
  /** Snapshot of who held the device when the grant was issued; the grant dies with them (§3.2). */
  primaryHolderId: string
  primaryKind: 'job' | 'user' | 'agent'
  /** The job this grant is attributed to, when the primary is a job. */
  jobId: string | null
  grantedAt: number
  expiresAt: number
}

export interface CoControlManager {
  /** Throws `assist_not_allowed` / `assist_taken` / `assist_denied_by_script` / `device_not_held`. */
  grant(deviceId: string, clientId: string, userId: string | null): CoControlGrant
  release(deviceId: string, clientId: string, reason: AssistEndReason): boolean
  releaseAllForClient(clientId: string): void
  /** Called from the lease manager's own release/clear paths — subordination (§3.2). */
  onPrimaryEnded(deviceId: string): void
  /** Refresh on activity, exactly like `touchManual`. */
  touch(deviceId: string, clientId: string): void
  /** The §3.2 gate. Never consulted by anything except `input.*`. */
  checkAssistAllowed(deviceId: string, clientId: string): { ok: true } | { ok: false; code: string; message: string }
  assistedBy(deviceId: string): LeaseHolder[]
  startReaper(): void
  stopReaper(): void
}

export type AssistEndReason = 'released' | 'ttl' | 'disconnected' | 'primary_ended' | 'mode_off'
```

Wiring: `deps.onManualRevoked` and `clearJobLease`
(`packages/core/src/lease/lease-manager.ts:129`, `:258-261`) both call
`onPrimaryEnded`. `releaseAllForClient` is called from the same WS-close path
that already calls the lease manager's version.

### 4.3 The gate (`packages/core/src/lease/lease-manager.ts` — **unchanged**)

`checkInputAllowed` is not modified. This is load-bearing and gets a test of
its own (§7.1): a client holding only a grant is refused by `shell.exec`,
`inspect.attach`, `clipboard.set`, `POST /:id/push` and `POST
/:id/adb-endpoint`, all five, on the same device, in the same test.

### 4.4 Protocol (`packages/protocol`)

**One source for the five input bodies** (F28's precedent):

```ts
// packages/protocol/src/messages/input.ts
export const INPUT_ACTION_BODIES = {
  tap:     { pos: NormPointSchema },
  swipe:   { from: NormPointSchema, to: NormPointSchema, durationMs: z.number().int().min(50).max(10_000).default(300) },
  gesture: { samples: z.array(NormGestureSampleSchema).min(2).max(300) },
  key:     { keycode: z.number().int().min(0).max(320) },
  text:    { text: z.string().min(1).max(1000) },
} as const

// `InputTapMessage` … `InputTextMessage` are rebuilt from these, unchanged on the wire.
export const MirrorActionSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('tap'),     ...INPUT_ACTION_BODIES.tap }),
  z.object({ verb: z.literal('swipe'),   ...INPUT_ACTION_BODIES.swipe }),
  z.object({ verb: z.literal('gesture'), ...INPUT_ACTION_BODIES.gesture }),
  z.object({ verb: z.literal('key'),     ...INPUT_ACTION_BODIES.key }),
  z.object({ verb: z.literal('text'),    ...INPUT_ACTION_BODIES.text }),
])
```

**New messages** (`packages/protocol/src/messages/co-control.ts`, new):

| Direction | Type | Payload |
|---|---|---|
| C→S | `assist.start` | `{ deviceId }` |
| S→C | `assist.started` | `{ deviceId, expiresAt, primary: LeaseHolder }` |
| C→S | `assist.stop` | `{ deviceId }` |
| S→C | `assist.stopped` | `{ deviceId, reason: AssistEndReason }` |
| S→C (broadcast) | `assist.changed` | `{ deviceId, assistedBy: LeaseHolder[] }` |
| C→S | `mirror.start` | `{ focusDeviceId, deviceIds: string[] }` |
| S→C | `mirror.started` | `{ groupId, focusDeviceId, members: MirrorMember[] }` |
| C→S | `mirror.stop` | `{ groupId }` |
| S→C | `mirror.stopped` | `{ groupId }` |
| C→S | `input.mirror` | `{ groupId, seq: number, action: MirrorAction, soloDeviceId?: string }` |
| S→C (unicast) | `input.mirror.result` | `{ groupId, seq, results: MirrorResult[] }` |
| S→C (unicast) | `mirror.changed` | `{ groupId, members: MirrorMember[] }` |

```ts
export const MirrorMemberSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  mode: z.enum(['lease', 'assist', 'partial', 'skipped']),
  /** `orientation_mismatch` for `partial`; `unavailable` | `installing` | `node_owned` | `assist_taken` | `assist_not_allowed` for `skipped`. */
  reason: z.string().nullable(),
  /** §3.7 item 2 — flagged once at start, rendered as a persistent chip. */
  aspectDrift: z.boolean(),
})

export const MirrorResultSchema = z.object({
  deviceId: z.string(),
  ok: z.boolean(),
  code: z.string().nullable(),
  latencyMs: z.number(),
})
```

`DeviceInfoSchema` gains, beside `heldBy` (`packages/protocol/src/device.ts:84`):

```ts
/** Who is currently assisting this device — empty, never null, so callers need no guard
 * (the same reasoning `tags` uses at `:53`). A `LeaseHolder` with `takeable: false`:
 * an assist is never taken over, it is granted or refused (plan 91 §3.2). */
assistedBy: z.array(LeaseHolderSchema).default([]),
```

`AuditEntrySchema` gains `meta: z.unknown().nullable()`
(`packages/protocol/src/api/auth.ts:12-19`) — §3.5 layer 3, F24.

### 4.5 Settings (`packages/protocol/src/settings.ts`)

```ts
export const CoControlModeSchema = z.enum(['off', 'admin', 'operator'])

coControl: z
  .object({
    mode: CoControlModeSchema.default('operator')
      .describe('Who may tap and type on a device someone else is already controlling. Off disables assisting entirely.')
      .meta({ title: 'Assisting a controlled device' }),
    grantTtlSec: z.number().int().min(30).max(3600).default(300)
      .describe('Assisting stops on its own after this long without input.')
      .meta({ title: 'Assist idle timeout (s)' }),
    maxConcurrentPerDevice: z.number().int().min(1).max(4).default(1)
      .describe('How many people may assist the same device at once. More than one makes it hard to tell whose tap did what.')
      .meta({ title: 'People assisting one device' }),
    queueWaitMs: z.number().int().min(500).max(30_000).default(5_000)
      .describe('How long an action waits for the device to be free before it is refused with an explanation.')
      .meta({ title: 'Input wait budget (ms)' }),
    maxQueueDepth: z.number().int().min(1).max(256).default(32)
      .describe('Input actions that may be waiting for one device at once.')
      .meta({ title: 'Max queued input actions' }),
  })
  .default({ mode: 'operator', grantTtlSec: 300, maxConcurrentPerDevice: 1, queueWaitMs: 5_000, maxQueueDepth: 32 })
  .meta({ title: 'Assisting', description: 'Reaching into a device a job or another person is driving, without taking control from them.' }),

mirror: z
  .object({
    maxDevices: z.number().int().min(2).max(64).default(20)
      .describe('How many devices one operator may drive at the same time.')
      .meta({ title: 'Max devices per mirror' }),
    requireSameOrientation: z.boolean().default(true)
      .describe('Skip taps and swipes on a device whose screen is rotated differently from the one you are looking at. Keys and typing still go through.')
      .meta({ title: 'Skip rotated devices for taps' }),
    aspectTolerance: z.number().min(0).max(0.5).default(0.05)
      .describe('How different a screen shape may be before that device is flagged as likely to land taps in a different place.')
      .meta({ title: 'Screen shape tolerance' }),
    dropAfterConsecutiveFailures: z.number().int().min(1).max(20).default(3)
      .describe('A device that refuses this many actions in a row leaves the group, with a message saying which.')
      .meta({ title: 'Drop after failures' }),
  })
  .default({ maxDevices: 20, requireSameOrientation: true, aspectTolerance: 0.05, dropAfterConsecutiveFailures: 3 })
  .meta({ title: 'Controlling many devices', description: 'One screen, one set of taps, many phones.' }),
```

### 4.6 ACL (`packages/core/src/auth/acl.ts`)

```ts
| 'device.assist'   // in the OPERATOR set, like `device.network` (:48-55)

/**
 * The gate for assisting a device someone else controls (plan 91 §3.2, §3.6).
 * Exactly the shape of `canUseShell` (:186-190): a farm-wide mode PLUS a role
 * permission, checked together, server-authoritative. Deliberately NOT a
 * widening of `shell.mode` — assisting grants five input verbs, not a shell.
 */
export function canAssist(role: Role, mode: CoControlMode): boolean {
  if (mode === 'off') return false
  if (!can(role, 'device.assist')) return false
  return mode === 'operator' || role === 'admin'
}
```

### 4.7 Mirror groups (`packages/core/src/mirror/group.ts`, new)

```ts
export interface MirrorGroup {
  id: string
  ownerClientId: string
  ownerUserId: string | null
  focusDeviceId: string
  members: Map<string, { mode: MirrorMember['mode']; reason: string | null; aspectDrift: boolean; consecutiveFailures: number }>
  /** The focused device's orientation and aspect at `mirror.start`, for §3.7's comparisons. */
  focusGeometry: { orientation: 'portrait' | 'landscape'; aspect: number }
}

export interface MirrorManager {
  start(input: { ownerClientId: string; ownerUserId: string | null; focusDeviceId: string; deviceIds: string[] }): Promise<{ group: MirrorGroup; members: MirrorMember[] }>
  stop(groupId: string, ownerClientId: string): void
  stopAllForClient(clientId: string): void
  dispatch(groupId: string, ownerClientId: string, action: MirrorAction, soloDeviceId?: string): Promise<MirrorResult[]>
  /** Live re-resolution: a member's job ended, it went offline, it rotated. */
  reconcile(deviceId: string): void
}
```

`dispatch` in full:

```ts
const targets = soloDeviceId ? [soloDeviceId] : [...group.members.keys()]
const results = await Promise.all(targets.map(async (deviceId) => {
  const m = group.members.get(deviceId)
  if (!m || m.mode === 'skipped') return { deviceId, ok: false, code: m?.reason ?? 'not_a_member', latencyMs: 0 }
  // §3.7: the orientation gate is PER LANE — a rotated member still gets keys and text.
  if (m.mode === 'partial' && (action.verb === 'tap' || action.verb === 'swipe' || action.verb === 'gesture')) {
    return { deviceId, ok: false, code: 'orientation_mismatch', latencyMs: 0 }
  }
  const session = sessions.get(deviceId)
  if (!session) return { deviceId, ok: false, code: 'E_DEVICE_NOT_READY', latencyMs: 0 }
  const source: InputSource = { kind: m.mode === 'lease' ? 'lease' : 'assist', id: group.ownerClientId, userId: group.ownerUserId }
  const started = Date.now()
  try {
    // Normalised coordinates go VERBATIM (§3.7). Each device's own
    // `mapNormToDevice(pos, session.frameSize)` does the rest — the same
    // call the single-device path already makes (`ws-handlers.ts:1161`).
    await applyAction(session, source, action)
    m.consecutiveFailures = 0
    return { deviceId, ok: true, code: null, latencyMs: Date.now() - started }
  } catch (err) {
    m.consecutiveFailures++
    if (m.consecutiveFailures >= cfg.dropAfterConsecutiveFailures()) dropMember(group, deviceId, 'repeated_failures')
    return { deviceId, ok: false, code: codeOf(err), latencyMs: Date.now() - started }
  }
}))
```

`Promise.all` over independent per-device sockets, not sequential: 20 devices
complete in roughly the duration of the slowest single action, not 20× it.

### 4.8 IPC and SDK

```ts
// packages/session/src/runner/ipc.ts — ParentToChildSchema gains ONE variant.
// The second unsolicited push ever (plan 91 §3.6); `abort` (:249) is the first.
// A human sent input to this device while this job was running. NOT an abort:
// the job keeps its lease, keeps running, and `finish()` is not invoked.
z.object({ t: z.literal('assist'), at: z.number().int(), actor: z.string().nullable() }),

// ChildToParentSchema's `ready` gains, beside `timeout`/`retries`/`reset` (:161-181):
assist: z.enum(['allow', 'deny']).optional(),

// packages/sdk/src/types.ts — ScriptContext (:262-275) gains:
/** Called when a human sent input to this device while this job was running
 * (plan 91 §3.6). The job is NOT aborted and NOT paused; this is information.
 * A script that never registers is affected in no way. */
onAssist?(cb: (e: { at: number; actor: string | null }) => void): void

// ScriptDefinition (:277-307) gains:
/** Whether an operator may assist this script's job (plan 91 §3.6). Default 'allow'. */
assist?: 'allow' | 'deny'
```

### 4.9 Database and endpoints

```ts
// packages/core/src/db/schema.ts — jobs (:212-310)
/**
 * Plan 91 §3.5 — how many times a human sent input to this job's device while
 * it was running. On the row rather than derived, so a job list can badge it
 * with no join, and so it outlives `retention.eventInputDays` (3 days by
 * default) with the job it belongs to. Same shape as `infraAttempts` (:249-255).
 */
assistCount: integer('assist_count').default(0),
```

No new table. §3.5 explains why `device_events` already answers the detail
question over an existing index.

| Method | Path | Permission | Returns |
|---|---|---|---|
| `GET` | `/api/jobs/:id/assists` | `job.view` | the §3.5 range query, as `DeviceEvent[]` |
| `GET` | `/api/adb/stats` | `device.view` | **extended** with an `input` block (§4.10) |

### 4.10 Observability (`packages/core/src/api/adb-stats.ts`)

```ts
// AdbStatsResponseSchema gains, beside `transport`/`hostAdb` (plan 85 §4.6):
input: z.object({
  lanes: z.record(z.string(), z.object({
    depth: z.number(), waitMsP50: z.number(), waitMsP95: z.number(), refusals: z.number(),
  })),
  assistsActive: z.number(),
  mirrorGroups: z.number(),
  mirrorMembers: z.number(),
  mirrorFanoutMsP50: z.number(),
  mirrorFanoutMsP95: z.number(),
}),
```

Plus a `doctor` check (`packages/core/src/doctor/checks/`): a lane whose
`waitMsP95` exceeds half the `queueWaitMs` budget, or a grant older than
`grantTtlSec` that the reaper has not collected, is reported with a remedy.

## 5. Implementation steps

### 5.0 Order, and why

91.1 is first and alone: the arbiter is the only piece that makes the rest
*safe* (§3.1), and it is pure and fully testable with a fake sink before any
authorisation exists. 91.2–91.6 complete Part 1. 91.7–91.8 build Part 2 on top
of it. 91.9 is Part 3. Do not start 91.4 before 91.1 is green.

### 91.1 — The input arbiter (fixes F6; tests H1) — **DONE 2026-08-13**

- [x] `packages/session/src/input-arbiter.ts`: new, per §4.1. Three lanes,
      non-preemptive priority, bounded queue, `E_INPUT_BUSY` with the blocking
      action named, `onAction` attribution callback.
- [x] `packages/session/src/session.ts`: build one arbiter per session; expose
      `arbiter`; keep `input` as the raw sink used only by the arbiter.
- [x] Migrate **every** caller in the same commit (`00-overview.md` §4.3):
      `packages/core/src/server/ws-handlers.ts` (line numbers had drifted from
      the ones written above — verified against the live file — the `input.*`
      branch now builds one `InputSource` and one `sink = 'arbiter' in session
      ? session.arbiter.for(source) : session.input` and every one of its six
      write call sites goes through `sink`); `packages/session/src/device-executor.ts`
      → `sink()`, a lazily-memoised `deps.session.arbiter.for(deps.source ??
      DEFAULT_INPUT_SOURCE)`, with `runner/job-runner.ts` passing the real
      `{ kind: 'job', id: job.id, userId: null }` as `source`.
- [x] `packages/session/src/input-arbiter.test.ts`: two concurrent `tap`s never
      interleave their down/up writes (a fake `InputSink` records order); a
      `key` submitted during a running `swipe` runs **immediately** (the lane
      split); an `assist` tap jumps a queued `job` tap but never a running one;
      the depth cap and the wait budget both refuse with a message naming the
      blocker; `stats()` percentiles. Two more beyond the step's own list:
      the façade's honest-absence contract for `gesture`/`typeText`, and
      `onAction` firing once per completed action. 9 tests, all pass.
- **Verification that the migration is complete (no caller left on the raw
  sink):** a type change, not a grep — `DeviceSession.arbiter` is a
  **required** field, and `createDeviceExecutor` resolves its sink from
  `deps.session.arbiter.for(...)`, never `deps.session.input` directly. A
  repo-wide search for every production call site of `.input.tap(`/`.swipe(`/
  `.key(`/`.text(`/`.gesture(`/`.typeText(` (excluding `.test.ts`) at the end
  of this step found exactly two files: `ws-handlers.ts` and
  `device-executor.ts` — both migrated. The one further hit,
  `packages/node/src/hosts.ts:305-308` (the node package's own mini-core,
  executing tunnelled `input.*` for a node-owned device), is **not** migrated
  and is not a miss: §2's non-goals state plainly that node/cloud devices get
  no arbiter in this plan ("`RemoteSessions` exposes only `frameSize` and
  `input`, with no arbiter and no session-local state"). `createSession` still
  builds a real `arbiter` for every session including the node's own (so the
  field is never `undefined` there), but `hosts.ts` deliberately keeps calling
  `session.input.*` directly, matching the plan's own scope line. Flagged here
  rather than silently left for whichever later plan gives node-owned devices
  co-control.
- **Deviations from the file-ownership list, and why:** `errors.ts` (added the
  `E_INPUT_BUSY` code the plan's own §4.1 text specifies), `index.ts` (barrel
  export for `createInputArbiter`/`InputArbiter`/`InputSource`/`InputLane`/
  `LaneStats`), and `runner/job-runner.ts` + its test (the only file that
  actually holds a `jobId` to satisfy the step's own `{ kind: 'job', id: jobId
  }` requirement) were all touched — none is protocol/** or acl.ts (the
  concurrent worker's files), all are one- or two-line additions, and leaving
  any of them out would have made this step either uncompilable or a silent
  no-op. `DeviceSession.arbiter` becoming required also broke 8 test fixtures
  outside this step's nominal file list (`packages/core/src/capability/context.test.ts`,
  `packages/core/src/server/{presence,ws-handlers-clipboard,ws-handlers-inspect,
  ws-handlers-monitor,ws-handlers-shell,ws-handlers-text,ws-handlers-video}.test.ts`)
  plus two more inside `packages/session` (`device-executor.test.ts`'s
  `fakeGestureSession`, `runner/job-runner.test.ts`'s `fakeSessionWithInput`)
  — all fixed with either a bare stub (fixtures that never exercise input) or
  a real `createInputArbiter(...)` wrapping the existing input spy (fixtures
  that do). `bash scripts/typecheck.sh` and `bun test` are both green across
  the whole workspace with these fixes in place.
- **Verifiable result:** with the fake sink, a job swipe and a human tap issued
  in the same tick produce two well-formed, non-overlapping pointer sequences,
  in an order the test asserts. A `key` issued mid-swipe runs with zero wait.

### 91.2 — The co-control grant (Part 1's authorisation)

- [x] `packages/core/src/lease/co-control.ts`: new, per §4.2 — grant, release,
      TTL reaper, `onPrimaryEnded` subordination, `maxConcurrentPerDevice`,
      `releaseAllForClient`, `assistedBy`. Also implements the two other
      documented throw codes (`assist_not_allowed` for the farm-wide
      `coControl.mode: 'off'` switch, defense in depth alongside `canAssist`;
      `assist_denied_by_script`, via an optional `scriptAssistPolicy` hook
      that step 91.5 will supply real data for — permissive by default until
      then).
- [x] `packages/core/src/lease/lease-manager.ts`: **no signature changes** to
      any existing method. Verified the plan's cited line numbers (`:129`,
      `:258-261`) no longer matched the current file (as flagged as likely in
      this step's brief) and re-derived the real wiring points: a NEW
      optional `LeaseManagerDeps.onPrimaryEnded` hook is added (purely
      additive, matching the file's own established optional-hook
      convention — `onManualTakenOver`, `onDeviceFreed`, etc.), fired
      **unconditionally** from `release()` (so a plain voluntary
      `releaseManual` with no `reason` ends a subordinate grant too, not only
      the automatic-revoke paths `onManualRevoked` covers) and from
      `clearJobLease()`. `onManualRevoked` itself is untouched — its own job
      (telling the ex-holder something was taken from them without asking)
      is different from `onPrimaryEnded`'s (telling anything subordinate to
      the hold that the hold is gone), so the two stay separate hooks rather
      than overloading one.
- [x] `packages/core/src/daemon.ts`: constructs `coControl` right after
      `leases` (reads `settingsStore.get().coControl.{grantTtlSec,
      maxConcurrentPerDevice, mode}` fresh, and the SAME `resolveLeaseLabel`
      resolver `leases` itself uses); starts its reaper alongside
      `leases.startReaper()` and stops it in `stop()` alongside every other
      periodic timer (`00-overview.md` §7 item 7 — the daemon itself was not
      run as a background process this step, only its unit/integration
      tests, so there is no `ps` output to attach; `co-control.test.ts`'s own
      TTL test starts and stops a real `setInterval` via
      `startReaper()`/`stopReaper()` and passes, the in-process equivalent).
      Wires `onPrimaryEnded` into `createLeaseManager(...)`'s new
      hook, **and** — beyond this step's literal checklist, added because the
      stated safety property demands it — calls
      `coControlRef?.onPrimaryEnded(deviceId)` from inside the EXISTING
      `onManualTakenOver` handler too: a takeover is an atomic
      revoke-then-acquire that never calls `release()`, so it is the one way
      a manual hold can end that the new hook alone would never see: without
      this, the displaced holder's grant would silently survive them being
      displaced. **Deliberately NOT done, flagged rather than silently
      skipped**: `coControl` is not yet passed into `createWsMessageHandler(...)`
      — `WsHandlerDeps` has no `coControl` field, and `ws-handlers.ts` is step
      91.4's file, not this step's (91.1 built/owns it; 91.4 is the step that
      adds the `input.*` fallback and `assist.*` handlers that would actually
      consume it). A marker comment sits directly above `attachWsRouter` in
      `daemon.ts` naming this exact gap, and
      `daemon-wiring.test.ts` pins that the comment exists — the same posture
      91.3 already took for the co-control message union not yet being added
      to `ClientMessageSchema`/`ServerMessageSchema`.
- [x] `packages/core/src/lease/co-control.test.ts`: a grant dies when the job
      lease clears; when the manual holder releases (a plain voluntary
      release, plus separately an automatic idle-timeout revoke); on TTL (real
      reaper, real timers, mirroring `presence.test.ts`'s own pattern); on WS
      close (`releaseAllForClient`, across two devices on one connection).
      Plus a fifth end path beyond the checklist: a takeover of the manual
      lease. A second grant on the same device is refused `assist_taken`
      naming the holder. A grant on an `idle` device is refused
      `device_not_held`. Also covers: idempotent re-grant (TTL refresh, no
      duplicate), `coControl.mode: 'off'` → `assist_not_allowed`, a
      script-declared deny → `assist_denied_by_script`, both primary kinds
      (`job` and manually-held-by-another-operator `user`, per §3.9's mirror
      table row that assist applies there too), `touch`, `assistedBy`'s wire
      shape (`kind: 'user'`, `takeable: false`), and
      `maxConcurrentPerDevice > 1`.
- [x] `packages/core/src/daemon-wiring.test.ts`: a new `describe` block pins
      that `createCoControlManager(...)` is really called (with `leases` and
      the live settings accessors, not a stub), that the reaper is started at
      boot and stopped in `stop()`, that `createLeaseManager(...)`'s call
      literally contains `onPrimaryEnded:` and that `onManualTakenOver`'s own
      body calls `coControlRef?.onPrimaryEnded(deviceId)`, and that the
      "not wired into the WS router yet" gap is marked in a comment a future
      edit cannot silently delete without this test also failing. The
      brace-matching helper's marker (`'createCoControlManager({'`) was
      checked to be unambiguous: the only other occurrence of the name in
      `daemon.ts` is the import line, which has no `(` immediately after it.
- **Verifiable result:** a grant can never outlive the hold it was subordinate
  to, proven for all four end reasons (job lease clears, manual holder
  releases — voluntary and automatic, TTL, WS close) plus a fifth
  (takeover) this step added on top of the checklist.

### 91.3 — Protocol, settings, ACL, spec

- [x] `packages/protocol/src/messages/input.ts`: `INPUT_ACTION_BODIES`;
      rebuild the five existing messages from it (wire-identical);
      `MirrorActionSchema`.
- [x] `packages/protocol/src/messages/co-control.ts`: new, the twelve messages
      of §4.4 plus `MirrorMemberSchema` / `MirrorResultSchema`.
- [x] `packages/protocol/src/device.ts`: `DeviceInfo.assistedBy`.
- [x] `packages/protocol/src/api/auth.ts:12-19`: `AuditEntrySchema.meta` (F24).
- [x] `packages/protocol/src/settings.ts`: `CoControlModeSchema`, the
      `coControl` and `mirror` blocks (§4.5).
- [x] `packages/core/src/auth/acl.ts`: `device.assist` in the OPERATOR set;
      `canAssist` (§4.6).
- [x] `packages/protocol/src/settings.test.ts`: defaults round-trip; the
      rebuilt input messages parse byte-identically to today's fixtures.
      (Locked down in `settings.test.ts` itself, plus `input.test.ts`
      unchanged and still green, plus a new `messages/co-control.test.ts` and
      a `DeviceInfoSchema.assistedBy` block in `device.test.ts`, and a
      `canAssist` block in `packages/core/src/auth/acl.test.ts`.)
- **Verifiable result:** `bash scripts/typecheck.sh`, `bun test`, and
  `bun run --cwd packages/studio test`/`build` are all green (verified at the
  end of this step; a transient `arbiter`-field typecheck failure from
  concurrent 91.1 work-in-progress elsewhere in the tree was observed
  mid-step and resolved itself by the end, by that other work landing — not
  fixed by this step). Every existing input-message test passes unchanged
  against the rebuilt schemas (`bun test packages/protocol/src/messages/
  input.test.ts` green, file untouched).
  Also NOT wired by this step, and flagged rather than silently left implied:
  the twelve co-control messages are declared and exported from
  `@enkaku/protocol` but are **not yet added to `ClientMessageSchema`/
  `ServerMessageSchema`** in `packages/protocol/src/index.ts` — that union
  wiring is left for step 91.4 (owned by whoever also wires
  `ws-handlers.ts`'s `input.*` fallback), per this step's "additive
  re-exports only" instruction for `index.ts`.

### 91.4 — The gate, wired narrowly (fixes F1's blast radius) — **DONE 2026-08-13**

- [x] `packages/core/src/server/ws-handlers.ts`: the plan's cited line numbers
      (`:1126-1141`, `lease-manager.ts:228-233`) had drifted again, as flagged
      as likely in this step's own brief — verified against the live file and
      re-derived. The `input.*` branch now resolves `allowed`/`source` per the
      §3.2 pseudocode exactly: `checkInputAllowed` first, `deps.coControl?.
      checkAssistAllowed` consulted ONLY as a fallback once that has already
      failed, and only `input.*` ever calls it. `touchManual` stays for the
      lease path (`lease.holder === clientId` makes it a safe no-op for a
      non-holder); the assist path calls `deps.coControl?.touch` instead — a
      new `if (source.kind === 'assist')` branch replaces the old
      unconditional `touchManual` call.
- [x] `assist.start` / `assist.stop` handlers: gated by `canAssist(role,
      coControlMode)` (`auth/acl.ts`, already built by 91.3); the script's
      `assist` declaration is honoured through `co-control.ts`'s existing
      `scriptAssistPolicy` hook inside `grant()` itself (permissive until
      91.5 supplies real per-job data, by that hook's own documented
      default — nothing to wire here); `assist.started`/`assist.stopped` are
      unicast replies; `assist.changed` is broadcast from `daemon.ts`'s
      `createCoControlManager(...)`'s new `onGranted`/`onReleased` hooks
      (through `hub.broadcast`) rather than only from these two handlers —
      deliberately, so TTL expiry, a WS disconnect
      (`coControl.releaseAllForClient`, also newly wired into `handleClose`),
      and the primary hold ending all broadcast too, not only the two
      explicit WS messages. `WsHandlerDeps` gains `coControl?: CoControlManager`
      and `coControlMode?: () => CoControlMode`, both OPTIONAL (unlike
      `leases`) so the ~10 existing `ws-handlers-*.test.ts` fixtures that
      construct `WsHandlerDeps` object literals directly did not all need a
      stub added for a dep they never exercise — omitted means "co-control
      does not exist here", the same convention `agent`/`readiness`/
      `crashWatch` already use in this exact file.
- [x] `packages/core/src/api/devices.ts`: `assistedByOf?: (deviceId: string)
      => LeaseHolder[]` added to `createDeviceRoutes`'s deps, populated in
      all three `rowToDeviceInfo` call sites this router owns (`infoWithTags`,
      `GET /`, `GET /:id`) by spreading `rowToDeviceInfo(...)`'s result and
      overriding `assistedBy: deps.assistedByOf?.(id) ?? []` — `rowToDeviceInfo`
      itself (`registry/device-registry.ts`) was NOT touched (outside this
      step's file-ownership list), so this dep overrides the schema's own
      `[]` default rather than threading a new parameter through that
      function. `daemon.ts` wires `assistedByOf: (deviceId) =>
      coControl.assistedBy(deviceId)` at the ONE `createDeviceRoutes({...})`
      call site. **Known gap, flagged rather than silently left**:
      `topology.ts`/`clusters.ts`/`capability/context.ts` also build
      `DeviceInfo` via `rowToDeviceInfo`/`listDevicesWithTags` with their own
      `heldByOf`, but are outside this step's file list and were not touched
      — a device's `assistedBy` reads `[]` on Topology, a cluster's device
      list, and the capability layer even while genuinely being assisted.
- [x] `packages/core/src/server/ws-handlers.assist.test.ts` (new): **the
      containment test.** One client holding only a grant (a job holds the
      device throughout; `roleOf` is `admin` and every farm switch is
      maximally permissive everywhere, isolating every refusal to the LEASE
      gate specifically) is refused by `shell.exec`, `inspect.attach`,
      `clipboard.set`, `POST /:id/push` and `POST /:id/adb-endpoint` — all
      five, same device, one test, all `device_busy` — while its `input.tap`
      succeeds (asserted via a spy on the fake `InputSink.tap`, going through
      a REAL `createInputArbiter`). **No security finding**: all five refuse
      exactly as F1 requires, structurally — none of their call sites
      (`ws-handlers.ts`'s `shell.exec`/`inspect.attach`/`clipboard.set`
      branches, `api/transfer.ts`, `api/adb-endpoint.ts`) was given the
      assist fallback. A second test in the same file proves the fallback
      never masks the original `checkInputAllowed` refusal for a client that
      holds no grant at all (still `device_busy`, never a misleading
      `no_grant`).
- [x] `packages/core/src/daemon.ts` / `packages/core/src/daemon-wiring.test.ts`
      (Task B, closing gaps 91.2 and 91.3 deliberately left open): `coControl`/
      `coControlMode` are now passed into `createWsMessageHandler(...)`; the
      "NOT WIRED YET ... step 91.4" marker comment above `attachWsRouter` is
      deleted; `daemon-wiring.test.ts`'s pinning test now asserts the real
      wiring (`coControl,` / `coControlMode: () => settingsStore.get()
      .coControl.mode` inside the `createWsMessageHandler({` call) instead of
      the marker's continued existence, plus a new test pinning the
      `onGranted`/`onReleased` → `hub.broadcast({ type: 'assist.changed' ...`
      wiring. The twelve co-control messages (`packages/protocol/src/index.ts`)
      are now in `ClientMessageSchema` (the five C→S: `assist.start`,
      `assist.stop`, `mirror.start`, `mirror.stop`, `input.mirror`) and
      `ServerMessageSchema` (the seven S→C: `assist.started`,
      `assist.stopped`, `assist.changed`, `mirror.started`, `mirror.stopped`,
      `input.mirror.result`, `mirror.changed`) — additive only, appended
      after a fresh read of the file per this repo's rule on it (three other
      workers had appended to it the same day). `mirror.*`'s own WS-handler
      cases do not exist yet (step 91.7 builds `packages/core/src/mirror/
      group.ts`) — those five message types are therefore reachable and
      Zod-valid but produce no response yet, the same as any other
      not-yet-implemented case in this switch (there is no exhaustiveness
      check on it).
- **Verifiable result:** a device with a running job accepts `input.tap` from a
  granted client and refuses `shell.exec`/`inspect.attach`/`clipboard.set`/
  `POST /:id/push`/`POST /:id/adb-endpoint` from the same client — proven by
  `ws-handlers.assist.test.ts`, 2 tests, both green. `bash scripts/typecheck.sh`
  (every package OK), `bun test` (3662 pass, 0 fail, across 269 files, including
  `daemon-wiring.test.ts`'s 12 tests and `co-control.test.ts`), `bun run
  --cwd packages/studio test` (655 pass, 0 fail) and, run alone per
  `00-overview.md`'s own warning about concurrent invocation, `bun run --cwd
  packages/studio build` are all green. No physical device is needed for
  anything in this step — everything above is server-side WS/HTTP routing and
  a settings-driven gate; the plan's own hardware-dependent checks (§7.2's
  device smoke test, §7.3's assist rung, §7.4's mirror ladder) are for later
  steps (91.6+) and are recorded there, **pending — owner to run**.

### 91.5 — Attribution (fixes the §3.5 requirement; F17, F19, F24) — **DONE 2026-08-13**

- [x] `packages/core/src/db/schema.ts`: `jobs.assistCount`; Drizzle migration
      via `bun run --cwd packages/core db:generate` (`0046_watery_quentin_quire.sql`,
      plain `ALTER TABLE jobs ADD assist_count integer DEFAULT 0`, never hand-written).
- [x] `packages/core/src/server/ws-handlers.ts`: on an accepted assist action,
      add `meta.assist: true` and `meta.jobId` to the existing recorder call
      (the plan's cited `:1155-1168` had drifted, as flagged as likely by this
      step's own brief — re-derived against the live file's five `input.*`
      recorder calls) and increment `jobs.assistCount` (a plain
      `COALESCE(...,0)+1` update, keyed off a freshly-resolved `assistJobId`
      — null unless the primary hold is actually a job, §3.9's "manual, held
      by someone else" row correctly contributes nothing here).
- [x] `control.assist.started` / `control.assist.ended` main-stream events;
      `MAIN_EVENT_KINDS` (`packages/protocol/src/messages/device-event.ts`).
      Recorded from three of the four places a grant can start/end —
      `assist.start` ('started'), `assist.stop` ('released'), `handleClose`
      ('disconnected', via a new `CoControlManager.grantsForClient`) — **known
      gap, flagged rather than silently left**: `ttl`/`primary_ended` are NOT
      recorded, because their only trigger is `daemon.ts`'s
      `createCoControlManager(...)`'s `onGranted`/`onReleased` closures
      (today wired only to `assist.changed`), a file this step could not
      touch; a self-detecting test in `daemon-wiring.test.ts` pins the exact
      gap for `onAssist` (a related but separate wiring need, see below) —
      the ttl/primary_ended recording gap itself is documented in prose here
      rather than with a second guard test, to avoid over-specifying a shape
      the eventual `daemon.ts` wiring pass is free to choose.
- [x] `audit.record({ action: 'device.assist', target: deviceId, meta: { jobId, primaryKind } })`
      and the new `'device.assist'` literal in
      `packages/core/src/auth/audit.ts` — same three trigger points as the
      main-stream event above, same ttl/primary_ended gap.
- [x] `GET /api/jobs/:id/assists` (§4.9) — the indexed range query, no JSON
      extraction. Needed no new dependency threading anywhere: `JobStore.assists(jobId)`
      (new, closes over the store's own `db`) does the query;
      `JobService.assists(jobId)` turns a missing job into `job_not_found`;
      the route is `service.assists(id)` — `service` was already a positional
      argument to `createJobRoutes`, so no daemon.ts touch was needed.
- [x] `packages/session/src/runner/ipc.ts`: the `assist` parent→child variant
      (the second unsolicited push ever, after `abort`) and `ready.assist`;
      `child-entry.ts` handles both directions; `packages/sdk/src/types.ts`:
      `ctx.onAssist`, `ScriptDefinition.assist`.
- [x] `packages/core/src/jobs/executor-host.ts`: `notifyAssist(jobId, e)`,
      shaped exactly like `notifyCrash` — a second handler map
      (`assistHandlers`), same lifecycle. `job-runner.ts` gained the actual
      IPC delivery (`RunningJob.notifyAssist`/`JobRunner.notifyAssist`, a
      second ref-cell beside `aborter`) and `executors/script.ts` wires
      `ctx.onAssist?.((e) => deps.runner.notifyAssist(job.id, e))` beside its
      existing `ctx.onCrash?.(...)` line — beyond the step's literal
      checklist, but required for `notifyAssist` to reach anywhere. **Known
      gap**: `WsHandlerDeps.onAssist` (the hook the `input.*` branch calls)
      is declared and consumed, but `daemon.ts` does not yet pass
      `onAssist: (jobId, e) => host.notifyAssist(jobId, e)` into
      `createWsMessageHandler(...)` — self-detected by a new
      `daemon-wiring.test.ts` test that fails until that one line lands.
      Also not wired: `co-control.ts`'s `scriptAssistPolicy` hook still reads
      its permissive default rather than a real per-job `ready.assist`
      declaration — connecting the two needs a jobId→policy registry
      reachable from `daemon.ts`'s `createCoControlManager(...)` construction,
      which is the same file-ownership boundary as the `onAssist` gap above;
      flagged here rather than silently assumed done.
- [x] `packages/studio`: an "assisted" badge on the job row (`JobsList.tsx`,
      the one shared job-row component) and an **Assisted by** section on the
      job detail page (`app/jobs/detail/page.tsx`, hidden entirely when
      empty); `DeviceLog.tsx` renders the two new kinds; the audit table
      (`app/settings/page.tsx`'s `AuditSection`) renders `meta` via a new
      expandable `AuditRow`, the same disclosure pattern `DeviceLog.tsx`'s
      `EventRow` already established (F24).
- **A decision this step had to make**: whether a MIRRORED action (step
  91.7) should write attribution too, and if so, per-device or aggregated.
  91.7 built `dispatch` with neither, matching §4.7's own literal
  pseudocode, and flagged the gap. This step read the code and chose
  PER-DEVICE rows over one aggregate row per mirror action — the full
  reasoning (an aggregate row has no honest place to live in a
  single-`deviceId` table, and would make a mirrored assist on a busy member
  invisible to `GET /api/jobs/:id/assists`) is in the status paragraph above
  and in `mirror/group.ts`'s own `MirrorManagerDeps.recorder` doc comment.
  Write amplification is real (up to `mirror.maxDevices`× per action) and is
  stated plainly rather than hidden: it is the same cost N separate human
  operators already produce today, riding the same buffered-transaction
  recorder.
- **Verifiable result:** run a job, assist it three times, let it finish.
  `jobs.assistCount` is 3; `GET /api/jobs/:id/assists` returns exactly those
  three actions with the operator's id; the job detail page shows them; the
  audit log names the device and the job. **Proven in software**:
  `ws-handlers.assist.test.ts`'s new "assist attribution" describe block runs
  this exact scenario against real SQLite tables (a real `jobStore`, a real
  `device_events` write/read round trip). **Pending — owner to run** for the
  hardware half (a real device, a real Studio session) — exact commands and
  an outcome table are in the status paragraph above, per this plan's own
  hardware-honesty rule. `bash scripts/typecheck.sh` (every package OK),
  `bun test` (3781 pass, 2 fail — this step's own deliberate self-detecting
  `daemon-wiring.test.ts` gap plus plan 99's unrelated, pre-existing
  `executor-kind-dispatch.test.ts` guard, neither a regression), `bun run
  --cwd packages/studio test` (699 pass) and, run alone, `bun run --cwd
  packages/studio build` are all green.

### 91.6 — Studio: assisting one device (Part 1 complete) — **DONE 2026-08-13**

- [x] `packages/studio/src/app/device/page.tsx` (the line number in the
      checklist above, `:372`, was already stale by the time this step
      started — the real line had drifted to 500 — `inputEnabled` becomes
      `(iHoldControl && !busy) || iAmAssisting`.
- [x] `AssistDialog.tsx`: §3.12's copy, modelled on `TakeControlDialog.tsx`,
      naming the script and the TTL (`humanTtl`).
- [x] `ScreenCard.tsx`: the pre-assist banner and the assisting chrome (§3.4)
      — amber border, `.rack-label`, `.readout` countdown, plus a "Stop
      assisting" action (`AssistStopMessage` already existed core-side with
      nothing in Studio to send it).
- [x] `HolderBadge.tsx` / `DeviceCard` / `WallTile` / `DeviceHeader`: render
      `assistedBy`, via a new `variant: 'assists'` on `HolderBadge` itself
      (amber, "Assisting —"/"Assisted by" — an assist is never a takeover).
      `DevicePicker.tsx` was missed by this list (it renders `heldBy` via the
      same `HolderBadge` but had no `assistedBy` block) — closed 2026-08-13,
      `docs/plans/96-m61-hotfixes.md` §96.12.
- [x] `packages/studio/src/lib/ws.ts` consumers: handle `assist.changed`,
      `assist.stopped` — `ws.ts` itself is a generic envelope client with no
      per-message-type branches of its own (confirmed by reading it before
      writing anything), so "consumers" is `device/page.tsx`'s own `ws.on`
      callback, the same file every other per-device message
      (`lease.changed`, `device.battery`, ...) is already handled in.
- [x] Studio tests (rendered, per `00-overview.md`'s repair-series rule): the
      banner appears for a busy device; the dialog names the script; the
      assisting chrome renders; input is enabled only with a grant. See the
      status line above for the full file list and counts.
- **Verifiable result:** with a job running, the device page offers Assist,
  the dialog names `checkout@1.4.2`, and after confirming, a tap reaches the
  phone while the job's lease countdown in the header keeps running unchanged.
  Proven in Studio's own suite as far as no physical device is needed:
  `ScreenCard` receives `inputEnabled: false` while busy-and-not-assisting and
  `inputEnabled: true` the instant `assist.started` resolves
  (`device/page.test.tsx`), and the flow never sends a `lease.*` message
  (so `heldBy`/the job's own hold is provably untouched). **The "a tap
  physically reaches the phone" half needs real hardware and was NOT run —
  see the pending manual smoke test below.**

  **Pending — owner to run**, on a real device, with a script that runs long
  enough to assist mid-job (`checkout@1.4.2` or any script with a `Bun.sleep`):
  1. Run a script against a real device from Studio; wait for it to reach
     `busy`/`running`.
  2. Open that device's page. Expect: the Control tab shows a chip reading
     "`<script>@<version>` is running on this device." with an **Assist**
     button, and the video is NOT interactive (taps do nothing).
  3. Click **Assist**. Expect: a dialog titled "Assist `<label>` while its
     job keeps control?", naming the script and "Assisting stops on its own
     after 5 minutes without input." (or the farm's configured
     `coControl.grantTtlSec`).
  4. Click **Assist** in the dialog. Expect: the dialog closes; the video
     card gains an amber border with a `ASSISTING — THE JOB STILL HAS
     CONTROL` label and a `mm:ss` countdown; a tap on the video now reaches
     the device (confirm by watching the phone's own screen or the script's
     own logged actions responding to it); the job keeps running
     uninterrupted (watch its own progress/logs); the header shows no change
     to who holds control (`heldBy` stays the job, no "Take control" prompt
     appears).
  5. Click **Stop assisting**. Expect: the amber chrome is replaced by the
     pre-assist banner again; the video stops accepting input; the job is
     still running, unaffected throughout.

  | Step | Expected | Observed |
  |---|---|---|
  | 2. Pre-assist banner | Names the script; Assist button present; input off | _pending_ |
  | 3. Dialog copy | Names the script and the TTL | _pending_ |
  | 4. Tap after confirming | Reaches the device; job keeps running; header unchanged | _pending_ |
  | 5. Stop assisting | Reverts to the pre-assist banner; input off again | _pending_ |

### 91.7 — Mirror groups, core (Part 2's engine) — **DONE 2026-08-13**

- [x] `packages/core/src/mirror/group.ts`: new, per §4.7 — `start` with the
      §3.9 resolution table, `dispatch` with the per-lane orientation gate,
      aspect flagging, auto-drop, `reconcile`, `stopAllForClient`. `resolveOne`
      is the single function both `start` and `reconcile` call — re-admitting
      a device can therefore never grant more than a fresh `mirror.start` on
      that one device would. `dispatch` does **not** re-check
      `checkInputAllowed`/`checkAssistAllowed` on every action; it trusts the
      authorization `start`/`reconcile` already established (an ordinary
      manual lease or an ordinary co-control grant, through the exact same
      doors a single-device operator uses — never `takeOverFrom`, per §3.10),
      exactly as §4.7's own "dispatch in full" pseudocode does. Two additions
      beyond that literal pseudocode, both flagged here rather than silently
      made: (1) a successful mirrored action also refreshes the member's
      underlying lease/grant TTL (`leases.touchManual`/`coControl.touch`) —
      without this, a long mirror session would have its assist grants expire
      out from under it mid-use; (2) `mirror.start` refuses the WHOLE request
      with `mirror_too_many_devices` when more devices are requested than
      `mirror.maxDevices` allows, rather than silently truncating the list.
- [x] `packages/core/src/server/ws-handlers.ts`: `mirror.start`, `mirror.stop`,
      `input.mirror`; unicast `input.mirror.result` and (via a new
      `sendToClient` helper, since `mirror.changed` is unicast to the owner,
      unlike `assist.changed`'s broadcast) `mirror.changed`. The
      `MirrorManager` is constructed inside `createWsMessageHandler` itself
      (the same place `monitors`/`crashWatcher`/`shellSessions` already are),
      only when both the new optional `WsHandlerDeps.coControl` and
      `WsHandlerDeps.states` are wired — `states` is new this step (a narrow
      `Pick<DeviceStateMachine, 'current'>`, since `mirror.start` is the
      first caller in this router that needs a device's RAW status rather
      than one client's `checkInputAllowed` answer). `handleClose` now also
      calls `mirror?.stopAllForClient(state.clientId)`, beside the existing
      `leases.releaseAllForClient`/`coControl.releaseAllForClient` calls —
      deliberately NOT releasing the members' own leases/grants a second
      time (those two calls already do that, regardless of which mirror
      group they were resolved through). One gap this step found and closed
      rather than left for Studio: unlike `coControl.grant`, plain
      `leases.acquireManual` has **no** centrally-wired "just acquired"
      broadcast hook — every existing `lease.acquire` broadcasts
      `lease.changed`, fans out `device.viewers`, records `control.acquired`,
      and writes the audit row **at its own WS call site**. A `lease`-mode
      mirror member that just got a fresh manual lease needs the identical
      treatment, or every other tab watching that device would silently
      never learn who holds it now (F25) — `mirror.start`'s handler now
      repeats that exact four-part broadcast for every member it resolved to
      `lease` (skipped for members that were already the operator's own
      lease, since re-broadcasting an unchanged holder is harmless but adds
      nothing).
- [x] Refuse `internal:install` members by name (F27) and re-admit them on
      `job.finished`; refuse node-owned devices `node_owned` (§2, via a
      `nodeIdFor` accessor wired from `remoteSessions?.nodeIdFor`, structurally
      typed rather than importing `ws-handlers.ts`'s `RemoteSessions`
      interface into `mirror/group.ts` — that file already imports
      `MirrorManager`'s type the OTHER direction, so importing a value the
      first way would make the two modules genuinely circular). The re-admit
      is wired the same forward-ref way every other WS-router hook in
      `daemon.ts` is: `handler.reconcileMirror` is assigned to a new
      `reconcileMirrorForDevice` forward-ref inside `attachWsRouter`, and
      `host`'s pre-existing `onJobFinished` callback (which already fires for
      EVERY job, not only `internal:install`) now also calls
      `reconcileMirrorForDevice?.(deviceId)` — a harmless no-op for a device
      that belongs to no mirror group. `daemon-wiring.test.ts` pins both the
      `states`/`mirrorSettings` accessors reaching `createWsMessageHandler`
      and the `onJobFinished` → `reconcileMirrorForDevice` wiring, so a
      future edit cannot silently drop either without a test failing.
- [x] **Beyond the checklist**: a second gate this step added and flagged —
      `MirrorManagerDeps.assistAllowedFor` runs `canAssist(role, mode)` (the
      SAME check `assist.start` enforces) once per member that would need a
      **fresh** co-control grant, not once for the whole `mirror.start` call.
      `co-control.ts`'s own §4.2 doc comment states plainly that `canAssist`
      is "the REAL gate ... checked before `grant()` is ever reached" and
      names `mirror.start` as the second door that reaches `grant()`
      directly — without this, an operator lacking `device.assist` could
      have minted assist grants through the mirror path with no role check
      at all, while `coControl.grant()` itself only enforces the FARM-WIDE
      `mode: 'off'` switch, never a role. Checking it per-member (not for the
      whole call) means an operator who cannot assist still mirrors a group
      of otherwise-idle devices normally; only the members that would have
      needed assisting are skipped `assist_not_allowed`.
- [x] `packages/core/src/mirror/group.test.ts` (new, 13 tests, all pass):
      built against REAL `LeaseManager`/`CoControlManager`/`DeviceStateMachine`
      instances over an in-memory SQLite db (the same pattern
      `co-control.test.ts` established for this plan) — only `sessions` and
      `jobs` are faked, so a test's `lease`/`assist` mode is what the real
      stores actually issued, not an assertion about a fake agreeing with
      itself. The step's own scenario: 10 selected devices — 5 idle (→
      `lease`), 1 busy with an ordinary job but deliberately given **no live
      session** (→ `assist`, but every dispatch to it still fails
      `E_DEVICE_NOT_READY` — proving an authorized-but-not-live member still
      gets an honest per-device result, never a silent success), 1 idle but
      landscape while the focus device is portrait (→ `partial`,
      `orientation_mismatch`), 2 offline (→ `skipped: unavailable`), 1 busy
      running `internal:install` (→ `skipped: installing`) — one
      `mirror.started` names all 10; a tap reaches exactly the 5 `lease`
      members and reports 5 non-deliveries, every one with a code; a **key**
      to the SAME group reaches the rotated device too (6 ok, matching the
      per-lane gate withholding only pointer verbs); solo narrows delivery to
      exactly one named device, and soloing a non-member device is refused
      rather than silently ignored. A separate two-device scenario proves
      three consecutive failures on one action drop that member with
      **exactly one** `mirror.changed` (not one per failure), and that the
      drop sticks (a fourth action refuses at the "already skipped" gate
      before ever reaching the sink again). Plus, beyond the step's own
      list: node-owned refusal by name; the per-member `assist_not_allowed`
      role gate (an idle sibling member still gets an ordinary lease in the
      same call); `mirror.maxDevices` as a whole-request refusal; F27's
      re-admit through `reconcile` (an `internal:install`-skipped member
      rejoins as `lease` the instant `clearJobLease`/`JOB_FINISHED` run,
      firing exactly one `mirror.changed`, while reconciling a device that
      belongs to no group is a harmless no-op); and `stop`/`stopAllForClient`
      (a no-op for a non-owner; removes only the calling client's own
      groups, leaving another owner's group dispatchable).
- **Verifiable result:** every device in the §3.9 table produces its documented
  `MirrorMember`, and no action ever completes without a per-device result —
  proven by `group.test.ts`'s 13 tests. `bash scripts/typecheck.sh` (every
  package OK), `bun test` (3753 pass; the only 2 failures anywhere in the
  workspace are `api/workflows-wiring.test.ts`, plan 99's in-progress
  concurrent work in a file this step never touched — confirmed by mtime and
  `git status`), `bun run --cwd packages/studio test` (657 pass) and, run
  alone per `00-overview.md`'s own warning, `bun run --cwd packages/studio
  build` are all green.
  **What has a real producer AND consumer end to end, and what does not
  yet**: `mirror.start`/`mirror.stop`/`input.mirror` are fully wired
  core-side — a WS client sending them today gets a real `mirror.started`/
  `mirror.stopped`/`input.mirror.result`, and `MirrorMemberSchema`/
  `MirrorResultSchema` reach the wire unchanged from step 91.3/91.4's
  protocol work. What is **not yet** wired, because it is step 91.8/91.9's
  job: Studio sends none of these three messages anywhere (no selection UI,
  no focus overlay, no mirror rail exist yet), so `MirrorManager` is a
  correct, tested engine with no client reaching it outside a WS tool or a
  test — the same "protocol declared, core wired, Studio not yet" gap
  91.4 itself already left open for `assist.*`, now closed for `assist.*`
  by nothing in THIS step (91.6 is Studio's own job for that half) and left
  open the identical way for `mirror.*`. `jobs.assistCount`/the
  `device_events`/audit attribution for a MIRRORED action (as opposed to a
  single-device assist) is **not** written anywhere — `mirror.ts`'s
  `dispatch` does not call `deps.recorder.record`/`deps.audit.record` at
  all, deliberately matching §4.7's own literal "dispatch in full"
  pseudocode, which has no such call either. This means a mirrored tap
  leaves **no** `device_events` row and is invisible to `GET
  /api/jobs/:id/assists` even once step 91.5 lands, which only reads
  `device_events` for its range query — flagged here as a real gap against
  F16's "every input is already recorded" invariant, not silently left
  implied. A future step (91.5's own owner, or a dedicated follow-up) should
  either thread `recorder`/`audit` through `MirrorManagerDeps` the same way
  this step already threads them through the `lease`-mode broadcast in
  `ws-handlers.ts`, or explicitly accept the gap in writing.

### 91.8 — Studio: selection, the badge, the wall (Part 2's surface; fixes F11, F12) — DONE

- [x] `packages/studio/src/app/page.tsx` (the cited `:384`/`:85-87`/`:306-317`
      were already stale, as flagged — verified against the live file):
      selection is available in **Wall** view, not only list. Migrated the
      hand-rolled `Set` onto `useBulkSelection` (`use-bulk-selection.ts`) —
      select-all (`bulk.toggleAll`/`bulk.allChecked`, a new "Select all"/
      "Clear all" button) and tri-state come for free; the toggle and the
      bulk toolbar are no longer gated to `view === 'list'`.
- [x] A cursor-anchored count badge while dragging or hovering in select mode —
      the owner's *"mouse akan ada indikator device yang terseleksi berapa"*
      (new `SelectionCursorBadge.tsx`). `prefers-reduced-motion` honoured (via
      `globals.css`'s existing global rule); offset from the raw cursor
      position AND `pointer-events-none`, so it never covers the pointer
      target.
- [x] `WallTile.tsx`: a selected outline, an `onDoubleClick` that sets
      `?focus=`, and the **Controlling here** placeholder for the focused tile
      (§3.11). Single click still navigates via a `DOUBLE_CLICK_WINDOW_MS`
      (220ms) deferred `router.push`, the mechanism a click-before-dblclick
      browser forces on anyone combining the two on one element.
- [x] Rendered Studio tests: selection persists across a view switch
      (`page.test.tsx`); the badge counts (`page.test.tsx`,
      `SelectionCursorBadge.test.tsx`); double-click sets the URL
      (`page.test.tsx`, `WallTile.test.tsx`); single click still navigates
      (`WallTile.test.tsx`, proven with a real `userEvent.dblClick` sequence
      alongside it, not just the two handlers in isolation).
- **Verifiable result:** select 10 on the Wall, the badge reads 10, double-click
  one, and its tile becomes the placeholder while the overlay opens. **Proven
  through 91.8's own scope**: selecting N tiles shows the badge reading N
  (`page.test.tsx`), double-clicking a tile sets `?focus=` and (unit-tested
  directly on `WallTile`) swaps its picture for the placeholder. The overlay
  itself opening is 91.9's own component and is not yet built — this step
  owns the placeholder and the URL it reads from, not the overlay.

### 91.9 — The focus overlay and the function rail (Part 3) — **DONE 2026-08-13**

- [x] `packages/studio/src/components/wall/FocusOverlay.tsx`: URL-driven
      (`?focus=`, read from a `deviceId` prop `app/page.tsx` derives from the
      param — the same "the page owns the URL, the component is a plain
      controlled prop" shape `Wall`'s own `focusId` already established in
      91.8), not a `Dialog` (a plain `fixed`, natively-`resize`-able panel,
      no focus trap, no full-screen backdrop), `Esc` to close **without**
      stealing `LiveView`'s `Esc`→`BACK` binding when the canvas has focus —
      resolved with a `window`-level `keydown` listener that backs off
      whenever `e.defaultPrevented` is already `true`, needing no change to
      `LiveView`'s own binding at all. Proven both directions against a REAL
      `LiveView` in `FocusOverlay.escape.test.tsx`.
- [x] The vertical rail of §3.11's nine items — every one reusing an existing
      component (F26) except Assist, Mirror, Focused only and End task: an
      ordinary non-`compact` `<LiveView>` already carries Back/Home/Recents,
      Power/Volume/Mute, Wake/Sleep and Clipboard; `RotationQuickAction` and
      a plain `next/link` cover Rotate and Open full device page.
- [x] Quality handoff: the overlay requests `control` (`<LiveView
      quality="control">`); `WallTile`'s own "Controlling here" placeholder
      (91.8) already stops the focused tile decoding, so no extra decoder is
      created — proven as a mount count in `FocusOverlay.test.tsx`, not
      merely asserted.
- [x] Mirror controls in the rail: on/off (`mirror.start`/`mirror.stop`,
      behind a group confirmation naming the candidate count), the live
      member count (`{active}/{total}` from `mirror.started`/
      `mirror.changed`), and the per-action result strip (`{ok}/{total}`,
      click to name the failed devices and their codes, fed by a new
      `mirror` prop on `LiveView` that routes `sendInputAction`'s single
      choke point through `input.mirror` instead of `input.<verb>` — the
      ONE additive change this step made to that file, unreachable when the
      prop is absent, which is every pre-existing caller).
- [x] `Alt` (tracked via `window` keydown/keyup/blur) and the rail's
      "Focused only" `Switch` both set `soloDeviceId` on the next dispatched
      action without leaving Mirror mode.
- **Verifiable result:** on the Wall with 8 tiles live, opening the overlay
  leaves the browser decoding 8 streams, not 9; closing it restores the tile.
  **Proven** — `FocusOverlay.test.tsx`'s decoder-count test mounts 8 real
  `WallTile`s (one focused) plus a real `FocusOverlay` for the same device,
  against a `LiveView` stub that records every mount, and asserts exactly 8
  distinct mounts with the focused device's id appearing exactly once (from
  the overlay, never its own suppressed tile).

### 91.10 — Observability (tests H2, H4) — **DONE 2026-08-13**

- [x] `packages/core/src/api/adb-stats.ts`: the `input` block (§4.10), plus
      `queueWaitMs`/`uncollectedGrants`/`orphanedMirrorGroups` beyond the
      literal pseudocode (see the plan's own status paragraph for why).
- [x] `packages/core/src/doctor/checks/`: a `co-control` check — lane wait p95
      against the budget, uncollected grants, mirror groups whose owner
      connection is gone. `warn`, never `fail` (matches `streamsCheck`'s own
      precedent), each condition named in the remedy.
- [x] One `warn`, rate-limited (10s per device+lane), whenever an action is
      refused `E_INPUT_BUSY`, naming the lane and the blocking source — both
      on the single-device `input.*` path (`ws-handlers.ts`'s one outer
      catch) and the mirror path (`group.ts`'s `dispatch`, which never
      throws up to that catch and so needed its own independent limiter).
- Also closed this step: the one deliberate-guard failure `daemon-wiring.test.ts`
  left for a later worker (step 91.5's attribution chain's last line,
  `onAssist: (jobId, e) => host.notifyAssist(jobId, e)` beside `onJobCrash`
  in `daemon.ts`) — the tree now has zero deliberate-guard failures
  traceable to this plan.
- **Verifiable result:** `GET /api/adb/stats | jq '.input'` reports per-lane
  depth and percentiles under a real assist, and `enkaku doctor` reports a
  clean co-control section. Proven against a real running core (no device
  attached) for the wiring; the "under a real assist" traffic itself is
  hardware-gated and written up as **Pending — owner to run** above, with
  exact commands and an outcome table.

### 91.11 — Documentation and spec — **DONE 2026-08-13**

- [x] `docs/spec.md` §10.1: the amendment in §3.4, verbatim.
- [x] `docs/spec.md` §10.5 (new): the co-control grant — what it is, what it
      grants, what it explicitly does not, and its lifetime.
- [x] `docs/spec.md` §11.3: a paragraph naming the **third** actor (an
      assisting operator) beside the script author and the leased operator,
      and stating plainly that its reach is five input verbs, not a shell.
- [x] `packages/session/README.md`: the arbiter's three lanes and why (file
      created — it did not exist before this step).
- [x] `packages/core/README.md`: grants, mirror groups, the new settings.
- [x] `docs/guide/install.md`: an "assisting a running job" section and a
      "controlling many devices" section.
- [x] `docs/plans/00-overview.md` §2: a row for this plan.
- **Verifiable result:** `bun run spec:check` reports no new gap (GAP 0,
  unchanged before and after — a prior reconciliation pass had already added
  a terse §12.4 stub, which is why the check was already at 0; this step's
  fuller §10.1/§10.5/§11.3 text does not regress it); `bash
  scripts/check-plan-status.sh` passes. See this step's own status note,
  directly above its checklist, for the full account, the facts double-checked
  against the code rather than the plan's own draft text, and the one
  consolidated hardware-pending table below (immediately above §6), gathering
  every *pending — owner to run* note this plan's steps left scattered.

**Consolidated hardware-pending table**, gathering every *pending — owner to
run* note this plan's steps accumulated — 91.5's own attribution smoke test,
91.6's tap-reaches-the-phone script, 91.9's live-focus-overlay script, 91.10's
stats-under-a-real-assist script, and the plan's own §7.3 "assist rung" and
§7.4 "mirror ladder" test-plan sections (neither of which any step has yet
executed, since 91.6/91.9's own scripts cover smaller, concrete slices of
the same ground with 1–3 devices rather than the full 2/5/10/20-device
ladders §7 describes) — into the single list this task asked for, so an
owner sitting down with real hardware has one list to work through top to
bottom instead of six. **Every per-step note above stays exactly where it
is — this table adds a cross-reference, it does not replace any of them.**
None of these were run by this documentation pass; the prohibition against
touching a physical device applied throughout, exactly as it applied to
every step that first wrote these rows.

| # | Source | Claim | Exact command | Outcome |
|---|---|---|---|---|
| 1 | Step 91.5's own status note (`§5`, above) | Assisting a running job three times produces `jobs.assistCount: 3`; `GET /api/jobs/:id/assists` returns exactly those three actions with the operator's id; the job detail page's **Assisted by** card lists them; Settings → Audit shows two `device.assist` rows (started, released) whose expanded `meta.jobId` matches | See step 91.5's own 5-step script and outcome table (`§5` step 91.5, immediately below its checklist) | _(unfilled)_ |
| 2 | Step 91.6's own status note (`§5`, above) | The pre-assist banner names the running script and disables input; the Assist dialog names the script and the TTL; confirming makes a tap **physically reach the device** while the job keeps running and the header's `heldBy` shows no change; **Stop assisting** reverts to the banner and disables input again | See step 91.6's own 5-step script and outcome table (`§5` step 91.6, immediately below its checklist) | _(unfilled)_ |
| 3 | Step 91.9's own status note (`§5`, above) | Quick control opens instantly on an idle Wall tile; the Assist gate applies on a busy tile; toggling Mirror across 3 selected devices makes one tap visibly reach all 3 phones' screens; holding Alt narrows delivery to the focused phone alone; the result strip reads `3/3` after release; **End task** stops the job and clears the banner; `Esc` navigates Back on the phone while the canvas has focus and only closes the overlay once it does not | See step 91.9's own 9-step script and outcome table (`§5` step 91.9, immediately below its checklist) | _(unfilled)_ |
| 4 | Step 91.10's own status note (`§5`, above) | `GET /api/adb/stats \| jq '.input'`'s `lanes.pointer.depth`/`waitMsP50`/`waitMsP95` move off zero during a real assist burst; `mirrorGroups`/`mirrorMembers`/`mirrorFanoutMsP50`/`P95` reflect a live mirror group; `enkaku doctor`'s co-control line stays `ok` through an ordinary assist/mirror session; it correctly `warn`s naming `orphanedMirrorGroups` after a browser tab is killed abruptly mid-group (`kill -9`, not a clean close); and clears back to `ok` once the group ends | See step 91.10's own 7-step script and outcome table (`§5` step 91.10, immediately below its checklist) | _(unfilled)_ |
| 5 | Plan-wide §7.3, "The assist rung" (2 devices) — tests H1, H2 | 0 malformed interleaved pointer sequences across 100 alternating job/human taps; the `keys` lane's wait is ≈0 ms while a `typeText` runs on the `pointer`/`text` lanes; the `pointer` lane's wait is under 1000 ms during a running swipe; 0 `E_INPUT_BUSY` refusals across 30 minutes of normal use; a grant left idle 5 minutes ends with one `control.assist.ended` naming `reason: 'ttl'` | See §7.3's own table (this document, in §7 Test plan, just above §8 Risks) | _(unfilled)_ |
| 6 | Plan-wide §7.4, "The mirror ladder — 5 → 10 → 20" (release binary, the Windows fleet host from plan 85 §7.3) — tests H3, H4 | At each rung, not advanced until the previous is green: the group resolves the requested device count; a Home key and a same-app/same-screen tap both reach every member; `mirrorFanoutMsP95`, the `global.inFlight`/`streams.active` deltas during a mirrored swipe (must stay **0** at every rung — proves mirrored input never touches the adb exec/stream budgets), `transport.bufferedBytesP95`/`controlReplyMsP95` during a mirrored gesture, the decoding-stream count with the overlay open (≤ the rung size), and 0 taps landing on the wrong element; the 5-rung additionally includes one deliberately rotated device (must resolve `partial`, refuse the tap by name, still receive the Home key); the 10-rung additionally includes one device mid-`internal:install` (must resolve `skipped: installing`, rejoin automatically when the install ends) | See §7.4's own table and rung notes (this document, in §7 Test plan, just above §8 Risks) | _(unfilled)_ |

## 6. Acceptance criteria

1. A device running a job accepts `input.tap`, `input.swipe`, `input.gesture`,
   `input.key` and `input.text` from a client holding a co-control grant, and
   the job's lease holder and `expiresAt` are byte-identical before and after.
2. `DeviceStatus` never leaves `busy` because of an assist; the scheduler, the
   wall badge and `heldBy` are unchanged.
3. The same client is refused by `shell.exec`, `inspect.attach`,
   `clipboard.set`, `POST /:id/push` and `POST /:id/adb-endpoint`, with the
   same codes as before this plan.
4. Two concurrent input actions on one device never interleave their pointer
   writes; a `key` issued during a running `swipe` executes with no wait; an
   action that waits past `coControl.queueWaitMs` is refused with a message
   naming what it waited for.
5. A grant expires after `grantTtlSec` without input, is refreshed by input,
   and is revoked immediately when the job's lease clears, when the manual
   holder releases, or when the WS closes.
6. A second operator asking to assist the same device is refused
   `assist_taken`, naming the current assister.
7. `coControl.mode: 'off'` disables assisting farm-wide; a script declaring
   `assist: 'deny'` disables the button for its job, with a tooltip naming the
   script.
8. After a job that was assisted three times, `jobs.assistCount` is 3,
   `GET /api/jobs/:id/assists` returns those three with the operator's id and
   timestamps, the job detail page renders them, and one `device.assist` audit
   row per grant carries the jobId in a `meta` the API now returns.
9. A script registering `ctx.onAssist` is called once per intervention; a
   script that does not register runs identically to before this plan; no
   assist ever invokes `finish()` or aborts a job.
10. `mirror.start` over 10 devices — 2 offline, 1 busy, 1 rotated, 1 installing
    — returns one `mirror.started` naming every device's mode and reason, with
    nothing silently dropped.
11. A mirrored tap lands at the same fraction of every member's screen
    regardless of resolution or density; a rotated member is refused
    `orientation_mismatch` for pointer actions and **receives** keys and text.
12. Every `input.mirror` returns one `input.mirror.result` with an entry per
    target, including failures with codes and latencies. A member failing three
    consecutive actions leaves the group with one message naming it.
13. Solo sends to exactly one device, and the result names only that device.
14. A 20-device mirror consumes zero adb exec slots and zero adb stream slots
    (`/api/adb/stats` `global` and `streams` unchanged during a mirrored swipe).
15. Selecting on the Wall shows a live count badge at the cursor;
    double-clicking a tile opens the overlay, turns that tile into
    **Controlling here**, and does **not** increase the number of decoding
    streams.
16. The assist confirmation names the script and the device; the group
    confirmation names the counts of lease / assist / skipped devices; neither
    can be permanently suppressed.
17. `GET /api/adb/stats` reports the `input` block, and `enkaku doctor` reports
    a co-control section.
18. `docs/spec.md` §10.1 is amended and §10.5 exists.
19. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| arbiter ordering | `packages/session/src/input-arbiter.test.ts` | no interleaved pointer sequences; lane independence; assist priority is non-preemptive; depth and wait bounds; percentiles |
| grant lifetime | `packages/core/src/lease/co-control.test.ts` | all four end reasons; `maxConcurrentPerDevice`; refused on an `idle` device |
| **containment** | `packages/core/src/server/ws-handlers.assist.test.ts` | a grant-only client is refused by all five other surfaces while `input.tap` succeeds |
| gate fallback | same file | `checkInputAllowed` is unchanged; the fallback fires only for `input.*` |
| protocol | `packages/protocol/src/messages/input.test.ts` | the rebuilt messages parse identically to today's fixtures; `MirrorActionSchema` round-trips |
| settings | `packages/protocol/src/settings.test.ts` | `coControl` / `mirror` defaults; bounds |
| ACL | `packages/core/src/auth/acl.test.ts` | `canAssist` truth table across three modes × two roles |
| mirror resolution | `packages/core/src/mirror/group.test.ts` | the §3.9 table, device by device |
| mirror dispatch | same file | per-lane orientation gate; verbatim normalised coordinates; auto-drop; solo; every action returns N results |
| attribution | `packages/core/src/api/jobs.test.ts` | the range query returns exactly the human's actions and none of the job's |
| IPC | `packages/session/src/runner/ipc.test.ts` | the `assist` variant parses; an older child ignoring it is unaffected |
| Studio (rendered) | `packages/studio/src/components/*.test.tsx` | banner, dialog copy, assisting chrome, `assistedBy` badges, cursor count, double-click, placeholder |

### 7.2 Local smoke (1–2 devices)

```bash
bun run typecheck
bun test
bun run --cwd packages/studio test
bun run dev
curl -s localhost:7700/api/adb/stats | jq '.input'
```

Then, with one device: start a long script that sits in a `waitFor` loop; open
the device page; confirm the Assist banner names it; assist; tap the screen and
watch the script continue; stop assisting; check `GET /api/jobs/:id/assists`.

### 7.3 The assist rung (2 devices, real hardware) — tests H1, H2

| Measurement | How | Expected |
|---|---|---|
| interleaved pointer sequences | 100 alternating job/human taps, `logcat` for `MotionEvent` sanity | **0** malformed |
| assist wait, `keys` lane, during a running `typeText` | `/api/adb/stats` `input.lanes.keys.waitMsP95` | **≈ 0 ms** |
| assist wait, `pointer` lane, during a running swipe | `input.lanes.pointer.waitMsP95` | < 1000 ms |
| `E_INPUT_BUSY` refusals in 30 min of normal use | log grep | **0** |
| grant TTL honoured | idle 5 min | grant gone, one `control.assist.ended` with `reason: 'ttl'` |

### 7.4 The mirror ladder — 5 → 10 → 20 (tests H3, H4)

Run on the Windows fleet host from plan 85 §7.3, with the release binary, one
rung at a time. **Do not advance a rung until the previous one is green.** An
empty cell is a failed rung, not a skipped one.

| Measurement | How | 5 | 10 | 20 |
|---|---|---|---|---|
| devices in the group after `mirror.start` | `mirror.started` | | | |
| Home key delivered to all | count `ok: true` | all | all | all |
| tap delivered to all (same app, same screen) | count | all | all | all |
| `mirrorFanoutMsP95` | `/api/adb/stats` | | | |
| `global.inFlight` delta during a mirrored swipe | same | **0** | **0** | **0** |
| `streams.active` delta during a mirrored swipe | same | **0** | **0** | **0** |
| `transport.bufferedBytesP95` during a mirrored gesture | same | | | |
| `controlReplyMsP95` during a mirrored gesture | same | | | |
| decoding streams with the overlay open | DevTools | ≤ rung | ≤ rung | ≤ rung |
| taps landing on the wrong element | visual | **0** | **0** | **0** |

Rung notes:
- **5** — include one device deliberately rotated. It must be `partial`, refuse
  the tap by name, and receive the Home key.
- **10** — include one device mid-`internal:install`. It must be `skipped:
  installing` and rejoin automatically when the install finishes.
- **20** — the rung that tests H4. If `bufferedBytesP95` or
  `controlReplyMsP95` degrade during a mirrored gesture, record the numbers;
  they are input to plan 88, not to this plan.

### 7.5 Regression watch

- `coControl.mode: 'off'` → the Assist button is absent and `assist.start` is
  refused server-side; nothing else changes.
- A farm with no grants and no mirror groups behaves byte-identically to before
  this plan on every input path (the arbiter with one source is a pass-through
  plus one queue hop).
- The five existing `input.*` wire messages are unchanged (91.3's fixture test).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The arbiter adds a queue hop to every input, hurting glass-to-glass latency (spec §16). | With one source, the queue is always empty and the hop is a resolved promise. §7.3 measures `waitMsP50` and §7.4 measures fan-out; the budget is a setting. |
| The lane split is wrong — a key during a drag really does corrupt something on some device. | H1's test asserts ordering, but only hardware can prove behaviour. §7.3's first row is exactly this check. If it fails, collapse to a single lane and pay §3.3's latency cost, recorded as a deviation. |
| A human "helps" a job into a state its script cannot recover from, and the job then fails confusingly. | The failure is now *explained*: `jobs.assistCount`, the assist list, and the audit row are all on the job. §3.6's `ctx.onAssist` lets a script that cares react. A script that must not tolerate it declares `assist: 'deny'`. |
| Assist becomes the normal way to work, and leases stop being taken. | The grant is subordinate (§3.2): the moment the primary hold ends, it dies and the operator must take a real lease. It cannot be acquired on an idle device at all. |
| Two operators assist the same device and blame each other. | Default `maxConcurrentPerDevice: 1`, refused by name. Raising it is a deliberate act. |
| Normalised fan-out lands taps on the wrong element when the members have diverged. | Undetectable at this layer, and stated as such (H3). Mitigated by live tiles, the aspect chip, solo, and a group confirmation that names the count. §7.4's last row is the honest check. |
| Mirroring becomes a bulk-command path by accretion. | §3.10's list is enforced structurally — the four dangerous surfaces are refused by call sites this plan never touches — and §2 names plan 93 as the owner. A future PR adding a sixth verb has to change `MirrorActionSchema` *and* the grant scope, in the open. |
| A mirror group outlives its owner's tab and keeps N leases held. | `stopAllForClient` on WS close, the same path that already releases leases (`lease-manager.ts:242-246`), plus a doctor check for orphaned groups. |
| `retention.eventInputDays` (3 days) deletes the assist detail before anyone reads it. | `jobs.assistCount` is on the job row and survives; the detail query degrades to "we know it happened N times, the per-action list has been rotated out", which is honest. §9 Q4 asks whether the assist rows should be exempt. |
| The focus overlay's `Esc` fights `LiveView`'s `Esc`→`BACK`. | Named in §3.11 and 91.9 as a real collision with a defined rule (canvas focus wins), with a rendered test. |
| A 20-device mirror is bounded by video, not input, and the Wall's own cap (`wall.maxTiles`, default 8) makes a 20-member group partly blind. | §3.8/H4. The overlay keeps members at `wall` quality; raising `maxTiles` for a mirror session is plan 92's decision, and §9 Q6 asks it. |

## 9. Open questions — owner decisions

1. **DECIDED (2026-08-12): "Assist."** The owner chose **Assist**, from the
   three names on the table — Assist, Co-control, Join — on the grounds that it
   reads as *helping* rather than *taking over*, and does not collide with
   "control", which already names a specific, different thing in this product
   (the lease, `DeviceStatus`, the Control button). This ratifies what §3.2
   through §4 already assumed throughout rather than hedged on: `assistCount`
   on the jobs row, the "Assisting" rack-label and badge, the confirmation
   dialog's wording, the `device.assist` audit action and `control.assist.*`
   events, `checkAssistAllowed`/`canAssist`. None of that was a placeholder
   pending this answer — it is now confirmed as final, not merely convenient.
2. **Default farm mode.** `coControl.mode` defaults to `'operator'`: any
   authenticated operator may assist. The alternative is `'admin'`, matching
   `shell.mode`'s default. Assisting is far narrower than a shell (five input
   verbs, no filesystem, no commands), which is why `'operator'` is proposed —
   but it is a policy call, not a technical one.
3. **Assist priority.** §3.3 makes an assist jump *queued* job actions. The
   alternative is strict FIFO. Jumping serves the owner's stated purpose (a
   human unsticking a job); strict FIFO is simpler to reason about and never
   surprises a script's timing. If H2's measured waits turn out to be near
   zero anyway, strict FIFO becomes the better default.
4. **Assist-event retention.** Input events are GC'd after 3 days (F19), so a
   month-old job shows `assistCount: 3` and an empty detail list. Options:
   leave it (cheap, slightly unsatisfying); exempt rows with `meta.assist`
   from the input-stream sweep (`packages/core/src/maintenance/retention.ts:54-94`);
   or copy them onto the job as an artifact at settle. The first is proposed.
5. **Cloud / node devices.** §2 refuses them from mirror groups by name,
   because `RemoteSessions` exposes no arbiter (`ws-handlers.ts:176-181`).
   Should mirroring across node-owned devices be a follow-up plan, or is a
   mirror deliberately a local-fleet feature?
6. **The Wall cap during a mirror.** `wall.maxTiles` defaults to 8
   (`packages/protocol/src/settings.ts:954-969`), so a 20-member group has 12
   members the operator cannot see — which weakens §3.10's "divergence is
   visible" mitigation. Should a mirror session temporarily raise the cap to
   the group size, accept the blindness, or refuse a group larger than
   `wall.maxTiles`? This overlaps plan 92 and should be decided with it.
7. **Per-device opt-out.** Farm-wide and per-script switches are designed
   (§3.6). A third, `DeviceSettings.control.allowAssist`, would let one phone
   in a rack refuse help regardless. Deliberately left out to avoid three
   places to look when the button is disabled — but it is a plausible ask for a
   shared farm.
