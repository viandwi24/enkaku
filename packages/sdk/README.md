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

## Publishing

```bash
bunx enkaku publish ./scripts/post-content.ts --farm http://localhost:7700
```

The CLI bundles the script and all of its dependencies into a single ESM file (the farm never installs dependencies), imports it to validate, converts the Zod `params` into a JSON Schema (which Studio uses to generate the parameter form), then POSTs it to `/api/scripts`.

Every publish creates a new row; the `(name, version)` pair is unique — bump `version` to publish again. A job records the specific row's `scriptId`, so older runs stay reproducible after a new version ships.

A token is optional, via `--token` or the `ENKAKU_TOKEN` env var (required when the core runs with `ENKAKU_PUBLISH_TOKEN` set).
