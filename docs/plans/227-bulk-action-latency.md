# Plan 227 — Bulk actions : the fan-out widths, the panel verbs, and the numbers nobody had

> Status: implemented (software). Executed 2026-09-08. The three owner rows (G7, G8, G9) are measurements and a decision, and none of them has been taken by this executor — there is no hardware on this branch.
> Ships: packages/core/src/actions/verbs.ts
> Depends on: plan 226 (the wake/sleep fast path, and the two questions it left open), plan 207 (the actions API, `VERBS`, `dispatchBounded`), plan 206 (always-on sessions — the reason every online device already holds a scrcpy control socket), plan 23 (`computeAutoConcurrency`, the adb semaphore that scales)
> Spec references: §4.8 (actions and their targets), §11 (the Actions API). §11's verb list grows by two.

---

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | An action's fan-out width follows the farm instead of being compiled in | `computeSyncFanout`/`computeAsyncFanout` derive it from adb's live semaphore; `ACTION_FANOUT_CONCURRENCY`/`ACTION_SYNC_FANOUT_CONCURRENCY` no longer exist | `rg -n "^export const ACTION_(SYNC_)?FANOUT_CONCURRENCY" packages/` → no hit (the names survive only in doc comments, which say what they were) | [x] |
| G2 | Both widths are reachable without a build | `ENKAKU_ACTION_FANOUT_MAX`, `ENKAKU_ACTION_SYNC_FANOUT_MAX`, `ENKAKU_ACTION_SOCKET_FANOUT` in `constants.ts` and `.env.example` | `bun test packages/core/src/device/adb-scaling.test.ts` → 28 pass | [x] |
| G3 | No farm gets narrower than it was | the floors are the previous values, 16 and 4 | same file → tests `no farm gets narrower…` and `the async floor is the 4…` pass | [x] |
| G4 | An operator can darken the phones without putting them to sleep | `screen-off`/`screen-on`, 0 adb calls on the path | `bun test packages/core/src/actions/run.test.ts` → 13 pass, incl. `no adb command is issued` | [x] |
| G5 | A shutdown says which phase took the time | three phases printed (`drain`, `release`, `stop`) plus `closeAll`'s own line | read `packages/core/src/index.ts`'s `leave()`; owner smoke §7 step 2 | [x] |
| G6 | The remaining hot commands can be measured on real hardware | 8 read-only probes in `bun run bench:wake`, `echo` among them as the floor | `bun run bench:wake -- --help` runs without touching a device | [x] |
| G7 | The command cost profile is taken on this farm's own phones | median ms per probe, pasted into §11 | owner, one device: `ENKAKU_TEST_DEVICE=1 bun run bench:wake -- --serial <S>` | owner |
| G8 | The exit's three phases are measured on a 73-device farm | the `shutdown took …` line, pasted into §11 | owner: Ctrl+C, read the last line | owner |
| G9 | Plan 226 Q1 is decided now that its blocking fact is known (§3.1) | yes or no, on the record | owner | owner |
| G10 | `bun run typecheck` is clean | 0 errors, 22/22 packages | `bun run typecheck` → exit 0 | [x] |
| G11 | Studio still exports statically | `bun run build:studio` exits 0 | §7 | [x] |

---

## 1. Goals

1. Make a bulk action's width a function of the farm, not a number compiled in for a farm a quarter the size.
2. Give an operator the action a competitor has and this product did not: darken the phones' own panels, farm-wide, without putting the devices to sleep.
3. Make the exit legible — three phases with three numbers — before anyone optimises it.
4. Put the remaining unmeasured commands within reach of one bench run.
5. Settle, by reading the source rather than reasoning, the two questions plan 226 left open.

## 2. Non-goals

| Not done here | Why / where |
|---|---|
| Handing `stay_awake` to the scrcpy server | plan 226 Q1. §3.1 now supplies the fact that was blocking it, and G9 is the decision. It is the larger win and it deletes code this plan does not touch |
| Batching session close's revert chain into one shell command | §3.6 — substantially subsumed by Q1. Doing it first would be work thrown away |
| Making `sleep` socket-only | it already is, except for the stay-on write, which is exactly what Q1 removes |
| `power_off_on_close`, airplane mode, reboot, shutdown verbs | §3.7 records what the source says about the first and what the competitor ships for the rest; none is built here |
| Measuring anything | there is no hardware on this branch. G7 and G8 are owner rows and say so |

---

## 3. Context and design decisions

### 3.1 What scrcpy v3.3.1's own source says — the facts this plan is built on

Plan 226 §3.4 and its Q1 both turned on facts about the pinned server that
nobody had read. They are read now. Fetched 2026-09-08 from
`https://raw.githubusercontent.com/Genymobile/scrcpy/v3.3.1/server/src/main/java/com/genymobile/scrcpy/`,
tag `v3.3.1`, the version `packages/scrcpy/src/version.ts` pins.

| # | Fact | Source |
|---|---|---|
| S1 | `CleanUp` captures `stay_on_while_plugged_in` with `Settings.getAndPutValue` and restores the captured value when the server's stdin closes — for **any** reason, this core being `SIGKILL`ed included | `CleanUp.java` `runCleanUp`, `main` |
| S2 | It restores **only if the current value differs** from what it wrote — the same capture-and-restore discipline plan 125 §0.2 requires of this codebase | `CleanUp.java`, `restoreStayOn` |
| S3 | `screen_off_timeout` is written to `Settings.TABLE_SYSTEM`, whose unit Android defines as **milliseconds**; the server option is an int passed through unchanged and `-1` means "leave it alone" | `CleanUp.java`; `Options.java` `screenOffTimeout` |
| S4 | The option keys are exactly `stay_awake`, `screen_off_timeout`, `power_off_on_close`, `power_on`, `cleanup` | `Options.java` `parse` |
| S5 | **Display power restore is armed, not automatic.** `restoreDisplayPower` starts `false`; `Controller.setDisplayPower(false)` calls `cleanUp.setRestoreDisplayPower(true)` | `Controller.java` `setDisplayPower`; `CleanUp.java` |
| S6 | So a panel darkened by a client's `SET_DISPLAY_POWER` is **powered back on** when the session dies | S5 plus `CleanUp.main` |
| S7 | `power_off_on_close=true` makes CleanUp power the screen **off** on session death instead, if it is on at the time | `CleanUp.java` `main` |

Three consequences, and each of them changes something that was written down
as settled:

**Plan 226 Q1 is safe.** S1 and S2 are precisely what Q1 hoped for and could
not confirm: scrcpy captures, scrcpy restores, and it survives a `kill -9` —
which is *better* than what this codebase does today, since the release sweep
cannot run when the process is gone. S3 answers the unit question Q1 said had
to be read off `Server.java` before anything was sent. G9 is now a decision
rather than a research task.

**Plan 226 §3.4's objection to `SET_DISPLAY_POWER` is dissolved.** That section
refused the mechanism because "a core killed with `SIGKILL` while 66 panels are
forced dark leaves 66 dark panels". S5 and S6 say it does not: the server arms
its own cleanup the moment the client sends the message, and the panels come
back. The refusal was correct about the *question it asked* — a display power
mode must not replace sleep, because sleep has to outlive the farm — and wrong
about the risk it named.

**And the same facts say what `screen-off` must NOT be sold as.** S6 means a
panel darkened this way lights up again when the session ends, an unplugged
cable included. So the owner's pre-unplug ritual — darken everything, then pull
the cables — is `sleep`, not `screen-off`, and §3.3 builds the two as separate
verbs for that reason rather than as two speeds of one.

### 3.2 The fan-out widths were a farm-size assumption compiled in

`actions/verbs.ts` carried two bare `export const`s: `ACTION_FANOUT_CONCURRENCY
= 4` for the async verbs and `ACTION_SYNC_FANOUT_CONCURRENCY = 16` for the sync
ones. Neither had an `ENKAKU_*` override; neither knew how many phones the farm
had. On the owner's 73 devices that made a bulk screenshot, install, push,
pull, `adb` shell, `prepare` or `install-agent` run **four at a time** —
nineteen waves.

The second constant's own comment is the sharper finding:

> Sixteen rather than unbounded because the real floor is still adb's own
> farm-wide semaphore (`adb.maxConcurrent`, 6 by default and pinnable to 2)

`computeAutoConcurrency(73)` returns **24**. The stated reason had stopped
describing the farm the number was bounding, and no operator could have widened
it without a build — which is the exact failure CLAUDE.md already records under
`WALL_RAMP_CONCURRENCY` ("a constant nobody sends is a knob that does not
turn"), repeated in a second place.

So the width is now **derived from the lane the work actually joins**:

- **sync** → adb's live semaphore, floored at the old 16 and capped by
  `ENKAKU_ACTION_SYNC_FANOUT_MAX` (32).
- **async** → half that semaphore, floored at the old 4 and capped by
  `ENKAKU_ACTION_FANOUT_MAX` (12). Half, because several of these verbs move
  megabytes and share the semaphore with session builds and the readiness sweep.
- **socket** → a third lane, §3.3, for a verb that touches no adb at all.

Read live, per call, not captured at wiring time: the autoscaler moves the
semaphore as devices arrive, an operator can pin it, and the shutdown sweep
widens it and puts it back.

**The ratios are reasoned, not measured, and the plan says so where it counts**
— in `adb-scaling.ts`'s own doc comment, in `constants.ts`, and here. G7's bench
is the instrument. What is not a matter of opinion is that both are now bounded
by something that scales and reachable by something that does not need a
compiler.

### 3.3 `screen-off` / `screen-on` — the panel, which is not the device's sleep

The capability already existed and was wired to the wrong kind of thing.
`session.ts` calls `scrcpy.control.setDisplayPower(false)` — two bytes on a
control socket this process already holds — gated on `prep.standbyScreenOff`,
a **per-device provisioning flag** defaulting to `false`, applied once at
session build and reverted at close. Its own declaration comment reads *"dark
panel, mirroring stays alive"*. Turning that on across a farm meant editing 73
device settings and rebuilding 73 sessions, to reach something that costs two
bytes.

It is now two ordinary `sync` verbs. Three properties are load-bearing:

1. **They are not `sleep`, and the plan refuses to let them be sold as it.**
   `sleep` puts Android itself to sleep; the state is Android's and survives
   this core dying. `screen-off` sets a display power mode, and S6 says the
   server undoes it when the session ends. Different guarantees, different
   buttons, and the Studio dialog's note says which is which in the one place
   an operator would otherwise be caught by it.
2. **`lane: 'socket'`** on the verb spec, so the width is not bounded by a
   queue the work never joins (§3.2). A farm-wide screen-off is N socket
   writes and costs the same at 3 devices and at 73.
3. **A device with no session is `skipped`, not `done`.** Reusing
   `device_unavailable`, which `failedStatusOf` already maps to skipped. An
   operator asked for a panel to change; reporting success for a phone whose
   panel did not is the "unverified is not success" rule this repo applies to
   a network route, applied here.

Two verbs rather than one with a boolean because every other verb in
`ACTION_VERBS` is a thing an operator does, named as they would name it, and an
action bar reads better with two buttons than with one that needs its argument
read.

### 3.4 The exit had no phases, so it had no diagnosis

A shutdown printed `stopping...` and `stopped`. An operator reporting that
leaving a 73-device farm takes far too long could not say which part took it,
and neither could anyone reading the log later — even though the three parts
have entirely different causes and entirely different fixes:

- **drain** — jobs finishing. Bounded by the work, not by this codebase.
- **release** — one adb write per device, `RELEASE_SWEEP_WORKERS` wide.
- **stop** — every session's own teardown, which is a **serialised** chain of
  adb round trips per device (the stay-on drop, the rotation revert, `ime set`,
  the farm tag, the inspector). This is the one nobody has measured and the one
  most likely to dominate at scale, so it gets its own line inside `stop` as
  well as being part of it.

Drain is timed from the signal rather than around the loop that does it,
because that loop returns early when a second Ctrl+C moves `phase` under it,
and a closure wrapper would have changed what the second signal does. A
timestamp cannot get that wrong.

### 3.5 The command cost profile — asking plan 226's question of the close path

Plan 226 §3.2's insight is that `/system/bin/svc` and `/system/bin/input` are
shell wrappers around `app_process`, so each call starts an ART runtime on the
phone; that is what the 1422 ms is. The question was asked of the wake path and
never of the close path, which still runs `ime set <previous>` once per device
on every shutdown — and on AOSP, `cmds/ime/ime` has historically been exactly
that shape of wrapper.

`bun run bench:wake` now ends with eight **read-only** probes: `echo` (the
floor — one adb round trip with no on-device binary), `getprop`, `settings get`,
`cmd settings get`, `ime list -s`, and `input`/`svc`/`dumpsys window policy`.
Nothing writes a setting, presses a key or sets a property; `input` and `svc`
with no arguments print usage and exit, which starts the same runtime a real
call would, which is the quantity being measured. Median of N, not mean, so one
scheduling hiccup on a loaded phone does not decide the answer.

Subtract the `echo` row from any other and what is left is what the binary
costs. **If `ime` measures like `svc` and not like `getprop`, the close path
has a JVM on it** and §3.6's ordering changes.

### 3.6 Why the revert chain is NOT batched here

Session close issues roughly six serialised adb round trips per device, and
`putStayOn` already proves in this repo that a write and its read-back fit in
one `adb shell`. Batching the four reverts is the obvious next move and it is
deliberately not made here, for one reason: **plan 226 Q1 removes the stay-on
write from both the close path and the release sweep entirely.** Batching a
chain that is about to lose one of its links — and doing it across four modules
that each own their own capture and error handling — is work that would be
partly discarded a week later. G9 first; the batching plan is written against
whatever chain survives it.

### 3.7 What the competitor's menu shows that is still missing

Recorded so it is not rediscovered. PandaClassic's quick actions include
**Open/Close airplane**, **Shutdown** and **Reboot**; none has any expression in
this codebase — not a verb, not a script, not a plugin. Airplane is the plan 313
client brief's own *"Use SIM 4G (change IP)"*, which §3.6 of that plan routed to
plugin script parameters: defensible for a workflow node, not an answer for a
quick action. And S7's `power_off_on_close` is a real option this codebase does
not pass, which would darken a phone on session death — interesting for a farm
shutdown, wrong as a default, and not built here.

---

## 4. Changes

| File | What |
|---|---|
| `packages/core/src/device/adb-scaling.ts` | `computeSyncFanout`, `computeAsyncFanout`, and the two floors that keep every farm at least as wide as it was |
| `packages/core/src/config/constants.ts` | `ACTION_FANOUT_MAX`, `ACTION_SYNC_FANOUT_MAX`, `ACTION_SOCKET_FANOUT` |
| `.env.example` | the three overrides, under Support overrides |
| `packages/core/src/actions/verbs.ts` | `VerbSpec.lane`; `actionFanout()`; `ACTION_FANOUT_CONCURRENCY`/`ACTION_SYNC_FANOUT_CONCURRENCY` deleted; the two `screen-*` rows |
| `packages/core/src/actions/run.ts` | `ActionsDeps.adbConcurrency`; both `dispatchBounded` widths derived; `setScreenPower()` and its two cases |
| `packages/core/src/daemon.ts` | wires `adbConcurrency`; times and logs `closeAll` |
| `packages/core/src/index.ts` | `phases`/`timed`/`signalledAt`; the `shutdown took …` line |
| `packages/protocol/src/actions.ts` | `screen-off`/`screen-on` in `ACTION_VERBS` and `ActionRequestSchema` |
| `packages/session/src/session.ts` | `DeviceSession.setDisplayPower?`, over `liveScrcpy` |
| `packages/ui/src/icons.ts` | `DeviceMobileSlashIcon` |
| `packages/studio/src/lib/generic-actions.ts` | the two menu rows, in the `device` group beside Sleep |
| `packages/studio/src/components/actions/verb-dialogs.tsx` | the two immediate dialogs, with the note S6 makes necessary |
| `scripts/bench-wake.ts` | `commandCostProfile()` and `--cost-rounds` |

Tests: `packages/core/src/device/adb-scaling.test.ts` (7 new), `packages/core/src/actions/run.test.ts` (5 new), `packages/protocol/src/actions.test.ts` (verb count and fixture map).

---

## 7. Verification

```
bun run typecheck                                  # 22/22 OK
bun test packages/core/src/device/adb-scaling.test.ts   # 28 pass
bun test packages/core/src/actions/run.test.ts          # 13 pass
bun test packages/protocol/src/actions.test.ts          # 49 pass
bun run build:studio                               # static export clean
rg -n "^export const ACTION_(SYNC_)?FANOUT_CONCURRENCY" packages/   # no hit
```

Owner smoke, in order:

1. `ENKAKU_TEST_DEVICE=1 bun run bench:wake -- --serial <S>` — paste the cost profile into §11 (G7).
2. Select the farm, press **Screen off**. Every panel dark, every tile still live. Then **Screen on**.
3. Ctrl+C. Read the last line: `shutdown took drain Xs, release Ys, stop Zs` (G8).
4. Decide G9.

---

## 9. Open questions

| # | Question | Held by | Current answer if unresolved |
|---|---|---|---|
| Q1 | Plan 226 Q1 — `stay_awake` to the scrcpy server | owner (G9) | §3.1 S1–S3 removes every technical objection. Unresolved, the release sweep stays and §3.6's batching stays blocked behind it |
| Q2 | Are the two ratios in §3.2 right? | this plan, against G7 | They are floors-plus-a-ceiling, both overridable, and no farm is narrower than before. G7's numbers are what would change them |
| Q3 | Does `ime set` start a JVM on this farm's phones? | G7 | Assumed yes on the strength of AOSP's historical `cmds/ime/ime`, asserted nowhere in the code |
| Q4 | Should a farm shutdown pass `power_off_on_close` (S7)? | owner | Not built. It would darken a phone on every session close, not only at shutdown, which is not what an operator wants from closing one wall tile |

## 10. Removed

| Removed | Why it is safe |
|---|---|
| `ACTION_FANOUT_CONCURRENCY` (`actions/verbs.ts`) | Its value survives as `computeAsyncFanout`'s floor, so the narrowest possible width is what it was |
| `ACTION_SYNC_FANOUT_CONCURRENCY` (same) | Same: it is `computeSyncFanout`'s floor |

Nothing else. Every behaviour reachable before this plan is reachable after it:
`prep.standbyScreenOff` still applies at session build, `sleep`/`wake` are
untouched, and no verb changed its gate, its policy row or its offline rule.

---

## 12. Post-merge UI audit (2026-09-09)

Plan 227 merged with `typecheck`, `build:studio`, the scoped tests and all
eleven CI gates green. None of those looks at a screen. Asked afterwards
whether an operator could actually use what shipped, this audit walked the two
menus by hand and found three things. All three are fixed on the follow-up
branch; two of them are this plan's own.

### A1 — `docs/spec.md` §11 did not list the two new verbs

This plan's own header says "§11's verb list grows by two" and the change never
reached the file. CLAUDE.md's rule is that the spec is the single source of
truth and wins where the code disagrees, so for a day the spec would have lost
against shipped code.

It is worth naming plainly: `docs/plans/700-automation-review.md` §2 F0 is a
criticism of exactly this drift (the spec said "six node kinds" while the code
had eight), written by the same author, four hours before repeating it.
`spec:check` is warning-only, so nothing caught it.

Fixed, and §11 now also carries the `sleep` vs `screen-off` distinction and the
`skipped`-never-`done` rule, rather than leaving both only in this plan.

### A2 — the note that disambiguates Sleep from Screen off could not be read

`VerbDialogSpec.note` renders in exactly one place, `ActionDialog.tsx`'s body,
and a verb marked `immediate: true` never opens a dialog. Every note on an
immediate verb was therefore copy nobody could reach — true for `reconnect`,
`disconnect`, `sleep` and `wake` since they were written.

Harmless for those four, whose labels say the whole story. Not harmless once
`screen-off`/`screen-on` landed one row under Sleep: four adjacent rows that
all sound like "turn the screen off", where the wrong choice has a consequence
an operator cannot see — a panel darkened by Screen off is powered back on when
the session dies (§3.1 S5/S6), so it is the wrong button before unplugging.
That sentence was written into the note and then made unreachable by the same
commit.

Both menus now carry the verb's own `note` as the row's tooltip, read from
`VERB_DIALOGS` rather than copied onto `GenericAction`, so one sentence per verb
serves the dialog and the menu and the two cannot drift.

### A3 — the immediate-verb toast reported `done` for devices it had skipped

Not this plan's code, and this plan's verbs are what make it bite. The toast
summed `failed` and `forbidden` and called everything else `done`:

```
const failed = grouped.failed.length + grouped.forbidden.length
if (failed > 0) toast.warning(...)
else toast.success(`${label}: done`)
```

`skipped` was counted in neither branch. An action on 73 phones that reached 3
and skipped 70 reported `done`, flatly. `screen-off` skips any device without a
scrcpy session, so on a farm mid-boot that is most of them — and §3.3's whole
reason for answering `device_unavailable` per device was to tell the truth,
which this line then discarded. It is the same "unverified is not success" the
farm refuses of a network route.

The toast now names all three counts, with `skipped` its own word rather than
folded into "refused": a phone that was offline was never asked, and calling
that a refusal sends an operator looking for one that never happened.

### What this says about the plan's own verification

§7's command list is a real list and every row in it passed. It contains
nothing that opens a menu, and `bun run build:studio` exiting 0 says a page
compiles, not that a person can use it. Studio has no tests by decision (plan
200 §8.3) and this plan does not propose changing that — but the §7 block of a
plan that adds an operator-facing control should carry a **walk**, not only a
build: open both menus, read every row that changed, and click the new one.
Written here rather than as a rule elsewhere, because the next plan to add a
verb is the one that needs it.

## 11. Handoff

Software rows G1–G6, G10 and G11 are done and proven by the commands in §7.
Three rows are open and all three are the owner's:

- **G7** — the command cost profile, one device, one bench run. This is the
  cheapest and it decides Q3 and Q2.
- **G8** — the exit's three phases on the 73-device farm. Now that the line
  exists, this is one Ctrl+C.
- **G9** — plan 226 Q1. §3.1 supplies the facts that were blocking it; it is a
  yes or a no, and a yes deletes the release sweep rather than tuning it.

No assertion was weakened to make a test pass. `packages/protocol/src/actions.test.ts`'s
verb count moved 27 → 29 because two verbs were added, and its stale comment —
which cited a plan/plan discrepancy about 25 vs 26 while the table had said 27
for some time — was replaced with what the number actually tracks.
