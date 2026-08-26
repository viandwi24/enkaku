# Plan 129 — M94 : An inspector that admits when it failed, and a picker you can see

> Status: implemented (software) — **129.1, 129.2, 129.3, 129.5, 129.6, 129.7 and 129.8 all land; 129.4 is deliberately not started.** Opened 2026-08-26 from a live debugging session on the owner's 20-device farm (20 × SM-F721U1, **Android 16 / API 36**); every number in §0 was measured over `/ws` against that farm rather than reasoned about. **The inspector fails honestly now**: `UiServerWatchdog.start()` throws instead of resolving after a `waitReady()` that never succeeded, so `createInspectorForSession`'s long-existing `uiautomator-dump` fallback is finally reachable — it never was, which is why a farm whose ui-server never starts saw a 32-second attach report `ready` and then fail every dump in 5 ms against a port nothing was listening on. **And it stops lying about why**: a connection refused in 5 ms no longer reports itself as a 20-second timeout, a sentence that sent this investigation's own first pass down a wrong path (§0.3) — that wrong fix was written, measured, and discarded. **The Inspect tab names the engine it actually got** and says when the session fell back. **Plugins can be handed Studio's own components** through the host-module table `@enkaku/ui` already uses (`@enkaku/host`), which is what makes a live-tile picker possible without moving Studio's WebSocket or video code into a framework-agnostic package; `DeviceWallWithPicker` is built on the existing `Wall`/`WallTile` and inherits their live-tile budget, and `mikrotik-routing@0.9.0` uses it. **NOT verified on hardware, and the root cause is untouched**: nothing here explains why ui-server does not start on API 36 (§5 step 129.4, §9 Q1) — this plan only stops that failure from masquerading as success, at the cost of the farm running on the slower dump engine (334–584 ms per dump against ~80 ms). §7 names what still needs a device. **Six defects were found by the workers implementing this**, recorded in §10 — including a `build:packs` blocker that no earlier step could have caught, an ambient `.d.ts` that was broken by construction and failed in a file other than itself, and one false premise in this plan's own step list that its author wrote from memory instead of from the code.
> Depends on: plan 06 (M4.5, the ui-server inspector), plan 34 (§3.2, the instrumentation streaming lane), plan 41 (§3.2, the on-device artifact expectation), plan 56 (§3.7, inspect is control-grade), plan 85 (§3.5, the stale-forward retry — whose diagnosis this plan corrects), plan 111 (§3.2, the plugin host module table), plan 124 (§0.2, "the worst surface in the product").
> Spec references: §7.9 (driver layers — the inspector layer), §11.6 (plugin screens), §19 (Device detail, Inspect).
> Ships: packages/studio/src/components/host/DeviceWallWithPicker.tsx

---

## 0. Evidence

Everything in this section was measured against the owner's live farm on 2026-08-26, over `/ws`, read-only. No adb command was issued: the box is a sealed phone farm on OTG with no physical screen, where a disconnect costs a hardware teardown.

### 0.1 The inspector reports `ready` for a server that is not there

One `inspect.attach` on device #1, with `device.inspector.status` broadcasts captured on the same socket:

| t | event |
|---|---|
| 16 ms | `device.inspector.status` → `starting` |
| 15 532 ms | `device.inspector.status` → `restarting`, reason **"the server was not ready within the start timeout"**, attempt 1 |
| 31 986 ms | `inspect.attach` replies **`state: 'ready'`** |

**`healthy` is never broadcast.** Three attaches across two devices measured 31 957 ms, 32 010 ms and 31 986 ms — the constant is `startTimeoutMs` (15 s) paid twice, once by `start()` and once by its single restart cycle, plus launcher overhead.

Immediately after that `ready`, three consecutive dumps on the same session:

| attempt | elapsed | error |
|---|---|---|
| 1 | **141 ms** | `The socket connection was closed unexpectedly` |
| 2 | **5 ms** | `Unable to connect. Is the computer able to access the url?` |
| 3 | **5 ms** | `Unable to connect. Is the computer able to access the url?` |

`Unable to connect` in 5 ms is a refused connection: **nothing is listening on the forwarded port.** The ui-server never came up, the attach said it had, and every dump afterwards fails instantly.

### 0.2 Why the fallback that exists for exactly this never fires

`createInspectorForSession` (`session/inspector-factory.ts`) already has the right shape — a `try` whose `catch` logs, calls `onFallback`, and returns `dumpHandle()`. It is unreachable in this scenario:

```ts
async start() {
  setStatus({ state: 'starting' })
  await opts.launcher.start(opts.localPort)
  if (await waitReady()) { healthy = true; setStatus({ state: 'healthy' }) }
  else { await restart('the server was not ready within the start timeout') }   // ← result never checked
  if (!timer && !dead) { /* ping timer */ }
}                                                                                // ← resolves either way
```

`start()` resolves whether or not the server ever answered. `isDead()` is then false — the breaker allows three cycles per ten minutes and exactly one was spent — so the factory's `if (inspector.isDead()) throw` does not fire either. A `ui-server` handle is returned for a dead ui-server, and `uiautomator-dump` — which works on these phones — is never reached.

### 0.3 The error message names a timeout that did not happen

`client.ts:95` builds every failure the same way:

```ts
throw new UiServerClientError('UI_SERVER_UNREACHABLE', `${url} did not respond within ${timeoutMs}ms: ${String(err)}`, { cause: err })
```

So a connection refused in 5 ms is reported as *"did not respond within 20000ms"*. That sentence is what the owner pasted, and it is what sent the first pass of this investigation hunting a timeout budget — a wrong fix that was written, measured against the farm, and discarded. A diagnostic that lies costs more than one that is missing.

### 0.4 The picker was solved for the wrong problem

The MikroTik group editor's "Add a device…" was a one-at-a-time `<Combobox>`. An earlier pass replaced it with the shared list-style `DevicePicker` (search, tag chips, multi-select), which is strictly better and still not the ask. The owner's words: *"saya minta device selector nya pas add device ada popup untuk device list kaya walls gitu, jadi user bisa pilih mau add device sambil lihat screen castnya"* — a wall of **live tiles**, chosen by looking at the screen.

The thing that made this look expensive is not true. `plugin-host.ts:9` does `import * as HostEnkakuUi from '@enkaku/ui'` and hands that namespace to plugin modules through `window.__enkaku__.hostModules`. A plugin's `@enkaku/ui` import **is Studio's own live instance**, running inside Studio's page. So a Studio component with a WebSocket video stream can be handed to a plugin without any of the video stack changing packages. §3.4.

---

## 1. Goals

1. `UiServerWatchdog.start()` rejects when the server never became ready, so `createInspectorForSession`'s existing fallback runs and the session gets `uiautomator-dump` instead of a dead `ui-server`.
2. `inspect.attach` never answers `ready` for an inspector that cannot serve a dump.
3. Every ui-server client error states what actually happened — a refused connection says so, and only a real timeout names a timeout, with the elapsed time it really took.
4. A degraded session is visible: the Inspect tab names the engine actually in use and says when it fell back.
5. Studio can hand components to plugin UIs through the existing host-module table, without moving Studio's WS or video code into `@enkaku/ui`.
6. The MikroTik group editor picks devices from a **wall of live tiles** showing number, name, stableId and the live screen.
7. Nothing above needs a device to be touched with adb to be believed: each is covered by a test, and §7 says exactly what still needs hardware.

## 2. Non-goals

- **Making ui-server work on Android 16.** §5 step 129.4 is a diagnosis, not a fix: it requires adb against a sealed OTG farm and is gated on the owner. This plan's job is that a broken ui-server degrades honestly to a working engine, which is what the farm needs today regardless of the root cause.
- Changing `startTimeoutMs`, the restart budget or the ping cadence as a *tuning* exercise. §3.2 changes when a start is declared failed; it does not retune the numbers.
- Video for remote (node-owned) devices in the wall picker — `RemoteSessions` exposes no display source, and §3.4's tile falls back to a static row there.
- Replacing the list-style `DevicePicker`. Both stay: a wall is right when you are choosing by looking, a list is right when you are choosing by name in a dialog that has no room for tiles.

## 3. Context and design decisions

### 3.1 The bug is a swallowed failure, not a slow start

32 seconds is a symptom of two 15-second waits, and shortening them would only make the lie arrive sooner. The defect is that `start()` has two exits and reports success on both. Fixing it turns a silent, permanent breakage into a visible, self-correcting degradation — the fallback engine is slower (334–584 ms per dump against ui-server's ~80 ms, `sdk/src/types.ts:178`) but it works on these phones today.

### 3.2 Fail the start, and fail it once

`start()` gains one rule: if the server is not healthy when the start sequence ends, it throws. Deliberately not "retry harder" — the restart cycle inside `start()` already spends 15 more seconds, and the breaker's remaining budget belongs to the watchdog's *runtime* recovery (a server that dies an hour later), not to a start that has already failed twice.

**The initial start therefore stops after the first `waitReady()` fails.** The restart cycle it currently runs is moved off the start path: it buys a second 15-second wait that has never once succeeded on this farm, and it doubles the time before the working engine takes over. An attach that falls back in ~15 s beats one that lies in ~32 s.

### 3.3 An error must not invent a number

`fetchWithTimeout` learns to tell its two failures apart:

- The request was aborted by `AbortSignal.timeout` → `${url} did not respond within ${timeoutMs}ms` — true, and worth naming.
- Anything else → `${url} failed after ${elapsedMs}ms: ${cause}` — the elapsed time actually measured.

`isStaleForwardError` keeps matching on the cause, not the message, so plan 85's retry is unaffected.

### 3.4 Plugins get Studio components through the door that already exists

`plugin-host.ts` already shims `react`, `react-dom`, `react/jsx-runtime` and `@enkaku/ui` into plugin modules from Studio's own imports. Adding one more specifier — `@enkaku/host` — costs a table entry and gives a plugin access to components that are *only* meaningful inside Studio: ones that talk to `/ws`, hold a lease, or decode video.

This is the right seam, and it is the opposite of the previous round's mistake. Moving `DevicePicker` into `@enkaku/ui` was correct because that component is pure. Moving `LiveView` there would not be: it reaches `@/lib/ws`, Studio's singleton socket, and dragging that into a framework-agnostic package would make the package lie about what it is.

`@enkaku/host` is therefore explicitly the home for "Studio's own, offered to plugins" — and its first export is the wall picker.

### 3.5 The wall picker

`DeviceWallWithPicker` (Studio): the existing `Wall` tile grid in a dialog, with selection. It reuses `WallTile` — so it inherits the live-tile budget, the sleeping/offline/quarantined placeholders, and the number/name/stableId identity already rendered there. A plugin opens it, gets back the chosen device ids, and never touches a socket.

The live-tile cap matters and is not new: `Wall` already streams only a bounded subset (`wall.maxTiles`) and promotes on demand. Twenty tiles in a dialog obey the same budget as twenty on the Devices page.

### 3.6 What must keep working

- A farm where ui-server *does* start sees no change at all: `waitReady()` succeeds, `healthy` is set, nothing throws.
- `uiautomator-dump` sessions are unaffected — the factory returns before any of this.
- The list-style `DevicePicker` and every current caller stay exactly as they are.
- A plugin that imports only `@enkaku/ui` keeps working; `@enkaku/host` is additive.

---

## 4. Technical design

### 4.1 `watchdog.ts`

```ts
async start() {
  setStatus({ state: 'starting' })
  await opts.launcher.start(opts.localPort)
  if (!(await waitReady())) {
    // No restart cycle here — see §3.2. The breaker's budget is for runtime
    // recovery, and a second 15s wait has never once turned into a healthy
    // server on the farm this was measured against.
    setStatus({ state: 'dead', reason: 'the server was not ready within the start timeout' })
    throw new Error('ui-server was not ready within the start timeout')
  }
  healthy = true
  setStatus({ state: 'healthy' })
  if (!timer && !dead) { /* ping timer, unchanged */ }
}
```

`dead` is set alongside, so a caller that ignores the throw still reads `isDead()` as true.

### 4.2 `client.ts`

```ts
private async fetchWithTimeout(url, init, timeoutMs): Promise<Response> {
  const startedAt = Date.now()
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const elapsed = Date.now() - startedAt
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    const detail = timedOut ? `did not respond within ${timeoutMs}ms` : `failed after ${elapsed}ms`
    throw new UiServerClientError('UI_SERVER_UNREACHABLE', `${url} ${detail}: ${String(err)}`, { cause: err })
  }
}
```

### 4.3 `ws-handlers.ts` — attach

**Verified during 129.3, and the second hypothesis is the true one.** `createInspectorForSession` (`inspector-factory.ts:129-148`) catches 129.1's throw, calls `onFallback`, and returns `dumpHandle()` — it never rethrows. So `session.inspector` is set to a `UiautomatorDumpInspector` (non-null), `session.inspectorEngineId` is `uiautomator-dump`, `inspectorCapabilities('uiautomator-dump')` includes `dump`, and `inspect.attach` replies `ready` for the fallback engine.

Acceptance criterion 3 therefore holds — but for the opposite reason to the one first written here: not because attach reports `unavailable`, but because the dump engine **genuinely can dump**. The `unavailable` branch is never reached in this scenario at all. The work is what the second sentence said: make the Inspect tab name the engine it actually got.

Yesterday's `INSPECT_ATTACH_DEADLINE_MS` (45 s) stays: bounding an unbounded await was right for its own reasons. With §3.2 the attach now settles in ~15 s, well inside it.

### 4.4 `plugin-host.ts`

`SHIMMED_SPECIFIERS` gains `'@enkaku/host'`; `hostModules()` gains `'@enkaku/host': HostEnkakuHost`, where `HostEnkakuHost` is `import * as … from '@/components/host'` — a new Studio barrel exporting `DeviceWallWithPicker` and nothing else for now. `enkaku-host.d.ts` (the plugin-side type shim named in `plugin-host.ts:58`) is updated in the same change so a plugin author gets types.

### 4.5 `DeviceWallWithPicker` (Studio → `@enkaku/host`)

```ts
interface DeviceWallPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Ids already in the group — shown selected and returned unchanged unless deselected. */
  value: string[]
  onConfirm: (ids: string[]) => void
  /** Optional filter, e.g. the plugin's own "not already assigned" rule. */
  filter?: (device: DeviceInfo) => boolean
  title?: string
}
```

It fetches `/api/devices` itself (Studio-side, same origin) so a plugin passes no device list at all.

---

## 5. Implementation steps

### 129.1 — The watchdog fails a start that never became ready
- `packages/drivers/src/inspector/ui-server/watchdog.ts` per §4.1.
- Tests (`watchdog.test.ts`, extend): a start whose ping never succeeds **throws** and leaves `isDead()` true; a start whose ping succeeds behaves exactly as before; the runtime restart path (ping-timer-triggered) is unchanged and still uses the breaker.
- **Result:** `bun test packages/drivers/src/inspector/ui-server/` green.

### 129.2 — Errors stop naming a timeout that did not happen
- `packages/drivers/src/inspector/ui-server/client.ts` per §4.2.
- Tests (`client.test.ts`, extend): a refused connection reports `failed after <n>ms` and never the string `did not respond within`; a genuine `AbortSignal.timeout` reports `did not respond within`; `isStaleForwardError` still matches a stale-forward cause after the message change (it reads `err.cause`, so this is a regression guard, not a new behaviour).
- **Result:** same directory green.

### 129.3 — The session says which engine it actually got
- Verify §4.3's assumption against the code first and report what is true.
- `packages/studio/src/components/InspectorPanel.tsx`: when `engineId` is `uiautomator-dump`, say so in one line, and if the session fell back name that. **Correction (§10 item 4): the claim that "nothing renders `device.inspector.fallback` today" was false** — `DeviceHeader.tsx` has rendered it since plan 34. The real gap is narrower and is this: the Inspect tab BODY, where the operator is actually reading a possibly-degraded tree, said nothing beyond a bare engine id and never listened for the broadcast.
- Tests: the panel renders the engine line for both engines; a fallback broadcast is surfaced rather than dropped.
- **Result:** `bun run --cwd packages/studio test src/components/InspectorPanel*` green.

### 129.4 — Why ui-server does not start on Android 16 *(diagnosis, owner-gated)*
**Not implementable without adb against the farm, and therefore not assigned to a worker.** What to collect, in order, once the owner approves each: the core log lines from a failed start (`ui-server instrumentation … ended unexpectedly`, `restart attempt 1/3`), then `pm list packages | grep uiautomator`, then a manual `am instrument -w -r -e debug false -e class …` to see the actual failure. Suspicion on record: all 20 devices are **API 36** and the pinned ui-server is 2.3.3 (uiautomator2 lineage); an instrumentation that does not support API 36 would present exactly like this. Recorded as §9 Q1.

### 129.5 — A host-module surface for Studio components
- `packages/studio/src/components/host/index.ts` (new barrel), `plugin-host.ts` per §4.4, and the plugin-side `enkaku-host.d.ts`.
- Tests (`plugin-host.test.ts`, extend): `@enkaku/host` is in the shim table and resolves to the barrel; a plugin module importing it receives the same React instance (the `Invalid hook call` guard plan 111 T4 already tests for `@enkaku/ui`).
- **Result:** `bun run --cwd packages/studio test src/lib/plugin-host.test.ts` green.

### 129.6 — The wall picker
- `packages/studio/src/components/host/DeviceWallWithPicker.tsx` per §4.5, built on the existing `Wall`/`WallTile`.
- Tests: renders tiles for the fetched devices; selection accumulates and `onConfirm` returns it; `filter` is honoured; a device already in `value` starts selected.
- **Result:** `bun run --cwd packages/studio test src/components/host/` green.

### 129.7 — The MikroTik editor uses it, and the pack ships
- **First**: add the `declare module '@enkaku/host'` block to `plugins/mikrotik-routing/src/enkaku-host.d.ts`. Step 129.5's worker found that this ambient file exists in THREE copies — the SDK scaffold (`packages/sdk/src/cli/init.ts`'s `hostTypes()`, updated in 129.5 and the canonical source for every new plugin) plus one hand-copied instance in each of `plugins/proxy-manager` and `plugins/mikrotik-routing`. `plugin-host.ts:58`'s comment names the file in prose and reads as if there were one. Without this the plugin's `groups.tsx` cannot import from `@enkaku/host` and will not typecheck. §4.4 implied it; it was not an action item until now.
- `plugins/mikrotik-routing/src/ui/parts/groups.tsx`: replace the list picker added in the previous round with a button opening `DeviceWallWithPicker`.
- **Bump `0.8.0 → 0.9.0` in all three sites** (`package.json`, `src/index.ts`'s `version:`, `src/index.test.ts`'s assertion), add the changelog row beside the others, then `bun run build:packs`. `seedEmbeddedPacks` keys on `${name}@${version}`; without the bump the farm keeps serving the old bundle — the failure mode plan 124 §0.2 and the 0.8.0 row both already record.
- **Result:** plugin tests green; `bun run build:packs` lists `mikrotik-routing@0.9.0`.

### 129.8 — Docs
- `docs/spec.md` §7.9: an inspector that cannot start falls back, and how that is surfaced; §11.6: `@enkaku/host` as the plugin-facing Studio component surface.
- `packages/drivers/README.md`: the start-vs-runtime distinction in the watchdog.
- Update this plan's status line; `bash scripts/check-plan-status.sh` passes.

---

## 6. Acceptance criteria

1. A ui-server whose ping never succeeds makes `start()` throw, `isDead()` true, and the factory return `uiautomator-dump` — proven by test, not by inspection.
2. No client error contains `did not respond within` unless the request was genuinely aborted by its timeout; a refused connection reports the real elapsed time.
3. `inspect.attach` never reports `ready` for a session whose inspector cannot dump.
4. The Inspect tab names the engine in use, and says when the session fell back.
5. A farm where ui-server starts normally sees no behavioural change (test: healthy path untouched).
6. `@enkaku/host` reaches plugin modules through the same table `@enkaku/ui` uses, sharing Studio's React instance.
7. The MikroTik group editor opens a wall of live tiles and returns the selected ids.
8. `mikrotik-routing` is at 0.9.0 in all three sites, with a changelog row, and `build:packs` emits it.
9. `bun run typecheck` passes; every test file touched passes.
10. `docs/spec.md` updated (DoD 8); `check-plan-status.sh` passes (DoD 6); no process left running (DoD 7).

## 7. Test plan

Unit tests are named per step. **What still needs hardware, and is not claimed until it is done:**

- Criterion 1's real-world half: attach on a farm device and confirm the Inspect tab now falls back to `uiautomator-dump` and renders a tree, in roughly 15 s rather than failing at 32 s. The measurement to repeat is §0.1's: `inspect.attach` timing plus the `device.inspector.status` broadcasts.
- Criterion 7: the wall picker against 20 live devices — tile budget, scroll, and whether picking by screen is actually faster than picking by name.
- §5 step 129.4 in full.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Failing the start makes a farm where ui-server is merely *slow* (>15 s but healthy) fall back permanently, losing the fast engine. | The watchdog's ping timer still runs on the dump engine's session? **No — it does not**, and this is the honest cost: the session keeps `uiautomator-dump` until it is rebuilt. §9 Q2 asks whether a later promotion back to ui-server is worth building. On the farm measured here the server never came up at all, so the trade is strictly positive today. |
| R2 | `@enkaku/host` becomes a dumping ground that couples every plugin to Studio internals. | It exports exactly one component, and its barrel is the enforcement point: adding to it is a deliberate edit to a file whose whole purpose is to be small. |
| R3 | Live tiles in a dialog multiply video streams. | `Wall` already owns a bounded live set; the dialog reuses it rather than introducing a second budget. |
| R4 | The plugin pack ships without the version bump and nothing reaches the farm. | 129.7 makes the bump part of the same step as the edit, and criterion 8 checks all three sites. It has already happened twice (plan 124, and 0.8.0). |

## 9. Open questions

1. **Why does ui-server not start on API 36?** The whole of §5 step 129.4. Until answered, this farm runs on `uiautomator-dump` — correct, and slower.
2. **Should a fallen-back session ever be promoted back to ui-server** without being rebuilt? Not built here (R1).
3. **Does the wall picker belong on the Devices page too** — "select devices by looking" is not a plugin-specific need. Deferred until the plugin's version has been used.

4. **Should the `@enkaku/host` ambient declaration be checked against the barrel?** §10 item 2 is a drift that no build can catch, because the declaration is hand-written in three places and `@enkaku/host` is never published. A generator, or a test that parses the barrel's exports and asserts the scaffold declares each one, would close it — neither is built here.

5. **Should `packages/drivers`' tests run isolated?** §10 item 3's flake comes from a global monkey-patch in a shared process. Studio passes `--isolate` for exactly this class of problem. Doing the same here would cost start-up time on every run; not decided.

## 10. Notes recorded during execution

1. **`enkaku-host.d.ts` is three files, not one.** `plugin-host.ts:58` refers to it in prose, singular. It exists as the SDK scaffold template (`sdk/src/cli/init.ts`'s `hostTypes()`) plus a hand-copied instance in each of `plugins/proxy-manager` and `plugins/mikrotik-routing`, with no shared package the two sides import from — `@enkaku/host` is never published, so the ambient declaration is duplicated by construction. Step 129.5 updated the scaffold only, deliberately; step 129.7 now carries the mikrotik copy as an explicit first action. — step 129.5's worker.

2. **The ambient declaration and the barrel drifted apart between two steps.** 129.5 stamped `HostPlaceholder` into the SDK scaffold; 129.6 replaced it with `DeviceWallWithPicker` in the barrel but was scoped out of the SDK file, so for a while the type a plugin author would have imported did not exist. Neither worker was wrong — each obeyed its own scope, and 129.6's worker flagged it rather than reaching outside. Reconciled by the coordinator. The underlying cause is item 1: **nothing checks this declaration against the real barrel**, because `@enkaku/host` is never published, so there is no shared package both sides import from. A drift like this cannot fail a build; it can only be noticed. §9 Q4 asks whether that is worth closing.

3. **The drivers test directory has a pre-existing cross-file flake, and it is in the mandated command.** `client.test.ts`'s `captureAbortTimeouts()` monkey-patches the global `AbortSignal.timeout` with no isolation, and `bun test packages/drivers/src/inspector/ui-server/` runs all seven files in ONE process (no `--isolate`, unlike Studio's script). 129.1/129.2's worker measured a real ~1-in-15 bleed under load, reproducing with and without their changes, and left it alone as out of scope — correctly. It is recorded here so the next person to see a red run in this directory checks for the bleed before assuming a regression. §9 Q5.

4. **The plan asserted a gap that did not exist.** §5 step 129.3 said `device.inspector.fallback` "is already broadcast and nothing renders it". `DeviceHeader.tsx` has rendered it since plan 34 — as a warning chip in the device header and inside the active-engines popover, wired through `app/device/page.tsx` and `DevicePopup.tsx`. 129.3's worker traced it, said so, and narrowed the step to the real gap (the Inspect tab body itself) instead of building a duplicate of something that already worked. The false premise was the coordinator's, written from memory rather than from the code — the same failure mode this plan's own §0.3 complains about in an error message.

5. **`build:packs` could not build any plugin that imports `@enkaku/host` — a real blocker, not a tidy-up.** `UI_EXTERNALS` (`sdk/src/cli/build-ui.ts:99`) lists the specifiers Studio's import map serves; `@enkaku/host` was not among them, so Bun's bundler tried to RESOLVE it, found no such package on disk (it is never published), and failed the whole run with `Could not resolve: "@enkaku/host"`. Steps 129.5 and 129.6 were both correct on their own and neither could have caught it: the shim table and the component were fine, and nothing built a plugin UI that imported it until 129.7. Found and reported by 129.7's worker, who correctly refused to reach outside `plugins/mikrotik-routing/` to fix it; fixed by the coordinator, after which `build:packs` emits `mikrotik-routing@0.9.0`.

6. **The scaffold's ambient `.d.ts` was broken by construction, and it fails somewhere else entirely.** A `.d.ts` with any top-level `import`/`export` is a MODULE, and `declare module '@enkaku/host'` inside a module is module *augmentation* — it silently requires the module to already resolve, which `@enkaku/host` never can. The error then lands on every file that imports it and never on the declaration itself. `hostTypes()` shipped with exactly that shape in 129.5. Rewritten to use inline `import('pkg').X` types with no top-level import/export, and `Window` augmented directly (`declare global` is unavailable for the same reason — it requires the file to be a module). Verified by `publish.test.ts`, which runs `tsc --noEmit` over a freshly scaffolded plugin. **One trap while fixing it**: making `__enkaku__` optional in the rewrite broke every generated plugin with TS18048, because the scaffold's own entry calls `window.__enkaku__.register(...)` unguarded — the field is deliberately non-optional and now says so. — reported by 129.7's worker, fixed and re-broken-and-fixed by the coordinator.
