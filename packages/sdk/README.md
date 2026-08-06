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
