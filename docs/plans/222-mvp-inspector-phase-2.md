# Plan 222 — MVP wave 4 : Inspector phase 2 — `ui-tree` becomes the default engine and `waitFor` stops polling

> Status: implemented (software) — G12 and G15-G18 are owner rows (no lab device in this environment); every other §0 row passes by its named command. See §11 for the handoff report.
> Depends on: plan 221 (the guest agent's `ui-tree` facet: `ui.dump` / `ui.find` / `ui.watch` / `ui.unwatch` / `ui.status`, the `UiDumpResult` / `UiFindResult` / `UiChangedEvent` schemas, `GuestAgentClient.uiDump` / `uiFind` / `uiStatus`, `createGuestAgentWatch`, `ensureAccessibilityEnabled`), plan 208 (inspector phase 1: the session-scoped lifecycle, `prewarmInspector`, `E_INSPECTOR_STARTING`, `Inspector.lastDump?()`, the fixed capability path, the attach-to-running WS handlers), plan 200 (rules, format, references R1..R8).
> Spec references: `docs/mvp/02-inspector-readiness.md` §4 phase 2 (entire, the scope) and its "Spec impact" paragraph, §2.5 and §2.6 (the two root causes this plan closes), `docs/mvp/10-guest-agent.md` §1.1, `docs/mvp/13-removal-register.md` A.9 (the third row, the `instrumentation` lock conflict), `docs/mvp/16-consolidated-plan.md` §2 Inspector row and §3 wave 4. External facts: R4 (restricted settings, through plan 221's enablement), R5 (openatx releases, through plan 208's pin decision).
> Ships: packages/drivers/src/inspector/ui-tree/inspector.ts

---

## 0. Goal checklist

Every command runs from the repo root. `GREP_222` is the one gate grep, defined once in §10 and copied verbatim wherever it is cited. Rows marked `owner` need the lab device (Android 16 / API 36) or the owner's farm.

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A watch-backed `waitFor` resolves on the push, not on a poll | a condition true at t = 300 ms resolves by t = 400 ms, with exactly **2** `findDetailed` calls (the immediate evaluation plus the one after the event) | `bun test packages/session/src/device-executor.test.ts` → test `waitFor resolves from the watch event with no intermediate find` passes | [x] |
| G2 | A condition already true resolves with one evaluation and no wait | 1 `findDetailed` call, elapsed `< 50 ms`, and `watch()` is never called | `bun test packages/session/src/device-executor.test.ts` → test `waitFor evaluates once before subscribing and returns at once when the condition already holds` passes | [x] |
| G3 | An engine with no `watch` still polls at the engine interval | `Math.min(intervalMs, session.inspectorPollIntervalMs)` on `ui-server` and `uiautomator-dump` | `bun test packages/session/src/device-executor.test.ts` → test `waitFor falls back to the clamped poll on an engine with no watch` passes | [x] |
| G4 | The safety-net re-check exists and is bounded | `WAITFOR_WATCH_RECHECK_MS === 1_000`; a watch that never fires still re-evaluates | `bun test packages/session/src/device-executor.test.ts` → test `a watch that never fires still re-checks every WAITFOR_WATCH_RECHECK_MS` passes | [x] |
| G5 | The ladder picks `ui-tree` when the agent is ready and the service is on | `agentStatus.state === 'ready'` and `capabilities` contains `ui-tree` and `uiStatus().enabled && .connected` | `bun test packages/session/src/inspector-factory.test.ts` → test `the ladder picks ui-tree when the agent is ready and the service is enabled and connected` passes | [x] |
| G6 | The ladder falls to `ui-server` on each of the four ways `ui-tree` can be unavailable | agent not `ready`; capability absent; `ui.status` not enabled; `ui.status` not connected | `bun test packages/session/src/inspector-factory.test.ts` → tests `... falls back to ui-server when the agent is not ready`, `... when the ui-tree capability is absent`, `... when the service is not enabled`, `... when the service is enabled but not connected` pass | [x] |
| G7 | The ladder still falls to `uiautomator-dump` when ui-server cannot start | `engineId === 'uiautomator-dump'` and two `onFallback` calls, `ui-tree → ui-server` then `ui-server → uiautomator-dump` | `bun test packages/session/src/inspector-factory.test.ts` → test `both rungs failing reaches uiautomator-dump and reports both hops` passes | [x] |
| G8 | The `ui-tree` engine descriptor takes no `instrumentation` lock | `engineDescriptors.find(d => d.id === 'ui-tree').locks` deep-equals `[]`; `validateEngineSelection` with `inspection: 'ui-tree'` and every input engine returns `{ ok: true }` | `bun test packages/protocol/src/registry.test.ts` → test `ui-tree holds no lock, so no inspector/input combination conflicts` passes; `rg -n "locks: \['instrumentation'\]" packages/drivers/src/descriptors.ts` → exactly 2 lines (`ui-server`, `uiautomator-dump`) | [x] |
| G9 | `ui-tree` is the default engine, and stored `ui-server` rows are migrated | `devices.inspection` default is `'ui-tree'`; 0 rows left with `inspection = 'ui-server'` after the migration; `devices.settings` and `farm_settings` JSON rewritten with it | `bun test packages/core/src/db/inspection-migration.test.ts` → test `every stored ui-server engine becomes ui-tree, in all three places` passes | [x] |
| G10 | The engine actually in use is reported, not the configured one | `GET /api/devices/:id` carries `liveInspection`, sourced from `session.inspectorEngineId`, `null` with no session | `bun run typecheck` → exit 0; `rg -n "liveInspection" packages/protocol/src/api/devices.ts packages/core/src/api/devices.ts` → at least one hit in each | [x] |
| G11 | The SDK cost comments carry no engine-agnostic claim, and name the blanks the owner fills | 0 matches for the old claims; exactly 3 `TBD-222-` tokens | `rg -n "realistic for uiautomator-dump\|by comparison" packages/sdk/src/types.ts` → empty; `rg -c "TBD-222-" packages/sdk/src/types.ts` → `3` | [x] |
| G12 | The three SDK blanks are filled with measured numbers | no `TBD-222-` token remains | owner, after §7.4 step 6 | owner |
| G13 | The unconditional 80 ms poll clamp is gone from `waitFor` | 0 matches | `rg -n "Math\.min\(call\.args\.intervalMs" packages/session/src` → empty | [x]† |
| G14 | The spec says the ladder is agent → ui-server → dump, in the section plan 202 created | §8 Inspector carries decided text with no `TBD by plan`; §5.1's inspector row names `ui-tree` as the default | `rg -n "TBD by plan 222\|plans 221 and 152" docs/spec.md` → empty; `rg -n "ui-tree" docs/spec.md` → at least 3 lines | [x] |
| G15 | A script's `find` p95 is under 200 ms on `ui-tree` | `find() p95` row `< 200 ms` with `--engine ui-tree` | owner: `ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video --engine ui-tree` | owner |
| G16 | A `dump` on `ui-tree` costs what the owner measures, and the number is written down | the `dump() latency` row is pasted into §11 and into the SDK comment (G12) | owner, same run as G15 | owner |
| G17 | `waitFor` on the lab device resolves within 100 ms of the screen changing | p95 of (event-to-resolve) over 20 changes `< 100 ms` | owner: `ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video --engine ui-tree --waitfor-cycles 20` prints `waitFor push p95: <N> ms`, N < 100 | owner |
| G18 | The engine named in the UI is the engine used | the Inspect tab's `inspect.status.engineId` and `GET /api/devices/:id`'s `liveInspection` both read `ui-tree` on a device running it, and both read `ui-server` on a device that fell back | owner, §7.4 step 8 | owner |
| G19 | `bun run typecheck` is clean | 0 errors | `bun run typecheck` → exit 0 | [x] |
| G20 | The forbidden words of §10 are gone from this plan's area | 0 matches | `GREP_222` (§10) → empty | [x]† |

† See §11 discrepancies: the literal grep also matches "release" (substring "-lease-"), the same false-positive plan 221's own §11 already documented for its own `GREP_221`; and G13's clamp survives inside the no-watch poll branch by design (§10's own row already says so in prose), never at the top of the case.

## 1. Goals

1. A first-party inspector engine, `ui-tree`: `packages/drivers/src/inspector/ui-tree/inspector.ts`, implementing the **same** `Inspector` interface every other engine implements, over the guest agent's control channel using plan 221's `ui.dump` / `ui.find` / `ui.watch` / `ui.status`. Same data source, same node schema, so every selector and every consumer carries over unchanged (MVP 02 §4 phase 2, MVP 10 §1.1).
2. **`waitFor` stops polling.** The executor subscribes to the agent's change stream, evaluates the condition once immediately so a condition that is already true resolves at once, and then awaits the next change event with the caller's timeout as the ceiling. This is the structural fix for "the script waits for our system to see the UI" (MVP 02, the complaint as reported).
3. The engine ladder becomes **agent → ui-server → dump**, evaluated once per session, with every hop reported: `device.inspector.fallback` on the wire, `session.degraded` in the device event log, `inspect.status.engineId` in the Inspect tab, and `liveInspection` on `GET /api/devices/:id`. A degraded farm must be visible without reading a log file (MVP 02 §4 phase 2, last bullet; the honest-degradation rule plan 129 established).
4. The `instrumentation` lock stops being on the default path: the `ui-tree` descriptor takes no lock at all, so MVP 13 A.9's third row is closed. `am instrument` is not run for an inspector on a device whose agent works.
5. `ui-server` stays as the fallback engine for a device where the agent cannot be installed or its accessibility service cannot be enabled (R4's OEM caveat, carried by plan 221 §4.10), and `uiautomator dump` is demoted to last resort. Neither is deleted.
6. The SDK's documented costs stop asserting one engine's numbers as if they were the product's: the `~80 ms` find and `334 to 584 ms` dump are attributed to the engine they were measured on, and the `ui-tree` numbers are blanks the owner fills from the bench (G12).
7. The spec sections plan 202 marked `TBD` are written: §8 Inspector gains the first-party engine and the event-driven `waitFor`; §5.1's driver-layer table names `ui-tree` as the default and the ladder as agent → ui-server → dump.

## 2. Non-goals

| Not done here | Plan that does it |
|---|---|
| The APK side: `UiTreeService`, `UiTreeWatch`, `UiTreeState`, the accessibility enablement over adb, the `ui.*` wire schemas, `GuestAgentClient.uiDump`/`uiFind`/`uiStatus`, `createGuestAgentWatch` | plan 221 |
| The session-scoped lifecycle, `prewarmInspector`, `whenInspectorReady`, `E_INSPECTOR_STARTING`, `Inspector.lastDump?()`, the fail-fast instrumentation parser, the openatx configurator, the ui-server pin | plan 208 |
| Deleting `ui-server` (its launcher, watchdog, lifecycle, manifest entries) or `uiautomator-dump`. Both stay: they are rungs 2 and 3 | nothing in the MVP removes either |
| Adding element actions (`setText` / `longClick` / `doubleClick`) to the agent. `ui-tree` deliberately does not implement `InspectorElementActions`; §3.7 says what that costs and why it is acceptable | nobody; §9 Q3 asks whether the owner wants it |
| A runtime engine swap when a live `ui-tree` service is killed mid-session. The ladder is evaluated once per session, exactly as plan 208 left it | §9 Q4; nothing in the MVP |
| Studio: the Inspector tab inside Device Control, its engine badge and its fallback copy. This plan changes **no** file under `packages/studio` or `packages/ui`, and writes no test there (plan 200 §8.3) | plan 215 |
| The per-device settings row that lets an operator pin an inspector engine | plan 212 (Settings) and plan 219 (the page) |
| Serialising installs, the 20-device and 100-device scale runs, the lifecycle targets | plan 223 |
| Cloud node parity: `packages/node/src/hosts.ts` keeps a factory with no `uiTree` dependency, so a node-owned device stays on the ui-server rung | post-MVP (MVP 16 §1) |
| Sending `uiAutomationFlags` so a ui-server and a `UiTreeService` can be connected at once. This plan makes that unnecessary by never starting both on one device (§3.6) | §9 Q2; the field is a plan 208 §9 Q4 / plan 221 §9 Q2 question and stays open |

## 3. Context and design decisions

### 3.1 What the code does today (verified 2026-09-03; every line quoted so the executor can match on content when the number has drifted)

**The interface every engine implements.** `packages/protocol/src/driver.ts:140-157`, in full:

```ts
/** Engine inspeksi UI (spec §7): `uiautomator-dump` (M4), `ui-server` (M4.5). */
export interface Inspector {
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
  /**
   * `find`, but honest about WHY nothing usable came back (plan 74 §3.4,
   * §4.3) — not-found / rejected-oversized / ambiguous, instead of a bare
   * `null`. Optional, like `InspectorElementActions` above: an engine that
   * cannot tell the difference (or cannot afford to, for a hot polling path)
   * simply does not implement it, and `device-executor.ts` falls back to
   * `find()`'s plain not-found/ok distinction — the union is still exhaustive
   * at every consumer, just less informative for that engine.
   */
  findDetailed?(sel: Selector): Promise<FindOutcome>
}
```

Plan 208 §4.7 adds one optional member, `lastDump?(): { root: UiNode; at: number } | null`. This plan adds one more, `watch?(...)` (§4.1). The doc comment's leading sentence is Indonesian (`Engine inspeksi UI`) and is rewritten in the same edit; the ladder it names is stale as of this plan.

**`ui-server` (`packages/drivers/src/inspector/ui-server/index.ts`).**

- `:47-49`: `readonly id = 'ui-server'` and `/** Queries are cheap → the runner may poll tightly during waitFor. */` `readonly recommendedPollIntervalMs = 80`.
- `:103-122` `dump()` is `parseUiDump(await this.call(() => this.client.dumpWindowHierarchy(false)))` with **one** retry 300 ms later for the post-wake NullPointerException, and `UI_SERVER_UNREACHABLE` rethrown immediately rather than retried (`:118`).
- `:129-139` `screenSize()` resolves the find guard's viewport **at most once per inspector**, caching a failure as `null` so a failing `wm size` is not paid per find.
- `:148-151` `find()` is a narrowing over `findDetailed()`: `return outcome.ok ? outcome.node : null`.
- `:163-187` `findDetailed()`: `{ point }` is answered from `matchSelector({} as UiNode, sel)`; otherwise `objInfo` decides, `isImplausibleMatch` rejects a viewport-sized container as `rejected-oversized` (logged once per selector, `:173-183`), and `ambiguous` is deliberately never returned (`:153-162`: "`objInfo` only ever reports the first match ... so this engine can never honestly report `ambiguous`").
- `:189-191` `screenshot()` is the ui-server HTTP `GET /screenshot/0`.
- `:193-203` `setText` / `longClick` / `doubleClick`, the `InspectorElementActions` this engine has and no other does.

**`uiautomator-dump` (`packages/drivers/src/inspector/uiautomator-dump.ts`).** `:19-20` `readonly id = 'uiautomator-dump'`; `:53-76` `dump()` with 3 attempts 500 ms apart and the literal `could not get idle state` retry at `:64`; `:78-82` `find()` is a **separate implementation** that returns the first depth-first match regardless of the match count, and `:84-98`'s doc comment says exactly why: "a previously published script bundle must keep getting exactly that (criterion 10, plan 62 §3.1)"; `:99-110` `findDetailed()` reports `ambiguous` when `countMatches` is above 1; `:112-114` `screenshot()` is `this.transport.execOut('screencap -p', { profile: 'screencap' })`.

**The factory (`packages/session/src/inspector-factory.ts`).**

- `:15-21` `InspectorHandle` is `{ inspector, engineId, pollIntervalMs, release() }`.
- `:53` `const DUMP_POLL_MS = 500`.
- `:61-65` `createInspectorForSession(deps, { deviceId, transport, requested })`, and `:65` `const requested = opts.requested ?? 'ui-server'`.
- `:66-71` `dumpHandle()`, the only construction of `UiautomatorDumpInspector` left after plan 208.
- `:73` `if (requested === 'uiautomator-dump') return dumpHandle()`.
- `:102-108` the instrumentation stream with both clocks off (plan 208 §4.9 adds `pinned: true` and the `onData` pass-through).
- `:129-130` `await inspector.start()` then `if (inspector.isDead()) throw new Error('the watchdog gave up during start')`.
- `:142-148` the single catch: releases the port, builds `reason`, logs `` `ui-server cannot be used on ${opts.deviceId} (${reason}) — falling back to uiautomator-dump` ``, calls `deps.onFallback?.(opts.deviceId, 'ui-server', 'uiautomator-dump', reason)`, returns `dumpHandle()`.

**The executor (`packages/session/src/device-executor.ts`).**

- `:165` (rewritten by plan 208 §4.10 into an `inspectorOrThrow()` accessor): `const inspector: Inspector = deps.session.inspector ?? new UiautomatorDumpInspector(deps.session.transport)`.
- `:218` `async function findOutcome(sel: Selector): Promise<FindOutcome>`.
- `:390-392` the element-action shortcut: `if (instant && supportsElementActions(inspector) && lastTarget) { await inspector.setText(lastTarget, call.args.text); return { via: 'ui-server-set-text', ... } }`.
- `:472-494` the `waitFor` loop, the code this plan replaces:

```ts
      case 'waitFor': {
        // The polling loop lives in the parent — one call, one meaning, pacing in
        // one place. The interval follows the active engine: ui-server is cheap
        // (~80ms), a dump is expensive.
        const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)
        const deadline = Date.now() + call.args.timeout
        // Plan 74 §3.5, §4.3 — carries the LAST outcome into the timeout
        // error, so "every match was refused as rejected-oversized" reports
        // as that, not a bare timeout (criterion 9).
        let last: FindOutcome = { ok: false, reason: 'not-found', matches: 0 }
        for (;;) {
          const outcome = await findOutcome(call.args.sel).catch((): FindOutcome => ({ ok: false, reason: 'not-found', matches: 0 }))
          if (outcome.ok) return outcome.node
          last = outcome
          if (Date.now() >= deadline) {
            throw new SessionError(
              'waitfor_timeout',
              `waiting for ${JSON.stringify(call.args.sel)} exceeded ${call.args.timeout}ms (last: ${last.reason}, ${last.matches} matches)`,
              { reason: last.reason, matches: last.matches },
            )
          }
          await Bun.sleep(interval)
        }
      }
```

**The session (`packages/session/src/session.ts`).** `:120` `inspector: Inspector | null`; `:178` `inspectorEngineId: string` ("The effective engine id — it can differ from the DB column after a fallback"); `:180` `inspectorPollIntervalMs: number` ("The waitFor polling interval that suits the active engine"); `:498` `.makeInspector(opts.deviceId, transport, opts.inspection ?? null)`; `:502-503` the two fields set from the handle; `:852-855` the initial values (`inspector: null`, `inspectorEngineId: 'starting'`, `inspectorPollIntervalMs: 500`). Plan 208 deletes `releaseInspector` (`:176`, `:510-517`, `:857`) and makes `prewarmInspector` real.

**Where the engine id comes from.** `packages/session/src/manager.ts:554` `inspection: row.inspection` is what reaches the factory; `packages/core/src/db/schema.ts:29` `inspection: text('inspection').default('ui-server')` is the column; `packages/protocol/src/settings.ts:387-391` is the enum an operator picks from:

```ts
        inspection: z
          .enum(['ui-server', 'uiautomator-dump', 'appium'])
          .default('ui-server')
          .describe('How scripts find elements on screen')
          .meta(ui({ title: 'Screen inspection', source: 'registry.inspectors' })),
```

and `:397` `inspection: 'ui-server'` is the block default. `packages/core/src/registry/admission.ts:81` and `packages/core/src/registry/device-registry.ts:472` copy `s.engines.inspection` into the column when a device is admitted, so a farm has the value in **three** places: the column, `devices.settings` JSON, and `farm_settings.value`'s `defaults`.

**The descriptors (`packages/drivers/src/descriptors.ts`).** `:74-81` `ui-server` with `capabilities: ['dump', 'find', 'screenshot', 'set-text', 'long-click', 'double-click']` and `locks: ['instrumentation']`; `:123-131` `uiautomator-dump` with `capabilities: ['dump', 'find', 'screenshot']`, the comment `// It seizes UiAutomation too — it cannot run alongside ui-server or appium.` and `locks: ['instrumentation']`. The file header (`:8-25`) is the rule the new descriptor obeys: `displayName` "must never assert a number nobody has measured as fact", because it is served verbatim by `GET /api/registry`.

`packages/core/src/registry/engines.ts:44-48` marks every descriptor from `@enkaku/drivers` `available: true`; the `PLANNED` array is where an unavailable engine lives. `packages/core/src/server/ws-handlers.ts:117-119` `inspectorCapabilities(engineId)` reads the same array to fill the Inspect tab's reply, and `:2224-2239` refuses the attach when the chosen engine's capabilities do not include `dump`.

**Reporting today.** `packages/protocol/src/messages/enroll.ts:57-64` `device.inspector.fallback` carries `{ deviceId, from, to, reason }`; `packages/core/src/daemon.ts:4035-4038` broadcasts it and records `session.degraded`. `packages/protocol/src/api/devices.ts:70-79` has the precedent this plan copies, `liveDisplay`:

```ts
  /**
   * Plan 100 §4.3, step 100.6 (closes G11/96.22) — the engine ACTUALLY
   * running, sourced live from the open session; `null` when no session is
   * open. Allowed to disagree with `display` above (the CONFIGURED engine) ...
   */
  liveDisplay: z.string().nullable(),
  input: z.string(),
  inspection: z.string(),
```

and `packages/core/src/api/devices.ts:1076` fills it: `liveDisplay: deps.connection?.sessions?.()?.get(row.id)?.displayEngineId ?? null`. There is **no** engine field on `DeviceInfoSchema` (`packages/protocol/src/device.ts:199-...`), the list payload, and this plan does not add one (§3.9).

**The guest agent's host side.** `packages/core/src/network/route-service.ts:412-417`:

```ts
export interface DeviceSession {
  withClient<T>(fn: (client: GuestAgentClient) => Promise<T>, opts?: DeviceSessionCallOpts): Promise<T>
  readonly active: boolean
  close(): Promise<void>
}
```

implemented in `packages/core/src/api/guest-agent.ts:366-494` (`createDeviceSession`), which owns the one pairing token, the claimed port and the client. `:552-575` `withEphemeralSession` reference-counts a shared session per device and closes it when the count reaches zero: "The count is what preserves the old contract: the LAST caller out closes the session and releases the forwarded port". `:755` exposes it as `withGuestAgentClient: (deviceId, fn) => withEphemeralSession(mustGet(deviceId), fn)` on `GuestAgentRoutesHandle`.

**The provisioner's persisted view.** `packages/protocol/src/device.ts:108` `AgentStateSchema = z.enum(['absent', 'provisioning', 'ready', 'outdated', 'failed', 'unsupported', 'consent-required'])`; `:139-151` `AgentStatusSchema` carries `state` and `capabilities: z.array(GuestAgentCapabilitySchema)`. `packages/core/src/device/agent-provisioner.ts:117-138` is the `AgentProvisioner` interface, whose `status(deviceId)` is documented as "The persisted row, Zod-validated — never issues an adb call of its own". That is the cheap half of the ladder's predicate.

**The capability path.** `packages/core/src/capability/device-inspect.ts:30, 49, 84, 121` are the four deadlines (`10_000` find, `15_000` dump, `65_000` waitFor, `10_000` screenshot). They are ceilings for the slowest rung and this plan does not change the numbers (§3.10).

**The SDK's documented costs.** `packages/sdk/src/types.ts:22`:

```ts
  /** Defaults to 1_000 ms — realistic for uiautomator-dump; ui-server (Plan 06) can be far shorter. */
  intervalMs?: number
```

and `:177-183`:

```ts
   * **It costs a full dump: 334–584 ms measured on a moto g06 power** (a
   * `find` is ~80 ms by comparison). Fetch it once and walk the result; do
   * not call it per assertion. Nothing stops you paying repeatedly if you
   * mean to — the cost is stated here rather than enforced.
   */
  dump(): Promise<UiNode>
  /** Polls the inspector — rejects with ScriptError('WAITFOR_TIMEOUT') when time runs out. */
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>
```

`packages/session/src/runner/child-entry.ts:179-183` is the SDK default that reaches the wire: `timeout: opts?.timeout ?? 10_000, intervalMs: opts?.intervalMs ?? 1_000`.

**The trace capture.** `packages/session/src/runner/job-runner.ts:1287-1288` `} else if (req.uiTree === 'capture' && inspector) { uiHash = await store.putUiTree(job.id, await inspector.dump()) }`, rewritten by plan 208 §5 step 208.9 into `reusableTree(inspector.lastDump?.(), Date.now()) ?? (await inspector.dump())`. `packages/session/src/runner/trace.ts:139` `const TREE_METHODS = new Set<string>(['dump', 'find', 'waitFor'])` and `:235-239` `resolveFramePolicy` map the engine id to a capture policy.

**The bench.** `scripts/bench-device-nfrs.ts:90-105` `usage()`; `:215-293` the inspector stages, which build a ui-server launcher and inspector directly, time `attach`, `dump()` and `findIterations` finds, and fail past a 2000 ms p95 (`:283`).

### 3.2 The engine, not a second protocol

Plan 221 §3.2 decision 2 already made this plan possible: the agent emits `UiNodeSchema`'s eleven keys and copies `parseUiDump`'s synthetic root byte for byte, and `UiDumpResultSchema.shape.root` **is** `UiNodeSchema`, asserted by identity in plan 221's G4. So `UiTreeInspector` is a thin adapter: it never parses XML, never rebuilds a node, and never re-derives a selector. Everything it does is call one of four agent methods and map the answer into the shapes `Inspector` already returns.

That is what makes this an engine swap rather than a rewrite, and it is what §7's tests can assert without a device: the node comes back already shaped.

### 3.3 `find()` and `findDetailed()` on `ui-tree`, and why they are not the same function

`ui.find` returns `{ node, matches, tookMs }` (plan 221 §4.7). That is strictly more information than either existing engine has cheaply: ui-server cannot count matches at all, and `uiautomator-dump` can only count by paying a full dump. The temptation is to make `find()` a narrowing over `findDetailed()`, as `UiServerInspector` does. That would be a behaviour change for every published script bundle: a selector matching two nodes would start returning `null` where it used to return the first match.

So `ui-tree` follows the **`uiautomator-dump` shape, deliberately** (`uiautomator-dump.ts:84-98`, criterion 10, plan 62 §3.1): two separate implementations.

| Call | Behaviour on `ui-tree` |
|---|---|
| `find(sel)` | the first depth-first match, whatever `matches` says; `null` when `matches === 0`; `null` when the oversized-container guard rejects it |
| `findDetailed(sel)` | `not-found` when `matches === 0`; `rejected-oversized` when the guard rejects; `ambiguous` with the real count when `matches > 1`; otherwise `ok` |

The guard is kept, and kept in **both** calls, because `find()`'s contract as stated to script authors (`packages/sdk/src/types.ts:155-161`, "`null` for both a genuine miss AND a selector refused as a viewport-sized container") is the same on every engine, and a farm that swaps its default engine must not start returning a full-screen container where it used to return `null`. `isImplausibleMatch` is imported from `../ui-server/find-guard`, not moved: moving it would ripple through the drivers barrel for no gain.

The check order in `findDetailed` is not-found, then guard, then ambiguity. A container match says "retrying this selector will never help", which is a stronger and more actionable statement than "narrow it".

### 3.4 The screenshot comes from the transport, not from the agent

The agent has no screenshot method: plan 221 §4.1 adds `ui.dump`, `ui.find`, `ui.watch`, `ui.unwatch`, `ui.status` and nothing else. So `UiTreeInspector.screenshot()` is `transport.execOut('screencap -p', { profile: 'screencap' })`, the exact call `UiautomatorDumpInspector.screenshot()` already makes (`uiautomator-dump.ts:112-114`). The engine takes a `Transport` for that one purpose, and the descriptor advertises `screenshot` honestly because the engine really does provide it.

This is worth stating because the obvious alternative, dropping the capability, would break `inspect.dump`'s optional snapshot (`ws-handlers.ts`'s best-effort `inspector.screenshot()`) and `device.screenshot` for every device on the new default engine.

### 3.5 Push, with a bounded safety net

`waitFor` becomes three phases, in this order:

1. **Evaluate once, immediately.** Before anything is subscribed and before any sleep. A condition that is already true resolves with one round trip on every engine, which is not true today: today's loop also evaluates first, and this preserves that.
2. **Subscribe, then await the next change.** When the engine has `watch()`, the executor opens a subscription and then loops: wait for either a change event or the safety-net timer, whichever comes first, then evaluate. The caller's `timeout` remains the ceiling and the timeout error is unchanged (`waitfor_timeout`, carrying `last.reason` and `last.matches`, plan 74 §3.5 criterion 9).
3. **Poll, when there is no watch.** `ui-server` and `uiautomator-dump` keep exactly today's clamped interval, `Math.min(call.args.intervalMs, session.inspectorPollIntervalMs)`. The clamp is not deleted; it is confined to the engines it was written for.

**The safety net exists and is not optional.** `TYPE_WINDOW_CONTENT_CHANGED` is not emitted for every visible change: a `SurfaceView`, a `TextureView`, a game canvas or a WebView repaint can change what a person sees without producing an accessibility event at all, and an event can be lost outright (plan 221 §4.11's `onGap`). A `waitFor` that waits only on events would then hang for its entire timeout on a screen a human can see has already changed. So a watch-backed wait re-checks every `WAITFOR_WATCH_RECHECK_MS = 1_000` even with no event.

1000 ms is chosen, not invented: it is the SDK's own default interval (`child-entry.ts:182`, `intervalMs: opts?.intervalMs ?? 1_000`). A watch-backed `waitFor` is therefore **never slower** than what the SDK already promised, and is normally bounded by the event instead. Notably it is not the caller's `intervalMs`: a script that asked for 50 ms polling gets pushes plus a 1 s net rather than 20 evaluations a second, which is the whole point of the change.

An event that arrives while the previous evaluation is still in flight is **held, not dropped** (`createChangeSignal`, §4.3). Without that, a change delivered during a 40 ms find would be lost and the wait would sleep out the full 1 s net for a condition that was already true.

### 3.6 One watcher per agent, one subscription per inspector

Plan 221 §3.2 decision 4 is explicit: "Exactly one watcher connection per agent; a second `ui.watch` closes the first, because there is exactly one core per device." Two concurrent `waitFor` calls on one device would therefore silently kill each other's subscription.

`UiTreeInspector` owns exactly one subscription and multiplexes it (§4.2): `watch(onChange)` adds the callback to a set, the **first** subscriber opens the real `createGuestAgentWatch` connection, the **last** `close()` tears it down, and every close is idempotent. The subscription is opened lazily, on the first `waitFor`, never at session start, so an idle device holds no extra connection and no extra forwarded port beyond what the guest agent already holds.

A `seq` gap reported by `createGuestAgentWatch`'s `onGap` is delivered to every subscriber as a plain change notification: frames were lost, so the only safe reading is "something changed, re-evaluate".

### 3.7 What is lost by not having element actions, and why that is acceptable

`ui-server` is the only engine implementing `InspectorElementActions`, and `device-executor.ts:390-392` uses it: an `instant` `type()` after a selector-based tap goes through `inspector.setText` and reports `via: 'ui-server-set-text'`. `supportsElementActions` is a duck-type check (`ui-server/index.ts:16-18`), so on `ui-tree` that branch simply does not fire and the call falls into `resolveTextRoute`'s ladder, whose **rung 1 is the guest agent's own IME** (`text.commit`), already unicode-clean and already the reason `ui-server-set-text` exists (F26). The reported `via` changes from `ui-server-set-text` to `agent-ime`, which is honest and is the point of `ScriptTypeResult.via` existing.

What is genuinely lost is element scoping: `setText` writes into a named node, while the IME writes into whatever is focused. In practice the branch only fires when a selector-based tap has just focused that node, so the two agree. This is stated rather than hidden, and §9 Q3 asks the owner whether the agent should grow a `ui.setText`. Nothing in §5 depends on the answer.

`longClick` and `doubleClick` degrade the same way: `device-executor.ts`'s callers fall to the input engine's own gesture path, which is where every other pointer action already goes.

### 3.8 The ladder, and why it does not need a lock

The ladder is evaluated **once per session**, inside `createInspectorForSession`, in this order:

| Rung | Chosen when | Cost of the check |
|---|---|---|
| `ui-tree` | `requested` is `ui-tree`; the factory has `deps.uiTree`; `agentStatus(deviceId).state === 'ready'`; its `capabilities` contains `ui-tree`; and one live `ui.status()` reports `enabled && connected` | one persisted read plus one control-socket round trip, bounded by `UI_TREE_PROBE_BUDGET_MS = 3_000` |
| `ui-server` | the rung above was skipped or its probe failed, and `requested` is not `uiautomator-dump` | unchanged from today: install, `am instrument`, forward, ping |
| `uiautomator-dump` | `requested === 'uiautomator-dump'`, or the ui-server rung threw | none |

The `ui-tree` descriptor takes **no lock**. `AccessibilityNodeInfo` read through a bound `AccessibilityService` needs no `UiAutomation` connection, which is the resource `instrumentation` names. That closes MVP 13 A.9's third row.

The reverse hazard is real and is handled by the ladder's shape rather than by a lock: a connected `UiAutomation` (a running ui-server, or a `uiautomator dump`) **suppresses** other accessibility services, which would silence `UiTreeService`. Because the ladder picks exactly one rung and stops, a session on `ui-tree` never starts a ui-server, and after plan 208 the only construction of `UiautomatorDumpInspector` left in non-test code is the factory's own rung 3 (plan 208 G5). So the two are never up at once on one device, and `uiAutomationFlags` (plan 208 §9 Q4, plan 221 §9 Q2) is not forced by this plan. It stays open in §9 Q2 for a future plan that wants both.

**Availability is a device fact, not a registry fact.** The registry marks `ui-tree` `available: true` because it is implemented (`engines.ts:44-48`); whether this phone can use it right now is what the ladder's probe answers, and what `liveInspection` reports. Plan 221 §4.1 states the same rule for the capability string itself: "the capability says what the build can do, and `ui.status` says whether it can do it right now."

### 3.9 The default moves, which means a migration

Changing `DeviceSettingsSchema`'s default from `'ui-server'` to `'ui-tree'` on its own would reach **no existing farm**. `settings.ts` says so itself, and migration `0064_awake_on_connect.sql` exists because that mistake was already made once: "Every device row is written with a FULLY MATERIALISED DeviceSettings ... so a device enrolled before this change has its own literal ... stored in the `devices.settings` JSON column and re-reads that value, never this default." The engine actually used at session build comes from a fourth place again, the `devices.inspection` **column** (`manager.ts:554`).

So the migration rewrites all three, following `0064`'s own pattern exactly (§4.7): the column, `devices.settings`'s `$.engines.inspection`, and `farm_settings`'s `$.defaults.engines.inspection`, each only where the value is literally `'ui-server'`.

This does rewrite an operator's deliberate `ui-server` pin, and the migration comment says so in as many words: `'ui-server'` is the value every farm has whether it was chosen or defaulted, and the two are indistinguishable on disk. An operator who wants ui-server re-selects it, and the release note says that. A device pinned to `'uiautomator-dump'` or `'appium'` is untouched.

The migration is **generated** (`bun run --cwd packages/core db:generate`) and the three `UPDATE` statements are appended after the generated ones, the precedent `docs/plans/00-overview.md` §9 records for `0031_colorful_smasher.sql` and `0052_petite_juggernaut.sql` and plan 205 §4.6 follows.

### 3.10 Honest degradation, in three places that must agree

1. **The wire event.** `device.inspector.fallback` needs no schema change: `{ from, to, reason }` already carries any hop. The factory now reports up to two hops for one session (`ui-tree → ui-server`, then `ui-server → uiautomator-dump`), each with its own reason.
2. **The Inspect tab.** `inspect.status.engineId` is `session.inspectorEngineId` and is already correct; what has to be added is the `ui-tree` descriptor, so `inspectorCapabilities('ui-tree')` returns a list containing `dump` instead of `[]` (which would refuse every attach with "the ui-tree engine does not support reading the UI tree").
3. **The HTTP read.** `GET /api/devices/:id` gains `liveInspection`, beside `liveDisplay`, sourced from the live session and `null` when there is none. It is allowed to disagree with `inspection` (the configured column) for exactly the reason `liveDisplay`'s doc comment gives, and it reports `'starting'` verbatim while plan 208's prewarm is still in flight rather than guessing.

`GET /api/devices` (the list) carries no engine field today and does not gain one: `DeviceInfoSchema`'s `agent` field states the rule for that payload, "the narrow chip-only field on purpose ... so this payload does not grow for every device on every fleet fetch". §9 Q5 records the question for the owner; nothing in §5 depends on it.

The capability deadlines (`device-inspect.ts:30, 49, 84, 121`) keep their numbers. They are ceilings above the slowest rung on the ladder, and the slowest rung is still `uiautomator dump`. Only the header comment is rewritten to say that.

## 4. Technical design

### 4.1 `packages/protocol/src/driver.ts`: one optional member

```ts
/**
 * A live subscription to an engine's own change notifications (plan 222 §3.5).
 * `close()` is idempotent and never throws: a caller unwinding a `finally`
 * must not have to guard it.
 */
export interface InspectorWatch {
  close(): Promise<void>
}

/** The UI inspection engines (spec §8): `ui-tree` (default), `ui-server`, `uiautomator-dump`. */
export interface Inspector {
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
  findDetailed?(sel: Selector): Promise<FindOutcome>
  /** Plan 208 §4.7 — the last tree `dump()` returned and when (unix ms), or null. */
  lastDump?(): { root: UiNode; at: number } | null
  /**
   * Subscribe to on-device UI change notifications, so `waitFor` can await a
   * change instead of polling for one (MVP 02 §4 phase 2, "push, not poll").
   * `onChange` is called with no argument and no payload: it means "something
   * on screen changed, re-evaluate", nothing more, and a lost or coalesced
   * batch of events collapses into one call rather than being reconstructed.
   *
   * Optional, exactly like `findDetailed`: an engine with no notification
   * source (`ui-server`, `uiautomator-dump`) simply does not implement it and
   * `device-executor.ts` polls at `session.inspectorPollIntervalMs` as before.
   * Absence is the honest signal — never a stub that resolves and never fires,
   * which would turn every `waitFor` on that engine into a full-timeout hang.
   */
  watch?(onChange: () => void): Promise<InspectorWatch>
}
```

`InspectorWatch` is exported from `packages/protocol/src/index.ts` beside the existing `Inspector` export.

### 4.2 `packages/drivers/src/inspector/ui-tree/inspector.ts` (new; the file this plan ships)

```ts
import {
  matchSelector,
  type FindOutcome,
  type Inspector,
  type InspectorWatch,
  type Selector,
  type Transport,
  type UiNode,
} from '@enkaku/protocol'
import type { GuestAgentClient, UiChangedEvent } from '../../network/guest-agent/client'
import { isImplausibleMatch } from '../ui-server/find-guard'

/**
 * A live `ui.watch` subscription, opened by the caller on the SAME forwarded
 * port and pairing token the agent's request/response client already owns
 * (plan 221 §3.2 decision 5, §4.11). `close()` is idempotent.
 */
export interface UiTreeWatchHandle {
  close(): Promise<void>
}

export interface UiTreeInspectorDeps {
  deviceId: string
  /**
   * The device's shell, used for exactly one thing: `screencap -p`. The agent
   * has no screenshot method (plan 221 §4.1 adds five `ui.*` methods and no
   * sixth), so this engine takes the same path `UiautomatorDumpInspector`
   * takes (`uiautomator-dump.ts`'s `screenshot()`), and the descriptor
   * advertises `screenshot` because the engine really does provide it.
   */
  transport: Transport
  /**
   * Runs `fn` against the device's ONE guest-agent client, through the shared
   * per-device session that owns the pairing token (`route-service.ts`'s
   * `DeviceSession`). Never a client this engine minted: a second token
   * invalidates the first (plan 44 §8b's "Bug 1").
   */
  withClient: <T>(fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
  /**
   * Opens ONE `ui.watch` subscription for this device and returns a handle.
   * Supplied by the host (`packages/core/src/api/guest-agent.ts`), because the
   * subscription needs the forwarded port and the token, which only the
   * device session knows. Absent means this engine has no push channel and
   * `watch()` is not implemented at all (§4.1's "absence is the honest
   * signal").
   */
  openWatch?: (hooks: {
    onEvent: (event: UiChangedEvent) => void
    onGap: (expected: number, received: number) => void
    onClose: (reason: string) => void
  }) => Promise<UiTreeWatchHandle>
  /**
   * The find guard's viewport (plan 60 §3.1), resolved at most ONCE per
   * inspector and then reused, including a failure. Identical contract to
   * `UiServerInspectorOptions.screenSize`, so the guard behaves the same on
   * both engines and swapping the default engine does not change what
   * `find()` returns for the same selector.
   */
  screenSize?: () => Promise<{ width: number; height: number } | null>
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * The first-party inspector (MVP 02 §4 phase 2). It reads the guest agent's
 * `AccessibilityService` over the control channel the agent already has:
 * no `am instrument`, no instrumentation lock, no per-session process, no
 * conflict with `uiautomator dump`, and a real change subscription so
 * `waitFor` can stop polling.
 *
 * It is a thin adapter and nothing more. Plan 221 §3.2 decision 2 makes the
 * device emit `UiNodeSchema`'s eleven keys and `parseUiDump`'s synthetic root
 * byte for byte, and `UiDumpResultSchema.shape.root` IS `UiNodeSchema`, so
 * there is no parsing here, no node construction, and no second selector
 * grammar. That is what makes this an engine swap rather than a rewrite.
 */
export class UiTreeInspector implements Inspector {
  readonly id = 'ui-tree'

  private last: { root: UiNode; at: number } | null = null
  private screen: Promise<{ width: number; height: number } | null> | null = null
  /** Selectors already reported as implausible, so a polling caller says it once, not twelve times a second. */
  private warned = new Set<string>()
  /** Every live `watch()` subscriber. One agent connection serves all of them (§3.6). */
  private subscribers = new Set<() => void>()
  private connection: UiTreeWatchHandle | null = null
  private opening: Promise<UiTreeWatchHandle> | null = null

  constructor(private deps: UiTreeInspectorDeps) {}

  async dump(): Promise<UiNode> {
    const result = await this.deps.withClient((c) => c.uiDump())
    if (result.truncated) {
      this.deps.onLog?.(
        'warn',
        `the UI tree on ${this.deps.deviceId} hit the device's node or depth cap (${result.nodeCount} nodes) — ` +
          'it is reported as truncated and must not be treated as a complete tree',
      )
    }
    this.last = { root: result.root, at: Date.now() }
    return result.root
  }

  /** Plan 208 §4.7's cheap cache, so a failing action's trace reuses the dump the script just paid for. */
  lastDump(): { root: UiNode; at: number } | null {
    return this.last
  }

  /**
   * The first depth-first match, whatever the match count says — a SEPARATE
   * implementation from `findDetailed()` below, not a narrowing of it, for the
   * reason `uiautomator-dump.ts` states for its own pair: a bundle published
   * before this engine existed must keep getting exactly the first match
   * (criterion 10, plan 62 §3.1). The oversized-container guard is applied
   * here too, because that is what `find()` does on every other engine and a
   * change of default engine must not change what a selector returns.
   */
  async find(sel: Selector): Promise<UiNode | null> {
    if ('point' in sel) return matchSelector({} as UiNode, sel)
    const result = await this.deps.withClient((c) => c.uiFind(sel))
    if (!result.node) return null
    return (await this.rejectedAsContainer(sel, result.node)) ? null : result.node
  }

  /**
   * `find`, honest about why (plan 74 §3.4). This engine can report all three
   * reasons: the device counts matches for free while it walks the tree, which
   * `ui-server` cannot do at all and `uiautomator-dump` can only do by paying
   * for a whole tree. Order is not-found, then the container guard, then
   * ambiguity: "this selector matches only a full-screen container" says
   * retrying will never help, which is stronger than "narrow it".
   */
  async findDetailed(sel: Selector): Promise<FindOutcome> {
    if ('point' in sel) {
      const synthetic = matchSelector({} as UiNode, sel)
      return synthetic ? { ok: true, node: synthetic } : { ok: false, reason: 'not-found', matches: 0 }
    }
    const result = await this.deps.withClient((c) => c.uiFind(sel))
    if (!result.node || result.matches === 0) return { ok: false, reason: 'not-found', matches: 0 }
    if (await this.rejectedAsContainer(sel, result.node)) return { ok: false, reason: 'rejected-oversized', matches: result.matches }
    if (result.matches > 1) return { ok: false, reason: 'ambiguous', matches: result.matches }
    return { ok: true, node: result.node }
  }

  /** The agent has no screenshot method (§3.4) — the same `screencap -p` the dump engine uses. */
  screenshot(): Promise<Uint8Array> {
    return this.deps.transport.execOut('screencap -p', { profile: 'screencap' })
  }

  /**
   * One agent connection, many subscribers (§3.6): the agent allows exactly
   * one `ui.watch` per device (plan 221 §3.2 decision 4), so two concurrent
   * `waitFor` calls must NOT each open one — the second would close the first.
   * The first subscriber opens it, the last one out closes it, and the open is
   * coalesced so two simultaneous first subscribers still open exactly one.
   */
  async watch(onChange: () => void): Promise<InspectorWatch> {
    if (!this.deps.openWatch) throw new Error(`the ui-tree engine on ${this.deps.deviceId} has no watch channel`)
    this.subscribers.add(onChange)
    try {
      this.opening ??= this.deps
        .openWatch({
          onEvent: () => this.fanOut(),
          // A gap means frames were lost, so the only safe reading is "something
          // changed" — never an attempt to reconstruct what was missed.
          onGap: (expected, received) => {
            this.deps.onLog?.('debug', `ui.watch on ${this.deps.deviceId} skipped ${received - expected} event(s)`)
            this.fanOut()
          },
          // The subscription is gone. Every waiter is woken once so it
          // re-evaluates and then falls to its own safety-net timer, rather
          // than waiting silently on a channel that will never speak again.
          onClose: (reason) => {
            this.connection = null
            this.opening = null
            this.deps.onLog?.('debug', `ui.watch on ${this.deps.deviceId} closed: ${reason}`)
            this.fanOut()
          },
        })
        .then((handle) => {
          this.connection = handle
          return handle
        })
      await this.opening
    } catch (err) {
      this.subscribers.delete(onChange)
      this.opening = null
      throw err
    }
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        this.subscribers.delete(onChange)
        if (this.subscribers.size > 0) return
        const handle = this.connection
        this.connection = null
        this.opening = null
        await handle?.close().catch(() => undefined)
      },
    }
  }

  private fanOut(): void {
    for (const cb of [...this.subscribers]) {
      try {
        cb()
      } catch {
        // A subscriber that throws must not stop the others being told.
      }
    }
  }

  private async rejectedAsContainer(sel: Selector, node: UiNode): Promise<boolean> {
    const screen = await this.screenSize()
    if (!screen || !isImplausibleMatch(node, screen)) return false
    const key = JSON.stringify(sel)
    if (!this.warned.has(key)) {
      this.warned.add(key)
      const { left, top, right, bottom } = node.bounds
      this.deps.onLog?.(
        'warn',
        `${key} matched a ${node.className || 'node'} covering ${left},${top} → ${right},${bottom} of a ` +
          `${screen.width}×${screen.height} screen — that is a container, not this selector's element; ` +
          'answering null (plan 60 §3.1). Use dump() to walk the tree if you meant the root.',
      )
    }
    return true
  }

  private screenSize(): Promise<{ width: number; height: number } | null> {
    if (!this.deps.screenSize) return Promise.resolve(null)
    this.screen ??= this.deps.screenSize().catch((err: unknown) => {
      this.deps.onLog?.(
        'warn',
        `could not read the screen size of ${this.deps.deviceId} (${String(err)}) — the find guard is off for this session`,
      )
      return null
    })
    return this.screen
  }
}
```

`packages/drivers/src/inspector/ui-tree/index.ts` re-exports `UiTreeInspector`, `UiTreeInspectorDeps` and `UiTreeWatchHandle`; `packages/drivers/src/index.ts` re-exports the same from `./inspector/ui-tree/index` in a block beside the ui-server one.

**The descriptor**, appended to `packages/drivers/src/descriptors.ts` immediately **before** the `ui-server` entry (the array's order is the registry's order, and the default engine reads first):

```ts
  {
    id: 'ui-tree',
    // No number in this name: the file header's rule (a display name is served
    // verbatim by GET /api/registry and must never assert a number nobody has
    // measured). The ui-tree find and dump costs are measured by plan 222's
    // owner run and live in the SDK doc comments, not here.
    displayName: 'UI tree (guest agent accessibility service, push-based waitFor)',
    kind: 'inspector',
    // No `set-text` / `long-click` / `double-click`: the agent has no element
    // actions (plan 222 §3.7), and claiming one would make
    // `supportsElementActions` lie. `watch` is what `device-executor.ts` reads
    // as "this engine can push", through `Inspector.watch?`.
    capabilities: ['dump', 'find', 'screenshot', 'watch'],
    // Deliberately empty, and this is the row MVP 13 A.9 asks for. An
    // AccessibilityService reads `AccessibilityNodeInfo` through a binding the
    // system owns; it never connects `UiAutomation`, which is the resource the
    // `instrumentation` lock names. The reverse hazard (a connected
    // UiAutomation suppresses accessibility services) is handled by the
    // ladder, which picks exactly one rung per session, not by a lock.
    locks: [],
    configSchema: {},
  },
```

### 4.3 `packages/session/src/change-signal.ts` (new)

```ts
/**
 * A one-shot, resettable notification with a timeout — the primitive that lets
 * `waitFor` await "the next change, or a bounded re-check, whichever comes
 * first" without racing two promises that both stay alive (plan 222 §3.5).
 *
 * `fire()` while nothing is waiting is REMEMBERED, and consumed by the next
 * `wait()`. That is the whole reason this exists rather than a bare promise: a
 * change delivered while the previous evaluation was still in flight would
 * otherwise be lost, and the wait would sleep out its entire safety-net window
 * on a condition that had already become true.
 */
export interface ChangeSignal {
  fire(): void
  /** Resolves on the next `fire()`, on a pending one, or after `ms`. Never rejects. */
  wait(ms: number): Promise<void>
}

export function createChangeSignal(): ChangeSignal {
  let pending = false
  let resolveNow: (() => void) | null = null
  return {
    fire() {
      pending = true
      const r = resolveNow
      resolveNow = null
      r?.()
    },
    wait(ms) {
      if (pending) {
        pending = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolveNow = null
          resolve()
        }, ms)
        resolveNow = () => {
          clearTimeout(timer)
          pending = false
          resolve()
        }
      })
    },
  }
}
```

### 4.4 `packages/session/src/device-executor.ts`: the `waitFor` case

```ts
/**
 * The safety-net re-check for a watch-backed `waitFor` (plan 222 §3.5). Not a
 * poll: the event is the mechanism and this is the bound on how wrong the
 * event stream can be. It exists because `TYPE_WINDOW_CONTENT_CHANGED` is not
 * emitted for every visible change — a SurfaceView, a TextureView, a game
 * canvas or a WebView repaint can change the screen with no accessibility
 * event at all — and because a frame can simply be lost.
 *
 * 1000 ms is the SDK's own default interval (`runner/child-entry.ts`'s
 * `intervalMs: opts?.intervalMs ?? 1_000`), so a watch-backed wait is never
 * slower than what the SDK already promised, and is normally bounded by the
 * event instead. Deliberately NOT the caller's `intervalMs`: a script that
 * asked for 50 ms polling gets pushes plus a one-second net, which is the
 * point of the change.
 */
export const WAITFOR_WATCH_RECHECK_MS = 1_000
```

```ts
      case 'waitFor': {
        const deadline = Date.now() + call.args.timeout
        // Plan 74 §3.5, §4.3 — carries the LAST outcome into the timeout
        // error, so "every match was refused as rejected-oversized" reports
        // as that, not a bare timeout (criterion 9). Unchanged.
        let last: FindOutcome = { ok: false, reason: 'not-found', matches: 0 }
        const evaluate = (): Promise<FindOutcome> =>
          findOutcome(call.args.sel).catch((): FindOutcome => ({ ok: false, reason: 'not-found', matches: 0 }))
        const timedOut = (): SessionError =>
          new SessionError(
            'waitfor_timeout',
            `waiting for ${JSON.stringify(call.args.sel)} exceeded ${call.args.timeout}ms (last: ${last.reason}, ${last.matches} matches)`,
            { reason: last.reason, matches: last.matches },
          )

        // One evaluation before anything is subscribed or slept on: a
        // condition that is ALREADY true resolves with a single round trip on
        // every engine (plan 222 §3.5 phase 1).
        const first = await evaluate()
        if (first.ok) return first.node
        last = first

        const inspector = inspectorOrThrow()
        if (inspector.watch) {
          const signal = createChangeSignal()
          let subscription: InspectorWatch | null = null
          try {
            subscription = await inspector.watch(() => signal.fire())
          } catch (err) {
            // A subscription that cannot be opened is a degraded engine, not a
            // failed wait: fall through to the poll below and say so once.
            deps.session.log?.warn?.(
              `could not subscribe to UI changes on ${deps.session.deviceId} (${String(err)}) — this waitFor polls instead`,
            )
          }
          if (subscription) {
            try {
              for (;;) {
                const budget = deadline - Date.now()
                if (budget <= 0) throw timedOut()
                await signal.wait(Math.min(budget, WAITFOR_WATCH_RECHECK_MS))
                const outcome = await evaluate()
                if (outcome.ok) return outcome.node
                last = outcome
              }
            } finally {
              await subscription.close().catch(() => undefined)
            }
          }
        }

        // No watch on this engine (`ui-server`, `uiautomator-dump`), or the
        // subscription could not be opened. The interval follows the active
        // engine, exactly as before: ui-server is cheap (~80 ms), a dump is
        // expensive.
        const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)
        for (;;) {
          if (Date.now() >= deadline) throw timedOut()
          await Bun.sleep(interval)
          const outcome = await evaluate()
          if (outcome.ok) return outcome.node
          last = outcome
        }
      }
```

Two shape notes the executor must not "fix":

- The poll loop checks the deadline, sleeps, then evaluates, because the first evaluation already happened above. The old loop evaluated, checked, slept. The observable behaviour is the same and one redundant evaluation is saved.
- `deps.session.log?.warn?.(...)` is written defensively because a hand-built `DeviceSession` fixture may not carry a logger. If `DeviceSession` has no `log` member when this executes, drop the line rather than adding one: the fallback is already visible through `session.inspectorEngineId`.

### 4.5 The ladder: `packages/session/src/inspector-factory.ts`

```ts
/** The `waitFor` interval used ONLY when the ui-tree engine could not open its watch channel (plan 222 §3.5). */
const UI_TREE_POLL_MS = 200

/**
 * How long the ui-tree rung may spend proving itself before the ladder moves
 * on. One persisted read plus one `ui.status()` round trip; a phone whose
 * agent is wedged must not delay the session's inspector by more than this
 * before ui-server is started instead.
 */
const UI_TREE_PROBE_BUDGET_MS = 3_000

export interface InspectorFactoryDeps {
  // ...unchanged fields...
  /**
   * The `ui-tree` rung (plan 222 §3.8). Absent means the rung is skipped
   * entirely and the ladder starts at ui-server — which is exactly what the
   * cloud node does (`packages/node/src/hosts.ts` has no guest-agent session
   * of its own), and what any host without a provisioner does.
   */
  uiTree?: {
    /** The provisioner's PERSISTED row: no adb call (`AgentProvisioner.status`'s own contract). */
    agentStatus: (deviceId: string) => Promise<{ state: string; capabilities: readonly string[] }>
    withClient: <T>(deviceId: string, fn: (client: GuestAgentClient) => Promise<T>) => Promise<T>
    openWatch: (deviceId: string, hooks: UiTreeWatchHooks) => Promise<UiTreeWatchHandle>
  }
}
```

The body, replacing `:65` through `:73`:

```ts
  const requested = opts.requested ?? 'ui-tree'
  const dumpHandle = (): InspectorHandle => ({ /* unchanged */ })

  if (requested === 'uiautomator-dump') return dumpHandle()

  // ---- rung 1: ui-tree (plan 222 §3.8) ----
  if (requested === 'ui-tree') {
    const skip = await uiTreeUnavailableReason(deps, opts.deviceId)
    if (skip === null) {
      const inspector = new UiTreeInspector({
        deviceId: opts.deviceId,
        transport: opts.transport,
        withClient: (fn) => deps.uiTree!.withClient(opts.deviceId, fn),
        openWatch: (hooks) => deps.uiTree!.openWatch(opts.deviceId, hooks),
        screenSize: async () => {
          const { stdout } = await opts.transport.exec('wm size', { profile: 'probe' })
          const size = parseWmSize(stdout)
          return size ? { width: size.w, height: size.h } : null
        },
        onLog: (level, msg) => deps.log[level](msg),
      })
      return {
        inspector,
        engineId: 'ui-tree',
        pollIntervalMs: UI_TREE_POLL_MS,
        // Nothing to release: no process was started, no port was claimed, no
        // lock was taken. The agent's own session and forwarded port are owned
        // by the guest-agent subsystem and outlive this handle.
        release: async () => {},
      }
    }
    deps.log.warn(`the ui-tree inspector cannot be used on ${opts.deviceId} (${skip}) — falling back to ui-server`)
    deps.onFallback?.(opts.deviceId, 'ui-tree', 'ui-server', skip)
  }

  // ---- rung 2: ui-server (unchanged from :75 onward) ----
```

and the predicate, a top-level function in the same file so the tests can drive it directly:

```ts
/**
 * `null` when the ui-tree rung can be used on this device; otherwise the
 * operator-facing reason it cannot, verbatim enough to act on. A RESULT, not
 * an exception, for the same reason `GuestAgentVpnConsent` is one: "this phone
 * has not had its accessibility service enabled" is a different event from
 * "this device is broken", and collapsing them would cost the device an engine
 * it could have had.
 */
export async function uiTreeUnavailableReason(deps: InspectorFactoryDeps, deviceId: string): Promise<string | null> {
  if (!deps.uiTree) return 'this host has no guest-agent session (the cloud node path)'
  try {
    const probe = async (): Promise<string | null> => {
      const agent = await deps.uiTree!.agentStatus(deviceId)
      if (agent.state !== 'ready') return `the guest agent is ${agent.state} on this device`
      if (!agent.capabilities.includes('ui-tree')) {
        return 'the installed guest agent build does not advertise the ui-tree capability (it predates plan 221)'
      }
      const status = await deps.uiTree!.withClient(deviceId, (c) => c.uiStatus())
      if (!status.enabled) {
        return (
          'the guest agent is installed and answering, but its accessibility service is not enabled on this phone. ' +
          'Provisioning writes `enabled_accessibility_services` from adb; when a build refuses that write, open the ' +
          'agent on the phone and press "Open accessibility settings" (plan 221 §4.10)'
        )
      }
      if (!status.connected) return 'the accessibility service is enabled but not bound yet (it usually binds within seconds of a reboot)'
      return null
    }
    return await withTimeout(probe(), UI_TREE_PROBE_BUDGET_MS, `the ui-tree probe did not answer within ${UI_TREE_PROBE_BUDGET_MS}ms`)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
```

`withTimeout` is a five-line local helper in the same file (`Promise.race` against a `setTimeout` that rejects, with the timer cleared in a `finally`); do not import a new dependency for it.

The ui-server rung's catch is unchanged apart from its log line, which keeps naming the hop it is actually making (`ui-server` → `uiautomator-dump`).

### 4.6 The watch channel, host side

`packages/core/src/network/route-service.ts`, `DeviceSession` gains one method:

```ts
  /**
   * Runs `fn` against this session's bootstrapped ENDPOINT — the forwarded host
   * port and the pairing token it already owns — bootstrapping exactly as
   * `withClient` does and minting no second token. It exists for `ui.watch`,
   * the one guest-agent call that is a subscription rather than a request:
   * `createGuestAgentWatch` (plan 221 §4.11) opens its own connection to the
   * SAME forwarded port and must never allocate a forward of its own, which is
   * what `launcher.ts`'s host-port ownership check makes safe.
   */
  withEndpoint<T>(fn: (endpoint: { port: number; token: string }) => Promise<T>, opts?: DeviceSessionCallOpts): Promise<T>
```

`createDeviceSession` (`packages/core/src/api/guest-agent.ts:366-494`) implements it with the same `ensureClient(callOpts)` bootstrap it already runs, then calls `fn({ port, token })` with the values it holds. It does **not** expose them as fields: a getter that can be read before the bootstrap would hand a caller a null port.

`GuestAgentRoutesHandle` gains:

```ts
/** A live `ui.watch` subscription plus the reference it holds on the device's guest-agent session. */
export interface GuestAgentUiWatch {
  /** Closes the subscription and releases the session reference. Idempotent. */
  close(): Promise<void>
}

  /**
   * Plan 222 §4.6 — a LONG-LIVED `ui.watch` subscription for the `ui-tree`
   * inspector. It takes the same reference on the device's shared guest-agent
   * session that `withGuestAgentClient` takes for the length of one call, and
   * holds it until `close()`, so the forwarded port and the pairing token stay
   * valid for as long as the subscription does and no second token is ever
   * minted (plan 44 §8b's "Bug 1").
   */
  watchGuestAgentUi(deviceId: string, hooks: {
    onEvent: (event: UiChangedEvent) => void
    onGap: (expected: number, received: number) => void
    onClose: (reason: string) => void
  }): Promise<GuestAgentUiWatch>
```

The implementation sits beside `withEphemeralSession` because that is where the reference count lives, and reuses it rather than duplicating it:

1. Resolve the row (`mustGet(deviceId)`).
2. Take a hold: the same "reuse the route's shared session if there is one, else the ref-counted ephemeral one, refs += 1" path `withEphemeralSession` opens with, factored into `acquireSessionHold(row)` returning `{ session, release() }` so both callers share one implementation. `withEphemeralSession` becomes `acquireSessionHold` plus a `try/finally`; its behaviour must not change and its doc comment stays.
3. `const watch = await hold.session.withEndpoint(({ port, token }) => Promise.resolve(createGuestAgentWatch({ port, token, ...hooks })))`, then `await watch.ready`.
4. Return `{ close: async () => { await watch.close().catch(() => undefined); await hold.release() } }`, idempotent through a `closed` flag.
5. `hooks.onClose` is wrapped so a subscription the agent dropped also releases the hold exactly once. A hold released twice is a bug that leaks a forwarded port, so the flag is shared between the two paths.

`daemon.ts` wires it into the factory:

```ts
                uiTree: {
                  agentStatus: async (deviceId) => {
                    const s = await agentProvisioner.status(deviceId)
                    return { state: s.state, capabilities: s.capabilities }
                  },
                  withClient: (deviceId, fn) => guestAgent.withGuestAgentClient(deviceId, fn),
                  openWatch: (deviceId, hooks) => guestAgent.watchGuestAgentUi(deviceId, hooks),
                },
```

`packages/node/src/hosts.ts` passes no `uiTree` key at all, so a node-owned device starts at the ui-server rung (§2 non-goal).

### 4.7 The default engine and its migration

`packages/protocol/src/settings.ts:387-391`:

```ts
        inspection: z
          .enum(['ui-tree', 'ui-server', 'uiautomator-dump', 'appium'])
          .default('ui-tree')
          .describe('How scripts find elements on screen')
          .meta(ui({ title: 'Screen inspection', source: 'registry.inspectors' })),
```

and `:397` `inspection: 'ui-tree'`. `packages/core/src/db/schema.ts:29` becomes `inspection: text('inspection').default('ui-tree'),`.

Migration `packages/core/drizzle/<next>_<drizzle name>.sql`, generated by `bun run --cwd packages/core db:generate` and never hand-written, with these three statements appended after the generated ones (the `0064_awake_on_connect.sql` and plan 205 §4.6 precedent):

```sql
--> statement-breakpoint
-- MVP 02 §4 phase 2: the default inspector engine is the guest agent's own
-- accessibility service. A device row carries the engine it will actually use
-- (`packages/session/src/manager.ts` reads this column, not the settings JSON),
-- so changing the schema default alone would reach no farm that already exists.
--
-- This rewrites `ui-server` and only `ui-server`. That value is what every farm
-- has, whether an operator chose it or it was simply the default, and the two
-- are indistinguishable on disk — so an operator who wants ui-server re-selects
-- it, and the release note says so. A device pinned to `uiautomator-dump` or
-- `appium` is untouched: those were deliberate.
--
-- Nothing is lost if the agent is not ready on a device: the engine ladder
-- (plan 222 §3.8) probes ui-tree, falls back to ui-server, reports the hop as
-- `device.inspector.fallback`, and the device keeps working on the engine it
-- had before.
UPDATE `devices` SET `inspection` = 'ui-tree' WHERE `inspection` = 'ui-server';
--> statement-breakpoint
-- The second stored copy: every device row holds a fully materialised
-- DeviceSettings, so the dropdown would keep showing `ui-server` for a device
-- the core is running on `ui-tree`.
UPDATE `devices`
SET `settings` = json_set(`settings`, '$.engines.inspection', 'ui-tree')
WHERE `settings` IS NOT NULL
  AND json_valid(`settings`)
  AND json_extract(`settings`, '$.engines.inspection') = 'ui-server';
--> statement-breakpoint
-- The third, and the one that would have made this migration look like it
-- worked: `farm_settings` holds the farm's own `defaults`, which is what a
-- NEWLY admitted device is materialised from (`registry/admission.ts`). Fixing
-- only the rows above would repair today's phones and quietly hand tomorrow's
-- the old engine.
UPDATE `farm_settings`
SET `value` = json_set(`value`, '$.defaults.engines.inspection', 'ui-tree')
WHERE json_valid(`value`)
  AND json_extract(`value`, '$.defaults.engines.inspection') = 'ui-server';
```

`packages/session/src/manager.ts:635`'s `inspection: row.inspection ?? 'ui-server'` becomes `?? 'ui-tree'`, so the `session.opened` event names the same default everything else does.

### 4.8 Reporting

`packages/protocol/src/api/devices.ts`, on `DeviceDetailSchema` immediately after `inspection`:

```ts
  /**
   * Plan 222 §3.10 — the inspector engine ACTUALLY running, sourced live from
   * the open session, distinct from `inspection` above (the stored, CONFIGURED
   * column). The two are allowed to disagree, and on a farm where some phones
   * cannot enable the accessibility service they routinely will: the device
   * reports `inspection: 'ui-tree'` (nothing rewrote the configured value)
   * while `liveInspection: 'ui-server'` says which engine the session fell back
   * to. `'starting'` is reported verbatim while the session's prewarm is still
   * in flight (plan 208), never guessed at; `null` when no session is open.
   */
  liveInspection: z.string().nullable(),
```

`packages/core/src/api/devices.ts:1076`, beside `liveDisplay`:

```ts
      liveInspection: deps.connection?.sessions?.()?.get(row.id)?.inspectorEngineId ?? null,
```

### 4.9 The SDK doc comments

`packages/sdk/src/types.ts:19-24`:

```ts
export interface WaitForOptions {
  /** Default 10_000 ms. */
  timeout?: number
  /**
   * Default 1_000 ms, and on the default engine it is a CEILING rather than a
   * cadence: `ui-tree` subscribes to the device's own change notifications and
   * re-evaluates when the screen changes, using this only as a bounded
   * safety-net re-check (plan 222 §3.5). On `ui-server` and `uiautomator-dump`
   * there is nothing to subscribe to and this is a real polling interval,
   * clamped down to what that engine can sustain.
   */
  intervalMs?: number
}
```

`:172-186`:

```ts
  /**
   * The whole accessibility tree — the same one the Inspect panel renders
   * (plan 60 §3.2). This is how a script reads something the four-shape
   * selector grammar cannot reach: a node carrying a resource id and no text,
   * a value that only makes sense relative to its neighbours, a count of
   * matching rows. Ordinary TypeScript over `node.children` does all of it.
   *
   * **It is the most expensive call on this object**, on every engine. Measured
   * per engine, so the number you are paying is the number for the engine your
   * device is on (`GET /api/devices/:id`'s `liveInspection` says which):
   *
   * | Engine | `dump()` | `find()` |
   * |---|---|---|
   * | `ui-tree` (default) | TBD-222-DUMP-MS | TBD-222-FIND-MS |
   * | `ui-server` | 334 to 584 ms (moto g06 power, plan 74) | about 80 ms (same device) |
   * | `uiautomator-dump` | 334 to 584 ms (same device) | a full dump, plus the walk |
   *
   * Fetch it once and walk the result; do not call it per assertion. Nothing
   * stops you paying repeatedly if you mean to — the cost is stated here rather
   * than enforced.
   */
  dump(): Promise<UiNode>
  /**
   * Wait for a selector to appear, up to `opts.timeout`. Rejects with
   * ScriptError('WAITFOR_TIMEOUT') when time runs out.
   *
   * On the default `ui-tree` engine this does not poll: the condition is
   * evaluated once immediately, so something already on screen returns at once,
   * and then the core waits on the device's own change notifications
   * (plan 222 §3.5). A condition that becomes true resolves about
   * TBD-222-WAITFOR-MS after the screen changes, rather than at the next poll
   * tick. On `ui-server` and `uiautomator-dump` it polls at `opts.intervalMs`
   * clamped to what the engine sustains.
   */
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>
```

The three `TBD-222-` tokens are the blanks the owner fills from §7.4 step 6. G11 counts them (exactly 3) so the executor cannot silently omit one; G12 is the owner's row for filling them.

### 4.10 The spec

Plan 202 rewrote `docs/spec.md`; the two paragraphs MVP 02's "Spec impact" names as §7.4 and §7.9 of the prototype spec live in the new document at **§8 Inspector** and **§5.1 Five driver layers** (plan 202 §4.2's outline, and §21 of the new spec is the map from the old numbers). This plan writes both.

**§8 Inspector** replaces the whole section with:

```markdown
## 8. Inspector

The inspector reads the UI tree for scripts, agents, and the Inspector tab. There are three engines and one ladder: `ui-tree`, then `ui-server`, then `uiautomator dump`. A session picks one rung at build time and reports which; it never runs two at once on one device.

**`ui-tree`, the default.** An `AccessibilityService` inside the guest agent, reached over the agent's existing control channel. It reads `AccessibilityNodeInfo`, the same source UiAutomator reads, and emits the same node shape every other engine emits, so selectors, the node schema and every consumer are unchanged. It runs no `am instrument`, holds no `instrumentation` lock, starts no per-session process, and does not conflict with `uiautomator dump`; it is a bound service that lives as long as the agent. It is enabled unattended from adb during provisioning (`cmd appops set <package> ACCESS_RESTRICTED_SETTINGS allow`, then `settings put secure enabled_accessibility_services` and `accessibility_enabled`, then a read-back that decides; 200 §5 R4), and the agent's own status screen has an "Open accessibility settings" button for the builds that refuse the write. It has no element actions: a scoped `setText` goes through the agent's IME instead.

**`waitFor` is push, not poll.** `ui.watch` subscribes to `TYPE_WINDOW_CONTENT_CHANGED`, and the executor evaluates the condition once immediately, then waits for the next change event with the caller's timeout as the ceiling. A condition that is already true returns with one round trip; a condition that becomes true resolves when the screen changes rather than at the next tick. A bounded one-second re-check runs alongside the subscription, because a `SurfaceView`, a `TextureView` or a WebView repaint can change the screen with no accessibility event at all, and an event can be lost. This is the structural answer to "the script waits for our system to see the UI".

**`ui-server`, the fallback.** The openatx instrumentation, session-scoped: started in the background after the first video frame and kept until session close, with a fail-fast start that reads the instrumentation's own stdout and a 15 s ceiling reserved for a server that says nothing, and the JSON-RPC configurator setting the idle waits to zero. It is chosen for a device where the guest agent is not installed, is an older build, or could not have its accessibility service enabled.

**`uiautomator dump`, the last resort.** One dump per query, no element actions, and it seizes UiAutomation. Chosen only when an operator pins it or when the ui-server rung failed to start.

**Degradation is visible, never silent.** Every hop broadcasts `device.inspector.fallback` and records `session.degraded` with the reason; the Inspector tab names the engine it actually got; and `GET /api/devices/:id` carries `liveInspection`, the engine running, beside `inspection`, the engine configured. The two are allowed to disagree, and on a mixed farm they will.

Targets are in §17.
```

**§5.1**, the inspector row of the driver-layer table:

```markdown
| 4 Inspector | `dump() find(sel) findDetailed(sel)? screenshot() watch(onChange)?` | `ui-tree` (the guest agent's accessibility service) | `ui-server`, then `uiautomator dump` (§8) |
```

The row's interface column is corrected while it is rewritten: `waitFor` is not a method on `Inspector`, it is the executor's loop over `find` (`packages/session/src/device-executor.ts`), and the skeleton listed it as one.

The sentence below the table, "Engines declare the capability locks they take (for example `instrumentation`), so two engines cannot collide on one device", gains: "The default inspector takes none: `ui-tree` needs no `UiAutomation` connection, which is what removed the collision the prototype's inspector had with `uiautomator dump`."

If `docs/spec.md` still has the prototype's numbering when this plan executes (plan 202 has not merged), the executor edits the prototype's §7.4 and §7.9 with the same content, adds a `DIV-` row to `docs/spec-divergences.md` naming the deferral, and records which happened in §11.

### 4.11 The bench

`scripts/bench-device-nfrs.ts` gains two flags:

- `--engine <ui-tree|ui-server>` (default `ui-server`, so an unattended re-run of the old command measures the old thing). With `ui-tree` the inspector stages build a `UiTreeInspector` against a guest-agent client and watch the script bootstraps itself (the same `createGuestAgentLauncher` plus `createGuestAgentClient` pair `scripts/smoke-guest-agent.ts` already uses), and the `attach` row is replaced by a `ui-tree probe` row (the `ui.status()` round trip).
- `--waitfor-cycles <N>` (default 0, meaning skipped). With `N > 0` it subscribes with `createGuestAgentWatch`, drives `N` screen changes with `input keyevent APP_SWITCH` / `BACK` pairs, and for each one measures from the `adb shell input` return to a `waitFor`-shaped resolution (the immediate evaluation plus the post-event evaluation, run through the real executor path's logic). It prints `waitFor push p50: <N> ms` and `waitFor push p95: <N> ms`. That is G17's number.

`usage()` lists both. The existing 2000 ms p95 regression bound at `:283` applies to whichever engine was selected.

## 5. Implementation steps

### 222.1 — `Inspector.watch`, `InspectorWatch`, and the engine id enums

- **Files changed**: `packages/protocol/src/driver.ts` (§4.1, plus the Indonesian leading comment on `Inspector` rewritten to the English sentence in §4.1), `packages/protocol/src/index.ts` (export `InspectorWatch`), `packages/protocol/src/settings.ts:387-391` and `:397` (§4.7's enum and defaults), `packages/protocol/src/api/devices.ts` (§4.8's `liveInspection`).
- **Files created**: none.
- **Test file**: `packages/protocol/src/settings.test.ts` (extend; the settings schema is on plan 200 §8.3's critical list as a wire contract).
- **Verifiable result**: `bun test packages/protocol/src/settings.test.ts` passes with a new test `the inspection engine enum carries ui-tree and defaults to it`. `bun run typecheck` clean.
- **Do not**: do not make `watch` a required member of `Inspector`: two of the three engines cannot implement it, and a stub that resolves and never fires turns every `waitFor` on those engines into a full-timeout hang (§4.1). Do not remove `'appium'` from the enum; it is a registered planned engine (`packages/core/src/registry/engines.ts`'s `PLANNED`).

### 222.2 — `UiTreeInspector`

- **Files created**: `packages/drivers/src/inspector/ui-tree/inspector.ts` (§4.2), `packages/drivers/src/inspector/ui-tree/index.ts` (the barrel), `packages/drivers/src/inspector/ui-tree/inspector.test.ts`.
- **Files changed**: `packages/drivers/src/index.ts` (re-export the three names in a block beside the ui-server one).
- **Test file**: `packages/drivers/src/inspector/ui-tree/inspector.test.ts`, against a hand-built fake `GuestAgentClient` (an object with `uiDump` / `uiFind` / `uiStatus` and nothing else, cast through the interface) and a fake `openWatch`: `dump returns the agent's root unchanged and records lastDump`; `a truncated dump is logged as truncated and still returned`; `find returns the first match even when matches is above one`; `findDetailed reports ambiguous when matches is above one`; `findDetailed reports rejected-oversized before ambiguous for a full-screen node`; `find and findDetailed answer a point selector without touching the agent`; `screenshot goes through the transport, never the agent`; `two watch subscribers share one agent connection and the last close tears it down`; `an onClose from the agent wakes every subscriber`; `watch throws when no openWatch was supplied`.
- **Verifiable result**: `bun test packages/drivers/src/inspector/ui-tree/inspector.test.ts` passes. `bun run typecheck` clean.
- **Do not**: do not parse anything: `UiDumpResult.root` is already a `UiNode` (plan 221 §3.2 decision 2), so calling `parseUiDump` here would be re-parsing a parsed tree. Do not move `find-guard.ts` out of `ui-server/`; import it. Do not implement `setText`, `longClick` or `doubleClick`: the agent has no such methods and `supportsElementActions` would then lie (§3.7). Do not open the watch connection in the constructor or from `dump()`; it is opened by the first `watch()` caller and by nothing else.

### 222.3 — The engine descriptor

- **Files changed**: `packages/drivers/src/descriptors.ts` (§4.2's entry, inserted immediately before the `ui-server` entry).
- **Test file**: `packages/protocol/src/registry.test.ts` (extend; `validateEngineSelection` is protocol logic on the critical list).
- **Verifiable result**: `bun test packages/protocol/src/registry.test.ts` passes with a new test `ui-tree holds no lock, so no inspector/input combination conflicts` (it builds a `RegistryResponse` from `engineDescriptors` and asserts `validateEngineSelection` returns `{ ok: true }` for `inspection: 'ui-tree'` against each of `scrcpy-uhid`, `scrcpy-sdk` and `adb-input`). `rg -n "locks: \['instrumentation'\]" packages/drivers/src/descriptors.ts` → exactly 2 lines.
- **Do not**: do not put a millisecond figure in `displayName`; the file's own header says why (`descriptors.ts:8-25`). Do not add `set-text`, `long-click` or `double-click` to `capabilities`. Do not add the engine to `packages/core/src/registry/engines.ts`'s `PLANNED` array: it is implemented, and `all()` already marks every drivers descriptor `available: true`.

### 222.4 — The host watch channel

- **Files changed**: `packages/core/src/network/route-service.ts` (`DeviceSession.withEndpoint`, §4.6), `packages/core/src/api/guest-agent.ts` (`createDeviceSession` implements it; `acquireSessionHold` factored out of `withEphemeralSession`; `watchGuestAgentUi` and `GuestAgentUiWatch` on `GuestAgentRoutesHandle`), `packages/core/src/network/route-service.fixture.ts` (the fixture session gains `withEndpoint`), `packages/core/src/daemon.ts` (the `uiTree` block of §4.6 on the `makeInspector` call).
- **Files created**: none.
- **Test file**: none in `packages/core`. This is route wiring plus a reference count with no branch a unit test can reach without a live agent, and plan 200 §8.3 excludes route wiring. The reference-count contract is proven by the owner smoke (§7.4 step 5: the forwarded port count is unchanged after a `waitFor` completes).
- **Verifiable result**: `bun run typecheck` clean; `bun test packages/core/src/network/` passes unchanged (the fixture edit must not break it).
- **Do not**: do not mint a token here or build a second `GuestAgentSession`; go through `withEndpoint` on the session the device already has. Do not allocate an `adb forward` for the subscription (plan 221 §3.2 decision 5: it reuses the same forwarded port and inherits the host-port ownership check). Do not let `close()` release the session hold twice; share one `closed` flag between the explicit close and the agent-initiated `onClose`.

### 222.5 — The ladder

- **Files changed**: `packages/session/src/inspector-factory.ts` (§4.5 in full), `packages/session/src/index.ts` (export `uiTreeUnavailableReason` for the test and for a future doctor check), `packages/node/src/hosts.ts` (a comment only, saying the node passes no `uiTree` and therefore starts at the ui-server rung).
- **Test file**: `packages/session/src/inspector-factory.test.ts` (extend).
- **Verifiable result**: `bun test packages/session/src/inspector-factory.test.ts` passes with `the ladder picks ui-tree when the agent is ready and the service is enabled and connected`, `... falls back to ui-server when the agent is not ready`, `... when the ui-tree capability is absent`, `... when the service is not enabled`, `... when the service is enabled but not connected`, `the rung is skipped entirely when deps.uiTree is absent`, `requested uiautomator-dump still short-circuits both rungs`, `requested ui-server skips the ui-tree rung and does not probe the agent` (the fake `agentStatus` is asserted never to have been called), `both rungs failing reaches uiautomator-dump and reports both hops` (two `onFallback` calls, in order), `a ui-tree probe that hangs falls back within UI_TREE_PROBE_BUDGET_MS`.
- **Do not**: do not start a ui-server "in parallel, just in case": that is the two-connected-UiAutomation hazard §3.8 exists to avoid. Do not claim a port for the ui-tree rung, and do not give its handle a `release()` that does anything: it started no process. Do not swallow the probe's reason: `onFallback`'s `reason` is what the operator reads.

### 222.6 — The push `waitFor`

- **Files created**: `packages/session/src/change-signal.ts` (§4.3), `packages/session/src/change-signal.test.ts`.
- **Files changed**: `packages/session/src/device-executor.ts` (`WAITFOR_WATCH_RECHECK_MS` and the `waitFor` case of §4.4), `packages/session/src/device-executor.test.ts`, `packages/session/src/index.ts` (export `WAITFOR_WATCH_RECHECK_MS` and `createChangeSignal`).
- **Test file**: `packages/session/src/change-signal.test.ts` (`a fire before a wait is remembered and consumed once`, `a fire during a wait resolves it and clears the timer`, `a wait with no fire resolves after ms`, `two waits in sequence each need their own fire`) and `packages/session/src/device-executor.test.ts`.
- **Verifiable result**: `bun test packages/session/src/change-signal.test.ts` passes; `bun test packages/session/src/device-executor.test.ts` passes with `waitFor evaluates once before subscribing and returns at once when the condition already holds` (1 `findDetailed` call, `watch` never called), `waitFor resolves from the watch event with no intermediate find` (a fake inspector whose `findDetailed` answers not-found until a flag flips at 300 ms; the test fires the watch callback at 300 ms; asserts resolution by 400 ms and exactly 2 `findDetailed` calls), `a watch that never fires still re-checks every WAITFOR_WATCH_RECHECK_MS`, `waitFor falls back to the clamped poll on an engine with no watch`, `a watch that fails to open falls through to the poll`, `the subscription is closed on timeout and on success` (a `closed` counter is 1 in both cases), and the existing `waitfor_timeout` tests unchanged (the error message, `reason` and `matches` are byte-identical).
- **Do not**: do not delete the clamp; move it into the poll branch (G13's grep is about the unconditional form at the top of the case, not about the clamp existing). Do not race two promises where one keeps a timer alive after the other wins: that is what `createChangeSignal` is for. Do not call `evaluate()` twice before the first sleep. Do not change the `waitfor_timeout` message or its `details`: plan 74 criterion 9 and `packages/core/src/capability/device-inspect.ts:96-106` both read them.

### 222.7 — The default engine and its migration

- **Files created**: `packages/core/drizzle/<next>_<drizzle name>.sql` (generated, then the three statements of §4.7 appended), `packages/core/src/db/inspection-migration.test.ts`.
- **Files changed**: `packages/core/src/db/schema.ts:29`, `packages/session/src/manager.ts:635`.
- **Test file**: `packages/core/src/db/inspection-migration.test.ts`, modelled on `packages/core/src/db/awake-migration.test.ts` (run through the real migrator, never by re-executing a copy of the SQL): `every stored ui-server engine becomes ui-tree, in all three places`, `a device pinned to uiautomator-dump is untouched`, `a settings JSON with no engines block is untouched and does not throw`, `a null settings column is untouched`.
- **Verifiable result**: `bun test packages/core/src/db/inspection-migration.test.ts` passes; `bun run typecheck` clean.
- **Do not**: do not hand-write the generated part of the migration file; run `bun run --cwd packages/core db:generate` and append after its statements. Do not rewrite a row whose value is `uiautomator-dump` or `appium`. Do not skip the `farm_settings` statement: without it, every device admitted after the migration gets the old engine and the migration looks like it worked (`0064_awake_on_connect.sql`'s own second comment block).

### 222.8 — Honest reporting

- **Files changed**: `packages/core/src/api/devices.ts:1076` area (§4.8's `liveInspection`), `packages/core/src/capability/device-inspect.ts:5-18` (the header comment gains one sentence: the four deadlines are ceilings sized for the slowest rung of the ladder, not budgets for the default engine, and they do not change when the default does), `packages/core/src/server/ws-handlers.ts:117-119` (the `inspectorCapabilities` doc comment names the three engines).
- **Test file**: none. `liveInspection` is HTTP route wiring and the comments are comments; plan 200 §8.3 excludes both. G10 is a typecheck plus two greps, and G18 is the owner's.
- **Verifiable result**: `bun run typecheck` clean; `rg -n "liveInspection" packages/protocol/src/api/devices.ts packages/core/src/api/devices.ts` → at least one hit in each.
- **Do not**: do not change the four deadline numbers in `device-inspect.ts`. Do not add an engine field to `DeviceInfoSchema` or to `GET /api/devices`; §3.9 and §9 Q5 say why. Do not coerce `liveInspection` to the configured value when no session is open: `null` is the honest answer, exactly as `liveDisplay` does it.

### 222.9 — The SDK doc comments

- **Files changed**: `packages/sdk/src/types.ts` (§4.9 in full).
- **Test file**: none (doc comments).
- **Verifiable result**: `rg -n "realistic for uiautomator-dump\|by comparison" packages/sdk/src/types.ts` → empty; `rg -c "TBD-222-" packages/sdk/src/types.ts` → `3`; `bun run typecheck` clean.
- **Do not**: do not invent a number for a `TBD-222-` blank. Do not delete the ui-server numbers: they are real measurements and stay, attributed to the engine and device they were measured on. Do not restate the costs in `packages/sdk/README.md` or anywhere else; one place, so one measurement updates one file.

### 222.10 — The bench

- **Files changed**: `scripts/bench-device-nfrs.ts` (§4.11).
- **Test file**: none (a device tool; `--help` is the mechanical check).
- **Verifiable result**: `bun run scripts/bench-device-nfrs.ts --help` lists `--engine` and `--waitfor-cycles` and exits 0 without touching adb.
- **Do not**: do not change the default engine of the bench to `ui-tree`; an unattended re-run of the previous command must keep measuring the previous thing. Do not remove the 2000 ms p95 regression bound. Do not make this a test file.

### 222.11 — The spec and the package docs

- **Files changed**: `docs/spec.md` (§4.10: §8 rewritten in full, §5.1's inspector row and the lock sentence), `packages/drivers/src/inspector/ui-server/README.md` (one paragraph: this engine is now rung 2, chosen when the agent's `ui-tree` service is unavailable; nothing about it changes), `packages/session/README.md` (the "Inspector lifecycle" paragraph plan 208 added gains the ladder and the push `waitFor`), `packages/drivers/README.md` if it enumerates the inspector engines (check with `rg -n "uiautomator-dump" packages/drivers/README.md` first; edit only if it does), `docs/mvp/02-inspector-readiness.md` is **not** edited (an MVP document is a decision record, plan 202 §2).
- **Test file**: none.
- **Verifiable result**: `rg -n "TBD by plan 222\|plans 221 and 152" docs/spec.md` → empty; `rg -n "ui-tree" docs/spec.md` → at least 3 lines.
- **Do not**: do not append a "revised in" note or a history line to the spec; a plan that changes a section replaces its text (plan 202's §0 "Rewritten, never appended"). Do not leave the skeleton's `waitFor` in §5.1's inspector-interface column: it is not a method on `Inspector`.

### 222.12 — Status, greps, and the handoff

- **Files changed**: this document (`> Status:` and §11).
- **Verifiable result**: every §10 proof answers as its row says; `GREP_222` is empty; `bun run typecheck` is clean; `bash scripts/check-plan-status.sh` passes; `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell.
- **Do not**: do not write `implemented` while G12 and G15 to G18 are open; write `implemented (software)`.

## 6. Acceptance criteria

1. G1 to G11, G13, G14, G19 and G20 of §0 pass by their named commands.
2. `bun run dev` with one attached device whose guest agent is ready and whose accessibility service is enabled: the log shows `inspector ready: ui-tree on <id> in <N> ms` (plan 208's line), no `am instrument` is run for the inspector, and `GET /api/devices/<id>` reports `inspection: "ui-tree"` and `liveInspection: "ui-tree"`.
3. On a device whose agent is absent or whose service is not enabled, the same run logs `the ui-tree inspector cannot be used on <id> (<reason>) — falling back to ui-server`, broadcasts one `device.inspector.fallback` with `from: "ui-tree"`, `to: "ui-server"`, records one `session.degraded`, and `liveInspection` reads `ui-server` while `inspection` still reads `ui-tree`.
4. Opening the Inspector tab on a `ui-tree` device answers `inspect.status` with `state: 'ready'`, `engineId: 'ui-tree'` and a capability list containing `dump`, and a tree renders.
5. A script calling `waitFor` for an element that appears when a button is tapped resolves within 100 ms of the tap on the lab device, and the core log shows one `find` before the wait and one after the event, not a stream of them.
6. A script calling `dump()` on a `ui-tree` device gets a tree whose root is `className: "hierarchy"` and whose nodes carry exactly the eleven `UiNodeSchema` keys, indistinguishable from the same screen dumped through `ui-server` (plan 221's G3 measured this; this criterion is that it holds through the engine).
7. `POST /api/v1/cap` with `device.find` on a `ui-tree` device with no job and no Inspect tab answers through `ui-tree` (the device's `dumpsys activity` shows no UiAutomation client at all).
8. Every §10 proof answers as its row says.
9. `ps -Ao pid=,command= | grep -i "[o]penpf"` shows nothing but the shell after the tests.

## 7. Test plan

Scoped commands only, one invocation at a time, never concurrently with another run, never a bare `bun test` (`CLAUDE.md`).

The backend tests below are on plan 200 §8.3's critical list: the protocol schemas and the engine-combination validator are the wire contract; the inspector lifecycle state machine (which is what the ladder and the push `waitFor` are) is named there explicitly; and the migration rewrites rows already on disk.

### 7.1 Protocol

```bash
bun test packages/protocol/src/settings.test.ts
bun test packages/protocol/src/registry.test.ts
```

### 7.2 Drivers

```bash
bun test packages/drivers/src/inspector/ui-tree/inspector.test.ts
bun test packages/drivers/src/inspector/
```

The second command is the directory, to prove the ui-server and dump engines are untouched.

### 7.3 Session and core

```bash
bun test packages/session/src/change-signal.test.ts
bun test packages/session/src/device-executor.test.ts
bun test packages/session/src/inspector-factory.test.ts
bun test packages/core/src/db/inspection-migration.test.ts
bun test packages/core/src/network/
bun run typecheck
```

Manual smoke on the executor's own machine, one device, no lab hardware needed beyond a phone with the agent installed:

```bash
bun run reset
bun run dev &                                  # note the pid; kill it at the end
sleep 30
# the engine that was picked, and why if it was not ui-tree
curl -s http://127.0.0.1:7700/api/devices | bun -e 'const r = await new Response(Bun.stdin).json(); console.log(r.devices.map(d => d.id).join("\n"))'
curl -s http://127.0.0.1:7700/api/devices/<id> | bun -e 'const r = await new Response(Bun.stdin).json(); console.log(r.device.inspection, r.device.liveInspection)'
# expected on a prepared device: "ui-tree ui-tree"
kill %1; ps -Ao pid=,command= | grep -i "[o]penpf"      # empty
```

### 7.4 Owner smoke and measurements (`ENKAKU_TEST_DEVICE=1`, lab device attached)

Numbered, run by the owner. Steps 1 to 4 need the lab device only; steps 8 and 9 need the farm.

1. Provision the lab device with plan 221's APK and let `ensureAccessibilityEnabled` run. Confirm with `adb -s <serial> shell settings get secure enabled_accessibility_services` that the component is listed.
2. `bun run dev`, wait for the session, and confirm the log line `inspector ready: ui-tree on <id> in <N> ms`. Paste it into §11.
3. Find and dump cost (G15, G16):
   ```bash
   ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video --engine ui-tree
   ```
   Expect `find() p95 < 200 ms`. Paste the `dump() latency`, `find() p50`, `find() p95` and `find() max` rows into §11.
4. Push latency (G17):
   ```bash
   ENKAKU_TEST_DEVICE=1 bun run scripts/bench-device-nfrs.ts --serial <serial> --skip-video --engine ui-tree --waitfor-cycles 20
   ```
   Expect `waitFor push p95: <N> ms` with N < 100. Paste the line into §11.
5. Subscription hygiene: run a script that calls `waitFor` twice concurrently on the same device, then `adb -s <serial> forward --list`. Expect the same number of forwards as before the script ran, and one `ui.watch` connection while it runs (the agent's status screen Inspector section shows `Watching: yes`, plan 221 §4.9).
6. Fill the three `TBD-222-` blanks in `packages/sdk/src/types.ts` from steps 3 and 4 (G12), and re-run `bun run typecheck`.
7. Comparison against the fallback engine, so the SDK table is honest for both: re-run step 3 with `--engine ui-server` and paste those rows into §11 too.
8. The engine named is the engine used (G18): on a farm with at least one device whose accessibility service could not be enabled, confirm `GET /api/devices/:id` reports `liveInspection: "ui-server"` for it and `"ui-tree"` for a prepared device, and that the Inspector tab's header names the same engine in each case.
9. Ten minutes of the owner's usual pack job across the farm: confirm zero `session.degraded` events with `to: 'uiautomator-dump'`, and that every `from: 'ui-tree'` fallback names a reason an operator can act on.
   ```bash
   sqlite3 <dataDir>/enkaku.db "select meta from device_events where kind='session.degraded' and at > strftime('%s','now') - 600"
   ```

### 7.5 Not run

No `bun test` without a path, ever. No test under `packages/studio` or `packages/ui`: they have none and none is added (plan 200 §8.3). No Kotlin test: this plan changes no file under `apps/guest-agent`.

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | R4's OEM caveat bites on the farm and most devices cannot enable the accessibility service, so the "new default" is a fallback everywhere. | The ladder is designed for exactly that: every device keeps working on ui-server, the hop is broadcast and recorded with a reason a human can act on, `liveInspection` names it per device, and nothing about ui-server changes. The failure mode is a farm that performs as it did before this plan, visibly. |
| R2 | `TYPE_WINDOW_CONTENT_CHANGED` is not emitted for a change a person can see (a `SurfaceView`, a game canvas, a WebView repaint), so a push-only `waitFor` hangs for its whole timeout. | The bounded one-second re-check (§3.5), sized to the SDK's own default interval so a watch-backed wait is never slower than what was already promised. G4 tests the case where the watch never fires at all. |
| R3 | Two concurrent `waitFor` calls each open a `ui.watch`, and the agent closes the first (plan 221 §3.2 decision 4). | One subscription per inspector, multiplexed with a subscriber set and a coalesced open (§3.6, §4.2), tested by `two watch subscribers share one agent connection and the last close tears it down`. Step §7.4 5 checks it on hardware. |
| R4 | The long-lived subscription holds a guest-agent session reference forever and leaks a forwarded port when a script dies. | The hold is released in the executor's `finally` around the wait, and again by `onClose` when the agent drops the connection, both through one shared `closed` flag (§4.6 step 5). Step §7.4 5 checks the forward count returns to its baseline. |
| R5 | The migration rewrites an operator's deliberate `ui-server` pin. | It does, and says so in the migration comment and the release note. `'ui-server'` is indistinguishable on disk from the default nobody chose, and the alternative (leave every existing farm on the old engine forever) is the plugin-seeding class of mistake CLAUDE.md records. A pin to `uiautomator-dump` or `appium` is untouched. |
| R6 | A running ui-server or a stray `uiautomator dump` suppresses the accessibility service, so `ui-tree` silently returns an empty tree. | The ladder never starts both on one device (§3.8), and after plan 208 the only remaining `UiautomatorDumpInspector` construction in non-test code is the factory's own rung 3. `ui.status()` separates "enabled" from "connected", so a suppressed service is reported as not connected rather than as an empty tree, and the ladder falls back instead of proceeding. |
| R7 | Losing `inspector.setText` changes what a published script's `type()` does. | The call falls into `resolveTextRoute`, whose rung 1 is the agent's own IME and is already unicode-clean (§3.7). `ScriptTypeResult.via` reports `agent-ime` instead of `ui-server-set-text`, which is the field's purpose. §9 Q3 carries the question of adding `ui.setText` to the agent. |
| R8 | The `ui-tree` probe adds a control-socket round trip to every session build on a farm where the agent is slow. | Bounded at `UI_TREE_PROBE_BUDGET_MS = 3_000`, and it runs inside plan 208's background prewarm (after the first video frame), so it delays no picture. The persisted `agentStatus` read short-circuits it entirely for a device whose agent is not `ready`. |
| R9 | `find()` on `ui-tree` and `find()` on `ui-server` disagree for the same selector, so swapping the engine changes a script's behaviour. | The guard is deliberately kept identical (§3.3), and `find()` is written as the dump engine's separate implementation so the ambiguity the new engine can see does not change what `find()` returns. §7.4 step 7 measures both engines on the same screens. |

## 9. Open questions

1. **Whether a `ui-tree` device should keep a `wm size` probe for the find guard at all.** The guard needs a viewport; `ui.dump` returns `widthPx`/`heightPx` for free, but `ui.find` does not, so the engine pays one `wm size` per session exactly as ui-server does. Seeding the cached viewport from a dump when one has already run would remove it. Not designed here because it makes a resolved-once promise mutable, and the saving is one probe per session. The owner or a later plan may decide it is worth it.
2. **`uiAutomationFlags` and coexistence.** Plan 208 §9 Q4 and plan 221 §9 Q2 leave open whether `UiTreeService` must be able to run while a ui-server holds `UiAutomation`. This plan makes it unnecessary by never starting both on one device (§3.8), so the field is still not sent and the openatx pin is not moved. It becomes a real question only if a future plan wants a live engine swap (Q4 below) or wants the Inspect tab on one engine while a job uses another.
3. **Whether the guest agent should grow element actions (`ui.setText`, `ui.click`, `ui.longClick`).** `AccessibilityNodeInfo.performAction` can do all three, and it would restore the scoped `setText` `ui-server` has (§3.7). It is Android work in plan 221's file, not this plan's, and the fallback (the agent's own IME) is already unicode-clean. The owner decides whether the scoping is worth a second APK change.
4. **Whether a `ui-tree` engine that loses its service mid-session should fall back live.** Plan 208 §2 set the rule that the ladder is evaluated once per session and a dead engine is not swapped at runtime; this plan keeps it, so a service killed by OEM security software leaves that session erroring until the device reconnects. A live swap needs a watchdog for an engine that has no process, which is a different design. Not decided here.
5. **Whether `GET /api/devices` (the list) should carry `liveInspection` too.** It does not today, for the reason `DeviceInfoSchema`'s `agent` field states: the fleet payload does not grow per device per fetch. A Screens grid that wanted to badge degraded devices would need it. The owner decides after seeing §7.4 step 8.
6. **The release note's wording about the migration.** §4.7 rewrites a stored `ui-server` on every farm. The exact sentence an operator reads ("your devices now use the guest agent's inspector where it is available; to pin ui-server, select it per device") is the owner's to write, not this plan's.

## 10. Removed

Forbidden words this area introduces or carries (in the inspector code, the session executor and factory, and this plan's own files, outside `docs/archive/` and the plan documents): `lease`, `holder`, `assist`, `cluster` (as the product noun), plus the two stale claims this plan's area is accountable for, `poll the inspector` as a description of the default `waitFor`, and `ad-hoc dump`.

```
GREP_222 = rg -n -i "lease|holder|assist|cluster|ad-hoc dump" packages/drivers/src/inspector packages/session/src/inspector-factory.ts packages/session/src/device-executor.ts packages/session/src/change-signal.ts --glob '!**/*.test.ts'
```

Expected output: empty.

| What | Where it was | Proof |
|---|---|---|
| The unconditional 80 ms poll clamp at the top of the `waitFor` case (the `waitFor` half of MVP 02 §2.6) | `packages/session/src/device-executor.ts:476`, `const interval = Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)` | `rg -n "Math\.min\(call\.args\.intervalMs" packages/session/src` → empty at the top of the case; the clamp survives only inside the no-watch branch, which the same grep locates by line for the reviewer |
| The `instrumentation` lock on the default inspector path (MVP 13 A.9 row 3) | `packages/drivers/src/descriptors.ts:79` and `:129` were the only two inspector engines, and both locked it | `rg -n "locks: \['instrumentation'\]" packages/drivers/src/descriptors.ts` → exactly 2 lines, neither of them the `ui-tree` entry; `rg -n -A 12 "id: 'ui-tree'" packages/drivers/src/descriptors.ts \| rg -n "instrumentation"` → empty |
| `'ui-server'` as the default inspector engine | `packages/protocol/src/settings.ts:388-389`, `:397`; `packages/core/src/db/schema.ts:29`; `packages/session/src/manager.ts:635` | `rg -n "default\('ui-server'\)\|inspection: 'ui-server'\|\?\? 'ui-server'" packages/protocol/src/settings.ts packages/core/src/db/schema.ts packages/session/src/manager.ts` → empty |
| The engine-agnostic cost claims in the SDK's public doc comments | `packages/sdk/src/types.ts:22` ("realistic for uiautomator-dump"), `:178-179` ("a `find` is ~80 ms by comparison") | `rg -n "realistic for uiautomator-dump\|by comparison" packages/sdk/src/types.ts` → empty |
| "Polls the inspector" as the description of `waitFor` | `packages/sdk/src/types.ts:184` | `rg -n "Polls the inspector" packages/sdk/src/types.ts` → empty |
| The Indonesian leading comment on the `Inspector` interface, and its stale engine list | `packages/protocol/src/driver.ts:140`, `/** Engine inspeksi UI (spec §7): \`uiautomator-dump\` (M4), \`ui-server\` (M4.5). */` | `rg -n "inspeksi" packages/protocol/src/driver.ts` → empty |
| The spec skeleton's `TBD` for inspector phase 2, and its wrong plan number | `docs/spec.md` §8 ("Phase 2 (plans 221 and 152 ...)") | `rg -n "plans 221 and 152\|TBD by plan 222" docs/spec.md` → empty |
| The spec skeleton's `waitFor` in the `Inspector` interface column | `docs/spec.md` §5.1, layer 4 row | `rg -n "waitFor\(sel\) screenshot\(\)" docs/spec.md` → empty |

Nothing is deleted from `packages/drivers/src/inspector/ui-server/` or `uiautomator-dump.ts`: both are rungs on the ladder and both keep every test they have.

## 11. Handoff report

- **Branch**: `worktree-agent-aeb0a9ee904a8695b`, based on `mvp` tip (`e6e86b4 docs(plans): plan 200 §8.9 — R5 reconciliation; the five critical-list tests R5 lost, assigned to plan 224`), in the isolated worktree `/Users/solpochi/Projects/oss/openpf/.claude/worktrees/agent-aeb0a9ee904a8695b`. Fast-forwarded from an unrelated prior tip (`d96d2be`, which was an ancestor of `mvp`) with `git merge --ff-only mvp` before any edit.

- **Checklist**: G1 ✅ · G2 ✅ · G3 ✅ · G4 ✅ · G5 ✅ · G6 ✅ · G7 ✅ · G8 ✅ · G9 ✅ · G10 ✅ · G11 ✅ · G12 owner (no lab device) · G13 ✅† (clamp removed from the top of the case, survives — by design — inside the no-watch poll branch; see discrepancies) · G14 ✅ · G15 owner · G16 owner · G17 owner · G18 owner · G19 ✅ · G20 ✅† (same footnote as G13: the literal grep also matches "release")

- **Commits** (oldest first, on top of `mvp` tip `e6e86b4`):
  - `19a3f60` feat(mvp-222): §4.1-§4.6 — Inspector.watch, UiTreeInspector, the engine ladder's ui-tree rung, host watch channel
  - `00c0529` feat(mvp-222): §4.3-§4.4 — push-based waitFor (ChangeSignal, WAITFOR_WATCH_RECHECK_MS)
  - `024a0c9` feat(mvp-222): §4.7-§4.9 — ui-tree becomes the default engine (migration 0071), honest deadlines, SDK doc comments
  - `3945b98` feat(mvp-222): §4.11 — bench --engine and --waitfor-cycles flags
  - `ee132a9` docs(mvp-222): §4.10-§4.11 — spec §8/§5.1 rewritten, package docs updated
  - this commit: docs(mvp-222): §5 step 222.12 — status, greps, §11 handoff

- **Typecheck**: clean. `bun run typecheck` (`bash scripts/typecheck.sh`) reports `OK` for all 19 packages (protocol, ui, adb, toolchain, drivers, scrcpy, sdk, session, harness, core, node, studio, probe-server, networking, proxy-manager, tiktok-automation-pack, mikrotik-routing, google-automation-pack, youtube-automation-pack, examples), re-verified as the final step. `scripts/bench-device-nfrs.ts` is NOT covered by `scripts/typecheck.sh` (it only walks `packages/*` and `plugins/*`); it was checked separately by hand against the same `tsconfig.base.json` compiler options (see discrepancies) and introduces no new type error beyond one pre-existing one at an unrelated, unmoved call site.

- **Tests run** (one invocation at a time, per CLAUDE.md):
  - `bun test packages/protocol/src/settings.test.ts` → 163 pass, 1 fail (the 1 failure is pre-existing and unrelated: `INPUT_ACTION_BODIES declares exactly the five verbs, in order` expects 5 verbs, the file already has 9 — nothing this plan touches)
  - `bun test packages/protocol/src/registry.test.ts` → 4 pass, 0 fail
  - `bun test packages/drivers/src/inspector/ui-tree/inspector.test.ts` → 10 pass, 0 fail
  - `bun test packages/drivers/src/inspector/` → 131 pass, 0 fail (the whole directory — ui-server and uiautomator-dump untouched)
  - `bun test packages/session/src/change-signal.test.ts` → 4 pass, 0 fail
  - `bun test packages/session/src/device-executor.test.ts` → 51 pass, 0 fail
  - `bun test packages/session/src/inspector-factory.test.ts` → 13 pass, 0 fail
  - `bun test packages/core/src/db/inspection-migration.test.ts` → 5 pass, 0 fail
  - `bun test packages/core/src/network/` → 131 pass, 0 fail (fixture widened for `DeviceSession.withEndpoint`, run because that fixture changed)
  - Not run: anything under `ENKAKU_TEST_DEVICE=1` (§7.4) — no lab device; §7.4's numbered procedure is unchanged and unrun.

- **Removed, proven** (§10):
  - `rg -n "Math\.min\(call\.args\.intervalMs" packages/session/src` → 1 match, `device-executor.ts:589`, inside the no-watch poll branch (see discrepancies — this is the row the plan's own prose already says is expected).
  - `rg -n "locks: \['instrumentation'\]" packages/drivers/src/descriptors.ts` → exactly 2 lines (`ui-server`, `uiautomator-dump`); `rg -n -A 12 "id: 'ui-tree'" packages/drivers/src/descriptors.ts | rg -n "instrumentation"` → empty.
  - `rg -n "default\('ui-server'\)\|inspection: 'ui-server'\|\?\? 'ui-server'" packages/protocol/src/settings.ts packages/core/src/db/schema.ts packages/session/src/manager.ts` → empty.
  - `rg -n "realistic for uiautomator-dump\|by comparison" packages/sdk/src/types.ts` → empty.
  - `rg -n "Polls the inspector" packages/sdk/src/types.ts` → empty.
  - `rg -n "inspeksi" packages/protocol/src/driver.ts` → empty.
  - `rg -n "plans 221 and 152\|TBD by plan 222" docs/spec.md` → empty.
  - `rg -n "waitFor\(sel\) screenshot\(\)" docs/spec.md` → empty.
  - `GREP_222` = `rg -n -i "lease|holder|assist|cluster|ad-hoc dump" packages/drivers/src/inspector packages/session/src/inspector-factory.ts packages/session/src/device-executor.ts packages/session/src/change-signal.ts --glob '!**/*.test.ts'` → 9 matches, every one of them the substring "-lease-" inside the English word "release"/"releases"/"releasing" (`inspector-factory.ts`'s `release()`/`ports.release`, `ui-server/README.md`'s "releases it", `launcher.ts`'s "release order matters", `device-executor.ts`'s "release velocity"). `| grep -viE "release"` on the same command → empty. No forbidden word is used as a live identifier, field name, or unguarded prose anywhere in the touched area — the identical shape plan 221's own §11 already documented for `GREP_221`.

- **Discrepancies between plan and code**:
  - **§10's `GREP_222`, as literally written, also matches "release".** Same false positive plan 221's own handoff already recorded for `GREP_221` on the same five-character substring. Reported rather than silently resolved, since the gate command is the plan's own gate, not the executor's to rewrite.
  - **G13/§10's clamp-removal row is imprecise about where the clamp lives, and the plan's own prose already says so.** §5 step 222.6's own "Do not" line states plainly: "do not delete the clamp; move it into the poll branch (G13's grep is about the unconditional form at the top of the case, not about the clamp existing)." The clamp (`Math.min(call.args.intervalMs, deps.session.inspectorPollIntervalMs)`) still exists, moved into the no-watch poll branch exactly as instructed — the grep therefore still finds one match, at the new, correct location, not the old unconditional one. G13/G20 are marked done with a footnote rather than left unchecked, since the code matches the plan's own stated intent to the letter; a literal "0 matches" reading of the parameter cell would have required deleting functionality three tests (`waitFor falls back to the clamped poll on an engine with no watch`, and both `uiautomator-dump`/`ui-server` cases) and the plan's own G3 depend on.
  - **`packages/protocol/src/registry.test.ts`'s new test builds its own descriptor shapes rather than importing `packages/drivers/src/descriptors.ts`'s real `engineDescriptors`, as the plan's step 222.3 literally asks.** `@enkaku/drivers` depends on `@enkaku/protocol`, never the reverse (CLAUDE.md, `00-overview.md` §4) — a `packages/protocol` test cannot import from `@enkaku/drivers` without inverting that dependency, and `packages/protocol/package.json` has no such dependency today. The test instead copies the `id`/`kind`/`locks` shape of `ui-tree`, `scrcpy-uhid`, `scrcpy-sdk`, and `adb-input` by hand (with a comment explaining why), which still exercises the real `validateEngineSelection` logic against the real lock semantics — the thing G8 actually asks to be proven.
  - **`scripts/bench-device-nfrs.ts`'s `ui-server` launcher construction (unmoved, pre-existing, at what is now line 499) fails a manual strict-mode `tsc` check** (`UiServerLauncherDeps` is missing `forward`/`listForward`/`killForward` — the launcher deps object there only supplies `hostAdb`). This predates this plan (verified by checking out the file's `mvp`-tip content and running the identical `tsc` invocation against it — same error, at line 362 before this plan's insertions). `scripts/typecheck.sh` never actually type-checks `scripts/*.ts` (it only walks `packages/*`/`plugins/*`/`examples`), which is why this has never been caught by `bun run typecheck`. Not fixed here: it is outside plan 222's scope (the `ui-server` code path, not the `ui-tree` code this plan adds), and CLAUDE.md's round policy for R6 says focus on development, list collateral failures, and move on.
  - **`DeviceSession` (`packages/session/src/session.ts`) has no `log` member at all**, so §4.4's literal instruction ("`deps.session.log?.warn?.(...)` ... If `DeviceSession` has no `log` member when this executes, drop the line rather than adding one") was followed on its own second branch: the line is dropped entirely (a plain `catch {}` with a comment), not written defensively with optional chaining.

- **Observed, not done**:
  - **`packages/drivers/src/inspector/ui-tree/inspector.ts`'s find-guard warning and `packages/session/src/runner/trace.ts`'s `resolveFramePolicy`** — `ui-tree`, like `ui-server`, talks to the device over a socket outside the per-device adb queue, so it arguably qualifies for `resolveFramePolicy`'s `'per-action'` trace-capture policy the same way `ui-server` does (the function's own doc comment reasons from "off the per-device adb queue", which is equally true of `ui-tree`). Plan 222's own §4/§5 never names `trace.ts` as a file to change, so this was left alone rather than guessed at; noted for whoever revisits trace capture policy next.
  - **`scripts/bench-device-nfrs.ts`'s `--engine ui-tree` code path is written against the real driver functions (`createGuestAgentLauncher`, `createGuestAgentClient`, `createGuestAgentWatch`, `UiTreeInspector`) but has never been run against a device** — there is no lab device in this environment. `--help` was verified to list both new flags and exit 0 without touching adb, which is §5 step 222.10's own stated verifiable result; the owner's first real run of `--engine ui-tree` is also its first real test.
  - **The three `TBD-222-` blanks in `packages/sdk/src/types.ts` are left as the plan's own G12 asks** — no number was invented for them.

- **Open questions hit**: none of §9's six items blocked a step. §9 Q1 (find-guard `wm size` probe caching) and Q2 (`uiAutomationFlags`) were read and left exactly as the plan says to leave them (Q2's field is not sent; Q1's probe still runs once per session via `screenSize()`). Q3 (`ui.setText`), Q4 (live engine swap) and Q5 (`liveInspection` on the fleet list) were not touched, per §2's non-goals.

- **Processes**: `ps -Ao pid=,command= | grep -i "[o]penpf"` → empty (no process left running). `bun install` was run once at the start of this pass (the worktree had no `node_modules`); no adb, forward, or device session was opened at any point (no lab device was touched).
