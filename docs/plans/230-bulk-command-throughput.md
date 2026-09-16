# Plan 230 — Bulk command throughput: why 80 devices take 6–8 s, and the two roads out

> Status: **design only** — the owner asked for analysis and a design, explicitly not an implementation ("analisis dulu deh", "rancang dulu, jangan implementasi", 2026-09-16). No code in this plan has been written.
> Ships: nothing yet.
> Depends on: plan 23 (the adb semaphore), plan 24 (the streaming lane), plan 44 (the guest agent), plan 227 (`actionFanout`), plan 228 (the shutdown/cast work).
> Spec references: §9, §10.4

## 0. The report

The owner sent one `adb shell` to **80 devices** and watched it complete in
**6–8 s**, in what looked like waves — "setiap beberapa devices aja dalam satu
waktu terus ditunggu habis itu lanjut". The competitor (Panda, some3c) applies
the same command across a farm of that size in **1–2 s**.

## 1. Where the time goes, measured from the code

The verb `adb` is declared `mode: 'async'` (`packages/core/src/actions/verbs.ts:45`).
That single classification decides the width:

```
computeAutoConcurrency(80)        = 24    # the farm-wide adb semaphore
computeAsyncFanout(24, MAX = 12)  = 12    # max(4, min(12, ceil(24 / 2)))
dispatchBounded(80 devices, 12)          # a rolling pool of 12
```

Run against the real functions:

| devices | semaphore | async fanout | rounds | sync fanout | rounds |
|---|---|---|---|---|---|
| 10 | 8 | 4 | 3 | 16 | 1 |
| 40 | 24 | 12 | 4 | 24 | 2 |
| **80** | 24 | **12** | **7** | 24 | 4 |
| 120 | 24 | 12 | 10 | 24 | 5 |

Seven rounds × ~0.9 s per `adb shell` round trip ≈ **6.3 s**. That is the
report, and it is arithmetic, not a guess.

One correction to the owner's reading: `dispatchBounded`
(`actions/run.ts:192`) is a **worker pool**, not a batch barrier — twelve
workers pull from a shared index, so a slow phone never holds the others. The
felt effect is identical when per-device latency is uniform, but a single stuck
device does not stall a round.

## 2. The defect: `adb shell` is charged the file-transfer rate

`computeAsyncFanout` is deliberately **half** the adb lane. Its own comment
(`device/adb-scaling.ts`) says why:

> *The `async` verbs (install, push, pull, adb shell, screenshot…): long, and
> several of them move megabytes.*

True of `install`, `push`, `pull`. Not true of `adb shell echo hi`, which moves
bytes and is one short round trip — the exact shape of the `sync` verbs
(`wake`, `sleep`) that get the **full** lane.

The classification conflates two independent properties:

| | job semantics (produces an async operation row?) | adb weight (one round trip, or megabytes?) |
|---|---|---|
| `adb` | async | **light** |
| `screenshot` | async | medium (a few MB over `exec-out`) |
| `install` / `push` / `pull` | async | heavy |

`actionFanout` reads the first column to decide a width that only the second
column justifies. **`adb shell` is paying the install tariff.**

## 3. The ceiling above it: 24, everywhere, unmeasured

```js
// packages/adb/src/client.ts
339:  const max = Math.min(24, Math.max(1, opts.maxConcurrent ?? 6))
358:  this.sem.resize(Math.min(24, Math.max(1, n)))
```

`computeAutoConcurrency` caps at 24; `AdbClient` clamps to 24 twice; and
`FarmSettings.advanced.adbMaxConcurrent` is `z.number().max(24)`. The setting is
**honest** — it refuses a larger value rather than silently clamping it — but 24
is the ceiling on every road, and its stated reason ("beyond this the adb server
itself becomes the bottleneck") is not measured. `adb-scaling.ts` says so in its
own words: *"The ratios below are reasoned, not measured."*

Two facts argue the ceiling is far too conservative **for short commands**:

1. `AdbClient.exec` is **not** an `adb.exe` spawn. It is one socket to the local
   adb server: `host:transport:<serial>` → `shell,v2,raw:<cmd>`
   (`client.ts:445` `runOneShot`). Eighty concurrent sockets to a local daemon
   is unremarkable.
2. The work is on the phones, and eighty phones are genuinely parallel.

The counter-argument is real and is why §5 does not simply raise the number: the
semaphore is shared by **every** adb caller — session builds, screencap, the
readiness sweep, transfers, guest-agent probes. Widening it globally trades
short-command latency for the stability of everything else, on a farm whose USB
hubs are also in the path.

## 4. The guest agent cannot be the answer for shell — and this is the finding

The attractive hypothesis: Panda keeps a persistent socket to an on-device agent
and writes the command to all 80 at once, with no shell process per phone.

Enkaku has an agent, and the transport half of that idea is already sound:
`ControlService.kt` runs a `LocalServerSocket` with a cached thread pool, and it
already serves long-lived connections (`ui.watch` streams over a held socket).
Making ordinary calls persistent instead of "connect → one line → close"
(`guest-agent/client.ts:75`) is a contained change.

**But the agent cannot run the commands.** Its manifest asks for `INTERNET`,
`ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `RECEIVE_BOOT_COMPLETED`,
`POST_NOTIFICATIONS`, `SET_WALLPAPER` — ordinary app permissions. It runs as an
app UID. `adb shell` runs as the **shell** UID. Everything the farm actually
sends is on the wrong side of that line:

| command | needs | agent (app UID) |
|---|---|---|
| `settings put global stay_on_while_plugged_in` | `WRITE_SECURE_SETTINGS` | no |
| `svc power stayon` | shell UID | no |
| `wm user-rotation lock` | shell UID | no |
| `input keyevent` | `INJECT_EVENTS` (signature) | no |
| `pm` / `am` / `dumpsys` | shell UID | no |

So an `exec` capability on the agent would be a socket that runs commands *less*
privileged than the ones the farm needs, while adding a genuinely dangerous
surface: an abstract Unix socket on every phone that executes arbitrary shell,
reachable by any local app that can guess the name. **Do not build it.**

What the agent *can* usefully carry is a different thing: **structured verbs it
is already permitted to perform**, over a persistent connection — the
`screen-label`, `text-input`, `ui-tree`, `mock-location`, `activity` family it
already has. Those would get much faster (no reconnect, no shell spawn). They
are not what a bulk `adb shell` is.

## 5. The three roads, with their real costs

### R1 — Reclassify `adb` (and `screenshot`) as light. Low risk.

Add a weight dimension to `VerbSpec` independent of `mode`, so `actionFanout`
bounds by the lane a verb actually loads. `adb` moves from 12 to the sync width
(24).

- 80 devices: 7 rounds → **4 rounds, ~3.5 s**.
- Touches `verbs.ts`, `adb-scaling.ts`, and their tests. No transport change.
- Cannot beat the semaphore, so ~3.5 s is its floor.

### R2 — A lane for short commands. Medium risk, and the recommendation.

The precedent is already in the codebase: plan 24 gave streaming its **own**
budget (`computeAutoStreams`, up to 64) precisely because a stream must not
queue behind ordinary commands. A short shell command has the same argument —
it is cheap, bounded, and nothing else should have to wait for it.

- A third lane in `AdbClient` with its own semaphore, sized by farm count
  (say `min(96, max(16, devices))`), for one-shot `shell` under a size/time
  budget. The existing counted lane keeps transfers, installs and session
  builds at 24, unchanged.
- The per-lane clamp replaces the blanket `Math.min(24, …)`, which currently
  bounds a lane it was never reasoned about.
- 80 devices: **~1–1.5 s**, the competitor's number, because the limit becomes
  the phones rather than our own queue.
- Needs measurement before the default is set — `bun run bench:wake` is the
  instrument the repo already names, and the honest first ship is a
  conservative default plus an `ENKAKU_*` override.

### R3 — Raise the global 24. Not recommended alone.

One-line, and it moves everything that shares the lane, including the paths
plan 228 just made cheaper. Without R2's separation there is no way to give
short commands room without also handing it to installs.

## 6. Two adjacent findings, both corrections

1. **`ENKAKU_WALL_DECODE_TILE_CEILING=64` does not give 64 tiles.**
   `computeAutoTiles` ends in `Math.min(32, …)` with no override, so the env var
   saturates at **32**:

   ```
   ceiling=24 → 24 tiles    ceiling=32 → 32 tiles    ceiling=64 → 32 tiles
   ```

   Sixty devices in one viewport is therefore not reachable by configuration at
   all. This corrects the advice given on 2026-09-15.

2. **The input path is already right.** `ws-handlers.ts`'s pointer stream
   coalesces newest-wins per stream with an in-flight guard
   (`ws-handlers.ts:1863`), and the mirror fan-out sends to every target without
   a bound. Nothing here is the cause of a bulk-command wait.

## 7. What would have to be measured before R2 ships

None of the numbers below are known; every one of them is currently reasoned.

| # | Question | Instrument |
|---|---|---|
| M1 | Where does adb-server throughput for one-shot `shell` actually knee — 24, 64, 128? | a bench that fans one `echo` across N devices at rising widths |
| M2 | Does a wide short-command lane measurably damage a concurrent session build or transfer? | run M1 against a farm with a wall open and an install in flight |
| M3 | Does a USB hub, rather than the adb server, become the limit first? | M1 split by transport (`adb-usb` vs `adb-tcp`) |
| M4 | What is one `adb shell` round trip, per transport, on the owner's hardware? | the per-command metric `AdbClient.onMetric` already emits |

M4 is free — the metric hook exists and `GET /api/adb/stats` already surfaces
the lane. Reading it on the owner's farm would replace the ~0.9 s estimate in §1
with a real number, and would say immediately whether §5's arithmetic holds
there.
