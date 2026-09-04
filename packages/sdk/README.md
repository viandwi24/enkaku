# @enkaku/sdk

The SDK for writing Enkaku automation scripts. Write them in your own editor (with full autocomplete), then publish to a farm.

```bash
bunx enkaku init my-pack     # scaffolds ./my-pack — publishes with no edits
cd my-pack && bun install
```

## A script cannot exist outside a plugin

**There is no `defineScript`.** A **plugin** is the one thing the farm publishes, versions, activates, and rolls back; a script is a *member* of one. One member is a perfectly ordinary plugin — that is what `enkaku init` writes — and adding a second script later is one more entry in `scripts`, not a new project.

This is a hard rule, not a convention: `enkaku publish` refuses an entry whose default export is not a `definePlugin()` result, and the refusal prints the wrapper so you can fix it from the error text.

```ts
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'my-pack',                // [a-z0-9-] — the KV namespace, and half of every `plugin/script` ref
  version: '2.0.0',             // semver, stamped onto every member below
  title: 'My pack',
  description: 'What this pack is for.',
  scripts: [
    {
      id: 'post-content',       // referenced as `my-pack/post-content`
      title: 'Post content',    // shown wherever the farm names this script
      description: 'Opens the composer and posts a caption.',
      params: z.object({ caption: z.string() }),
      timeout: 180_000,         // per attempt, defaults to 300_000
      retries: 1,               // extra attempts after a failure, defaults to 0

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
    },
  ],
})
```

**A member never carries its own `version`.** Every member of a bundle shares the plugin's — the bytes, the instant, and the source tree are the same, so two members cannot honestly claim different versions. Declaring one that disagrees with the plugin's throws at import time.

Everything below is written as a member. `ctx`, the phases, `params`, `result`, `runtime`, `timing` and the rules are identical to what a script has always had; only the wrapper changed.

## Declaring a result

`run`'s return value has always landed in `jobs.result` — as `unknown`, unvalidated, unmeasured, rendered as raw `JSON.stringify`. `result` is the optional, second half of the same idea `params` already gives the input side: declare a shape, and the farm checks it, stores it, sizes it, and renders it as values instead of a wall of JSON — with no per-script UI written anywhere.

```ts
import { ui, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'

const params = z.object({ videos: z.number().int().min(1).max(2_000).default(30) })

const result = z.object({
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
})

// Declared as a `const` carrying BOTH generics — that is the inference site
// that makes a wrong `run` return value a compile error. Then drop it into
// `definePlugin({ ..., scripts: [autoScroll] })`.
export const autoScroll: PluginMemberScript<typeof params, typeof result> = {
  id: 'auto-scroll',
  title: 'Auto-scroll the feed',
  description: 'Watches videos until the target count is reached.',
  params,
  result,

  async run(ctx) {
    // ... returns the shape above; a wrong shape is a compile error right here, in your editor
    return { videos: 15, watchSeconds: 812, byLabel: { skim: 4, full: 11 }, endedOnStall: false }
  },
}
```

**Optional, always — declaring nothing is not a lesser choice.** A definition with no `result` keeps `run` returning `Promise<unknown>` exactly as before, `scripts.result_schema` stays `NULL`, and the job renders exactly as it always has, plus one extra fact recorded on the row: `resultStatus: 'undeclared'`. There is no nag and no deprecation path for the scripts that genuinely have nothing structured to say.

**The payoff for declaring one is a compile error in your own editor, not a runtime surprise.** `PluginMemberScript`'s second generic makes a `run` that returns the wrong shape fail `tsc` before you ever publish — the same trick `ui()` already plays on a misspelled `kind`. It has to be written at the member's own `const` declaration, as above: TypeScript cannot reverse-infer a second, independent generic per element of the `scripts` array, so a member written inline gets typed `params` (`ctx.params` is inferred) but a wide `result`.

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

`ctx.artifact.file()` resolves `Promise<{ artifactId }>` (plan 115 §3.6) — the id the artifact was saved under, so a script that read bytes from somewhere (say, the workspace) and wants them on a device can chain straight into `ctx.device.push({ artifactId, ... })` without a second lookup. Additive: every caller that only wanted the side effect can keep ignoring the return value.

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

Your live Zod schema — `.refine()`/`.superRefine()` included — is real, and the child validates your actual return value against it, not a JSON Schema approximation. That is strictly better than what `params` can offer (a `.refine()` on `params` is invisible to the run-dialog form, plan 95 §9 Q2). The trade is the flip side: **the published `resultSchema` a reader sees — on the job detail page, in `ScriptDetailSchema`, wherever `resultSchema` is served — silently drops every `.refine()`/`.superRefine()`**, because converting to JSON Schema cannot express one. So a result can be legitimately rejected (`resultStatus: 'invalid'`) for a reason the schema a reader is looking at does not show. The real reason always survives in `resultIssues` — Zod's own message, stored verbatim, never recomputed — and `enkaku publish` prints a warning at publish time naming the field when your `result` carries a refinement the published schema cannot show. (Today that warning reuses `params`'s own wording verbatim — it talks about "the run form", which a result does not have — a known rough edge, tracked in `docs/plans/96-m61-hotfixes.md`, not yet fixed.)

## Runtime envelope — a restriction, never a permission

`timeout`/`retries` above are the oldest, narrowest slice of a bigger idea: a script can declare what it needs to run, as a sibling of `params`, and the farm either honours it or refuses it by name.

```ts
// One member of a plugin — `version` belongs to the plugin, not to a member.
{
  id: 'post-content',
  params: z.object({ caption: z.string() }),
  runtime: {
    sdk: 1,                          // the SDK contract major this bundle was built against
    timeoutMs: 180_000,              // supersedes `timeout` — do not set both to disagreeing values
    retries: 1,                      // supersedes `retries`
    maxRssBytes: 512 * 1024 * 1024,  // this script's own memory ceiling
    maxConcurrent: 1,                // at most one copy of THIS script running farm-wide at once
  },
  // ...
}
```

`timeout`/`retries` are kept forever (a published script already used them) and are marked `@deprecated` rather than removed. `definePlugin` folds both shapes into one `runtime` at **import time**, per member: if you set `timeout: 30_000` *and* `runtime.timeoutMs: 60_000` with disagreeing values, publishing throws immediately, naming both numbers — a silent pick would be a bug you could never see by reading your own script back. Setting only one form, either form, is fine.

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
derives `id`/`version`/`params`/`reset`/`timing` from it, and returns an
ordinary frozen script definition — indistinguishable from one you wrote by
hand. You will not normally call `defineRecording` yourself; it exists so the
*interpreter* that walks a recording's steps lives in one place (the SDK), not
duplicated between the core and Studio. **Detach** (Studio, the recording's
review panel) turns a recording into a plain script you own outright, with
every step expanded as a literal `await` call — a one-way door, and the honest
way to graduate a macro into a script with real branching.

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
import { ui } from '@enkaku/sdk'
import { z } from 'zod'

// One member of a plugin's `scripts` array.
{
  id: 'auto-scroll',
  title: 'Auto-scroll the feed',
  description: 'Watches videos until the target count is reached.',
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
}
```

That renders a stepper, an ordered range reading `5 s ~ 20 s`, and a slider reading `35%` — no control name appears anywhere in the code above, because `ui()` never lets you name one. A schema says what a value *means*; Studio decides how it looks, so the form can be restyled without a single script being republished.

### `ui()` and the kinds

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
| `workspaceFolder` | string | a folder in the workspace | `/videos` — where a run writes its clips |
| `workspaceFile` | string | a file in the workspace | `/captions.txt` |

**The two workspace kinds are a path inside the workspace, never a host filesystem path** — `/videos`, `/captions.txt`, the same absolute-within-the-workspace string `ctx.fs`/`fs.list` take. Studio renders a browser over the workspace instead of a text box, so an operator picks a real folder or file rather than typing one from memory. A folder is stored **without** a trailing slash (`/videos`), because that is the only form the workspace's own path rules accept; the workspace root is `/`.

`workspaceFile` takes an optional `extensions` (`ui({ title: 'Captions', kind: 'workspaceFile', extensions: ['.txt'] })`), scoped to that one kind the way `unit` is scoped to `duration` — on any other kind it does not compile. It narrows what the browser **offers**, never what is accepted: a value stored before you added the filter still reads back and is still shown.

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

What changes is what the **form** can see. Converting your schema to JSON Schema (the format the run dialog, the schedule editor, and the enqueue-time check all read) **silently drops every `.refine()`/`.superRefine()`** — not an error, not a warning from Zod, just gone. So a `.refine()` catches a bad value only *after* a device has been claimed and the job has started, which an operator experiences as a job failure with no red field to look at, not a form error.

`enkaku publish` tells you when this applies to you:

```
warning: script "auto-scroll": params carries 1 refinement that the run form cannot evaluate (intervalMs). Operators will see it as a job failure, not a form error. Consider an ordered range, showWhen, or a per-field bound.
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

## One context, many entry points — `PluginContext` and `defineService`

A plugin is not only a bag of scripts. It can also run code for as long as it is enabled (plan 109, M74), and the point of that design is that **there is one context, not a script API and a separate runtime API**:

```ts
import { definePlugin, defineService } from '@enkaku/sdk'

export default definePlugin({
  id: 'bridge',
  version: '1.0.0',
  scripts: [ /* … */ ],
  service: defineService({
    permissions: ['device.list'],          // exhaustive; shown to the operator at install
    setup: async (ctx) => {
      ctx.log.info('up')
      await ctx.storage.global.set('startedAt', Date.now())
      ctx.onStop(() => { /* close whatever you opened */ })
    },
  }),
})
```

**It is `service`, not `runtime`, and the two words are not interchangeable
here.** A plugin MEMBER's `runtime` is the envelope below — `timeoutMs`,
`retries`, `maxRssBytes`, `maxConcurrent` — a restriction a script places on its
own execution. `service` is the long-lived half. Two adjacent keys sharing one
word would have meant reading the wrong doc comment forever.

`ctx.storage`, `ctx.log` and `ctx.farm` are the same three members a script handler gets — the same types, built by the same function — so a helper you write once works from either end:

```ts
// helpers.ts — imported by your script AND by your runtime
import type { PluginContext } from '@enkaku/sdk'

export async function bump(ctx: PluginContext, deviceId: string) {
  ctx.log.info('bumping', { deviceId })
  return ctx.storage.forDevice(deviceId).increment('runs', 1)
}
```

`ScriptContext` **extends** `PluginContext`, so that is checked by the compiler and not by anybody remembering.

| member | script handler | service handler |
|---|---|---|
| `storage.global` | the farm's scope | the farm's scope |
| `storage.device` | your job's device | **refuses `E_NO_DEVICE_SCOPE`** — an HTTP handler has no ambient device; name one |
| `storage.forDevice(id)` | your job's device only — any other refuses `E_FOREIGN_DEVICE_SCOPE` | that device |
| `log` | joins the job log | joins the plugin's runtime log |
| `farm.call` / `farm.callRaw` | the capability broker | the capability broker |
| `device`, `params`, `job`, `artifact`, `jobs` | yes | **absent** — they need a claimed device and a job |

`ctx.storage` is `ctx.kv` under plan 109's name, and it is literally the same object. Both names work and always will; `ctx.kv` is what every already-published bundle compiled against.

### The service is in-process, and that has a price you must know

A script runs in its own child process. **A service does not.** Your service code is loaded into the core process, alongside the queue, the device registry, and every live screencast. That buys immediacy and costs containment, and the honest list is short:

**Caught, and charged to your plugin:** a handler that throws, a handler that rejects, a handler that overruns its deadline, a module that fails to import, and — where the farm can trace it back to you — a floating promise rejection. Each one is charged against an error budget: 20 failures in 60 seconds and your service is stopped, marked `failed` with your last error shown verbatim, and **not retried** until someone starts it again.

A handler that overruns its deadline frees the CALLER; it does not stop your handler. A JavaScript promise cannot be cancelled. Your `setup` receives an `AbortSignal` on every guarded call and honouring it is the only way your code actually stops.

**Not caught, by any amount of `try`/`catch` — each one takes the whole farm down:**

- a synchronous infinite loop (`while (true) {}`) — the event loop stops, and every device with it;
- running out of memory;
- `process.exit()` anywhere in your code;
- a native crash inside an npm dependency you imported.

This is **not a sandbox**, and it is not called one. It is a deliberate choice for a farm whose plugins are written by its own operator: there is no marketplace, no third-party distribution, and no signing. `isolation: 'process'` is reserved in the manifest for the day that stops being true: you may write it, and the farm refuses it at verify with `E_PLUGIN_ISOLATION_UNSUPPORTED`, naming it as unimplemented rather than ignoring it.

One more thing that is worth knowing before you read a status: **`starting` is not `running`.** Your service is `running` only once your `setup` has resolved. Until then it is `starting`, and every call into it is refused with `E_PLUGIN_RUNTIME_STARTING` rather than queued — so if your `setup` awaits something slow, nothing of yours is reachable yet, and the Plugins page will say exactly that.

## Your script can be a workflow node

A **workflow** (plan 99, M64) is a pipeline of published scripts, run as one job on one device under one control marker — see `packages/protocol/README.md` and `packages/core/README.md` for the document shape and the executor. Nothing about how you write a script changes to make it usable as a node: any published script can be one, referenced by `name@version` (or `name@latest`), and it runs exactly the way it runs on its own — its own child process, its own `timeout`/`retries`/`params`/`finish()`. A workflow author cannot see your source, only your `paramsSchema` and, if you declare one, your output shape; they wire your script's parameters to a constant, a workflow parameter, or an earlier node's output through a closed binding grammar that never evaluates code (see `packages/protocol/README.md`'s "the rule that matters most").

Three things make a script a *good* node, and none of them are enforced — they are what makes the pipeline around your script trustworthy rather than merely runnable:

**A small, declared output.** `return { ok: true, videos: 15 }` from `run()` is readable by a later node through `{ from: 'thisNode', path: 'videos' }` whether or not you declare a shape for it — but an undeclared output can only be checked when the workflow actually *runs*, never at publish time, so a typo in a binding's `path` becomes a 3am job failure instead of a red field in the editor. Once your farm's plan 97 output contract is available, declare one; until then, keep the shape flat and the field names stable across versions, because a workflow bound to `videos` today breaks quietly if a later version renames it to `videoCount`.

**An idempotent `finish()` — the same rule as always, now exercised harder.** A node's failed attempt is retried in place, same job, same device, same control marker, a fresh child — which is nothing new (`finish` already runs in a fresh process after a killed attempt, see "Rules that matter" above). What is new is **resume**: an operator can restart a *later* job at this node, on a device your script has no memory of touching since. `finish()` must not assume anything about what ran immediately before it beyond what `ctx` itself tells you — no closure state, no "I know I just launched the app because the previous line did," because on a resumed run that previous line may not have executed in this process at all.

**A `reset` declaration that is honest.** A workflow node defaults to `reset: 'farm'` if it is first in the pipeline, `reset: 'none'` for every node after — meaning by default your script's `prepare()` runs on whatever state the *previous* node left the device in, not a freshly reset one. If your script assumes it always starts from a clean launcher (force-stops nothing itself, expects no other app in the foreground), say so by declaring `reset: 'farm'` on that node in the workflow document rather than letting `prepare()` silently misbehave the one time it runs second in a pipeline. Conversely, if your script is a warm-up step whose entire purpose is to leave the device somewhere useful for the next node (the owner's own example: scroll the feed, then search from there), do not force-stop your own target app in `finish()` unless the workflow is actually ending — a cleanup written for a solo run can quietly undo the one thing the pipeline exists to preserve.

## A plugin can own a screen — `surface`

A **plugin** is one project (an `index.ts` calling `definePlugin`) that publishes several scripts sharing helpers, types, and constants as a single bundle. `definePlugin` also takes an optional `surface`: the screens the plugin contributes to Studio — a sidebar entry, a page, a table, forms, and actions. A plugin that omits `surface` is unaffected in every way.

**The screen is data, not code — on the default path.** A declared view has no JavaScript of yours in the operator's session, no expression language, and no string interpolation: you declare *what the screen holds*, and Studio draws it with the same components every other screen uses. When a table is the wrong shape for what you are building, you ship a React module instead and Studio mounts it in its own tree — that is tier C, below, and it is code, with everything that implies.

```ts
import { definePlugin } from '@enkaku/sdk'

export default definePlugin({
  id: 'tiktok',
  version: '1.5.0',
  title: 'TikTok automation pack',
  description: 'Watch-and-scroll automation for the TikTok feed, with human-shaped timing.',
  scripts: [switchAccount, searchFollow, listAccounts, autoScrollScript],

  surface: {
    nav: [{ id: 'accounts', label: 'TikTok accounts', icon: 'users', view: 'accounts' }],
    views: {
      accounts: {
        title: 'TikTok accounts',
        description: 'Which accounts are signed in on each device, as last read from the switch-account sheet.',
        // One row per ACCOUNT, not per device: `rows: 'items'` flattens the stored value's
        // `accounts` array, and `includeMissing` keeps a never-synced device visible as a row.
        data: { kind: 'kv.scan', key: ACCOUNTS_KEY, rows: 'items', itemsAt: 'accounts', includeMissing: true },
        table: {
          rowKey: 'username',
          selectable: true,
          columns: [
            { field: '$device.label', header: 'Device' },
            { field: 'username', header: 'Account' },
            { field: 'position', header: 'Slot', width: 'narrow' },
            { field: 'current', header: 'Signed in', schema: { type: 'boolean' }, width: 'narrow' },
            { field: '$entry.updatedAt', header: 'Last synced', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          ],
        },
        toolbar: ['sync'],
        rowActions: ['switchTo', 'syncOne'],
        empty: { title: 'No accounts read yet', hint: 'Run “Sync accounts” to read the switch-account sheet on each device.' },
      },
    },
    actions: {
      sync:    { kind: 'batch', label: 'Sync accounts',      script: 'tiktok/list-accounts@latest', target: 'picker' },
      syncOne: { kind: 'job',   label: 'Sync this device',   script: 'tiktok/list-accounts@latest', device: 'row' },
      switchTo: {
        kind: 'job',
        label: 'Switch to this account',
        script: 'tiktok/switch-account@latest',
        device: 'row',
        params: { target: { $row: 'username' } },
        confirm: 'Switch this device to the selected account?',
      },
    },
  },
})
```

That is the pack's `accounts` view, copied from `plugins/tiktok-automation-pack/src/index.ts`, not a sketch. Read it alongside this section — it is the reference implementation and it is kept working.

It is no longer the pack's *whole* surface: plan 113 added a second view (`content`, the post queue) and a `service` block, and neither is reproduced here. The excerpt is a worked example of the vocabulary, not an inventory of one pack — for the full picture, read the file.

### Columns and forms are JSON Schema — there is no field vocabulary here

A column's optional `schema` is an ordinary JSON Schema node, and it is drawn by the **same resolver** a script's parameter form and a job's result view use (`docs/design.md`'s "Schema-driven forms"). `{ type: 'boolean' }` is a truth mark; `{ type: 'number', 'x-enkaku': { kind: 'timestamp' } }` is a unix-seconds instant rendered as a relative time. Everything the `ui()` vocabulary can say about a parameter it can say about a column, and the surface adds **nothing** of its own at field level — no `widget`, no `render`, no `format`. A column with no `schema` is plain text.

The same is true of an action's form: a `form` action states a `schema` and Studio opens the run dialog's own `SchemaForm` on it, so you get enums with labels, ordered ranges, durations, and `showWhen` for free.

### Where the rows come from

Two data sources, and **neither one names a namespace** — a source can only ever read your own plugin's KV namespace, which is your plugin's `id`. The farm takes it from the URL path, never from anything you or the browser send, so there is no field to spell another plugin's name with.

| `data.kind` | one row is | notes |
| --- | --- | --- |
| `kv.scan` | one device, or one element of `itemsAt` inside that device's entry | `includeMissing: true` (the default) keeps a device with no entry as a visible row, so "never synced" is a state rather than an absence |
| `kv.list` | one entry in your `global` namespace | `scope` is `'global'` only; a device-scoped list with no device to scope it to is a `kv.scan` |

Your scripts write what the screen reads: `ctx.kv.device.set(...)` from a job, read back by the view; a `kv.set` action writes what the next job reads. One store, two writers — which is why the screen and the scripts should share a key **constant** rather than two copies of a string.

### Bindings — the only way a value reaches an action

An action names a value it needs with a closed, non-Turing binding: a literal (`{ $literal: 'x' }`), `{ $row: 'dot.path' }`, `{ $form: 'dot.path' }`, `{ $device: 'label' }` (one of `id`, `stableId`, `label`, `status`, `groupId`), `{ $entry: 'updatedAt' }` (one of `key`, `version`, `updatedAt`), or an object or array whose leaves are bindings. No operators, no interpolation, no calls, no regular expressions. A bare `'username'` is **not** a binding — a plain string is a literal value, so "read from the row" and "written by the author" can never be confused.

`confirm` is a plain sentence and never a template. Studio names the target itself, from the view's own `rowKey`.

### Actions, and who is allowed to run them

Four kinds — `job`, `batch`, `kv.set`, `kv.delete` — plus `form`, which opens a `SchemaForm` and then runs one of them. Every one executes **server-side**, so a `batch`'s `name@latest` is resolved to a concrete script id by the same registry `POST /api/batches` uses, and every execution writes an audit row naming your plugin and the action. Permission comes from the action, not from the screen: `job`/`batch` need `job.run`, `kv.set`/`kv.delete` need `plugin.data`.

One asymmetry worth knowing before you design a toolbar: **a batch cannot target a dev-slot script.** A batch pins a reference and must survive the laptop closing; a dev slot expires after 30 idle minutes, so a paced batch could outlive the entry it was enqueued against. A `job` action takes the explicit ad-hoc path and works against a dev slot. That is why the pack above has both `sync` (a fleet batch) and `syncOne` (the same read, one device, a job) — the second is what makes `enkaku dev` on this pack a working loop.

### What `definePlugin` refuses on your machine

The surface is validated at import time, before any network call, by `validatePluginSurface` — the same function the farm's verify child and its parent re-check both run, so a defect cannot pass here and fail there. It throws for: a nav entry naming a view that does not exist; a toolbar or row action naming an action that does not exist; a duplicate nav id; an icon outside the allowlist; a view declaring both `table` and `react`, or neither; a `table` with no `data`; and any cap exceeded — 8 nav entries, 16 views, 32 actions, 12 columns, 256 KiB for the whole serialised `surface`, 8 MiB for the `ui/` directory. Each refusal quotes the limit it hit. Every defect is reported at once, not one per run.

Two checks happen on the farm rather than here. Every JSON Schema a surface embeds is put through **`checkDeclaredSchema`** — the same gate a `params` schema passes — at verify, so a column schema that is too deep or too wide fails there. And the *existence* of a `script` a `job`/`batch` action names is deliberately never checked, at either end: a pack may reference a script published separately, so the action reports `script_not_found` at click time, the same failure the run dialog already gives. Either way the failure is `E_PLUGIN_SURFACE_INVALID`: the plugin is recorded `failed`, registers **zero** scripts, and changes nothing about any other plugin.

### Tier C — your own React, and what you are taking on with it

A view may state `react: { entry: 'index.js', apiVersion: 1 }` instead of `table`. Studio loads that module out of your package's `ui/` directory and mounts your component **inside its own React tree**, on its own React. You write ordinary React — hooks, your own components, tabs, a canvas, whatever the screen actually is — and there is no vocabulary in your way.

You also get Studio's components for real. Import `@enkaku/ui` and you receive the **host's live instances**: your `Table` is not a lookalike of Studio's `Table`, it is the same one, so your screen picks up its next change on the day Studio does. `@enkaku/ui` also carries the pieces that make a screen *behave* like a Studio screen rather than merely look like one, which is the difference between borrowing Studio's buttons and matching it:

- `EmptyState`, `ErrorState`, `LoadingRows`, `ConfirmDialog` — the states every list has to handle, drawn the way the jobs list draws them.
- `api(path, schema, init?)` — a `fetch` that resolves the core's origin for you, unwraps the farm's error envelope, and validates the response against a Zod schema instead of casting it. `useAction()` gives a button its pending state and its toast. `coreBase()` is the origin on its own if you want to build a URL yourself.
- `z` — Zod itself, re-exported, so `api()`'s required schema costs your bundle nothing. `@enkaku/ui` is external; a `zod` of your own would be a second copy.
- `relativeTime`, `duration`, `fileSize`, `formatFieldValue` — so a time on your screen reads the way every other time in the farm reads.

**You do not have to find the core.** `fetch('/api/…')` is only correct when Studio is served BY the core, which is the normal deployment but not the only one — under `bun run dev:studio` the page is on :3001 and the core on :7700. `api()` handles it, and sends the session cookie cross-origin. If you would rather not use `@enkaku/ui` at all, the expression you want is `new URL(import.meta.url).origin`: your module was served by the core, so its own URL is the core's.

What is deliberately **not** here: `PageHeader` (Studio already draws one above your view, from your manifest's `title` and `description` — a second is two stacked sticky bars) and `PaginatedTable` (its envelope is the farm's internal keyset contract, not one your own routes owe anybody).

Use none of it and write plain HTML if you prefer; that is a supported choice.

There is **no sandbox, and this document will not pretend otherwise.** Your module runs in Studio's page with the operator's session, and `fetch` reaches the farm exactly as Studio's own code does. Nothing narrows what you can touch. Studio wraps your component in an error boundary, which contains a *crash* — a component that throws renders an error instead of taking the page down — and contains nothing else. This is deliberate: your scripts already run in the core's own process with the core's full OS authority, so the browser half extends that trust to nobody new (`docs/spec.md` §11.3, §11.6). One consequence to know: an action your UI takes is attributed to the operator whose browser ran it, not to you.

Three costs, so the choice is made on them rather than on taste:

- **A build step and a version coupling.** `apiVersion` is the `@enkaku/ui` major you built against. It is required, and the farm checks it **at verify** with exact equality: a mismatch is refused as `E_PLUGIN_UI_UNSUPPORTED`, naming both numbers, before the plugin can be activated. That is a checked incompatibility instead of a component that explodes in front of an operator — but it does mean a rebuild when that major moves. A tier-A plugin never needs one. There is no promise of a stable component API; Studio's components are internal and change, which is exactly why the check is equality and not a range.
- **Every state is yours to *decide*, even though you no longer have to draw them.** Tier A gets loading, empty and error from the renderer, for free and correct. Tier C hands you `LoadingRows`, `EmptyState` and `ErrorState` — the components Studio's own screens use — but nothing renders them unless you do, and nothing tells you when you forgot one. Focus and keyboard behaviour are yours outright.
- **Styling — you may need your own stylesheet, and the scaffold ships one.** Your markup renders in Studio's document, so every class Studio itself compiles is already available to you, `@enkaku/ui`'s components included. **A class Studio never used was never generated** and will do nothing at all, with no error anywhere — so the moment you write a class of your own, you need `src/ui/index.css`. See "Your own Tailwind classes" below.

`react` and `table` are mutually exclusive — exactly one renderer per view — but `data` is legal beside either, and so are `actions`. A React view may declare a `kv.scan` source and read it through the same route a table does, and may invoke a declared action, which is still the only path that resolves a script reference server-side and audits as `plugin.action`. It may equally declare neither and call `fetch` itself; `actions` may be omitted entirely.

The rule (`docs/design.md`): **tier A when the screen is rows or fields, tier C when it genuinely is not.**

### Shipping a surface: the `.enkaku` package

A plugin with a React view ships as a `.enkaku` archive — a plain `tar.gz` holding `plugin.json`, `scripts.mjs`, and `ui/`. Any entry outside that allowlist is refused at verify. `POST /api/plugins` accepts the archive raw, or the original JSON body for a plugin with no assets.

`enkaku init <name>` scaffolds the React shape by default — a script member, a view, `src/ui/index.tsx` with the registration line already written, `src/ui/index.css` with the three imports that are easy to get catastrophically wrong, and build flags that are already right — and `enkaku init <name> --script-only` scaffolds the pre-React three-file project. Every top-level file in `src/ui/` is built to `ui/<name>.js` inside the package, which is what `react.entry` names; `react` and `@enkaku/ui` are marked external, because two copies of React in one page throw `Invalid hook call`.

**`enkaku dev` iterates a React view.** It builds both halves and pushes a whole package, so a dev slot carries its `ui/` payload, and the asset route answers from the dev slot ahead of the active published row — edit, save, reload, see the change.

### Your own Tailwind classes

**You may well need none.** Studio's stylesheet already contains every class Studio itself uses, and that includes everything `@enkaku/ui`'s components are built from. A screen drawn from those components needs no stylesheet at all — delete `src/ui/index.css` and the two Tailwind devDependencies with it, and nothing breaks.

You need one the moment you write a class of your own. `grid-cols-[200px_1fr]`, `rotate-3`, a colour Studio never reached for: that class was never generated, so your markup renders with the attribute intact and not one matching rule. There is no error and no warning — this is the single most confusing thing about writing a plugin screen, which is why the scaffold ships the stylesheet rather than leaving you to discover it.

The convention is a stylesheet **named after the entry it belongs to** — `src/ui/index.css` beside `src/ui/index.tsx` — compiled into `ui/index.css` in the package, which Studio links beside the module. There is no manifest field to set. `enkaku publish` and `enkaku dev` run **your project's own** `@tailwindcss/cli`; the SDK does not carry a CSS compiler, because it is bundled into your plugin and a compiler has no business in that bundle.

What the scaffold writes, and what every line of it is for:

```css
@import 'tailwindcss/theme.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities);
@import '@enkaku/ui/theme.css' theme(reference);
```

- **Never `@import 'tailwindcss'` here.** That pulls in preflight, a *global* reset, and Studio's document already has one — a second copy restyles every other screen in the farm rather than your view. Publishing refuses a stylesheet that contains it, naming the declaration it found.
- **`theme(reference)` on both theme imports.** It registers the tokens so `bg-panel` compiles, without writing a `:root` block. Your `<link>` is injected after Studio's, so a token you re-declared would win the cascade and repaint the whole farm with whatever the palette looked like the day you built. Referenced, `bg-panel` compiles to `background-color: var(--panel)` (the mapping is `@theme inline`), so Studio's live value is the only value there is.
- **`@enkaku/ui/theme.css` is the farm's design tokens** — `bg-panel`, `text-faint`, `text-ok`, `rounded-card`, and the `hover-none:` variant — read from the same file Studio compiles against, so the two cannot drift.

Hand-written CSS in that file is allowed and is entirely your own risk. It becomes a stylesheet in Studio's document, so a bare `button { … }` restyles Studio's buttons too. Scope what you add. Do not import the file from your `.tsx`: it is compiled and linked for you, and importing it hands the raw source to a bundler that does not know what Tailwind is.

## Publishing

```bash
bunx enkaku init my-pack                                  # scaffold — a script and a React screen, publishes with no edits
bunx enkaku init my-pack --script-only                    # scaffold — a script and no screen
bunx enkaku publish ./src/index.ts --farm http://localhost:7700
bunx enkaku dev     ./src/index.ts --farm http://localhost:7700   # push on every save, 30-min dev slot
```

The CLI bundles the entry and all of its dependencies into a single ESM file (the farm never installs dependencies), imports it to read the default export, checks every member's declared schemas against the published limits locally, then POSTs to `/api/plugins` — the bundle on its own as JSON, or a whole `.enkaku` package when the project has a `src/ui/` directory to build — which stages it, verifies it in a child process, and reports what it found. `--stage-only` skips the verify half so you can trigger it separately.

**An entry whose default export is not a `definePlugin()` result is refused, and nothing is sent.** The message carries the wrapper itself:

```
✗ publish failed: the entry's default export is not a plugin — and a script cannot be published on its own.

Wrap what you have in a plugin — four lines:

  import { definePlugin } from '@enkaku/sdk'

  export default definePlugin({
    id: 'my-plugin',
    version: '1.0.0',
    scripts: [{ id: 'my-script', title: 'My script', description: 'What it does', params, run }],
  })

Or scaffold a project that already publishes: enkaku init my-plugin
```

Every publish creates a new row per member; the `(name, version)` pair is unique — bump the plugin's `version` to publish again. A job records the specific row's `scriptId`, so older runs stay reproducible after a new version ships.

A token is optional, via `--token` or the `ENKAKU_TOKEN` env var (required when the core runs with `ENKAKU_PUBLISH_TOKEN` set).
