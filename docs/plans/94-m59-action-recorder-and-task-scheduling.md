# Plan 94 — M59 : The Action Recorder, and Runs That Repeat on a Jittered, Staggered Clock

> Status: partial — steps 94.1–94.10 done (recording document, replay verbs, the recorder, record mode in Studio, review/compile/publish/detach, `jobs.notBefore`/claim predicate/`job.waiting` reason, the batch pacer, stop-means-stop, schedules inheriting pacing, and pacing rendered in the run form/schedule form/batch detail). **Step 94.12 (documentation and the spec) is now DONE** — see its own checklist entry in §5. **Step 94.11 is now DONE (F30, acceptance criterion 19 closed)** — see its own checklist entry in §5 for full detail: `packages/core/src/api/batches.ts` gained one `carryForwardShape` helper both `POST /:id/rerun-failed` and `POST /:id/rerun?only=` call (never a copy each), carrying priority verbatim, the queue timeout as a re-applied DURATION rather than the stale absolute instant (an already-expired original no longer makes the rerun expire on arrival), and the original batch's own full pacing shape onto the failed (now including `expired`, not only `failed`) devices, deduplicated once per device — the stagger restarts from the rerun's own dispatch instant for free, because `createBatch` calls `deps.pacer.planFirst` at the moment it runs, never at the original batch's `createdAt`. `packages/core/src/clusters/pacer.ts`'s `replanAfterRestart` gained the orphan half of "Restart safety": a paced batch whose last device's last repetition already settled before a crash — so nothing is left to plan, but `batches.status` is still cached `queued`/`running` because the crash landed between that settle and `recomputeBatchStatus` actually running — is now reconciled to its real terminal status on boot, logged, and never for a batch left `stopping` (a written state this sweep does not touch at all). Step 94.7 (the pacer) is detailed in its own checklist entry below. **Step 94.8 (stopping) is now DONE** — `POST /api/batches/:id/stop` replaces `/cancel` (§3.9), gated per member by `canCancelJob` (F27), reused by `onOverlap: 'cancel-previous'` (`schedules/runner.ts`), and `@enkaku/protocol`'s `BatchStatusValue` is widened to `'stopping'` together with Studio's two exhaustive status-badge maps and a new **Stop** control (with a consequences dialog) on batch detail and the schedule's last run — see its own checklist entry below for full detail, including the hardware-verification table left pending for the owner. **Step 94.9 (schedules inheriting pacing) is now DONE** — see its own checklist entry in §5 for full detail. Step 94.1 (the recording document and the replay interpreter) implemented and unit-tested: `packages/protocol/src/recording.ts` (`RecordingStepSchema`, `RecordingTargetSchema`, `RecordingCandidateSchema`, `RecordingDocSchema`), `packages/protocol/src/selector-match.ts`'s `hitTest`, `packages/sdk/src/define-recording.ts`'s `defineRecording` — all exported from their package indexes. Verified with no device and no core, per the step's own verifiable result. Two findings surfaced and documented in `define-recording.ts`'s header comment for step 94.2 to resolve: (1) §4.4 names `gesture`/`longPress` as the new `DeviceApi` verbs step 94.2 must add, but a recorded tap's `point` target and a `swipe` step's `from`/`to` are ALSO stored normalised (F2) and need equivalent normalised-coordinate verbs (`tapNorm`/`swipeNorm`, absent from §4.4's code block) — declared locally in `define-recording.ts` pending 94.2; (2) `ScriptDefinition.timing` (§4.5, F10) does not exist on `packages/sdk/src/types.ts` yet either, so it is carried as a locally-typed extension that survives `defineScript`'s verbatim spread.
>
> Step 94.2 (the verbs the replay needs) is now DONE for the SDK/script path, unit-tested with no device: `InputTapMessage.payload.holdMs` (`packages/protocol/src/messages/input.ts`, shared via `INPUT_ACTION_BODIES.tap` so `input.mirror`'s tap verb carries it too); `LiveView.tsx` sends the measured `elapsed` as `holdMs` on every tap (a long-press is STILL `input.tap` — duration alone makes it one); `ws-handlers.ts`'s `input.tap` branch passes `{ holdMs: [exact,exact] }` when the client measured one, else a `tapJitterMs` device accessor (new, optional, defaults to `DEFAULT_TIMING.tapJitterMs`) — closing F5 for the default case. Both findings 94.1 flagged are resolved: `DeviceApi` (`packages/sdk/src/types.ts`) gained **four** verbs, not two — `gesture`, `longPress`, and (finding 1's fix) `tapNorm`/`swipeNorm` — with the full coordinate-space rule (device-pixel vs. normalised, and why) written as a doc comment directly above `DeviceApi` itself; `ScriptDefinition.timing` is now a real field. `define-recording.ts`'s local `RecordingDevice`/`RecordingScriptDefinition` workarounds are gone — it uses the canonical types directly. `packages/protocol/src/capability/device-args.ts` gained the four `DEVICE_CALL_ARGS` entries (`gesture`, `longPress`, `tapNorm`, `swipeNorm`) and `packages/session/src/runner/ipc.ts`'s `DeviceCallSchema` gained the matching union members — neither file is named in step 94.2's own file list, but `DeviceCall` (the type `device-executor.ts`'s new cases switch on) is defined across exactly these two files, so completing the assigned device-executor.ts work was not possible without them; flagged here rather than silently expanded. `device-executor.ts` implements all four new cases (`tapNorm`/`swipeNorm`/`gesture` map normalised → device pixels locally, mirroring — not importing — `ws-handlers.ts`'s `mapNormToDevice`, since `@enkaku/session` cannot depend on `@enkaku/core`; `longPress` centres `tapJitterMs`'s own width on the caller's `ms`) and its `timing` is now genuinely a getter read fresh on every device call, not once at executor construction — `packages/session/src/runner/job-runner.ts`'s one-line companion fix (`{ timing: deps.timing() }` → `{ timing: deps.timing }`, passing the accessor itself) is what makes that reach the real job path, verified by a test that changes a setting mid-run on one already-running executor.
>
> **Two items from step 94.2's own checklist were deliberately NOT done by this pass**, per this worker's brief, which excluded them from scope (a different worker's territory): `packages/session/src/runner/ipc.ts`'s `ready` message does not yet carry `ScriptDefinition.timing`, and `job-runner.ts` does not yet merge it over the device's own settings (§4.5's full wiring — the field exists on the type and survives `defineScript`'s spread per finding 2, but nothing reads a SCRIPT's own `timing` override yet); and **"make layer 1 real" (F35, F36) is still open** — `packages/core/src/daemon.ts:2087` still resolves only the farm-wide default, never a device row's own `settings.timing`, for both the job path and the capability/agent path. `ws-handlers.ts`'s new `tapJitterMs` dep is deliberately optional with a farm-wide fallback for exactly this reason — the plumbing is ready for `daemon.ts` to wire a real per-device accessor into, but nothing does yet. **Acceptance criterion 7 (a device's own Timing settings honoured) is therefore NOT met** — only its narrower manual-tap slice (F5) is. F4, F6, F7, F10 are closed for the verbs themselves; F3 (a drag replays with the operator's own sampled path, never a synthesised curve) is closed at the interpreter/executor level (unit-tested: `device.gesture` reaches `InputSink.gesture` sample-for-sample, mapped but never re-curved) but **acceptance criterion 5 needs a real device to confirm end-to-end** — see the new "94.2 hardware verification — pending, owner to run" note below §5's step 94.2, with exact commands and an outcome table; no physical device was available to this worker.
>
> Step 94.3 (the recorder) is now DONE, unit-tested and integration-tested with no device, per the step's own verifiable result: `packages/core/src/recording/anchors.ts` (`mapNormToPixels`, `anchorDue`, `proposeCandidateSelector` — pure, no I/O), `session.ts` (`createRecordingSession`/`RecordingSession` — the per-device state machine: `observe()` is synchronous and never awaited on the input path, property 1), `service.ts` (`createRecordingService`/`RecordingService` — the per-farm registry, `E_RECORDING_ACTIVE`/`E_NO_RECORDING`, `lastFinished`, and the `onStep`/`onBoundStopped` push registration mirroring `CrashWatcher.onJobCrash`'s single-subscriber shape). `packages/core/src/server/ws-handlers.ts` gained the tee (one `deps.recording?.get(deviceId)?.observe(...)` call immediately after each existing `deps.recorder.record(...)` in the `input.tap`/`.swipe`/`.gesture`/`.key`/`.text` branches, before the real device call) and the three `recording.*` cases, gated by the exact same `deps.leases.checkInputAllowed` call `input.*` already uses — no second permission check anywhere. `packages/protocol/src/messages/recording.ts` (new) declares `recording.start`/`.stop`/`.cancel` (client→server) and `recording.state`/`recording.step` (server→client), exported from `index.ts`'s two discriminated unions and its own append-only block at the true end of the file (never reordering the file's contested existing content). `packages/protocol/src/settings.ts` gained `FarmSettingsSchema.recording` with the six fields verbatim as specified (`anchorQuietMs: 400`, `anchorMinIntervalMs: 1500`, `longPressMs: 400`, `maxSteps: 500`, `maxDurationSec: 900`, `captureScreenshots: true`), unit-tested for every default and bound; `packages/studio/src/components/settings/farmSections.ts` claims the new key (`{ id: 'recording', title: 'Recording', group: 'Devices', keys: ['recording'] }`) — `farmSections.test.ts`'s exhaustiveness assertion passes with no changes needed to that test. Screenshots and anchor images go through the EXISTING blob store (`packages/core/src/agent/blob/store.ts`'s `createBlobStore`/`sniffImageMediaType`/`blobIdFor` — F16), never a second store; no new blob "kind" was needed since the store is already generic (content-addressed, media-type-sniffed), so `packages/core/src/blobs/` was not created.
>
> **Six decisions made by this pass, stated here rather than left implicit:**
> 1. **Anchor resolution timing.** §4.6's own `finishAndBuild` doc comment ("resolves candidates against the last anchor") is satisfied by computing each step's `candidate` SYNCHRONOUSLY inside `observe()`, using whichever `AnchorSnapshot` was most recently captured AT THAT MOMENT — not deferred to `finishAndBuild()`. This is the anchor that was current when the step landed (the anchor timer fires during the quiet gap BEFORE the next gesture, by design — §3.3), so "the last anchor" and "the anchor current at observe time" are the same thing in the common case; `finishAndBuild()`'s own job is only to await any STILL-IN-FLIGHT capture (an anchor dump or a step screenshot) before serialising, never to redo the candidate arithmetic.
> 2. **`RecordingDoc.recordedOn.model` has no dedicated source.** `devices` has no `model` column (only a discovery-time `probe.model` that gets folded into `label` once, at admission, and is never stored separately — confirmed by reading `packages/core/src/db/schema.ts` and `packages/core/src/registry/device-registry.ts`). `recordedOn.model` is populated from the device row's `label` — an honest best-effort, not fabricated data, but worth the owner's attention if a dedicated `model` column is ever added elsewhere.
> 3. **Anchors/screenshots require an inspector ALREADY attached** (e.g. the operator has the Inspect tab open, or a script/agent attached one). `recording.start` deliberately does NOT auto-attach one: doing so would mean either duplicating `ws-handlers.ts`'s own ref-counted `inspectorRefCounts`/`state.inspectAttached` lifecycle inside the recorder (a second copy of state this router already owns once) or leaking an inspector engine nothing ever releases. A recording opened with no inspector attached gets zero candidates and zero screenshots — never a failed recording (§4.6's own honesty rule), but this is a real product gap: **94.4 (record mode in Studio) should decide whether entering record mode also attaches the inspector**, and is flagged here rather than silently left for that step to rediscover.
> 4. **`text` steps store the LITERAL string, always** — never gated by the farm's `logInputText` setting (which only controls what the AUDIT/event log may show). A recording exists specifically to be replayed, and a replayed `text` step needs the real string; this makes a recording exactly as sensitive as the device session that produced it (reviewing one, 94.5, shows what was typed — the same as watching the screen live already would), which is a genuine privacy-relevant decision the owner should be aware a recording can now contain a password or a one-time code in the clear, on disk, once 94.5 persists it to the workspace.
> 5. **`RecordingService.lastFinished(deviceId)`** is an addition beyond §4.6's own interface sketch, flagged in both the code and here: an explicit `stop()` hands its caller the built document directly, but a BOUND (`maxSteps`/`maxDurationSec`) or a lost lease fires from inside the session with nobody awaiting a return value, so this accessor is the only way 94.4's step strip or 94.5's review panel can retrieve what a bound-ended recording actually produced.
> 6. **Lease-loss handling is split, not whole.** `RecordingService.stopForLeaseLost(deviceId)` (new, mirrors `stoppedReason: 'lease-lost'` already in the wire schema) is wired from `ws-handlers.ts`'s own `lease.release` success branch and from `handleClose`'s existing `leaseHolds`-walking loop — both cases this router can fully see and own. The automatic-revocation paths (idle timeout, quarantine, a takeover), which go through `daemon.ts`'s `onManualRevoked` rather than through this router directly, are NOT wired — `daemon.ts` is outside this step's file list. A forward-ref export, `stopRecordingForLeaseLost(deviceId)`, was added to `createWsMessageHandler`'s returned object (mirroring the existing `releaseLeaseHold`/`releaseShellSession` forward-refs) for exactly this gap; the missing `daemon.ts` line is named verbatim in this worker's final report.
>
> **GAP CLOSED, docs/plans/96-m61-hotfixes.md §96.16.** The two gaps flagged above — `daemon.ts` never constructing `RecordingService` at all (so `recording.*` refused `E_NOT_SUPPORTED` in every real boot, the fifteenth instance of this repo's "correct, tested code, unreachable production call site" defect class) and decision 6's split lease-loss handling (the automatic-revocation paths never called `stopRecordingForLeaseLost`) — are both now wired: `daemon.ts` constructs `recordingService = createRecordingService({ settings: () => settingsStore.get().recording, blobs: agentBlobStore, log: log.child('recording') })` beside `agentBlobStore`, passes it to `createWsMessageHandler(...)` as `recording: recordingService`, and both `onManualRevoked` (idle timeout, quarantine, forced disconnect) and `onManualTakenOver` (a takeover — a separate hook that never calls `release()`, so `onManualRevoked` never fires for it) now call the `stopRecordingForLeaseLost` forward-ref. See §96.16 for full evidence and the pinning tests added to `packages/core/src/daemon-wiring.test.ts`.
>
> **Not built by this pass, and explicitly out of this step's checklist**: `packages/core/src/recording/compile.ts` (94.5), the six `/api/recordings/*` routes (94.5), Record mode in Studio (94.4).
>
> Step 94.4 (record mode in Studio) is now DONE, unit-tested with no device (Studio-only work, per this worker's brief — `packages/core`, `packages/protocol`, `packages/sdk` untouched): `packages/studio/src/components/device/ScreenCard.tsx` gains `'record'` as a third `ScreenMode`, `packages/studio/src/components/recording/useRecording.ts` (new) is the client half of the `recording.*` WS surface step 94.3 shipped, and `packages/studio/src/components/recording/RecordPanel.tsx` (new) is the step strip / duration / step counter / Stop / Discard / review panel it feeds. `app/device/page.tsx` gained one prop wire (`recordDisabledReason` for node-owned devices, mirroring the existing `inspectDisabledReason`). Full detail, including the two 94.3-flagged decisions (the inspector-attachment gap, and lease-loss/bound handling) and their resolutions, is under step 94.4 in §5 below — not duplicated here. The hard part the brief named — entering `record` must not restart the video — is asserted directly in `ScreenCard.test.tsx` (DOM-node reference equality plus `active` never dropping to `false` across a `live → record → live` switch), not merely implied by the strip rendering. **94.4 hardware verification is pending, owner to run** — see the note under step 94.4 in §5, with exact steps and an outcome table; no physical device was available to this worker.
>
> Step 94.5 (review, compile, publish, detach) is now DONE, unit-tested with no device: `packages/core/src/recording/compile.ts` (new) — `emitRecordingEntry(doc)` (§4.7's three-line `defineRecording({...})` entry, deterministic and byte-identical on a re-compile of an unedited document) and `emitDetachedScript(doc)` (§4.7's detach emitter — a plain `defineScript` with every step expanded as a literal, ordered `await`, never an interpreter loop, per F18 and criterion 3's "readable generated source"), plus `paramsSchemaFor`/`paramsJsonSchemaFor` (§4.2's `{param}` → `z.object({ name: z.string() })` → JSON Schema, so `scripts.paramsSchema` is populated WITHOUT ever executing the bundle — F11). 19 tests, `compile.test.ts`. `packages/core/src/api/recordings.ts` (new) — `GET /`, `GET /:slug`, `PATCH /:slug`, `DELETE /:slug`, `POST /:slug/publish`, `POST /:slug/detach` (§4.9's six routes) **plus one addition beyond that table, flagged in the file's own header comment and here**: `POST /` (create) — pulls `RecordingService.lastFinished(deviceId)` (step 94.3's own addition beyond ITS interface sketch) and writes the FIRST `/recordings/<slug>.recording.json`, because nothing else in §4.9's table can create that file at all. Publish goes through the exact `buildScriptFromWorkspace` + `publishScript` pair `script.publish`'s `{ path }` form already uses — no new bundling (F11) — and `publishScript`'s `kind` is left at its default (`'script'`): a published recording is a `scripts` row with **no marker anywhere** distinguishing it from a hand-written one (criterion 2). "Detached" is tracked by a sentinel workspace file, `/recordings/<slug>.detached` (written by detach, checked by publish/PATCH), rather than a new `RecordingDoc` field — deliberately, since `packages/protocol/src/recording.ts` was outside this step's ownership list and this needed no schema change to implement. Detach refuses to overwrite a pre-existing hand-authored `/scripts/<slug>.ts`, deletes the compiled `/recordings/<slug>.ts` so **nothing regenerates over it again** (criterion 4 — publish afterward refuses `E_RECORDING_DETACHED`), and keeps the `.recording.json` (marked, not deleted). 26 tests, `recordings.test.ts`, including one that dynamically imports a published bundle and runs it as a real `ScriptDefinition` (F11/F18, never executed by the BUILD itself) and one asserting the stored `source` column is human-readable generated text containing the literal steps (F12, criterion 3). `packages/core/src/server/http.ts` gained an optional `recordingRoutes` field, mounted at `/api/recordings`, the same optional-mount pattern `workflowRoutes` already established. **`packages/core/src/daemon.ts` was wired in this pass** (a small, additive edit — one import line, one field inside the existing `createApp({...})` call, reusing the SAME `workspaceStore`/`recordingService` instances every other route in that file already shares) — unlike `workflowRoutes`'s own history, this was not left as an open gap; `packages/core/src/api/recordings-wiring.test.ts` is the self-detecting tripwire that stays in the tree and today PASSES, proving the wiring is real rather than merely declared.
>
> Studio: `packages/studio/src/app/recordings/page.tsx` (the list — name, step count, recorded time, a status badge for published/detached/not-published/corrupt, Review and Delete) and `packages/studio/src/app/recordings/detail/page.tsx` (`?slug=…`, not a dynamic segment — Studio is a static export, the same `?id=` precedent `app/device/page.tsx` set) — the review panel: a screenshot per step (the shared content-addressed blob store, F16), the gap in ms, a candidate's selector with its match count and anchor age, **Promote disabled unless `count === 1`** (with the disabled button's `title` naming the actual match count — "4 elements match this selector — promoting would tap a different one depending on the screen"), Demote, trim/reorder/delete a step, parameterise (and revert) a text step, `speed`/`maxGapMs`/`cleanup`/description editing under CAS (`PATCH`'s `ifMatch`, refreshed after every save), a Publish panel (version input, defaulting to a bumped patch), and a Detach/Delete ownership panel with `ConfirmDialog`s naming the one-way consequence. `packages/studio/src/components/recording/recording-api.ts` (new) is the typed client — response shapes are DUPLICATED from `recordings.ts` rather than imported from `@enkaku/protocol` (that package's `recording.ts`/`api/` were outside this step's ownership; the file's own header names the precedent `packages/protocol/src/recording.ts` itself already set for its own duplicated grammar). `packages/studio/src/components/recording/RecordPanel.tsx` gained the missing piece step 94.4 flagged as not yet existing: a "Save & review" form in the `reviewing` phase (name + version, validated against the same slug grammar) that calls the new create route and then links to `/recordings/detail?slug=…` — closing the loop 94.4's own report opened ("94.5's `/recordings/detail?slug=…` does not exist yet"). `packages/studio/src/components/device/ScreenCard.tsx` gained one line (`deviceId={deviceId}` passed to `RecordPanel`, which needed it and was not receiving it). 35 new Studio tests (`RecordPanel.test.tsx` +17, `recordings/page.test.tsx` +6, `recordings/detail/page.test.tsx` +12), all against a mocked WS/HTTP surface, no device.
>
> **The privacy exposure named in this step's brief, resolved as instructed — made visible, not decided.** A `text` step's literal string reaches disk the moment `POST /api/recordings` (or a `PATCH` that reverts a parameterised step back to a literal) writes it — 94.3's decision 4, now real. The review panel puts one unambiguous line directly at every such step: *"Stored verbatim — this exact text is saved to the workspace and will appear in the published script's source, regardless of the farm's 'log typed text' setting,"* plus the literal value itself in view, plus a summary count above the step list when one or more exist. No redaction (replay would break), no new farm setting (not this worker's decision to make), not a tooltip (`page.test.tsx`'s own test asserts the line is `getByText`-findable, not merely present in a `title` attribute). Parameterising a step removes the literal from the document the moment it is saved.
>
> **Not done in this pass, named rather than left silent:** (1) the six-route table in §4.9 does not by itself explain how the first `.recording.json` comes to exist — this worker added a seventh route (`POST /`) to close that gap rather than leaving the review panel permanently empty; if the owner wants exactly six routes, the same effect could be reached by folding creation into `PATCH` as an upsert, which was considered and rejected here as a worse API (a `PATCH` that sometimes means "create from a device's in-memory recording" and sometimes means "edit this JSON" is a harder contract to document than one more route). (2) Trim/reorder/delete/promote/parameterise are all local-state edits applied by one `PATCH` on "Save changes" — there is no per-action undo/redo and no autosave; an operator who edits and navigates away without saving loses the edit (the underlying `.recording.json` on disk is untouched either way, so nothing is corrupted, just not persisted). (3) `packages/studio/src/components/layout/AppShell.tsx` (the main nav) was NOT edited — `/recordings` has no nav entry, matching `/workflows`'s own precedent (also absent from that list as of this writing); reachable today only via a direct URL or the `RecordPanel`'s own "Review" link after saving. (4) A hand-crafted `.recording.json` (never produced by the recorder) that is well-formed JSON but fails `RecordingDocSchema` is reported as `corrupt: true` in the list rather than a 500 — verified in `recordings.test.ts`, not attempted in Studio beyond that.
>
> **`docs/spec.md` gap, relayed rather than written (that file is held by another worker per this step's brief).** `bun run spec:check` newly reports 7 names absent from spec.md and `spec-divergences.md`: the `/recordings` screen (`/recordings/detail` did not surface separately in the tool's own dedup, but needs the same treatment) and six routes (`GET /`, `GET /:slug`, `POST /`, `PATCH /:slug`, `DELETE /:slug`, `POST /:slug/detach` under `/api/recordings` — `POST /:slug/publish` did not surface as a gap because the bare word "publish" already appears in spec.md for unrelated reasons, the tool's own documented under-reporting). `FAIL_ON_GAP` is still `false`, so this does not fail CI, but the exact spec text this step would have added (§7.7-style route table rows, a §19 Studio-screens row for `/recordings` and `/recordings/detail`) is written out VERBATIM at the top of this worker's final report for the spec.md holder to paste in.
>
> **GAP CLOSED, 2026-08-13, by plan 98's documentation pass (step 98.9, which also owned this plan's relay).** `docs/spec.md` gained a new `### 11.8 Action recordings` section and a `## 19` Recordings row, independently re-verified against the tree rather than pasted verbatim — one factual correction was needed and made: `emitRecordingEntry` does **not** produce a literal three-line file (`compile.ts:85-95` pretty-prints the WHOLE document, `JSON.stringify(doc, null, 2)`, inline inside the `export default defineRecording(...)` call, so the real file's length is proportional to step count); the spec now describes it as "a short, generated entry — one `import` and one `export default defineRecording(...)` call with the document inlined" instead. Every other claim in this step's own relay text (the REST surface including the `POST /` addition, the compare-and-swap `PATCH`, detach's refuse-to-overwrite/delete-compiled/mark-detached triple, the `?slug=` Studio routing, and the `logInputText`-independent privacy disclosure) was independently re-confirmed against current source and carried through unchanged. `bun run spec:check` now reports the `/recordings` screen and all seven routes as accounted for. One unrelated defect surfaced during this re-verification — the review panel's "Revert to literal" control blanks a step's text rather than restoring it — and is recorded as `docs/plans/96-m61-hotfixes.md` §96.17 rather than fixed here (out of this documentation pass's own file ownership).
>
> Step 94.6 (a job can be told to wait) is now DONE — see the detail directly under that step's own checklist in §5, including the two-pass history (a stalled first worker, then this one). Step 94.7 (the pacer itself) is now also DONE — see its own checklist in §5 for the detail, including the deliberate one-step-early stop short of widening `BatchStatusValue`/touching Studio (that is step 94.8's, which is also the step that gets to touch `packages/studio/**` for this plan). **Step 94.8 (stopping) is now DONE** — see its own checklist entry in §5 for full detail. **Step 94.9 (schedules inheriting pacing) is now DONE** — see its own checklist entry in §5 for full detail. **Step 94.10 (Studio: pacing in the run form, the schedule form, and batch detail) is now DONE** — see its own checklist entry in §5 for full detail, including the two-pass history on `ScheduleEditorDialog.tsx` (built disabled-and-honest while 94.9 was still unshipped, then made functional once it landed mid-pass) and the hardware-verification table left pending for the owner. **All eleven of plan 94's numbered implementation steps (94.1–94.11) and 94.12 (documentation and the spec) are now DONE.** Every implementation step this plan named has shipped and is unit/integration-tested with no physical device — the ONLY thing standing between this plan and a clean `implemented` header is (a) the consolidated hardware-verification table in §5 (every row genuinely needs real phones and is the owner's to run, never an agent's, per this repo's standing rule) and (b) one genuinely unbuilt acceptance criterion, distinct from a hardware gap and named here rather than folded into it: **acceptance criterion 7** (a device's own Timing settings honoured, F35/F36) is blocked on `packages/core/src/daemon.ts:2087`-ish actually wiring a per-device `timing` accessor for both the job path and the capability/agent path — flagged as out-of-ownership by every worker who touched this plan (94.2's own status note above; step 94.11's own file list, `api/batches.ts` and `clusters/pacer.ts`, does not reach `daemon.ts`'s timing wiring either) and still open. This is why plan 94's own `> Status:` line stays `partial` rather than `implemented`: `implemented` in this repo's own convention (`scripts/check-plan-status.sh`) means every acceptance criterion is met, and criterion 7 is not — a distinction this line keeps honest rather than rounding up.
> Depends on: Plan 05 (the script framework and the subprocess runner), Plan 20/22.0 (clusters and batches), Plan 21 (schedules), Plan 40 (input realism — the gesture engine, `holdMs`, `perCharMs`), Plan 56 (`proposeSelectors`/`matches` in `@enkaku/protocol`), Plan 57 (the screen card's mode model), Plan 62 (`name@version` and `@latest`), Plan 64 (the workspace and server-side bundling), Plan 71 (the `job.waiting` broadcast), Plan 82 (plugins). None of them needs to change first; this plan extends four of them and duplicates none.
> Spec references: §7.4 (the persistent inspector), §9.3 (timing realism), §10.1–§10.4 (device state, lease, per-device queue, the exec semaphore), §11.1–§11.2 (`defineScript`, the rules that make it solid), §11.4 (publishing is a finished bundle), §12.3 (clusters, batches, schedules), §13 (the WS protocol), §16 (job overhead < 3 s), §19 (Studio screens)
> Ships: packages/protocol/src/recording.ts

---

## 0. Evidence

Every claim below about how Enkaku behaves today is **CONFIRMED** — there is a
file and a line that says so. Claims about how the new machinery will behave in
the field are **HYPOTHESIS**, and §5 instruments each one before §6 asserts it.

The competitor model this plan is measured against is recorded in the research
note the owner commissioned: Panda separates **Action** (a recorded gesture
macro) from **Task** (an external `.js`/`.bat`), and executes both through one
shared parameter shape — `count`, a randomised `[min,max]` interval between
repeats, `deviceInterval` as a fixed stagger across the fleet, and `startTimes`
for scheduling. The owner's instruction is verbatim: *"Action dan task dengan
interval acak min max dan device interval itu gas tetap."*

**A framing note that this plan does not re-litigate.** Enkaku no longer
positions itself as a QA/test-automation product; the acceptable-use document
and that framing were deliberately removed by the owner (recorded in
`docs/spec.md:450` and `:851`, both dated 2026-08-12). An earlier analysis
argued randomised intervals were wrong because "deterministic timing is a QA
feature". The owner has overruled that. Randomised intervals ship. What this
plan owes in exchange is that every randomised value is **materialised and
legible after the fact** — §3.7 — which is the property that actually matters
and which the one randomiser already in the tree (F21) does not have.

### 0.1 Confirmed findings — the recorder side

| # | Finding | Evidence |
|---|---------|----------|
| **F1** | **There is no input recorder and no replay anywhere in this repo.** The one thing named `recorder` is the *device event log* — a buffered writer of `device_events` rows, not an input capture. | repo-wide search; `packages/core/src/events/recorder.ts:5-16` |
| **F2** | Manual input already reaches the core in a **resolution-independent** form: coordinates are normalised 0..1 on the client and mapped to device pixels server-side. A recording built on this survives a different screen size for free. | `packages/protocol/src/messages/input.ts:6-8`; `packages/core/src/server/ws-handlers.ts:1161` |
| **F3** | A manual drag already carries the operator's **real sampled pointer trace** with millisecond offsets — up to 300 samples, `atMs` relative to the first, batched at 8 ms on the client and sent once on pointer-up. Replay fidelity for drags is therefore a data-plumbing problem, not a modelling one. | `packages/protocol/src/messages/input.ts:35-52`; `packages/studio/src/components/LiveView.tsx:30`, `:303-314`, `:331-335` |
| **F4** | **`input.tap` carries no hold duration.** `LiveView` measures `elapsed` on pointer-up and discards it whenever the pointer moved less than the drag threshold; the message shape has only `pos`. A long-press is not expressible on the manual path today, so it cannot be recorded. | `packages/protocol/src/messages/input.ts:10-13`; `packages/studio/src/components/LiveView.tsx:316-326` |
| **F5** | The manual tap path also drops the device's own hold-jitter range: it calls `session.input.tap(p)` with no options, while the script path passes `{ holdMs: timing.tapJitterMs }`. Manual and scripted taps therefore already differ in a way nothing documents. | `packages/core/src/server/ws-handlers.ts:1169` vs `packages/session/src/device-executor.ts:182` |
| **F6** | The **driver layer can already do everything a replay needs**: `tap(p, { holdMs: [min,max], rng })`, `gesture(samples)`, `typeText(text, { perCharMs, rng })`. The `rng` seam is explicit and injectable, and exists precisely so sampling can be made deterministic. | `packages/protocol/src/driver.ts:94-121` |
| **F7** | The **SDK cannot reach any of it.** `DeviceApi` has `tap`/`swipe`/`scroll`/`fling`/`type`/`key` and no verb that plays a sampled path, and no long-press. A script cannot express what the manual path already sends. | `packages/sdk/src/types.ts:15-116` |
| **F8** | Every script device call pays a **synthetic inter-action pause** drawn from `betweenActionMs`, whose default is **[300, 900] ms**. `pause()` runs at the head of `tap`, `swipe`, `scroll`, `fling` and `type`. | `packages/session/src/device-executor.ts:125`, `:175`, `:186`, `:193`, `:204`, `:215`; `packages/protocol/src/settings.ts:45-49` |
| **F9** | Every script tap is displaced by `coordJitterPx`, default **2 px**. | `packages/session/src/device-executor.ts:120-123`; `packages/protocol/src/settings.ts:50` |
| **F10** | The executor takes its timing **once, at attempt construction** — before the child's `ready` message can arrive — so a script has no way to influence it today. | `packages/session/src/runner/job-runner.ts:270-281`; `packages/session/src/runner/ipc.ts:148-176` |
| **F11** | The core **already bundles a script server-side from a workspace path**, under an import allowlist (`@enkaku/sdk` and `zod` only), with no filesystem resolution, bounded at 30 s / 20 MiB, and **never executed**. Both `script.publish` input forms end in the same publish function. | `packages/core/src/scripts/build.ts:1-31`, `:195-226`; `packages/core/src/capability/script.ts:63-96` |
| **F12** | `scripts.source` already exists **specifically so a human can read what a job actually ran**, and `(name, version)` is unique. | `packages/core/src/db/schema.ts:369-375`, `:393` |
| **F13** | Plan 56's selector machinery is already in `@enkaku/protocol`, pure and browser-safe: `proposeSelectors(root, node)` returns ranked `id → desc → text → point` candidates **with match counts**, computed by the same `matches()` the drivers use, so a proposal cannot disagree with what `find` will do. | `packages/protocol/src/selector-analysis.ts:1-108`; `packages/protocol/src/selector-match.ts:4-29` |
| **F14** | A full inspector dump costs **334–584 ms measured**, against ~80 ms for a `find`. This is the number that decides how a recorder may capture semantics. | `packages/sdk/src/types.ts:64-75` |
| **F15** | The device event log already sees `input.tap`/`input.swipe`/`input.gesture` — but timestamps at **second** granularity, stores **device pixels**, reduces a gesture to `samples: N` (the trace itself is dropped), and redacts `input.text` to `{ length, sha256Prefix }` by default. It is the right shape and the wrong resolution; it cannot be the recording source. | `packages/core/src/events/recorder.ts:64`; `packages/core/src/server/ws-handlers.ts:1160-1197`, `:1195`, `:94-103` |
| **F16** | A content-addressed image blob store exists (`sha256:<hex>` is the id), so identical step screenshots are stored once. | `packages/core/src/agent/blob/store.ts:32-57` |
| **F17** | The screen is already modelled as a set of **modes** (`'live' \| 'inspect'`) rather than tabs, established by plan 57 precisely so switching does not tear down the video and the WS. | `packages/studio/src/components/device/ScreenCard.tsx:9-40` |
| **F18** | `defineScript` validates and freezes and does nothing else — "all orchestration belongs to the core's runner, so a script published with an older SDK keeps working on a newer core". This is a constitutional constraint on where replay logic may live. | `packages/sdk/src/define-script.ts:6-19` |
| **F19** | `finish()` must be stateless and idempotent because the parent genuinely **re-runs it in a fresh child** after a timeout kill — `if (session && !outcome.finishRan) … runAttempt({ mode: 'finish-only', timeoutMs: FINISH_ONLY_TIMEOUT_MS, priorError })`. The new process shares no memory with the `run` that died. | `packages/session/src/runner/job-runner.ts:767-789`, `:44-48`; `packages/session/src/runner/ipc.ts:202-203`, `:211`; `packages/sdk/src/types.ts:295` |

### 0.2 Confirmed findings — the three input tiers disagree about timing

These three are grouped apart because they are one fact seen three ways: the
setting that §3.6 builds its whole composition rule on is not consistently read
today. They are numbered after the scheduling findings below because they were
found last, by the audit that §3.6 forced.

| # | Finding | Evidence |
|---|---------|----------|
| **F35** | **Manual control passes through no jitter layer at all.** There are three input tiers and only one is jittered: a script goes through `createDeviceExecutor` with the farm's settings; a capability/agent/MCP call goes through the same executor but with `timing` never wired, so it always gets `DEFAULT_TIMING`; and the manual WS path calls `session.input.*` directly, with no pause, no coordinate jitter, no `holdMs` and no `perCharMs`. A tap held for exactly the engine's own `DEFAULT_HOLD_MS` range is a coincidence, not a setting being honoured. | `packages/core/src/server/ws-handlers.ts:1126-1228`, `:1169`; `packages/drivers/src/input/scrcpy-input.ts:15`, `:25-29`; `packages/core/src/daemon.ts:1259-1274` (no `timing`) vs `:2087` |
| **F36** | **A device's own Timing settings are written and never read.** `DeviceSettingsSchema.timing` is rendered per device by the schema-driven form, but the only production read anywhere is `settingsStore.get().defaults.timing` — the **farm** default. Setting "Human-like touch" on one device today changes nothing. | `packages/protocol/src/settings.ts:286`; `packages/core/src/daemon.ts:2087` (the only read); `packages/session/src/device-executor.ts:115`; `packages/core/src/capability/context.ts:303` |
| **F37** | The synthesised gesture path carries a **fourth** jitter — `jitterPx`, hardcoded at 1 px on every non-endpoint sample — that is not in `TimingSettings` and not configurable. Harmless, but it means "the jitter settings" is not the whole list. | `packages/drivers/src/input/gesture.ts:74`, `:101-103` |

### 0.3 Confirmed findings — the scheduling side

| # | Finding | Evidence |
|---|---------|----------|
| **F20** | Batch members are **not** enqueued through `JobStore.enqueue`. `createBatch` writes the batch row and **every member job at once**, in one transaction, all `status: 'queued'`. There is no lazy or paced dispatch of any kind. | `packages/core/src/clusters/dispatch.ts:89`, `:169-185` |
| **F21** | There is **no `batch_members` table**; membership is `jobs.batchId` + `jobs.batchSeq`, indexed `(batchId, batchSeq)`. | `packages/core/src/db/schema.ts:229-231`, `:297` |
| **F22** | **`jobs` has no earliest-start column.** `expiresAt` is a deadline, not a delay. The claim predicate is `status='queued' AND d.status='idle'` plus the quiet-period exclusion and the batch-concurrency gate — nothing can hold a job back in time. | `packages/core/src/db/schema.ts:233`; `packages/core/src/queue/job-store.ts:287-309` |
| **F23** | `batches.concurrency` is enforced **only inside the claim SQL**, with an explicit instruction not to add a TypeScript pre-filter. `0` means unlimited. | `packages/core/src/queue/job-store.ts:257-260`, `:299-304`; `packages/core/src/db/schema.ts:347` |
| **F24** | The queue scheduler is event-driven with a **2 000 ms** fallback interval. A delay expressed only as a database timestamp would therefore be honoured within 2 s without any timer at all — enough for a minute-scale interval, far too coarse for a sub-second stagger. | `packages/core/src/config.ts:50-51`; `packages/core/src/queue/scheduler.ts:159` |
| **F25** | A job already has a "waiting, and here is why" broadcast — with exactly **one** reason: the quiet period. `onJobWaiting` carries `{ jobId, deviceId, waiting, heldBy, remainingSec }`. | `packages/core/src/queue/scheduler.ts:39`, `:103-118` |
| **F26** | **`POST /api/batches/:id/cancel` cancels queued members only**; running members are left to finish. There is no batch-level way to stop a job that has already started. | `packages/core/src/api/batches.ts:187-194`; `packages/core/src/queue/job-store.ts:397-405` |
| **F27** | One verb, three gates: batch cancel requires `job.run`; single-job cancel uses `canCancelJob` (`job.cancel.any` **or** device ownership); the agent capability requires `job.cancel.any` outright. | `packages/core/src/api/batches.ts:188`; `packages/core/src/api/jobs.ts:184-190`; `packages/core/src/auth/acl.ts:251-254`; `packages/core/src/capability/job.ts:107` |
| **F28** | Schedules **already randomise**: `pickJitterMs` draws in `[0, jitterSec]` per fire from `Math.random` and sleeps before dispatch. **The drawn value is never persisted, logged, or broadcast** — only the `dueAt`→`firedAt` delta on `schedule_runs` implies it. | `packages/core/src/schedules/runner.ts:121`, `:127-131`, `:189-190`, `:347-348`; `packages/core/src/db/schema.ts:604-606` |
| **F29** | The repo's *other* randomiser does the opposite and writes down why: the `order: 'random'` shuffle is drawn from `crypto.getRandomValues` and **baked into `jobs.batchSeq`**, so "nothing depends on a random number that no longer exists". This is the house rule F28 breaks. | `packages/core/src/clusters/dispatch.ts:54-71`; `packages/core/src/db/schema.ts:230` |
| **F30** | `rerun-failed` re-dispatches only `failed` members — not `expired`, not `cancelled` — and silently drops `priority` and `expiresAt`. | `packages/core/src/api/batches.ts:199-225` |
| **F31** | Batch and schedule targeting reaches devices by **cluster or explicit list only**. The resolver supports tags, but both dispatch call sites hard-code `tags: []`. | `packages/core/src/clusters/dispatch.ts:141`; `packages/core/src/schedules/runner.ts:289`; `packages/core/src/clusters/resolve.ts:33-71` |
| **F32** | `recomputeBatchStatus` is the **single writer** of `batches.status` and is already called on every member settle, expiry, rebind and cancel. It is the hook a pacer needs, and it already exists. | `packages/core/src/clusters/status.ts:70-91`; `packages/core/src/jobs/executor-host.ts:121`, `:181`; `packages/core/src/queue/expiry.ts:44`; `packages/core/src/daemon.ts:758-759` |
| **F33** | The run dialog already creates a batch for a cluster or a multi-device pick, and already renders a plain-language consequence sentence ("5 devices, one at a time, in random order — about 5× one run"). | `packages/studio/src/components/RunScriptDialog.tsx:49-58`, `:129-135`, `:267-274` |
| **F34** | Schedules already carry `concurrency`, `order`, `priority` and `queueTimeoutSec` straight through to `createBatch`, and `run-now` forces `jitterSec: 0` because "the operator asked for it now". Anything added to a batch's dispatch shape is inherited by schedules for the cost of one field. | `packages/core/src/schedules/runner.ts:211-224`; `packages/core/src/api/schedules.ts:541-544` |

### 0.4 Hypotheses (instrumented before they are asserted)

| # | Hypothesis | Why it fits | How §5 tests it |
|---|-----------|-------------|-----------------|
| **H1** | An **anchor dump** taken while the operator is between gestures resolves a usable, unique selector for the majority of tap steps on the apps this farm actually drives — and, critically, produces a *confidently wrong* one for a minority, because the anchor can be stale by the time the tap lands. | F14 makes a per-tap dump impossible (334–584 ms would distort the very timing being recorded); a dump during a human pause is free. But nothing in the tree can tell a stale anchor from a fresh one. | 94.3 records the candidate **and** the anchor's age, package name and step distance, and never uses it at replay time. 94.5's review panel reports "N of M steps have a unique candidate" per recording; §7.3 measures it on three real recordings before any promotion path is trusted. |
| **H2** | One job per repetition is affordable at the counts operators actually use, because the dominant cost is the job's own spawn-and-prepare overhead (spec §16: < 3 s), not the pacing. | A 30 s inter-repeat interval dwarfs a 3 s spawn; the alternative (one job looping internally) buys back that 3 s and pays for it with the whole retry, cancel and history model (§3.5). | §7.3 measures wall time for `count: 20`, `interval [0,0]`, against the same macro run once, and records the per-repetition overhead as a number. |
| **H3** | Replaying a recording with its **own** recorded gaps, and `betweenActionMs` suppressed, is at least as reliable as replaying it with `betweenActionMs` added on top — and materially faster. | The recorded gaps are a human's real pauses; adding a synthetic [300, 900] ms pause per step double-counts the same concern and, on a 30-step macro, adds ~18 s. | §7.3 runs the same recording 10× each way and compares success rate and total duration. If suppression is *worse*, §3.6's composition table is wrong and 94.2's `ScriptDefinition.timing` seam is what makes reverting it a one-line change. |
| **H4** | Force-stopping the packages a recording touched returns a device interrupted mid-macro to a state the next repetition can start from, for the great majority of recordings. | It is the same mechanism plan 35's declared reset already relies on, and the recorder can infer the package set from the anchors rather than asking the operator. | §7.4's stop drill cancels a paced batch mid-repetition on three devices and checks each one is at its launcher with the target app stopped. |

---

## 1. Goals

- **A human can record what they do on a device and replay it, unattended, across a fleet.** Record on the device page, review the steps beside the screenshot each one produced, name it, publish it — and from that moment it is an ordinary script that every existing surface already knows how to run, schedule, batch, version and audit.
- **A recording is a script, not a second kind of thing.** There is exactly one runnable artefact in this product, and this plan does not add a second. Versioning, `name@version`, `@latest`, job history, artifacts, retries, cancellation, ACL and the run form are inherited, not re-implemented.
- **A run can repeat, on a randomised interval, staggered across the fleet.** `count`, `interval [min,max]`, `deviceInterval` — the competitor's exact shape, expressed once, on the object that already means "one script across a device set", so schedules inherit it for the cost of one field.
- **Every randomised value is written down.** A run that took a random delay records the delay it actually took, on the row, in seconds you can read. This is the property F28 currently lacks and F29 already establishes as the house rule; this plan extends the rule and fixes the one place that breaks it.
- **Three timing layers, three owners, three homes, and no screen that conflates them.** Per-device input realism (exists), a recording's own pauses (new), and fleet phase (new) are separate concepts with separate settings, and the UI names them separately.
- **A repeating, staggered run is genuinely stoppable.** One button stops the whole thing: no further repetition is planned, every queued member is cancelled, every running member is aborted, and every device is left in a declared state — with one permission rule, not the three F27 currently has.
- **A recording's replay fidelity is stated, not implied.** What it reproduces faithfully, what it approximates, and what it will not attempt are written into the artefact's own review panel, not only into this document.

## 2. Non-goals

- **Not a device-side input recorder.** Capturing a finger on the glass means `getevent` over the streaming lane: raw evdev in device coordinates, per-touchscreen calibration, multi-touch slot tracking, and a per-device driver quirk budget. This plan records the *operator's* input as it passes through the core, which is what the competitor's mirror-window recorder does too. §3.3 has the full argument.
- **Not multi-touch, pinch or rotate.** The canvas sends one pointer (F3), and `InputGestureMessage` carries one sample array. Two-finger gestures need a protocol change and a second scrcpy pointer id; they are named here so their absence is a decision.
- **Not scroll-momentum equivalence.** A replay reproduces the recorded *path and its timing*; Android's own `VelocityTracker` then decides how far the list coasts, and it will not always land on the same row. §3.4 states this as a limit rather than pretending otherwise.
- **Not per-member parameters.** Panda's "batch text distribution" (one line of a list per device) would be `batch_member_params` — a real, separable feature. This plan does not build it, does not half-build it, and names the exact seam it would attach to (§9 Q3). 00-overview §1 forbids pulling it forward.
- **Not `.bat` equivalence.** Panda's "Task" runs either an on-device `.js` or a **host-side** `.bat`. Enkaku already has the first (a script *is* that, and better). It will not gain the second: running an arbitrary host process on an operator's behalf has no device, no lease, no deadline and no audit shape, and the CLI is already the answer to "run something on this host".
- **Not the focused control window's buttons** — plan 91. This plan states its interface to them in §3.9 and designs none of them.
- **Not the command console or bulk operations** — plan 93. Same: interface in §3.9, no design here.
- **Not the guest agent** — plan 90. The recorder needs nothing on the device that is not already there.
- **Not a change to the queue's per-device serialisation, the exec semaphore, or the streaming lane.** The stagger is a dispatch constraint layered above all three; §3.8 says exactly how they compose and that none of them is replaced.
- **Not tag-based batch targeting** (F31). It is adjacent, it is broken, and it is not this plan's.

## 3. Context and design decisions

### 3.1 The decision the rest of this plan hangs on: a recording compiles to a script

This is the single most consequential choice here, so it gets the full argument
rather than an assertion.

Enkaku already has a runnable artefact with a large, expensive, *finished*
support system around it: `scripts` rows with unique `(name, version)` (F12),
`name@version`/`@latest` resolution pinned at enqueue (plan 62), a job history
with artifacts and logs, retries with failure classification, cancellation with
descendants, an ACL, a parameter form generated from Zod, batches, schedules,
clusters, plugins, and an agent capability. A second artefact type — call it
`actions` — would need its own row, its own list screen, its own version story,
its own reference syntax, its own executor path, its own permission, its own
batch integration, its own schedule integration, its own cancel path, and its
own place in every one of those surfaces. It would then need all of that a
second time whenever any of those subsystems changed. That is not a one-time
cost; it is a permanent tax on every future plan in this repo.

Against that, the thing a recording actually *is* — an ordered list of device
calls with delays between them — is expressible in the script language today
with no new concepts at all. And the machinery to turn structured data into a
published script already exists and is already a hardened security boundary
(F11): the core takes a workspace path, walks its import graph, refuses any
bare specifier outside `@enkaku/sdk` and `zod`, bundles it with `Bun.build`
without ever executing it, and hands the result to the same `ctx.scripts.publish`
that `POST /api/scripts` calls.

**Decision: a recording is *source*, and a script is *build output*.** The repo
already models exactly this distinction — the workspace holds source, `scripts`
holds bundles — and the recording slots into the existing half of it:

```
record  →  /recordings/<slug>.recording.json      (workspace file, Zod-validated)
review  →  the same file, edited through a step panel or by hand
compile →  /recordings/<slug>.ts                  (generated, 3 lines, regenerated every time)
publish →  buildScriptFromWorkspace(…)  →  scripts row  →  everything downstream
```

The generated file is deliberately trivial, because F18 forbids putting
orchestration in the SDK's authoring layer and because a large generated file is
one nobody will read:

```ts
// GENERATED by Enkaku's recorder from /recordings/checkout.recording.json.
// Edits here are overwritten on the next compile — use "Detach" to take ownership.
import { defineRecording } from '@enkaku/sdk'
export default defineRecording({ /* the recording document, verbatim */ })
```

`defineRecording` is a *thin* wrapper: it validates the document, derives
`id`/`version`/`params`/`reset` from it, and returns an ordinary
`ScriptDefinition` whose `run` walks the steps. The interpreter lives in the SDK
so there is one implementation, unit-testable without a device, versioned with
the SDK exactly as `defineScript` is.

**No new table.** No `actions` row, no `action_runs`, no second reference
grammar. A recording's *identity* is its workspace path; a published recording's
identity is a `scripts` row like any other.

**The escape hatch is one button and it is one-way.** "Detach" copies the
generated file to `/scripts/<slug>.ts`, rewrites its body from
`defineRecording({…})` into a plain `defineScript({…})` with the steps expanded
as real SDK calls, and stops regenerating it. From that point it is an ordinary
script the operator owns, and the recording is no longer its source. This is the
honest version of "eject": the operator gets the full language, and nothing
pretends a round trip back into the step editor is possible.

**What this costs, stated plainly.** A recording's steps are a
`@enkaku/protocol` schema, so changing the step grammar is a schema change that
must keep parsing every recording already on disk. That is a real, permanent
obligation — but it is exactly the obligation `DeviceSettings` already carries
(`normaliseLegacyPrep`, `packages/protocol/src/settings.ts:106-112`), with the
same tool, and it is smaller than the obligation a second artefact type would
create.

### 3.2 Naming

The competitor calls the recorded artefact an **Action**. This plan calls it a
**Recording**, in code and in the UI, for one reason: "action" already means
something else on this product's own surfaces — the per-device action buttons on
the wall and the device card — and a farm operator reading "Actions" in the nav
would reasonably expect those. The verb stays **Record**; the Studio screen is
**Recordings**; the SDK export is `defineRecording`. The mapping to the
competitor's vocabulary is stated once, in the guide. Flagged for the owner in
§9 Q1, because it is a product-vocabulary call and not a technical one.

### 3.3 What a recording captures — and why it is not a finger on the glass

There are two places a gesture can be observed.

**On the device**, via `getevent`: this is where a *physical* finger lands. It
means a raw evdev byte stream on the streaming lane, in device-specific
coordinate space, with per-touchscreen `ABS_MT_*` axis ranges that must be read
from `getevent -p` and calibrated per model, multi-touch slot state to
reconstruct, and a pressure/touch-major channel that varies by vendor. It also
records nothing about *intent* — only that a contact moved. This is a different
project with a different risk profile, and building a bad version of it would be
worse than not having it.

**At the core**, where manual input already arrives: F2 and F3 say this stream is
already normalised 0..1, already carries a real sampled trace with millisecond
offsets, and already passes through exactly one function
(`ws-handlers.ts:1126-1210`) after the lease check and before the device call.
Every verb it carries maps one-to-one onto a driver verb the replay will use
(F6). And it is what the competitor's own recorder observes too — Panda is a
screen-mirroring product, and its "Record Action" watches the mirror window.

**Decision: the recorder tees the core's manual-input path.** No device-side
component, no new permission surface, no calibration. It is enabled while a
recording is open and does nothing otherwise.

**It lives in the core, not in the browser**, for four reasons: the core is
server-authoritative and Studio "only hides buttons"
(`packages/core/src/auth/acl.ts:5-6`); the anchor dumps (below) come from the
core's inspector and the client cannot cheaply get them; a tab reload must not
destroy a recording in progress; and a later plan that wants to record an
*agent's* input gets it for free from the same place.

**What a step carries:**

| Field | Source | Note |
|---|---|---|
| `kind` | the WS message type | `tap` \| `longPress` \| `gesture` \| `swipe` \| `key` \| `text` |
| normalised coordinates | the message itself (F2) | 0..1, so a different screen size replays without change |
| `gapMs` | wall clock since the previous step | the human's own pause; the authoritative timing |
| `holdMs` | pointer down→up (F4 — needs 94.2) | for `tap` and `longPress` |
| `samples` | `input.gesture`, verbatim (F3) | the real trace, not a synthesised curve |
| `screenshotBlobId` | a screencap taken after the step settles | content-addressed, so a static screen stores one blob (F16) |
| `candidate` | `proposeSelectors` against the anchor (F13) | **never used at replay time in v1** — see below |
| `anchor` | `{ ageMs, packageName, stepsSince }` | the honesty fields that let a human judge the candidate |

**Anchors, and the semantic-selector trade-off — stated honestly.** A dump costs
334–584 ms (F14). Taking one per tap would distort the very timing being
recorded and would make the mirror feel broken. Taking one *after* a tap races
the screen transition the tap caused, and would resolve the tap against the
*next* screen — which does not fail loudly; it produces a confident, wrong
selector, which is strictly worse than no selector at all.

So: **anchors, taken when they are free.** The recorder requests a dump when the
operator has been idle for `anchorQuietMs` (default 400 ms) and at most once
every `anchorMinIntervalMs` (default 1 500 ms). Steps are hit-tested against the
most recent anchor, and each candidate carries how stale that anchor was.

**And then v1 does not replay from it.** Replay is coordinate-based. The
candidate is displayed in the review panel next to the step's screenshot, with
its match count and its anchor age, and an operator may **promote** it to be the
step's target — one step at a time, deliberately, seeing what they are choosing.
This is not a hedge; it is the whole design:

- A recording that silently prefers a selector fails in a way nobody can
  reproduce, because the failure depends on a dump that no longer exists.
- A recording that replays coordinates fails in a way anyone can see: the
  screenshot in the review panel shows what was there, and the job's own
  screenshot shows what is there now.
- The upgrade path is real and cheap, and it is the operator's judgement — which
  is the only thing that can actually tell a stale anchor from a fresh one.

H1 measures how often a unique candidate is even available. If it is high, a
later plan can propose bulk promotion with evidence. If it is low, this plan
already told the truth.

### 3.4 Replay fidelity — what is in, what is out

**In, and faithful:**
- `tap` at a normalised point, with the recorded hold duration.
- `longPress` — a tap whose hold exceeded `longPressMs` (default 400 ms).
- `gesture` — the operator's own sampled path, played through `InputSink.gesture` sample-for-sample (F6). Curvature and velocity are the human's, not a synthesised Bézier.
- `swipe` — the two-point fallback `LiveView` already emits for a drag too fast to sample (`LiveView.tsx:336-344`).
- `key` — any keycode the manual path sends.
- `text` — the string, delivered through the device's own typing cadence.
- The gaps between steps, scaled by a per-run `speed` multiplier.

**In, but approximated, and labelled as such in the review panel:**
- **Scroll momentum.** The path and its timing are reproduced exactly; how far the list then coasts is Android's `VelocityTracker`'s decision, and a busy device will not always land on the same row. A recording that depends on landing on a specific row should end that step on a `waitFor`-shaped assertion, which today means detaching (§3.1) — named in §9 Q2.
- **Typing.** The recording stores the string, not per-keystroke timing (the manual path batches text before sending it, `LiveView.tsx:350-357`). Cadence comes from the device's `perCharMs`.

**Out, deliberately:**
- Multi-touch, pinch, rotate (§2).
- Anything the recording did not cause: a notification, an incoming call, an interstitial ad, a system permission dialog that appears on one device and not another. A recording is a sequence of inputs, not a state machine, and it has no way to branch. This is the honest boundary between a recording and a script, and it is why "Detach" exists.
- Clipboard, file pickers, and system UI that differs by OEM.

### 3.5 Repetition is N jobs, not one job with a loop

`count: 20` could mean one job that loops twenty times, or twenty jobs. The
second is right, and the reason is not performance:

- **Retry.** A script's `retries` re-runs the *attempt*. With a loop, a failure
  at repetition 7 retries repetitions 1–7 — for a recording that posts something,
  that is seven duplicate posts. With one job per repetition, a retry re-runs
  repetition 7 and nothing else.
- **`finish()` idempotency (F19).** A loop's `finish()` would have to be
  idempotent across an unknown number of completed repetitions. A single
  repetition's `finish()` only has to be idempotent across one, which is the
  contract that already exists and is already testable.
- **The device is free between repetitions.** A 20× run with a 5-minute interval
  is 100 minutes. A looping job holds the lease for all of it and blocks every
  other job on that device (spec §10.1: `busy` is exclusive). Twenty jobs release
  the device between repetitions, and the queue does what it was built to do.
- **History.** Twenty rows, each with its own artifacts, logs, duration, failure
  class and screenshots — versus one row whose log is a wall of text.
- **Cancel.** Aborting a loop mid-iteration leaves the device wherever it was and
  the job row says one thing. Cancelling a paced batch stops it *between*
  repetitions in the common case, which is the clean cut.

The cost is a spawn per repetition (spec §16 budgets < 3 s). H2 measures it.

**But not twenty rows at once.** F20 enqueues every member immediately. Twenty
future repetitions sitting `queued` on one device would (a) run back-to-back the
moment the device is idle, ignoring the interval entirely, and (b) starve every
other job on that device for the whole run. So:

**Decision: the batch enqueues repetition `k+1` for a device only after
repetition `k` settles**, with a freshly drawn delay, and the queue is what
enforces the delay.

### 3.6 The three timing layers, and how they compose

There are three, not two, and conflating any pair produces a bad product.

| Layer | What it is | Owner | Where it is configured |
|---|---|---|---|
| **1 — Input realism** | Hold duration, coordinate jitter, typing cadence, gesture shaping. Sub-second, *inside* one action. | the **device** | Device → Settings → *Human-like touch* (exists: `TimingSettingsSchema`, `packages/protocol/src/settings.ts:39-91`) |
| **2 — Pace** | The gaps between a recording's own steps, and the interval between whole repetitions. Seconds to minutes. | the **run** | The run form → *Repeat*; the recording's own `speed` |
| **3 — Phase** | Where each device sits in the cycle, so a fleet does not fire in unison. | the **fleet** | The run form → *Stagger* |

They are not the same knob at different scales and the UI must never suggest
they are: layer 1 lives on a device's settings page and applies to *everything*
that device does; layers 2 and 3 live on the run form and apply to *this run*.
No screen shows both.

**Layer 1 does not actually work per device today, and this plan cannot leave it
that way.** F36: the per-device *Human-like touch* form is rendered from
`DeviceSettingsSchema` and read by nothing — the single production read is the
**farm** default. F35 adds that the capability/agent path never receives timing
at all, and that manual control has no jitter layer whatsoever. That is three
tiers disagreeing about a setting whose whole purpose is to be consistent, and
this plan's composition table is meaningless on top of it: "merged over the
device's own settings" (§4.5) has to mean something. So 94.2 makes the device's
row the real source, falling back to the farm default, for the job path **and**
the capability path. This is not scope creep — it is the floor the rest of §3.6
stands on.

**One asymmetry the recorder creates, stated up front.** A recording captures
manual input, which is *not* jittered (F35). It replays as script input, which
*is*. So a replay is never a byte-identical reproduction of the recording
session even at `speed: 1` — the taps land within `coordJitterPx` of where the
human tapped and are held for a duration drawn from `tapJitterMs`. That is the
intended behaviour (it is what stops 200 repetitions being pixel-identical), but
it is a real difference between what was recorded and what runs, and the review
panel says so rather than leaving it to be discovered.

**Layer 1 and layer 2 do not simply add.** F8 is the trap: `betweenActionMs`
defaults to [300, 900] ms and fires before every device call, so a 30-step
recording replayed as-is gains ~18 s of pauses on top of the human's own. Worse,
those pauses exist to stop automation falling into an obvious pattern — and a
recorded human's gaps *already* are not a pattern. Applying both double-counts
one concern and distorts the recording.

**Decision: composition is per-field, and the table is the contract.**

| `timing` field | On a replayed recording |
|---|---|
| `betweenActionMs` | **superseded** — the recording's own `gapMs` replaces it |
| `tapJitterMs` | **applies**, as the spread around a step's recorded `holdMs` |
| `coordJitterPx` | **applies** — this is what stops 200 repetitions hitting one identical pixel |
| `perCharMs` | **applies** — the recording has no per-keystroke timing to supersede it |
| `profile` | `instant` still wins: it degrades a sampled path to a two-point swipe, and the review panel says so |
| `gestureCurvature`, `gestureSampleIntervalMs` | **unused** — the recorded path is real, not synthesised |

The mechanism is one new optional field, `ScriptDefinition.timing?:
Partial<TimingSettings>`, reported in the child's `ready` message exactly as
`reset` already is (F10, `ipc.ts:165-175`), and merged over the device's own
settings when the parent builds the executor. A generated recording sets
`{ betweenActionMs: [0, 0] }` and nothing else. This is a general, useful
capability — a script that must type into a field with an aggressive debounce
can now say so — and it makes H3 falsifiable with a one-line change.

### 3.7 Where the randomisation lives, and why it is written down

`count`, `interval [min,max]` and `deviceInterval` describe **one script across a
device set** — which is the definition of a batch (spec §12.3). They do not
belong on a job (a job is one execution), and they do not belong on a schedule
(a schedule is *when*, and F34 shows it already delegates *what* to a batch).

**Decision: pacing is a property of the batch, and only of the batch.** A
schedule inherits it by passing four fields through, exactly as it already
passes `concurrency` and `order` (F34). A single-device run with `count: 1` and
no stagger stays a plain `POST /api/jobs` and is untouched; the run dialog
creates a batch the moment `count > 1` or more than one device is targeted, so
there is exactly one paced dispatch path.

**Every draw is materialised on the row it governs.** F29 is the house rule and
this plan extends it rather than inventing a seeded PRNG:

- The stagger and the first interval are computed at batch creation and written
  to `jobs.notBefore`.
- Each subsequent interval is drawn when the previous repetition settles and
  written to that member's `jobs.notBefore` before it is visible to the queue.
- The drawn delay is *also* stored as `jobs.pacedDelayMs`, so an operator reading
  a job row sees "waited 4 min 12 s" without doing arithmetic against another
  column.

A seeded PRNG was considered and rejected: it lets you *re-derive* a number you
have already stored, which is strictly less useful than storing it, and it adds a
seed nobody can interpret. F29's own comment makes the argument better than this
paragraph does.

**And F28 gets fixed in the same pass.** `schedule_runs` gains `jitterMs`, the
value `pickJitterMs` already draws and currently throws away. A run that fired
90 seconds late must be able to say whether that was jitter or the farm being
busy. This is a two-line change and it is in scope precisely because this plan is
the one asserting the rule.

### 3.8 The stagger, the queue, and the three limiters that are not each other

`deviceInterval` is a **dispatch** constraint. It does not bound concurrency and
it does not replace anything:

- **The per-device queue** (spec §10.4) serialises within one device. A stagger is *across* devices and never touches it.
- **`batches.concurrency`** (F23) caps how many members run at once, in SQL. A stagger with no concurrency cap still runs everything, just phase-shifted.
- **The exec semaphore** (`adb.maxConcurrent`, spec §10.4) caps adb operations farm-wide and autoscales. A stagger reduces the burst that hits it; it does not raise its ceiling.

All three remain, all three are independent, and the plan says so in the settings
copy as well as here.

**The stagger is a phase offset applied once, at a device's first repetition** —
not re-applied per repetition. Re-applying it would fight the interval draw:
after repetition 1, devices are already de-phased, and independent per-device
draws keep them that way. When `intervalMin === intervalMax` (no randomisation at
all), the offsets alone hold the phase, which is exactly right.

**It is a floor, not a promise.** `notBefore` says "not before this instant"; the
queue still decides when the device is actually free. A batch dispatched onto
twenty busy devices will not honour a 3-second stagger, and the batch detail page
shows planned-versus-actual rather than pretending it did.

**Mechanically**, `jobs.notBefore` (unix seconds, nullable) is added and one
predicate joins the claim SQL (F22):

```sql
AND (j.not_before IS NULL OR j.not_before <= strftime('%s','now'))
```

F24 means a delayed job would already be picked up within 2 s of becoming
eligible with no timer at all — fine for a minute-scale interval, useless for a
500 ms stagger. So the pacer arms **one** dynamic `setTimeout` at the earliest
future `notBefore` and calls `scheduler.kick()`, the same single-global-timer
shape `schedules/runner.ts:507-520` already uses, with the 2 s fallback as the
safety net. Because `notBefore` is a column and the "is there a next repetition"
decision is derived from `jobs` rows, a core restart loses nothing but the timer,
which is rearmed at boot.

### 3.9 Stopping, and the ACL

"End Task" must mean *end*. Today it does not: F26 leaves running members alone,
and a paced batch would additionally keep planning new ones.

**Decision: `POST /api/batches/:id/stop`** — one verb that does all four things,
in this order:

1. Mark the batch `stopping`, which is what the pacer reads. **No further repetition is ever planned**, and this happens first so the window in which step 3 can be undone by step 4 does not exist.
2. Cancel every `queued` member (the existing `cancelQueuedInBatch`, F26).
3. Abort every `running` member through the existing `JobService.cancel` path — which aborts the executor, lets `finish()` run, and falls back to `finishExternally` when no executor is live.
4. Recompute the batch status once, at the end.

`POST /:id/cancel` is **replaced**, not kept beside it (00-overview §4.3):
"cancel some of it" was never a useful verb and its existence is why F26 reads
like a bug.

**One permission rule.** F27's three gates collapse: stop uses `canCancelJob`
**per member**, the same function `POST /api/jobs/:id/cancel` uses. An operator
stops the members they could have stopped individually; members on devices they
do not own are refused, counted, and reported in the response
(`{ cancelled, aborted, refused }`) rather than silently skipped. This is
strictly tighter than today, where `job.run` alone kills queued jobs on anyone's
devices.

**"Without leaving devices half-done", honestly.** A macro cut between step 12
and 13 leaves the app on step 12's screen. Nothing can undo that. What a
recording *can* express is the same cleanup a script already can, and the
recorder can infer it: the compiler emits `reset: { packages: [...] }` from the
anchors' `packageName` values, and a `finish()` that force-stops them when the
recording's `cleanup` is `'force-stop'` (the default). Force-stopping twice is a
no-op, so this is stateless and idempotent by construction — the F19 contract,
satisfied without the operator having to think about it. H4 measures whether it
is enough.

### 3.10 Interfaces to plans this one does not own

- **Plan 91 (the focused control window).** It owns the buttons. This plan owns two WS messages and one core state: `recording.start` / `recording.stop` / `recording.cancel` (client → core), `recording.state` / `recording.step` (core → client), and one active recording per device, held by the lease holder. Plan 91 may render a record button anywhere it likes; the state it reads is `recording.state`.
- **Plan 93 (the command console and bulk operations).** It owns "do this to N devices now". This plan owns "do this to N devices, `count` times, on a jittered clock". The seam is `POST /api/batches` with a `pacing` block: plan 93's bulk actions may create a batch with `pacing: null` and get today's behaviour exactly, or pass one and get pacing, with no second dispatcher.
- **Plan 90 (the guest agent).** No interface. The recorder needs nothing on-device that is not already there, and deliberately does not use the agent for input capture (§3.3).

---

## 4. Technical design

### 4.1 The recording document (`packages/protocol/src/recording.ts`, new)

```ts
/** A recorded step's target. v1 replays `point` ALWAYS; `selector` is only
 *  ever present because a human promoted a candidate (plan 94 §3.3). */
export const RecordingTargetSchema = z.union([
  z.object({ kind: z.literal('point'), pos: NormPointSchema }).strict(),
  z.object({ kind: z.literal('selector'), selector: SelectorSchema, fallback: NormPointSchema }).strict(),
])

/** What `proposeSelectors` offered for this step, and how much to trust it. */
export const RecordingCandidateSchema = z.object({
  selector: SelectorSchema,
  /** Matches in the anchor tree. 1 is the only promotable value. */
  count: z.number().int().nonnegative(),
  /** How stale the anchor was when this step landed. */
  anchorAgeMs: z.number().int().nonnegative(),
  /** Steps taken since the anchor — each one could have changed the screen. */
  anchorStepsSince: z.number().int().nonnegative(),
  anchorPackage: z.string(),
})

export const RecordingStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), gapMs: z.number().int().min(0), target: RecordingTargetSchema,
             holdMs: z.number().int().min(0).max(60_000).optional(),
             candidate: RecordingCandidateSchema.optional(), screenshotBlobId: z.string().optional() }),
  z.object({ kind: z.literal('longPress'), gapMs: …, target: RecordingTargetSchema, holdMs: z.number().int().min(200),
             candidate: …, screenshotBlobId: … }),
  z.object({ kind: z.literal('gesture'), gapMs: …, samples: z.array(NormGestureSampleSchema).min(2).max(300),
             screenshotBlobId: … }),
  z.object({ kind: z.literal('swipe'), gapMs: …, from: NormPointSchema, to: NormPointSchema,
             durationMs: z.number().int().min(50).max(10_000), screenshotBlobId: … }),
  z.object({ kind: z.literal('key'), gapMs: …, keycode: z.number().int().min(0).max(320) }),
  z.object({ kind: z.literal('text'), gapMs: …,
             /** A literal string, or `{ param: 'caption' }` — see §4.2. */
             value: z.union([z.string(), z.object({ param: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) })]) }),
])

export const RecordingDocSchema = z.object({
  schema: z.literal(1),
  name: z.string().min(1),                       // the script name it publishes as
  version: z.string().regex(SEMVER),
  description: z.string().default(''),
  recordedAt: z.number().int(),
  recordedOn: z.object({ stableId: z.string(), model: z.string(), width: z.number().int(), height: z.number().int() }),
  /** Multiplies every `gapMs` at replay. 1 = as recorded. */
  speed: z.number().min(0.1).max(10).default(1),
  /** Caps a single gap, so a recording with a 4-minute pause in it is usable. */
  maxGapMs: z.number().int().min(0).default(15_000),
  /** Force-stopping the packages below on finish; 'none' leaves the device as-is. */
  cleanup: z.enum(['force-stop', 'none']).default('force-stop'),
  /** Inferred from the anchors' packageName; also becomes ScriptDefinition.reset.packages. */
  packages: z.array(z.string()).default([]),
  steps: z.array(RecordingStepSchema).max(2_000),
})
export type RecordingDoc = z.infer<typeof RecordingDocSchema>
```

`recordedOn` is not decoration: it is what the review panel needs to say "this
was recorded on a 1080×2400 device" when the operator schedules it onto a
720×1600 one. Normalised coordinates survive the change; a fixed-pixel layout may
not, and the operator should be told rather than discovering it in a job log.

`name` becomes the published script's name, so it is validated against the
**existing** reference grammar rather than a new one:
`^[a-z0-9][a-z0-9._-]*$` (`packages/protocol/src/script-ref.ts:15-17`, which
reserves the single `/` for plugin members). A recording is not a plugin member,
so a slug containing `/` is refused at record time — where the operator can fix
it — rather than at publish time, where the error would name a grammar they have
never seen.

### 4.2 Parameters — the one place a recording is more than a replay

A `text` step may carry `{ param: 'caption' }` instead of a literal. The
compiler collects every distinct name and emits

```ts
params: z.object({ caption: z.string() })
```

so the run form, the batch form, the schedule form, the agent capability, and
`ctx.jobs.trigger()` all get a real parameter with zero extra work — every one
of them already renders `paramsSchema`. This is ~20 lines of codegen and it is
the difference between a macro that types one fixed string forever and one worth
scheduling. It is deliberately the *only* parameterisation in v1: no conditional
steps, no loops, no per-device values (§2, §9 Q3).

### 4.3 `defineRecording` (`packages/sdk/src/define-recording.ts`, new)

```ts
export function defineRecording(doc: RecordingDoc): ScriptDefinition<z.ZodTypeAny>
```

Validates `doc` through `RecordingDocSchema`, derives `id`/`version` from it,
builds `params` from the `{ param }` references (§4.2), sets
`reset: { packages: doc.packages }`, sets
`timing: { betweenActionMs: [0, 0] }` (§3.6), and returns a definition whose:

- `run(ctx)` walks `steps`, sleeping `min(step.gapMs * doc.speed, doc.maxGapMs)` before each, then dispatching one device call. `gesture` → `ctx.device.gesture(samples)`; `tap`/`longPress` → `ctx.device.tap(target, { holdMs })`; the rest map directly. Every step logs `step i/N: <kind>` at `debug` so a failed replay is readable.
- `finish(ctx)` force-stops `doc.packages` when `doc.cleanup === 'force-stop'`, and nothing else. Stateless and idempotent (F19).

No timeouts, no retries, no orchestration — F18.

### 4.4 SDK and driver verbs the replay needs (F6, F7)

```ts
// packages/sdk/src/types.ts — DeviceApi
/** Play a recorded pointer trace sample-for-sample (plan 94 §3.4). Normalised
 *  0..1; the core maps to device pixels, exactly as manual input already does.
 *  Rejects with E_GESTURE_UNSUPPORTED on an engine with no `gesture` (AdbInput). */
gesture(samples: NormGestureSample[]): Promise<void>

/** A tap held for `ms` (plan 94 §3.4). `tap` keeps its device-configured
 *  `tapJitterMs` range; this one names the duration and jitters around it. */
longPress(target: Selector, ms: number): Promise<void>
```

Both are new `DeviceCall` methods in `@enkaku/protocol` and new cases in
`device-executor.ts`, delegating to `InputSink.gesture` and
`InputSink.tap(p, { holdMs })` — which both already exist (F6). No driver
changes.

`InputTapMessage` gains `holdMs` so the *manual* path can produce a long-press at
all (F4):

```ts
export const InputTapMessage = z.object({
  type: z.literal('input.tap'),
  payload: z.object({ deviceId: z.string(), pos: NormPointSchema,
    /** Pointer down→up, measured on the client (plan 94 §4.4). Absent on an
     *  older client; the core then uses the device's own tapJitterMs range,
     *  which is what it does today for every manual tap (F5). */
    holdMs: z.number().int().min(0).max(60_000).optional() }),
})
```

and `ws-handlers.ts:1169` starts passing a range, closing F5 as a side effect.

### 4.5 `ScriptDefinition.timing` (F10)

```ts
// packages/sdk/src/types.ts — ScriptDefinition
/** Overrides the DEVICE's input-realism settings for this script's own calls
 *  (plan 94 §3.6). Merged over `DeviceSettings.timing`, never replacing it
 *  wholesale: a recording sets `betweenActionMs: [0,0]` because it supplies its
 *  own pauses, and inherits tap jitter, coordinate jitter and typing cadence. */
timing?: Partial<TimingSettings>
```

Carried in the child's `ready` message beside `reset` (`ipc.ts:165-175`).
`createDeviceExecutor`'s `timing` becomes a getter (`() => TimingSettings`) so
the value is read per call rather than captured at construction — the same
freshness concern `job-runner.ts:278-279` already documents for settings
changes.

### 4.6 The recorder (`packages/core/src/recording/`, new)

```ts
export interface RecordingSession {
  readonly deviceId: string
  readonly startedAt: number
  readonly stepCount: number
  /** Called from the input tee, after the lease check, before the device call. */
  observe(step: ObservedInput): void
  /** Stops, resolves candidates against the last anchor, returns the document. */
  finishAndBuild(): Promise<RecordingDoc>
  cancel(): void
}

export interface RecordingService {
  start(deviceId: string, actor: string): RecordingSession      // E_RECORDING_ACTIVE if one is open
  get(deviceId: string): RecordingSession | null
  stop(deviceId: string): Promise<RecordingDoc>
  cancel(deviceId: string): void
}
```

- **The tee** is one call in `ws-handlers.ts:1154-1210`, immediately after the existing `deps.recorder.record(...)` device-event call, so a rejected input is never recorded (the same reasoning already written at `ws-handlers.ts:1154-1158`).
- **Anchors.** A timer fires `anchorQuietMs` after the last observed input; it takes one `inspector.dump()` on the streaming lane and stores the tree plus a screencap blob. At most one per `anchorMinIntervalMs`. A dump failure is logged once and skips that anchor — a missing anchor means "no candidate", never a failed recording.
- **Candidates.** `hitTest(root, pos)` (new, next to `matchSelector`) returns the deepest node whose bounds contain the point; `proposeSelectors(root, node)` (F13) ranks them; the first with `count === 1` becomes `candidate`.
- **Bounds.** `recording.maxSteps` (default 500) and `recording.maxDurationSec` (default 900). Exceeding either **stops the recording and keeps it**, with a `warn` and a `recording.state` push saying why. Never a silent drop.
- **Lifetime.** In memory, keyed by deviceId, one at a time, owned by the lease holder; released when the lease is released. A core restart loses an in-progress recording — the same accepted simplification `queue/scheduler.ts:58-59` already makes for its own bookkeeping, and stated in the UI.

### 4.7 The compiler (`packages/core/src/recording/compile.ts`, new)

```ts
/** Emits the three-line generated entry from a recording document (§3.1).
 *  Deterministic: the same document always produces byte-identical output, so
 *  a "recompile" that changes nothing writes nothing. */
export function emitRecordingEntry(doc: RecordingDoc): string
```

Publishing is then the path that already exists (F11): write
`/recordings/<slug>.ts`, then `ctx.scripts.publish` via the `{ path }` form.
Nothing new is bundled, allowlisted, or executed.

**Detach** (`POST /api/recordings/:slug/detach`) emits a *different* file — a
full `defineScript` with the steps expanded as literal SDK calls — writes it to
`/scripts/<slug>.ts`, and deletes `/recordings/<slug>.ts` so nothing regenerates
over it. The `.recording.json` is kept, marked `detached`, and no longer
compiles.

### 4.8 Pacing (`packages/core/src/db/schema.ts`, `clusters/dispatch.ts`, `clusters/pacer.ts`)

```ts
// batches — new columns
repeatCount:        integer('repeat_count').notNull().default(1),      // 1 = today's behaviour
intervalMinMs:      integer('interval_min_ms').notNull().default(0),
intervalMaxMs:      integer('interval_max_ms').notNull().default(0),
deviceIntervalMs:   integer('device_interval_ms').notNull().default(0),
status:             /* unchanged, plus a new 'stopping' value */

// jobs — new columns
/** Unix seconds. The queue will not claim this job before it (plan 94 §3.8).
 *  Null = claimable now, which is every job written before this plan. */
notBefore:          integer('not_before'),
/** 0-based repetition index within the batch, for this device. */
batchRepeat:        integer('batch_repeat'),
/** The delay actually drawn for this repetition, materialised so it is
 *  readable without arithmetic (plan 94 §3.7, following dispatch.ts:54-59). */
pacedDelayMs:       integer('paced_delay_ms'),

// schedules — pass-through, mirroring concurrency/order (F34)
repeatCount, intervalMinMs, intervalMaxMs, deviceIntervalMs

// schedule_runs — closes F28
jitterMs:           integer('jitter_ms').notNull().default(0),
```

The claim gains one predicate (§3.8). `idx_jobs_claim` is left as is: it already
narrows on `(status, deviceId)` and the extra filter is evaluated on a handful
of rows.

```ts
export interface BatchPacer {
  /** Repetition 0 for every device, with the stagger baked into notBefore. */
  planFirst(batchId: string): void
  /** Called from recomputeBatchStatus (F32) when a member settles. */
  onMemberSettled(batchId: string, deviceId: string): void
  /** Arms one timer at the earliest future notBefore across all jobs. */
  rearm(): void
  stop(): void
}
```

`onMemberSettled` is the whole engine: if the batch is not `stopping`/terminal
and this device has completed fewer than `repeatCount` repetitions, draw
`delay ∈ [intervalMinMs, intervalMaxMs]` from `crypto.getRandomValues` (F29's
source, not `Math.random`), insert one job with
`notBefore = now + delay`, `batchRepeat = k+1`, `pacedDelayMs = delay`, then
`rearm()` and `scheduler.kick()`.

**Restart safety.** The decision is derived entirely from rows — `repeatCount`
against `COUNT(*) WHERE batch_id = ? AND device_id = ?` — so a boot-time sweep
over non-terminal batches re-plans anything the crash interrupted and rearms the
timer. No in-memory plan to lose.

### 4.9 Protocol and API surface

```ts
// ClientMessage
| { type: 'recording.start';  payload: { deviceId: string } }
| { type: 'recording.stop';   payload: { deviceId: string } }
| { type: 'recording.cancel'; payload: { deviceId: string } }

// ServerMessage
| { type: 'recording.state'; payload: { deviceId: string; active: boolean; stepCount: number;
      startedAt: number | null; stoppedReason?: 'max-steps' | 'max-duration' | 'lease-lost' } }
| { type: 'recording.step';  payload: { deviceId: string; index: number; kind: RecordingStepKind;
      hasCandidate: boolean } }

// job.waiting gains a reason (F25) — 'quiet' | 'paced', with `remainingSec`
// already meaning the right thing for both.
```

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/api/recordings` | `script.view` | lists `/recordings/*.recording.json` with step count, published version, detached flag |
| `GET` | `/api/recordings/:slug` | `script.view` | the document |
| `PATCH` | `/api/recordings/:slug` | `script.publish` | the reviewed document (trim, reorder, promote a candidate, parameterise a text step) |
| `DELETE` | `/api/recordings/:slug` | `script.publish` | |
| `POST` | `/api/recordings/:slug/publish` | `script.publish` | compiles and publishes; body `{ version }` |
| `POST` | `/api/recordings/:slug/detach` | `script.publish` | §4.7 |
| `POST` | `/api/batches` | `job.run` | **extended** with an optional `pacing` block |
| `POST` | `/api/batches/:id/stop` | per-member `canCancelJob` | **replaces** `/cancel` (§3.9) |

`pacing` on `POST /api/batches`:

```ts
pacing: z.object({
  count: z.number().int().min(1).max(1000).default(1),
  intervalMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([0, 0]),
  deviceIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
}).refine((p) => p.intervalMs[0] <= p.intervalMs[1], 'the interval range is inverted').optional()
```

Absent means today's behaviour exactly — one repetition, no delay, no stagger —
so every existing caller (plan 93's bulk actions included) is unaffected.

### 4.10 Studio

- **Record is a third mode of the screen card** (F17): `ScreenMode = 'live' | 'inspect' | 'record'`, not a tab, for the same reason plan 57 gave — a mode change must not tear down the video and the WS. In record mode the card keeps the live picture and gains a step strip along its edge, filling as steps arrive over `recording.step`.
- **`/recordings`** — the list, and `/recordings/detail?slug=…` — the review panel: each step as a row with its screenshot, its gap, its candidate (with match count and anchor age) and a **Promote** control that is disabled unless `count === 1`. Trim, reorder, delete a step, mark a text step as a parameter. Then **Publish as script**, which asks only for a version.
- **The run form** (F33) gains a **Repeat** section — count, interval min/max, stagger — and extends the existing consequence sentence rather than adding a second one:
  > *5 devices × 20 repeats, 3–8 min apart, started 30 s apart — about 2 h 10 m, finishing around 16:45.*
- **The repetition safety warning** (§9 Q4, decided 2026-08-12): a non-blocking
  warning below the consequence sentence when the estimated continuous duty per
  device — repetitions whose interval leaves no meaningful gap, summed — exceeds
  a threshold proposed at 30 min (provisional, see §9 Q4; the setting's home and
  field name are an implementation detail, not decided here). Targeting the
  whole fleet additionally requires typing the device count into a confirm
  field rather than a plain click, the same friction `ConfirmDialog` already
  reserves for an unrecoverable action.
- **Batch detail** gains a per-device repetition column (`7 / 20`), the next planned start, and the delay each completed repetition actually waited (`pacedDelayMs`) — which is what makes §3.7's promise visible rather than merely true.
- **Device → Settings → Human-like touch** gains one sentence pointing at the run form for repeat pacing, so the two layers are cross-referenced without being co-located (§3.6).

---

## 5. Implementation steps

### 94.1 — The recording document and the replay interpreter

- [x] `packages/protocol/src/recording.ts`: `RecordingStepSchema`, `RecordingTargetSchema`, `RecordingCandidateSchema`, `RecordingDocSchema` (§4.1); exported from `index.ts`.
- [x] `packages/protocol/src/selector-match.ts`: `hitTest(root, point)` — deepest node containing the point, preferring `clickable`. Pure, tested against a fixture tree.
- [x] `packages/sdk/src/define-recording.ts`: `defineRecording` (§4.3), exported from `packages/sdk/src/index.ts`.
- **Verifiable result:** a hand-written `RecordingDoc` fixture drives `defineRecording` and produces a `ScriptDefinition` whose `run` issues the expected `DeviceCall` sequence against a fake device, with the expected sleeps — with no device and no core.

### 94.2 — The verbs the replay needs

- [x] `packages/protocol/src/messages/input.ts`: `InputTapMessage.payload.holdMs` (§4.4). Landed on the shared `INPUT_ACTION_BODIES.tap` (not `InputTapMessage` alone) — it and `MirrorActionSchema`'s tap verb are the SAME schema (`packages/protocol/src/messages/input.ts`'s own header comment), and `LiveView.tsx`'s `sendInputAction` sends one or the other from one object literal, so `holdMs` had to type-check against both or neither. Unit-tested: `packages/protocol/src/messages/input.test.ts`.
- [x] `packages/studio/src/components/LiveView.tsx` (plan cited `:316-326`; the real lines were `:381-382` for the send, `:427-428` for the measurement — confirms the brief's own "every cited line number in this series has been stale"): sends the measured `elapsed` as `holdMs`; a press over the recorder's own `longPressMs` still sends `input.tap` — there is no separate long-press message, ever. Tested: `LiveView.test.tsx`.
- [x] `packages/core/src/server/ws-handlers.ts` (plan cited `:1169`; the real line was `:1453`): passes `{ holdMs: [exact,exact] }` when the message carries one, else a new optional `tapJitterMs` dep (falls back to `DEFAULT_TIMING.tapJitterMs` when unwired — see the Status line's note on why `daemon.ts` is not wiring it yet). Closes F5's DEFAULT case; the genuinely-per-device case is F36, still open. Tested: `ws-handlers-tap-hold.test.ts` (new).
- [x] `DeviceCall` gains `gesture`, `longPress`, `tapNorm`, `swipeNorm` — **not** `packages/protocol/src/device.ts` (that file is `DeviceInfo`/`DeviceConnection`/lease-holder shapes; it has never had anything to do with `DeviceCall`). The actual single source is `packages/protocol/src/capability/device-args.ts`'s `DEVICE_CALL_ARGS` (new: `GestureCallArgsSchema`, `LongPressArgsSchema`, `TapNormArgsSchema`, `SwipeNormArgsSchema`, with the coordinate-space rule as a doc comment), consumed by `packages/session/src/runner/ipc.ts`'s `DeviceCallSchema` (four new union members) — **neither file is in this step's stated file list**, but `device-executor.ts`'s new cases switch on `DeviceCall`, defined across exactly these two files; there was no way to do the assigned device-executor.ts work without them. Flagged per the brief's own instruction rather than silently expanded. Tested: `ipc.test.ts`.
- [x] `packages/sdk/src/types.ts`: `DeviceApi.gesture`, `DeviceApi.longPress` (§4.4) — **and**, resolving 94.1's finding 1, `DeviceApi.tapNorm`/`DeviceApi.swipeNorm`, with the full coordinate-space rule (device-pixel vs. normalised 0..1, and exactly why the distinction matters) written as a doc comment directly above `DeviceApi` itself, so — per this brief's own instruction — the next reader cannot miss it. `ScriptDefinition.timing` (§4.5) landed as specified. `define-recording.ts`'s local `RecordingDevice`/`RecordingScriptDefinition` workarounds are deleted; the interpreter now uses the canonical types with no cast.
- [x] `packages/session/src/device-executor.ts`: four new cases (not two — `tapNorm`/`swipeNorm` in addition to `gesture`/`longPress`), each mapping normalised → device pixels via a local `mapNormToDevice` (session cannot import core's copy — cross-package direction). `timing` is now `TimingSettings | (() => TimingSettings)`, resolved once per `execute()` CALL (not once per executor) via `resolveTiming()`; `jitterPoint`/`pause`/`runSwipe` all take `timing` as an explicit parameter rather than closing over a construction-time value. `gesture` rejects `E_GESTURE_UNSUPPORTED` on an engine with no `gesture` method, rather than silently degrading to a two-point swipe (F3's whole point). Tested: `device-executor.test.ts` (18 new tests, including two that mutate a `timing` getter's return value BETWEEN two calls on the SAME executor instance and assert the second call sees the change).
- [ ] **Not done — a different worker's territory per this pass's brief.** `packages/session/src/runner/ipc.ts`: `ready` carries `ScriptDefinition.timing`; `packages/session/src/runner/job-runner.ts:270-281`-ish merges it over the device's own settings (§4.5's full wiring). The field exists on the canonical type (finding 2, above) and survives `defineScript`'s spread, but nothing reads a SCRIPT's own `timing` override at the parent yet — only `defineRecording`'s own `{ betweenActionMs: [0,0] }` value, carried structurally, is exercised by any test today.
  - One companion fix WAS made, in a file also outside this step's list (`packages/session/src/runner/job-runner.ts`, one line): `...(deps.timing ? { timing: deps.timing() } : {})` → `...(deps.timing ? { timing: deps.timing } : {})` — passing the ACCESSOR to `createDeviceExecutor`, not its once-resolved return value. Without this, `device-executor.ts`'s new getter mechanism would still only ever be called once per attempt (an improvement already documented, but not "per call"), because `job-runner.ts` was the one caller resolving it eagerly. Verified by `job-runner.test.ts`'s existing "changing timing between two jobs..." test (still green, unchanged behaviour for that case) plus `device-executor.test.ts`'s new same-executor-two-calls tests.
- [ ] **Not done — outside this step's file list (`daemon.ts` not owned), and explicitly excluded from this worker's checklist.** "Make layer 1 real before building on it" (F36, F35): `packages/core/src/daemon.ts:2087` still resolves only `settingsStore.get().defaults.timing` (the farm default) for the job path, and the capability/agent path (`daemon.ts:1259-1274`-ish) still never receives `timing` at all. **Acceptance criterion 7 is not met.** `ws-handlers.ts`'s new `tapJitterMs` dep (this step) is the one piece of matching plumbing added on the manual-input side, deliberately optional with a farm-wide fallback, so wiring a real `(deviceId) => merge(farm, deviceRow.settings.timing)` into it later is additive, not a rework.
- **Verifiable result — split by what does and does not need a device:**
  - **Verified in software, this pass, no device:** `device.gesture(samples)` reaches `InputSink.gesture` unchanged (mapped, never re-curved — F3); `device.longPress` reaches `tap` with a `holdMs` range centred on the caller's `ms`; a script declaring `timing: { betweenActionMs: [0,0] }` suppresses `pause()` (existing `NATURAL_TIMING`/composition tests, unchanged, still green); a `timing` GETTER's value change reaches the very next call on an already-running executor (new tests, both `tapJitterMs` and `coordJitterPx`).
  - **Still needs a device, not run by this pass:** "a script calling `device.gesture(samples)` reproduces a recorded drag on a real device" (F3/F6/F7, acceptance criterion 5) and "setting `coordJitterPx: 40` on one device visibly moves that device's taps and no other's, from both a job and an agent call" (F35/F36, acceptance criterion 7 — additionally blocked on the still-open `daemon.ts` wiring above, so this half cannot pass yet regardless of hardware). See "94.2 hardware verification — pending, owner to run" immediately below.

**94.2 hardware verification — pending, owner to run.** No physical device was available to this worker; both checks below are real-device-only and are written out so the owner can run them verbatim.

*A. A real long-press on the manual (LiveView) path (F4, F5).*

1. `bun run dev` (or point at an already-running core) and `bun run dev:studio`.
2. Studio → a device → Control. Press and hold on the canvas for **~1200 ms**, release, without dragging.
3. Browser devtools → Network → WS frames (or a `console.log` patch in `ws.ts`'s `send`): confirm ONE `input.tap` frame whose `payload.holdMs` is close to 1200 — not absent, not a small number from the driver's own default range.
4. Confirm the DEVICE did something a ~40–120 ms tap would not: whatever the app under test treats as a long-press (a context menu, a drag handle, …). Note the app/element used and what happened.
5. `curl -s "localhost:7700/api/devices/<id>/events?stream=input&kind=input.tap" | jq '.items[0].meta'` — device-pixel `x`/`y` should be present (the device-event log still redacts/aggregates per F15; it does not carry `holdMs` yet — the WS frame in step 3 is the authoritative check for this step).

*B. A real drag through `device.gesture` — the sampled path, not a synthesised curve (F3, F6, F7). Bypasses the recorder on purpose (94.3, not built yet) to isolate the VERB.*

1. Publish this probe script (`ctx.device.gesture`/`ctx.device.longPress` directly):

   ```ts
   // /scripts/probe-gesture.ts
   import { defineScript } from '@enkaku/sdk'
   import { z } from 'zod'

   export default defineScript({
     id: 'probe-gesture',
     version: '1.0.0',
     params: z.object({}),
     async run(ctx) {
       // Irregular spacing on purpose — a real recorded trace looks like
       // this; a synthesised Bézier does not.
       await ctx.device.gesture([
         { x: 0.2, y: 0.8, atMs: 0 },
         { x: 0.35, y: 0.55, atMs: 40 },
         { x: 0.5, y: 0.2, atMs: 260 },
       ])
       await ctx.device.longPress({ point: { x: 500, y: 900 } }, 900)
     },
   })
   ```

   Publish via Studio's script upload, or `POST /api/scripts` with the workspace `{ path }` form (F11).
2. `curl -s -XPOST localhost:7700/api/jobs -d '{"script":"probe-gesture@1.0.0","deviceId":"<id>"}' | jq`.
3. Watch the device screen: the finger path should visibly bend through the middle point (not a straight start→end line), then hold at (500, 900) for ~900 ms before releasing.
4. `curl -s localhost:7700/api/jobs/<jobId> | jq '.status,.error'` — must be `success`. `E_GESTURE_UNSUPPORTED` means the active input engine cannot honour a curved trace at all (expected only on an `AdbInput`-only device — every scrcpy-capable device should succeed).

**Outcome table — fill in after running:**

| Check | Device / model | Result | Notes |
|---|---|---|---|
| A.3 — `input.tap` carries `holdMs` ≈ measured press duration | | | |
| A.4 — a ~1.2 s hold triggers the app's own long-press behaviour | | | |
| B.3 — the gesture path visibly curves through the middle point | | | |
| B.3 — the long-press holds ~900 ms | | | |
| B.4 — job status is `success`, not `E_GESTURE_UNSUPPORTED` | | | |

### 94.3 — The recorder

- [x] `packages/core/src/recording/service.ts`, `session.ts`, `anchors.ts` (§4.6). Tested: `anchors.test.ts` (10), `session.test.ts` (20), `service.test.ts` (13) — all with a fake clock/timer queue, no device.
- [x] `packages/core/src/server/ws-handlers.ts`: the tee, and the three `recording.*` client messages with the same `checkInputAllowed` gate input already uses. Tested: `ws-handlers-recording.test.ts` (8), including a dedicated test proving property 1 (the tee is byte-identical to `sink.tap`'s call args whether recording is off, wired-but-idle, or actively recording).
- [x] `packages/protocol/src/index.ts`: `recording.state`, `recording.step` (§4.9) — landed in `packages/protocol/src/messages/recording.ts` (new; also carries the three client→server messages, matching every other verb-family file's own client+server split, e.g. `messages/co-control.ts`), imported/appended into `ClientMessageSchema`/`ServerMessageSchema` and re-exported from `index.ts`'s own append-only block at the true end of the file.
- [x] `packages/protocol/src/settings.ts`: a `recording` block — `anchorQuietMs` (400), `anchorMinIntervalMs` (1500), `longPressMs` (400), `maxSteps` (500), `maxDurationSec` (900), `captureScreenshots` (true). Tested: `settings.test.ts`'s new `FarmSettingsSchema.recording` describe block (4 tests: defaults, independent overrides, the `longPressMs >= 200` floor matching `RecordingStepSchema.longPress.holdMs`, `maxSteps`/`maxDurationSec` never zero). `farmSections.ts` claims the key; `farmSections.test.ts`'s exhaustiveness assertion passes unchanged.
- [x] Screenshots and anchor images through the existing blob store (F16) — `createBlobStore`/`sniffImageMediaType`, no new blob kind or table.
- **Verifiable result — met, no device:** with a lease held, `recording.start` then thirty taps and two drags produces a `RecordingDoc` with thirty-two steps (`ws-handlers-recording.test.ts`'s own test is titled after this sentence), real `gapMs` values (asserted non-negative and, in `session.test.ts`, asserted to equal the exact fake-clock deltas), sampled gesture traces (asserted verbatim-equal to what was sent), and a candidate on the steps that landed on an identifiable node (`session.test.ts`'s anchor/candidate suite, using a hand-built `UiNode` fixture — F13's own `proposeSelectors` guarantees the count agrees with what `Inspector.find` would do). `recording.start` on a device that already has one open returns `E_RECORDING_ACTIVE` (both `service.test.ts` and the WS integration test assert this).
- **Two properties instrumented, not just asserted once:** property 1 (the tee never alters the input path) has its own dedicated test comparing `sink.tap`'s call arguments across three handler instances (recording dep absent / present-but-idle / actively recording) and asserting byte-for-byte equality. Property 3 (bounded, always) has four tests: `maxSteps` ends a recording at exactly the cap with a stated reason, `maxDurationSec` ends one on its own with NO further input at all (a real wall-clock watchdog, not just a check-on-next-input), a `recording.state` WS push carries `stoppedReason: 'max-steps'`, and hitting one bound never double-fires `onBound`.
- **Anchor cost at a realistic tap rate, per §"On the anchors" in this step's brief:** with the shipped defaults (`anchorQuietMs: 400`, `anchorMinIntervalMs: 1500`), an anchor is requested only after 400ms of no input AND at least 1500ms since the last one. An operator tapping at a brisk, sustained ~1 tap/second (1000ms gaps) never goes 400ms quiet between taps, so **zero anchors fire during continuous fast tapping** — exactly the "flooding" case the throttle exists to prevent. An operator who pauses to read the screen between groups of actions (a realistic recording session — tap, glance, tap, glance) gets roughly one anchor dump per pause, capped at one every 1.5s even if pauses are back-to-back; on a 30-step recording with, say, 10 natural pauses long enough to go quiet, that is **at most ~10 anchor dumps and ~10 screenshot blobs** (screenshots are separate, taken per-step when `captureScreenshots` is on, and dedupe by content hash when the screen has not changed — F16's own guarantee, exercised by `session.test.ts`'s "an identical screenshot across two steps dedupes to one blob row" test). The anchor tree itself is NOT stored as a blob (only its derived `candidate` selector and the `screenshotBlobId` are persisted on the step) — so the per-recording blob-store cost is bounded by step count with screenshots on (≤ `maxSteps`, deduped), and by pause count for anchors, independent of tap rate.

**94.3 hardware verification — pending, owner to run.** Everything above is proven with a fake input path and a fake clock, per this step's own instruction. What still needs a real device:

1. `bun run dev` and `bun run dev:studio`, with `daemon.ts` wired per this step's report (construct `createRecordingService` and pass it into `WsHandlerDeps.recording`, plus register the two WS pushes — see the report's verbatim lines).
2. Studio → a device → Control. Open the Inspect tab first (so an inspector is attached — 94.3 deliberately does not auto-attach one, see decision 3 above), then start a recording (94.4 has not built the button yet; until then, this can be driven by hand-sending `{"type":"recording.start","payload":{"deviceId":"<id>"}}` over the WS from devtools).
3. Tap an identifiable button (one with a resource id or unique text), pause ~1s, tap it again, pause, then do one real drag.
4. Confirm via `recording.get`/a debug log: the tap steps carry a `candidate` with `count: 1`, and the anchor's `anchorAgeMs` is a plausible small number (not stale by seconds).
5. Confirm a `screenshotBlobId` is present on each step and `GET /api/v1/blobs/<id>` (the existing agent blob route, F16) returns a real PNG.
6. Send `recording.stop`; confirm the resulting `RecordingDoc` (via `RecordingService.lastFinished`, logged) parses through `RecordingDocSchema` (it will — `finishAndBuild` already calls `.parse()` — this step just confirms it end-to-end against real captured bytes, not fixture bytes).
7. Leave a recording open and idle for `maxDurationSec` (temporarily set low, e.g. 10s, via farm settings) with no further input; confirm the `recording.state` broadcast arrives with `active: false, stoppedReason: 'max-duration'` on its own.

**Outcome table — fill in after running:**

| Check | Device / model | Result | Notes |
|---|---|---|---|
| 4 — a real tap on an identifiable button gets a `count: 1` candidate | | | |
| 5 — a real screenshot blob round-trips through `GET /api/v1/blobs/:id` as a valid PNG | | | |
| 6 — the stopped document parses and matches what was actually tapped | | | |
| 7 — `maxDurationSec` ends a silent recording on its own, broadcast confirms it | | | |

### 94.4 — Record mode in Studio

- [x] `packages/studio/src/components/device/ScreenCard.tsx`: `'record'` as a third mode (§4.10, F17) — `ScreenMode = 'live' | 'inspect' | 'record'`. `record` keeps the SAME `LiveView` the `live` mode shows (`videoVisible = mode === 'live' || mode === 'record'`); only `inspect` now swaps the picture. The mode buttons row gains a third button (`Circle` icon) with a small pulsing red dot rendered on it whenever a recording is active — visible even while a different mode is on screen, since the recording keeps running on the core regardless of which mode this tab happens to display.
- [x] `packages/studio/src/components/recording/useRecording.ts` (new): the client half of the `recording.start`/`.stop`/`.cancel` request/reply pair and the `recording.step`/`recording.state` pushes (§4.9). Called at `ScreenCard`'s own top level — never inside a child gated on `mode === 'record'` — so a step already captured, and the phase itself, survive a flip to `Live`/`Inspect` and back; this is what makes the video-never-restarts property and the state-never-lost property the SAME mechanism rather than two things to keep in sync. Distinguishes a PUSH from a reply by the same rule `WsClient.request()` already implements (a reply is matched by `id` and never reaches an `on()` handler), so an unsolicited `recording.state` reaching the hook's listener is always the recording ending on its own (a bound, or the lease going away) — never this tab's own `stop()`.
- [x] `packages/studio/src/components/recording/RecordPanel.tsx` (new): the step strip (`recording.step`'s `kind`/`hasCandidate`, rendered as an ordered list of chips, oldest first), the duration (ticking every second — `useNow`, owned by THIS component so the timer runs only while `mode === 'record'` is actually on screen, not on every device page view) and step counter, **Stop** and **Discard** while active, and the **Review** state (§4.10's own wording: "review panel") an operator lands on after either — with the stopped reason named honestly when the recording ended on its own (`max-steps` / `max-duration` / `lease-lost`). Deliberately does NOT navigate anywhere (94.5's `/recordings/detail?slug=…` does not exist yet, and even once it does, this in-mode review state is what proves "without the video ever restarting" — a route change would remount the page).
- [x] The "a core restart loses an unsaved recording" caveat stated in the panel, not only in this document — one sentence, shown in every phase (idle/active/reviewing), not only before starting: *"A recording lives only in this core's memory until it is saved — a core restart, or losing control of this device, discards anything not yet published."*
- [x] **The inspector-attachment gap (94.3 decision 3) — decided: surfaced, not left silent.** The idle state names it plainly: *"Element candidates and screenshots need the Inspect tab to have attached an inspector to this device first. A recording still captures every tap, swipe and key by coordinate without one."* This is a STATIC hint, not a live read of whether an inspector is actually attached right now — `InspectorPanel.tsx` (which owns that state) is outside this step's file list (`packages/studio/src/components/device/**`/`packages/studio/src/components/recording/**` only), and lifting its attach/ready state up to `ScreenCard` would mean editing a file this step does not own. In practice this gap is narrower than it sounds: `InspectorPanel` already auto-attaches whenever this tab holds the manual lease, REGARDLESS of which mode is on screen (`packages/studio/src/components/InspectorPanel.tsx`'s own `attach`/`canUse` effect, plan 59 §3.3 — mounted unconditionally by `ScreenCard` for any non-node-owned device) — so for an operator who has ever opened Control on this device while holding control, an inspector is already attached by the time they switch to `Record`, and the gap this note describes is the *rarer* case (control taken but the Inspect-owning effect has not yet resolved, or a node-owned device where Record itself is refused — see below).
- [x] **The lease-lost / bound-ended case — the operator never presses Stop.** `useRecording` reacts to the unsolicited `recording.state` push exactly as it reacts to its own `stop()` reply, transitioning to `reviewing` and naming the reason (`RecordPanel`'s `STOPPED_REASON_TEXT`): *"reached the maximum number of steps for one recording"* / *"reached the maximum recording duration"* / *"ended because control of this device was lost — released, taken over, or timed out."* Proven directly in `useRecording.test.ts` and `ScreenCard.test.tsx` (a test named for exactly this: "the recording ending on its own... still lands the operator on the review panel, naming why").
- [x] **Node-owned (cloud) devices** — `recording.start`'s own `E_NOT_SUPPORTED` refusal (`ws-handlers.ts`, step 94.3, outside this step's file list) is surfaced structurally rather than only as a caught WS error: `ScreenCard` gained a `recordDisabledReason?: string` prop (mirroring `inspectDisabledReason`), and `app/device/page.tsx` sets it to `'Recording is not available for cloud (node-owned) devices yet.'` when `device.nodeId` is set — the Record mode button is genuinely disabled, with a reason, rather than a live but doomed control.
- [x] `Start recording` inside the panel is separately disabled (its OWN reason, not the mode button's) while `!inputEnabled` — recording rides the same manual lease `input.*` uses (§3.3: "recording is a side-channel on the LEASE holder's own input, not an action an assisting human takes on someone else's behalf" — `ws-handlers.ts`'s own comment on why recording deliberately has no assist fallback), so a tab that is only assisting, or holds no lease at all, sees why it cannot start one.
- **Verifiable result — met, no device, proven in software:** `ScreenCard.test.tsx`'s new "record mode never restarts the video" describe block is the property proof the brief calls "the hard part" — it asserts the `LiveView` stub's DOM node is REFERENCE-EQUAL before and after switching `live → record → live` (React never unmounted/remounted it) and that `active` never drops to `false` anywhere in that sequence (the prop that actually controls whether `LiveView`'s own decoder/WS subscription tears down), contrasted with a second test showing `inspect` correctly DOES flip `active` to `false` (the one mode that swaps the picture). A separate integration-style test ("records, sees steps appear as they arrive, stops, and lands on the review panel") drives the exact sequence the plan's own verifiable result names, end to end through the mocked WS surface. 40 new tests total across `useRecording.test.ts` (9), `RecordPanel.test.tsx` (12) and the new `ScreenCard.test.tsx` describe blocks (19 in the file overall, up from 5).

**94.4 hardware verification — pending, owner to run.** Everything above is proven against a mocked WS surface, per this step's own instruction; nothing here has touched a real phone.

1. `bun run dev` and `bun run dev:studio`, with `daemon.ts` wired per 94.3's report (`recordingService` constructed and passed to `createWsMessageHandler`).
2. Studio → a device → Control. Take control, open the Inspect tab once (so an inspector is attached — the idle-state hint above), then switch to the **Record** mode button.
3. Click **Start recording**. Confirm the picture does NOT flash, reload, or drop a frame — the same continuous stream `Live` was already showing.
4. Tap two different buttons on the device, pause between them, then do one drag. Confirm each lands in the step strip within roughly a second, in order, and that at least one identifiable tap shows the "has a candidate" styling (a filled dot / highlighted chip).
5. Watch the duration counter tick and the step counter increment live.
6. Click **Discard** on a second, throwaway recording; confirm it returns to the idle "Start recording" state with no step strip left over.
7. Start again, record a few steps, click **Stop**; confirm the panel reads "Review", names the step count and duration, and the video is still the same live picture underneath (no restart, no black frame).
8. With a recording active, click **Release control** (or have a second operator take over). Confirm the panel reaches "Review" ON ITS OWN within a second or two, naming "control of this device was lost", with no Stop click from this tab.
9. Confirm the caveat sentence ("A recording lives only in this core's memory until it is saved…") is visible on screen at every point above — idle, active, and review — not just remembered from this document.

**Outcome table — fill in after running:**

| Check | Device / model | Result | Notes |
|---|---|---|---|
| 3 — no restart/reload/dropped frame when starting a recording | | | |
| 4 — steps appear in order, with candidate styling on an identifiable tap | | | |
| 6 — Discard returns cleanly to idle | | | |
| 7 — Stop lands on Review with the video untouched | | | |
| 8 — losing control ends the recording on its own, named honestly, no Stop click | | | |
| 9 — the core-restart caveat is visible at every phase | | | |

### 94.5 — Review, compile, publish, detach

- [x] `packages/core/src/recording/compile.ts`: `emitRecordingEntry` (§4.7), plus the detach emitter (`emitDetachedScript`). 19 tests, `compile.test.ts`.
- [x] `packages/core/src/api/recordings.ts`: the six routes (§4.9), mounted in `http.ts` (optional `recordingRoutes`, wired for real in `daemon.ts` this pass — `recordings-wiring.test.ts` proves it) — **plus one addition beyond the six, `POST /` (create), flagged in the file's own header and in this step's status note above**, since nothing in the six-route table can produce the FIRST `.recording.json`. 26 tests, `recordings.test.ts`.
- [x] `packages/studio/src/app/recordings/page.tsx` and `detail/page.tsx`: the review panel (§4.10) — screenshot per step, gap, candidate with match count and anchor age, Promote (disabled unless `count === 1`, with the reason in the disabled button's title), trim/reorder/delete, parameterise a text step, `speed`, `maxGapMs`, `cleanup`, and the recorded-device note. Plus the privacy line this step's brief required: a visible "stored verbatim" warning at every unparameterised `text` step, before publish. 35 new Studio tests across `RecordPanel.test.tsx`, `recordings/page.test.tsx`, `recordings/detail/page.test.tsx`.
- [x] Publishing goes through the same `buildScriptFromWorkspace` + `publishScript` pair `ctx.scripts.publish`'s `{ path }` form already uses — no new bundling (F11); `kind` is left at its default (`'script'`), never a new marker.
- **Verifiable result — met, no device:** publishing a reviewed recording produces a `scripts` row indistinguishable from a hand-written one (`recordings.test.ts`'s own test dynamically imports the published bundle and runs it as a real `ScriptDefinition`); it would appear in the scripts list and the run dialog would render its parameter form (both read the SAME `scripts` row/`groupScriptsByName`/`paramsSchema` path every other script already goes through — no new code was needed or written on those two surfaces, which is itself the proof of criterion 2), and `GET /api/scripts/:id` returns readable generated source (F12, asserted directly: the stored `source` column contains `import { defineRecording } from '@enkaku/sdk'` and the literal step JSON, not opaque bundle output).

**94.5 hardware verification — pending, owner to run.** Everything above is proven against a real SQLite `:memory:` db and a real `WorkspaceStore`/`Bun.build`, but with a hand-built `RecordingDoc` fixture, never one produced by an actual phone (94.3's and 94.4's own hardware notes are the prerequisite — a real recording has to exist first). What still needs a real device:

1. Complete 94.3's and 94.4's own hardware steps first: record a short macro (a few taps, one long-press, one drag, one typed string) on a real phone through Studio's Record mode.
2. Click **Stop**, reaching the Review state `RecordPanel` already showed pre-94.5; type a name and a version in the new "Save & review" form and click it. Confirm it lands on `/recordings/detail?slug=<name>` with no page-reload flash (a client-side `next/link` navigation).
3. On the review page: confirm the screenshot thumbnails are real PNGs (not placeholders) for every step that had an inspector attached; confirm at least one tap shows a candidate with `count: 1` and a small `anchorAgeMs`; click **Promote** on it and confirm the step's target line switches from "point (...)" to "selector {...}".
4. Confirm the typed-string step shows the "Stored verbatim" warning with the real text visible, type a parameter name, click **Parameterise**, and confirm the literal disappears from the page (still on disk until Save, per the panel's own local-edit model — Save, then re-fetch the page and confirm the literal is gone from `GET /api/recordings/:slug` too).
5. Click **Save changes**; confirm no error, and that reloading the page reflects the edits (trimmed step, promoted selector, parameterised text).
6. Click **Publish as script** with a version; confirm success, then open `/scripts`, find the new script by name, open it, and confirm `GET /api/scripts/:id`'s source is readable (visually — this is F12's whole point) rather than a minified bundle.
7. Open the run dialog for the new script from `/scripts`; confirm the `caption`-shaped parameter (or whatever was parameterised) renders as a real form field, and run it once on the SAME device it was recorded on. Confirm it replays the macro.
8. Run the SAME published script on a **different** device with a different screen resolution (acceptance criterion 1, inherited from 94.1 — this step is what finally makes it end-to-end testable); confirm the taps land on the equivalent on-screen positions rather than at the original device's pixel coordinates.
9. Back on the recording's review page, click **Detach**; confirm success, that a **Detach** button no longer shows (replaced by "Already detached"), and that `/scripts/<slug>.ts`'s content in the Workspace browser is a plain `defineScript` with literal `await` calls, not a `defineRecording({...})` blob. Publish the recording again (it should refuse) and confirm the message names the detached state rather than a generic error.

**Outcome table — fill in after running:**

| Check | Device / model | Result | Notes |
|---|---|---|---|
| 2 — Save & review lands on the detail page with no reload | | | |
| 3 — real screenshots, a `count: 1` candidate, Promote flips the target | | | |
| 4 — the verbatim-text warning shows the real string; Parameterise removes it | | | |
| 6 — the published script's `GET /api/scripts/:id` source is human-readable | | | |
| 7 — the run dialog renders the parameter form and the replay works on the recording's own device | | | |
| 8 — the SAME script replays correctly on a device with a DIFFERENT screen resolution | | | |
| 9 — Detach produces a plain script file, and a second publish is refused | | | |

### 94.6 — A job can be told to wait

- [x] `packages/core/src/db/schema.ts`: `jobs.notBefore`, `jobs.batchRepeat`, `jobs.pacedDelayMs` (§4.8); `bun run --cwd packages/core db:generate`.
- [x] `packages/core/src/queue/job-store.ts`: the one claim predicate (§3.8) — `AND (j.not_before IS NULL OR j.not_before <= strftime('%s','now'))`, inside the same `BEGIN IMMEDIATE` transaction as every other gate, never a TypeScript pre-filter.
- [x] `packages/core/src/queue/scheduler.ts`: `job.waiting` gains `reason: 'quiet' | 'paced'` (F25); a paced job reports its remaining seconds (`computePacedBlocked`, purely informational — pacing itself is enforced per-row in SQL, never by excluding a device from `claimNext`).
- **Verifiable result:** a job inserted with `notBefore = now + 5` is not claimed for 5 s on an idle device — proven in `job-store.test.ts` with a real SQLite `claimNext` (no sleep: the row's `notBefore` is moved back to simulate the clock, then re-claimed) — and the reason/remaining-seconds reach `onJobWaiting` (`scheduler.test.ts`), i.e. the wire. **Studio's "waiting — next repetition in 4 s" rendering is step 94.10's own surface, not built here.** With `notBefore` null, claim behaviour is byte-identical to today — exercised explicitly (not just implied by the future-date test), because SQL's `=` never matches `NULL = NULL`.
- **This step landed in two passes.** A first worker added the schema columns and migration, then stalled before touching `job-store.ts`/`scheduler.ts` at all — leaving four files failing typecheck on the widened `JobRow` (`clusters/dispatch.ts`, `clusters/dispatch.test.ts`, `jobs/executor-host.test.ts`, `jobs/executor-kind-dispatch.test.ts`, named in this worker's brief) plus five more the brief's own typecheck run had not surfaced yet (`packages/core/src/queue/job-store.ts` itself, `jobs/triggers.ts`, `jobs/executors/workflow-settings-wiring.test.ts`, `jobs/executors/workflow.test.ts`, `services/job-service.test.ts` — all hidden by `scripts/typecheck.sh`'s own `head -10` truncation of a failing package's log, not by anything specific to this step). A second worker (this pass) closed all nine, then did the actual claim predicate and scheduler wiring. `packages/core/src/api/jobs.ts:229`'s TS2739 is a pre-existing, unrelated failure (a duplicate schema from a second Claude session outside this workspace) and is untouched.

### 94.7 — The pacer

- [x] `packages/core/src/clusters/pacer.ts` (§4.8), with `crypto.getRandomValues` as the draw source (F29).
- [x] `packages/core/src/db/schema.ts`: the four `batches` pacing columns and the `stopping` status.
- [x] `packages/core/src/clusters/dispatch.ts`: `createBatch` accepts `pacing`, plans repetition 0 per device with the stagger in `notBefore`, and no longer enqueues repetitions it has not reached.
- [x] `packages/core/src/clusters/status.ts`: `recomputeBatchStatus` calls `pacer.onMemberSettled` (F32) — the one hook, not a second loop.
- [x] `packages/core/src/daemon.ts`: construct the pacer, boot-time re-plan sweep, `rearm()` on start.
- [x] `packages/core/src/api/batches.ts`: the `pacing` block (§4.9); `rowToBatchInfo` reports planned/completed repetitions per device.
- **Verifiable result:** a batch over 3 devices with `count: 4`, `intervalMs: [2000, 4000]`, `deviceIntervalMs: 1000` produces 12 jobs over time — never 12 at once — device *n* starts ~`n` seconds after device 0, every inter-repetition gap lands in [2, 4] s, and every job row carries the delay it actually waited. Killing the core mid-run and restarting it resumes the remaining repetitions. **Proven with a real SQLite `Db` (no device, no core process), a seeded `randomUint32` and a fake `clock` — never `Math.random()` and never a real sleep** — `packages/core/src/clusters/pacer.test.ts` (16 tests): `drawIntervalMs` always lands in `[min, max]` across a wide seeded sequence and returns `min` untouched (no draw at all) when `max <= min`; `planFirst` bakes a deterministic `i * deviceIntervalMs` stagger into repetition 0 across 3 devices (device 0 gets no stagger, device 2 gets exactly `2 * deviceIntervalMs`); `onMemberSettled` plans exactly one further repetition with a delay in `[intervalMinMs, intervalMaxMs]`, refuses once `repeatCount` is reached, refuses on a `'stopping'` batch (checked FIRST, per §3.9's own ordering argument) and on any terminal batch, and paces multiple devices independently; `replanAfterRestart` re-plans a device whose last repetition settled before a simulated crash and leaves a still-`queued`/`running` device alone. An unpaced batch (`count: 1`, every interval `0`) with a wired pacer is proven byte-identical to today's behaviour (`notBefore`/`batchRepeat` stay null), and so is a batch with NO pacer wired at all, even carrying a `pacing` block on the input.
- **Deliberately stopped one step short of the wire, named rather than left silent.** `batches.status` gains the `'stopping'` VALUE at the DB-column level (documented on the column itself in `db/schema.ts`, and `clusters/status.ts`'s `recomputeBatchStatus` already refuses to clobber it away early) — but nothing writes it yet (`POST /api/batches/:id/stop` is step 94.8's own item), and `@enkaku/protocol`'s `BatchStatusValue` is deliberately **not** widened to include it in this step. Widening the wire type one step early would have left every exhaustive `BatchStatusValue` switch in `packages/studio` (the batch-status badge maps on `/batches` and `/batches/detail`) non-exhaustive for a value the wire could never actually send yet — confirmed by trying it: `bash scripts/typecheck.sh` failed both Studio pages the moment the enum widened, even though nothing in `packages/studio/**` was touched. Reverted rather than fixed there, per this step's own file-scope boundary (`packages/studio/**` is a concurrent worker's for plan 97 step 97.6) — step 94.8 owns widening `BatchStatusValue` and Studio's status maps together, since it is also the step that adds the writer.
- **Wire honesty, proven rather than merely built.** `packages/protocol/src/messages/job.ts`'s `JobInfoSchema` gained `notBefore`/`batchRepeat`/`pacedDelayMs` (additive, all nullable, all default `null`) and `queue/job-store.ts`'s `rowToJobInfo` populates them straight from the row — so a paced job's state reaches `GET /api/jobs`, `GET /api/batches/:id` (`jobs` array) and the `job.status` broadcast, not only the DB. `packages/protocol/src/messages/batch.ts`'s `BatchInfoSchema` gained `pacing` (the batch's own config, `null` when unpaced) and `repeats` (per-device `{ deviceId, completed, planned }`, empty when unpaced), populated by `api/batches.ts`'s `rowToBatchInfo`. **Rendering any of this is Studio's own surface, step 94.10's — nothing in this step reads these fields on the client.** Said plainly per this repo's own repeated defect (an unwired field mistaken for a finished feature, 21 times in 3 days per this task's brief): the wire carries planned/completed repetitions and each repetition's actual delay; nothing yet shows them on a screen.
- **`onBatchChanged`'s signature widened** (`(batchId: string, deviceId?: string) => void`, up from `(batchId: string) => void`) across `jobs/executor-host.ts`, `queue/expiry.ts` and `daemon.ts`'s own forward-ref — `deviceId` is passed ONLY from a genuine terminal settle (`executor-host.ts`'s `settle()`, and `expiry.ts`'s queue-timeout sweep — an expired repetition never ran but is still settled from the pacer's point of view, so a device that cannot be reached does not permanently stall the rest of its schedule) and deliberately omitted from `requeueForRebind` (going back to `queued`, not completing a repetition) and from `services/job-service.ts`'s queued-cancel branch (same reasoning — a job-service `cancel()` of a `running` job needs no separate wiring at all, since `executor-host.ts`'s own `settle()` already fires with the deviceId on that path).

### 94.8 — Stop means stop

- [x] `packages/core/src/api/batches.ts`: `POST /:id/stop` replacing `/cancel` (§3.9), gated per member by `canCancelJob` (F27), returning `{ cancelled, aborted, refused, refusedDeviceIds }`.
- [x] `packages/core/src/services/job-service.ts`: reused for the running members — no second abort path. **Untouched, deliberately**: `stopBatch` (new, `api/batches.ts`) takes a `Pick<JobService, 'cancel'>` and calls it per member; `JobService.cancel()`'s own status-branching (queued → `cancelQueued`, running → `host.abort`/`finishExternally` fallback) is the ONLY abort logic that runs — the file needed no edit to be "reused."
- [x] `packages/core/src/schedules/runner.ts:177-186` (now ~183-211): `onOverlap: 'cancel-previous'` calls the same `stopBatch` (imported from `api/batches.ts`) with `actor: null` (no interactive caller at cron time, the same reasoning `assertDeviceAllowedFor` already states for this call site) instead of `cancelQueuedInBatch` alone — closing the exact gap named in this step's own brief: a paced batch's still-`running` member, and the pacer planning behind it, are now stopped too.
- [x] `packages/studio`: **Stop** on batch detail (`packages/studio/src/app/batches/detail/page.tsx`) and on the schedule's last run (`packages/studio/src/app/schedules/detail/page.tsx`, a new "Last run" card driven by `schedule.lastBatchId`), both using the shared `ConfirmDialog` with a description naming what happens to queued/running members and — only when the batch is paced — that no further repetition is planned. `POST /:id/cancel`/`BatchCancelResponseSchema` are gone from both files; `BatchStopResponseSchema` (`{ cancelled, aborted, refused, refusedDeviceIds }`) is the one response shape both dialogs read, and both report a non-zero `refused` in the success toast rather than only the happy-path counts.
- **`BatchStatusValue` widened together with the Studio maps, per 94.7's own deliberate stop-short.** `packages/protocol/src/messages/batch.ts`'s `BatchStatusSchema` now includes `'stopping'`; `packages/core/src/api/batches.ts`'s `rowToBatchInfo` reports it honestly (a new `statusOf` helper mirrors `clusters/status.ts`'s own "held until every member is terminal" rule, via a newly-exported `TERMINAL_BATCH_STATUSES`, rather than redefining that rule a second time) — before this, `rowToBatchInfo` always called `computeBatchStatus(counts)` directly, which can never produce `'stopping'`, so a page load mid-stop would have misreported `running`/`queued`. Both of Studio's exhaustive `Record<BatchInfo['status'], string>` badge maps (`packages/studio/src/app/batches/page.tsx`, `.../batches/detail/page.tsx`) gained a `stopping` row (the same warn tone `cancelled` uses — "still doing something, headed toward warn"), and `/batches`' own running-first sort ranks `stopping` alongside `running`.
- **`'batch.cancel'` renamed to `'batch.stop'`** in `packages/core/src/auth/audit.ts`'s `AuditAction` union — required by the typechecker the moment the route's audit call changed action names; not a second value sitting beside the old one, matching `/cancel` itself being replaced rather than kept.
- **Two small wiring additions in `packages/core/src/daemon.ts`**, named rather than silently expanded past this step's own file list (the pattern step 94.7 already set for the pacer): `createBatchRoutes({...})` now also receives `jobService` (the SAME instance already built for `createJobRoutes`, constructed earlier in the same function scope — no second one), and `createScheduleRunner({...})` receives the same `jobService` for `onOverlap: 'cancel-previous'`. Both are additive fields on deps interfaces this step already owns (`BatchRoutesDeps.jobService`, `ScheduleRunnerDeps.jobService`), both optional (a test harness or an unwired host degrades to "every affected member is refused" — honest about doing zero work, never a false `cancelled`/`aborted` — rather than a crash), so `daemon.ts` needed only two one-line additions to reach a boot that actually works, not a rewrite.
- **Proven, not just built**: `packages/core/src/api/batches.test.ts` (5 new tests) — queued cancelled + running aborted with the exact `{cancelled, aborted, refused, refusedDeviceIds}` shape; a device the operator does not own is refused, counted and named while the rest still stop (F27); an admin (`job.cancel.any`) is refused nothing; no `jobService` wired refuses every member rather than silently doing nothing; and the criterion-12 case itself — a paced batch stopped mid-flight, then a settle for the just-aborted member arrives (`pacer.onMemberSettled` called directly, simulating the worst-case interleaving named in this step's own brief), asserted to plan **zero** further repetitions. `packages/core/src/schedules/runner.test.ts`'s existing `cancel-previous` test now asserts the previous batch ends in a real terminal status (never left `queued`/`running`), not only that its one queued job was cancelled — closing the exact hole (a running member left going) this step's own brief named as broken. `packages/core/src/clusters/pacer.test.ts` already proved (step 94.7) that a `'stopping'` batch plans nothing from `onMemberSettled`, checked first; this step adds the API-level proof that `POST /:id/stop` is what actually gets a batch INTO that state. Studio: 8 new tests across `batches/page.test.tsx`, `batches/detail/page.test.tsx` (Stop button → dialog naming consequences → `POST /:id/stop`; a paced batch's dialog names "no further repetition"; a `stopping`/terminal batch shows no Stop control) and `schedules/detail/page.test.tsx` (the "Last run" card, its own Stop dialog and confirm flow, and its absence with no `lastBatchId` or a finished run).
- **Hardware verification — pending, owner to run.** Nothing in this step's own automated proof drives a real phone; the verifiable result's "every device at its launcher with the recording's declared packages force-stopped" is 94.5/§3.9's `finish()`/`cleanup: 'force-stop'` contract (already unit-tested there), exercised end-to-end only by an actual `POST /:id/stop` against running jobs on real hardware. Steps to run, and an outcome table to fill in:
  1. `bun run dev`, enroll (or use) at least 3 real devices in one cluster.
  2. Publish (or reuse) a recording/script that opens an app, per 94.5/7.2's own smoke test.
  3. `curl -s -XPOST localhost:7700/api/batches -d '{"scriptId":"…","target":{"clusterId":"…"},"pacing":{"count":4,"intervalMs":[2000,4000],"deviceIntervalMs":1000}}' | jq` — confirm jobs start staggered, not all at once.
  4. While at least one device is mid-run (app open, job `running`) and at least one repetition is still queued, `curl -s -XPOST localhost:7700/api/batches/<id>/stop | jq` — record the response.
  5. Watch each device: confirm the running one's app closes (or the script's own `finish()` completes) within a few seconds, no new job starts on any device afterward, and `GET /api/batches/<id>` settles to a terminal status (never stays `stopping`).
  6. Repeat step 4 as a user without ACL rights to one of the devices (a non-admin operator, that device unowned by them — or, simpler, temporarily assign the device to a different user) and confirm `refused` names it while the rest still stop.

  | Check | Device / model | Result | Notes |
  |---|---|---|---|
  | 3 — staggered start, not simultaneous | | | |
  | 4/5 — stop response shape, and every device reaches its launcher within a few seconds | | | |
  | 5 — no further repetition starts on any device after the stop | | | |
  | 5 — `GET /api/batches/<id>` reaches a terminal status, never stuck `stopping` | | | |
  | 6 — a device the caller does not own is refused and named, the rest still stop | | | |
- **Verifiable result:** stopping a 20-device paced batch mid-flight leaves zero queued members, zero running members, zero further repetitions planned, and every device at its launcher with the recording's declared packages stopped. An operator without rights to three of the devices gets `refused: 3` and the other seventeen stop. **Software half proven** (queued/running counts, refusal-by-count, the pacer planning nothing further, the wire/Studio honesty about `'stopping'`) — the hardware half ("every device at its launcher") is the pending table above.

### 94.9 — Schedules inherit it, and write down what they drew — **DONE**

- [x] `packages/core/src/db/schema.ts`: the four pacing columns on `schedules`; `schedule_runs.jitterMs` (F28).
- [x] `packages/core/src/api/schedules.ts`: the fields in `ScheduleBody`, `SchedulePatchBody` and `rowToScheduleInfo`.
- [x] `packages/core/src/schedules/runner.ts:211-224`: pass `pacing` into `createBatch`, exactly as `concurrency`/`order`/`priority` already are (F34).
- [x] `packages/core/src/schedules/runner.ts:248-260`: persist `jitterMs` on the run row; `packages/protocol/src/messages/schedule.ts`: it appears in `ScheduleRunInfo`.
- **Verifiable result:** a schedule with `count: 5` fires and produces a paced batch; its run row says "fired 47 s after due — 47 s of jitter", and a run that was late for any *other* reason says `jitterMs: 0` and is therefore distinguishable.

**Closed.** `packages/core/src/db/schema.ts` gained five columns via migration `0056_complete_liz_osborn.sql` (generated by `bun run --cwd packages/core db:generate`, never hand-written — verified by inspecting the generated SQL before applying it): `schedules.repeatCount`/`.intervalMinMs`/`.intervalMaxMs`/`.deviceIntervalMs` (mirroring `batches`' own pacing columns from step 94.7 exactly, `NOT NULL DEFAULT` matching), and `schedule_runs.jitterMs` (`NOT NULL DEFAULT 0`, **milliseconds** — the one column on that table not expressed in seconds, called out in its own doc comment so it is never mistaken for `dueAt`/`firedAt`'s unit). The two pre-existing hand-built `ScheduleRow` literals in the workspace (`packages/core/src/schedules/runner.test.ts`'s `seedSchedule`, `packages/core/src/jobs/scheduled-batch-version-gate.test.ts`'s `seedSchedule`) were updated in the same change — the widened-type hazard this step's own brief called out.

`packages/core/src/api/schedules.ts`: `ScheduleBody` gained `repeatCount`/`intervalMinMs`/`intervalMaxMs`/`deviceIntervalMs` (defaults `1`/`0`/`0`/`0` — unpaced), inherited by `SchedulePatchBody` via `.partial()`; a new `assertPacingValid` helper (mirroring `POST /api/batches`'s own `pacing.refine`) rejects an inverted interval range on both `POST /` and `PATCH /:id` — the PATCH path merges the patched value against the EXISTING row's own min/max before checking, so patching only one side of the range still catches an inversion, tested directly. `rowToScheduleInfo` and `rowToScheduleRunInfo` both echo the new fields back.

`packages/core/src/schedules/runner.ts`'s `fireOnce` passes `pacing: { count: schedule.repeatCount, intervalMs: [schedule.intervalMinMs, schedule.intervalMaxMs], deviceIntervalMs: schedule.deviceIntervalMs }` into `createBatch` unconditionally, right alongside `concurrency`/`order`/`priority` — no second path, no conditional branch for "is this schedule paced," exactly F34's instruction: `createBatch` itself is what makes an unpaced schedule (the default) a no-op, the same way it already does for a hand-started batch with no `pacing` block.

**F28, closed on both firing branches, not just the one the checklist named.** `jitterMs` is hoisted to a `let` at the top of both `fireOnce` (the script branch) and `fireAgentOnce` (the agent branch) — F28's own evidence cites line ranges in both — defaulting to `0` and set from `pickJitterMs`'s actual return value only on the path that reaches the draw; a `skipped-overlap` fire (which never draws) records `jitterMs: 0` right alongside `dueAt`/`firedAt`, which is the property F28 exists to prove: "a run that fired late must be able to say whether that was jitter or the farm being busy" — zero is unambiguous, not merely absent. `packages/protocol/src/messages/schedule.ts`'s `ScheduleRunInfoSchema` gained `jitterMs: z.number().int().default(0)`, defaulted so no pre-existing fixture literal needed editing.

**Proved with a seeded random source and a fake clock, per the plan's own hardware-honesty rule — no device or core needed for this step.** `packages/core/src/schedules/runner.test.ts` gained two new `describe` blocks: one asserting the exact drawn `jitterMs` lands on the row for a `random: () => 0.5` draw (`floor(0.5 * (10*1000+1)) = 5000`), that an unjittered schedule records `0`, and that a `skipped-overlap` fire never reaches the draw at all; a second asserting a schedule's `repeatCount`/interval/`deviceIntervalMs` land on the resulting batch's own columns unchanged, and that the default (unpaced) shape produces `repeatCount: 1`/every interval `0` on the batch. `packages/core/src/api/schedules.test.ts` gained a matching `describe` for the REST surface: POST round-trips pacing (and defaults to unpaced), an inverted range is refused with `400` on both POST and PATCH (including the merged-with-existing-row case), and PATCH updates pacing independently of every other field.

**Hardware honesty — pending, owner to run.** Everything above is proved in software with no device; the plan's own claim ("a real jittered schedule firing across a farm needs phones") is not closed by this step and is recorded here rather than silently assumed:

| # | Step | Expected | Actual | Pass? |
|---|---|---|---|---|
| 1 | Create a schedule targeting a real cluster of ≥3 devices, `cron: '* * * * *'`, `jitterSec: 20`, `repeatCount: 3`, `intervalMs: [5000, 15000]`, `deviceIntervalMs: 2000`. Let it fire once. | A batch appears with all 3 devices staggered ~2 s apart at their first repetition. | | |
| 2 | `GET /api/schedules/:id/runs` right after the fire. | The run row's `jitterMs` is a nonzero value ≤ 20000, and `firedAt - dueAt` (in ms) equals it exactly. | | |
| 3 | Watch each device run its 3 repetitions to completion. | Each device's 2nd/3rd repetitions start with a delay inside `[5000, 15000]` ms of the previous one settling — `jobs.pacedDelayMs` on each new row matches the observed gap. | | |
| 4 | Restart the core mid-flight (kill `-9` between repetitions 1 and 2 on at least one device). | On restart, the pacer's boot-time sweep re-arms and the remaining repetitions still complete — no device silently stalls at 1/3. | | |
| 5 | Repeat the whole run with `jitterSec: 0` and no `pacing` block at all. | Every `schedule_runs` row for it shows `jitterMs: 0`; the resulting batch is indistinguishable from a batch dispatched before this plan existed. | | |

### 94.10 — Pacing in the run form, the schedule form, and batch detail — **DONE**

- [x] `packages/studio/src/components/RunScriptDialog.tsx`: a **Repeat** section and the extended consequence sentence (§4.10, F33), including the estimated finish time.
- [x] The estimated-continuous-duty warning and the typed-device-count
      confirmation for a fleet-wide run (§9 Q4, decided 2026-08-12 — the
      shape is decided, the proposed 30-minute threshold and its settings home
      are provisional pending §7.3's numbers).
- [x] `packages/studio/src/components/ScheduleEditorDialog.tsx`: the same section, with an explicit note that the schedule's own `jitterSec` shifts *the whole run*, while the interval shifts *each repetition* — two different knobs on one screen, so the copy must separate them.
- [x] `packages/studio/src/app/batches/detail/page.tsx`: repetition progress per device, next planned start, actual delays.
- [x] The device Settings timing panel's cross-reference sentence (§3.6).
- **Verifiable result:** an operator who has never read this document can tell, from the run form alone, that "pause between actions" and "interval between repeats" are different things.

**Closed.** This step's whole brief was "everything reaches the wire and nothing renders it" (steps 94.6–94.8's own words) — this pass is the render.

**`packages/studio/src/components/RunScriptDialog.tsx`.** A new `RepeatSection` (count, interval min/max in seconds, a device stagger) is available for every target, including a **single device**: §3.6's own decision — "the run dialog creates a batch the moment `count > 1` or more than one device is targeted" — means a lone device with a real repeat draft ALSO has to become a batch, so `useBatch = target !== 'single' || pacingActive` now gates `POST /api/jobs` vs. `POST /api/batches` (previously keyed on `target === 'single'` alone), and the batch body's `target` becomes `{ deviceIds: [deviceId] }` for that case. The section's own opening line is the comprehension-test copy itself: *"How many times this run repeats, and how long to wait between whole repetitions — separate from the pause BETWEEN ACTIONS inside one run, which lives on the device itself (Device → Settings → Human-like touch)."* — it names the OTHER knob's real location, not merely "a different thing." `ConsequenceNote` gained an optional `repeat` prop; a real draft extends the existing sentence with one more clause ending in the finish estimate: *"5 devices, one at a time, in random order × 20 repeats, 3–8 min apart, started 30 s apart — about 2 h 10 m, finishing around 16:45."* `RunScriptDialog.test.tsx` gained a `describe` block (10 tests) proving: the comprehension copy is present and findable by text (not a tooltip); leaving Repeat at its default reproduces the plain sentence byte-for-byte; an unpaced batch sends no `pacing` key at all (criterion 16's Studio half); `repeatCount > 1` sends the exact `{ count, intervalMs: [min,max], deviceIntervalMs }` shape §4.9 specifies; a single device with `repeatCount > 1` posts to `/api/batches` with `target: { deviceIds: [...] }`, not `/api/jobs`; an inverted interval disables Run; and the fleet-wide typed confirmation (below) gates Run.

**The finish-time estimate is built from the same three numbers the pacer draws from, not a re-derivation** — `estimateFinishSec` takes the exact `RepeatDraft` (`count`, `intervalMinSec`, `intervalMaxSec`, `deviceIntervalSec`) that also becomes the POST body's `pacing` block: the AVERAGE interval times `count - 1` gaps on one device, plus `(deviceCount - 1) * deviceIntervalSec` for the stagger span (§3.8: "applied once, at a device's first repetition"). It cannot know a repetition's own run time (unknowable for a plain script — only a workflow declares node timeouts), which the code comment states explicitly rather than silently ignoring; the estimate is a floor, exactly the honesty §3.8 already gives the stagger itself.

**The continuous-duty warning (§9 Q4) uses the WORST case, not the average**, deliberately: `worstCaseDutySec` checks whether the drawn interval's own MINIMUM clears a "meaningful rest" floor (`REPEAT_GAP_FLOOR_SEC = 60`, provisional) — an operator's midpoint can look restful while some drawn gaps still land at the minimum, and a safety warning should not be fooled by an optimistic average. Above `REPEAT_DUTY_WARNING_SEC = 30 * 60` (the plan's own proposed 30-minute figure, provisional per §9 Q4 and named as such in the UI copy itself: *"this threshold is a provisional starting point, not a hard limit"*), a non-blocking amber note appears under the Repeat section — never a farm setting, per this step's own instruction not to invent one.

**The typed-device-count confirmation is for a fleet-wide run only** (criterion from this step's own brief, item 3): `fleetWide = (target === 'cluster' || target === 'devices') && targetCount > 0 && targetCount >= usable.length` — a partial multi-device pick shows no confirmation at all (proven directly: `RunScriptDialog.test.tsx`'s "a partial (non-fleet-wide) pick shows no typed confirmation"), and `Run batch` stays disabled until the operator types the exact device count into a field, mirroring `ConfirmDialog`'s own friction for an unrecoverable action rather than a dialog that can be clicked through on reflex.

**`packages/studio/src/components/ScheduleEditorDialog.tsx`.** Landed in two passes within this step, named rather than smoothed over: this worker's first pass found step 94.9 (the schedule-level `repeatCount`/`intervalMinMs`/`intervalMaxMs`/`deviceIntervalMs` wire fields) still unstarted, and — per this step's own "reaches nowhere" caution, read the other way round — declined to build a working-looking Repeat section that would have silently dropped every value the operator typed (`ScheduleBody` had no such keys yet, so a non-`.strict()` `.parse()` would have stripped them). A disabled, honestly-labelled placeholder shipped instead, with the distinguishing Jitter-vs-interval copy attached to the (already-functional) Jitter field. **94.9 shipped, by a concurrent worker, before this step finished** (its own checklist entry above is now marked DONE) — this worker's SECOND pass, on rediscovering that, replaced the disabled placeholder with a real, functional Repeat section: `repeatCount`/`intervalMinSec`/`intervalMaxSec`/`deviceIntervalSec` state, hydrated from an existing schedule's own `repeatCount`/`intervalMinMs`/`intervalMaxMs`/`deviceIntervalMs` (`?? ` defaults for a fixture or cached row predating 94.9), included in the POST/PATCH body in milliseconds, and gated by the same inverted-interval check the core's own `assertPacingValid` enforces. The two-knob distinction lives in two places now: the Repeat section's own opening line (identical wording to the run form's, for one shared vocabulary), and the required sentence attached to Jitter — *"This shifts the WHOLE firing's own start time, once — it is not the interval between a repeating run's own repetitions (below), which is a different knob entirely."* `ScheduleEditorDialog.test.tsx` gained 4 new tests: the two-knob copy is present; an existing schedule's pacing hydrates correctly in seconds; an inverted interval blocks Save; and setting repetitions sends the exact `{ repeatCount, intervalMinMs, intervalMaxMs, deviceIntervalMs }` shape on the PATCH body.

**`packages/studio/src/app/batches/detail/page.tsx`.** A new "repeat pacing" aside (shown only when `batch.pacing !== null`) reports the batch's own config (`repeatCount`/interval/stagger, formatted with the SAME "say the unit once" rule the run form uses — `3–8 min`, never `3 min–8 min` — so the same numbers read identically on both screens) and, per device from `batch.repeats` (`{ deviceId, completed, planned }`, §4.9's own wire addition), a `completed/planned` line plus — since `BatchDeviceRepeatSchema` carries no next-start field itself (noted explicitly in that schema's own doc comment as this step's problem to solve) — a next-planned-start derived from the already-loaded `jobs` array: the earliest-`notBefore` queued job for that device, preferring a LIVE `job.waiting` push over the static `notBefore` read when one has arrived. `JobsList.tsx` gained an opt-in `pacing` column (`columns.pacing`, off by default — every existing caller, the plain Jobs page and a device's Jobs tab, is unaffected) rendering `rep N`, `waited Xm Ys` for a settled repetition's own `pacedDelayMs`, and `starts in ~Ns` for a queued one — plus a new `waiting` prop so a live `job.waiting` push renders as *"waiting — next repetition in 4s"* rather than the static fallback, closing F25's own complaint ("a job already has a waiting broadcast... reason 'quiet'/'paced'... rendering was yours"). `page.tsx`'s own `job.waiting` WS handling was new (the file never had any before this step) — membership is checked against a ref-mirrored set of the batch's own loaded job ids, since `job.waiting` carries no `batchId`. `packages/studio/src/app/jobs/detail/page.tsx`'s PRE-EXISTING `job.waiting` handling (plan 71 §3.7) dropped `reason` at the point it was captured into state — fixed in the same pass (the type gained `reason: 'quiet' | 'paced'`, the WS handler now reads it, and the rendered line switches between *"Waiting for the device to be free"* and *"Waiting for the next repetition"* accordingly) since it is the SAME wire field this step's brief named as unrendered, on the one other screen that already had a waiting UI to fix. 3 new tests in `batches/detail/page.test.tsx` (an unpaced batch shows no aside; a paced one shows its config and per-device progress; a live `job.waiting` push with `reason: 'paced'` renders on the row — the latter required mocking `@/lib/ws` at module level, since a real `WsClient` needs an actual socket to fire a listener, following the exact pattern `app/console/page.test.tsx` already established) and 4 new tests in `JobsList.test.tsx` (off by default; a settled repetition's delay; a queued repetition's static countdown; a live push beating the static fallback).

**The device Settings timing panel's cross-reference sentence (§3.6).** `packages/studio/src/app/device/page.tsx`'s Settings tab wraps the `timing` section's `SchemaForm` (matching the existing precedent the `video` section already set with `DeviceVideoFields`) with one sentence, shown only on that section: *"This is how THIS device performs one action... and it applies to everything this device runs. Repeat pacing... is a property of the RUN, not the device — set it in the run form's Repeat section instead."* No screen shows both device timing and run pacing settings at once (§3.6's own rule), so this is a pointer, never a duplication.

**One honest finding, per this step's own instruction to say so if the two knobs still read alike.** They do not, by direct test (`RunScriptDialog.test.tsx`'s "the section names the pause-between-actions setting as a DIFFERENT knob, living on the device" asserts the exact sentence is findable by text) — but the distinction is carried entirely by PROSE, in three different places (the run form, the schedule form, the device settings page) that must stay in sync by hand. Nothing in the schema or the type system enforces that these three sentences keep telling the same story if one of them is edited later; a future worker who rewords one without grepping for the other two would not be caught by any test in this pass. Flagged rather than fixed, since building that guard (e.g. a shared constant string, or a lint rule) was not asked for and would be a real design decision about how much this repo wants prose to be DRY versus locally readable in context.

**Not built in this pass, named rather than left silent.** The estimated finish time and the continuous-duty warning are Studio-only arithmetic — nothing on the wire states them, so a device the operator cannot see (a lease taken over mid-run, a job that fails and skips its own gap) is not reflected in the estimate; it is a plan, not a promise, exactly as the code comments say. `packages/studio/src/app/schedules/detail/page.tsx` does not show a schedule's own pacing summary (only the editor dialog does) — out of this step's own file list (`§4.10` names the run form, the schedule FORM, and batch detail; the schedule detail PAGE is a fourth surface this step's brief never asked for) and flagged here rather than silently added.

**Hardware honesty — pending, owner to run.** Everything above is proven against a mocked WS/HTTP surface, no device, no core, per this step's own instruction. What still needs a real farm:

1. `bun run dev` and `bun run dev:studio`, at least 3 real devices in one cluster.
2. Open the run dialog on a published script/recording, pick the cluster, set `Repetitions: 4`, `Interval: 5–10 (s)`, `Stagger: 3 (s)`. Confirm the consequence sentence's finish-time estimate reads as a plausible clock time a few minutes out, and click **Run batch**.
3. Open the resulting batch's detail page. Confirm the "repeat pacing" aside shows `4` repetitions, `5 s–10 s` interval, `3 s` stagger, and each device's `completed/planned` ticks up as repetitions settle.
4. Watch a device between repetitions: confirm its job row (or the aside's per-device line) shows a live "next repetition in Ns" countdown that actually reaches zero and starts the next job — not a number that freezes or drifts.
5. Repeat step 2 targeting every device currently online — confirm the typed device-count confirmation appears and blocks Run until the exact count is typed.
6. Create a schedule with a real repeat draft (`Repetitions: 3`, a real interval), let it fire once, and confirm the resulting batch's own pacing matches what was configured in the schedule editor — not the default.

| Check | Device / model | Result | Notes |
|---|---|---|---|
| 2 — the finish-time estimate reads as a plausible clock time | | | |
| 3 — the aside's config and per-device progress match the real run | | | |
| 4 — a live "next repetition in Ns" countdown reaches zero and the next job actually starts | | | |
| 5 — the fleet-wide typed confirmation appears and gates Run | | | |
| 6 — a schedule's own repeat draft reaches the batch it creates | | | |

### 94.11 — Fix what this plan is standing on — **DONE**

- [x] `packages/core/src/api/batches.ts:199-225`: `rerun-failed` carries `priority`, `expiresAt` **and** the pacing block forward, and includes `expired` members (F30). A paced batch re-run by hand currently loses its whole shape.
- [x] Boot-time sweep for orphaned paced batches (a batch left `queued`/`running` with no live jobs after a crash) — logged, re-planned or closed, never silently stalled.
- **Verifiable result:** re-running the failed members of a paced, prioritised, queue-timed batch produces a batch with the same pacing, priority and timeout.

**Closed.** Both traps this step warned about (a) and the fix itself are one function, not two: `packages/core/src/api/batches.ts` gained `failedOrExpiredDeviceIds(jobRows)` (deduplicated, `'failed' | 'expired'` — F30's own "includes expired members") and `carryForwardShape(row, jobRows, now)`, and BOTH `POST /:id/rerun-failed` and `POST /:id/rerun?only=failed` (the sibling this step's brief named by name — trap (a), "the single dominant defect class of this entire session") call the same two functions; `?only=skipped` also goes through `carryForwardShape` for the same reasoning (a skipped-device retarget is exactly as much "the same run, over a subset of devices" as a failed-device rerun). Neither route builds its own copy of any of this.

- **`priority`** carries forward unchanged, read off the original batch's own job rows (`batches` itself has no `priority` column — only `jobs.priority`, written uniformly per batch by `createBatch`).
- **`expiresAt` (trap b) is NOT copied verbatim.** It is an absolute unix-seconds instant, and an original batch's own deadline has almost certainly already passed by rerun time — copying it would make every rerun job expire on arrival, a rerun that reports `201` while dispatching work that can never run. What carries forward is the original queue timeout's own DURATION (`original expiresAt − the original batch's own createdAt`), re-applied from the rerun's own `now`. Tested explicitly for the already-expired case (`batches.test.ts`, "an already-expired original queue timeout does NOT make the rerun expire instantly").
- **Pacing carries forward as the original batch's own FULL shape** (`count`/`intervalMs`/`deviceIntervalMs`), applied to the rerun's own (failed-or-expired-device, deduplicated) target — trap (d)'s decision, made explicitly and documented in `carryForwardShape`'s own doc comment: "redo this device's whole run" was chosen over "resume however many repetitions it still owed", because a single device can fail on repetition 2, succeed on repetition 3, and fail again on repetition 4 — "how many repetitions are still owed" has no single well-defined answer for that device, while "redo the whole thing" always does. Tested directly (`batches.test.ts`, "reruns the FAILED DEVICES with the full original repeat count, not 'however many repetitions were owed'").
- **The stagger restarts from now (trap c), for free** — no code in `carryForwardShape` touches a stagger origin at all; `createBatch` calls `deps.pacer.planFirst(batchId)` at the moment IT runs (already wired into both rerun routes, which already pass `deps.pacer` through), keyed off the pacer's own clock, never the original batch's `createdAt`.
- **The boot sweep.** `packages/core/src/clusters/pacer.ts`'s `replanAfterRestart` already covered "a device settled and the next repetition was never planned" (step 94.7) — this step closes the other half: a batch whose LAST device's LAST repetition already settled before a crash landed between that settle and `clusters/status.ts`'s `recomputeBatchStatus` actually running, leaving `batches.status` cached at `queued`/`running` with zero live jobs, invisible to every other sweep in the codebase because its own status claims it is already done. `replanAfterRestart` now takes optional `jobStore`/`broadcast`/`log` (the same graceful-degradation shape every other accessor in this codebase has — omitted, the re-plan still runs, only the reconciliation is skipped) and calls `recomputeBatchStatus` once per batch AFTER the per-device re-plan loop, with no `settledDeviceId` (that argument is `onMemberSettled`'s own hook, already invoked directly above in the same loop — passing it again here would plan the same next repetition twice). A defensive branch also closes a paced batch with literally zero job rows (should not happen — `createBatch` inserts the batch row and its members together — but logged and marked `failed` rather than left orphaned forever if it ever does). A batch left `'stopping'` by an operator is never selected by this sweep's own query at all (`nonTerminal` only reads `queued`/`running`) — never resurrected, never touched. `packages/core/src/daemon.ts`'s boot call site now wires `jobStore`, `broadcast: (msg) => hub.broadcast(msg)`, and `log: log.child('pacer')` into `replanAfterRestart`. 8 new tests: `clusters/pacer.test.ts` (6 — closes to `success`, closes to `failed` on one failure, skipped when unwired, `stopping` untouched, zero-job-rows defensive close, still-mid-flight is re-planned not closed) and `api/batches.test.ts` (5 — priority/pacing/expiresAt carried on `rerun-failed`, the already-expired case, the full-repeat-count-not-remaining-repetitions case, `?only=failed` matching `rerun-failed`'s own shape, and an unpaced batch reruns unpaced with no regression).

### 94.12 — Documentation and the spec — **DONE**

- [x] `packages/sdk/README.md`: a new "Recordings, and the three layers of timing" section — `defineRecording`, `device.gesture`, `device.longPress`, the normalised-vs-device-pixel coordinate rule (`tapNorm`/`swipeNorm`/`gesture`), `ScriptDefinition.timing`, and §3.6's three-layer timing table plus its per-field composition table, both reproduced verbatim.
- [x] `packages/core/README.md`: a new "The action recorder, and runs that repeat on a jittered, staggered clock" section — the tee/anchors/bounds/blob-store reuse, the `text`-step privacy note, the compiler and its REST surface, the pacer (`notBefore`/`batchRepeat`/`pacedDelayMs`, `crypto.getRandomValues`, restart-safety, stop-means-stop, schedule pass-through and the jitter-vs-interval distinction), and a table of the new `recording` settings block.
- [x] `docs/guide/record-and-replay.md` (new): record, review, promote a selector (disabled unless the candidate is a unique match), parameterise a text step (with the "stored verbatim regardless of `logInputText`" privacy exposure stated in plain words, not softened), publish, run it 20× across a cluster on a jittered, staggered clock, stop it — and a dedicated "What a recording will not replay faithfully" section (§3.4: scroll momentum, typing cadence, and what is not attempted at all) placed in front of the user, not only in this plan.
- [x] `docs/spec.md`: §13 gained the `recording.*` message family and `job.waiting`'s `reason` (`'quiet' | 'paced'`) — neither was previously named on the wire-protocol list at all. §12.3 and §19 were found, on inspection, **already correct and already complete** for this plan's own scope — plan 98's documentation pass (step 98.9) had already added the `/recordings` screen and its REST surface to §19/§11.8, and a later, unidentified pass had already folded batches' pacing, `notBefore`/`batchRepeat`/`pacedDelayMs`, `POST /:id/stop`, and the schedule pass-through (including the jitter-vs-interval distinction) into §12.3 — re-verified line by line against `packages/core/src/clusters/pacer.ts`, `dispatch.ts`, `schedules/runner.ts` and found accurate, not re-written. Also carried five corrections relayed from plan 93 step 93.12 (that step's own worker could not touch this file), each independently re-verified against the tree before being applied — see this step's own report for the detail; none of the five were plan 94's own claims.
- [x] `docs/plans/00-overview.md` §2: the row for this plan — added along with six other missing rows (85, 87, 88, 89, 90, 92, 93, 95, 96, 97) discovered missing during this same pass; the claim relayed from plan 93 ("only 90, 92, 93, 94, 95, 96, 97 are missing; only 98 and 99 have rows") was itself stale — 85, 87, 88, and 89 were ALSO missing, found by direct inspection rather than trusted from the relay.

### Pending work, consolidated — every hardware item this plan has left open, in step order

No worker on this plan has ever run anything against a physical device — this
repo's standing rule. Every step above that found its own verifiable result
provable only against real hardware left its own note, in its own words, at
the point it was found; this table cross-references each one rather than
replacing it, the same convention plans 90 §5 step 90.8, 91 §5 step 91.10, 92
§5 step 92.9, 93 §5 step 93.12, 97 §5 step 97.9 and 99 §5 step 99.9 each
already used for their own plan's equivalent list.

| # | Step | What's pending | Exact commands / outcome table |
|---|---|---|---|
| 1 | 94.2 | A real long-press on the manual (LiveView) path carrying `holdMs`; a real drag through `device.gesture` reproducing the operator's own sampled curve, not a synthesised one. | This document, §5 step 94.2's own "**94.2 hardware verification — pending, owner to run**" paragraph (checks A and B, five numbered sub-steps each, plus a `\| Check \| Device / model \| Result \| Notes \|` table, all cells empty). |
| 2 | 94.3 | The recorder against a real device: a tap on an identifiable button resolving a `count: 1` candidate, a real screenshot blob round-tripping as a PNG, a stopped document parsing against real captured bytes, and `maxDurationSec` ending a silent recording on its own. | This document, §5 step 94.3's own "**94.3 hardware verification — pending, owner to run**" paragraph (seven numbered steps plus a four-row outcome table, all cells empty). |
| 3 | 94.4 | Record mode in Studio against a real device: no restart/reload/dropped frame on entering Record, steps appearing in order with candidate styling, Discard/Stop behaving cleanly, losing control ending the recording on its own. | This document, §5 step 94.4's own "**94.4 hardware verification — pending, owner to run**" paragraph (nine numbered steps plus a six-row outcome table, all cells empty). |
| 4 | 94.5 | The full record → review → promote → parameterise → publish → detach loop against a real device, including replaying the SAME published script on a device with a DIFFERENT screen resolution (acceptance criterion 1, end-to-end). | This document, §5 step 94.5's own "**94.5 hardware verification — pending, owner to run**" paragraph (nine numbered steps plus a seven-row outcome table, all cells empty). |
| 5 | 94.8 | Stopping a real paced batch mid-flight: staggered start, every device reaching its launcher within seconds of `POST /:id/stop`, no further repetition starting, a refused-device case reporting correctly. | This document, §5 step 94.8's own "**Hardware verification — pending, owner to run**" paragraph (six numbered steps plus a five-row outcome table, all cells empty). |
| 6 | 94.9 | A real jittered, paced schedule firing across a farm — `jitterMs` on the run row matching `firedAt - dueAt` exactly, each repetition's `pacedDelayMs` matching its observed gap, and restart safety after a mid-flight kill. | This document, §5 step 94.9's own "**Hardware honesty — pending, owner to run**" table (five rows, all cells empty). |
| 7 | 94.10 | The Studio pacing surfaces against a real farm: a plausible finish-time estimate, the batch detail aside matching a real run, a live "next repetition in Ns" countdown reaching zero, the fleet-wide typed confirmation, and a schedule's own repeat draft reaching the batch it creates. | This document, §5 step 94.10's own "**Hardware honesty — pending, owner to run**" paragraph (six numbered steps plus a five-row outcome table, all cells empty). |
| 8 | §7.3 | The measurements that settle §0.4's hypotheses (H1–H4): candidate accuracy, per-repetition overhead, gap-suppression duration/success rate, post-stop device cleanliness, stagger and interval accuracy, cross-resolution replay — at least three devices, three real recordings. | §7.3 above, the `\| Measurement \| Method \| Target \| Result \|` table — every `Result` cell empty. |
| 9 | §7.4 | The stop drill — 5 devices, `count: 50`, a genuinely long-running paced batch, stopped mid-flight, watched for 5 minutes to confirm nothing resurrects it, repeated with the core killed 2 s after the stop. | §7.4 above, the five numbered steps (no table — a pass/fail narrative per step). |

None of the nine rows above can be closed by a worker under this repo's
standing no-physical-device rule — they are the owner's to run, roughly in the
order listed (94.2/94.3/94.4/94.5 build on each other; 94.8/94.9/94.10 and
§7.3/§7.4 all need a working paced batch, which is 94.2–94.5's own
prerequisite).

## 6. Acceptance criteria

1. A recording made on one device replays on a **different device with a different screen resolution** without editing, because coordinates are normalised (F2).
2. A published recording is an **ordinary `scripts` row**: it appears in the scripts list, resolves as `name@version` and `name@latest`, runs from the run dialog, can be scheduled, batched, cancelled, retried, and called by an agent — with **no code path anywhere that special-cases it**.
3. `GET /api/scripts/:id` returns generated source a human can read, and the workspace holds both the recording document and the generated entry.
4. **Detach** produces a plain `defineScript` file the operator owns, and the recording stops regenerating over it.
5. A recorded long-press replays as a long-press (F4 closed); a recorded drag replays with the operator's own sampled path, not a synthesised curve (F3, F7 closed).
6. A replayed recording does **not** pay `betweenActionMs` on top of its own gaps, and **does** still get `coordJitterPx`, `tapJitterMs` and `perCharMs` — verified per field against §3.6's table.
7. A **device's own** Timing settings are honoured — by a job and by an agent capability call, not only by the farm default (F35, F36 closed). Changing `coordJitterPx` on one device changes that device and no other.
8. Every tap step in a recording carries either a unique candidate selector with its match count and anchor age, or an explicit reason it has none. **No candidate is ever used at replay time unless a human promoted it.**
9. A batch with `count: N`, `intervalMs: [min,max]`, `deviceIntervalMs: d` produces exactly `devices × N` jobs; never more than `devices` of them exist at once; every inter-repetition gap on a device lands in `[min,max]`; device *k*'s first repetition is planned no earlier than `k × d` after device 0's.
10. **Every delay is on the row.** `jobs.pacedDelayMs` and `jobs.notBefore` are populated for every paced member, and `schedule_runs.jitterMs` for every fire (F28 closed).
11. The stagger is applied **once**, at a device's first repetition, and never re-applied.
12. `POST /api/batches/:id/stop` stops queued members, running members, and the pacer. No repetition is planned after the stop, in any interleaving.
13. Stop is gated by `canCancelJob` **per member**, and reports refusals by count instead of silently skipping them (F27 closed).
14. A device whose paced run was stopped mid-repetition has the recording's declared packages force-stopped, and the same stop applied twice changes nothing.
15. Killing the core mid-paced-run and restarting it resumes the remaining repetitions from the database, with no duplicated and no dropped repetition.
16. With no `pacing` block, `POST /api/batches` behaves **byte-identically** to before this plan; with `notBefore` null, the claim behaves byte-identically to before this plan.
17. A recording that exceeds `maxSteps` or `maxDurationSec` is **stopped and kept**, with the reason visible in Studio.
18. The run form's consequence sentence states repeats, interval, stagger and an estimated finish time; no screen shows both the device timing settings and the run pacing settings.
19. `rerun-failed` carries pacing, priority and queue timeout forward, and includes expired members (F30 closed).
20. `bun run typecheck`, `bun test`, and `bun run --cwd packages/studio test` are green. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

### 7.1 Unit tests

| Area | File | What it must prove |
|---|---|---|
| document schema | `packages/protocol/src/recording.test.ts` | every step kind round-trips; an inverted interval, a 2001-step document and a bad param name are all refused |
| hit-test | `packages/protocol/src/selector-match.test.ts` | deepest containing node; prefers `clickable`; a point outside every node returns null |
| candidates | `packages/core/src/recording/candidates.test.ts` | a unique `id` beats an ambiguous `text`; a node with nothing but bounds yields no candidate; the count equals `countMatches` (F13's guarantee) |
| interpreter | `packages/sdk/src/define-recording.test.ts` | the call sequence, the sleeps, `speed`, `maxGapMs`, param substitution, `reset.packages`, and a `finish()` that is a no-op when `cleanup: 'none'` |
| idempotent finish | same | `finish()` twice produces the same calls (F19) |
| compiler | `packages/core/src/recording/compile.test.ts` | deterministic output; the generated file passes `walkWorkspaceGraph`'s allowlist; detach emits a `defineScript` that typechecks |
| timing merge | `packages/session/src/device-executor.test.ts` | `betweenActionMs: [0,0]` suppresses the pause while `coordJitterPx` and `tapJitterMs` still apply (§3.6's table, one assertion per row) |
| per-device timing | `packages/core/src/daemon.test.ts` / `capability/context.test.ts` | a device row's `settings.timing` beats the farm default, on the job path **and** the capability path; a device with none falls back cleanly (F35, F36) |
| new verbs | `packages/session/src/device-executor.test.ts` | `gesture` reaches `InputSink.gesture` unchanged; `longPress` reaches `tap` with the right `holdMs`; an engine with no `gesture` refuses by name |
| claim predicate | `packages/core/src/queue/job-store.test.ts` | a future `notBefore` is not claimed; a past one is; null is unchanged; the batch-concurrency gate still holds alongside it |
| pacer | `packages/core/src/clusters/pacer.test.ts` | one repetition planned per settle; never past `repeatCount`; stagger once; draws inside the range; `stopping` plans nothing; the restart sweep re-plans exactly the missing repetitions |
| stop | `packages/core/src/api/batches.test.ts` | queued cancelled, running aborted, pacer stopped, refusals counted; a settle arriving *during* the stop plans nothing |
| schedule pass-through | `packages/core/src/schedules/runner.test.ts` | pacing reaches `createBatch`; `jitterMs` is persisted; `run-now` still forces `jitterSec: 0` |
| recorder session | `packages/core/src/recording/session.test.ts` | gaps measured from observation; caps stop-and-keep; a lease loss stops it; a dump failure yields no candidate rather than an error |
| review panel | `packages/studio/src/app/recordings/detail/page.test.tsx` | Promote is disabled at `count !== 1`; the anchor age renders; trimming a step renumbers the rest |
| run form | `packages/studio/src/components/RunScriptDialog.test.tsx` | the consequence sentence for 5 devices × 20 × [3,8] min × 30 s stagger |

### 7.2 Local smoke (one device)

```bash
bun run typecheck && bun test && bun run --cwd packages/studio test
bun run dev
# Studio → a device → Control → Record. Open an app, tap through 3 screens,
# long-press something, scroll, type. Stop.
# Review: check every step has a screenshot, the gaps look like what you did,
# and note how many steps got a unique candidate. Publish as `smoke@1.0.0`.
curl -s localhost:7700/api/scripts | jq '.items[] | select(.name=="smoke")'
# Run it once from the run dialog. Compare the job's screenshots to the review panel's.
curl -s -XPOST localhost:7700/api/batches -d '{"scriptId":"…","target":{"deviceIds":["…"]},
  "pacing":{"count":3,"intervalMs":[5000,9000],"deviceIntervalMs":0}}' | jq
curl -s localhost:7700/api/batches/<id> | jq '.jobs[] | {batchRepeat, notBefore, pacedDelayMs, status}'
# Stop it mid-run and confirm the device is at its launcher.
curl -s -XPOST localhost:7700/api/batches/<id>/stop | jq
```

### 7.3 The measurements that settle §0.4

Run on at least three devices, with three recordings made against apps this farm
actually drives. **Record the numbers in this section; an empty cell is a
measurement not taken, not a passed one.**

| Measurement | Method | Target | Result |
|---|---|---|---|
| **H1** — steps with a unique candidate | the review panel's own count, 3 recordings | reported, not targeted | |
| **H1** — candidates that are *wrong* | promote every candidate, replay, count divergences against the coordinate replay | reported | |
| **H2** — per-repetition overhead | `count: 20`, `intervalMs: [0,0]`, total ÷ 20 minus the single-run duration | < 3 s (spec §16) | |
| **H3** — duration, gaps suppressed vs added | the same recording 10× each way | suppressed is faster | |
| **H3** — success rate, suppressed vs added | same runs | suppressed ≥ added | |
| **H4** — devices clean after a mid-run stop | stop a 3-device paced batch mid-repetition | 3 / 3 at the launcher | |
| stagger accuracy | first-repetition start times across 5 devices, `deviceIntervalMs: 1000` | within ±2 s of plan (F24's fallback) | |
| interval accuracy | every `pacedDelayMs` against its measured gap | within ±2 s | |
| replay across resolutions | record on device A, replay on device B with a different size | reported: passes / fails, and where | |

### 7.4 The stop drill

With 5 devices, `count: 50`, `intervalMs: [30_000, 90_000]`, `deviceIntervalMs:
5_000`, running for at least three repetitions on every device:

1. `POST /api/batches/:id/stop`.
2. Within 10 s: `GET /api/batches/:id` shows zero queued and zero running members.
3. Over the next 5 minutes: **no new job appears** for that batch.
4. Every device: at its launcher, target packages stopped, `status: idle`.
5. Repeat with the core killed 2 s after the stop and restarted — the boot sweep must not resurrect the batch.

### 7.5 Regression watch

- `POST /api/batches` with no `pacing` produces the same rows as before, in the same transaction (F20).
- A job with `notBefore` null is claimed exactly as before (F22).
- `schedules` with `repeatCount: 1` behave exactly as before (F34).
- The device event log still records manual input unchanged (F15) — the recorder tees, it does not replace.
- `profile: 'instant'` on a device still degrades a recorded gesture to a two-point swipe rather than failing.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A coordinate replay silently drifts as the app under test changes, and nobody notices until a run has been wrong for a week. | Every step keeps its recording-time screenshot; a job's own screenshots sit beside it in the review panel. The recording says what it saw; the job says what it sees. This is the failure mode a *selector* replay would hide, which is §3.3's whole argument. |
| An operator promotes a candidate resolved against a stale anchor and gets a confidently wrong selector. | The anchor's age, package and step distance are shown next to the Promote control, and promotion is per step, never bulk. H1 measures how often this is even a temptation before any bulk path is considered. |
| `count × devices` jobs floods the job history. | One job per repetition is the point (§3.5), and it is bounded: `count ≤ 1000`. The jobs list is already keyset-paginated and already filters by batch (F21's index). If retention becomes the issue, it is spec §18's artifact policy, not a reason to hide history. |
| The pacer plans a repetition during a stop, or after a batch is terminal. | `status: 'stopping'` is set **first**, before anything is cancelled (§3.9 step 1), and the pacer reads it on every `onMemberSettled`. A test asserts the interleaving explicitly (§7.1). |
| A paced batch is stalled forever because a settle event was missed. | The plan is derived from rows, not events: the boot sweep and the 2 s scheduler tick both re-derive it (§4.8), and 94.11 adds the orphan sweep. |
| `notBefore` slows the claim query on a large `jobs` table. | It is one integer comparison after `idx_jobs_claim` has already narrowed on `(status, deviceId)` — a handful of rows. Measured at the 20-device rung if plan 85's ladder is ever run. |
| The stagger is swallowed by a busy farm and an operator believes it held. | It is documented as a floor (§3.8) and the batch detail shows planned versus actual start per device, so the discrepancy is visible rather than assumed. |
| Suppressing `betweenActionMs` makes replays *less* reliable — H3 is wrong. | The mechanism is one field on the generated script (§4.5). Reverting is deleting one line from the compiler, and §7.3 measures it before the plan claims it. |
| The recording step grammar has to change later and old documents stop parsing. | `schema: 1` is in the document from day one, and the repo already has the tool and the precedent (`normaliseLegacyPrep`, `settings.ts:106-112`). Any bump gets a tracked-removal row in 00-overview §9, like every other one. |
| A recording captures a password typed into a field. | `input.text` redaction already exists as a device-event setting (`packages/protocol/src/settings.ts:326`). The recorder honours the same switch, and the review panel lets an operator turn any text step into a parameter (§4.2) — which is the right answer anyway, since a hard-coded credential in a published script is worse than one in a run form. |
| Two operators race to record on one device. | One recording per device, held by the lease holder; a second `recording.start` returns `E_RECORDING_ACTIVE`. The lease already answers "who is driving". |

## 9. Open questions

1. **DECIDED (2026-08-12): "Recording" is confirmed; "Action" stays reserved for the wall's per-device buttons.** §3.2 proposed *Recording* over the owner's original word *Action*, on the grounds that *Action* already names the per-device buttons on the wall and the device card, and a nav entry called "Actions" would mislead. The owner accepted, and his own restatement shows he understood the artefact correctly, not just the word: *"recording action boleh juga tuh, itu kaya record macro gitu berarti yah"* — "recording is fine, so it's like recording a macro then." The vocabulary is settled: **Recording** for the artefact everywhere this plan's code and UI touch it — `defineRecording`, the **Recordings** Studio screen, the verb **Record** — and *Action* is not reused for it; it keeps meaning the wall's and device card's per-device buttons.
2. **Should a recording be able to wait for something?** §3.4 is honest that a recording has no assertions: it plays inputs at recorded intervals and cannot know whether a screen arrived. The smallest useful addition would be a `waitFor` step, recorded when the operator pauses on a screen and promotes an anchor node into a wait. That is genuinely valuable and genuinely a different feature — it turns a recording into a program with control flow. Not decided here, and deliberately not half-built: today the answer is Detach (§3.1).
3. **Per-member parameters.** Panda distributes one line of a list per device. The seam is a `batch_member_params` table keyed `(batchId, deviceId)`, read at `toJobRow` (`clusters/dispatch.ts:73-117`) — one table, one join, and a file-upload UI in the run form. §4.2's parameterisation is the half of it this plan builds; the distribution half is a separate plan and probably belongs with plan 93's bulk operations rather than here.
4. **DECIDED (2026-08-12): the repetition safety warning ships. The threshold's *shape* is decided; its *numbers* are provisional.** Nothing stops an operator queuing `count: 200` at `intervalMs: [0,0]`, which is a battery and thermal event more than a scheduling one (spec §15.2 already auto-quarantines on temperature). The owner said build the warning. The agreed shape: **warn on estimated continuous duty — how long a device would be kept busy with no gap — not on raw `count`**, because `count: 200` with a five-minute interval is harmless while `count: 30` back-to-back is not; a warning keyed on `count × devices` alone would flag the harmless case and miss nothing about the dangerous one's actual cause. Proposed starting point, to be wired into the run form's consequence sentence (§4.10) as a non-blocking warning: flag a run whose *estimated* continuous busy time — repetitions whose interval leaves no meaningful gap, summed — would keep a device busy beyond roughly **30 minutes without a gap**, and additionally require the operator to **type the device count** (not just confirm a dialog) when the run targets the whole fleet, mirroring the friction `ConfirmDialog` already reserves for an unrecoverable action. **These numbers are provisional**, not ratified: the owner approved the shape of the mechanism, not the 30-minute figure or the exact duty-cycle formula, and both should be retuned once §7.3's own measurements (H2's per-repetition overhead, the stagger and interval accuracy rows) give a real device a real thermal/battery number to check the threshold against.
5. **Should the recorder capture agent input too?** §3.3 puts the tee in the core specifically so it could. Recording what an AI agent did on a device, and replaying it deterministically, is an obviously interesting capability and an obviously large question about what "reproducible" means for a model. Not built, not designed, named so the seam is not accidentally closed.
