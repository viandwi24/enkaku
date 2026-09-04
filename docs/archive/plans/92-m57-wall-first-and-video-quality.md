# Plan 92 — M57 : The Wall Is the Front Door, and the Picture Has Knobs

> Status: implemented and tested — all nine steps (92.1–92.9) done. Every
> acceptance criterion is proven at the unit/component/integration level;
> what remains is exclusively hardware/real-farm verification, which no
> worker on this plan ran (this repo's standing rule: no agent runs against
> a physical device or `redroid` instance) — the seven such items are
> consolidated into one table in step 92.9's own entry (§5), cross-referencing
> each step's own pending note rather than replacing it. 92.1 implemented and tested (`packages/session/src/video-profile.test.ts`, `packages/protocol/src/settings.test.ts`): the two quality profiles are farm/device settings now (`FarmSettings.video`, `DeviceSettings.video`), combined by `resolveVideoProfile` (`packages/session/src/video-profile.ts`), with byte-identical scrcpy arguments proven against the pinned pre-plan-92 constants. 92.5 also implemented and tested (`packages/studio/src/lib/prefs.ts`, `packages/studio/src/lib/prefs.test.ts`, `packages/studio/src/app/page.tsx`, `packages/studio/src/app/page.test.tsx`, `packages/studio/src/components/wall/Wall.tsx`, `packages/studio/src/components/wall/Wall.test.tsx`): the Wall is now the unconditional landing view — `view` precedence is URL → `sessionStorage` (this tab only) → `'wall'`, with no `wall.defaultView` farm setting anywhere in the chain (§9 Q1); the View toggle gained a Tile size (S/M/L) control persisted in `localStorage` and threaded into `TileGrid.minTileWidthPx`. `bun run build:studio` confirmed the static-export hazard does not fire: the prerendered `packages/studio/out/index.html` body is the Suspense/loading fallback, not real page content. 92.3 also implemented and tested (`packages/session/src/manager.ts`, `packages/session/src/manager.test.ts`, `packages/protocol/src/api/adb.ts`, `packages/protocol/src/api/adb.test.ts` (new), `packages/core/src/api/adb-stats.ts`, `packages/core/src/api/adb-stats.test.ts`, `packages/core/src/daemon.ts`): `SessionManager` gained a farm-wide build lane (a plain queueing counting semaphore, `createBuildLane`, `manager.ts`) around `createEntry`, sized by `session.maxConcurrentBuilds` (wired live in `daemon.ts`), acquired OUTSIDE the `inFlight`/`upgrading` per-device dedupe maps so a queued build never holds a device's dedupe slot hostage — proven by a five-test describe block that starts N builds against a cap of K and asserts both peak observed concurrency and that all N complete, that a throwing build still releases its permit, and that two callers for the SAME device share one queued build rather than each taking a permit. `SessionManager.videoStats()` (optional, mirroring `activeDeviceIds?()`, so the dozens of unrelated `SessionManager` test fixtures across the workspace did not all need a stub in this commit) reports live streams by quality, the lane's own `buildsRunning`/`buildQueueDepth`, and each open entry's resolved profile. `AdbStatsResponseSchema.video` (also `.optional()`, mirroring `input`, for the same pre-existing `AdbServerCard.test.tsx` fixture reason) is wired into `/api/adb/stats`, zero-filled the same way `transport`/`hostAdb`/`adbHealth`/`input` are. 92.6 also implemented and tested (`packages/studio/src/components/wall/TileSkeleton.tsx` (new), `packages/studio/src/components/wall/TileSkeleton.test.tsx` (new), `packages/studio/src/components/LiveView.tsx`, `packages/studio/src/components/LiveView.test.tsx`, `packages/studio/src/components/wall/WallTile.tsx`, `packages/studio/src/components/wall/WallTile.test.tsx`, `packages/studio/src/components/wall/Wall.tsx`, `packages/studio/src/components/wall/Wall.test.tsx`): every one of §4.7's nine states now renders explained content, proven by a component test per state rather than only by design. `TileSkeleton` (a tile-shaped grid through the SAME `TileGrid`, not `LoadingRows`' full-width bars) covers both loading rows; `Wall` now holds it until the live-tile budget is known, reading `/api/adb/stats`'s `video.maxTiles` — 92.3's ACTUALLY-APPLIED number, landed after this step started, so `Wall` never has to duplicate `computeAutoTiles` client-side — in place of the raw `wall.maxTiles` `/api/settings` used to expose (which is `0`/auto by default since 92.1 and was never usable directly). `WallTile` gained a screen state checked AHEAD of `live`: `asleep` now renders a screen-off placeholder ("Screen off", persistent Wake) and never mounts `LiveView`, closing F12 directly at the tile — `Wall`'s own live-set eligibility also now excludes asleep (belt-and-braces, so the status strip's "budgeted" count never double-books an asleep tile). The pre-existing "outside the live budget" placeholder is now quiet: hover/focus-revealed like a live tile's own action overlay rather than a persistent button, per §3.4's narrowing of plan 48 rule 3 — a farm of mostly-budgeted tiles no longer reads as a wall of alarms. `LiveView` gained a `compact` branch of the wake-up phase panel (spinner, one word from a new `PHASE_COMPACT_LABEL` map, elapsed seconds after 10s, replacing the four-step breadcrumb only in `compact` mode) and of the stopped overlay (same translated reason and retry action, tile-sized), leaving the full breadcrumb and "Stream stopped" headline on the device page unchanged. `Wall`'s status strip reports the blocked/budgeted breakdown (asleep/offline/quarantined/outside-the-live-budget counts) in a native `title` attribute revealed on hover, computed from the same asleep-excluding eligibility list, so "12 of 100 live" always has an honest answer for the other 88. **Not done in this step, left to 92.8/92.9 as designed:** the Mbit/s/fps/resolution portion of §4.7's status-strip mockup (needs client-side aggregation across every live tile's own `stream.started`, not assigned here). **Pending — owner to run:** a real 100-device cold-load screenshot pass; exact steps and an outcome table are in step 92.6's own entry below. 92.4 also implemented and tested (`packages/studio/src/components/wall/useLiveSet.ts` (new), `packages/studio/src/components/wall/useLiveSet.test.ts` (new), `packages/studio/src/components/wall/Wall.tsx`, `packages/studio/src/components/wall/Wall.test.tsx`, `packages/studio/src/components/wall/WallTile.tsx`): the live-set policy of §4.6 — `computeLiveSet` (pure: eligibility/blocked classification, pinned → visible-hot → visible-already-live → visible-new → off-screen ranking, the hard `maxTiles` cap, the `rampConcurrency` ramp gate) plus `useLiveSet` (the hook owning the `IntersectionObserver`, the 400ms dwell timers, and the ramp counter), replacing the hand-rolled eligibility/backfill state 92.3/92.6 had already corrected once. `Wall.tsx` keeps 92.3/92.6's `/api/adb/stats`-sourced, server-resolved `maxTiles` untouched (this step's own checklist text about holding on `/api/settings` and calling `computeAutoTiles` client-side was stale before this step started, per the brief's own warning — that arithmetic is 92.3's, server-side, and Studio has no business duplicating it) and additionally fetches `wall.rampConcurrency` from `/api/settings` non-blockingly (a client-side courtesy only, defaulted to the schema's own `2`). `WallTile` gained one additive `rootRef` prop forwarded onto its existing root `next/link` for the observer to attach to — its `asleep`-before-`live` guard (92.6) was verified, not duplicated. Two corrections this step made to plan 92 §4.6's own sketch, both caught by this step's own tests before shipping, not by inspection: `LiveSetInput` needed a `liveIds` field (the previous call's own `live` output, read back in) that §4.6's interface omitted — without it neither stability (an already-live tile surviving a same-rank newcomer) nor the ramp gate (which only gates ids NOT already live) has anything to compare against; and a rank-4 (never visible, never pinned, never live) device is now excluded from the live/pending candidate pool outright rather than merely ranked last, closing a bug where a cap bigger than the number of real candidates would silently fill itself with devices nobody had ever scrolled to. All three of the step's own headline verifiable-result clauses (zero streams on asleep devices, zero streams from a fast scroll, hot-first with at most `rampConcurrency` outstanding on a row) are proven directly in `useLiveSet.test.ts` (15 tests: 9 against the pure `computeLiveSet` with hand-built inputs, 6 against the hook with a fake `IntersectionObserver` since happy-dom's own is a non-firing stub) — full reasoning and the real-farm outcome table (`adb shell dumpsys power`, `/api/adb/stats` polling during a fast scroll and a stop-on-a-row) are in step 92.4's own entry below, **pending — owner to run**. 92.7 also implemented and tested (`packages/studio/src/components/wall/tile-identity.ts` (new), `packages/studio/src/components/wall/tile-identity.test.ts` (new), `packages/studio/src/components/wall/WallTile.tsx`, `packages/studio/src/components/wall/WallTile.test.tsx`, `packages/studio/src/components/TileChips.tsx`, `packages/studio/src/components/TileChips.test.tsx`, `packages/studio/src/components/DeviceCard.tsx`, `packages/studio/src/components/DeviceCard.test.tsx`, `packages/studio/src/app/page.tsx`, `packages/studio/src/app/page.test.tsx`): `tileIdentityOf` (`tile-identity.ts`) is the one adapter behind §4.8's `{ number, connection }` — `connection` is read straight off `DeviceInfo.connection` (plan 88 landed; falls back to the schema's own `usb`/`unknown` default for a hand-built fixture with no `connection` key, the convention every other component test in this workspace already uses, rather than throwing on `connectionBadge(undefined)`), `number` reads a field named `number` that does not exist on `DeviceInfoSchema` at all (plan 89 not started) and so is always `null` today — dash-tolerant by construction, not by a null check added later. `WallTile`'s line 1 is now number (`.readout`, fixed `w-6`, right-aligned, dash today) · label · a connection glyph (one `lucide` icon keyed off the SAME `connectionBadge()` classification `ConnectionBadge` uses, `title`/`sr-only` carrying `connectionTooltip()` — no text badge, per §4.8's own reasoning about the cost on a narrow tile); the holder/assist badges moved OFF the header and onto the picture (a `bg-black/60`-scrimmed absolute overlay, placed AFTER the picture content in DOM order so it paints above `LiveView` without a `z-index`), closing F31 — proven in `WallTile.test.tsx` by asserting the header block's own child count is IDENTICAL with vs without a holder (happy-dom has no real layout engine, so `getBoundingClientRect` cannot prove a pixel height; the header's fixed DOM structure is the mechanism that guarantees it, and that mechanism is what is asserted directly) and that the badge renders inside the picture container instead. The tile's root `Link` gained `@container` (verified to actually emit `container-type:inline-size` in the compiled CSS — `docs/design.md`'s own warning that a v3 bracket form fails silently applied here too, so it was checked against real Tailwind v4 PostCSS output before being trusted, and again in the `bun run --cwd packages/studio build` output CSS: `@container not (min-width:200px){.\@max-\[200px\]\:hidden{...}}` and the 160px sibling both present). `TileChips` gained the container-query drop order — temperature at `@max-[200px]:hidden`, battery at the narrower `@max-[160px]:hidden`, so at a 140px (S) tile both drop, at 180px (M) only temperature drops, at 260px (L) neither drops — with plan 48 §3.2's fixed order and dash-for-missing completely untouched (the classes only ever hide an already-correctly-ordered chip; `DeviceTile`, which sets no `@container` ancestor, is unaffected, proven by the existing 48.4 tests still passing unmodified). `page.tsx`'s search predicate gained `d.connection.address` (`null` never matches, same as every other optional field there); the **Connection** filter beside the readiness filter turned out to be already shipped by plan 88 §4.9 (`CONNECTION_FILTER_LABEL`, `Filter by connection` — confirmed present and unchanged, not re-added). `DeviceCard.tsx` gained the same dash-tolerant number next to its label, through the identical `tileIdentityOf` adapter, so list and wall report the same number the day plan 89 lands — this is a narrower reading of plan 48 §9 Q1 than reusing `TileChips` wholesale in `DeviceCard` (deliberately not done: `DeviceCard`'s battery row also shows a "charging" qualifier `TileChips` has no room for, and losing it was judged a worse trade than the consistency gained; §9 Q1 is left explicitly open below for that larger question, not silently closed). Tile height was not hand-measured against real pixels for the reason above (no layout engine in the test environment); §6.8's convention is instead satisfied by the structural proof described above, which is the thing that actually makes the height identical. 92.2 also implemented and tested (`packages/session/src/session.ts`, `packages/session/src/session.test.ts`, `packages/session/src/manager.ts`, `packages/session/src/manager.test.ts`, `packages/core/src/daemon.ts`, `packages/core/src/daemon-wiring.test.ts`, `packages/core/src/api/devices.ts`, `packages/core/src/api/devices-video-reprofile.test.ts` (new), `packages/core/src/api/video.ts` (new), `packages/core/src/api/video.test.ts` (new), `packages/protocol/src/api/video.ts` (new), `packages/protocol/src/api/video.test.ts` (new), `packages/protocol/src/api/index.ts`, `packages/core/src/server/http.ts`, `packages/core/src/server/http.test.ts`, `packages/studio/src/components/LiveView.tsx`, `packages/studio/src/components/LiveView.test.tsx`, `docs/spec.md` §10.1): `DeviceSession.videoProfile` (`session.ts`) records the resolved numbers a session actually started its encoder with — typed **optional**, not required as §4.3's own snippet showed, because a dozen `DeviceSession` fixtures across `packages/core/src/server/*.test.ts` and `mirror/group.test.ts` (none of them about video, none owned by this step) build one by hand with no cast, the same fixture-compatibility reason `SessionManager.videoStats`/`activeDeviceIds` are already optional — this plan's own §4.3 interface sketch is corrected by this step's tests, not by inspection. `manager.ts`'s `upgradeToControl` is now a two-line guard (`existing.session.quality !== 'wall'` → return) around the new `restartAt(deviceId, quality, detail?)`, which is the FORMER BODY of `upgradeToControl`, generalised: the `upgrading` coalescing map and the old→fresh `frameSubscribers`/`refcount` carry-over are byte-identical to before this step, just reachable for any target quality rather than only `wall → control`. `reprofile(reason)` implements all five §3.8 rules: it compares `Entry.videoProfile` (not the newly-optional `DeviceSession.videoProfile` — the two are the SAME object whenever a resolver is wired, and `Entry`'s copy needs no null-guard at the call site) against a freshly resolved profile via `sameVideoNumbers` (rule 1); debouncing is deliberately NOT this function's job (rule 2, see `daemon.ts` below); every restart is dispatched (not awaited one at a time) through `restartAt` → the SAME build lane `createEntry` already queues behind (rule 3); a device whose `DeviceSnapshotSource` row reports `status: 'busy'` is collected into `skippedBusy` and never touched (rule 4 — the blast-radius bound, proven by a dedicated test asserting the busy device's session is the EXACT SAME object before and after); and `detail: 'applying new video settings'` threads through `createEntry`'s `onPhase` wrapper as the fallback for any phase that does not supply its own (rule 5). Both `restartAt` and `reprofile` are optional on `SessionManager` for the identical fixture-compatibility reason as `videoProfile` above — `readiness.test.ts`'s `fakeSessionManager()` is one of the dozens of pre-existing fixtures that would otherwise need a stub in this commit. `daemon.ts` gained a `reprofileDebounceTimer` beside `heartbeatInterval`, cleared in `stop()` the same way; **the debounce window is 500ms**, chosen because `settingsStore.onChange` fires on every farm settings PATCH (not only a video one) and can fire several times as an operator edits a form field by field, and restarting a farm's video on every keystroke would be worse than not honouring the setting at all (§3.8's own words) — 500ms is short enough that "I changed a setting and it took effect" still reads as immediate, long enough that a multi-field save coalesces into one pass; `reprofile` itself is idempotent per pass (rule 1 means a no-op restart costs nothing), so debouncing only changes how OFTEN the farm re-checks, never what it does once it checks. `POST /api/video/reprofile` (new `packages/protocol/src/api/video.ts` — `VideoReprofileResponseSchema`, appended to `packages/protocol/src/api/index.ts`'s barrel, never touching the contested top-level `packages/protocol/src/index.ts`; new `packages/core/src/api/video.ts`, mounted in `server/http.ts` beside `/api/adb/stats`) is the manual "apply now" — `settings.manage`, calls the identical `SessionManager.reprofile()` the debounced path calls, refuses `E_NOT_SUPPORTED` (501) when no session manager is wired. `PATCH /api/devices/:id` (`api/devices.ts`) restarts the ONE device it just patched — at its own current quality, never forcing a quality change — when `changedKeys` includes `video` and the device is not `busy`; `connection.sessions`'s `Pick<SessionManager, ...>` widened from `'closeDevice'` to also include `'restartAt' | 'get'`, which required a matching fixture update in `devices.test.ts`'s `fakeSessions()` (a file this step does not own but could not avoid touching mechanically — `get` is non-optional on `SessionManager`) and its own local `makeApp` connection-type — both additive, no existing assertion changed. `LiveView.tsx` (F17) now keeps `session.progress.detail` in a `phaseDetail` state slot, reset on every fresh mount/retry alongside `phase`, and renders it as its own line directly under the phase headline in BOTH the compact (Wall tile, one word plus detail) and full (device page, sentence headline plus detail) wake-up panels — additive to 92.6's own one-word compact convention, not a replacement for it. **Verifiable result — CONFIRMED at the unit level**: `manager.test.ts`'s new describe block proves a changed wall bitrate restarts only the session whose resolved profile actually moved (a second, unchanged device is left alone and its `makeScrcpy` build count does not increment), a `busy` device is reported in `skippedBusy` and its session object is never replaced, a restart carries a TWO-subscriber refcount across (proven by releasing one of two original viewers and asserting the session stays open, then releasing the second and watching `idleTtlSec: 0` close it — a broken carry-over would have closed it on the FIRST release), and every phase of a reprofile-triggered restart carries `detail: 'applying new video settings'` through `onPhase`. `devices-video-reprofile.test.ts` proves the same at the HTTP layer for a per-device PATCH. **A real two-device browser check (one wall tile, one device page, `PATCH /api/settings` with `video.wallBitRate` changed, watching the wall tile's picture recover without the browser tab re-subscribing) is pending — owner to run**, exact steps below. **Hardware smoke test — pending, owner to run** (no scrcpy-against-real-device run was performed by this step, per this repo's standing rule that no agent runs real hardware): 92.8 also implemented and tested (`packages/studio/src/components/video/video-quality.ts` (new), `video-quality.test.ts` (new), `VideoQualityReadout.tsx` (new), `useAdbVideoStatsPoll.ts` (new), `useAdbVideoStatsPoll.test.ts` (new), `FarmVideoFields.tsx` (new), `FarmVideoFields.test.tsx` (new), `DeviceVideoFields.tsx` (new), `DeviceVideoFields.test.tsx` (new), `packages/studio/src/app/settings/page.tsx`, `packages/studio/src/app/settings/page.test.tsx`, `packages/studio/src/app/device/page.tsx`, `packages/studio/src/app/device/page.test.tsx`): the farm Settings page's already-registered `video` section (`farmSections.ts`, landed by 92.1 — untouched by this step, per this step's own file-ownership boundary) now renders through a NEW `FarmForm` `render` prop (`settings/page.tsx`) that keeps every load/save/dirty/`beforeunload` mechanic exactly as every other section's, while `FarmVideoFields` lays out the fields around it: the two preset dropdowns always visible, the six number fields behind a native-Radix `Collapsible` "Advanced" disclosure (pre-opened automatically the moment ANY of the six differs from what the selected preset implies, so an operator who already customized something sees it without a click), a "Reset to preset" action, `VideoQualityReadout` (both profiles, resolved numbers, and — critically — the resolver's own per-field `source`, RENDERED not recomputed, per this step's own brief item 1), the §3.7 projection line (a PINNED `wall.maxTiles` wins over the auto-derived tile count, matching the "a non-zero setting always wins" convention, F24), the §3.9 measured block (`useAdbVideoStatsPoll`, polling `/api/adb/stats` every 2s while — and only while — the section is mounted AND `document.hidden` is false, mirroring `useNow.ts`'s established start/stop shape rather than inventing a second one), and an "Apply to live sessions" button calling `POST /api/video/reprofile` whose toast NAMES the skipped devices by label (`buildReprofileToast`, resolving `skippedBusy`'s bare ids through the pre-existing `fetchDeviceRefs`, `lib/api.ts` — the response schema carries ids only, never labels, so this step's own brief item 2 — "never say applied without saying except these" — is met client-side). The device page's Settings tab gained the identical treatment (`DeviceVideoFields`) for `DeviceSettings.video`'s eight OPTIONAL fields, with the two farm/device differences the schema's own doc comments already state made explicit in code: "Reset to preset" CLEARS the six fields outright (sets them to `undefined`, dropped by `JSON.stringify`, F21) rather than writing preset numbers over them (only meaningful because device fields are genuinely optional, unlike the farm's own F22-constrained block), and the readout collapses the resolver's 'preset'/'farm' distinction into one "the farm" answer for any field this device does not override (`deviceSourceLabel`) — the farm's OWN video settings are read off the SAME `/api/settings` fetch the page's `shellMode`/`coControlMode` state already use, not a second request. **One real deviation from the sibling steps' precedent, reported per this brief's own instruction to report contradictions**: `CONTROL_PRESETS`/`WALL_PRESETS`/`resolveVideoProfile`/`computeAutoTiles` are DUPLICATED into a new `packages/studio/src/components/video/video-quality.ts` rather than imported from `packages/session/src/video-profile.ts` — `@enkaku/session`'s own barrel (`packages/session/src/index.ts`) re-exports the job runner and container/child-process isolation providers, real Node dependencies that must never reach Studio's static-export bundle, and that package has no subpath export isolating just the (dependency-free) `video-profile.ts` module; adding one was considered and rejected as outside this step's own Studio-only file-ownership boundary. The duplication is guarded, not silent: `video-quality.test.ts` re-derives `CONTROL_PRESETS.sharp`/`WALL_PRESETS.balanced` from `FarmSettingsSchema`'s own baked JSON-Schema defaults and every OTHER preset row from that same schema's `.describe()` prose (the only two places these numbers are expressed anywhere Studio can read them live) — a future edit to either the real preset tables or the schema prose that is not mirrored here fails loudly. **A real gap, not closed by this step**: the plan's own §5 "Verifiable result" for 92.8 has a second clause — "after saving, the WALL's own strip reports the new resolution and a video rate that converges on the projection" — which is `Wall.tsx`'s own status-strip enhancement that 92.6 explicitly deferred to "92.8/92.9" and this step did NOT pick up, because `packages/studio/src/components/wall/**` sits outside this step's own file-ownership boundary (a sibling worker's files, per the brief that scoped this step) and the fps/resolution aggregation Wall.tsx would need is a genuinely different client-side computation from anything built here. Left open, recorded in step 92.8's own checklist entry below rather than claimed done. `bash scripts/typecheck.sh` reproduces the SAME single pre-existing failure (`packages/core/src/api/jobs.ts(213,49)`), untouched by this step; `bun test` (root) 4316/0, `bun run --cwd packages/studio test` 925/0 (886 baseline + 39 new), `bun run --cwd packages/studio build` succeeds with `/settings` and `/device` both in the static export, `bun run spec:check` GAP 0.
  ```bash
  # With two devices enrolled, one open on the Wall (?view=wall) and one open
  # on its own device page (Control), both already streaming:
  curl -s localhost:7700/api/devices | jq -r '.[].id'   # note both device ids

  # Change the wall bitrate only.
  curl -s -X PATCH localhost:7700/api/settings \
    -H 'content-type: application/json' \
    -d '{"video":{"wallBitRate":300000}}'
  ```
  | Step | Expected | Observed |
  |---|---|---|
  | Within ~500ms–1s of the PATCH above | The WALL tile shows "Starting video" (compact) plus "applying new video settings" underneath; the DEVICE PAGE tile is untouched | *(owner to fill in)* |
  | The wall tile's browser tab / WS connection | Never disconnects or re-issues `stream.start` — the existing `<video>`/canvas element just goes dark and comes back, per the refcount carry-over | *(owner to fill in)* |
  | The wall tile once the restart finishes | Picture returns, visibly lower bitrate (300 kbit/s) | *(owner to fill in)* |
  | The device-page tile throughout | Unaffected the whole time — its own profile did not change | *(owner to fill in)* |
  | With a job running on a third device, same PATCH | That device's tile is UNCHANGED — no restart, no flicker — and a manual `curl -X POST localhost:7700/api/video/reprofile` (admin token) reports it in `skippedBusy` | *(owner to fill in)* |
  `bash scripts/typecheck.sh` reproduces the SAME single pre-existing failure named at the top of this document (`packages/core/src/api/jobs.ts(213,49)`, a second Claude session's duplicate schema, arbitration pending) — not introduced or touched by this step. `memory-limit.integration.test.ts`'s `enforce: "kill"` flake (heavy parallel load only) was not observed in this step's own runs.

Step 92.8 also implemented and tested 2026-08-13 (see its own entry in §5
below for the full account). **Step 92.9 (documentation and spec) also
implemented and tested 2026-08-13**: `packages/session/README.md`,
`packages/studio/README.md`, `docs/guide/install.md`, and `docs/spec.md`
§19 all gained the sections this step's own brief specified (see step
92.9's own entry in §5 below for the exact scope of each); the one piece of
code left to this step — the Wall status strip's Mbit/s figure, which 92.6
deferred and 92.8 could not reach — is now wired in `Wall.tsx`, with the
fps/average and real-resolution portion explicitly left open as a
follow-up (reasoning in 92.9's own entry, not invented here). `bun run
spec:check` reconfirmed at GAP 0 after the `docs/spec.md` edit.
> Depends on: Plan 42 (the Wall, quality profiles, idle sessions), Plan 43 (readiness, `maxHot`), Plan 47 (the merged fleet view, View/Group in the query string), Plan 48 (tile density and the hover overlay), Plan 85 (the adb autoscalers, `/api/adb/stats`'s `transport` block, the bounded host-adb helper). None of them needs to change first; this plan amends Plan 42's live-set eligibility and Plan 48's rule-3 scope, and says so in §3.4 and §3.9.
> Receives from (not built here): Plan 88 — `DeviceInfo.connection` (USB/Wi-Fi plus the address); Plan 89 — a short per-device number. §4.8 states the exact contract this plan consumes; §0.2 H4 records that neither plan is written yet.
> Spec references: §7.5 (device identity, the fleet list), §9 (display and input engines), §10.1 (video keeps running while a device is busy), §12 (per-device settings), §16 (NFR targets), §19 (Studio screen spec and its rendering principle)
> Ships: packages/session/src/video-profile.ts

---

## 0. Evidence

Written from the code. Every claim about current behaviour is **CONFIRMED** with a
`file:line`, or marked **HYPOTHESIS** with the observation that would settle it.
No step in §5 acts on a hypothesis without first adding the measurement.

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | The fleet page opens on **List**. `view` is read from the query string and falls back to `'list'`; `Wall` renders only for `?view=wall`. | `packages/studio/src/app/page.tsx:73-76`, `:606-607` |
| **F2** | The view choice is **not remembered** anywhere. `pushParams` writes it to the query string with `router.replace`; there is no client-side persistence and no farm setting. A repo-wide search for `localStorage` across `packages/studio/src` returns **zero** matches. | `packages/studio/src/app/page.tsx:232-250`; repo-wide search |
| **F3** | The live-tile budget is `wall.maxTiles`, a fixed integer defaulting to **8**, min 1, max 64. It is the only video-adjacent farm setting that exists, and it governs concurrency, not picture. | `packages/protocol/src/settings.ts:954-969` |
| **F4** | Quality is a **two-value enum with no numbers attached**: `QualitySchema = z.enum(['control','wall'])`. | `packages/protocol/src/messages/stream.ts:12-13` |
| **F5** | The numbers are **compile-time constants**: `control: {maxSize:1600, maxFps:30, bitRate:4_000_000}`, `wall: {maxSize:480, maxFps:5, bitRate:800_000}`. Nothing reads them from settings; nothing can change them at runtime. | `packages/session/src/session.ts:29-32` |
| **F6** | Those constants reach scrcpy directly as `max_size` / `max_fps` / `video_bit_rate`, resolved once when the child is spawned. | `packages/core/src/daemon.ts:1934-1961`, specifically `:1945-1957` |
| **F7** | There is **no Studio control surface at all** for picture quality. A repo-wide grep for `bitRate` / `maxSize` / `maxFps` / `QUALITY_PROFILES` across `packages/studio/src` returns zero matches. | repo-wide search |
| **F8** | Changing quality already restarts a session and **carries its subscribers**: `upgradeToControl` closes the `wall` entry, builds a `control` one, and copies `frameSubscribers` and `refcount` onto the fresh entry. It is coalesced per device by an `upgrading` map. Its scope is exactly one transition — `wall → control` — and nothing else ever restarts a healthy session. | `packages/session/src/manager.ts:209-244`, specifically `:236-238` |
| **F9** | Session builds are deduped **per device** (`inFlight`) and **not bounded farm-wide**. Eight `stream.start` messages for eight different devices produce eight concurrent `createEntry` calls. | `packages/session/src/manager.ts:202`, `:262-267` |
| **F10** | Every `stream.start` takes a readiness **viewer hold** before acquiring the session, and the hold's first acquisition runs `ensureAwake` on the device. | `packages/core/src/server/ws-handlers.ts:654-657`; `packages/core/src/device/readiness.ts:360-363` |
| **F11** | `createSession` calls `wakeDevice` **unconditionally**, before video starts. So opening a stream on a device always wakes its screen, whatever the readiness layer decided. | `packages/session/src/session.ts:214-229` |
| **F12** | The Wall's live set excludes only `offline` and `quarantined`. An **asleep** device is eligible, gets a `LiveView`, and is therefore woken by F10+F11 merely because someone looked at the wall. | `packages/studio/src/components/wall/Wall.tsx:54-57`; `packages/studio/src/components/wall/WallTile.tsx:93-94` |
| **F13** | The live set is backfilled in **fleet-list order**, and "Show live" evicts with `next.shift()` — the front of the array, i.e. the least-recently-*promoted* tile, not the least-recently-*seen* one. Nothing consults the viewport, and nothing consults readiness. | `packages/studio/src/components/wall/Wall.tsx:63-87` |
| **F14** | `wall.maxTiles` is fetched **after first paint** from `/api/settings`, with a hardcoded fallback of 8 until the response lands. On a farm configured for 24 tiles, the first render starts 8 streams and then starts 16 more a moment later. | `packages/studio/src/components/wall/Wall.tsx:12`, `:42`, `:48-52` |
| **F15** | The grid is a fixed `minmax(180px, 1fr)`. There is no tile-size control. | `packages/studio/src/components/wall/TileGrid.tsx:23`; `packages/studio/src/components/wall/Wall.tsx:119` |
| **F16** | `LiveView`'s wake-up progress panel renders the same four-step breadcrumb in `compact` (tile) mode as on the full device page. At a 180 px tile that is a wall of text in a 100 px column. | `packages/studio/src/components/LiveView.tsx:581-599` (no `compact` guard, unlike `:465`, `:527`, `:540`, `:566`, `:604`) |
| **F17** | `SessionProgressMessage` carries an optional `detail`, and `LiveView` **ignores it** — it reads `payload.phase` only. So a session restart can never explain itself. | `packages/protocol/src/messages/stream.ts:86-95`; `packages/studio/src/components/LiveView.tsx:189-191` |
| **F18** | `FarmSettings.defaults` (a whole `DeviceSettings`) is applied **only at admission**, copied into the new row's `settings` blob. It is not a live fallback: the session builder parses `row.settings` and falls back to `defaultDeviceSettings()` — the *schema* defaults, never the farm's. **A farm-wide value expressed as a `DeviceSettings` field therefore reaches existing devices never.** | `packages/core/src/registry/admission.ts:61`; `packages/core/src/registry/device-registry.ts:215`; `packages/core/src/session/adapters.ts:19-22` |
| **F19** | Studio hardcodes no config forms: the farm settings page renders `z.toJSONSchema(FarmSettingsSchema)` through `SchemaForm`, one section at a time, and PATCHes the **whole** settings object. A field added to a schema appears in the UI with no React change. | `packages/core/src/api/settings.ts:17-25`; `packages/studio/src/app/settings/page.tsx:216-236` |
| **F20** | `SchemaForm` has **no slider primitive**. A JSON-Schema `number` renders as a typed number input; an `enum` renders as a dropdown. | `packages/studio/src/components/schema-form/SchemaForm.tsx:188-205` |
| **F21** | `PATCH /api/devices/:id` **replaces** the device's settings blob wholesale (`patch.settings = parsed.data`), so an absent optional field genuinely means absent. | `packages/core/src/api/devices.ts:505-539`, specifically `:534` |
| **F22** | `PATCH /api/settings` merges **one level deep** and `setAtPath` stores `undefined` as a value, which `JSON.stringify` then drops. Clearing an optional *farm* field therefore silently does nothing — today that already affects `network.geoProvider`, the one optional farm field. This plan puts no optional field in `FarmSettings` because of it (§3.6), and records the defect in §2. | `packages/core/src/settings/farm-settings.ts:47-55`; `packages/studio/src/components/schema-form/resolve.ts:74-87`; `packages/protocol/src/settings.ts:1050-1057` |
| **F23** | `settingsStore.onChange` exists and is already used to re-derive a runtime budget when settings change (`recomputeAdbConcurrency`). It is the established hook for "a saved setting takes effect now". | `packages/core/src/settings/farm-settings.ts:66-69`; `packages/core/src/daemon.ts:380` |
| **F24** | `0 = auto` is an established settings convention with two live examples, both clamped pure functions applied through the same "a non-zero setting always wins" rule. | `packages/core/src/device/adb-scaling.ts:15-16`, `:29-30`; `packages/core/src/daemon.ts:347`, `:367` |
| **F25** | `/api/adb/stats` already reports a `transport` block — `connections`, `bufferedBytesMax`, `bufferedBytesP95`, `videoBytesPerSec`, `controlReplyMsP50/P95`, `watchdogReconnects` — plus `streams` occupancy and `idleSessions`. Video bytes are recorded at the point every frame is sent. | `packages/core/src/api/adb-stats.ts:22-30`, `:56-77`; `packages/core/src/server/ws-handlers.ts:622-624` |
| **F26** | The readiness manager acquires a `wall`-quality session for every device whose **desired** readiness is `hot`, bounded by `readiness.maxHot`. So `wall` profile numbers govern more than the Wall. | `packages/core/src/device/readiness.ts:272-283` |
| **F27** | `readiness.maxHot`'s doc comment states it "deliberately matches `wall.maxTiles` and `session.maxIdleSessions` (both default 8), so one page of the Wall is exactly the set of devices that can be hot". | `packages/protocol/src/settings.ts:970-994` |
| **F28** | A device owned by a remote node **ignores the requested quality entirely** — the tunnel protocol carries no profile — and `stream.started` reports the profile honestly rather than claiming an upgrade. | `packages/core/src/server/ws-handlers.ts:636-645` |
| **F29** | A device on the `screencap-loop` fallback produces PNGs and consumes none of the three numbers; `LiveView` already distinguishes the two codecs in its readout. | `packages/session/src/session.ts:420-425`; `packages/studio/src/components/LiveView.tsx:509-520` |
| **F30** | `enforceIdleCap` closes over-cap idle sessions **immediately**, not on a timer, least-recently-idle first. `session.maxIdleSessions` defaults to 8. | `packages/session/src/manager.ts:89-106`; `packages/protocol/src/settings.ts:935-942` |
| **F31** | A tile shows `label` plus the chip row plus, when present, a `HolderBadge` on a **third line** — so a tile's height changes the moment someone takes control of that device. | `packages/studio/src/components/wall/WallTile.tsx:81-90` |
| **F32** | `DeviceInfo` — the payload the fleet list and the Wall render from — carries **no transport, no address, and no short number**. `serial` is the only connection-ish string, and the list card prints it raw. | `packages/protocol/src/device.ts:34-86`; `packages/studio/src/components/DeviceCard.tsx:102` |
| **F33** | The fleet page's free-text search covers `label` and `serial` only; the filter row offers status, cluster, readiness, tags, and grouping — no connection dimension. | `packages/studio/src/app/page.tsx:214`, `:456-498` |
| **F34** | Spec §19 states the rendering principle outright: *"every config panel is rendered from a schema through the schema-driven form renderer — no hardcoded UI per component."* `docs/design.md:53-59` says the same and adds that labels and descriptions live in the Zod schema, not in React. | `docs/spec.md` §19 (final line); `docs/design.md:53-59` |
| **F35** | `docs/design.md:49` makes the three data states mandatory: *"Every screen that fetches data must handle all three — an empty screen with no explanation is a defect, not a neutral state."* | `docs/design.md:49` |

### 0.2 Hypotheses (instrument before acting)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | Wall-first on a 100-device farm is dominated by **session build cost**, not by decode or bandwidth: 8 concurrent `createEntry` calls each push a jar, spawn a child, and connect two sockets (F9), while decode of 8 tiles at 480 px / 5 fps is nearly free. | Plan 85 §0.2 H5 already traced a five-device stampede to concurrent session builds saturating one USB controller, and this plan makes that path the default page. | 92.3 adds the build lane plus a `video.buildsRunning` / `buildQueueDepth` gauge to `/api/adb/stats`; §7.3's ladder reads time-to-first-tile with the lane at 1, 2, and 4. |
| **H2** | Ordering the live set **hot-first** removes most of the cost rather than merely spreading it: a `hot` device's session is already open, so its tile's `acquire` returns an existing entry and paints on the primed keyframe path. | `manager.ts:250-260` returns the existing entry synchronously, and `ws-handlers.ts:697-710` primes the decoder from the cached config plus keyframe. | 92.4's ordering is measured in §7.3: time-to-first-picture for a farm with `readiness.defaultDesired: 'hot'` versus `'asleep'`, at the same device count. |
| **H3** | A quality change large enough to be worth making (e.g. wall `balanced → detailed`) is **visible within one restart**, so no separate "preview" mechanism is needed. | The restart carries subscribers (F8) and re-primes the decoder, so the tile goes soft for ~1 s and comes back sharper. | 92.8's effective-profile readout reports the size the stream actually came up at (`stream.started.width/height`), so a change that did nothing is visible as a number that did not move. |
| **H4** | Plans 88 and 89 will deliver `connection` and a short device number **on `DeviceInfo`**, i.e. on the same payload the Wall already renders. | It is the only payload the fleet list and the Wall share (F32), and both plans are described as list/tile-facing. | 92.7 consumes them behind one adapter (§4.8) and renders a dash when they are absent, so this plan builds and ships whether or not 88/89 have landed. |

### 0.3 What today's behaviour costs, in one paragraph

Open Studio on a 100-device farm and set `?view=wall`. The page paints, fetches
settings, and starts **8 streams chosen by list order** (F13, F14). Each one
takes a readiness hold that wakes the phone (F10, F11), whether or not it was
meant to be asleep (F12). Eight session builds run at once with no farm-wide
bound (F9). Every tile that is still building shows a four-step breadcrumb
crammed into a 100 px column (F16). The other 92 tiles show a Play button. When
the operator decides the picture is too soft, there is no setting to change
(F5, F7) — the numbers are in a TypeScript constant. That is the state this
plan is written against.

---

## 1. Goals

- **The fleet page opens on the Wall**, and opening it does not stampede: a
  100-device farm reaches a stable picture without a burst of concurrent
  session builds, without waking a phone nobody asked to wake, and without a
  blank rectangle at any point in the sequence.
- **The live set is chosen deliberately**, by a policy an operator can predict:
  what is on screen, what is already hot, what is awake. Not fleet-list order.
- **The picture has numbers, and they are settings.** `maxSize`, `maxFps`, and
  `bitRate` are farm settings for both profiles, overridable per device,
  rendered by the existing schema-driven form with no bespoke UI.
- **Changing them takes effect on live sessions**, restarting only the sessions
  whose resolved numbers actually changed, carrying their subscribers, saying
  why on screen, and never interrupting a job.
- **Raising quality lowers the live-tile count automatically**, so no
  combination of settings can be chosen that melts the browser. The budget is
  one number, and both knobs draw from it.
- **The effect is measurable in the UI**: the wall reports what it is actually
  spending, and the settings screen reports what the current draft would cost.
- **A tile holds identity, connection, condition, and actions** — including the
  fields plans 88 and 89 add — at 180 px and at 400 px, without a third line
  appearing when someone takes control.
- **The Wall is the unconditional landing view; nothing configures it away**
  (§9 Q1). **List is one click away and a choice made in this tab is
  remembered for this tab**, with a link still winning over the memory, and a
  brand-new tab or session landing on the Wall regardless of what was chosen
  before.

## 2. Non-goals

- **Not per-tile quality.** Quality is a property of the *profile*, resolved per
  device; a single wall never mixes tile sizes. A device that needs a different
  picture gets a per-device override, which applies wherever it is watched.
- **Not quality for remote-node devices.** The tunnel protocol carries no
  profile (F28) and this plan does not add one; a node-owned tile keeps
  reporting the quality it actually got. Cloud parity is plan 61's ground.
- **Not thumbnails for non-live tiles.** Plan 42 §9 Q1 deferred them because
  they need stored images and a retention policy; that is still true, and §9 Q6
  re-asks it with the wall-first evidence.
- **Not virtualising the tile grid.** Every filtered device stays in the DOM.
  §7.3 records the frame cost at 100 and 200 tiles; if it bites, it becomes its
  own plan (§9 Q7), not a patch here.
- **Not live input from a tile.** Tiles stay read-only (plan 42 §2, plan 48 §2).
- **Not the connection badge, the IP, or the device number themselves.** Plans
  88 and 89 own those fields; this plan owns the layout that has to hold them
  (§4.8).
- **Not fixing F22** (an optional *farm* setting cannot be cleared from Studio).
  It is real, it is recorded above, and it affects `network.geoProvider` today.
  This plan avoids it structurally by putting no optional field in
  `FarmSettings` (§3.6) rather than reworking the settings merge, which touches
  every section and deserves its own change.
- **Not a WebRTC or transport change.** Plan 85 §2 still holds; 85.7b remains
  the gated decision it was.

## 3. Context and design decisions

### 3.1 Making the Wall the default is a capacity decision, not a routing one

`view = 'list'` is one fallback string (F1). Changing it is a one-line edit and
would be a bad change on its own, because the Wall's live-set policy was
designed for a page an operator *chose* to open, with a laptop-sized budget of
8 tiles (plan 42 §3.5) and a "Show live" affordance for everything else. As the
front door on a 100-device farm, three of its assumptions stop holding:

1. **List order is not attention order** (F13). The first eight devices in the
   fleet list are an accident of enrolment, not what the operator is looking at.
2. **Looking is not consent to wake** (F10, F11, F12). Today the wall wakes up
   to eight phones as a side effect of being rendered. As a chosen view that is
   a defensible surprise; as the default it is a farm changing state because a
   browser tab opened.
3. **Eight is not a budget, it is a number** (F3). It was sized against the
   wall profile's 800 kbit/s. It has no relationship to the settings this plan
   is about to make adjustable.

So the routing change (92.5) is the smallest step in this plan, and it lands
**after** the policy (92.4) and the server-side bound (92.3).

### 3.2 The live-set policy: four rules, in order

Replacing F13's "first N of the filtered list" with:

1. **Eligibility by readiness, not only by status.** A tile streams only when
   the device is `awake` or `hot`. `asleep` joins `offline` and `quarantined`
   as a non-streaming state with its own placeholder and a persistent Wake
   action. *The wall shows the farm; it does not change the farm by being
   opened.* This is the rule that fixes F12, and it is an amendment to plan 42
   §4.6 — stated as one in §3.4.
2. **Membership follows the viewport.** An `IntersectionObserver` with a
   one-row `rootMargin` decides candidacy, and a tile must be continuously
   visible for `DWELL_MS` (400 ms) before it asks for a stream. Fast scrolling
   past forty tiles therefore starts zero streams, which is the whole point.
3. **Ordering within the candidates is hot → awake**, then the grid's own
   order. `readiness.actual === 'hot'` means a session is already open
   (F26), so those tiles cost one map lookup and a primed keyframe (H2).
4. **The cap is `wall.maxTiles`, and eviction is least-recently-*visible***, not
   least-recently-promoted (F13). A tile that has been off screen longest is
   the one that gives up its stream.

Everything above is client-side and advisory. §3.3 is what makes it safe.

### 3.3 The stampede is stopped on the server, because the client cannot be trusted to

Two browser tabs, or one tab and a script, defeat any client-side ramp. The
authoritative bound belongs where sessions are actually built (F9):

**Decision.** `SessionManager` gains a farm-wide build lane —
`session.maxConcurrentBuilds`, default 2 — around `createEntry`. It **queues**,
it does not refuse: a wall tile that waits 900 ms for its turn is correct; a
wall tile that errors because another tab was also loading is not. `inFlight`'s
per-device dedupe is unchanged and sits inside the lane.

Two is not a guess. It is the same reasoning plan 85 §3.4 used for
`adb.maxInstallConcurrent`: a session build pushes a jar and spawns a child over
a shared USB controller, and the observed failure at five devices was
concurrency, not count (plan 85 §0.2 H5). The setting exists so §7.3 can move it
to 1 and 4 and record what happens rather than argue about it.

The client ramp stays as well, for a different reason: without it, a tab with 24
eligible tiles enqueues 24 builds and the last one is served two dozen builds
later with no feedback. The client's job is to *ask in a sensible order*
(§3.2 rule 3, plus at most `wall.rampConcurrency` = 2 outstanding
`stream.start` requests); the server's job is to *never be asked too much at
once*. Two layers, two different failures.

### 3.4 What this changes in plan 42 and plan 48, said out loud

- **Plan 42 §4.6** ("Offline, quarantined, and unauthorised devices render as a
  static card with the reason") is **extended**: `asleep` joins that set. Plan
  42 could not have made this call — readiness did not exist until plan 43, and
  `WallTile` already computes `asleep` for a different purpose
  (`WallTile.tsx:61`, `:70`). The reason is F11: there is no way to stream a
  device without waking it, so "stream every eligible device" and "do not wake
  the farm" cannot both be true.
- **Plan 42 §3.5** ("at most `wall.maxTiles`, default 8") keeps its rule and
  loses its constant: `maxTiles` gains `0 = auto` (§3.7), following the
  convention F24 established.
- **Plan 48 §3.3 rule 3** ("a tile with no live picture shows its action
  persistently") is **narrowed**. Its stated reason is that the overlay is the
  content when there is no picture to protect — true when no-picture is the
  exception. Wall-first inverts that: on a 100-device farm most tiles are
  outside the live budget at any moment, and 90 persistently drawn buttons is
  the noise plan 48 was written to remove. So rule 3 now applies to
  **device conditions** (offline, quarantined, asleep) — where the action is
  genuinely the content — and **not** to a tile that is merely outside the
  live budget, which is a wall-policy state, not a fact about the phone.
  Budget-paged tiles keep the whole tile clickable (it already is,
  `WallTile.tsx:96-107`) and reveal their glyph on hover/focus like any live
  tile. Rules 1 and 2 (focus-within, coarse pointers) are untouched.
- **Plan 48 §3.2** (fixed chip order, dash for missing, so columns align) is
  **kept and extended** to the new fields, with a defined drop order (§4.8).
  It is safe to drop a chip at narrow widths because `auto-fill minmax` gives
  every tile in a grid the same width, so a container query drops it from every
  tile at once — columns still align.

### 3.5 Where the numbers live: a farm block, not a `DeviceSettings` field

The obvious move — put `video` in `DeviceSettingsSchema`, which
`FarmSettings.defaults` already reuses verbatim — is **wrong here**, and F18 is
why: farm defaults are copied into a device row at admission and never read
again. A farm-wide picture setting expressed that way would apply to devices
enrolled after the change and to nothing else. That is precisely the
"saved but never read" defect this repo has hit twice (`timing`, plan 34; the
dead-config guard comments at `packages/core/src/session/adapters.ts:43-50`).

**Decision.** Two places, one resolver:

- `FarmSettings.video` — a new top-level section, **fully populated, no optional
  fields** (F22), read live from `settingsStore` at session build.
- `DeviceSettings.video` — an all-optional override block. Absent field means
  "use the farm's". `PATCH /api/devices/:id` replaces the blob wholesale (F21),
  so absent genuinely means absent there.
- `resolveVideoProfile(farm, device, quality)` in
  `packages/session/src/video-profile.ts` — one pure function, the only place
  the two are combined, and the artefact this plan ships.

`QUALITY_PROFILES` (F5) stops being the source of the numbers and becomes the
**preset table** the resolver reads from, keeping one home for the constants.

### 3.6 Presets with an advanced reveal — decided on the codebase's own rules

The competitor exposes four sliders. This plan exposes **a preset dropdown per
profile plus three optional number fields per profile**, and the choice is not
aesthetic:

1. **Spec §19 forbids the alternative.** *"Every config panel is rendered from a
   schema through the schema-driven form renderer — no hardcoded UI per
   component"* (F34). Four bespoke sliders on the settings page is a hardcoded
   config panel. A preset enum and three numbers are a schema, and they render
   themselves.
2. **There is no slider primitive** (F20), and building one would be the wrong
   control anyway: `maxSize` is a value operators type (`480`, `720`, `1080`),
   not a value they drag toward.
3. **A preset is a sentence; a number is a measurement.** `docs/design.md:64`
   says to name things from the user's side. "Balanced" is the user's side.
   `bitRate: 800000` is the encoder's side, and it belongs behind the reveal —
   present, exact, typed, never the first thing asked.
4. **Presets alone cannot serve a farm.** Someone will need 640 px at 3 fps.
   Refusing them would make this a half-feature.

**No redundant state.** The stored shape is `preset` plus *optional* numbers;
there is no `'custom'` preset value to drift out of sync. The resolved profile
is `presetTable[preset]` with any present numbers written over it, computed by
one function. The UI shows the preset dropdown, an **Advanced** disclosure with
the three fields (empty = from the preset), and a readout of the resolved
values. "Reset to preset" clears the three fields.

The `wall` presets deliberately keep `balanced` equal to today's constants
(480 / 5 / 800 k) and `control`'s `sharp` equal to today's (1600 / 30 / 4 M), so
an existing farm sees **no behavioural change** until someone changes something.

### 3.7 Bounds: honest per profile, and a budget that couples the two knobs

The prompt's own worry — "4K at 60 fps on 20 devices will melt the farm" — has
three candidate answers. Two are bad:

- *Scale the schema bound with device count.* Impossible and undesirable: Zod
  bounds are static, the JSON Schema is generated once per request
  (`settings.ts:20`), and a form whose maximum moves while you type is hostile.
- *Silently clamp at runtime.* Forbidden. Config precedence in
  `docs/plans/00-overview.md` and the boot rule (`E_BAD_CONFIG`) both say a
  setting is honoured or refused, never quietly altered.

The third is the one that works: **make the tile count a function of the tile
cost.**

```ts
/** One browser tab's video budget, in bits per second. */
const WALL_VIDEO_BUDGET_BPS = 20_000_000

/** `wall.maxTiles: 0` (auto) — how many tiles fit the budget at the resolved wall bitrate. */
export function computeAutoTiles(wallBitRate: number): number {
  return Math.min(32, Math.max(4, Math.floor(WALL_VIDEO_BUDGET_BPS / wallBitRate)))
}
//  800 kbit/s (balanced) → 25    1.5 Mbit/s (detailed) → 13
//  400 kbit/s (light)    → 32    4 Mbit/s (someone typed control numbers into wall) → 5
```

Raising the wall's picture quality lowers the number of live tiles by exactly as
much, so total video into one tab stays inside one budget no matter which knob
is turned. It is one clamped pure function applied through the same
"a non-zero setting always wins" rule as `computeAutoConcurrency` and
`computeAutoStreams` (F24), so there is nothing new to learn.

Schema bounds are then per *purpose*, generous but not meaningless:

| | `maxSize` | `maxFps` | `bitRate` |
|---|---|---|---|
| `control` | 480 – 2560 | 5 – 60 | 500 k – 20 M |
| `wall` | 160 – 1080 | 1 – 30 | 100 k – 8 M |

A wall profile at 2560 px is not a wall profile, it is a control profile, and
the two-profile split is the thing that makes any of this tractable.

**And the projection is shown, always.** The settings section renders a live
line computed from the current draft — *"25 live tiles at these settings ≈
20.0 Mbit/s into one browser tab"* — beside the measured figure from
`/api/adb/stats` (§3.8). A number nobody can see is not a bound.

`readiness.maxHot` stays independent, and its doc comment (F27) is corrected:
it no longer "matches `wall.maxTiles`", because `maxTiles` is now derived. The
sentence is replaced with what is actually true — `maxHot` bounds devices held
hot **by policy**, while the wall's live set bounds devices held hot **by being
watched**.

`session.maxIdleSessions` is deliberately **not** raised to match. 25 idle
sessions at a 300 s TTL is 25 phones holding an encoder for five minutes after
an operator scrolled past them (F30 closes the excess immediately, which is the
behaviour we want). Scrolling back up pays a rebuild, ramped and hot-ordered.
That trade is stated here so nobody "fixes" it later by raising the number.

### 3.8 Changing quality must change the picture, or it is a lie

Nothing today re-reads a profile after a session starts (F5, F6). Making the
numbers settings without a re-profile path would ship the exact "saved but never
read" defect §3.5 exists to avoid.

**Decision.** Generalise F8 rather than add a second restart path.
`upgradeToControl` becomes a special case of `restartAt(deviceId, quality)`,
keeping its coalescing map and its subscriber carry-over verbatim. On top of it:

```
reprofile(reason): restart every open session whose RESOLVED profile
                   no longer matches the numbers it was started with
```

with five rules:

1. **Compare resolved numbers, not settings identity.** `DeviceSession` records
   the `VideoProfile` it was built with. A settings save that changes an
   unrelated field restarts nothing.
2. **Debounced and coalesced.** One pass 500 ms after the last change, driven
   from `settingsStore.onChange` (F23's precedent) and from the device PATCH
   route when `changedKeys` includes `video`.
3. **Through the build lane** (§3.3), so re-profiling 25 live sessions is a
   queue, not a burst.
4. **Never mid-job.** A device whose status is `busy` is skipped and keeps its
   picture until its current job ends; the API response says so by name.
   Video keeps running while a device is busy (spec §10.1) and a settings save
   must not be the thing that interrupts an automation.
5. **It explains itself.** The restart emits the plan-17 phases with
   `detail: 'applying new video settings'`, and `LiveView` finally renders
   `detail` (F17) — a one-line, generally useful fix that turns every existing
   phase detail into something the operator can see.

The operator-facing summary comes back from the endpoint and becomes a toast:
*"New video settings applied to 6 devices · 2 kept their picture until their job
finishes."*

### 3.9 Feedback: three numbers, in the two places they are needed

`/api/adb/stats` already carries the measurements (F25). What is missing is a
reader.

- **On the Wall**, the existing counter line (`Wall.tsx:107-110`) becomes a
  status strip: `12 of 100 live · 9.1 Mbit/s · 4.8 fps avg · 480×1040`. Video
  rate and buffer come from `/api/adb/stats` (polled every 10 s, and only while
  the tab is visible); fps is aggregated client-side from the tiles; the
  resolution is the size the streams actually came up at
  (`stream.started.width/height`), not the size that was requested — which is
  what makes a setting that did nothing visible (H3), including scrcpy's own
  rounding.
- **On the Video settings section**, the same block polled every 2 s while the
  section is open, beside the projection from §3.7. Adjusting a number and
  watching the measured rate move toward the projection is the feedback loop.
- **`/api/adb/stats` gains a `video` block** so both readers ask one endpoint:
  live streams by quality, resolved profiles, builds running, build queue depth.

None of this is a config panel, so §3.6's rendering rule does not apply — these
are readouts, and the settings page already carries a bespoke readout of exactly
this kind: `AdbDiagnosticsPanel`
(`packages/studio/src/app/settings/page.tsx:300-320`), which also establishes
the poll-only-while-visible discipline this plan copies.

### 3.10 Remembering the view within a tab — the landing view itself is not a setting

F2: nothing is remembered, and Studio has never used `localStorage` (or
`sessionStorage`). This section originally weighed three options for where the
*default* view should come from, including a `wall.defaultView` farm setting.
**§9 Q1 (decided 2026-08-12) settles that question differently from how this
section originally answered it**: the owner ruled the landing view
unconditional — *"wall first emang wajib tampilannya itu"* — so `wall.defaultView`
is **cut**, not merely defaulted to `'wall'`. A farm-wide switch that lets an
admin default everyone to List is exactly the configurability the owner ruled
out, for the same reason this section already rejected a farm setting *alone*
("one operator's preference would change everyone's front door") — the owner's
answer generalises that objection to cover every operator, including an admin
editing Settings.

List itself is not removed — the owner's decision is about the default a
fresh session sees, not about the view. So:

**Decision.** `packages/studio/src/lib/prefs.ts` — one Zod-parsed object,
holding the view and the tile size, with a `try/catch` read (private browsing
mode) and a schema fallback, exactly as originally designed — but split across
two storage backends, not one:

- **`view` lives in `sessionStorage`.** This is the mechanical device that
  makes "List is one click away" (§1) and "the Wall is the unconditional
  landing view" (§9 Q1) both true at once: a view switch survives a reload of
  the *same tab* (`sessionStorage` persists across reloads), but a new tab, a
  new window, or a new browser session starts with no preference at all and
  therefore always lands on the Wall — nothing to configure, nothing to reset,
  nothing an admin can change for anyone else.
- **`tileSize` stays in `localStorage`.** It is a property of the screen an
  operator is sitting in front of (§3.11), not a landing-view choice, and a
  screen's size does not reset just because a new tab was opened.

Precedence, most specific first: **URL query parameter → this tab's session
preference → `'wall'`**. There is no third rung and no farm setting in the
chain. A shared link still always shows what the sender saw, which is the
whole reason plan 47 put the view in the query string.

The static-export hazard is handled by construction: the dashboard already
bails out of prerendering because it calls `useSearchParams` inside a `Suspense`
boundary (`packages/studio/src/app/page.tsx:54`, `:696-701`), so a lazy
`useState` initialiser reading `sessionStorage`/`localStorage` runs client-side
only. 92.5's verifiable result checks the built HTML rather than assuming it.

**Reconciliation note for whoever reads this next.** The owner decided the
*default* is unconditional; he was not asked, and this plan does not claim he
decided, whether a same-tab reload should keep showing List at all. Keeping
that behaviour (via `sessionStorage` rather than dropping the memory entirely)
is this document's own inference, made so the Goals-section promise that "List
is one click away" survives a reload without also reviving a configurable
default. If that inference is wrong, the fix is local — swap `sessionStorage`
for a plain in-memory `useState` that forgets on any reload — not a reversal
of the owner's decision.

### 3.11 Tile size is a wall control, not a setting

F15: the grid is fixed at 180 px. On a 1440 px screen that is seven columns; on
a 4K wall-display it is twenty-one. A **Tile size: S / M / L** control
(140 / 180 / 260 px minimum width) sits next to the View toggle, persists in
`prefs.ts`, and changes only `TileGrid`'s `minTileWidthPx`. It is not a farm
setting: it is a property of the screen you are sitting in front of, which is
the same reasoning that keeps zoom out of settings everywhere else.

## 4. Technical design

### 4.1 Video profiles (`packages/protocol/src/settings.ts`)

```ts
/** The three numbers behind a quality profile. Named once, used by both. */
export const VideoNumbersSchema = z.object({
  maxSize: z.number().int(),
  maxFps: z.number().int(),
  bitRate: z.number().int(),
})
export type VideoNumbers = z.infer<typeof VideoNumbersSchema>

export const ControlPresetSchema = z.enum(['sharp', 'balanced', 'light'])
export const WallPresetSchema = z.enum(['detailed', 'balanced', 'light', 'minimal'])

// FarmSettings — a NEW top-level section. No optional fields (F22).
video: z.object({
  controlPreset: ControlPresetSchema.default('sharp')
    .describe('Picture quality for the device page. Sharp 1600 px · 30 fps · 4 Mbit/s. Balanced 1080 px · 30 fps · 2.5 Mbit/s. Light 720 px · 20 fps · 1.2 Mbit/s.')
    .meta({ title: 'Device page picture' }),
  controlMaxSize: z.number().int().min(480).max(2560).default(1600)
    .describe('Longest edge of the device-page picture, in pixels.')
    .meta({ title: 'Device page size (px)' }),
  controlMaxFps: z.number().int().min(5).max(60).default(30)
    .describe('Frames per second for the device page.')
    .meta({ title: 'Device page frame rate' }),
  controlBitRate: z.number().int().min(500_000).max(20_000_000).default(4_000_000)
    .describe('Video bitrate for the device page, in bits per second.')
    .meta({ title: 'Device page bitrate' }),

  wallPreset: WallPresetSchema.default('balanced')
    .describe('Picture quality for wall tiles. Detailed 720 px · 8 fps · 1.5 Mbit/s. Balanced 480 px · 5 fps · 800 kbit/s. Light 320 px · 3 fps · 400 kbit/s. Minimal 240 px · 2 fps · 200 kbit/s.')
    .meta({ title: 'Wall tile picture' }),
  wallMaxSize: z.number().int().min(160).max(1080).default(480)
    .describe('Longest edge of a wall tile, in pixels. Bigger tiles mean fewer live at once.')
    .meta({ title: 'Wall tile size (px)' }),
  wallMaxFps: z.number().int().min(1).max(30).default(5)
    .describe('Frames per second for a wall tile.')
    .meta({ title: 'Wall tile frame rate' }),
  wallBitRate: z.number().int().min(100_000).max(8_000_000).default(800_000)
    .describe('Video bitrate for one wall tile, in bits per second. The live-tile budget is divided by this number when Max live wall tiles is set to automatic.')
    .meta({ title: 'Wall tile bitrate' }),
}).default({ /* the eight values above */ })
  .meta({
    title: 'Video',
    description: 'How much picture each of the two views asks for. The device page and the wall are tuned separately: one is being driven, the other is being watched.',
  }),
```

The eight fields are flat on purpose. `PATCH /api/settings` merges one level
deep (F22), and the settings form PATCHes the whole object anyway
(`page.tsx:230`) — but a flat section is the shape that is correct under both,
and it keeps every field a single Zod node the form can render.

Per device, in `DeviceSettingsSchema` — every field optional, so an absent one
means "the farm's":

```ts
video: z.object({
  controlPreset: ControlPresetSchema.optional().describe('Overrides the farm setting for this device only. Leave empty to follow the farm.').meta({ title: 'Device page picture' }),
  controlMaxSize: z.number().int().min(480).max(2560).optional().meta({ title: 'Device page size (px)' }),
  controlMaxFps: z.number().int().min(5).max(60).optional().meta({ title: 'Device page frame rate' }),
  controlBitRate: z.number().int().min(500_000).max(20_000_000).optional().meta({ title: 'Device page bitrate' }),
  wallPreset: WallPresetSchema.optional().meta({ title: 'Wall tile picture' }),
  wallMaxSize: z.number().int().min(160).max(1080).optional().meta({ title: 'Wall tile size (px)' }),
  wallMaxFps: z.number().int().min(1).max(30).optional().meta({ title: 'Wall tile frame rate' }),
  wallBitRate: z.number().int().min(100_000).max(8_000_000).optional().meta({ title: 'Wall tile bitrate' }),
}).default({}).meta({
  title: 'Video',
  description: 'Picture quality for this device. Every field is optional — anything left empty follows the farm setting under Settings → Devices → Video.',
}),
```

And in the existing `wall` section:

```ts
maxTiles: z.number().int().min(0).max(64).default(0)   // CHANGED: 0 = auto
  .describe('How many wall tiles stream live at once. 0 divides a fixed video budget by the wall tile bitrate, so raising picture quality lowers the tile count automatically.')
  .meta({ title: 'Max live wall tiles' }),
// `defaultView` is deliberately NOT added here. §9 Q1 (decided 2026-08-12):
// the Wall is the unconditional landing view; a farm setting that lets an
// admin default everyone to List is exactly the configurability the owner
// ruled out. See §3.10.
rampConcurrency: z.number().int().min(1).max(8).default(2)   // NEW
  .describe('How many wall tiles may ask for a stream at the same time while the wall fills in.')
  .meta({ title: 'Wall fill-in concurrency' }),
```

`session` gains:

```ts
maxConcurrentBuilds: z.number().int().min(1).max(16).default(2)   // NEW
  .describe('How many device sessions may be started at the same time across the farm. Extra requests wait their turn rather than failing.')
  .meta({ title: 'Max concurrent session starts' }),
```

**Migration.** A stored `wall.maxTiles: 8` is the old default that no operator
chose deliberately (the same argument plan 85 §3.1 made for `adb.maxStreams: 4`),
so a `normaliseLegacyWall` preprocess rewrites a stored `8` to `0` on the first
boot after upgrade, and the removal is recorded in `00-overview.md` §9 with a
date. A stored value that is not 8 is left alone.

### 4.2 The resolver (`packages/session/src/video-profile.ts`, new — the artefact)

```ts
/** Preset tables. `control.sharp` and `wall.balanced` are today's constants, unchanged. */
export const CONTROL_PRESETS: Record<ControlPreset, VideoNumbers> = {
  sharp:    { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  balanced: { maxSize: 1080, maxFps: 30, bitRate: 2_500_000 },
  light:    { maxSize: 720,  maxFps: 20, bitRate: 1_200_000 },
}
export const WALL_PRESETS: Record<WallPreset, VideoNumbers> = {
  detailed: { maxSize: 720, maxFps: 8, bitRate: 1_500_000 },
  balanced: { maxSize: 480, maxFps: 5, bitRate:   800_000 },
  light:    { maxSize: 320, maxFps: 3, bitRate:   400_000 },
  minimal:  { maxSize: 240, maxFps: 2, bitRate:   200_000 },
}

export interface VideoProfile extends VideoNumbers {
  quality: Quality
  /** Where each number came from, for the readout: 'preset' | 'farm' | 'device'. */
  source: { maxSize: VideoSource; maxFps: VideoSource; bitRate: VideoSource }
}

/**
 * The ONE place farm video settings and a device's overrides are combined.
 * Precedence, most specific first: device field → farm field → preset table.
 * Pure: no clock, no I/O, no settings store — so `reprofile`'s comparison and
 * the Studio readout can both call it and can never disagree.
 */
export function resolveVideoProfile(
  farm: FarmSettings['video'],
  device: DeviceSettings['video'] | null,
  quality: Quality,
): VideoProfile

/** True when two profiles would produce a different encoder. Ignores `source`. */
export function sameVideoNumbers(a: VideoNumbers, b: VideoNumbers): boolean
```

`QUALITY_PROFILES` (`packages/session/src/session.ts:29-32`) is **deleted** and
its two call sites (`daemon.ts:1945`, and the type import in
`session.ts`) move to `resolveVideoProfile`. Replace, never version
(`00-overview.md` §4.3).

### 4.3 Session and manager (`packages/session/`)

```ts
// CreateSessionOpts
/** The resolved numbers this session must start its encoder with (plan 92 §4.2). */
videoProfile: VideoProfile

// DeviceSession
/** The profile the encoder actually came up with — what `reprofile` compares against. */
readonly videoProfile: VideoProfile

// SessionManagerDeps
/** Farm + per-device video settings, read fresh (the pattern `idleTtlSec` already uses). */
resolveProfile: (deviceId: string, quality: Quality) => VideoProfile
/** `session.maxConcurrentBuilds` (plan 92 §3.3), read fresh. */
maxConcurrentBuilds?: () => number

// SessionManager
/**
 * Restart a device's session at `quality` with a freshly resolved profile,
 * carrying subscribers and refcount (the generalisation of `upgradeToControl`,
 * manager.ts:220-244 — its coalescing map and carry-over are kept verbatim).
 */
restartAt(deviceId: string, quality: Quality, detail?: string): Promise<void>

/**
 * Restart every open session whose resolved profile no longer matches the one
 * it was built with. Skips `busy` devices (spec §10.1). Serialised through the
 * build lane. Returns what happened, for the operator-facing summary.
 */
reprofile(reason: string): Promise<{ restarted: string[]; skippedBusy: string[]; unchanged: number }>

/** Live streams by quality plus build-lane occupancy, for /api/adb/stats. */
videoStats(): {
  streams: { control: number; wall: number }
  buildsRunning: number
  buildQueueDepth: number
  profiles: Array<{ deviceId: string; quality: Quality; maxSize: number; maxFps: number; bitRate: number }>
}
```

The build lane is a plain counting semaphore around `createEntry`, acquired
*outside* `inFlight` so a second acquire for the same device still coalesces
onto the first without taking a second permit.

### 4.4 Core wiring (`packages/core/src/daemon.ts`)

- `makeScrcpy` takes the profile from the session instead of
  `QUALITY_PROFILES[quality]` (`:1945`).
- `resolveProfile` is built from `settingsStore.get().video` plus the device
  row's parsed `settings.video`, read fresh per call — the same freshness
  discipline as `idleTtlSec` (`:1932`).
- `settingsStore.onChange` gains a **debounced** (500 ms) `reprofile('farm settings changed')`
  beside the existing `recomputeAdbConcurrency` (`:380`).
- `PATCH /api/devices/:id` calls `sessions.restartAt(id, currentQuality, 'applying new video settings')`
  when `changedKeys` includes `video` and the device is not `busy`
  (`packages/core/src/api/devices.ts:530-540` already computes `changedKeys`).

`packages/core/src/session/adapters.ts` projects `settings.video` onto
`DeviceSnapshot` at the same seam it already projects `identity` and
`instrumentation` (`:43-50`), so the dead-config guard those comments describe
covers this too.

### 4.5 Protocol and API additions

```ts
// AdbStatsResponseSchema — a new block, same optional/zero-default contract as
// plan 85's `transport` and `hostAdb` (adb-stats.ts:22-31).
video: z.object({
  controlStreams: z.number().int(),
  wallStreams: z.number().int(),
  buildsRunning: z.number().int(),
  buildQueueDepth: z.number().int(),
  maxConcurrentBuilds: z.number().int(),
  /** wall.maxTiles as it is actually being applied, and whether it was derived. */
  maxTiles: z.number().int(),
  maxTilesAuto: z.boolean(),
}),
```

| Method | Path | Permission | Body / response |
|---|---|---|---|
| `POST` | `/api/video/reprofile` | `settings.manage` | → `{ restarted: string[]; skippedBusy: string[]; unchanged: number }` — the manual "apply now", used by the settings section's **Apply to live sessions** button and by anyone who wants it from curl. The automatic path (§3.8) calls the same function. |
| `GET` | `/api/adb/stats` | `device.view` | **extended** with the `video` block above |

No new WS message. The restart is already fully described by
`session.progress` + `detail` (F17), and adding a second announcement for the
same event is how two sources of truth start.

### 4.6 The Wall's live-set controller (`packages/studio/src/components/wall/`)

A new `useLiveSet` hook, so the policy is testable without rendering video:

```ts
export interface LiveSetInput {
  devices: DeviceInfo[]
  maxTiles: number
  rampConcurrency: number
  /** Ids currently intersecting the viewport (plus one row of margin), newest first. */
  visibleIds: string[]
  /** Ids the operator promoted by hand — always win over the automatic order. */
  pinnedIds: string[]
  now: number
}
export interface LiveSetOutput {
  /** Streaming right now. */
  live: string[]
  /** Wants to stream, waiting for a ramp slot. */
  pending: string[]
  /** Eligible but outside the budget. */
  budgeted: string[]
  /** Not streaming because of the device's own state. */
  blocked: Array<{ id: string; reason: 'asleep' | 'offline' | 'quarantined' }>
}
export function computeLiveSet(input: LiveSetInput): LiveSetOutput
```

Pure, so `Wall.test.tsx` can assert ordering, eviction, dwell, and the cap
without a DOM. The component owns only the `IntersectionObserver`, the 400 ms
dwell timers, and the ramp counter.

Ordering inside the cap: pinned → `visible && actual==='hot'` → `visible &&
actual==='awake'` → previously live and still visible → the rest, in grid
order. Eviction: lowest rank first, breaking ties by longest time off screen.

`Wall` also stops racing its own settings fetch (F14): it renders the skeleton
grid until `/api/settings` answers, so it starts the right number of streams
once instead of the wrong number twice.

### 4.7 Wall states — all six, none optional (`docs/design.md:49`)

| State | What it looks like | Why |
|---|---|---|
| **Loading (devices unknown)** | A skeleton **tile grid** at the current tile size — chrome, chip placeholders, a dark screen area — not `LoadingRows`. | The layout must not jump when the data lands. Today the wall is preceded by four full-width rows (`page.tsx:566`) and then becomes a grid. |
| **Loading (settings unknown)** | Same skeleton, held until `/api/settings` answers. | Fixes F14 — start the right number of streams once. |
| **Empty (no devices)** | Unchanged (`page.tsx:572-589`), including the "phones waiting to be added" variant. | Already correct. |
| **Empty (filter matches nothing)** | Unchanged (`Wall.tsx:93-101`). | Already correct. |
| **Partial (tile connecting)** | A **compact** phase panel: one spinner, one word (`Connecting` / `Waking` / `Video` / `First frame`), plus the elapsed seconds after 10 s. The four-step breadcrumb stays on the device page. | Fixes F16. Same information, sized for a 100 px column. |
| **Blocked (asleep)** | A screen-off placeholder: the tile's identity block, a dimmed screen area, "Screen off", and a persistent **Wake** (plan 48 rule 3, which still applies here — this is a device condition). | §3.2 rule 1. Honest, and it does not wake the farm. |
| **Budgeted (outside the live cap)** | A quiet neutral screen area; the whole tile is the "show live" target, with a small glyph on hover/focus. | §3.4's narrowing of plan 48 rule 3. |
| **Error (core unreachable)** | Unchanged `ErrorState` with retry (`page.tsx:564`). | Already correct. |
| **Error (one tile's stream failed)** | The existing `stopped` overlay, compact: the translated reason (`LiveView.tsx:59-64`) plus "Try again". | Already exists; only the compact sizing is new. |

The **status strip** above the grid replaces `Wall.tsx:107-110`:

```
12 of 100 live · 9.1 Mbit/s · 4.8 fps · 480×1040     [ Tile size S M L ]
```

with the four blocked/budgeted counts available on hover
(*"63 asleep · 21 outside the live budget · 4 offline"*), because a wall showing
12 of 100 must say what the other 88 are doing.

### 4.8 Tile layout (`WallTile.tsx`, `TileChips.tsx`)

The grammar plan 48 established — one chrome block, two lines, then picture —
is kept. What changes is what line 1 holds and where the holder badge goes.

```
┌──────────────────────────────────┐
│ 042  Galaxy A15 (kitchen)    ⇄   │  line 1: number · label · connection glyph
│ 🔋100%  🌡29.0°C  awake  idle    │  line 2: TileChips, unchanged order
│ ┌──────────────────────────────┐ │
│ │ [holder chip]                │ │  ← moved onto the picture
│ │            screen            │ │
│ │ [running-job caption]        │ │
│ │        [ actions ]           │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

Rules, each with a reason:

- **The number is an index, not a headline.** `.readout`, `text-fg-subtle`,
  fixed 3-character width so labels start at the same x across the grid. It
  never competes with the label for attention, and it is what an operator says
  out loud when pointing at a rack.
- **The connection is a glyph, not a badge.** One `lucide` icon (USB / Wi-Fi),
  right-aligned. A text badge on a 180 px tile costs roughly a third of line 1
  and pushes the label into an ellipsis; the *kind* is what gets scanned down a
  column, and one glyph does that better than three letters.
- **The IP is not on the tile.** It is the glyph's `title` and its accessible
  name (`"Wi-Fi, 192.168.1.42"`), it is searchable (`page.tsx:214`'s query gains
  the address), and it gets a **Connection** filter beside the readiness filter
  (`page.tsx:473`). An address is 15 monospace characters an operator reads once
  while debugging a connection and never again; permanent tile space is the
  wrong place for it, and search plus filter is where it earns its keep.
- **The holder chip moves onto the picture** (top-left, same scrim treatment as
  the running-job caption). Today it is a third line that appears when someone
  takes control (F31), so a tile changes height — and the whole grid reflows —
  the moment a colleague starts driving. Plan 48 §3.2's own reasoning applies
  exactly: who is driving is about the picture, so it belongs on the picture.
- **Drop order under narrow tiles**, via a CSS container query on the tile
  (`@container (max-width: 200px)`), never JS measurement: temperature drops
  first, then battery. **Number, label, connection glyph, readiness, and status
  never drop.** Because `auto-fill minmax` gives every tile in a grid the same
  width, a drop applies to the whole grid at once and plan 48 §3.2's column
  alignment survives.

The plans-88/89 fields are consumed behind one adapter so this plan builds and
ships either way (H4):

```ts
/** Plan 88 (connection) and plan 89 (number). Both optional today; a dash renders when absent. */
export interface TileIdentity { number: number | null; connection: { kind: 'usb' | 'wifi'; address: string | null } | null }
export function tileIdentityOf(d: DeviceInfo): TileIdentity
```

If plan 88 names its field differently, `tileIdentityOf` is the only edit.

### 4.9 Studio: preferences and the view control

**CHANGED (§9 Q1, decided 2026-08-12).** `view` and `tileSize` no longer share
one storage backend or one precedence chain. `view` must forget itself on a
new session (so the Wall is the unconditional landing view); `tileSize` should
not (it is a screen property, §3.11). Splitting the module in two is the
smallest change that keeps both true:

```ts
// packages/studio/src/lib/prefs.ts (new)

// This tab's view choice ONLY — sessionStorage, so it survives a reload of
// this tab but is absent in any new tab, window, or session. That absence is
// what makes the Wall the unconditional landing view (plan 92 §9 Q1): there
// is no farm setting and no cross-session memory to configure it away.
const SessionPrefsSchema = z.object({
  view: z.enum(['list', 'wall']).optional(),
})
/** Reads sessionStorage through the schema; any failure (private mode, corrupt value) yields defaults. */
export function readSessionPrefs(): z.infer<typeof SessionPrefsSchema>
export function writeSessionPrefs(patch: Partial<z.infer<typeof SessionPrefsSchema>>): void

// A genuine cross-session preference — a property of the screen the operator
// is sitting in front of, not of what they want to land on.
const LocalPrefsSchema = z.object({
  tileSize: z.enum(['s', 'm', 'l']).default('m'),
})
export function readLocalPrefs(): z.infer<typeof LocalPrefsSchema>
export function writeLocalPrefs(patch: Partial<z.infer<typeof LocalPrefsSchema>>): void
```

Resolution in `page.tsx`, replacing `:73-76`:

```ts
const [view, setViewState] = useState<View>(() => {
  const q = params.get('view')
  if (isView(q)) return q          // a shared link always wins
  const p = readSessionPrefs().view
  if (p) return p                  // this tab's own earlier choice, this session only
  return 'wall'                    // the unconditional landing view (plan 92 §9 Q1) — nothing corrects this later
})
```

`setView` writes both the query string (as today, `:243-246`) and the session
preference. There is no farm setting in this chain to apply once `/api/settings`
answers — that was `wall.defaultView`, and §9 Q1 cut it (§3.10, §4.1).

## 5. Implementation steps

### 92.1 — Video profiles become settings (fixes F5, F7; avoids F18, F22) — DONE 2026-08-13

- [x] `packages/protocol/src/settings.ts`: `VideoNumbersSchema`,
      `ControlPresetSchema`, `WallPresetSchema`, the flat `FarmSettings.video`
      section, the all-optional `DeviceSettings.video` block, `wall.maxTiles`
      `min(0).default(0)` with `normaliseLegacyWall`, `wall.rampConcurrency`,
      `session.maxConcurrentBuilds`. **No `wall.defaultView`** — cut per §9 Q1
      (decided 2026-08-12). Correct `readiness.maxHot`'s doc comment per §3.7.
- [x] `packages/session/src/video-profile.ts` (new): the preset tables,
      `resolveVideoProfile`, `sameVideoNumbers`, `computeAutoTiles`.
- [x] Delete `QUALITY_PROFILES` from `packages/session/src/session.ts:29-32`;
      `CreateSessionOpts.videoProfile` replaces `quality`-as-a-lookup.
      **Every caller migrated in the same change** (`00-overview.md` §4.3):
      `packages/session/src/manager.ts` gained `SessionManagerDeps.resolveProfile`,
      which `createEntry` calls to build `CreateSessionOpts.videoProfile`;
      `CreateSessionDeps.makeScrcpy`'s third parameter changed from a
      `Quality` string to the already-resolved `VideoProfile`, so both
      `packages/core/src/daemon.ts` and `packages/node/src/hosts.ts` (the
      node package's own mini-core, which carries no farm settings store —
      `00-overview.md` §4.1's `node` boundary — so it never supplies
      `resolveProfile` and always gets `createSession`'s schema-default
      fallback, which is byte-identical to the old constants) had their
      `makeScrcpy` closures updated to read `profile.maxSize`/`maxFps`/
      `bitRate` directly instead of indexing `QUALITY_PROFILES[quality]`.
      `packages/session/src/types.ts`'s `DeviceSnapshot` also gained a
      `video?: DeviceSettings['video']` field (not itself named in this
      step's checklist, but required for `adapters.ts`'s projection below and
      for `manager.ts`'s `resolveProfile` accessor to have anything to read).
- [x] `packages/core/src/daemon.ts` (line numbers were stale, as warned — the
      real call site is `:2376-2407`, not `:1945-1957`): `makeScrcpy` now
      takes the numbers from the session's already-resolved profile; a new
      `resolveProfile` accessor (beside `idleTtlSec`/`maxIdleSessions`) reads
      `settingsStore.get().video` plus the device row's own `video` override.
      `packages/core/src/session/adapters.ts`: projects `settings.video` onto
      `DeviceSnapshot` at the same seam `identity`/`instrumentation` already
      use (the dead-config guard, F18).
- [x] `docs/plans/00-overview.md` §9: the `wall.maxTiles: 8 → 0` migration row
      added, with removal date 2027-02-13 (matching Plan 85's `adb.maxStreams`
      precedent's ~6-month window).
- [x] Also updated, not originally named in this checklist but required by
      "migrate every caller in the same change": `packages/session/src/index.ts`
      (dropped the `QUALITY_PROFILES` export, added the new `video-profile.ts`
      exports), `packages/protocol/src/index.ts` (appended the three new
      settings symbols at the very end, per that file's contested/append-only
      rule), `packages/studio/src/components/settings/farmSections.ts` (a new
      `video` section under `Devices`, plus a correction to the now-stale
      `readiness`/`wall.maxTiles` comment on the `sessions` section),
      `packages/core/README.md` and `packages/core/src/session/adapters.ts`'s
      own comments.
- **Verifiable result — CONFIRMED:** with no settings changed, a fresh farm
  produces byte-identical scrcpy arguments to today (`max_size 1600 max_fps 30
  video_bit_rate 4000000` for control, `480/5/800000` for wall), proven by a
  unit test over `resolveVideoProfile` in
  `packages/session/src/video-profile.test.ts` (pins the pre-plan-92
  `QUALITY_PROFILES` numbers directly, so a preset-table typo would fail the
  test, not just drift silently). Setting `video.wallMaxFps: 3` and opening a
  new wall tile spawns scrcpy with `max_fps 3` — proven end to end by
  `packages/session/src/manager.test.ts`'s new plan-92 describe block, which
  wires a fake `resolveProfile` and asserts the number `makeScrcpy` actually
  received. A **real** scrcpy-against-real-phone run of this same scenario is
  **pending — owner to run** (see this step's own smoke-test note below).
- **Hardware smoke test — pending, owner to run.** Nobody working on this
  step runs scrcpy against a real device; the unit test above proves the
  arithmetic, not the wire bytes. With one enrolled device and `bun run dev`
  running:
  ```bash
  # 1. Baseline — no settings changed, confirm the picture matches today.
  curl -s localhost:7700/api/devices | jq -r '.[0].id'   # note the device id
  # Open the device page in Studio, start Control, then visually confirm the
  # picture is unchanged from before this step (1600px/30fps/4Mbps). Open the
  # Wall for the same farm and visually confirm a tile is unchanged too
  # (480px/5fps/800kbps).

  # 2. Change a setting and confirm it actually reaches the device.
  curl -s -X PATCH localhost:7700/api/settings \
    -H 'content-type: application/json' \
    -d '{"video":{"wallMaxFps":3}}'
  # Open a NEW wall tile for the same device (a session not already open at
  # `wall` quality — an existing one will not re-profile until 92.2 lands)
  # and confirm the picture visibly drops to ~3fps.
  ```
  | Step | Expected | Observed |
  |---|---|---|
  | Baseline device-page picture (no settings changed) | Looks identical to before this step (1600px/30fps/4Mbps) | *(owner to fill in)* |
  | Baseline wall-tile picture (no settings changed) | Looks identical to before this step (480px/5fps/800kbps) | *(owner to fill in)* |
  | `PATCH /api/settings` with `video.wallMaxFps: 3`, then a brand-new wall tile | Visibly ~3fps | *(owner to fill in)* |
  | scrcpy-server itself | No new/rejected argument, no error in its stderr (`packages/scrcpy/src/version.ts`'s pinned server still accepts exactly `max_size`/`max_fps`/`video_bit_rate`, unchanged) | *(owner to fill in)* |

### 92.2 — Live re-profile (fixes the "saved but never read" class; §3.8) — DONE 2026-08-13

- [x] `packages/session/src/session.ts`: `DeviceSession.videoProfile` (typed
      optional — see this step's own entry in the plan status line above for
      why that corrects §4.3's own snippet rather than contradicting it).
- [x] `packages/session/src/manager.ts`: generalised `upgradeToControl` into
      `restartAt(deviceId, quality, detail?)`, keeping the `upgrading`
      coalescing map and the subscriber/refcount carry-over unchanged (line
      numbers were stale as warned — the real pre-step site was
      `manager.ts:407-435`, not `:236-238`); added `reprofile(reason)` with
      the five rules of §3.8; `detail` threads through to `onPhase`.
- [x] `packages/core/src/daemon.ts` (line numbers were stale — the real
      `settingsStore.onChange` site is `:510`, not `:380`, which is now
      `recomputeAdbConcurrency`'s own registration, unmoved): debounced
      (500ms) `reprofile` registered right after it. `packages/core/src/api/devices.ts`
      (real site `:749-751` pre-step, not `:530-540`): `restartAt` when
      `changedKeys` includes `video` and the device is not `busy`.
- [x] `packages/core/src/api/video.ts` (new): `POST /api/video/reprofile`.
- [x] `packages/studio/src/components/LiveView.tsx` (real site `:248-250`
      pre-step, not `:189-191`): keeps `payload.detail` in state and renders
      it under the phase headline in both compact and full modes (F17).
- **Verifiable result — CONFIRMED at the unit/integration level, pending a
  real two-device browser run (owner to run, see the plan status line
  above):** with two devices live (one on the wall, one on the device page),
  changing `video.wallBitRate` restarts exactly the wall one; its tile shows
  the "Starting video"/"Video" phase plus *"applying new video settings"*
  underneath, and returns to a picture without the viewer re-subscribing
  (proven by the refcount carry-over test in `manager.test.ts`, since a
  broken carry-over would close the entry on the very first `release()`). A
  device running a job is listed in `skippedBusy` and keeps its picture
  (proven by asserting its session object is never replaced).

### 92.3 — The build lane and the video stats block (fixes F9; tests H1) — DONE 2026-08-13

- [x] `packages/session/src/manager.ts`: a counting semaphore
      (`createBuildLane`, module-private) around `createEntry`, sized by
      `SessionManagerDeps.maxConcurrentBuilds()` (new; undefined leaves the
      lane unbounded — the pre-plan-92 behaviour, so a caller wiring nothing
      is unaffected). **Queues, never refuses**: `run(fn)` `await`s a permit
      and always executes `fn`; `finally` always releases, including when
      `fn` throws, so a failed build can never leak farm capacity. **Acquired
      outside `inFlight`/`upgrading`**: the permit wait happens INSIDE the
      promise those two per-device dedupe maps store (`pending =
      buildLane.run(() => createEntry(...))`, then `inFlight.set(deviceId,
      pending)` runs synchronously right after), so a second caller for the
      SAME device arriving while the first is queued finds the map already
      populated and joins that one promise rather than requesting a permit
      of its own — proven by a dedicated test (`SessionManager — the build
      lane`, "two callers for the SAME device share the one queued build").
      Wired into both call sites that build a fresh session: `acquire`'s
      `inFlight` path and `upgradeToControl`'s restart. `videoStats()` per
      §4.3 — added as `videoStats?()` (optional), not the plan's own
      required signature: the workspace has a dozen-plus test fixtures that
      hand-build a `SessionManager`-shaped object literal for scenarios that
      have nothing to do with video (job runner, workflow executors,
      readiness), and `activeDeviceIds?()` right above it already
      establishes optional-for-fixture-compat as this file's own precedent.
      `Entry` gained a `videoProfile: VideoProfile | null` field (the
      profile `createEntry` resolved for that build, or `null` when no
      resolver is wired) so `videoStats()`'s `profiles` array can never
      disagree with what actually reached `makeScrcpy` — this is a step
      ahead of 92.2's own (not-yet-landed) `DeviceSession.videoProfile`, and
      the two are expected to converge once 92.2 lands.
- [x] `packages/protocol/src/api/adb.ts`: `AdbStatsResponseSchema.video`
      (§4.5) — `controlStreams`/`wallStreams`/`buildsRunning`/
      `buildQueueDepth`/`maxConcurrentBuilds`/`maxTiles`/`maxTilesAuto`, all
      `z.number().int()`/`z.boolean()`. Made `.optional()` on the wire, for
      the exact reason the `input` block right above it already is (its own
      comment explains): `AdbServerCard.test.tsx`'s `statsBody()` fixture
      (owned by the concurrent worker on `packages/studio/**`) predates this
      field, and this step's file-ownership boundary excludes Studio. The
      real running core still always sends it, zero-filled — proven by
      `packages/protocol/src/api/adb.test.ts` (new): a fully-populated block
      round-trips, a body with no `video` key at all still parses, and an
      out-of-range (non-integer) field is rejected.
- [x] `packages/core/src/api/adb-stats.ts`: wired with the same
      optional/zero-default contract as `transport` (`ZERO_VIDEO`, mirroring
      `ZERO_TRANSPORT`/`ZERO_HOST_ADB`/`ZERO_INPUT`) — a new `video` deps
      accessor carries `maxConcurrentBuilds`/`maxTiles`/`maxTilesAuto` (the
      farm-settings half), combined with `sessions()?.videoStats?.()` (the
      live-manager half, `controlStreams`/`wallStreams`/`buildsRunning`/
      `buildQueueDepth`) in the route handler. `packages/core/src/daemon.ts`
      wires both: `maxConcurrentBuilds: () =>
      settingsStore.get().session.maxConcurrentBuilds` on the
      `createSessionManager({...})` call, and a `video` accessor on the
      `createAdbStatsRoutes({...})` call that resolves `wall.maxTiles` as
      ACTUALLY APPLIED — `computeAutoTiles(resolveVideoProfile(...).bitRate)`
      when the stored setting is `0` (auto), the stored value otherwise,
      never the raw `0` — using the farm's own resolved wall bitrate (no
      per-device override: `maxTiles` is a farm-wide budget). Proven by two
      new tests in `packages/core/src/api/adb-stats.test.ts`: zero-filled
      when `sessions()` is `null`, and the live `videoStats()` combined with
      the settings accessor when both are supplied.
- **Verifiable result — CONFIRMED, at the `SessionManager` layer (the layer
  this step owns; the plan's own "24 simultaneous `stream.start` messages"
  phrasing is the WS-protocol restatement of the same claim, and the WS
  handler is unchanged by this step — it already calls `sessions.acquire()`
  once per message, which is exactly what these tests drive directly).**
  `packages/session/src/manager.test.ts`'s new `SessionManager — the build
  lane` describe block: with `maxConcurrentBuilds: () => 2` and 6 distinct
  devices acquired concurrently, the peak concurrency observed BOTH by the
  fake encoder's own counter AND by `manager.videoStats().buildsRunning`
  read at the instant each build starts never exceeds 2, all 6 sessions are
  built (none refused, `manager.get(id)` is non-null for every one), and
  `buildQueueDepth` is confirmed to rise to 2 while a 3rd device queues
  behind a `maxConcurrentBuilds: () => 1` cap and drain back to 0 once every
  build finishes. A separate test proves the release-on-every-path
  requirement: acquiring a device absent from the device source throws
  synchronously from inside the lane's permit, and the very next acquire (at
  `maxConcurrentBuilds: () => 1`) still succeeds rather than hanging — if the
  failed build's permit had leaked, it would hang forever. A fifth test
  proves the lane is unbounded when no accessor is wired at all (the
  pre-plan-92 behaviour, F9, preserved for any caller that opts out).
- **Hardware / real-farm measurement — pending, owner to run.** This step's
  own software claim is proven above with fakes; §7.3's wall-first ladder
  (10 → 50 → 100 devices) is where the actual farm-scale numbers H1 asks
  for come from, and nobody working on this step ran it against real or
  `redroid` hardware. With a farm of at least 50 devices enrolled and
  `bun run dev` running:
  ```bash
  bun run dev            # core on :7700
  bun run dev:studio     # Studio on :3001

  # 1. Baseline: open the wall (or drive 50 concurrent stream.start
  #    requests directly, e.g. against /ws) and poll the lane while it fills.
  watch -n1 'curl -s localhost:7700/api/adb/stats | jq "{buildsRunning: .video.buildsRunning, buildQueueDepth: .video.buildQueueDepth, maxConcurrentBuilds: .video.maxConcurrentBuilds}"'

  # 2. H1's own test — plan §7.3's 50-device rung: record time-to-full-live-set
  #    at session.maxConcurrentBuilds = 1, 2, and 4, alongside
  #    transport.controlReplyMsP95 at each setting.
  curl -s -X PATCH localhost:7700/api/settings \
    -H 'content-type: application/json' \
    -d '{"session":{"maxConcurrentBuilds":1}}'
  # ...repeat the cold-load timing, then with maxConcurrentBuilds: 2 and 4.
  ```
  | `session.maxConcurrentBuilds` | Time to full live set | `video.buildsRunning` peak | `transport.controlReplyMsP95` | Observed |
  |---|---|---|---|---|
  | 1 | | ≤1 | | *(owner to fill in)* |
  | 2 (default) | | ≤2 | | *(owner to fill in)* |
  | 4 | | ≤4 | | *(owner to fill in)* |

  Expected outcome per §7.3: "if 4 is not materially worse on
  `transport.controlReplyMsP95`, raise the default and say so; if 1 is
  materially better, lower it." This step deliberately leaves
  `session.maxConcurrentBuilds`'s schema default at `2` (set by 92.1)
  pending that measurement — changing the shipped default without the
  numbers above would be exactly the kind of unmeasured guess §3.3 argues
  against.

### 92.4 — The live-set policy (fixes F12, F13, F14; tests H2) — DONE 2026-08-13

- [x] `packages/studio/src/components/wall/useLiveSet.ts` (new): the pure
      `computeLiveSet` of §4.6 (eligibility/blocked classification, the
      pinned → visible-hot → visible-already-live → visible-new → off-screen
      rank order, the hard `maxTiles` cap, the `rampConcurrency` gate) plus
      `useLiveSet`, the hook that owns the `IntersectionObserver`, the
      per-tile `DWELL_MS` (400ms) dwell timers, and the ramp counter.
      **Two additions beyond §4.6's own sketch, both load-bearing, both
      documented in the file itself:** (1) `LiveSetInput` gained `liveIds` —
      the previous computation's own `live` output, read back in. Without it
      the function cannot be pure AND stable: `now` alone cannot tell an
      already-streaming tile from a same-rank newcomer, so nothing would
      stop a same-tier newcomer from evicting a tile that is already
      decoding, and the ramp gate would have nothing to gate against (it
      only limits ids NOT already in `liveIds`). `useLiveSet` supplies this
      via a ref that is updated after each call, deliberately kept OUT of
      the `useEffect` dependency array that recomputes it (an output
      feeding back in as an input would otherwise be an infinite loop). (2)
      A rank-4 device (not pinned, not visible, not already live) is now
      **excluded from `target` outright**, not merely ranked last — an
      early version of this function let a cap with room to spare
      (`maxTiles` bigger than the number of real candidates) fill itself
      with devices nobody had ever looked at, which is exactly the
      "opening the wall must not touch devices nobody scrolled to" property
      this step exists to build. Caught by this step's own
      `useLiveSet.test.ts` before it shipped (see the test named "an
      off-screen, never-pinned, never-live device is never promoted even
      when the cap has room"), not by inspection.
- [x] `packages/studio/src/components/wall/Wall.tsx`: uses `useLiveSet` in
      place of the hand-rolled `eligibleIds`/`liveIds` state 92.3/92.6 had
      already corrected once (see this step's own brief) — the
      `wall.maxTiles`-from-`/api/adb/stats` read (already the number
      ACTUALLY APPLIED, server-resolved by 92.3's `computeAutoTiles`) is
      preserved byte-for-byte and still gates the skeleton exactly as
      92.6 left it. **This step's own checklist line above ("hold the
      skeleton until `/api/settings` answers; apply `maxTiles` auto
      client-side") is stale, per the brief's own warning that every line
      number this plan has cited so far has been stale** — that is §4.6's
      pre-92.3 sketch, and re-introducing it (fetching `/api/settings` for
      `wall.maxTiles` and calling `computeAutoTiles` in Studio) would be
      exactly the silent blank-wall regression 92.6's own note warns
      against, plus a new one: `computeAutoTiles` lives in
      `packages/session/src/video-profile.ts`, a server-side package this
      step's file-ownership boundary does not extend to and that Studio's
      browser bundle has no business importing. What Studio DOES now fetch
      that it did not before is `wall.rampConcurrency` (`GET
      /api/settings`, `b.settings.wall.rampConcurrency`) — the one number
      `/api/adb/stats`'s `video` block does not carry — defaulted to the
      farm schema's own `2` and corrected non-blockingly once the fetch
      answers (it is a client-side courtesy only, §3.3, never worth a
      second loading state).
- [x] `packages/studio/src/components/wall/WallTile.tsx`: **verified, not
      duplicated** — 92.6 already checks `asleep` ahead of `live` and never
      mounts `LiveView` for it (`WallTile.test.tsx`'s own "screen-off
      placeholder" describe block proves it). The only change this step
      makes to the file is additive: an optional `rootRef` prop forwarded
      onto the tile's existing root `next/link` (which already forwards
      `ref` to its underlying `<a>`) so `useLiveSet`'s
      `IntersectionObserver` has something to observe — no wrapper element,
      no second anchor, the single-click/double-click handlers and the
      "root is itself a `next/link`" rule both untouched.
- **Verifiable result — CONFIRMED at the layer this step owns (the pure
  policy plus the hook's viewport/dwell/ramp wiring), each clause traced to
  its own test in `useLiveSet.test.ts`:**
  - *"zero streams on asleep devices"* — `computeLiveSet`'s own
    `describe('computeLiveSet — eligibility ...')` block: an asleep device
    is `blocked` unconditionally, even when a stale caller also lists it in
    `visibleIds`/`pinnedIds`/`liveIds` (belt-and-braces, matching
    `WallTile`'s own independent `asleep`-before-`live` check). The hook
    test `'an asleep device that dwells past DWELL_MS never becomes live'`
    proves the same holds end-to-end through the `IntersectionObserver` +
    dwell path, not only in the pure function.
  - *"scrolling quickly starts zero streams"* — the hook test `'fast
    scroll: a tile that intersects and un-intersects before DWELL_MS
    elapses never becomes live'`: the dwell timer is cancelled on
    `isIntersecting: false` before it ever fires, so the id never enters
    `visibleIds`, so it is never a rank-0..3 candidate, so it can never be
    promoted — matching the file header's claim that dwell filtering
    happens *before* `computeLiveSet` ever sees the id, not as a
    probabilistic race.
  - *"stopping on a row starts streams for that row only, hot devices
    first, at most 2 requests outstanding"* — the hook test `'stopping on a
    row: dwelled tiles become live, hot ones first, at most
    rampConcurrency at once, the rest a ramp step later'`: three tiles
    dwell together (one hot), `rampConcurrency: 2` promotes exactly 2 —
    always including the hot one — and the third waits in `pending` until
    one `RAMP_STEP_MS` tick later. `computeLiveSet`'s own ramp-gate
    `describe` block proves the general rule (hot-first, at-most-N-new,
    already-live ids never count against the gate) with hand-built inputs,
    independent of the hook's timers.
  - Ordering/eviction/budget/stability beyond the three headline clauses —
    pinned always wins, an already-live tile is never evicted by a
    same-tier newcomer, a tile that scrolled off screen is the first
    evicted under budget pressure, `maxTiles: 0` means "not known yet"
    never "auto" — each has its own test in `computeLiveSet`'s three
    `describe` blocks (eligibility, ordering, the budget), 15 tests total,
    runnable with no browser at all.
  - `Wall.test.tsx`'s pre-existing "status strip breakdown" tests (written
    against 92.6's own hand-rolled, non-viewport-gated live set) needed
    updating, not just re-running: without a real `IntersectionObserver`
    a tile can never dwell, so a test asserting a device is live has to
    simulate visibility. `Wall.test.tsx` now installs a module-scoped fake
    `IntersectionObserver` that reports "visible" the instant a tile
    registers (these are shell/status-strip tests, not scroll-timing
    tests — `useLiveSet.test.ts` owns that), and its `WallTile` mock now
    forwards `rootRef` to a real `<a>` so the registration actually
    happens; all three tests wait out `DWELL_MS` via `waitFor` and their
    original count/title assertions are otherwise unchanged.
- **Not provable without hardware — pending, owner to run.** Everything
  above proves the POLICY (the pure function and the hook's own
  observer/dwell/ramp wiring) against fakes. It does not and cannot prove:
  (a) that a real `IntersectionObserver` in a real browser reports
  `rootMargin: '200px 0px'` the way this step assumes on an actual 100-tile
  grid; (b) that `adb shell dumpsys power` genuinely shows no wake on 90
  real asleep phones — this step's `live` output never reaching `WallTile`
  is necessary but not sufficient, since F11 (`createSession` wakes
  unconditionally) lives in `packages/session/src/session.ts`, outside this
  step's file-ownership boundary, and only a real device proves the two
  layers compose correctly end to end; (c) that "at most 2 requests
  outstanding" holds against the ACTUAL WS wire, not just this hook's
  internal `live` bookkeeping — `RAMP_STEP_MS` (800ms) is a fixed timer
  standing in for "the previous batch has probably connected by now"
  because `LiveView` (a concurrent worker's file, plan 94 step 94.2)
  reports no real "connected" signal this hook could gate on instead; the
  real hard bound for concurrent session BUILDS is server-side
  (`session.maxConcurrentBuilds`, 92.3's build lane), and this client ramp
  is deliberately only ever a courtesy on top of it (§3.3). With a farm of
  at least 100 enrolled devices (redroid or real hardware), at least 90 set
  to `readiness.desired: 'asleep'`, and `bun run dev` / `bun run
  dev:studio` running:
  ```bash
  # 1. Cold load — confirm nothing wakes just from opening the wall.
  curl -s localhost:7700/api/devices | jq '[.[] | select(.readiness.actual=="asleep")] | length'   # expect ~90
  # Open http://localhost:3001/ (the Wall, unconditionally per 92.5) and
  # immediately, without scrolling, run:
  for id in $(curl -s localhost:7700/api/devices | jq -r '.[] | select(.readiness.actual=="asleep") | .id'); do
    adb -s "$(curl -s localhost:7700/api/devices/$id | jq -r .device.serial)" shell dumpsys power | grep -i "mWakefulness=" 
  done
  # Expected: every one reports Asleep, none Awake.
  curl -s localhost:7700/api/adb/stats | jq '.video.wallStreams'   # expect it to reflect only the awake/hot devices actually on screen, never 90+

  # 2. Fast scroll — hold Page Down / drag the scrollbar top to bottom in under ~2s.
  #    Poll during the scroll:
  watch -n0.2 'curl -s localhost:7700/api/adb/stats | jq "{wallStreams: .video.wallStreams, buildsRunning: .video.buildsRunning}"'
  # Expected: both stay at (or return to) whatever they were before the
  # scroll — no sustained rise during the scroll itself.

  # 3. Stop on a row — scroll to a row with a known mix of hot/awake devices, then stop.
  watch -n0.2 'curl -s localhost:7700/api/adb/stats | jq "{wallStreams: .video.wallStreams, buildsRunning: .video.buildsRunning, buildQueueDepth: .video.buildQueueDepth}"'
  # Expected: `buildsRunning` peaks at ≤2 (session.maxConcurrentBuilds,
  # the server-side hard bound — 92.3), the hot device(s) in that row
  # reach `wallStreams` first, and the row settles to N live tiles (N =
  # the row's device count, or `maxTiles` if smaller) within a couple of
  # `RAMP_STEP_MS` ticks.
  ```
  | Check | Expected | Observed |
  |---|---|---|
  | Cold load: `dumpsys power` on all ~90 asleep devices | Every one still `Asleep` | *(owner to fill in)* |
  | Cold load: `/api/adb/stats` session count for asleep devices | 0 | *(owner to fill in)* |
  | Fast scroll top→bottom: `video.buildsRunning`/`wallStreams` during the scroll | No sustained rise | *(owner to fill in)* |
  | Stop on a row: `video.buildsRunning` peak | ≤2 | *(owner to fill in)* |
  | Stop on a row: which device's stream appears first | The row's hot device(s) | *(owner to fill in)* |

### 92.5 — The Wall becomes the front door, unconditionally (fixes F1, F2; ships §9 Q1) — DONE

- [x] `packages/studio/src/lib/prefs.ts` (new), per §4.9 — the session/local
      split, not one shared module. `SessionPrefsSchema`/`readSessionPrefs`/
      `writeSessionPrefs` (sessionStorage, `view` only) and
      `LocalPrefsSchema`/`readLocalPrefs`/`writeLocalPrefs` (localStorage,
      `tileSize`), each Zod-parsed with a `try/catch` around storage access.
      Unit-tested in `packages/studio/src/lib/prefs.test.ts` (corrupt JSON,
      a value failing the enum, and a simulated storage-access throw all
      degrade to the schema default rather than throwing into the caller).
- [x] `packages/studio/src/app/page.tsx`: the precedence of
      §3.10 (URL → this tab's session preference → `'wall'`); `setView` writes
      both the query string and the session preference. No farm setting is
      read for this — `wall.defaultView` does not exist (§9 Q1).
- [x] The View toggle gains the **Tile size** control (§3.11 — S/M/L via
      `TILE_SIZE_PX` = 140/180/260px), visible only once the Wall is on
      screen, persisted via `writeLocalPrefs`, and threaded through `Wall`'s
      new `minTileWidthPx` prop (default 180, preserving F15's old constant
      for any other caller) into `TileGrid.minTileWidthPx`.
- **Verifiable result:** a fresh browser tab (no `?view=`, no session
  preference) opens `/` on the Wall; picking List and reloading **the same
  tab** opens List; opening a **new** tab or a private window opens the Wall
  again, unconditionally; opening `/?view=wall` opens the Wall regardless of
  the session preference. `bun run build:studio` succeeds and the dashboard
  body in `packages/studio/out/index.html` is the Suspense fallback,
  confirming no prerender reads `sessionStorage`/`localStorage` (§3.10).
  **Proven:** `packages/studio/src/app/page.test.tsx`'s
  `describe('Dashboard — the Wall is the unconditional front door ...')`
  covers all four cases above by unmounting/remounting `<Dashboard />`
  against the SAME `sessionStorage` ("reload") versus a cleared one ("new
  tab"), since `router.replace` is mocked and never actually mutates the
  URL the nav mock hands back. `bun run build:studio` run and verified by
  hand: `grep -c BAILOUT_TO_CLIENT_SIDE_RENDERING packages/studio/out/index.html`
  → `1`, and the body contains none of the Dashboard's own real strings
  (`"Tile size"`, `"Phones connected to this farm"`) — confirming the
  static export never executes `sessionStorage`/`localStorage` access.
  (In practice `AppShell`'s `AuthGate` already wraps every route in its own
  `useSearchParams()`-inside-`Suspense` boundary, so the bailout observed
  in the built HTML fires there first; `DashboardView`'s own `Suspense`
  boundary — unchanged by this step, pre-existing since plan 72 — is what
  would matter if `AuthGate`'s boundary were ever removed.)

### 92.6 — Every wall state (fixes F16; `docs/design.md:49`) — DONE 2026-08-13

- [x] `packages/studio/src/components/wall/TileSkeleton.tsx` (new) and its use
      for both loading states. The plan's own line citation for this step was
      already stale before this worker started (per this step's brief); the
      `LiveView.tsx:581-599` breadcrumb block cited in the next line is the
      wake-up panel's `showWakePanel && !stopped` JSX, which by the time this
      step landed was actually at `:733-754` (four separate edits to this
      file by 92.1/92.2-adjacent work moved it twice more before this step's
      own edit). `TileSkeleton` renders through the SAME `TileGrid` at the
      SAME `minTileWidthPx` the real grid uses (chrome/chip/screen-area
      placeholders), so the layout never jumps when real tiles replace it.
      `Wall.tsx` uses it for BOTH rows: `devices === null` (count defaults to
      8, nothing to size yet) and — new in this step — `devices` known but
      the live-tile budget not yet answered from `/api/adb/stats`
      (`count={devices.length}`, so an already-known device count does not
      reflow either). The empty-farm state (`devices.length === 0`) is
      checked BEFORE the budget wait, so an empty farm never waits on a
      budget it has nothing to apply.
- [x] `packages/studio/src/components/LiveView.tsx`: a `compact` branch of the
      wake-up phase panel — a new `PHASE_COMPACT_LABEL` one-word-per-phase map
      (`Connecting`/`Waking`/`Video`/`Frame`/`Loading`), a smaller spinner, and
      the same slow-phase elapsed-seconds readout after `SLOW_PHASE_AFTER_SEC`
      (10 s) — plus a `compact` branch of the (pre-existing) "Stream stopped"
      overlay: the same translated `explain(stopped)` reason and retry action,
      resized for a tile instead of the device page and relabelled "Try
      again". The full (non-`compact`) panel and headline are byte-for-byte
      unchanged — proven by a describe block per state in `LiveView.test.tsx`
      asserting BOTH that the compact word/overlay appears and that none of
      the full panel's own words (the four-step breadcrumb, "Stream stopped")
      leak into compact mode, and a companion test that the full mode still
      shows them.
- [x] `WallTile.tsx`: a screen state checked AHEAD of `live` (Plan 92 §3.2
      rule 1, closes F12 directly at the tile, not only in `Wall`'s own
      eligibility list): `asleep` renders a screen-off placeholder
      (`MoonStar` icon, "Screen off") and NEVER mounts `LiveView`, so an
      asleep device sitting in a caller's live set — the exact situation F12
      describes, and one 92.4's not-yet-landed live-set policy could still
      produce today — cannot wake a phone merely by being on screen. The Wake
      action (the existing bottom `ReadinessControl` overlay) is shown
      persistently for it, same as offline/quarantined (plan 48 rule 3). The
      pre-existing "outside `wall.maxTiles`" placeholder ("budgeted") is now
      QUIET (§3.4): its "Show live" glyph and the bottom Wake/Sleep overlay
      are both hover/focus-revealed, matching a live tile's own overlay,
      rather than a persistent button — the `hasPicture` boolean was renamed
      `revealOnHover` and now covers live-and-budgeted rather than
      live-only, with `blocked` (offline/quarantined/asleep) the only
      persistent case.
- [x] `Wall.tsx` (the counter line, previously `:107-110`, now further down
      the file after 92.5's own edits added the Tile-size prop and 92.3's
      settings-loading gate above it) → the status strip of §4.7: the
      live-count line gains a `title` attribute (native, no Radix Tooltip
      dependency — simpler, and avoids every caller needing a
      `<TooltipProvider>` in tests) listing counts by reason — "N outside the
      live budget", "N asleep", "N offline", "N quarantined" — omitted
      entirely (no `title` attribute at all) when every device is accounted
      for. `Wall`'s own live-set eligibility (`eligibleIds`) now excludes
      asleep as well as offline/quarantined, so "budgeted" and "blocked"
      never double-count the same device. **Also changed, beyond this step's
      literal checklist, because it was necessary to make the strip honest**:
      the live-tile budget is now read from `/api/adb/stats`'s
      `video.maxTiles` (92.3, landed mid-step) instead of `/api/settings`'s
      raw `wall.maxTiles` — reading the setting directly would show the raw
      `0` (auto, the shipped default since 92.1) and cap the live set at
      zero tiles for every farm that has not pinned a number, which is a
      worse "unexplained" failure than the one this step exists to fix.
      `DEFAULT_MAX_TILES` (8) is now purely the pre-answer/pre-`video`-block
      fallback, not a stand-in for `computeAutoTiles`.
  - **NOT done in this step, deliberately (out of scope, left to
    92.8/92.9):** the Mbit/s / fps / resolution portion of §4.7's own
    strip mockup. That needs polling `/api/adb/stats` every 10 s while the
    tab is visible plus client-side fps aggregation across every live tile's
    own `stream.started`/frame events — real work assigned to 92.8/92.9
    (§3.9), not named in this step's checklist, and not fabricated here.
- **Verifiable result — CONFIRMED at the component level; all nine §4.7 rows
  are reachable and legible in Studio's own test suite**, per row:
  1. **Loading (devices unknown)** —
     `TileSkeleton.test.tsx` + `Wall.test.tsx`'s "devices still loading
     renders the tile skeleton" (an `aria-busy` grid, not a blank div).
  2. **Loading (settings/budget unknown)** — `Wall.test.tsx`'s "devices known
     but the live-tile budget still loading renders the tile skeleton too,
     not the real tiles" (asserts NO tile testid exists yet).
  3. **Empty (no devices)** — unchanged, `Wall.test.tsx`'s pre-existing "no
     devices match" test, now also proven not to wait on the budget.
  4. **Empty (filter matches nothing)** — unchanged (pre-existing).
  5. **Partial (tile connecting)** — `LiveView.test.tsx`'s new compact-panel
     describe block: a `session.progress` message renders the one-word
     label and spinner.
  6. **Blocked (asleep)** — `WallTile.test.tsx`'s new describe block: "Screen
     off" renders, `LiveView`'s own canvas (`aria-label="Device screen"`)
     never mounts, and the Wake action is persistent, not hover-only.
  7. **Budgeted (outside the live cap)** — `WallTile.test.tsx`: "Show live"
     and the Wake/Sleep overlay both carry the hover-reveal opacity classes,
     not the persistent one; `Wall.test.tsx`'s breakdown tests confirm the
     count and the `title` wording.
  8. **Error (core unreachable)** — unchanged (pre-existing `ErrorState`,
     owned by `page.tsx`, outside this step's file list).
  9. **Error (one tile's stream failed)** — `LiveView.test.tsx`'s new
     stopped-overlay describe block: the compact overlay shows the
     translated reason and "Try again", never the full "Stream stopped"
     headline; the full panel is unchanged.

  The plan's SECOND clause — "at no point during a cold load of a
  100-device farm is any tile an unexplained blank rectangle" — is a
  hardware/scale claim this worker cannot produce (see below); the software
  half of that claim is that every branch a tile can render through
  produces one of the nine explained states above and never an empty
  fragment, which the per-row tests above are what stand in for it absent
  real hardware.
- **Hardware smoke test — pending, owner to run.** Nobody working on this
  step drove a real (or `redroid`) 100-device farm through a cold load; the
  component tests above prove every STATE renders correctly once reached,
  not that the real page reaches all nine during an actual cold load, nor
  what it looks like on screen. With a farm of at least 20–30 real/`redroid`
  devices enrolled (100 is the plan's own target; use whatever is actually
  available and note the real count) and some deliberately left asleep,
  offline, or quarantined so every row has a live example:
  ```bash
  bun run dev            # core on :7700
  bun run dev:studio     # Studio on :3001
  ```
  1. Put several devices to sleep (`ReadinessControl` → Sleep, or `adb shell
     input keyevent KEYCODE_SLEEP` directly), leave a couple offline
     (unplugged) and, if the farm has any, leave one quarantined.
  2. Open a brand-new tab to `/` (cold load — clear `sessionStorage` first if
     reusing a browser profile). Screenshot the very first paint (row 1,
     `TileSkeleton`), then again a moment later before real tiles settle if
     the budget fetch is visibly slower than the device fetch (row 2).
  3. Once settled, screenshot: a live tile mid-connect if one can be caught
     early enough (row 5 — reload one tab of a single device to catch it),
     an asleep tile (row 6, confirm `adb shell dumpsys power | grep
     mWakefulness` stays `Asleep` for it — the software claim F12 makes),
     a budgeted tile hovered and unhovered (row 7, confirm the "Show live"
     glyph is genuinely invisible at rest, not just faint), and a tile whose
     stream was killed mid-view (row 9 — kill its scrcpy child process on
     the device or `adb kill-server`-adjacent disruption is NOT permitted
     per this repo's rule; disconnecting the USB cable for one device is the
     safe way to trigger `stream.ended`).
  4. Stop the core (or block :7700) to reach row 8 (`ErrorState`).
  5. Confirm the empty-filter state (row 4) with a search that matches
     nothing.
  6. Watch the status strip's hover title through the whole sequence and
     confirm the blocked/budgeted counts move as devices change state.
  | Row | State | Screenshot taken | Any unexplained blank tile observed |
  |---|---|---|---|
  | 1 | Loading — devices unknown | *(owner to fill in)* | *(owner to fill in)* |
  | 2 | Loading — budget unknown | *(owner to fill in)* | *(owner to fill in)* |
  | 3 | Empty — no devices | *(owner to fill in)* | *(owner to fill in)* |
  | 4 | Empty — filter matches nothing | *(owner to fill in)* | *(owner to fill in)* |
  | 5 | Partial — tile connecting | *(owner to fill in)* | *(owner to fill in)* |
  | 6 | Blocked — asleep | *(owner to fill in)* | *(owner to fill in)* |
  | 7 | Budgeted — outside the live cap | *(owner to fill in)* | *(owner to fill in)* |
  | 8 | Error — core unreachable | *(owner to fill in)* | *(owner to fill in)* |
  | 9 | Error — one tile's stream failed | *(owner to fill in)* | *(owner to fill in)* |
  | — | Full cold load, top to bottom, every tile inspected | *(owner to fill in)* | *(owner to fill in — this is the plan's own bar)* |

### 92.7 — Tile layout for the fields plans 88 and 89 add (§4.8) — DONE 2026-08-13

- [x] `packages/studio/src/components/wall/tile-identity.ts` (new):
      `tileIdentityOf`, dash-tolerant.
- [x] `WallTile.tsx`: line 1 becomes number · label · connection glyph; the
      holder chip moves onto the picture; the tile gets `@container`.
- [x] `TileChips.tsx`: container-query drop order (temperature, then battery),
      with the fixed order and dash-for-missing of plan 48 §3.2 intact.
- [x] `packages/studio/src/app/page.tsx`: search covers the address; a
      **Connection** filter beside the readiness filter (already shipped by
      plan 88 §4.9 — confirmed present, not re-added; only the search
      predicate needed the address added here).
- [x] `DeviceCard.tsx` (the `:102` line cited was stale — the label link,
      not the connection block, which now starts around line 130): the same
      dash-tolerant number next to the label, through `tileIdentityOf`, so
      list and wall report the same number. NOT done: swapping `DeviceCard`'s
      battery/temp/readiness/status rendering for a shared `TileChips` row —
      considered and deliberately deferred (`DeviceCard`'s battery line shows
      a "charging" qualifier `TileChips` has no room for); plan 48 §9 Q1
      stays explicitly open for that larger question rather than being
      silently closed by this step.
- **Verifiable result:** a tile's height is identical whether or not the device
  is held, and identical whether or not plans 88/89 have landed; at a 140 px
  tile size the number, label, glyph, readiness, and status are all present and
  legible; tile height at a fixed grid width is recorded before and after
  (plan 48 §6.8's convention). **Height stability** is proven structurally in
  `WallTile.test.tsx` (the header block's DOM child count is asserted equal
  with vs without a holder, and the holder badge is asserted to render inside
  the picture container instead) rather than by a pixel measurement — happy-dom
  (this workspace's only test DOM) runs no layout engine, so
  `getBoundingClientRect` always reads `0` regardless of markup; the
  before/after tile-height figure plan 48 §6.8 asks for is therefore
  **pending — owner to run**, in a real browser:
  1. `bun run dev && bun run dev:studio`, open `/` (Wall, S tile size).
  2. Resize the browser so the grid renders an exact multiple of 140px
     (devtools device toolbar, e.g. 1400px wide → 10 columns).
  3. Devtools → select a tile → Computed → note its rendered height in px.
  4. Take control of that same device from a second tab/session so
     `heldBy` becomes non-null; reload the Wall; re-select the same tile;
     note the height again.
  5. Outcome table:

     | State | Tile width | Tile height | Notes |
     |---|---|---|---|
     | not held | 140px | _pending_ | baseline |
     | held (another operator) | 140px | _pending_ | must equal the row above |

     A mismatch between the two rows is a regression in the mechanism this
     step's tests already assert structurally — it would mean the structural
     proof above missed a case, not that the feature is unverified.

### 92.8 — The Studio surfaces for quality (§3.6, §3.9) — DONE 2026-08-13

- [x] `packages/studio/src/app/settings/page.tsx`: a **Video** section in the
      **Devices** group (`FARM_SECTION_DEFS`, `:72-102`) — rendered entirely by
      `SchemaForm` from `FarmSettings.video`, no bespoke fields.
- [x] An **Advanced** disclosure around the six number fields, with a
      "Reset to preset" action that clears them; the preset dropdown and the
      readout stay outside it.
- [x] The effective-profile readout (both profiles, resolved numbers, and where
      each came from) plus the projection line of §3.7 and the measured block of
      §3.9, polling `/api/adb/stats` every 2 s while visible.
- [x] An **Apply to live sessions** button calling `POST /api/video/reprofile`,
      with the summary toast of §3.8.
- [x] The device page's Settings tab renders `DeviceSettings.video` the same
      way, with an effective-profile readout naming the farm as the source for
      any empty field.
- **Verifiable result — settings-page half CONFIRMED, wall-strip half still
  open (see below):** `FarmVideoFields.test.tsx` proves the projection line
  itself moves with the unsaved draft, matching the plan's own worked
  numbers exactly — 25 live tiles ≈ 20.0 Mbit/s at the untouched `balanced`
  wall preset, 13 live tiles once `wallBitRate` is set to the `detailed`
  preset's 1.5 Mbit/s (`computeAutoTiles(1_500_000) === 13`, asserted in
  `video-quality.test.ts` and rendered live in
  `FarmVideoFields.test.tsx`'s "a customized number..." test) — all
  **before** Save, since the projection is a pure function of `draft`, no
  network round trip. The clause about what happens **after** saving —
  "the wall's own strip reports the new resolution and a video rate that
  converges on the projection within one poll interval" — is about
  `Wall.tsx`'s OWN status strip, which 92.6 explicitly deferred ("the
  Mbit/s/fps/resolution portion of §4.7's status-strip mockup ... not
  assigned here") to "92.8/92.9." This step did **not** pick it up:
  `packages/studio/src/components/wall/**` is outside this step's own
  file-ownership boundary (a sibling worker's files per the brief that
  scoped this step), and the aggregation Wall.tsx would need
  (`stream.started.width/height` and an fps figure summed across every live
  tile) is a client-side computation this step's own surfaces
  (`/api/adb/stats`'s `video`/`transport` blocks, read by the NEW
  `useAdbVideoStatsPoll` hook and rendered in the settings page's own
  "measured" block) do not, by themselves, produce. **Left open for 92.9 or
  a following step** — recorded here rather than silently claimed done.

### 92.9 — Documentation and spec — DONE 2026-08-13

- [x] `packages/session/README.md`: a new "Video profiles: two quality
      profiles, one resolver" section — the preset tables (pinned to the
      pre-plan-92 constants, with the reasoning for why), resolution
      precedence (device → farm → preset, and why `FarmSettings.video` is
      its own top-level section rather than folded into
      `FarmSettings.defaults`), the `wall.maxTiles: 0` = auto sentinel and
      `computeAutoTiles`'s formula, and what `reprofile` actually does to a
      live session (the five §3.8 rules, in particular that a `busy` device
      is never touched and picks up the new profile only at its next
      session — a deliberate blast-radius bound, not an oversight).
- [x] `packages/studio/README.md`: two new sections. "The Wall is the front
      door" states the URL → session-preference → `'wall'` precedence and
      the deliberately-cut `wall.defaultView` setting, phrased so a future
      reader does not re-propose it without first reading why it was
      rejected. "The wall's live-set policy" states `useLiveSet`'s four
      rules in order, with the asleep-is-blocked rule called out as the one
      non-negotiable ("there is no way to stream a device without waking
      its screen"). "The tile grammar" restates §4.8 as a rule for the
      *next* field to follow — height must never depend on content, line 1
      is identity and never drops, line 2 is condition in one fixed order
      with a stated container-query drop order, a per-device fact that
      is not yet available is a dash rather than a conditional DOM shape,
      and the IP/Connection-filter split generalises to "scanned vs.
      looked-up" for any future field — rather than only describing what
      `WallTile.tsx` happens to do today.
- [x] `docs/guide/install.md`: a new "The wall and video quality" section —
      what to turn down on a laptop/slow link (the wall preset, down to
      Light or Minimal), what to turn up on a dedicated wall display (up to
      Detailed, or Advanced numbers), and the arithmetic for why raising
      quality lowers the tile count (`live tiles ≈ 20 Mbit/s ÷ wall tile
      bitrate`, with the same worked numbers §3.7/the settings page use —
      25/13/32/5 — so a reader sees the identical figures in the guide and
      in the product).
- [x] `docs/spec.md` §19: the **Dashboard** row now states the Wall opens
      unconditionally, with no farm-wide or per-browser setting that
      changes it, and that List survives a same-tab reload only; the
      **Settings** row now names the new Video group under Devices — two
      presets, an Advanced reveal, the projection/measured readouts, and
      **Apply to live sessions**. Both edits are inline amendments
      (`*(amended, plan 92 §...)*` / `*(Added, plan 92 §...)*`) following
      the same annotation convention the Workflows row already established
      for a directly-added row, not a new DIV — this plan updates
      `docs/spec.md` itself in the same pass rather than deferring to a
      divergence row, per `00-overview.md` §7 item 8. `bun run spec:check`
      reconfirmed at **GAP 0** after the edit (that check is a
      name-presence check, not comprehension, per its own header — the two
      rows above were also checked by hand against the actual shipped
      behaviour of steps 92.1–92.8, not only for the names it greps for).
- [x] **The one piece of code deferred to this step**: 92.6 explicitly left
      the Mbit/s portion of §4.7's status-strip mockup ("12 of 100 live ·
      9.1 Mbit/s · 4.8 fps · 480×1040") to "92.8/92.9", and 92.8 could not
      pick it up because `packages/studio/src/components/wall/**` sat
      outside its own file-ownership boundary. `Wall.tsx` now polls
      `/api/adb/stats` every 10s (while mounted; visibility-gated, via the
      same `useAdbVideoStatsPoll` hook 92.8's own `FarmVideoFields.tsx`
      already uses) and renders the farm-wide measured video rate —
      `formatMbps(transport.videoBytesPerSec * 8)`, the identical
      conversion the settings page's `MeasuredBlock` uses — appended to the
      status strip as "· X.X Mbit/s across the farm", proven in
      `Wall.test.tsx`'s new "the status strip reports the farm-wide
      measured video rate" test (`2_500_000` bytes/s → `20.0 Mbit/s`,
      matching the settings page's own arithmetic exactly).
      **Deliberately NOT included, and said so rather than faked**: the
      average-fps and real-negotiated-resolution portion of the same
      mockup. Two reasons, not one: (1) `transport.videoBytesPerSec` is
      farm-wide across *every* open session, control and wall quality
      alike — the wire carries no per-quality split — so it is labelled
      "across the farm", never implied to be the wall's own spend alone;
      producing a wall-only figure would need a protocol change outside
      this step's ownership (`packages/protocol/src/schema/**` is another
      worker's, plan 97 step 97.2). (2) fps and the as-negotiated
      resolution genuinely need each live tile's own `stream.started`
      event plus a running frame counter — the only place either number
      exists today is `LiveView.tsx` (`packages/studio/src/components/
      LiveView.tsx`), which sits outside `packages/studio/src/components/
      wall/**`, exactly the boundary 92.8's own status note cites for
      leaving the same gap open. Closing it needs an additive `LiveView`
      stats-callback prop plus `WallTile` forwarding it — real feature
      work, not something to smuggle into a documentation step by editing
      a file outside its remit. **This is judged to belong in a follow-up
      step of its own** (not invented a number for here), fully documented
      in `Wall.tsx`'s own comment at the poll call site so the next worker
      does not have to reverse-engineer why it stops where it does.
- [x] **Consolidated the pending hardware** from steps 92.1, 92.2, 92.3,
      92.4, 92.6, and 92.7 (92.2 carries one too, embedded in the status
      line above rather than named in this step's own brief — included
      here anyway since the point of consolidating is completeness, not
      matching a list verbatim) into one ordered table, immediately below,
      mirroring plans 90 and 91's own consolidated tables. Every per-step
      note stays exactly where it was written; the table below only adds a
      cross-reference. **Nothing in it was run** — this step never touched
      a physical device or `redroid` instance, per this repo's standing
      rule.

**Consolidated hardware-pending table.** Gathers every *pending — owner to
run* note steps 92.1–92.7 accumulated (92.8 contributed a software gap, not
a hardware run — its row below says so and points at what this step did
about it) into the single list an owner sitting down with real hardware can
work through top to bottom, mirroring `docs/plans/90-m55-unified-guest-agent.md`'s
own "Consolidated hardware-pending table" and `91-m56-co-control-and-mirror-input.md`'s
per-step outcome tables. **Every per-step note above/below stays exactly
where it is — this table adds a cross-reference, it does not replace any of
them.**

| # | Source | Claim | Exact command | Outcome |
|---|---|---|---|---|
| 1 | Step 92.1's own entry (§5) | With no settings changed, the device page and a wall tile look identical to before this plan; `wallMaxFps: 3` visibly drops a NEW wall tile's frame rate; scrcpy-server itself accepts the arguments with no error | `curl -s localhost:7700/api/devices \| jq -r '.[0].id'`, visually confirm baseline picture on Control and a wall tile, then `curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' -d '{"video":{"wallMaxFps":3}}'` and open a brand-new wall tile — full script and a 4-row table in step 92.1's own entry above | _(unfilled)_ |
| 2 | Step 92.2's own entry (§5, table embedded right after the plan's own Status line at the top of this document) | Changing `video.wallBitRate` restarts only the wall session (not the device-page one), shows "applying new video settings", recovers without the browser tab re-subscribing, and a `busy` third device is left untouched and reported in `skippedBusy` | With two devices streaming (one Wall, one Control): `curl -s localhost:7700/api/devices \| jq -r '.[].id'`, then `curl -s -X PATCH localhost:7700/api/settings -H 'content-type: application/json' -d '{"video":{"wallBitRate":300000}}'` — full 5-row table at the top of this document, right after the Status line | _(unfilled)_ |
| 3 | Step 92.3's own entry (§5, H1) | The build lane's real-farm concurrency ladder: time-to-full-live-set and `transport.controlReplyMsP95` at `session.maxConcurrentBuilds` = 1, 2, and 4, on a farm of at least 50 devices | `watch -n1 'curl -s localhost:7700/api/adb/stats \| jq "{buildsRunning: .video.buildsRunning, buildQueueDepth: .video.buildQueueDepth}"'` plus a `PATCH /api/settings` cycling `session.maxConcurrentBuilds` through 1/2/4 — full script and a 3-row table in step 92.3's own entry above | _(unfilled)_ |
| 4 | Step 92.4's own entry (§5, H2) | Opening the wall on ~90 asleep devices wakes none of them; a fast top-to-bottom scroll starts zero streams; stopping on a row starts that row's streams, hot devices first, `buildsRunning` peaking at ≤2 | `adb shell dumpsys power \| grep mWakefulness` on every asleep device after a cold load, plus `watch -n0.2 'curl -s localhost:7700/api/adb/stats \| jq "{wallStreams: .video.wallStreams, buildsRunning: .video.buildsRunning}"'` during a fast scroll and a stop — full 3-part script and a 5-row table in step 92.4's own entry above | _(unfilled)_ |
| 5 | Step 92.6's own entry (§5) | Every one of §4.7's nine wall states is reachable and legible during a real cold load of a 20–100 device farm, with no unexplained blank tile at any point | A staged farm (some asleep, some offline, one quarantined if available), a cold-load screenshot pass through all nine states plus a full top-to-bottom sweep — full 6-step script and a 10-row table in step 92.6's own entry above | _(unfilled)_ |
| 6 | Step 92.7's own entry (§5, plan 48 §6.8's convention) | A tile's rendered height in a real browser is identical whether or not the device has a holder (happy-dom has no layout engine, so this cannot be measured in the test suite — it is proven only structurally there) | Resize the browser to an exact multiple of 140px, devtools → Computed → note a tile's height; take control of the same device from a second session; reload and re-measure — 2-row outcome table in step 92.7's own entry above | _(unfilled)_ |
| 7 | Step 92.8's own status note ("A real gap, not closed by this step") / this step's own note above | The wall's status strip reports a video rate that converges on the settings page's projection after a save | Not a hardware command — a software follow-up. **Partially closed by this step** (92.9): the farm-wide measured Mbit/s figure now renders on the wall strip (`Wall.tsx`, proven in `Wall.test.tsx`). The average-fps and as-negotiated-resolution portion is still open and needs a `LiveView.tsx` stats-callback addition outside `packages/studio/src/components/wall/**` — see this step's own note above for the full reasoning | N/A — see outcome column |

Rows 1–6 predate this step; none of the code they describe branches on their
outcome — every one is a confirmation of behaviour already proven against
fakes or unit tests, the identical "code lands either way" posture plan 90's
own consolidated table records. Row 7 is this step's own, and is the one row
in this table that is a code task rather than a device command — recorded
here because the task that produced this documentation pass asked for the
Wall status-strip gap specifically, not because it fits this table's other
six rows' shape.

## 6. Acceptance criteria

1. With no settings changed, a fresh farm produces byte-identical scrcpy
   arguments to today for both profiles, and an upgraded farm's stored
   `wall.maxTiles: 8` reads as `0` after one boot.
2. `FarmSettings.video`'s eight fields appear in Studio's **Video** section with
   their own labels and descriptions, rendered by `SchemaForm` with **no**
   bespoke form component added anywhere.
3. `DeviceSettings.video`'s eight optional fields appear on the device page's
   Settings tab; an empty field follows the farm, and the effective-profile
   readout names the farm as its source.
4. Changing a farm video number restarts exactly those live sessions whose
   resolved numbers changed, carries their subscribers, and shows
   *"applying new video settings"* on each restarting view.
5. A device with a running job is never restarted by a settings change; it is
   reported in `skippedBusy` and picks up the new profile at its next session.
6. `wall.maxTiles: 0` yields 25 at the default wall bitrate, 13 at `detailed`,
   and 5 if someone sets the wall bitrate to 4 Mbit/s. A non-zero setting always
   wins.
7. Twenty-four simultaneous `stream.start` calls never exceed
   `session.maxConcurrentBuilds` builds in flight, none is refused, and all
   twenty-four eventually stream.
8. Opening the wall on a farm of asleep devices starts zero streams and wakes
   zero phones; each such tile shows "Screen off" with a working Wake.
9. Scrolling a 100-device wall from top to bottom without stopping starts zero
   streams; pausing on a row starts that row's, hot devices first.
10. Every state in §4.7's table is reachable, and no tile is ever an
    unexplained blank rectangle during a cold load.
11. A fresh browser tab, with no `?view=` and no session preference, opens `/`
    on the Wall — unconditionally, with no setting anywhere that changes it
    (§9 Q1). A view chosen in one tab survives a reload of that same tab; a
    new tab or a private window opens on the Wall regardless of what was
    chosen elsewhere; a `?view=` link overrides both.
12. Tile height does not change when a device gains or loses a holder, and does
    not change depending on whether plans 88/89 have landed.
13. At a 140 px tile the number, label, connection glyph, readiness, and status
    are all rendered; temperature and battery drop in that order, uniformly
    across the grid.
14. The wall's status strip reports live count, video rate, average fps, and the
    real stream resolution; the settings section reports the projection beside
    the measurement.
15. Searching an IP address finds its device, and the Connection filter narrows
    both List and Wall.
16. `/api/adb/stats` reports the `video` block, and `POST /api/video/reprofile`
    returns the three-part summary.
17. No Tailwind v3 bracket colour classes are introduced; `design-rules.test.ts`
    passes over every file this plan touches.
18. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test`
    are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| profile resolution | `packages/session/src/video-profile.test.ts` | preset tables equal today's constants; device field beats farm field beats preset; `source` is reported correctly per field; `sameVideoNumbers` ignores `source` |
| auto tiles | `packages/session/src/video-profile.test.ts` | 800 k→25, 1.5 M→13, 400 k→32 (ceiling), 4 M→5, 100 M→4 (floor) |
| settings migration | `packages/protocol/src/settings.test.ts` | stored `wall.maxTiles: 8` → `0`; stored `12` untouched; a fresh row is `0`; every new field's bounds reject out-of-range values |
| re-profile | `packages/session/src/manager.test.ts` | restarts only changed profiles; carries subscribers and refcount; skips `busy`; coalesces two triggers into one restart; `detail` reaches `onPhase` |
| build lane | `packages/session/src/manager.test.ts` | never exceeds the cap; queues rather than refusing; same-device acquires still coalesce onto one permit; the cap is read fresh |
| live set | `packages/studio/src/components/wall/useLiveSet.test.ts` | hot-before-awake ordering; asleep is blocked with a reason; dwell suppresses fast scrolling; eviction is least-recently-visible; pinned always wins; the cap is never exceeded |
| preferences | `packages/studio/src/lib/prefs.test.ts` | URL > local > farm > `'wall'`; a corrupt or absent `localStorage` yields defaults and never throws |
| tile identity | `packages/studio/src/components/wall/tile-identity.test.ts` | absent number and absent connection both render a dash rather than an empty gap |
| tile layout | `packages/studio/src/components/wall/WallTile.test.tsx` | the holder chip is inside the picture, not the header; the chip drop order; the screen-off and budgeted states render their own affordances |
| phase detail | `packages/studio/src/components/LiveView.test.tsx` | `detail` renders; the compact panel shows one word, not four |

### 7.2 Local smoke (1–2 devices)

```bash
bun run typecheck && bun test && bun run --cwd packages/studio test
bun run dev            # core on :7700
bun run dev:studio     # Studio on :3001
curl -s localhost:7700/api/adb/stats | jq '.video, .streams, .transport'
curl -s -XPOST localhost:7700/api/video/reprofile | jq
```

Then, by hand:
1. Open `/` — it is the Wall. Switch to List, reload — still List (same tab).
   Open a new tab to `/` — the Wall again, unconditionally (§9 Q1). Open
   `/?view=wall` — the Wall.
2. Put one device to sleep. Its tile shows "Screen off" and does **not** wake
   it (`adb shell dumpsys power | grep mWakefulness` stays `Asleep`).
3. Settings → Devices → Video: switch the wall preset to Detailed. Watch the
   projection and the tile count change before saving. Save, and watch the live
   tile restart and come back sharper, with the "applying new video settings"
   line visible during the restart.
4. Start a job on the second device, change a video setting, and confirm the
   toast names it as skipped and its picture never breaks.
5. Set `wall.maxSize` to 1080 and confirm the auto tile count falls.
6. Resize the browser to 768 px and step the tile size S/M/L; confirm the chip
   drop order and that nothing overflows.

### 7.3 The wall-first ladder — 10 → 50 → 100

Run against a farm large enough to matter (a mixed real/`redroid` farm is
acceptable for the browser-side rows; rows marked **device** need real phones).
**Do not advance a rung until the previous one is green.** An empty cell is a
failed rung, not a skipped one.

| Measurement | How | 10 | 50 | 100 |
|---|---|---|---|---|
| time to first painted tile | DevTools, cold load | | | |
| time to a full live set | stopwatch | | | |
| streams started on asleep devices | `/api/adb/stats` | **0** | **0** | **0** |
| **device**: phones woken by opening the wall | `dumpsys power` | **0** | **0** | **0** |
| `video.buildsRunning` peak | polled 1 Hz | ≤2 | ≤2 | ≤2 |
| `video.buildQueueDepth` peak | same | | | |
| measured video Mbit/s vs projection | strip vs settings | within 20% | within 20% | within 20% |
| `transport.bufferedBytesP95` | `/api/adb/stats` | | | |
| `transport.controlReplyMsP95` | same | | | |
| tab CPU, steady state | DevTools | | | |
| decoders alive | `chrome://media-internals` | ≤ maxTiles | ≤ maxTiles | ≤ maxTiles |
| scroll top→bottom: streams started | `/api/adb/stats` delta | **0** | **0** | **0** |
| DOM nodes / frame cost at full grid | DevTools performance | | | |
| re-profile of all live sessions | `POST /api/video/reprofile` | | | |

Rung-specific:

- **10 devices** — the desk-farm baseline. Both `readiness.defaultDesired`
  values (`asleep` and `hot`) are run, and the two time-to-first-picture
  figures are recorded side by side: that pair is the measurement for **H2**.
- **50 devices** — the rung that decides the build lane's default. Record
  time-to-full-set at `session.maxConcurrentBuilds` of 1, 2, and 4. If 4 is not
  materially worse on `transport.controlReplyMsP95`, raise the default and say
  so; if 1 is materially better, lower it. This is **H1**'s test.
- **100 devices** — the rung that stresses the browser rather than the farm.
  Record the DOM/frame row with the grid fully rendered. If the frame cost of
  100 non-live tiles is itself the bottleneck, virtualisation becomes its own
  plan (§9 Q7) rather than being patched in here.

### 7.4 Regression watch

- A farm with `wall.maxTiles` pinned to a number keeps using that number.
- A farm that changes no video setting produces the same scrcpy arguments,
  session counts, and wall behaviour as before this plan, apart from the
  asleep-tile rule.
- A brand-new tab, with no `?view=` and no session preference, always opens on
  the Wall — there is no farm setting that reproduces "today's front door"
  (List) for a fresh session, by design (§9 Q1, decided 2026-08-12).
- A remote-node device still reports the quality it actually got (F28), and the
  effective-profile readout says so rather than showing the local resolution.
- A `screencap-loop` device still reports `screencap` in the readout (F29), and
  the video settings visibly do not claim to apply to it.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wall-first is simply wrong for a farm with 500 devices, and we have made the front door slow for them. | **DECIDED (2026-08-12, §9 Q1):** the owner ruled this unconditional — there is no `wall.defaultView` escape hatch. The mitigation is therefore the rest of this plan's performance work (§3.2's viewport-gated live set, §3.3's build lane, §3.7's coupled budget), not a config switch to List. §7.3's 100-device rung is still where this risk gets a real number; a bad number there is new evidence for a new question, not grounds to quietly reopen this one. |
| The asleep rule makes the wall look dead on a farm whose devices are asleep by default (`readiness.defaultDesired: 'asleep'`). | The tiles are explicitly "Screen off" with a working Wake, not blank (§4.7), and the strip says how many. §9 Q2 asks whether a "Wake all visible" bulk action belongs here — the multi-select toolbar already has Wake selected (`page.tsx:543`). |
| The client ramp and the server lane disagree and one of them becomes dead code. | They fail differently on purpose (§3.3), and both are measured separately in §7.3 (`buildsRunning` from the server, outstanding requests from the client). A rung showing the queue never non-empty at `rampConcurrency: 2` would say the ramp is doing its job. |
| Re-profiling restarts the session of someone actively driving a device. | It is a deliberate act by someone with `settings.manage`, it is announced on screen with a reason (§3.8 rule 5), and the summary names every device it touched. A job is never interrupted (rule 4). |
| `computeAutoTiles` surprises an operator who raises quality and silently gets fewer tiles. | It is not silent: the field description says it, the settings section shows the projected tile count as you type, and the wall strip reports the count. §9 Q3 asks whether the coupling should be opt-out. |
| The 20 Mbit/s budget is wrong for the machine in front of the operator. | It is a named constant with the §7.3 rows that would move it, and `wall.maxTiles` can always be pinned. It is a ceiling on *asking*, not a claim about the network. |
| An optional per-device field cannot be cleared once set. | It can: `PATCH /api/devices/:id` replaces the blob wholesale (F21), and the form emits `undefined` for an emptied number field. The farm-side variant of this bug (F22) is real, recorded, and deliberately out of scope (§2). |
| `localStorage` is a new mechanism in Studio and becomes a dumping ground. | One typed, Zod-parsed module with two fields (§4.9), and a written rule that any later view preference goes there rather than into a second mechanism. |
| Moving the holder chip onto the picture makes it harder to see. | It gets the same scrim treatment as the running-job caption, which plan 48 §3.4 already validated on live video, and it removes a whole-grid reflow (F31) that is worse. |
| The compact phase panel hides information the four-step panel gave. | The full panel is unchanged on the device page, where there is room; the compact one keeps the current phase and the slow-phase timer, which are the two things that answer "is this stuck". |
| Plans 88/89 land with different field names or never land. | Everything goes through `tileIdentityOf` (§4.8), which renders a dash for absent fields, and criterion 12 requires identical tile height either way. |

## 9. Open questions

1. **DECIDED (2026-08-12): unconditional. There is no `wall.defaultView`
   setting.** This section originally asked whether wall-first should be
   unconditional or a farm-configurable preference (the `wall.defaultView`
   enum proposed in §3.10/§4.1 below). The owner: *"wall first emang wajib
   tampilannya itu"* — that view is mandatory. The Wall **is** the devices
   page's landing view, for every farm, with no setting anywhere — farm-wide
   or per-browser — that changes what a fresh session opens on.

   This reverses one piece of this plan's own technical design, so it is
   reconciled here rather than left to contradict itself: **`wall.defaultView`
   is cut** (§3.10, §4.1, §4.9, 92.5, criterion 11, and the §7.4/§8 references
   to it are all amended to match — see each). What survives, because the
   owner's decision was about the *default*, not about removing the view:
   List still exists, is one click (or one `?view=list` link) away, and a
   `?view=` link still always wins, matching plan 47's reason for putting the
   view in the query string in the first place. What also survives, as this
   document's own inference rather than something the owner was asked: a view
   switched to *within a browser tab* keeps showing on a reload of that same
   tab (§3.10 now uses `sessionStorage`, not `localStorage`, precisely so that
   is true without it also being true of a brand-new tab or session — a new
   session always lands on the Wall, unconditionally). If that inference is
   wrong, it is a small, local fix, not a reversal of the owner's decision —
   see §3.10's own note.

   The risk this question was hedging against — wall-first being wrong for a
   very large farm — is not waved away; §8's first risk row is amended to say
   so: it is now a risk accepted on purpose, with §7.3's 100-device rung as
   where it gets a real number, and a bad number there is new evidence for a
   new question, not grounds to quietly reopen this one.
2. **Should the wall offer "Wake all visible"?** §3.2 rule 1 stops the wall
   waking phones as a side effect. Making it a deliberate one-click action is
   the natural complement, and the bulk Wake already exists in the List view's
   multi-select toolbar (`page.tsx:543`). Adding it to the wall means the
   default view can wake twenty phones with one click, which is either
   convenient or alarming depending on whose farm it is.
3. **Should `computeAutoTiles`' coupling be opt-out?** Raising picture quality
   silently lowering the tile count is the mechanism that keeps the sliders
   safe (§3.7). An operator on a 10 Gb LAN with a workstation may reasonably
   want both. Pinning `wall.maxTiles` already achieves it; the question is
   whether that is discoverable enough or whether it needs its own words in
   the UI.
4. **Should a per-device override of the `wall` profile exist at all?** The
   control profile clearly benefits from one (a device on `adb-tcp` over a slow
   link). A per-device wall profile makes a single wall render tiles of
   different quality, which may read as a rendering bug rather than a setting.
   This plan includes it for symmetry; dropping it is a one-line schema change.
5. **Is the 20 Mbit/s budget the right number, and should it be a setting?**
   It is currently a named constant. Making it a setting adds a knob whose
   correct value nobody can know without measuring; leaving it constant means
   an operator on a very fast or very slow link has to pin `maxTiles` instead.
   §7.3 produces the evidence either way.
6. **Thumbnails for non-live tiles** (plan 42 §9 Q1, re-asked). With the wall as
   the front door, most tiles are non-live most of the time, which strengthens
   the case a great deal — and still needs stored images, a retention policy,
   and a decision about whether a stale screenshot of a phone is helpful or
   misleading.
7. **When does the tile grid need virtualising?** §7.3's 100-device rung
   measures it. If the frame cost of a fully rendered grid is the bottleneck
   rather than video, that is a different problem with a different solution
   (windowing, which fights `IntersectionObserver`-driven live sets in
   interesting ways) and belongs in its own plan.
8. **Does the Wall deserve its own route now?** Plan 42 §9 Q3 answered "no,
   it is a mode so filters and tags apply to it unchanged", and that reasoning
   still holds. But `/` now *is* the wall, and `/?view=list` is the exception —
   which inverts the naming without changing the code. Cosmetic, but worth a
   decision before it calcifies.
