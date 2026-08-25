# Plan 125 — M90 : A farm that stays awake, a control that knows who you are, and a session that starts cold once

> Status: implemented (software) — steps 125.1–125.11 all land, 2026-08-25, opened the same day from three field reports after the owner's first three days on a real 12+ device farm. **A farm is awake by default and stays that way** across session close, lease expiry, reconnect and a core restart (the persisted `screen_off_timeout` + `stay_on_while_plugged_in` writes, each verified by read-back or reported `refused`, each captured before the first write so `restore` is real). **A tile is no longer a dead end** — a dead stream keeps its own retry, an asleep tile offers Wake, and the Wall offers "Wake N devices". **Control knows who you are**: opening a device you already hold gives you control instead of naming you as a stranger, and §9 Q1's placeholder copy is gone. **The cold path lost its duplicated work**: the wake is paid once (2→1 cold, 1→0 for an already-awake device — counted off the wire in a test), the guest-agent bootstrap left the critical line, the video path spawns zero `adb.exe` children, and `<LiveView>` no longer waits on an HTTP round trip. **Three defects were found that this plan had not gone looking for**, all fixed: `acquireManual`'s CAS compared a clientId to a userId, so **every takeover on an authenticated farm had been refused since auth shipped**; three scrcpy error exits leaked a forward AND an orphaned server with no handle to kill it (§96.23's ghost); and a session on a `desired: 'awake'` device wrote `stayon false` on close while readiness still believed it held the device, silently dropping the phone's hold. **NOT verified on hardware.** No device was attached: §7's H1–H4 are all open, and H1 in particular — whether sleeping is what causes the owner's disconnects — decides whether the awake default is documented as a reliability fix or only as a convenience. Every branch here fails toward "more awake", never toward "dark". §9's four open questions stand, and §4.5's popup-vs-wall second session (Q3) is now worth re-asking with the wake cost gone.
> Depends on: plan 45 (M19, the readiness model), plan 92 (M57, wall-first — whose §8 risk and §9 Q2 this plan closes), plan 100 (M65, session parity — whose G5/G9/G13 measurements this plan builds on), plan 105 (M70, the control model — whose §9 Q1 this plan finally answers), plan 106 (M71, device preparation), plan 118/119 (M83/M84, adb performance — whose protocol path this plan extends to the video hot path), plan 96 §22 (the 1422 ms `svc power stayon` measurement).
> Spec references: §7.9 (driver layers), §16 (NFR: glass-to-glass < 150 ms), §19 (Dashboard, Device detail).
> Ships: packages/core/src/device/awake-policy.ts

Three reports, one root cause: **every default in this product was chosen for a shared, multi-operator farm, and the owner runs a dedicated single-operator automation farm inside a sealed phone-farm box.** Sleep to save battery, never wake a phone as a side effect, ask before taking control — all correct for a farm with colleagues in it, all actively harmful here.

---

## 0. Evidence

### 0.1 The three field reports, verbatim (owner, 2026-08-25, after three days on ~12 × SM-F721U1)

1. *"Casting suddenly stops — the tile goes black with 'Screen off', and I have to double-click each device to make it wake up. This happens to most devices, a few minutes after I add them to the farm. Do I really have to trigger a wake-up one by one? That takes forever."*
2. *"Why is the wake-up and casting delay so long? Competing apps feel almost instant. So we must have a wrong method, or a method that isn't effective."*
3. *"Take control keeps getting in the way. I open a device in browser A — that auto-takes control — and it tells me `bitorex.it@gmail.com is using this device now. Join them, or take over — not decided which should be the default here.` As if it isn't me in this tab, when it is me, under that very account."*

### 0.2 The box changes the risk model, and it is the constraint that outranks the rest

The owner's farm lives in a **phone-farm box**: the phones are physically enclosed, with no screen or hands on them. Their own words: *"if something happens to a device — say it disconnects — I can't get to it any more, I have to take the box apart and attach an LCD."*

**So the recovery cost of a bad device write is not "annoying", it is hardware disassembly.** Everything this plan writes to a phone must therefore be:

1. **Read back and verified** before it may be reported as applied — the discipline plan 89 §3.5's `lock-screen` tier already follows.
2. **Reversible over adb alone**, with the revert exercised in a test, never only in theory.
3. **Never dependent on physical access to recover.** No reboot, no touching Wi-Fi/network configuration, no lock-screen or credential changes, nothing that can strand a phone off the network.

This is a hard rule for every step below, not advice. It is why §3.3 chooses persisted device settings over runtime-only holds, and why §3.4 refuses one otherwise-attractive option outright.

### 0.3 `readiness.actual` is bookkeeping, not an observation — and this is the whole of report 1

`packages/core/src/device/readiness.ts:161-167`, quoted complete:

```ts
function rawActual(deviceId, row) {
  if (!row) return 'asleep'
  if (row.status === 'offline') return 'asleep'
  if (deps.sessions()?.get(deviceId)) return 'hot'
  if (keepAwakeApplied.has(deviceId)) return 'awake'
  return 'asleep'
}
```

That is the entire definition. **`asleep` means "this core has no session open and has not itself called `wakeDevice`" — it says nothing about the phone.** A grep across `packages/` and `plugins/` for `dumpsys power`, `mWakefulness`, `mScreenOn`, `mDisplayState` returns **zero hits outside plan prose**. A phone whose screen is genuinely lit reads `asleep`; a phone whose `stayon usb` silently did nothing reads `awake`. Neither is checkable today.

### 0.4 The treadmill, step by step, all read from the code

1. `readiness.defaultDesired` ships `'asleep'` (`packages/protocol/src/settings.ts:2232`) and is written into the device row **at admission** (`packages/core/src/registry/admission.ts:87`, `registry/device-registry.ts:481`). Every phone the owner adds is asleep *by standing intent*.
2. Minutes later one of these fires: session idle TTL **300 s** (`settings.ts:1955` → `packages/session/src/manager.ts:795`), manual-lease idle **300 s** (`packages/core/src/config.ts:36` → `lease/lease-manager.ts:433-447`), or the `readiness.maxHot: 8` cap (`settings.ts:2223`) on a farm of 12+.
3. Each of those funnels into `daemon.ts:3732` → `readiness.reconcile` → the `asleep` branch (`readiness.ts:300-308`) → `releaseAwake()` → **`svc power stayon false`** — `session.ts:711`'s own comment: *"Hand the screen back to the device's own timeout."*
4. `WallTile.tsx:173` reads `readiness.actual === 'asleep'`; `WallTile.tsx:301` checks that branch **before** `live`, so the tile can never mount `LiveView` again. `useLiveSet.ts:139` also drops the device from `eligible` entirely.
5. There is no Wake affordance left on the tile: plan 101 step 101.8 removed both the per-tile `ReadinessControl` (`WallTile.tsx:70-81`) and the farm-wide asleep counter strip (`Wall.tsx:178-189`).

**There is no timer, no boot sweep, and no auto-wake anywhere.** `readiness.ts:114-116` says so in its own words — *"This module starts no `setTimeout`/`setInterval` of its own anywhere below"* — and `start()`/`stop()` (`readiness.ts:385-394`) are empty stubs. The only escape is a human action per device.

### 0.5 Two aggravating defects

- **The default keep-awake mode is a no-op on these phones.** `prep.keepAwake` defaults to `'while-charging'` (`settings.ts:443`) → `svc power stayon usb` (`packages/session/src/wake.ts:11`). `settings.ts:22-24` already states the consequence: *"`usb` only holds the screen while plugged into USB, which does nothing for a device attached over `adb-tcp`."* So even a *woken* device on TCP has no hold and hits its own timeout.
- **A dead stream takes the device down with it.** A display error closes the entry even with live subscribers (`manager.ts:545-559`) → `session.closed` → reconcile → `asleep`. `LiveView.tsx:371-377` has a perfectly good "stopped, retry" overlay — but `WallTile.tsx:301`'s `asleep` branch renders *before* it, so the retry is swallowed and the operator is left with an inert rectangle. **That is report 1's "casting suddenly stops", exactly.**

### 0.6 The mitigation plan 92 promised no longer exists

`docs/plans/92-m57-wall-first-and-video-quality.md:1884`, §8:

> *"**The asleep rule makes the wall look dead on a farm whose devices are asleep by default.** The tiles are explicitly 'Screen off' with a working Wake, not blank (§4.7), and the strip says how many."*

**Both halves are now false** — step 101.8 deleted the tile Wake and the strip. And §9 Q2 (`92-…:1926`) — *"Should the wall offer 'Wake all visible'?"* — was never answered. This plan answers it (§3.4).

### 0.7 Report 2: the method is right; the session BUILD is what costs

Measured by the owner on real hardware, recorded at `docs/plans/96-m61-hotfixes.md:2517-2530`: a cold `stream.start` ≈ **4.3 s**, of which **`svc power stayon` alone is 1422 ms** — *"`svc` costs ten times everything else combined, because it starts a whole `app_process` JVM to reach the power service."*

Plan 92's own H1 (`92-…:97`) already reached the conclusion: wall-first is *"dominated by **session build cost**, not by decode or bandwidth."* And plan 100's G5 (`100-…:22`) records that the mechanism which would remove it — pre-warming — *"already exists … but ships off by default and, when on, warms at **wall** quality only."*

So: **scrcpy is not the wrong method.** Competitors use the same thing. What is wrong is that no fast path is actually switched on, and roughly three seconds of the cold path is duplicated or misplaced work.

**The double wake — found by this plan's sweep, recorded in no existing plan.** On a cold device the wake block runs **twice, serially**:

1. `packages/core/src/server/ws-handlers.ts:991` — `await readiness.hold(deviceId, 'viewer')` → `ensureAwake` → `wakeDevice` (`readiness.ts:218`)
2. `ws-handlers.ts:997` — `await sessions.acquire(...)` → `createSession` → `wakeDevice` again (`packages/session/src/session.ts:449`)

`createSession` never consults the readiness manager, and `skipDevicePrep` is only set for a `control` build sitting beside an open `wall` entry (`manager.ts:635-643`). **≈3.2 s burned before `starting-video` is even entered.** Plan 96 left exactly this open (`96-…:2540`): *"**Not fixed:** the redundant work itself. A restart of an already-open session should skip the wake path, or at minimum skip `svc power stayon` when the device already holds it."*

The rest of the cold path, all on the critical line:

| Cost | Where | Note |
|---|---|---|
| A full **guest-agent app bootstrap** | `session.ts:485-491` `applyTextInput`, default `textInput: 'auto'` | `am start` + ~500 ms handover (`launcher.ts:422-425`, measured) + an 8 × 500 ms `hello()` ladder (`client.ts:315-347`), up to `PAIRING_ROUNDS = 3` (`api/guest-agent.ts:79`), plus 3 `appops` and 4 `ime`/`settings` shell calls — **then the session is thrown away** (`guest-agent.ts:569-574`), so the next build redoes all of it |
| **4 `adb.exe` process spawns** | `packages/scrcpy/src/session.ts:145,184,430,436` | `push`, `shell`, `forward`, `forward --list`. Plan 119 moved exactly these onto the protocol path — **for the guest-agent and ui-server launchers only**; `daemon.ts:3773` still passes `hostAdb: hostAdbHandle.run` to scrcpy. The owner's host is Windows, where `118-…:22` records process creation as measurably more expensive |
| **Video socket handshake** | `scrcpy/session.ts:474-517` | 40 attempts × (400 ms silence window + 150 ms sleep). `app_process` cold start normally misses the first window, so 2–3 attempts (~1.1–1.6 s) is the *expected* case, not an error case |
| **`stream.start` gated behind an HTTP RTT** | `DevicePopup.tsx:957` | `<LiveView>` renders only once `GET /api/devices/:id` resolves. The video request does not need that payload |
| **Nothing is concurrent** | `session.ts` E1→E6 | One unbroken `await` chain. The jar push does not depend on the screen being on, yet never overlaps the wake |
| **The popup opens a SECOND scrcpy session** | `manager.ts:388` keys entries `(deviceId, quality)` | Double-clicking a live tile takes the phone from one H.264 encode to two; the `wall` entry then sits on its 300 s idle timer **still encoding for nobody** (`manager.ts:786-795`) |

The jar push itself **must stay** — plan 100 G13 (`100-…:30`): scrcpy-server `unlinkSelf()`s on load, so every session must push it fresh, and *"this cost two false diagnoses during the investigation this plan is built on."*

### 0.8 Report 3: the control model never asks who you are

`computeControlState` (`packages/studio/src/components/device-popup/ControlState.tsx:267-320`) takes `status`, `heldBy`, `myLeaseExpiresAt`, `myAssistGrant`, `coControlMode` — **and no user identity.** Its own doc comment explains the omission (`ControlState.tsx:232-237`):

> *"Never derived by comparing `heldBy.id` to a session id: once a farm has real auth, `toHolder` (`lease-manager.ts`) resolves a person's `id` to their authenticated `userId`…"*

**That reasoning has expired.** Auth shipped. `LeaseHolderSchema.id` is documented as *"clientId for a user (or the authenticated userId when known)"* (`packages/protocol/src/device.ts:62`), `GET /api/auth/me` already returns `user.id` (`packages/studio/src/lib/auth.ts:47`), and the label on the owner's own screen **is their email**. The comparison the comment forbids is now precisely the correct check.

Why it fires on what feels like a first open: the popup auto-claims **only** when `status === 'idle'` (`DevicePopup.tsx:396`), and an *explicitly* taken lease is deliberately **not** released when the popup closes (`DevicePopup.tsx:556-568` — only an `auto-claim` origin is released). So: take control once → close → reopen (or open a second tab) → status is `manual`, holder is you, the fresh popup has `myLeaseExpiresAt === null` → `held-by-human` → *"bitorex.it@gmail.com is using this device now."*

And the caption below it is plan 105 §9 Q1 — an unanswered internal design question — **rendered verbatim into production UI** (`DevicePopup.tsx:1143`): *"Join them, or take over — not decided which should be the default here."* `docs/design.md`'s writing rules do not allow an operator to be handed our own indecision.

## 1. Goals

1. **A farm boxed and powered stays awake and reachable without anyone touching it.** A device admitted today is awake by standing intent, stays awake across session close, lease expiry, reconnect, and a core restart, and never needs a per-device human wake.
2. **Nothing this plan writes to a phone can require physical access to undo** (§0.2). Every write is read back, verified, and revertible over adb.
3. **`readiness.actual` stops guessing.** What the UI says about a screen is either observed or explicitly marked unknown — never an inference presented as fact.
4. **A tile is never a dead end.** A stream that dies offers its retry; a sleeping device offers a wake; the Wall can wake everything it is showing in one deliberate action.
5. **Opening a device you already hold gives you control**, silently, in every tab — never a dialog naming you as a stranger, and never our own undecided question as operator-facing copy.
6. **The cold cast path loses its duplicated and misplaced work**: the wake is paid once, the guest-agent bootstrap leaves the critical line, the video path stops spawning `adb.exe`, and independent steps overlap.
7. **Click-to-first-paint is measured**, so the next latency claim is a number rather than an impression.

## 2. Non-goals

- **Server-side transcoding.** Asked for once and rejected on the record (plan 100 `:65`) — no codec dependency enters this workspace, and it would add a round trip against the §16 target.
- **Caching or skipping the scrcpy-server jar push.** Forbidden by G13 (§0.7); it caused two false diagnoses already.
- **Rewriting the readiness model** (plan 45's desired/actual/blocked/hold shape) or the lease model. Both are sound; this plan changes defaults, adds observation, and removes duplicated work.
- **Unlocking phones with a PIN/pattern.** `wake.ts:22-27` states this limit honestly and it stays a limit.
- **The full glass-to-glass NFR measurement.** It needs a browser-driving harness that does not exist here (`scripts/bench-device-nfrs.ts`'s own header). §4.7 adds the click→paint half that can be had without one.
- **Battery/thermal policy for always-on screens.** Named as a real cost in §8; a brightness or duty-cycle policy is its own plan.

## 3. Context and design decisions

### 3.1 Awake becomes the product default, not just this farm's setting

The owner's instruction was direct: *"default harus nyala dong"* — the default must be on. So `readiness.defaultDesired` flips from `'asleep'` to `'awake'` at the schema level, not merely in one farm's settings row.

This is a genuine change of product character and is worth defending. A device farm's phones exist to be looked at and driven; a fleet that goes dark five minutes after you look away optimises for a cost (battery) that a permanently-powered rack does not pay, and against the thing the product is for. Plan 45 §3.7 described the old behaviour approvingly — *"sleeps five minutes after you navigate away, without anyone having to think about it"* — and it reads very differently from inside a sealed box.

`'asleep'` remains fully supported and one setting away; what changes is which one a fresh farm starts on.

### 3.2 `hot` is not the default, and the `maxHot` cap is the reason

`awake`, not `hot`. `readiness.maxHot` defaults to 8 (`settings.ts:2223`), so on a 12-device farm a `hot` default would leave four phones `blocked: 'hot_budget_full'` — a farm that boots into a partly-failed state, with the failure worded as a budget error. `awake` has no cap: the screen is on and the device is reachable, and a session opens when something actually needs one.

### 3.3 The hold must outlive the core — which means a persisted device setting, not only a runtime hold

This is where §0.2's box constraint decides the design.

`svc power stayon` writes `Settings.Global.STAY_ON_WHILE_PLUGGED_IN` — **persistent on the device**, surviving a core restart, a core crash, and a phone reboot. `settings put system screen_off_timeout` is likewise persistent. Both are readable back, both revert with one adb write, and neither can strand a phone off the network. They are exactly the shape §0.2 demands.

So the awake policy is **two persisted writes plus a runtime nudge**, in this order:

1. `settings put system screen_off_timeout <ms>` — verified by reading it straight back, the discipline plan 89 §3.5 already uses for the lock-screen tier. This is the piece that keeps a boxed phone awake even when the core is not running at all.
2. `svc power stayon <mode>` — the existing hold.
3. `input keyevent KEYCODE_WAKEUP` (+ the existing keyguard nudge) — to light a panel that is already dark.

`prep.keepAwake`'s default moves `'while-charging'` → `'always'`, because `'usb'` is a documented no-op on `adb-tcp` (§0.5) and would make the new default a lie on exactly the farm shape this plan is for.

**The original value of every setting written is captured before the first write and stored per device**, so "restore what was there" is a real operation and not a guess — the gap plan 89 §3.6 records for the wallpaper tier, not repeated here.

### 3.4 Sleep is a connectivity risk in a box — stated as a hypothesis, to be measured, not asserted

Android powers down radios and enters Doze when the screen is off. On a farm reached over `adb-tcp`, that is a plausible mechanism for the owner's *"kalau ada apa apa dengan devicenya misalnya disconnect"* — the disconnects and the sleeping may be the same event, not two.

**This plan does not assert that.** It is H1 in §7's hardware ladder: measure reconnect/dropout rate over 24 h with `desired: 'asleep'` versus `'awake'` on the same box. If it holds, the awake default is a reliability fix and should be documented as one; if it does not, §3.1 still stands on its own reasoning. Recording it as a hypothesis rather than a conclusion is the difference between this plan and a guess.

**One option is refused outright**: anything that touches Wi-Fi configuration, power-save whitelisting via network settings, or `svc wifi`. A wrong write there strands a boxed phone permanently, and no latency or convenience win justifies that risk profile.

### 3.5 A tile must always offer the next action

Three ordering and affordance defects, one rule: **the Wall never renders a state the operator cannot act on.**

- `WallTile`'s `asleep` branch stops preceding the stream-error branch, so a dead stream shows `LiveView`'s existing retry instead of being swallowed (§0.5).
- The per-tile Wake affordance returns — as a compact action on the placeholder, not the persistent overlay 101.8 removed for good reason.
- **"Wake all visible"** lands on the Wall, answering plan 92 §9 Q2. Its own hesitation — *"the default view can wake twenty phones with one click, which is either convenient or alarming depending on whose farm it is"* — is settled by making it an explicit, labelled action that states its count (`Wake 12 devices`), never automatic.

### 3.6 `actual` gets an observation, and `unknown` becomes sayable

`rawActual` keeps its fast inference, but a real probe backs it: `dumpsys power | grep mWakefulness` (or `dumpsys display`), run on the paths that already talk to the device, cached with a timestamp. Where no observation exists, the UI says so rather than asserting `asleep` — the same rule plan 89 §3.5 applies to `unavailable`, and the same reason `deriveHealth` refuses to word `unverified` as success.

A probe costs an adb round trip, so it runs on reconcile and on demand — **never on a timer** (`readiness.ts:114`'s no-timer rule stands).

### 3.7 One wake per session start, and the readiness manager is the authority

`createSession` stops calling `wakeDevice` blindly. It takes a `deviceIsAwake()` callback (or a `skipWake` flag the caller sets from `readiness.hold`'s result), so the wake happens once, at the readiness layer, before `acquire`. On a device that is already `awake` or `hot`, it happens zero times.

This is the single largest win available: ≈1.6 s on any cold open, ≈3.2 s where it was doubled, on the owner's own measurement.

### 3.8 The guest-agent bootstrap leaves the critical line

Text input is not needed to paint a frame. `applyTextInput` moves off the pre-video chain and runs **after the first frame**, its failure staying exactly as non-fatal as it already is. The device becomes visible in a fraction of the time; the IME arrives a moment later, which is when a human could first type anyway.

This does not fix `withEphemeralSession`'s open-and-throw-away lifecycle (plan 119 §9 Q1's open question) — it takes it off the path where it hurts. Fixing the lifecycle stays that plan's to answer.

### 3.9 The video path joins plan 119's protocol path

`packages/scrcpy/src/session.ts`'s `push`, `forward` and `forward --list` move from `adb.exe` spawns to the protocol-level client plan 119 already built and proved for two other launchers. Four spawns per session become zero. On Windows — the owner's host, and the platform plan 118 §0.2 measured as worst for process creation — this is the difference between a fixed multi-hundred-millisecond tax and none.

### 3.10 Opening a device you already hold is not a takeover

`computeControlState` gains `myUserId: string | null` and one new state, checked **after** `i-hold` and before `held-by-job`:

```
held-by-me-elsewhere — heldBy.kind === 'user' && heldBy.id === myUserId
```

Its primary action is **Resume control here** — move the lease to this client — never "take over" from yourself. And the popup's auto-claim widens from `status === 'idle'` to *"idle, or held by me"*, so in the common case the state is never reached at all: you open the device, you have control, exactly as report 3 asks.

`myLeaseExpiresAt` stays as the first check. It remains the unambiguous fact about *this* client and is correct even when auth is off and two clients share one identity; the id comparison is a second, weaker signal used only when the first says nothing.

### 3.11 Plan 105 §9 Q1, answered

For a takeable **human** holder who is not you, **Take control is the primary action and Assist is secondary.** The reasoning: this product's normal operator is one person driving a rack, so the overwhelmingly common intent is "I want this phone"; Assist is the specialised case and reads better as the deliberate second choice. Assist keeps equal prominence for an **agent** holder, where joining a running automation genuinely is the more likely intent.

The caption goes. Whatever we choose, the operator is told what each button does — never that we could not decide.

### 3.12 There is no screen — and that changes the cost side, not the design

Recorded 2026-08-25, from the owner, after §3.1–§3.5 were already written against the wrong mental picture: **the box holds bare phone motherboards with no LCD attached.** Power in, adb out; casting is the only way anything is ever seen.

Two consequences, in opposite directions.

**The cost argument for sleeping collapses.** §8's original heat-and-burn-in risk assumed twelve lit panels. There is no backlight — which is both the dominant power draw of a phone screen and the entire mechanism of burn-in — so neither cost exists. The risk row is struck through rather than deleted, and §9 Q1's brightness-floor question is moot, because "always-on screens cost heat" is the obvious assumption and the next reader will arrive with it too.

**But keeping Android awake is still necessary, and for a reason that has nothing to do with panels.** `mWakefulness` is a framework state, not a description of hardware: when it goes to `Asleep` the compositor stops producing frames, which is exactly why an asleep tile shows nothing to capture. `svc power stayon` and `screen_off_timeout` are the levers that hold that framework state, and they are just as load-bearing on a headless motherboard as on a phone with a screen. Nothing in §3.3 changes.

It also makes §0.2 stricter than it was written. "Hard to reach" understated it: **there is no second access path at all.** No panel to read an error off, no touchscreen to dismiss a dialog with, no recovery that does not go through adb. A write that costs a device its adb reachability is unrecoverable in the field, not merely expensive — which is why §3.4 refuses the whole Wi-Fi/network category rather than trying to make it safe.

## 4. Technical design

### 4.1 `packages/core/src/device/awake-policy.ts` (new — the plan's `Ships:` artefact)

```ts
/** What the phone had before Enkaku touched it, so "restore" is real (§3.3). */
export interface CapturedPowerState {
  screenOffTimeoutMs: number | null   // null = could not be read
  stayOnWhilePluggedIn: string | null
  capturedAt: number                  // unix seconds
}

export interface AwakePolicy {
  /** Read and remember the device's own settings. Idempotent; never overwrites an existing capture. */
  capture(deviceId: string): Promise<CapturedPowerState>
  /** Apply the persisted keep-awake writes, each verified by read-back (§3.3). Returns what actually took. */
  apply(deviceId: string, mode: KeepAwakeMode): Promise<AwakeApplyResult>
  /** Put back exactly what `capture` saw. Idempotent. */
  restore(deviceId: string): Promise<AwakeApplyResult>
  /** Observed screen state (§3.6), or `unknown` when the probe could not run. */
  observe(deviceId: string): Promise<ObservedScreen>
}

export type ObservedScreen = { state: 'on' | 'off' | 'unknown'; reason: string | null; observedAt: number }

export interface AwakeApplyResult {
  screenOffTimeout: 'applied' | 'unchanged' | 'refused'
  stayOn: 'applied' | 'unchanged' | 'refused'
  reason: string | null
}
```

`ObservedScreen.state === 'unknown'` is a first-class outcome and must never be rendered as `off` (§3.6).

### 4.2 Schema and settings changes

| Setting | From | To | File |
|---|---|---|---|
| `readiness.defaultDesired` | `'asleep'` | `'awake'` | `packages/protocol/src/settings.ts:2232` |
| `prep.keepAwake` | `'while-charging'` | `'always'` | `settings.ts:443`, `:477` |
| `prep.screenOffTimeoutMs` | — (new, optional) | default `1800000` (30 min), `null` = leave alone | `settings.ts` prep block |

`DeviceReadinessSchema` gains `observed: ObservedScreenSchema | null` — **beside** `actual`, never replacing it: `actual` stays the scheduling-relevant bookkeeping value the whole system already reasons about, and `observed` is what the UI may show a human. Two different questions, two fields.

New device columns for the capture of §3.3: `powerCapture` (JSON, `CapturedPowerState`), mirroring how `labelFingerprint`/`labelState` already store a device's last-confirmed answer.

### 4.3 Wall and tile

- `WallTile.tsx:301` — branch order becomes: stream error → asleep → live → budgeted. The error branch must win, always.
- The `asleep` placeholder gains a compact **Wake** button (not the removed persistent overlay), calling the existing `setDeviceReadiness(id, 'awake')`.
- `Wall.tsx` gains **Wake all visible** — an explicit action naming its count, applied to the visible, non-blocked set, reporting outcomes grouped (`docs/design.md`'s multi-device report rule).
- `useLiveSet.ts:139` — an `asleep` device stays out of the live set, unchanged. This plan wakes devices; it does not make a sleeping phone stream.

### 4.4 Readiness lifecycle

- Reconcile on **reconnect** for a device whose `desired` is `awake` — the gap at `readiness.ts:255-261`, where `keepAwakeApplied.delete` on an offline blip means a `desired: 'awake'` device never gets re-woken.
- A **boot sweep**: on core start, reconcile every device with `desired !== 'asleep'`, bounded by the existing build-lane discipline. `readiness.ts:385-394`'s empty `start()` is where this goes. This is the one new periodic-ish behaviour, and it runs **once at boot, not on a timer** — the no-timer rule (`readiness.ts:114`) stands.

### 4.5 The cold path

| Change | File | Expected saving |
|---|---|---|
| `createSession` skips `wakeDevice` when readiness already holds the device awake (§3.7) | `packages/session/src/session.ts:449`, `manager.ts:635-643`, `ws-handlers.ts:991-997` | **≈1.6 s, ≈3.2 s where doubled** (measured basis: `96-…:2517`) |
| `applyTextInput` runs after first frame (§3.8) | `session.ts:485-491` | the whole guest-agent bootstrap, ≥500 ms observed, seconds worst case |
| scrcpy `push`/`forward`/`forward --list` onto the protocol client (§3.9) | `packages/scrcpy/src/session.ts:145,430,436`, `daemon.ts:3773` | 4 process spawns/session, Windows-weighted |
| `<LiveView>` no longer gated on `GET /api/devices/:id` | `DevicePopup.tsx:957` | one HTTP RTT |
| Overlap the jar push with the wake where a wake is still needed | `session.ts` E2/E6 | up to the shorter of the two |
| Popup reuses the Wall's open session, or stops the orphaned `wall` entry when it opens a `control` one | `manager.ts:635-643`, `LiveView.tsx:463` | one redundant H.264 encode on the phone |

**Not changed, deliberately**: the jar push itself (G13), the video-socket retry ladder (its 400 ms window is what makes a slow `app_process` survivable — shortening it trades a rare failure for a common one), and `UHID_SETTLE_MS` (an input concern, not video).

### 4.6 Control state

```ts
export interface UseControlStateInput {
  status: DeviceStatus | null
  heldBy: LeaseHolder | null
  myLeaseExpiresAt: number | null
  myAssistGrant: { expiresAt: number; primary: LeaseHolder } | null
  coControlMode: CoControlMode
  myUserId: string | null            // NEW (§3.10) — from GET /api/auth/me
}

// NEW state, between `i-hold` and `held-by-job`:
| { kind: 'held-by-me-elsewhere'; holder: LeaseHolder; primary: ControlAction /* Resume control here */ }
```

Precedence becomes: `i-assist` → `i-hold` → **`held-by-me-elsewhere`** → `free` → `held-by-job` → `held-by-human`.

`DevicePopup.tsx:396`'s auto-claim condition widens to `status === 'idle' || heldByMe`. `DevicePopup.tsx:1143`'s caption is deleted and the `held-by-human` branch re-ordered per §3.11.

### 4.7 Measurement

A `performance.now()` mark at the click (`WallTile`'s double-click / the popup open) carried through to `LiveView`'s `markPainted()` (`LiveView.tsx:392-428`), reported as one number in the existing `session.progress` readout and logged. The server leg is already instrumented — `logSlowCommand` fires above 2000 ms (`ws-handlers.ts:470`) and `transport.controlReplyMsP95` is on `/api/adb/stats` — so this closes the browser half without needing the e2e harness §2 rules out.

## 5. Implementation steps

Three workstreams, run in this order (the owner's own priority: the farm has to stop going dark first).

### Workstream A — the farm stays awake

**125.1 — `awake-policy.ts`: capture, apply, restore, observe (§4.1)**
- [ ] The module, with read-back verification on every write and an explicit `refused` outcome.
- [ ] `powerCapture` column + migration (`bun run --cwd packages/core db:generate`).
- [ ] Unit tests including: a write that does not read back is `refused`, never `applied`; `restore` is idempotent; `observe` returns `unknown` rather than `off` when the probe fails.

**125.2 — Defaults flip, and the persisted timeout joins the wake (§3.1, §3.3, §4.2)**
- [ ] `readiness.defaultDesired` → `'awake'`; `prep.keepAwake` → `'always'`; new `prep.screenOffTimeoutMs`.
- [ ] `wakeDevice` (`packages/session/src/wake.ts`) calls the policy so the persisted writes happen alongside the runtime nudge.
- [ ] A migration note: existing farms keep their stored value; only a fresh farm gets the new default.

**125.3 — Readiness observes, reconnects, and sweeps at boot (§3.6, §4.4)**
- [ ] `observed` on `DeviceReadinessSchema`, populated from the policy probe, never on a timer.
- [ ] Reconcile on reconnect for `desired !== 'asleep'`.
- [ ] Boot sweep in `readiness.start()`.

**125.4 — The Wall stops being a dead end (§3.5, §4.3)**
- [ ] Branch reorder so a stream error always shows its retry.
- [ ] Wake affordance on the asleep placeholder.
- [ ] **Wake all visible**, naming its count, with a grouped outcome report.
- [ ] Studio surfaces `observed` where it disagrees with `actual`, worded as an observation.

### Workstream B — control knows who you are

**125.5 — `held-by-me-elsewhere` (§3.10, §4.6)**
- [ ] `myUserId` threaded from the auth context into `useControlState`.
- [ ] The new state, its precedence position, and **Resume control here**.
- [ ] Auto-claim widened to "idle, or held by me".
- [ ] Tests: two tabs, same user; auth off (`myUserId === null`) must behave exactly as today.

**125.6 — Answer §9 Q1 and delete the placeholder copy (§3.11)**
- [ ] Take control primary / Assist secondary for a human holder; equal for an agent holder.
- [ ] `DevicePopup.tsx:1143`'s caption removed; both buttons carry their own plain explanation.
- [ ] Update plan 105 §9 Q1 to record the answer and the date.

### Workstream C — the cold path

**125.7 — Kill the double wake (§3.7)** — the single biggest win; do it first and measure before continuing.
**125.8 — `applyTextInput` off the critical line (§3.8).**
**125.9 — scrcpy onto the protocol path (§3.9).** **DONE** — `packages/scrcpy/src/session.ts`'s `push`, `forward`, `forward --list` and `forward --remove` now run over plan 119's `client.forward`/`listForward`/`killForward` and `packages/adb`'s `sync:`-service `pushFile`, wired in `daemon.ts`'s `makeScrcpy`. A session that used to spawn **four** `adb.exe` children spawns **zero** for push and forward (the long-lived `adb shell app_process` stays, by nature); `session.test.ts` counts both shapes with a fake that records every `hostAdb` argv. The CLI path is kept behind one `if` (`packages/node/src/hosts.ts` still runs on it), and the protocol ADD — the one shape nobody has exercised against real hardware, since neither existing launcher ever asked for `tcp:0` — falls back to it once, with a warning, rather than costing the farm its video. Also fixed while in there: `startScrcpySession` used to leak the forward, the host-side adb child AND the device-side server whenever the socket handshake failed (§96.23's 7m42s ghost had no `close()` to be reached through), so teardown now runs on every exit route.
**125.10 — Ungate `<LiveView>`, overlap push with wake, stop the orphaned wall encode (§4.5).**
**125.11 — Click-to-paint measurement (§4.7).**

## 6. Acceptance criteria

1. A freshly admitted device is `desired: 'awake'` and its screen is on, with no human action.
2. Every phone stays awake and adb-reachable after: the last viewer leaves, a manual lease expires, a session idles out, a device reconnects, and **the core process restarts**.
3. No write this plan makes to a phone requires physical access to undo; `restore` puts back exactly what `capture` read, proven by a test.
4. A write that cannot be read back reports `refused` with a reason, and is never counted as applied.
5. `readiness.observed` is `unknown` — never `off` — when no probe succeeded, and the UI never words `unknown` as asleep.
6. A tile whose stream dies shows its retry, not "Screen off".
7. A sleeping tile offers Wake; the Wall offers **Wake all visible** naming its count, reporting outcomes grouped.
8. Opening a device you already hold in another tab gives you control, with no dialog naming you as its current holder.
9. The strings "not decided which should be the default here" and any other undecided-design copy no longer appear in Studio.
10. With auth disabled, control behaves exactly as it does today (`myUserId === null` changes nothing).
11. `wakeDevice` runs **at most once** per session start, and zero times for a device already awake or hot — asserted by a test that counts the calls.
12. `applyTextInput` no longer blocks the first frame; a device with no guest agent still reaches `ready` and still streams.
13. `packages/scrcpy/src/session.ts` spawns no `adb.exe` process for push or forward.
14. Click-to-first-paint is reported as a number in the core log and in the session progress readout.
15. `bun run typecheck` passes; scoped tests pass for every directory touched.
16. `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

Unit and component tests colocated as usual, scoped per directory (CLAUDE.md's rule — **no full suite**).

The parts that only real hardware can settle, for the owner to run on the box:

- **H1 (§3.4) — does sleeping cause the disconnects?** 24 h on the same box, `desired: 'asleep'` vs `'awake'`, counting `device.status → offline` transitions and reattach failures. This decides whether the awake default is documented as a reliability fix or only as a convenience.
- **H2** — cold `stream.start` before and after 125.7, from the existing `logSlowCommand` line. Expected: ≈4.3 s → ≈2.7 s from the single-wake fix alone, ≈1.5 s cumulative after 125.8–125.10.
- **H3** — does `screen_off_timeout` + `stayon true` actually hold an SM-F721U1 over `adb-tcp` for 24 h unattended, and does `restore` put both back?
- ~~**H4** — thermals~~ **WITHDRAWN** (§3.12): there are no panels to heat. If a thermal question is ever worth asking on this box it is about the SoCs under sustained H.264 encoding, which is a video-profile question and belongs with plan 92/100, not here.

Manual smoke: `bun run dev` + `bun run dev:studio`; admit a device and confirm it is awake without intervention; kill the core and confirm the phone is still awake and reachable; open the same device in two tabs.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| ~~**Always-on screens in a closed box: heat and burn-in.**~~ **WITHDRAWN 2026-08-25 — the premise was wrong.** The owner's box holds bare phone **motherboards with no LCD attached at all** (owner, 2026-08-25). There is no backlight, which is both the dominant power draw and the entire burn-in mechanism, so neither cost exists. What remains is the SoC/GPU cost of composing frames, which is not optional anyway: it is what gives scrcpy something to capture. See §3.12 | This risk row is kept struck through rather than deleted, because "always-on screens cost heat" is the obvious assumption and the next reader will make it too |
| **A power write strands a boxed phone** | §0.2's three rules, enforced by §4.1's API shape: read-back or `refused`, capture-before-write, revert exercised in a test. Nothing touches Wi-Fi or credentials (§3.4) |
| **Flipping a product default surprises an existing farm** | Only a *fresh* farm gets the new default; a stored value is never rewritten (125.2). Documented in the guide and in the spec's own settings table |
| **Skipping the wake breaks a device that genuinely was asleep** | The skip is driven by the readiness manager's own state, which is the thing that woke it; criterion 11's call-counting test pins it, and the fallback is the existing `ensureAwake` early-out (`readiness.ts:213`) |
| **Moving `applyTextInput` after the first frame changes IME timing under a script** | It is already best-effort and already swallowed on failure (`session.ts:485`'s `.catch`). A job that needs text input awaits the session's `ready`, which still gates on the same work completing |
| **The protocol forward path regresses video where it worked for the agent** | Plan 119 shipped and proved the mechanism on two launchers; 125.9 reuses it rather than reimplementing, and the fallback to `hostAdb.run` stays one line away |
| **`myUserId` is null with auth off, silently disabling the fix** | Criterion 10 makes that the explicitly tested, unchanged path — `myLeaseExpiresAt` remains the first and strongest check (§3.10) |

## 9. Open questions

1. ~~**Should `awake` also keep the panel at minimum brightness?**~~ **MOOT, closed 2026-08-25.** There is no panel (§3.12) — the box holds bare motherboards. A brightness floor would dim the framebuffer scrcpy captures for no saving at all, which is strictly worse than doing nothing.
2. **Should a device restore its captured power settings on Forget/Block**, the way physical labelling clears its label (plan 89 §3.7)? Symmetry says yes; the box says a Forget that leaves a phone asleep and unreachable is worse than one that leaves it awake. Leaning toward *restore on Forget only when the device is reachable, and record it when not* — owner's call.
3. **Does the popup's `control`-quality session earn its existence** once 125.7–125.10 land, or should opening a device simply re-profile the Wall's existing `wall` session upward? Plan 100 `:248` left same-quality reprofiling paying the full wake path; with the wake gone, the calculus changes and one session per device may beat two.
4. **How long should a manual lease live for a single-operator farm?** 300 s (`config.ts:36`) is a shared-farm number. §0.8's confusion is fixed by identity, but a farm with one operator might reasonably hold a lease until it is released.

---

## 10. Notes recorded during execution

**A server-side defect found by 125.5 and fixed by the coordinator, 2026-08-25 — "Take control" had been dead on every authenticated farm.**

`acquireManual`'s compare-and-swap tested `opts.takeOverFrom !== current.holder` — the WS **clientId**. But `toHolder` (`packages/core/src/lease/lease-manager.ts:124`) publishes `lease.holderUserId ?? lease.holder`, so on a farm with auth on, **every `LeaseHolder.id` that ever reached a browser was a userId.** The two can never be equal, so every takeover was refused with `lease_holder_changed`. Plan 71 §3.4's whole path has been dead since auth shipped, and it was invisible because the refusal is worded as a legitimate race ("the device is now held by …").

This is very likely part of §0.1 report 3's *"take control keeps getting in the way"* — not only the identity confusion §3.10 fixes, but the takeover button behind it not working either.

The CAS now accepts **either** id the holder can be known by. That does not weaken it: both ids identify the same lease this branch already read, so a dialog drawn against a holder who has since been replaced still fails — the property §3.4 actually asks for. Two regression tests pin both halves (a userId takeover succeeds; a *stale* userId is still refused).

**Deviations accepted in 125.5/125.6:**

- `myUserId` is **optional** (`myUserId?: string | null`), not required as §4.6 writes it — making it required would have forced an edit to `wall/DeviceContextMenu.tsx`, another worker's file mid-flight. An omitted value is field-for-field identical to `null`, pinned by a test.
- A **resumed** lease gets `leaseOrigin: 'explicit'`, so closing the popup does not release it — `DevicePopup.tsx`'s own long-standing rule covers this case verbatim: glancing at a device you had taken must not be what loses it.
- `held-by-human.undecided: true` became `weighting`, since after §3.11 `undecided` is simply a false statement.

**From 125.4 (the Wall), landed 2026-08-25 — the branch reorder alone would NOT have worked:**

Reordering `WallTile`'s branches is necessary but not sufficient. When a stream dies, readiness reconciles to `asleep` and `useLiveSet` drops the device from `live` **in the same update**, so `<LiveView>` unmounts regardless of branch order and its `stopped` state — which *is* the retry — dies with it. The fix collapses both cases into one `rendersPicture` boolean so there is exactly one `<LiveView>` element at one position: React then reconciles it as an *update*, and the instance survives to draw its own retry. A mount-counting test pins it (a remount would read 2).

The safety half is `pictureMountedRef`: **a latched error may only ever KEEP a picture, never create one** — otherwise a `stream.ended` for a budgeted or returning-from-offline tile would mount a decoder on a sleeping phone, which is plan 92 F11/F12 through the back door.

"Wake all visible" scopes to what the wall is *showing* (post search/filter), **not** the IntersectionObserver viewport — a wake whose scope depends on scroll position is the "alarming" half of plan 92 §9 Q2's own hesitation. `wallWakeTarget()` is pure and exported, and one computation feeds both the button's count and the request so they cannot disagree.

**A plan 124 regression this plan's work exposed:** `wall/DeviceContextMenu.test.tsx:103` kept its own hardcoded count of ActionsList's rows (13) and was never updated when plan 124 step 124.6 added the fourteenth ("Set number as wallpaper"). It is a second, independent copy of `ActionsList.test.tsx`'s count — deliberate, because that test's whole point is that the menu renders panel 3 rather than a copy of it — but the coupling is real, and whoever adds row fifteen must change both. Fixed, with that note left at the assertion.

**From 125.3 (readiness observes, reconnects, sweeps), landed 2026-08-25:**

- **`awakePolicy` is now wired** (`daemon.ts`, immediately before `createReadinessManager`). Until this line existed, `readiness.ts`'s dep was declared but never supplied, and `ensureAwake` therefore *withheld* the persisted `screen_off_timeout` write by design (§0.2 rule 1: no capture sink, no write). So the wiring is what makes §3.3 real — pinned by a test asserting the `settings get` precedes the `settings put`, that `svc power stayon true` still rides along, and that `devices.power_capture` holds the device's pre-Enkaku values; a paired test asserts the no-policy path still refuses the timeout write.
- **`DeviceReadinessSchema.observed` is `.nullable().optional()`, not `.default(null)`** like `blocked` beside it. A required output field would have forced a mechanical `observed: null` into ~30 Studio test literals, several in another worker's territory mid-flight, for zero behavioural gain — the same trade §10 already records for `myUserId` in 125.5. Every core producer (`computeReadiness`, `staticReadinessFallback`) writes the key explicitly, so the wire always carries it.
- **The probe is cached for 15 s on the reconcile path, and never cached on the `observe()` path.** §3.6 asks for "cached with a timestamp" and it turns out to be load-bearing rather than an optimisation: `daemon.ts` reconciles on *every* status transition, session open/close, and job claim/finish, so an uncached probe would have put a `dumpsys power` round trip on all of them — adding cost to the very path §0.7 is trying to make cheaper. `reconcile` awaits the probe (so the single broadcast carries it, rather than a second one racing behind), but `hold()` does not go through `reconcile`, so the `stream.start` hot path is untouched.
- **`observed` is set to `unknown` WITH a reason on the offline and quarantined branches**, rather than left stale. A five-minute-old `on` still shown for a phone that has since dropped off the farm is the same "inference presented as fact" §0.3 exists to stop.
- **The reconnect path needed no code change, only a test and a warning.** `daemon.ts`'s device-status hook already reconciles on every transition, and the registry applies `DEVICE_CONNECTED` (offline→idle) on reprobe, so the chain was intact — but it is now the *only* thing that re-wakes a `desired: 'awake'` device after a blip, and since 125.2 that is every device on a fresh farm. A test drives the whole chain through the state machine's `onChange` (calling `reconcile` by hand would have proved nothing), and both ends carry a comment saying not to narrow the hook to a subset of transitions.
- **The boot sweep is bounded at 4**, below the 8 `battery.ts`/`health.ts` use, because a wake is a transport plus several shell calls including the 1422 ms `svc power stayon` (§0.7), not one `dumpsys`. It is clamped again by the live adb lane width. Offline and quarantined devices are skipped with their reason recorded on the wire *and* in one summary log line, and are never retried — a sweep that retried would be the timer this module refuses to grow. `stop()` aborts a sweep in flight.
- **The no-timer rule is now asserted against the source**, not just claimed in a comment (`readiness.test.ts`, mirroring `adb-server-control.test.ts`'s one-call-site rule): §4.4's sweep would have been very natural to write as an interval.
- **Left for a later step:** 125.4's final bullet — Studio surfacing `observed` where it disagrees with `actual`. `WallTile.tsx:213` carries that worker's own marked hook and the wording rules for whoever fills it in; the field now exists for them.

**From 125.7 and 125.8 (the cold cast path), landed 2026-08-25:**

- **The skip is `skipWake`, a flag, wired from a `deviceIsAwake()` accessor** — §3.7 offered either shape and both turned out to be needed at different layers. `SessionManagerDeps.deviceIsAwake` (`packages/session/src/manager.ts`) is the accessor, read fresh *inside* `createEntry` rather than at `acquire` time, for the same reason `buildEntry` re-checks the wall entry there: a build queued behind the farm-wide build lane can wait, and the answer that decides whether to pay a 1422 ms `svc power stayon` has to be the one true when the build actually runs. It resolves to `CreateSessionOpts.skipWake`, which is what `createSession` reads. A test pins the freshness explicitly (flip the accessor while the build is queued, assert zero wakes).
- **`skipWake` is deliberately NOT `skipDevicePrep`.** They fold together (`const skipWake = skipDevicePrep || opts.skipWake`) but they are different facts: `skipDevicePrep` means "another open entry owns this device's prep, and reverts nothing here", `skipWake` means only "the screen is already being held on by someone else". Rotation, text input and the farm tag are untouched by the new flag — none of them can be inferred from "the panel is lit".
- **The revert half is what makes it safe, and it fixed a pre-existing leak on the way.** `close()`'s `svc power stayon false` is now gated on `!skipWake`, not `!skipDevicePrep`. Before this step, a session on a `desired: 'awake'` device wrote `stayon false` on close while `readiness.keepAwakeApplied` still believed it held the device awake — so `ensureAwake`'s own early-out (`rawActual !== 'asleep'`) declined to put it back, and the phone lost its hold with nothing left to notice. That is the §0.4 treadmill through a second door. Net effect of 125.7 is therefore **two adb writes removed per session, none added** — the only direction §0.2 permits.
- **What was measured, and what was not.** No hardware here; nothing in this report is a wall-clock number from a phone. What *is* checkable is the call count, and that is what the tests assert, off the wire rather than off a spy: `input keyevent KEYCODE_WAKEUP` occurrences per session build. Before: **2** on a cold `stream.start` (one from `readiness.hold` → `ensureAwake`, one from `createSession`), **1** on a device already awake or hot (`ensureAwake` early-outs, `createSession` woke anyway). After: **1** and **0** respectively — acceptance criterion 11. The whole wake sequence goes with it, not just the nudge: the `settings get` readback pair and the `svc power stayon` call, asserted absent. H2's before/after on real hardware (the `logSlowCommand` line, `ws command stream.start took Xms`) remains the owner's to run.
- **125.8 keeps its guarantee by moving it, not dropping it — `whenTextInputReady()`.** §8's risk row says a job that needs text input "awaits the session's `ready`, which still gates on the same work completing". `ready` is the first *frame* and now genuinely precedes the keyboard, so the guarantee moved to a method on `DeviceSession`: it starts the setup if nothing has, and resolves when it is done. Both real callers await it immediately before `resolveTextRoute` — `ws-handlers.ts`'s `input.text` and `device-executor.ts`'s `type()` — which is the exact point where `agentCapabilities`/`imeCurrent` are read and must be true. **A script still cannot type before the IME is set**; the wait simply moved off the path where nobody was typing. `session.textInput.agentCapabilities`/`imeCurrent` are now mutated in place when the bootstrap lands, so they must be read fresh off the session at each call and never captured at session start.
- **The setup has two triggers and needs both.** The first frame (§3.8's own wording) is the ordinary one. `whenTextInputReady()` starting the work rather than merely awaiting it is the second, and it is not a nicety: a session whose display never produces a frame — a dead encoder, a screencap loop that cannot read the panel — would otherwise leave a script blocked forever on work nothing ever kicked off.
- **Deferring opened one new window, and `revertTextInput()` is what closes it.** `close()` can now land mid-bootstrap, and reverting the not-yet-applied no-op would leave the agent's IME pinned as the device's default input method *permanently* — a device-scoped setting outliving the session that made it, on a phone in a sealed box (§0.2). So the revert awaits an in-flight setup before reverting. That can make a close slower; it can never cost a phone its keyboard.
- **One line is still owed by `daemon.ts`'s owner** (out of this worker's territory), and until it exists 125.7 is inert in production while remaining fully exercised by tests. In the `createSessionManager({...})` call (`packages/core/src/daemon.ts`, beside `maxConcurrentBuilds`): `deviceIsAwake: (deviceId) => (readiness ? readiness.actual(deviceId) !== 'asleep' : false),` — `readiness` is already read through the same closure a few lines above (`if (kind === 'session.opened' ...) void readiness?.reconcile(deviceId)`), so no new binding or ordering is involved. Write it the long way, **not** as `readiness?.actual(deviceId) !== 'asleep'`: with `readiness` still unset that reads `undefined !== 'asleep'`, i.e. `true`, and would skip the wake on exactly the early builds that most need it.
- **A test that had to change its meaning, not just its expectations:** `manager.test.ts`'s fast-path block asserted that the ORDINARY build issues `ime` commands, as the baseline proving its fixture was not vacuously silent. After 125.8 the ordinary build issues none at build time, so the baseline now asserts exactly that, then drives `whenTextInputReady()` and asserts the commands appear — the fixture is still proved live, and the fast path's own `ime`-free assertion still means something.

**Workstream C wiring, closed by the coordinator 2026-08-25.**

125.7 shipped `SessionManagerDeps.deviceIsAwake` as an **optional** dep — which meant every test in `packages/session` passed with it supplied and production would have passed with it absent, silently paying the wake twice. That is the same defect class `daemon-wiring.test.ts` exists for, and plan 119 left an instance of it that plan 125 §0.7 had to find later (the video path never got the protocol forward).

Wired at `daemon.ts`'s `createSessionManager({...})`, written the long way:

```ts
deviceIsAwake: (deviceId) => (readiness ? readiness.actual(deviceId) !== 'asleep' : false),
```

The shorthand `readiness?.actual(deviceId) !== 'asleep'` is a real trap, not a style preference: it evaluates `undefined !== 'asleep'` — `true` — while readiness is still unset during early boot, so it would skip the wake on exactly the builds that most need one. **A missing readiness manager has to mean "wake it", never "assume it is awake."**

A guard in `daemon-wiring.test.ts` asserts both the presence and the long form, with comment lines stripped first (the call-site comment quotes the shorthand in order to explain why it is wrong, and the naive assertion failed on its own documentation). The guard was verified by temporarily substituting the buggy shorthand: the test fails, and passes again when restored.
