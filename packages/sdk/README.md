# @enkaku/sdk

The SDK for writing Enkaku automation scripts. Write them in your own editor (with full autocomplete), then publish to a farm.

```bash
bun add @enkaku/sdk zod
```

## Script shape

```ts
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'post-content',
  version: '2.0.0',
  params: z.object({ caption: z.string() }),
  timeout: 180_000,   // per attempt, defaults to 300_000
  retries: 1,         // extra attempts after a failure, defaults to 0

  async prepare(ctx) {          // get the device ready — may fail and retry
    await ctx.device.app.forceStop('com.myapp')
    await ctx.device.app.launch('com.myapp')
  },

  async run(ctx) {              // the real work; the return value lands in jobs.result
    await ctx.device.tap({ desc: 'New post' })
    await ctx.device.waitFor({ id: 'caption_input' })
    await ctx.device.type(ctx.params.caption)
    await ctx.artifact.screenshot('before-post')
    return { ok: true }
  },

  async finish(ctx) {           // ALWAYS runs — clean up state
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop('com.myapp')
  },
})
```

## Declaring a result

`run`'s return value has always landed in `jobs.result` — as `unknown`, unvalidated, unmeasured, rendered as raw `JSON.stringify`. `result` is the optional, second half of the same idea `params` already gives the input side: declare a shape, and the farm checks it, stores it, sizes it, and renders it as values instead of a wall of JSON — with no per-script UI written anywhere.

```ts
import { defineScript, ui } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'auto-scroll',
  version: '2.1.0',
  params: z.object({ videos: z.number().int().min(1).max(2_000).default(30) }),

  result: z.object({
    videos: z.number().int()
      .describe('How many videos were actually watched.')
      .meta(ui({ title: 'Videos watched', kind: 'count', summary: true })),
    watchSeconds: z.number().int()
      .describe('Total time spent watching, summed across every video.')
      .meta(ui({ title: 'Total watch time', kind: 'duration', unit: 's', summary: true })),
    byLabel: z.record(z.string(), z.number().int())
      .describe('How many videos fell into each watch-length bucket.')
      .meta(ui({ title: 'Watch-length buckets' })),
    endedOnStall: z.boolean().default(false),
  }),

  async run(ctx) {
    // ... returns the shape above; a wrong shape is a compile error right here, in your editor
    return { videos: 15, watchSeconds: 812, byLabel: { skim: 4, full: 11 }, endedOnStall: false }
  },
})
```

**Optional, always — declaring nothing is not a lesser choice.** A definition with no `result` keeps `run` returning `Promise<unknown>` exactly as before, `scripts.result_schema` stays `NULL`, and the job renders exactly as it always has, plus one extra fact recorded on the row: `resultStatus: 'undeclared'`. There is no nag and no deprecation path for the scripts that genuinely have nothing structured to say.

**The payoff for declaring one is a compile error in your own editor, not a runtime surprise.** `defineScript`'s second generic makes a `run` that returns the wrong shape fail `tsc` before you ever publish — the same trick `ui()` already plays on a misspelled `kind`.

**Why the JSON Schema `enkaku publish` sends for `result` is `io: 'output'`, and `params`'s is `io: 'input'`, at two separate call sites.** A `params` schema describes what a person is about to type, so a field with a `.default()` must stay optional in the form — that is `io: 'input'`. A `result` schema describes a value that has already been produced, and by the time `run()` returns, every default has already been applied — so in `io: 'output'` mode a defaulted field is correctly published as `required`. Sharing one conversion helper between the two would get one of them wrong; the SDK gives each its own named call site with the reason written above it, and you never have to think about `io` yourself unless you are reading the generated schema.

### A crash is a failure, a salvage is evidence, a handled outcome is a result

Three different things a script can report, kept deliberately separate rather than folded into one vocabulary:

1. **A crash is not a result.** It stays exactly where it already lived — `jobs.error`, `failureClass`, `errorPhase` — and this feature adds nothing there. A script-authored error enum sitting beside those columns would just give the retry policy a second, less trustworthy input to read.
2. **What a crashed run managed to salvage is evidence, not a report.** `finish()` — the one hook guaranteed to run after a failure, with `ctx.error` set — may now return a value:

   ```ts
   async finish(ctx) {
     if (ctx.error) return { videosBeforeFailure: watchedSoFar.length }
   }
   ```

   That value is stored as `resultStatus: 'partial'` — and, deliberately, **is never checked against your declared `result` schema**, even if you declared one. There is no honest lenient schema to check it against: the run never finished, so there is no contract left to hold it to, and inventing a half-checked grade would be worse than being plain about what `partial` means. A consumer that needs a guarantee reads `valid`; `partial` means only "this came from a run that did not finish."
3. **A failure you actually want a later script (or a pipeline node) to branch on is a *successful* job with a negative verdict** — not a crash at all:

   ```ts
   result: z.discriminatedUnion('ok', [
     z.object({ ok: z.literal(true), videos: z.number().int() }),
     z.object({ ok: z.literal(false), reason: z.enum(['blocked', 'logged-out', 'no-feed']) }),
   ]),
   async run(ctx) {
     try { /* ... */ ; return { ok: true, videos } }
     catch (e) { if (isBlocked(e)) return { ok: false, reason: 'blocked' }; throw e }
   }
   ```

   The job is `success`, the result is `valid`, and whoever reads it branches on a typed field instead of parsing an error string.

### The 64 KiB rule, and `ctx.artifact.file` is the door

A result is capped at `job.maxResultBytes` — a farm setting, default **64 KiB**, the same number `ctx.kv`'s value cap already uses (the two are the only places a script persists structured JSON, so they share one number rather than two to remember). The cap is measured in the child, on the plain JSON, **before** anything crosses to the parent process — so a result far over the limit never costs the parent any memory. Going over sends the *verdict*, not a truncated value: the job still settles `success` (the device work already happened), `resultStatus` becomes `'oversize'`, `resultBytes` is the exact measured size, and `jobs.result` is `NULL` — never a half-written value that happens to parse.

The job detail screen then names the fix rather than just the wall: *"save large output as an artifact with `ctx.artifact.file('report', data)` and return a small summary that points at it."* Artifacts are already the large-payload door — per-job, broadcast live, sized, retained — reachable from every script's `ctx`. A result is for the handful of numbers a human or another script needs to read as *values*; anything bigger belongs in a file.

### `ctx.progress` is an observation; `result` is a commitment

`ctx.progress(value)` reports how a long run is going *right now* — coalesced to at most one push per `job.progressIntervalMs` (default 1000ms), last value wins, so calling it in a tight per-item loop costs one assignment, never one message per call. It is never persisted (no column, no `UPDATE`, gone the moment the core restarts), never validated against `result`'s schema, and never readable by `ctx.jobs.resultOf` or by any other job — its only consumer is someone watching the job detail screen while it runs. A `result` is written exactly once, at settle, and is the one thing another script may read back.

```ts
async run(ctx) {
  for (const video of feed) {
    // ... watch it ...
    ctx.progress({ videos: watched.length, watchSeconds })   // live — cheap even called per video
  }
  return { videos: watched.length, watchSeconds }             // the one, final, readable result
}
```

If you find yourself wanting another job to read an *intermediate* value while this one is still running, that is a different, unbuilt feature — `ctx.jobs.resultOf` deliberately refuses a job that has not finished, and a streaming result would make that refusal meaningless.

### The `.refine()` gap

Your live Zod schema — `.refine()`/`.superRefine()` included — is real, and the child validates your actual return value against it, not a JSON Schema approximation. That is strictly better than what `params` can offer (a `.refine()` on `params` is invisible to the run-dialog form, plan 95 §9 Q2). The trade is the mirror image: **the published `resultSchema` a reader sees — on the job detail page, in `ScriptDetailSchema`, wherever `resultSchema` is served — silently drops every `.refine()`/`.superRefine()`**, because converting to JSON Schema cannot express one. So a result can be legitimately rejected (`resultStatus: 'invalid'`) for a reason the schema a reader is looking at does not show. The real reason always survives in `resultIssues` — Zod's own message, stored verbatim, never recomputed — and `enkaku publish` prints a warning at publish time naming the field when your `result` carries a refinement the published schema cannot show. (Today that warning reuses `params`'s own wording verbatim — it talks about "the run form", which a result does not have — a known rough edge, tracked in `docs/plans/96-m61-hotfixes.md`, not yet fixed.)

## Runtime envelope — a restriction, never a permission

`timeout`/`retries` above are the oldest, narrowest slice of a bigger idea: a script can declare what it needs to run, as a sibling of `params`, and the farm either honours it or refuses it by name.

```ts
export default defineScript({
  id: 'post-content',
  version: '2.0.0',
  params: z.object({ caption: z.string() }),
  runtime: {
    sdk: 1,                          // the SDK contract major this bundle was built against
    timeoutMs: 180_000,              // supersedes `timeout` — do not set both to disagreeing values
    retries: 1,                      // supersedes `retries`
    maxRssBytes: 512 * 1024 * 1024,  // this script's own memory ceiling
    maxConcurrent: 1,                // at most one copy of THIS script running farm-wide at once
  },
  // ...
})
```

`timeout`/`retries` are kept forever (a published script already used them) and are marked `@deprecated` rather than removed. `defineScript`/`definePlugin` fold both shapes into one `runtime` at **import time**: if you set `timeout: 30_000` *and* `runtime.timeoutMs: 60_000` with disagreeing values, publishing throws immediately, naming both numbers — a silent pick would be a bug you could never see by reading your own script back. Setting only one form, either form, is fine.

**Read this paragraph twice before you set `maxRssBytes` or `maxConcurrent`: every field here is a restriction your script places on *itself* — never a permission it is requesting.** Declaring `maxRssBytes: 4_000_000_000` does **not** grant your script four gigabytes of memory. It states a ceiling *you* promise to stay under. The farm's own administrator-set ceiling still wins regardless of what you declare, and if you (or whoever runs your job) supply a per-job override that asks for more than the farm allows, the farm refuses the job outright — `E_RUNTIME_OVER_CEILING`, naming the ceiling it exceeded — it does **not** quietly clamp your number down and run anyway. If you take this envelope for an allowance, you will publish a script that runs fine on your own farm and then fails confusingly, at enqueue, on a farm you do not administer and whose ceiling you cannot see from here. The fix when that happens is never "ask for less by trial and error" — it is to ask whoever runs that farm what its ceiling actually is.

Every field is validated independently by the farm at publish time (`enkaku publish` sends it, the core re-checks the shape itself — never trusting this SDK's own validation alone) and is **append-only and forward-compatible**: a field this SDK adds that an older, not-yet-upgraded farm does not recognize is dropped with one warning, never a fatal error, and — because every field only *restricts*, per the paragraph above — the worst a farm ignoring a field you declared can do is run your script under its own, looser numbers, visibly and logged. That safety property is exactly why a future field is only ever allowed to restrict: a field that instead *granted* something (network access, a filesystem permission) could not ride this same channel, because an older farm silently ignoring it would fail open instead of closed.

What each field is checked against, and how strictly:

| Field | Enforcement | In practice |
|---|---|---|
| `sdk` | hard | An unsupported SDK major is refused **at enqueue**, before any device is claimed. Omit it and you are treated as the current major — every script that predates this field keeps working unchanged. |
| `timeoutMs` | hard | The exact number the existing kill path (grace → SIGTERM → SIGKILL) arms against. A request over the farm's ceiling is clamped down and logged (naming your script and both numbers), not refused — the artefact may already be published and running elsewhere. |
| `retries` | hard | Your own retry budget on a failure classified as **your script's fault** — separate from the farm's own infrastructure retry budget. An exact count. |
| `maxRssBytes` | **sampled** | Your process's memory is polled periodically (2 s by default) via `process.memoryUsage.rss()` — there is no OS-level cap underneath this. A breach is caught within one sample interval, **not prevented**: a single huge allocation between two samples can still happen. On a breach the kill is an **immediate SIGKILL with no grace period** — harsher than a timeout kill, deliberately, because a process already over its own declared ceiling should not be trusted to clean up politely on its way out. `finish()` still runs afterward — always — in a genuinely fresh process with `ctx.error` populated, exactly as the rule above describes; only the *grace period* is skipped, never the cleanup guarantee. |
| `maxConcurrent` | hard | Farm-wide, keyed on your script's **name**: at most this many jobs of *this* script run at once, across every device, enforced inside the database's own claim transaction — not a best-effort check that can race. `0` (or omitted) means unlimited. It blocks only additional jobs of *your* script; every other script on every other device keeps running normally. |

No field here is `advisory` today — an unlabelled, unenforced field is not something this SDK will ever let you add silently.

**There is no farm-wide memory default this SDK can assume.** A farm may run with no memory ceiling configured at all (`null` is the shipped default on both farm-side memory settings), in which case an undeclared `maxRssBytes` means your script runs with no memory limit whatsoever — not some baked-in number. If your script needs a memory ceiling, declare `maxRssBytes` yourself; do not rely on the farm having set one.

## Rules that matter

**`finish` must be stateless and idempotent.** If an attempt hits its timeout and its process is force-killed, the core runs `finish` in a **fresh process** (a finish-only attempt) so the promise that "the device comes back clean" still holds. That new process shares no memory with the `run` that died: closure variables, connections, and file handles are gone. So `finish` may depend on `ctx` and nothing else.

**Selectors are layered** — stable to fragile: `{ id }` → `{ desc }` → `{ text }` → `{ point }`. One selector holds exactly one key. The device page's **Inspect** tab dumps the live tree and proposes match-counted candidates instead of making you guess — see [`docs/guide/scripts.md`](../../docs/guide/scripts.md#finding-a-selector).

**`find` answers `null` when it cannot answer.** A selector that only resolves to a viewport-sized container is not a match: `tap` aims at a node's centre, so acting on one presses the middle of the page. The inspector rejects it and `find` returns `null` — the same answer as a genuine miss, so there is no third case to handle.

**`ctx.device.dump()` gives you the whole tree**, the same one the Inspect panel renders — for everything a four-shape selector cannot reach. **It costs 334–584 ms** (a `find` is ~80 ms), so fetch it once and walk the result:

```ts
const tree = await ctx.device.dump()
const nodes: UiNode[] = []
const walk = (n: UiNode) => { nodes.push(n); n.children.forEach(walk) }
walk(tree)

// The value the operator wants carries a resource id and no text of its own —
// no selector reaches it, one line of TypeScript does.
const ip = nodes.find((n) => n.resourceId.endsWith('lite-your-ip-value'))?.children[0]?.text
const rowCount = nodes.filter((n) => n.resourceId.endsWith('list_item')).length
```

Calling it once per assertion instead is a choice, not an error — the cost is stated, not enforced.

**`type()` handles printable ASCII only in M4** (it uses `adb shell input text`). Unicode and IME text arrive with `ui-server.set_text` (M4.5) and UHID input (M6).

**`waitFor` polls the inspector; it is not a sleep.** In M4 the inspector is `uiautomator dump` (0.5–2 seconds per query), so the default interval is one second. M4.5 swaps in `ui-server` (<200 ms) without changing this API.

**`ctx.device.clipboard.get()`/`.set()`** read and write the device clipboard over the scrcpy control socket. `set(text, { paste: true })` immediately pastes into the focused field — off by default, since it is easy to trigger by accident. On a session with no scrcpy control socket (`screencap-loop`), `get()` rejects `E_CLIPBOARD_UNAVAILABLE` rather than returning an empty string; `set()` still best-effort attempts it over adb.

**`ctx.jobs` sees this device's jobs — queued, running, finished — and only this device's.** `ctx.jobs.list()` pages through them (server-side keyset paging, capped at 100 per page); `ctx.jobs.previous()` answers "what ran on this phone right before me" (the job that *finished* most recently before this one *started* — not a happens-before guarantee, since another device or a manual run could interleave); `ctx.jobs.queuedAfter()` answers "what's waiting behind me". None of the three ever carries a `params` or `result` field — both are script-authored JSON, and a script has no business reading a neighbour's. `ctx.jobs.resultOf(jobId)` is the separate, narrow door to a result: it works only for a job whose script shares this one's name, and returns `null` for every refusal (not found, someone else's script, not finished yet) rather than telling you which — a script cannot act differently on "foreign" than on "missing", and the distinction would itself leak whether a job exists.

**`ctx.jobs.trigger()` starts another job and keeps going.** It is fire-and-forget: it returns `{ jobId, deduped }` the instant the job is *queued* — never its result, never a wait. Awaiting a triggered job from the same device would deadlock: one device runs one job at a time.

```ts
const { jobId, deduped } = await ctx.jobs.trigger({ script: 'tiktok/warmup@1.2.0', params: { account: 'x' } })
```

- **The chain is bounded by the farm, not by you remembering to stop.** Every trigger records who triggered it, the root of the chain, and how deep it is. Three farm settings — `jobs.trigger.maxDepth` (default 5), `.maxPerChain` (default 200), `.maxPerJob` (default 10) — refuse a trigger that would exceed them. A refusal **throws**: `await ctx.jobs.trigger(...)` rejects, exactly like a failed `ctx.device` call.
- **A repeated call is a no-op, not a duplicate.** Every trigger carries a key — supply your own (`key: 'followup:accountX'`) for "at most once, ever," or leave it out and the runtime derives one from this job's own id, attempt, and call count. The default reproduces the SAME key when the same code re-runs (a `finish()` that runs again in a fresh process after a timeout kill — see the rule above) but a DIFFERENT key on a genuine retry (a different attempt is different work). The second call with the same key returns the FIRST call's `jobId` with `deduped: true` and enqueues nothing.
- **The reference is pinned the instant `trigger()` runs.** `script: 'name@latest'` resolves right away; publishing a newer version afterward does not change what the queued job executes — the same reasoning `enkaku publish`'s pinned schedules already follow.
- **It defaults to this device**, and can name another (`deviceId: '...'`) — refused with a typed error if that device is missing or quarantined.

## Recordings, and the three layers of timing (plan 94, M59)

**A recording is source, not a second kind of script.** An operator records a
macro on the device page (tap through it, drag, type — Studio's Record mode),
reviews it, and publishes it; that publish goes through the exact same
`ctx.scripts.publish` every hand-written script does, and the resulting
`scripts` row is indistinguishable from one you typed. The published bundle's
entry point is generated, not hand-written, and it is deliberately thin:

```ts
// GENERATED by Enkaku's recorder from /recordings/checkout.recording.json.
import { defineRecording } from '@enkaku/sdk'
export default defineRecording({ /* the recording document, verbatim */ })
```

`defineRecording(doc: RecordingDoc): ScriptDefinition` validates the document,
derives `id`/`version`/`params`/`reset`/`timing` from it, and hands the result
to `defineScript` itself — a recording-derived script goes through exactly the
same validation, fold and freeze as one you wrote by hand. You will not
normally call `defineRecording` yourself; it exists so the *interpreter* that
walks a recording's steps lives in one place (the SDK), not duplicated between
the core and Studio. **Detach** (Studio, the recording's review panel) turns a
recording into a plain `defineScript` you own outright, with every step
expanded as a literal `await` call — a one-way door, and the honest way to
graduate a macro into a script with real branching.

### `device.gesture` and `device.longPress`

Two verbs exist specifically so a replay reproduces what was recorded, not an
approximation of it:

- **`device.gesture(samples: NormGestureSample[])`** plays a recorded pointer
  trace **sample-for-sample** — the operator's own curvature and velocity,
  never collapsed to two points and a synthesised Bézier. Rejects with
  `E_GESTURE_UNSUPPORTED` on an input engine that cannot curve a trace
  (`AdbInput` — the same engine `swipe()` already degrades to a straight line
  on).
- **`device.longPress(target: Selector, ms: number)`** is a tap held for
  `ms` — a recorded long-press replays as a long-press, never a different
  verb. `ms` names the exact duration; the device's own `tapJitterMs` range is
  recentred on it, so "Human-like touch" still means something across repeats
  rather than an identical hold every time.

### Coordinates are normalised everywhere a recording touches them — this is what lets a recording replay on a different screen

`tap`, `swipe`, `scroll`, `fling` and `longPress` all take **device-pixel**
coordinates, because an ordinary script author writes literal coordinates
against a device whose size they already know. A recording is the opposite
case — captured on one device, replayed on a device of a *different* size —
so every position a recording stores is **normalised 0..1**, and that has to
survive all the way to the driver call. `tapNorm(pos: NormPoint, opts?: {
holdMs?: number })` and `swipeNorm(from: NormPoint, to: NormPoint, ms: number)`
exist **for this reason alone**: they are the replay interpreter's own verbs,
not something an ordinary script should reach for.

**`Point` and `NormPoint` are structurally identical `{x, y}` shapes — nothing
type-checks the difference.** Hand a normalised fraction to `tap`/`swipe`, or a
device pixel to `tapNorm`/`swipeNorm`/`gesture`, and nothing throws: the tap
simply lands near the top-left corner, every time, on every device. Reach for
`tapNorm`/`swipeNorm`/`gesture` only when you are replaying something already
expressed in the 0..1 space (a recording, or a candidate `proposeSelectors`
offered) — never for a coordinate you wrote by hand.

### `ScriptDefinition.timing` — a script's own override of the device's input realism

```ts
timing?: Partial<TimingSettings>
```

Overrides the **device's** input-realism settings for this script's own calls,
merged over `DeviceSettings.timing` (falling back to the farm default) field
by field — never replacing it wholesale. A compiled recording sets
`{ betweenActionMs: [0, 0] }` because it supplies its own recorded gaps
between steps; every other field (tap jitter, coordinate jitter, typing
cadence) still comes from whichever device happens to run it. This is a
general capability, not only a recording's: a script that must type into a
field with an aggressive debounce can declare its own `timing` too. Reported
in the child's `ready` message beside `reset`, and merged fresh per attempt —
never captured once and reused.

### The three timing layers — read this table before you touch any of the three

There are three, not two, and conflating any pair produces a bad product.
Each one is a different owner, a different home, and a different scale:

| Layer | What it is | Owner | Where it is configured |
|---|---|---|---|
| **1 — Input realism** | Hold duration, coordinate jitter, typing cadence, gesture shaping. Sub-second, *inside* one action. | the **device** | Device → Settings → *Human-like touch* (`TimingSettingsSchema`) |
| **2 — Pace** | The gaps between a recording's own steps, and the interval between whole repetitions. Seconds to minutes. | the **run** | The run form → *Repeat*; the recording's own `speed` |
| **3 — Phase** | Where each device sits in the cycle, so a fleet does not fire in unison. | the **fleet** | The run form → *Stagger* |

They are not the same knob at different scales, and no single screen shows
more than one of them: layer 1 lives on a device's settings page and applies
to *everything* that device does; layers 2 and 3 live on the run form and
apply to *this run only*. `ScriptDefinition.timing` above is how a script
adjusts layer 1's own composition for itself — it never reaches into layers 2
or 3, which are dispatch concerns the SDK has no api for.

**How a replayed recording composes layer 1 with its own recorded gaps** —
the exact rule, per field:

| `timing` field | On a replayed recording |
|---|---|
| `betweenActionMs` | **superseded** — the recording's own `gapMs` replaces it |
| `tapJitterMs` | **applies**, as the spread around a step's recorded `holdMs` |
| `coordJitterPx` | **applies** — this is what stops 200 repetitions hitting one identical pixel |
| `perCharMs` | **applies** — the recording has no per-keystroke timing to supersede it |
| `profile` | `instant` still wins: it degrades a sampled path to a two-point swipe |
| `gestureCurvature`, `gestureSampleIntervalMs` | **unused** — the recorded path is real, not synthesised |

One asymmetry worth knowing: a recording captures **manual** input, which is
not jittered, and replays as **script** input, which is. So a replay is never
a byte-identical reproduction of the recording session even at `speed: 1` —
the taps land within `coordJitterPx` of where the human tapped, held for a
duration drawn from `tapJitterMs`. That is intended (it is what stops 200
repetitions being pixel-identical), not a bug.

## Parameters, and the form they become

`params` is not just a validator — it is what Studio's run dialog, schedule editor, and (soon) the agent's tool surface render *from*, with no per-script React anywhere. A plain `z.object({...})` already works: every field gets a box, a checkbox, or a dropdown, in declaration order, with a sensible fallback label. `ui()` is how you make that box the *right* box, and how you write down what a value means rather than leaving Studio to guess.

```ts
import { defineScript, ui } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'auto-scroll',
  version: '1.0.0',
  params: z.object({
    videos: z.number().int().min(1).max(2_000).default(30)
      .describe('How many videos to watch before stopping. The real count varies ±30%.')
      .meta(ui({ title: 'Number of videos', kind: 'count', group: 'Core settings' })),
    watchSec: z.tuple([z.number(), z.number()]).default([5, 20])
      .describe('How long to watch each video before moving on.')
      .meta(ui({ title: 'Watch time per video', kind: 'duration', unit: 's', group: 'Core settings' })),
    likeChance: z.number().min(0).max(1).default(0.35)
      .describe('Tap the like button after watching. Skipped when the button cannot be found.')
      .meta(ui({ title: 'Like chance', kind: 'chance', group: 'Interaction' })),
  }),
  // ...
})
```

That renders a stepper, an ordered range reading `5 s ~ 20 s`, and a slider reading `35%` — no control name appears anywhere in the code above, because `ui()` never lets you name one. A schema says what a value *means*; Studio decides how it looks, so the form can be restyled without a single script being republished.

### `ui()` and the nine kinds

`ui({ title, description?, kind?, unit?, ...})` is a typed identity function — it returns a plain object for `.meta()`, but its real job happens at your own call site: a misspelled `kind`, a `unit` on a non-duration `kind`, or a `labels` map that doesn't belong are all **compile errors in your editor**, not a surprise when you publish.

| `kind` | domain | means | example |
| --- | --- | --- | --- |
| `count` | integer ≥ 0 | a number of things | `videos`, `maxTiles` |
| `chance` | number, **exactly `[0,1]`** | a probability the script evaluates at runtime | `likeChance`, `saveChance` |
| `duration` | number + `unit` | elapsed time | `watchSec`, `execTimeoutMs` |
| `bytes` | integer | a size in bytes | `maxPushBytes` |
| `bitrate` | integer | bits per second | `controlBitRate` |
| `pixels` | integer | a length on screen | `coordJitterPx` |
| `temperature` | number | degrees Celsius | `tempThresholdC` |
| `text` | string | free text | a caption, a search query |
| `packageName` | string | an Android package id | `reset.packages` |

`unit` is `'ms' | 's' | 'min' | 'h'`, and is **required by, and valid only for, `kind: 'duration'`** — `ui({ kind: 'duration' })` with no unit, or `unit` on any other kind, does not compile.

**`chance`, not a percentage.** The value your script reads is a probability compared against `rng()`, so `kind: 'chance'` fixes the domain to `[0, 1]` — `.default(30)` meaning "30%" is a publish-time error, not a bug report later. Studio renders the percentage; your code never divides by 100.

**A number whose bounds happen to be `[0, 1]` is not automatically a `chance`**, and a field named `*Ms` is not automatically a `duration` — `kind` must be declared. Guessing from a name or a bound would occasionally be wrong in a way that is confidently invisible, so the resolver never does it; the cost of writing `ui()` once at each field is what buys the render you actually want.

`bytes` and `bitrate` are **displayed** humanised (`536870912 → "512 MB"`) and **stored** as the raw integer you declared bounds for — there is no unit conversion on the way in, so nothing your `.min()`/`.max()` says can be defeated by a rounding step.

### Grouping

Adjacent fields that share a `group` become one section, in the order they appear:

```ts
z.object({
  videos: z.number()…meta(ui({ title: 'Number of videos', kind: 'count', group: 'Core settings' })),
  watch:  z.tuple([…])…meta(ui({ title: 'Watch time', kind: 'duration', unit: 's', group: 'Core settings' })),
  like:   z.number()…meta(ui({ title: 'Like chance', kind: 'chance', group: 'Interaction' })),
  save:   z.number()…meta(ui({ title: 'Save chance', kind: 'chance', group: 'Interaction' })),
})
```

produces two headed sections, "Core settings" then "Interaction", in that order. Fields with no `group` render first, under no heading. There is no separate list of section names to keep in sync — a section's position *is* wherever its fields are, so the two can never drift apart. Repeating a group name non-consecutively (`A, A, B, A`) still renders — three sections, not two — but `enkaku publish` warns about it, since it is rarely what you meant.

A field only applies when a sibling holds a particular value: `ui({ title: 'Region', showWhen: { field: 'mode', is: 'advanced' } })`, or `{ field: 'mode', in: ['advanced', 'expert'] }`. A hidden field still submits whatever value it holds — hiding is presentation, never a way to make a value not run.

### What `.refine()` will, and will not, do

Your live Zod schema is real and `params.parse()` still runs it in the child process before `run()` starts — a `.refine()` or `.superRefine()` on `params` is exactly as enforced as it always was.

What changes is what the **form** can see. Converting your schema to JSON Schema (the format the run dialog, the schedule editor, and the enqueue-time check all read) **silently drops every `.refine()`/`.superRefine()`** — not an error, not a warning from Zod, just gone. So a `.refine()` catches a bad value only *after* a device has been leased and the job has started, which an operator experiences as a job failure with no red field to look at, not a form error.

`enkaku publish` tells you when this applies to you:

```
warning: params carries 1 refinement that the run form cannot evaluate (intervalMs). Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.
```

The one cross-field case that comes up in practice — "the low end of a range must not exceed the high end" — does not need a `.refine()` at all: declare the pair as an ordered tuple (`z.tuple([z.number(), z.number()])` with `ui({ kind: 'duration', unit: 'ms' })`, `ordered` defaults to `true`) and the form, the enqueue-time check, and the child all enforce `a ≤ b` from that one declaration. Save `.refine()` for genuine cross-field logic the form's vocabulary has no other way to express, and expect the warning above when you do.

`params` also is **not** checked against `pattern` by the form or by the enqueue-time validator, on either side — no author-supplied regular expression is ever compiled or evaluated outside your own child process, because an untrusted pattern can hang whichever process evaluates it. If you were going to use `pattern` to validate a package id, a URL, or an email, use `kind: 'packageName'` or a string `format` (`'uri'`, `'email'`, `'date-time'`) instead — those are checked by Enkaku's own code, safely, both in the browser and in the core.

### Credentials do not belong in a parameter

There is deliberately no `kind: 'secret'`. A masked input would be theatre: whatever an operator types into a form field is stored as plain JSON in `jobs.params`, and again in `batches.params`, `schedules.params`, and any named parameter set — hiding the keystrokes while writing the plaintext to four tables looks handled and is not.

Use `ctx.kv` instead — `ctx.kv.device` (scoped to one device) or `ctx.kv.global` (shared across every run of your script), both namespaced per plugin so two scripts can never collide on a key:

```ts
async prepare(ctx) {
  const token = await ctx.kv.global.get('api_token', z.string())
  if (!token) throw new Error('no api_token in KV — a farm admin needs to set one before this script can run')
}
```

A farm admin provisions the value once (through the admin-scoped `PUT /api/kv/entry`, gated on the `kv.manage` permission — never something a script's own author can reach) rather than an operator typing a secret into a run form every time. A credential set this way lives in one place, is never echoed back into a form, and is never copied into a batch, a schedule, or a saved parameter set the way a plaintext `params` value would be.

## The trust model, honestly

Every job runs in a **child process** with a hard timeout. The only guarantee is **crash containment**: a script that crashes or hangs cannot take the core down, and a timeout always frees the device.

This is **not a security sandbox**. A script bundle has full filesystem and network access as the OS user running the core. In local and self-hosted mode, the script author is treated as a **trusted operator**. Real security isolation (a container or microVM per job) is multi-tenant cloud work.

## Your script can be a workflow node

A **workflow** (plan 99, M64) is a pipeline of published scripts, run as one job on one device under one lease — see `packages/protocol/README.md` and `packages/core/README.md` for the document shape and the executor. Nothing in `defineScript` changes to make a script usable as a node: any published script can be one, referenced by `name@version` (or `name@latest`), and it runs exactly the way it runs standalone — its own child process, its own `timeout`/`retries`/`params`/`finish()`. A workflow author cannot see your source, only your `paramsSchema` and, if you declare one, your output shape; they wire your script's parameters to a constant, a workflow parameter, or an earlier node's output through a closed binding grammar that never evaluates code (see `packages/protocol/README.md`'s "the rule that matters most").

Three things make a script a *good* node, and none of them are enforced — they are what makes the pipeline around your script trustworthy rather than merely runnable:

**A small, declared output.** `return { ok: true, videos: 15 }` from `run()` is readable by a later node through `{ from: 'thisNode', path: 'videos' }` whether or not you declare a shape for it — but an undeclared output can only be checked when the workflow actually *runs*, never at publish time, so a typo in a binding's `path` becomes a 3am job failure instead of a red field in the editor. Once your farm's plan 97 output contract is available, declare one; until then, keep the shape flat and the field names stable across versions, because a workflow bound to `videos` today breaks quietly if a later version renames it to `videoCount`.

**An idempotent `finish()` — the same rule as always, now exercised harder.** A node's failed attempt is retried in place, same job, same device, same lease, a fresh child — which is nothing new (`finish` already runs in a fresh process after a killed attempt, see "Rules that matter" above). What is new is **resume**: an operator can restart a *later* job at this node, on a device your script has no memory of touching since. `finish()` must not assume anything about what ran immediately before it beyond what `ctx` itself tells you — no closure state, no "I know I just launched the app because the previous line did," because on a resumed run that previous line may not have executed in this process at all.

**A `reset` declaration that is honest.** A workflow node defaults to `reset: 'farm'` if it is first in the pipeline, `reset: 'none'` for every node after — meaning by default your script's `prepare()` runs on whatever state the *previous* node left the device in, not a freshly reset one. If your script assumes it always starts from a clean launcher (force-stops nothing itself, expects no other app in the foreground), say so by declaring `reset: 'farm'` on that node in the workflow document rather than letting `prepare()` silently misbehave the one time it runs second in a pipeline. Conversely, if your script is a warm-up step whose entire purpose is to leave the device somewhere useful for the next node (the owner's own example: scroll the feed, then search from there), do not force-stop your own target app in `finish()` unless the workflow is actually ending — a cleanup written for standalone use can quietly undo the one thing the pipeline exists to preserve.

## Publishing

```bash
bunx enkaku publish ./scripts/post-content.ts --farm http://localhost:7700
```

The CLI bundles the script and all of its dependencies into a single ESM file (the farm never installs dependencies), imports it to validate, converts the Zod `params` into a JSON Schema (which Studio uses to generate the parameter form), then POSTs it to `/api/scripts`.

Every publish creates a new row; the `(name, version)` pair is unique — bump `version` to publish again. A job records the specific row's `scriptId`, so older runs stay reproducible after a new version ships.

A token is optional, via `--token` or the `ENKAKU_TOKEN` env var (required when the core runs with `ENKAKU_PUBLISH_TOKEN` set).
