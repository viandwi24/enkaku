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
