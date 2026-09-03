# Plan 107 — M72 : A long operation outlives the window that started it

> Status: partial — steps 107.1 (inventory), 107.2 (`GET /api/transfers`, the in-memory registry) done 2026-08-16; 107.3 (`useOperations` + `OperationTray`), 107.4 (durable kinds join the tray), and 107.5 (dialog re-attach in `InstallBatchDialog`/`BulkTransferDialog`) done 2026-08-17 — see their own checklists in §5. `Ships:` below now names a real file. 107.6 (owner-run H1–H3) and §9 Q2/Q3 are still open (Q3 answered here as a proposal, not a ruling — see its own entry). Plan 106 step 106.8 (2026-08-17, a later pass) narrowed 107.4's own "device preparation: partially covered" gap for `ui-server`'s install phase specifically — see §3.5's cross-reference note and 107.4's own updated bullet; not a change made by this plan's own steps. **107.7 (a live bug fix, this pass) done 2026-08-17**: an owner-reported stuck tray entry (a `stopping` batch with zero jobs, held non-terminal forever) traced to a core defect (`clusters/status.ts`/`api/batches.ts`, recorded as `docs/plans/96-m61-hotfixes.md` §96.30) plus two tray-side defects step 107.3/107.4 shipped with (no auto-dismiss for a terminal operation, `queued` batches shown as if progressing) — see §96.30 for the full account and §5 step 107.7 below for the tray-side half in this plan's own words.
> Depends on: Plan 103 (M68) — the popup and its dialogs are where these operations are started and re-opened. Plan 104 (M69) — an operation's target set comes from `TargetPicker`, so one operation can span many devices.
> Spec references: §12.3 (batches), §13 (the wire protocol — `transfer.*`), §19 (Studio screens)
> Ships: packages/studio/src/components/operations/OperationTray.tsx

---

## 0. Evidence

The owner's ask, verbatim: *"ketika install apk baik di satu device atau multiple device... ada component atau ui khusus yang floating di devices atau global app, jadi pas modal popup install apk di close progressnya masih bisa dilihat gitu, terus kalau di pencet install apk dan muncul modal juga pastikan prosesnya juga ditampilkan lagi di popupnya, ini penting sekali."* And: *"ga hanya install apk fitur aja, analisis fitur lain juga jangan lupa."*

### 0.1 Confirmed findings

| # | Finding | Evidence |
|---|---------|----------|
| **G1** | **Install already has an operation id and already broadcasts progress.** `POST /api/devices/:id/install` runs through `runTransfer(transferId, onProgress)`, and `transfer.progress` / `transfer.done` are wire messages carrying `transferId`. | `packages/core/src/api/transfer.ts:91-110`; `packages/protocol/src/messages/transfer.ts:16`, `:28`, `:43` |
| **G2** | **But nothing can discover an operation it did not watch start.** The `transferId` is minted inside the request; there is no list endpoint for in-flight transfers. A client that was not already subscribed has no way to learn one is running. **This — not the missing UI — is the actual gap.** | `packages/core/src/api/transfer.ts`; no `GET /api/transfers` exists |
| **G3** | `transfer.progress`/`transfer.done` are **scoped to viewers of the device**, not farm-wide (hotfix F27, closed in step 93.9 through `daemon.ts`'s `broadcastTransferEvent`). So a tray that is not watching that device receives nothing. | `docs/spec.md` §13; plan 93 §3.9 |
| **G4** | **Four operation kinds are already server-durable and discoverable**: jobs (`jobs` table, `GET /api/jobs`), batches (`batches`, `GET /api/batches`), command runs (`GET /api/command-runs`), and — once plan 106 lands — per-device preparation. Each survives a page reload and can be re-read at any time. | `packages/core/src/api/{jobs,batches}.ts`; plan 93 §4.4; plan 106 §3.1 |
| **G5** | **Transfers are the odd one out**: the operation continues server-side after the HTTP request's client disconnects, but no record of it exists to read back. Install and push/pull share this shape. | G1 + G2 |
| **G6** | The archive download (`GET /api/batches/:id/artifacts.zip`, step 93.10) is a **streaming HTTP response**, not a tracked operation — it has no id at all, and a closed tab simply cancels it. | `packages/core/src/api/batches.ts:784` |
| **G7** | Multi-device outcomes already have one house style — `OutcomeSummary`/`SkippedGroups`, outcome first, grouped by reason, every count reachable to named devices. | `packages/studio/src/components/bulk/`; `docs/design.md` |

### 0.2 Hypotheses

| # | Hypothesis | Probe |
|---|-----------|-------|
| **H1** | A farm-wide tray subscribing to every device's transfer events does not reintroduce the fan-out F27 closed (G3). | Watch `transfer.*` traffic with the tray open and 20+ devices present; compare against the pre-93.9 behaviour that F27 was raised about. |
| **H2** | Making transfers durable (a row, not just an event stream) is worth its cost, versus accepting that a page reload loses in-flight tracking. | Owner's judgement, informed by §3.4's two options and how often a reload happens mid-install in practice. |

---

## 1. Goals

1. **An operation's progress outlives the modal that started it** — closing the dialog never hides work that is still running.
2. **Re-opening that dialog re-attaches** to the running operation rather than offering to start a second one (the owner's own second sentence, and the more dangerous half: a dialog that forgets is a dialog that will double-install).
3. **One tray, one vocabulary**, for every kind of long operation — not a bespoke indicator per feature.
4. Answer the "which other features" question with an inventory, not an assumption (§3.5).

## 2. Non-goals

- Not a job scheduler or a queue. Jobs and batches already have both (G4); this is the *visibility* layer over work that is already running.
- Not re-broadcasting transfer events farm-wide by default (G3) — see §3.3.

## 3. Context and design decisions

### 3.1 The gap is discovery, not display

G1 is the surprise: install already has an id and already streams progress. So the missing piece is **not** a progress bar — it is that G2 leaves an operation undiscoverable to anyone who was not already listening.

That reframes the work. A tray that only shows operations *it personally started* is a tray that loses everything on a reload, and shows nothing at all in a second browser tab. The registry has to be able to answer "what is running right now" from cold.

### 3.2 Two classes, and they need different work

| class | kinds | what they already have | what they need |
|---|---|---|---|
| **durable** | jobs, batches, command runs, device preparation (G4) | a row, a list endpoint, reload-safe | only the tray reading them |
| **ephemeral** | transfers: install apk, push/pull (G5) | an id and a live event stream | **a way to be discovered** (§3.4) |
| **untracked** | the artifact zip (G6) | nothing — a stream a closed tab cancels | a decision: leave it, or give it an id |

Do not paper over the difference. A tray that shows durable and ephemeral operations identically, while only one of them survives a reload, teaches the operator a rule that is false half the time.

### 3.3 The tray subscribes per device, and that constraint is deliberate

G3: `transfer.progress`/`transfer.done` are scoped to viewers of the device. That scoping was a hotfix (F27) — before it, transfer events went farm-wide, which is exactly what a naive tray would ask for again.

So the tray must not "just subscribe to everything". Options, in preference order:

1. **Subscribe to the devices this operation targets**, learned when the operation starts and re-learned from the registry (§3.4) on reload.
2. A dedicated, deliberately-small farm-wide `operation.*` channel carrying only ids, states and counts — never per-chunk byte progress, which is what made F27 expensive.

H1 measures whichever is chosen. Do not restore farm-wide per-chunk broadcast; that regression has already been paid for once.

### 3.4 Making transfers discoverable — the one real decision

Two ways, and §9 Q1 asks the owner:

- **In-memory registry in the core.** `GET /api/transfers` lists what is in flight right now. Cheap, no schema change, and correct for the common case — but a core restart forgets, and the operation it forgot may still be running on the phone.
- **A durable row**, like jobs and batches (G4). Survives restart, consistent with every other operation kind, and gives "what happened to that install an hour ago" an answer — but it is a table, a migration, and a retention question for something that is usually over in seconds.

H2 informs it. The in-memory registry is the smaller step and can be replaced by the durable one later without changing the tray, provided the tray reads an endpoint rather than the event stream directly — which is a reason to build it that way regardless of the answer.

**Decision recorded, step 107.2 (2026-08-16): the in-memory registry.** Built as `createTransferRegistry()` (`packages/core/src/device/transfer-registry.ts`), fed from the single `transferBroadcast` object `daemon.ts` already constructs — the one seam every one of `runTransfer`'s nine call sites (`api/transfer.ts` ×3, `jobs/executors/{install,push,pull}.ts` ×3, the script IPC bridge in `daemon.ts` ×3) already shares, so no new dependency had to be threaded through any of them. `GET /api/transfers` (`packages/core/src/api/transfers.ts`, `TransfersResponseSchema` in `@enkaku/protocol`) reads it.

**The restart caveat, stated where a reader of this decision will find it (not only in the code):** the registry is a `Map` in the core process's memory, not a database row. **A core restart forgets every entry** — including a transfer whose `adb push`/`pm install` is still running on the phone, because the transfer is server-side work outliving the HTTP request that started it, not a client connection tied to the process's own lifetime. `GET /api/transfers` answers "what is THIS PROCESS aware of right now," never "what has ever run" or "what is currently happening on the device regardless of core uptime." Finished entries are also swept after a 30-second retention window (`RETENTION_MS`), so the list never grows into an unbounded history either — that is deliberately the durable row's job (§3.4's other option), not this one's.

**Why the smaller option is safe here, not merely cheap:** `TransferRecordSchema`'s shape (`transferId`, `deviceId`, `kind`, `state`, `startedAt`, `updatedAt`, `sent`, `total`, `ok`, `error`) is exactly what a `transfers` table's own row would hold. A later swap to the durable option changes `transfer-registry.ts`'s internals and this file's producer; it changes nothing about `TransfersResponseSchema` itself or any client reading it — the condition §3.4 sets for choosing the smaller step without foreclosing the larger one.

**F27 re-checked for this endpoint specifically**: `sent`/`total` are included as a point-in-time snapshot from the single poll that fetched the list — never a repeated push. This is not the farm-wide per-chunk broadcast F27 closed (plan 93 step 93.9): the live per-chunk stream stays exactly where F27 put it, scoped to viewers of the device via `transfer.progress`/`transfer.done`. `GET /api/transfers` exists only to tell a client which device(s) and transferId(s) to subscribe to; it is polled on demand, not pushed on every byte.

### 3.5 The inventory, because "analyse other features too" is the actual instruction

Every operation that can outlive its dialog, and what it needs:

| operation | today | needs |
|---|---|---|
| **Install apk** | id + events, undiscoverable (G1, G2) | §3.4 |
| **Push / Pull file** | same machinery as install | §3.4 |
| **Run script / batch** | durable (G4) | tray entry only |
| **Adb command fan-out** | durable (`/api/command-runs`) | tray entry only |
| **Device preparation** (plan 106) | durable per component; as of plan 106 step 106.8, `ui-server`'s INSTALL PHASE specifically also mints a real `transferId` (routed through the SAME machinery this row's own "Install apk" uses, `origin: 'preparation'` on the resulting `GET /api/transfers` row) | tray entry for the durable state (106.4's own gap, still open — see below); the install-phase transfer entry is now free, no longer "needs" anything |
| **Artifact zip download** (G6) | a raw stream, no id | a decision (§3.2) |
| **Toolchain install** (host-side) | its own page and progress | probably its own place — say so rather than absorbing it silently |
| **Bulk wake/sleep** | one WS message per device, sets `desiredReadiness` and returns; the actual wake happens async but is already tracked on the device row itself (`device.readiness`, read back by `GET /api/devices`) | **nothing** — not long, and already discoverable per-device without a tray. |
| **Bulk device labels** (`POST /api/devices/labels/apply`, plan 89 §4.6) | ***not*** fan-out-and-forget — see step 107.1's finding below | undecided; flagged, not fixed, by this plan |

That last row matters as much as the others. A tray that shows every action becomes noise, and noise is how an operator learns to ignore the one entry that mattered.

**Step 107.1's finding (2026-08-16), the reason this verification pass exists**: §3.5's original table lumped "Bulk wake/sleep/labels" into one row and called all of it "nothing — not long." That is true for wake/sleep (`readiness.set` over WS, one write, returns immediately) but **false for the bulk labels endpoint**. `POST /api/devices/labels/apply` (`packages/core/src/api/devices.ts:564`) loops over every targeted device *sequentially*, `await`-ing `LabellingService.apply()` (`packages/core/src/device/labelling.ts`) for each one before moving to the next — and `apply()` does real, unconditional device I/O (a wallpaper push through the guest agent, or a lock-screen write over plain adb), explicitly documented on `LabellingServiceDeps` as serialized per device precisely because it is not instant. On a fleet-wide "apply to everyone" pass this is minutes, not milliseconds, all inside ONE HTTP request. Two consequences the original row missed:

1. **It has no id at all** — not even the ephemeral `transferId` install/push/pull have. There is nothing to poll, subscribe to, or discover, whether or not this plan's registry pattern is applied to it.
2. **Bun/Hono does not abort a handler when the client disconnects** unless the handler explicitly checks `c.req.raw.signal.aborted` (`app.post('/labels/apply', ...)` does not) — so closing the tab that started a fleet-wide label apply does not stop it; the loop keeps writing to devices the operator has already navigated away from, with no way to learn it finished, how far it got, or which devices failed, other than opening each device's own settings afterward and checking its persisted `DeviceLabelState` one at a time.

This is exactly the class of gap this plan exists to find, and it is recorded here — not fixed here: fixing it (an id, a way to poll or cancel, a tray entry) is new scope beyond 107.2's transfers-only mandate and beyond 107.3–107.5 (Studio, out of this pass's boundary — see the file header). It is left as an open item for whichever later step or plan picks up "operations besides transfers that need discoverability."

**Cross-reference, added after plan 106 step 106.8 (2026-08-17)**: step 107.4's own "device preparation: partially covered" note (below) is narrowed, not closed, by that step. `ui-server-component.ts`'s install now routes through `runTransfer` (`origin: 'preparation'` on the resulting `GET /api/transfers` row, `packages/studio/src/lib/operations.ts`'s `toTransferOperation`), so a ui-server install appears in `OperationTray` for free — this table's own §3.4 column ("needs") is updated above. Two things this did NOT close, so 107.4's note below still stands: (1) `ui-server`'s non-install phases (the `verifyDeviceArtifact` check, the SDK-floor check) mint no transferId and are still invisible to the tray; (2) the guest agent's own install is deliberately not converted (plan 106 §9 Q5's resolution), so it still relies solely on `DeviceInfo.agent === 'provisioning'` for its tray entry, unchanged. The general farm-wide preparation summary this plan's own step 107.4 and plan 106 §9 Q4 both want — a compact, precomputed `DeviceInfo` field covering EVERY registered component's state, not just a transfer-in-flight — is still not built.

### 3.6 Re-opening a dialog must re-attach, not restart

The owner named this and it is the half with teeth. `InstallBatchDialog` opened while an install is running on the same target must show **that** operation — its progress, its per-device outcome so far — and must not offer a fresh Install button as though nothing were happening.

Where the target overlaps only partly (an install is running on three of the five devices now selected), say so explicitly rather than merging the two silently. Guessing here produces a double install, and on a slow device that is minutes of wasted transfer and a real risk of two `pm install` runs racing on one phone.

---

## 4. Technical design

```
core: operation registry (§3.4)   ← in-memory or durable, decided by §9 Q1
        │  GET /api/operations (or /api/transfers) — what is running now
        ▼
studio: useOperations()           ← one hook, mounted at the AppShell
        │  reads the endpoint on mount, then follows WS events (§3.3)
        ├── <OperationTray/>      ← floating, farm-wide, one vocabulary
        └── dialogs re-attach     ← §3.6, by matching operation + target
```

Every multi-device operation renders its outcome through `OutcomeSummary`/`SkippedGroups` (G7) — the tray shows progress, and the completed result reads exactly as it does everywhere else.

---

## 5. Implementation steps

### 107.1 — The inventory, verified against the code — **done, 2026-08-16**
§3.5's table, checked rather than assumed — the same discipline step 103.11's audit used. Any operation it finds that is not listed there is the point of doing it.

- [x] Confirmed accurate against the code as of this pass: **Run script/batch** (`jobs`/`batches` tables, `GET /api/jobs`, `GET /api/batches`); **Adb command fan-out** (`command_runs`, `GET /api/command-runs`); **Device preparation** (`GET /:id/preparation`, plan 106); **Artifact zip download** (`GET /:id/artifacts.zip` — a raw stream, genuinely no id, matching G6); **Toolchain install** (`GET /api/tools` reflects the manager's own persisted version/active state, its own page as the table already said).
- [x] **Install apk / Push / Pull file** — confirmed as G1/G2/G5 described: an id (`transferId`) and a live WS stream, but no way to discover one that was already running. Closed by 107.2.
- [x] **New finding, not in §3.5's original table**: `POST /api/devices/labels/apply` (bulk device labels, plan 89 §4.6) was filed under "Bulk wake/sleep/labels — nothing," which is correct for wake/sleep but wrong for labels — it is a sequential, per-device, real-I/O loop inside one HTTP request, with no id, no partial-progress visibility, and no server-side cancellation on client disconnect. Recorded in §3.5's table and its own note above; **not fixed by this plan** (out of 107.2's transfers-only scope) — left as an explicit open item.
- [x] §3.5's table updated in place (split the wake/sleep and labels rows; added the finding note) rather than left to silently disagree with the code, per this step's own discipline.

### 107.2 — Discoverability for transfers (§3.4) — **done, 2026-08-16**
Whichever §9 Q1 chooses. The tray reads an endpoint either way.

- [x] §9 Q1 answered: the in-memory registry (see §3.4's own "Decision recorded" paragraph above for the full reasoning and the restart caveat).
- [x] `packages/protocol/src/api/transfers.ts` — `TransferStateSchema`, `TransferRecordSchema`, `TransfersResponseSchema`; exported from `packages/protocol/src/index.ts`.
- [x] `packages/core/src/device/transfer-registry.ts` — `createTransferRegistry()`; `progress`/`done` mirror `TransferBroadcast`'s own `(deviceId, transferId, kind, ...)` shape so it can be fed from the ONE `transferBroadcast` object every `runTransfer` call site already shares, with no new dependency threaded through any of the nine; a 30s retention window sweeps finished entries so the list stays bounded.
- [x] `packages/core/src/api/transfers.ts` — `createTransferRegistryRoutes`, `GET /` → `{ transfers: registry.list() }`. No permission gate beyond `authMiddleware`, matching `GET /api/jobs`/`GET /api/batches`/`GET /api/command-runs`.
- [x] `daemon.ts` — `transferRegistry` constructed unconditionally beside `transferService`; both `transferBroadcast.progress` and `.done` feed it; `transferRegistryRoutes` built from the live registry and passed into `createApp`.
- [x] `server/http.ts` — `HttpDeps.transferRegistryRoutes` (required, not optional — every construction site is exactly two files, `daemon.ts` and `http.test.ts`, both updated in this pass); mounted at `/api/transfers`, its own top-level prefix (farm-wide, not device-scoped).
- [x] F27 re-checked and stated explicitly in the endpoint's own doc comments (protocol schema, core route, core registry) and in spec.md §13: `sent`/`total` are a single-poll snapshot, never a repeated push — the live per-chunk channel stays exactly where F27 scoped it.
- [x] Tests: `packages/core/src/device/transfer-registry.test.ts` (registry unit tests — lazy-create on either `progress` or `done`, terminal-state guard, retention sweep, concurrent transfers); `packages/core/src/api/transfers.test.ts` (route tests); `packages/core/src/daemon-wiring.test.ts` (three new tests pinning the actual wiring, not just the mechanism, per this repo's "21+ instances of unreachable production call site" defect log).
- [x] `docs/spec.md` §13 updated in the same pass (the `GET /api/transfers` addition to the "File transfer" bullet) — `spec:check` GAP 0.

### 107.3 — `useOperations` + `OperationTray` — **done, 2026-08-17**
Farm-wide, mounted once at the shell. Subscription per §3.3, never a restored farm-wide per-chunk broadcast.

- [x] `packages/studio/src/lib/operations.ts` — a shared, ref-counted `OperationsStore` (mirrors `WsClient`'s own singleton shape) plus `useOperations()` (`useSyncExternalStore`). Fetches `GET /api/transfers|jobs|batches|command-runs|devices` on the first subscriber, then polls every 5s (`POLL_MS`) — a bounded, snapshot-only re-read of list endpoints, never a per-chunk push. `job.status`/`batch.status`/`device.added`/`device.removed`/`device.status` (already farm-wide broadcasts, per `AppShell.tsx`'s own pre-existing sidebar-count effect) trigger an immediate debounced refresh.
- [x] §3.3 answered: **option 1** (subscribe to the devices an operation targets). For LIVE byte-level transfer progress specifically, the store sends `log.subscribe`/`log.unsubscribe` (`streams: ['input']`) per device — the SAME mechanism `TerminalPane.tsx` already uses to become a "viewer" for `shell.echo`/`shell.result` fan-out (`ws-handlers.ts`'s `deviceTargets`), reused rather than re-invented. Only devices with a currently-running, not-already-batch-covered transfer are subscribed (`wantedTransferSubscriptions`); every other kind refreshes on the bounded poll. No new core-side WS message was added — F27's farm-wide per-chunk broadcast is not reintroduced.
- [x] `packages/studio/src/components/operations/OperationTray.tsx` — the floating panel, mounted once in `packages/studio/src/components/layout/AppShell.tsx` (sibling to the sidebar and content pane, so its `fixed` positioning is never affected by an ancestor's `filter`). Renders nothing when no operation is running (§3.5's "noise" rule). No `backdrop-filter` (would have been permitted — one fixed element regardless of fleet size — but a solid `bg-surface` was simpler and reads better over the Wall).
- [x] Tests: `packages/studio/src/lib/operations.test.ts` (30 cases — pure builders, the store's fetch/poll/patch/subscribe lifecycle, ref-counting across two simultaneous callers); `packages/studio/src/components/operations/OperationTray.test.tsx` (empty state, a running batch through `OutcomeSummary`, the ephemeral badge, collapse/expand).

### 107.4 — Durable kinds join the tray — **done, 2026-08-17**
Jobs, batches, command runs, preparation — read from their existing endpoints (G4), no new state.

- [x] Batches: `GET /api/batches?limit=50`, filtered to `queued|running|stopping`; device ids for the tray/re-attach come from the SAME `GET /api/jobs?limit=200` fetch already needed for standalone jobs (grouped by `batchId`) — no second per-batch fetch. Rendered through `OutcomeSummary` unchanged (G7, "reuse, do not reinvent").
- [x] Standalone jobs (not part of a batch): `GET /api/jobs?limit=200`, filtered to `batchId === null && status in (queued, running)` — a batch member job is never ALSO shown as its own row (would be exactly the noise §3.5 warns about); it is represented once, by its batch.
- [x] Command runs: `GET /api/command-runs?limit=50`, filtered to `running|awaiting-continue`. Counts refresh on the same bounded poll as everything else — this is a stated, accepted trade (no `command.subscribe` per run), since that channel is ALSO scoped like transfers (`commandTargets(runId)`, `ws-handlers.ts`'s own comment) and adding a fifth kind of live subscription was judged not worth it for a value that can lag up to 5s. `href` points at `/console` (no per-run deep link exists yet — out of this plan's file allowlist to add).
- [x] Device preparation: **partially covered, stated rather than silently faked.** There is no farm-wide list endpoint (`GET /:id/preparation` is per-device only, and building one is out of `packages/core/**`'s file allowlist for this pass, and out of 107.4's own "no new state" instruction). `DeviceInfo.agent` — the guest agent's own state, already returned by `GET /api/devices` — is the one farm-wide-visible signal, so a device with `agent === 'provisioning'` gets a `'preparation'` tray entry. Every OTHER preparation component (plan 106 §3.2's open-ended registry) has no farm-wide signal and is not represented — an operator still finds it on that device's own popup. Recorded here, and in `lib/operations.ts`'s own doc comment, rather than left to look like full coverage. **Narrowed by plan 106 step 106.8 (2026-08-17, a later pass — `packages/core` scope that pass, unlike this one, was allowed to touch):** `ui-server`'s install phase now rides `GET /api/transfers` (`origin: 'preparation'`), so it appears in the tray as an ordinary transfer row without this file's own `DeviceInfo`-summary gap needing to close first. This is additive, not a replacement — the `agent === 'provisioning'` entry above is unchanged, and `ui-server`'s own non-install phases and any future non-transfer-routed component are still invisible here exactly as this bullet already said. See §3.5's own cross-reference note, added the same pass.
- [x] §3.2's rule kept visible, not merely internally tracked: `Operation.durable` is `false` only for `kind: 'transfer'`; `OperationTray` renders an explicit, tooltipped "not saved" badge on those rows only, naming the restart caveat 107.2 already recorded.
- [x] §3.5's last row respected: wake/sleep and bulk labels do NOT get a tray entry — `useOperations` never reads a source for either, so there is nothing to accidentally include. `POST /api/devices/labels/apply` stays the flagged, not-fixed open item 107.1 recorded (it has no id — nothing to build a tray entry from without new core scope, which this plan does not take).

### 107.5 — Dialogs re-attach (§3.6) — **done, 2026-08-17**
Install first, then push/pull. Partial-overlap targets stated, never merged silently.

- [x] `findReattach(operations, action, targetDeviceIds)` (`lib/operations.ts`, pure, unit-tested) — three outcomes: `'none'` (free to submit), `'full'` with a single covering operation (silently re-attachable), and every other case (`'partial'`, or `'full'` split across more than one operation) named instead of merged.
- [x] `InstallBatchDialog.tsx` — on open (and again whenever the operator edits the target while the dialog stays open), checks `findReattach(operations, 'install', targetDeviceIds)`. A clean full match against a **batch** operation sets `batchId` directly, reusing `useBatchReport`'s existing progress view unchanged — no new report UI. A clean full match against an ephemeral **transfer** (a single-device install started elsewhere, e.g. the device popup's Files tab, before any batch is involved) renders `TransferProgressBar` instead. Any other overlap renders `ReattachBanner` (`components/operations/ReattachBanner.tsx`) and disables the Install button until the operator narrows the target or waits.
- [x] `BulkTransferDialog.tsx` — the identical shape, action-parametrised by `mode` (`push`/`pull`).
- [x] `resolveTargetDeviceIds` (`lib/operations.ts`) — turns the picker's CURRENT state (`single`/`cluster`/`devices`) into a concrete device-id list, reading a cluster's live membership from the device pool rather than a cached count, so the re-attach check is never stale against what `TargetPicker` itself already shows.
- [x] Tests: `InstallBatchDialog.test.tsx` (+3: silent batch re-attach, silent transfer re-attach, partial-overlap banner + disabled submit) and `BulkTransferDialog.test.tsx` (+2: transfer re-attach, partial-overlap on pull) — added beside the existing F15/§3.4 cases, all passing together.

### 107.6 — H1/H2
Owner-run.

### 107.7 — The tray's own visibility rule was wrong at both ends — done, 2026-08-17
> Status: **done.** A live bug: the owner's tray showed one entry, forever —
> `chrome-open-url · no device · stopping · 16s`, a full-width bar reading
> `(0/0)`. Traced to a core defect (a batch with zero jobs could never leave
> `stopping` — `docs/plans/96-m61-hotfixes.md` §96.30 has the full account,
> including why the DB row/tray both heal on the next read with no migration)
> plus two things step 107.3/107.4 got wrong in this plan's own file: no
> auto-dismiss existed for ANY terminal operation (one showed for zero
> seconds, the other — durable non-terminal kinds — for as long as its
> source stayed non-terminal, which for a batch could be forever), and
> `NONTERMINAL_BATCH` treated `queued` as equivalent to `running`, which the
> owner's own words ("minimal yang lagi progress") say it is not.

- [x] `lib/operations.ts` — `Operation` gained `terminal`/`succeeded`, set by
  each `toXOperation` builder from that kind's own protocol status enum
  (`TERMINAL_BATCH`/`TERMINAL_JOB`/`TERMINAL_COMMAND_RUN`, duplicated from
  the wire schemas since the core's own `TERMINAL_BATCH_STATUSES` is a
  server-internal export Studio cannot reach). `withinGrace(op, nowMs)` — no
  new timer anywhere: `finishedAt` is a wall-clock instant already on the
  operation, recomputed fresh every time `buildOperations` runs (the store's
  own bounded poll and WS-triggered refresh), so there is nothing per-entry
  to leak or forget to clear on unmount. `SUCCESS_GRACE_MS` (5s) vs
  `SETTLED_GRACE_MS` (15s, three times longer — a failure needs more time to
  be read than a success needs to be noticed, matching this codebase's own
  `OutcomeSummary`/`SkippedGroups` convention of giving a non-clean outcome
  more surface, not less).
- [x] `buildOperations` now takes an optional `nowMs` (default `Date.now()`,
  the same pattern `lib/format.ts`'s `duration`/`relativeTime` already use).
  Jobs and command runs need no status filter beyond "is this row a
  candidate" — every status either kind's protocol enum defines is EITHER
  progressing or terminal, and `withinGrace` decides the terminal ones.
  Batches are the one kind with a third bucket: `batchBelongsInTray`
  excludes `queued` outright, unconditionally, never merely delayed by the
  grace window — scoped to batches specifically (not jobs, which keep plan
  107 step 107.4's own original, still-pinned "running/queued" behaviour),
  because a queued batch is the one shape §96.30 found can get stuck
  non-terminal FOREVER at the core level; a standalone queued job carries no
  equivalent risk (`forget` deletes the whole job row, never leaves an
  orphaned parent).
- [x] A batch operation with `deviceIds.length === 0` never renders,
  whatever its status — belt-and-suspenders for §96.30's own core fix, and
  the direct fix for the screenshot's `"no device"` label. Not applied to
  command runs: a cluster/tag-targeted run legitimately has an empty
  pre-resolution `target.deviceIds` today (`CommandRunSummary` carries no
  resolved member list), so the same guard there would have hidden every
  real cluster/tag command from the tray — checked before applying, not
  assumed safe.
- [x] `components/bulk/OutcomeSummary.tsx` — no `<Progress>` rendered at all
  when `counts.total === 0`. `value={0}` already rendered the INDICATOR
  fully hidden, but the track underneath (`bg-primary/20`, a full-width,
  always-visible pill) still read as a bar with something to show — the
  screenshot's own complaint. Shared by every bulk surface (`InstallBatchDialog`,
  `BulkTransferDialog`, `batches/detail`, `device-popup/ActionsList`, this
  tray), so the fix applies everywhere at once rather than only in the tray.
- [x] The tray's other operation kinds checked for the identical "immortal
  non-terminal" shape (the failure mode this whole investigation's own brief
  warned is the one that keeps recurring in this repo): transfers already
  carry a bounded 30s server-side retention sweep regardless of state
  (`transfer-registry.ts`); a standalone job is deleted WHOLE by `forget`,
  never left as an orphaned parent the way a batch can be; command runs have
  no deletion path that removes a member out from under a still-live run.
  Batches are the one kind with both a parent/child split AND a deletion
  path (`device/lifecycle.ts`'s `forget({ deleteHistory: true })`) that
  touches only the child.
- [x] Tests: `lib/operations.test.ts` (+9) — the exact stuck shape (`queued`
  excluded even with real jobs; zero-device-id batch excluded whatever its
  status) plus the grace window for every terminal kind, both within and
  past it, and proof a still-progressing operation is immune to an
  arbitrarily large clock. `components/operations/OperationTray.test.tsx`
  (+3) — the owner's exact stuck entry renders nothing end to end; a batch
  that just succeeded still renders; the same batch, well past even a
  failure's own window, does not. `components/bulk/OutcomeSummary.test.tsx`
  (new file, 2 tests) — zero total renders no `[role="progressbar"]`; a real
  total still does.
- **Verifiable result:** the owner's own stuck entry — `stopping`, zero
  jobs, `(0/0)`, no device, ticking forever — disappears from the tray
  within one poll cycle of this fix landing (the core heals the row's
  reported status on the very next `GET`; no restart, no migration). A fresh
  install/batch still shows while genuinely running, still shows its outcome
  briefly on success or failure, and is gone a few seconds later either way.

---

## 6. Acceptance criteria

- [x] Closing an install dialog mid-install leaves its progress visible in the tray (§1) — the install's own transfer/batch is already in `useOperations()`'s state (fed by the SAME `GET /api/transfers`/`GET /api/batches` `OperationTray` reads), independent of whether `InstallBatchDialog` is mounted.
- [x] Re-opening that dialog shows the running operation and offers no second start (§3.6) — `findReattach` + the silent-reattach effect in `InstallBatchDialog.tsx`/`BulkTransferDialog.tsx`, unit- and component-tested.
- [x] A partially-overlapping target is stated, not merged (§3.6) — `ReattachBanner`, submit disabled while `reattach.overlap !== 'none'`.
- [x] The tray shows something after a **page reload** for durable kinds (jobs/batches/command-runs re-fetched fresh on mount), and ephemeral kinds are visibly marked distinct (`Operation.durable`, the "not saved" badge) — never rendered identically (§3.2).
- [x] No farm-wide per-chunk transfer broadcast is reintroduced (§3.3, F27) — live transfer progress is carried by a PER-DEVICE `log.subscribe`, the same mechanism `TerminalPane.tsx` already uses; no new core WS message type was added by this pass.
- [x] Fast fan-out actions do not appear in the tray (§3.5's last row) — `useOperations` has no source for wake/sleep or bulk labels at all.
- [x] Completed multi-device operations render through `OutcomeSummary`/`SkippedGroups` (G7) — `OperationTray`'s batch/command-run rows use `OutcomeSummary` directly; the dialogs' own completed-batch view was already `OutcomeSummary`/`SkippedGroups` before this plan and is unchanged.

## 7. Test plan

### Component
- `packages/studio/src/lib/operations.test.ts` (30 cases) — `buildOperations`/`visibleTransfers`/`wantedTransferSubscriptions`/`resolveTargetDeviceIds`/`findReattach` as pure functions, plus the store's own fetch-on-mount, WS-patch, and ref-counted subscribe/unsubscribe lifecycle (an operation started elsewhere appears after a cold read; a `transfer.done` patch marks it settled and unsubscribes its device immediately).
- `packages/studio/src/components/operations/OperationTray.test.tsx` (4 cases) — empty state, a running batch through `OutcomeSummary`, the ephemeral "not saved" badge, collapse/expand.
- Re-attach: `InstallBatchDialog.test.tsx`/`BulkTransferDialog.test.tsx` (+5 cases total) — opening the dialog with a target fully covered by one running operation shows that operation's own progress (batch or ephemeral transfer) and offers no fresh submit button; a partial overlap shows `ReattachBanner` and disables submit.

### Owner-run
| # | What | How | Outcome |
|---|---|---|---|
| H-1 | The tray does not reintroduce F27's fan-out (§3.3). | Open the tray with 20+ devices; watch `transfer.*` traffic. | *(owner to fill in)* |
| H-2 | Durable-vs-ephemeral is worth the cost (§3.4). | Reload mid-install; judge whether losing the tracking matters. | *(owner to fill in)* |
| H-3 | A real multi-device install, watched from the tray with the dialog closed. | Install on 3+ devices, close the dialog, follow it in the tray, reopen. | *(owner to fill in)* |

## 8. Risks and mitigations

- **Restoring F27's farm-wide broadcast** to feed the tray. Mitigated by §3.3's ordered options and H1; the regression has been paid for once already.
- **A tray that shows everything becomes noise.** Mitigated by §3.5's explicit exclusion of fast fan-out actions.
- **Durable and ephemeral shown identically**, teaching a reload rule that is false for half of them. Mitigated by §3.2's rule that the difference stays visible.
- **A double install** from a dialog that forgot. Mitigated by §3.6 — and this is the failure that costs an operator real minutes, not just confusion.

## 9. Open questions

1. **In-memory registry or a durable row for transfers?** (§3.4.) **Answered, step 107.2 (2026-08-16): the in-memory registry.** It is the smaller step (no schema change, no migration, no retention policy to design for a table) and it is replaceable later by a durable row without changing the tray or any other client, because `GET /api/transfers` already reads an endpoint (`TransfersResponseSchema` in `@enkaku/protocol`) rather than the event stream directly, and that schema's shape already matches what a durable row would hold — see §3.4's own "Decision recorded" paragraph for the full reasoning, and its stated cost (a core restart forgets every in-flight transfer, even one still running on the phone).
2. **Does the artifact zip get an id** (G6), or stay a stream a closed tab cancels?
3. **Does the tray live in the shell, the device popup, or both?** The owner said *"floating di devices atau global app"* — both readings are open, and the answer decides whether a device-scoped operation is visible while looking at a different device.

   **Proposal recorded by step 107.3 (2026-08-17) — a proposal, not a ruling; the owner still decides.** Built at the SHELL only (`AppShell.tsx` mounts one `<OperationTray/>`), for three reasons stated so the tradeoff is visible rather than assumed:

   - It is the smaller, reversible step: `useOperations()` is the shared, ref-counted singleton every caller reads (`lib/operations.ts`), so a SECOND rendering surface inside the device popup would cost a new component reading the SAME hook and filtering its `operations` down to the popup's own device — cheap to add later, and adding it does not change or duplicate the fetch/poll/subscribe machinery this step already built.
   - A shell-mounted tray is strictly MORE visible than a popup-only one: it is on screen from every page, including while looking at a DIFFERENT device than the one an operation targets — which is exactly the case a popup-only placement cannot cover (the owner's own scenario: an install running on device A stays visible while the operator has popped open device B).
   - The popup already has its own dense, fixed-height `ActionsList` (§4.2 of plan 103, twelve rows, "nothing appends to it") and its own three-panel layout (plan 103's own `docs/design.md` entry) — dropping a second, in-place operations list into it without a design pass would be exactly the kind of unreviewed layout change plan 103 was written to prevent equally carefully.

   **What is deliberately NOT built by this step, so the shell-only choice does not silently foreclose a popup surface later**: a per-device operations affordance on `DeviceCard`/`WallTile` (a badge, a mini progress rail) is left out for the identical reason `OperationTray.tsx`'s own doc comment states — keeping this pass to one surface. If the owner's reading of *"floating di devices"* means a per-device indicator ON the tile or inside the popup specifically (not just "visible while looking at devices," which the shell tray already satisfies), that is the next, separate step this proposal leaves open rather than guesses at.
