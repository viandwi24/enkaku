# Writing scripts

Scripts are written with `@enkaku/sdk` — the full shape, the trust model, and publishing are documented in [`packages/sdk/README.md`](../../packages/sdk/README.md). Start with `bunx enkaku init my-pack`: a script is always a member of a **plugin** (there is no other shape, and `enkaku publish` refuses one), and the scaffold writes a one-member plugin that publishes with no edits.

This page covers one thing: finding a selector without guessing.

## Finding a selector

A `Selector` is exactly one of `{ id }`, `{ desc }`, `{ text }`, `{ point }` — no combinations, matched in that order of preference (stable to fragile). Guessing one and finding out it does not match from a `WAITFOR_TIMEOUT` fifteen seconds into a job run is the problem the device page's **Inspect** tab exists to remove.

The loop:

1. Open a device's page, take control, start the stream, then open the **Inspect** tab. It dumps the current on-device UI tree through the same `Inspector` engine your script's `find`/`waitFor` will use — nothing about the picture is synthesised.
2. Click the element you want on the snapshot (or find its row in the tree on the left) — the panel selects the deepest node under the point, or the row you clicked.
3. The panel proposes selectors for that node, ranked `id → desc → text → point`, each with a **match count against the tree you are looking at right now**. `1 match` is safe to use as-is; a candidate reporting more says so, with the warning that `find` always resolves to the first one in depth-first order — the panel does not hide that ambiguity, because it is exactly what a script author cannot see from outside.
4. Press **Test on device** to run the real `Inspector.find` before you trust the count — the tree can be a few seconds old if the screen has scrolled since the dump.
5. Press **Copy** — it produces a ready-to-paste line, e.g.:

   ```ts
   await ctx.device.tap({ id: 'feed_action' })
   ```

   Paste it into `prepare`/`run`/`finish` and swap `tap` for `find`/`waitFor` as needed.

Two things the panel is explicit about, because scripts get bitten by them silently otherwise:

- `{ text }` and `{ desc }` compare **exactly**, after trimming — `{ text: 'Follow' }` never matches "Following".
- `{ point }` never touches the inspector: it is a synthetic coordinate, always "truthy", and can never be used as an existence check. The panel offers it last, and only as a fallback when nothing else on the node has a usable id, description, or text.

## When no selector reaches it

Four shapes cannot address everything, and no amount of extra shapes would. On whoer.net the node holding the exit IP carries a resource id and **no text at all** — the text lives on a child — while the hostname beside it reads `FAST-INTERNET-103-186-169-250.solnet.net.id`: the same address with dashes for dots. Nothing selector-shaped reads that; ordinary TypeScript over the tree does.

So a script can ask for the tree the Inspect panel is showing it:

```ts
const tree = await ctx.device.dump()
```

It returns the same `UiNode` root, children and all. **It costs 334–584 ms** (a `find` is around 80 ms), so fetch it once per screen and walk the result rather than calling it per assertion.

`find` is the other half of the same honesty: a selector that only resolves to a viewport-sized container now returns `null` instead of a node whose centre is the middle of the page. If a `find` you expected to work starts coming back empty, the job log says which selector was rejected and what it matched — dump the tree and look.

A node-owned (cloud) device has no local inspector to attach to yet — the tab says so and stays disabled there; copy-paste from a locally enrolled device of the same build in the meantime.
