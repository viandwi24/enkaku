# Plan 226 — Bulk wake and sleep, and the release the farm pays on the way out

> Status: implemented (software). Executed 2026-09-07. The three device-side timings this plan reasons from are plan 96 §22's own measurement and upstream scrcpy's source; **none of them has been re-measured on this farm's hardware by this executor** — G8 is the owner row that closes that, and `bun run bench:wake` is the instrument.
> Depends on: plan 125 (the awake policy: `power.ts`, `wake.ts`, `awake-policy.ts`, the capture-before-write rule and the read-back-or-`refused` rule this plan does not relax), plan 206 (always-on sessions — the reason every online device already holds a scrcpy control socket, which is what the key path now uses), plan 207 (the actions API: `VERBS`, `runAction`, `dispatchBounded`), plan 91 (the input arbiter, the only sanctioned way into a session's input).
> Spec references: `docs/spec.md` line 199 (a device put to sleep "stays asleep with its session up; its tile shows a dark screen") — unchanged by this plan, only made fast.

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A bulk `sleep`/`wake` is dispatched in parallel, not one device at a time | `ACTION_SYNC_FANOUT_CONCURRENCY = 16`, applied through the same `dispatchBounded` the async verbs use, still awaited so the `sync` response contract is unchanged | `bun test packages/core/src/actions/` → passes; read `run.ts`'s `spec.mode === 'sync'` branch | [x] |
| G2 | `svc power stayon` is no longer on the hot path | `applyStayOn` writes `settings put global stay_on_while_plugged_in <mask>` batched with its read-back, and reaches `svc` only when that read-back does not satisfy the mode | `bun test packages/session/src/wake.test.ts` → tests `"always" writes the AC\|USB\|WIRELESS bitmask, and never reaches \`svc\`` and `a ROM that ignores the direct write still gets \`svc power stayon\`` | [x] |
| G3 | A device whose value is already correct still writes nothing at all | `satisfiesStayOn(current, mode)` early-out, unchanged from plan 125 | `bun test packages/session/src/wake.test.ts` → test `a device that already holds the value writes nothing at all — neither rung of \`applyStayOn\` runs` | [x] |
| G4 | The wake and sleep keys travel over a session's control socket when one exists | `wakeDevice`'s `injectKey` port; `readiness.ts`'s `keyInjectorFor`/`pressSleep`, both falling back to `input keyevent` | `bun test packages/core/src/device/readiness.test.ts` → test `Wake works after a Sleep... and both keys ride the session, not the shell`; `bun test packages/session/src/wake.test.ts` → the three injector tests | [x] |
| G5 | A device with no session behaves exactly as it did before | the shell rung is unconditional when `injectKey` is absent, returns `false`, or throws | `bun test packages/session/src/wake.test.ts` → tests `an injector that cannot send falls back to the shell` and `an injector that throws is tolerated the same way` | [x] |
| G6 | Sleep costs ONE adb round trip on the happy path | no `readPowerState` ahead of the write; the read-back rides in the same command; no `svc` | `bun test packages/core/src/device/readiness.test.ts` → test `Sleep is ONE round trip: a batched stayon write, no read ahead of it, and never \`svc\`` | [x] |
| G7 | Session close no longer pays the JVM either | `session.ts`'s two `svc power stayon false` sites go through `applyStayOn` | `bun test packages/session/src/session.test.ts` → passes; grep `svc power stayon` in `packages/session/src/session.ts` returns only prose | [x] |
| G8 | The three timings this plan reasons from hold on this farm's own hardware | per-command wall clock for `settings put global …` vs `svc power stayon`, and for an injected keycode vs `input keyevent` | owner, one device: `ENKAKU_TEST_DEVICE=1 bun run bench:wake -- --serial <S>`, before and after; pasted into §11 | owner |
| G9 | `bun run typecheck` is clean | 0 errors, 22/22 packages | `bun run typecheck` → exit 0 | [x] |

## 1. Goals

1. Make "select the whole farm and press Sleep" finish in seconds rather than minutes, and make Wake the same, **without** relaxing any rule plan 125 §0.2 put in place for a phone sealed in a box.
2. Cut the cost the core pays on the way out, which an operator experiences as a shutdown that hangs: every session close and every release currently starts a JVM on its device.
3. Leave every behaviour reachable when the fast path is not available. A device with no session, or a ROM that ignores a direct settings write, must end in exactly the state it ended in before this plan — only later.

## 2. Non-goals

| Not done here | Where it belongs |
|---|---|
| Handing `stay_on_while_plugged_in` to the scrcpy server (`stay_awake=true`) so its on-device `CleanUp` restores it and the release sweep disappears entirely | a follow-up plan — see §9 Q1. It is the larger win and the larger risk: it moves ownership of a persisted device setting out of this codebase. |
| `SET_DISPLAY_POWER` as the sleep mechanism | deliberately refused — see §3.4. |
| The `dumpsys power` observation on the reconcile path | left alone. It is one round trip, it is cached for `OBSERVE_MAX_AGE_SEC`, and plan 125 §3.6 is the reason it exists. |
| Raising `adb.maxConcurrent` | nothing to raise: `computeAutoConcurrency` already returns 24 for a farm of this size. |
| Studio's bulk selection UI | unchanged; this plan is entirely under the existing `POST /api/actions/:verb`. |

## 3. Context and design decisions

### 3.1 The two axes, and which one was bigger

A bulk sleep of 66 devices cost roughly two and a half minutes. That number is the product of two independent problems, and it is worth stating which is which because only one of them is about adb at all.

**Axis one — the dispatch was serial.** `packages/core/src/actions/verbs.ts` marks `wake` and `sleep` as `mode: 'sync'`, and `run.ts`'s sync branch was a plain `for (const deviceId of candidates) await …`. Sixty-six devices, strictly one at a time, inside the HTTP request the browser is holding open. The async verbs next to it have had bounded parallelism since plan 207; the sync ones never did, and nothing about them requires the ordering — the fan-out is over a selection, and no verb in that switch reads another device's state.

**Axis two — each device's work was expensive for a reason that has nothing to do with adb's speed.** `svc`, `input` and `settings` are not native binaries. `/system/bin/svc` and `/system/bin/input` are shell wrappers around `app_process`, so every call starts an ART runtime on the phone. That is what plan 96 §22's **1422 ms** for `svc power stayon` is: not a slow link, a JVM start.

Both are fixed here. Axis one is the larger multiplier; axis two is what makes the remaining per-device cost small enough for the parallelism to be worth having.

### 3.2 Why writing the setting directly is the same state change

`svc power stayon <token>` calls `IPowerManager.setStayOnSetting(mask)`, which stores `Settings.Global.STAY_ON_WHILE_PLUGGED_IN`; `PowerManagerService` reads it back through a `ContentObserver` either way. Two independent confirmations that the direct write is sufficient:

- **Upstream scrcpy does exactly this.** `CleanUp.java` in the pinned v3.3.1 applies `--stay-awake` as `Settings.getAndPutValue(Settings.TABLE_GLOBAL, "stay_on_while_plugged_in", …)` and restores it the same way. It never shells `svc`.
- **This module already did it.** `restoreStayOn` has always used `settings put global stay_on_while_plugged_in`, and plan 125 chose it deliberately, because `svc` only speaks three tokens and a captured value may be none of them. The module was already trusting the cheap write to put a value *back* while paying the expensive one to put it *there*.

The mask for `always` is `AC|USB|WIRELESS` = 7, matching scrcpy's own constant rather than the 15 a dock-aware `svc power stayon true` writes. `satisfiesStayOn` accepts both — it asks whether those three bits are set, never for an exact number — and a phone farm has no dock.

One behaviour is genuinely lost: `svc power stayon <non-false>` also calls `pm.wakeUp()`. Nothing depends on it. `wakeDevice` sends its own `KEYCODE_WAKEUP` immediately afterwards, and always has.

### 3.3 Why the `svc` rung stays

Leading with the cheap write would be hopeful rather than honest without a floor under it. A ROM that ignores a direct write to the key, or a shell UID that turns out not to hold it, fails the read-back and gets the JVM path anyway. No device loses a capability it had before this plan — it only loses the wait. This is the same shape as `isKeyguardShowing`'s cheap-probe-then-full-dump ladder, one file over.

### 3.4 Why sleep is `KEYCODE_SLEEP` over the socket, and NOT `SET_DISPLAY_POWER`

`SET_DISPLAY_POWER` (control message 10, already encoded in `packages/scrcpy/src/control/messages.ts` and already used for `prep.standbyScreenOff`) would be the fastest possible answer: two bytes, one write, the panel black in the same frame on every device at once. It is refused here for one reason.

It sets a **display power mode**, which is system-wide state this process does not own and cannot be sure of restoring. A core killed with `SIGKILL` while 66 panels are forced dark leaves 66 dark panels — the same class of failure as the `stay_on_while_plugged_in` leak this plan is partly about, in a place where the recovery is worse. `KEYCODE_SLEEP` puts the phone into an ordinary sleep, which is a state Android itself owns, wakes out of on a power button, and survives this core's death correctly. It is just as instant over the same socket. The keycode choice is otherwise unchanged and still load-bearing: `SLEEP` (223) rather than `POWER` (26) because reconcile can run more than once for one transition and a toggle would turn the screen back on.

### 3.5 Why the order of the two steps in `releaseAwake` is unchanged

A device still holding `stay_on_while_plugged_in` while plugged in is woken straight back up by PowerManager, so the stayon drop must land before the key. It does. What changed is that the drop is now one batched round trip whose read-back has already come back before the key is sent, which also gives `PowerManagerService`'s observer its moment.

### 3.6 Why the sleep write is now unconditional

`releaseAwake` used to `readPowerState` first and skip the write when the device was already at 0. That read was worth two round trips only because the write behind it was 1422 ms. Now that the write *is* a `settings` call carrying its own read-back, reading first to decide whether to make it costs more than making it. Writing 0 to a device already at 0 is idempotent, and the `keepAwake !== 'off'` gate — a device we never wrote, we still never write — is untouched.

### 3.7 The arbiter, not the raw sink

The injector goes through `session.arbiter.for(…)`, never `session.input`. The raw sink has no serialisation, and a readiness sleep landing between a job's own down and up on the one shared virtual pointer is precisely what plan 91 §3.3 built the arbiter to stop. The source is `kind: 'user'` because the arbiter's priority table knows only `user`/`job`/`agent`, and a wake or a sleep is a person pressing a button — it should jump a queued job action and still never preempt one already running.

## 4. Changes

| File | What |
|---|---|
| `packages/session/src/power.ts` | `STAYON_MASK`; `applyStayOn` becomes a two-rung ladder with `putStayOn` (batched write + read-back) first and `svc` as its floor; `applyScreenOffTimeout` batches its own read-back the same way |
| `packages/session/src/wake.ts` | `WakeDeviceOpts.injectKey`; `pressKey` ladder; `KEYCODE_WAKEUP`/`KEYCODE_MENU` as numbers so both rungs share one spelling |
| `packages/session/src/session.ts` | both `svc power stayon false` sites (build failure, `close()`) go through `applyStayOn` |
| `packages/core/src/device/readiness.ts` | `keyInjectorFor`, `pressSleep`, `READINESS_INPUT_SOURCE`, `KEYCODE_SLEEP`; `ensureAwake` passes the injector; `releaseAwake` drops its read-before-write; `BOOT_SWEEP_MAX_CONCURRENCY` 4 → 12 |
| `packages/core/src/actions/verbs.ts` | `ACTION_SYNC_FANOUT_CONCURRENCY = 16` |
| `packages/core/src/actions/run.ts` | the sync branch dispatches through `dispatchBounded`, still awaited |

## 9. Open questions

**Q1 — should scrcpy own stay-awake outright?** `packages/scrcpy/src/session.ts` already passes `cleanup=true` and does not pass `stay_awake`. The v3.3.1 server accepts `stay_awake` and `screen_off_timeout` as `key=value` options, applies them itself, and spawns an independent on-device process that restores both when the server's stdin closes — which is to say when the session dies for **any** reason, including this core being `SIGKILL`ed. Adopting it would delete the shutdown release sweep rather than speed it up, and would fix a real crash-safety hole: today a `kill -9` leaves every phone the farm touched pinned lit for ever, with nothing left to notice. It is not done here because it moves ownership of a persisted device setting out of this codebase and past plan 125 §0.2's capture record, and because `screen_off_timeout`'s unit in the server option (the client's flag is seconds; the setting is milliseconds) must be read off v3.3.1's own `Server.java` before anything is sent. Owner's call.

**Q2 — is `ACTION_SYNC_FANOUT_CONCURRENCY = 16` the right width?** It was chosen against `computeAutoConcurrency`'s 24 for a farm this size, so the adb lane is not the binding constraint at 16 and is at 32. Nothing measured it; G8's bench is the instrument if it needs revisiting.

## 10. Removed

Nothing. Every command this plan stops sending on the fast path is still sent on the slow one, and no interface was narrowed: `injectKey` is optional, `applyStayOn`'s signature is unchanged, and `mode: 'sync'`'s response contract is byte-identical.

## 11. Handoff

Software rows G1–G7 and G9 are done and proven by the commands in §0. Test files touched are fixture updates plus new coverage for the two behaviours added (the `svc` fallback rung, and the injector's three outcomes); no assertion was weakened to pass.

**What an owner should do next, in order:**

1. Run G8's bench on one device before and after, and paste the two tables here. Everything in §3.1 and §3.2 is reasoned from plan 96 §22's single 1422 ms figure and from upstream source, not from this farm.
2. Press Sleep on the whole farm from Studio and time it. Then press Wake.
3. Watch a `Ctrl-C` shutdown and time the release sweep line in the log.
4. Decide Q1.
