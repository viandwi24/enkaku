# Plan 70 — M35 : An Agent That Can Actually See

> Status: implemented — `packages/core/src/agent/blob/store.ts` (`createBlobStore`, `sha256:<hex>` content addressing, `sniffImageMediaType`/`parseImageDimensions` for PNG/JPEG/WebP/GIF from a few dozen header bytes, no codec) backed by a new `agent_blobs` table (`db/schema.ts`, migration `0035_cloudy_lightspeed.sql`). Protocol (`packages/protocol/src/messages/agent.ts`): `AgentImageRefSchema`/`AgentImageMediaTypeSchema`, `ToolResultContentSchema = text | image`, `AgentToolResultBlockSchema.content` is now `ToolResultContent[]` (never a string), `AgentContentBlockSchema` gains the image variant so a user message can carry one, `PostThreadMessageInputSchema` becomes `{text: default(''), attachments?: string[]}` refined to require one or the other, `AgentBlobInfoSchema` for the upload response; `AgentDefaultsSchema`/`AgentSettingsSchema`/`ResolvedAgentConfigSchema`/`resolveAgentConfig` gain `maxImagesPerRequest` (default 10) and `maxImageBytes` (default 5 MiB). The lossless migration (`db/migrations/tool-result-content-blocks.ts`, marker `tool-result-content-blocks-70`, wired into `daemon.ts` right after `runMigrations`) rewrites every pre-existing `tool_result.content: string` to `[{type:'text', text}]` — guarded, idempotent, and it runs BEFORE any code reads a message through the new Zod shape. `capability/types.ts` adds `ImageOutputDeclaration`/`imageOutputs?` to `CoreCapability`/`AnyCoreCapability`; `registry.ts`'s boot check (`assertImageOutputsExist`) fails the boot, naming the capability and the field, when a declared `dataField`/`mediaTypeField` is absent from the capability's own `output` schema shape, or when an entry names neither a fixed `mediaType` nor a `mediaTypeField` — `device.screenshot` (`capability/device-inspect.ts`) declares `imageOutputs: [{dataField: 'image', mediaType: 'image/png'}]`. The loop (`agent/loop/run.ts`): `buildToolResultContent` decodes each declared field's base64, refuses `E_IMAGE_TOO_LARGE` (naming the actual size and the cap) or `E_IMAGE_TYPE_MISMATCH` (sniffed bytes vs. declared type) as an error `tool_result` with the run continuing and nothing stored, else stores via the blob store (dedup free), strips the field from the JSON with a marker string, and emits `[{type:'text', ...}, {type:'image', ...}]`; `toProviderMessages` maps a stored image ref to an UNRESOLVED provider image block (`blobId` only, no base64). `agent/loop/request.ts`'s new `resolveImagesForRequest` (called from `buildProviderRequest` before `sanitizeMessages`, always last) is where base64 is materialised — the ONLY place — walking the whole window oldest-to-newest, keeping the newest `maxImagesPerRequest` and replacing everything older with a text placeholder naming the media type and dimensions. `provider/types.ts` gains `ProviderImageBlock`/`ProviderToolResultContentBlock`; `provider/anthropic.ts` maps a resolved image block to `{type:'image', source:{type:'base64', media_type, data}}` (throws loudly if a block somehow reaches it still unresolved) for both a top-level user attachment and inside a `tool_result`. `compaction.ts`'s `textOf` renders an image as `[image, <mediaType>]` in a summary transcript, never inlining base64. The blob API (`api/blobs.ts`, `createBlobRoutes`, mounted at `/api/v1/blobs` in `server/http.ts`/`daemon.ts`): `POST /` accepts a raw body or a multipart `file` field, sniffs (never trusts `Content-Type`), refuses non-images (415) and oversized bodies (413, checked against `Content-Length` AND the actual byte count), audits as `agent.blob.upload`; `GET /:id` serves the sniffed type with `nosniff`, an immutable long-lived cache header, and `Content-Disposition: attachment` for anything outside the four-type allowlist (defensive — nothing this store can produce today is outside it), 404 on an unknown id. `agent/runner.ts`'s `postMessage` gained an `attachments?: string[]` parameter — `attachmentBlocks` turns each into a stored-blob-referencing `AgentImageRef`, refusing the WHOLE message (not silently dropping one picture) if an id does not resolve; `RunnerDeps.blobs` threads a shared `BlobStore` into every `executeRun` call. Studio: `lib/agent-transcript.ts` replaces the old JSON-string `parseScreenshotResult` with `findImageBlock`/`textOfToolResult`/`blobUrl`/`computeImageInContext` (a client-side approximation of the loop's own window, default 10, since the messages endpoint carries no per-agent budget — a recorded gap, not filled); `ToolCallCard` renders `<img src={blobUrl(...)}>` and marks `inContext === false` with an explicit "no longer see this screen" note (§3.7); `Transcript`'s composer gained a paste/pick attach button, thumbnails with a remove control and a KB size, an upload-failure message, and sends `{text, attachments}` with `text` no longer required. `bun run typecheck` is green across all 11 packages (`bash scripts/typecheck.sh`); `bun test` is 2147 pass / 0 fail (baseline 2091 + 56 new, zero regressions) — the criterion-1 integration test (`run.test.ts`) asserts BYTE-EQUALITY between the source PNG and what the fake provider actually received after a full round trip through storage, windowing, and base64 resolution, not a shape check. No real Anthropic API call is made anywhere in the test suite. **Deviations, recorded rather than silent:** (1) the plan attributes image resolution/windowing to `request.ts` alone; the UNRESOLVED-image-block construction (which needs the stored `AgentImageRef`'s `blobId`/`mediaType`) stays in `run.ts`'s `toProviderMessages` as the plan's own pseudocode groups it, with only the resolve-and-window step itself (`resolveImagesForRequest`) living in `request.ts` — the two files divide the work at the boundary between "stored shape → provider shape" and "provider shape → wire shape," which is where every other responsibility in this pair already splits. (2) the dropped-image placeholder names the media type and dimensions (`[image dropped from context — image/png, 1080×2400, over the per-request image budget]`) rather than a device id and a timestamp as the plan's own illustrative example shows — `ProviderMessage` carries neither (no `createdAt`, no device attribution) by the time the window step runs, and threading them through would touch every `ProviderContentBlock` consumer for a display nicety; the stored transcript (which DOES have both) is what Studio's own "not currently in context" marking reads instead. (3) Studio's "in current context" marking is a client-side approximation (`computeImageInContext`, default `maxImagesPerRequest: 10`) rather than the authoritative figure, because no endpoint exposes a thread's resolved agent config alongside its messages — the same class of gap Plan 69's own status header recorded three times over rather than adding a new endpoint outside this plan's scope. (4) `agent.blob.upload` is a new `AuditAction` (`auth/audit.ts`) — the plan's §4.6 implies auditing every write path but does not enumerate this one specifically.
> Ships: packages/core/src/agent/blob/store.ts
> Depends on: Plans 63 (capabilities), 66 (the loop), 69 (the transcript that renders images).
> **Work this first.** Until it lands, the single most important thing a device-farm agent does — look at a phone — does not work at all.
> Spec references: §7.1 (display sources), §11.3.

---

## 1. Goals

- A screenshot reaches the model **as an image**, not as base64 text.
- A person can **attach an image** to a message they send an agent.
- Images are stored **once**, content-addressed, and referenced — never inlined into every message row and never pushed as base64 over `/ws`.
- An image too large for the provider is **refused by name**, never silently truncated or silently dropped.

## 2. Non-goals

- Server-side image resizing. §3.3 shows why it is an optimisation and not a prerequisite, and why adding a native image dependency to the core is a stack decision that needs its own case.
- Video, audio, or PDF input.
- Letting an agent read an arbitrary image out of the workspace as a vision input. `fs.read` returns bytes; making every file a potential vision payload is a separate decision with its own injection surface (§9.2).
- Changing what `device.screenshot` captures.

## 3. Context and design decisions

### 3.1 The defect, exactly

`packages/core/src/agent/loop/run.ts:389`:

```ts
if (result.ok) appendToolResult(call.id, JSON.stringify(result.output), false)
```

and `packages/protocol/src/messages/agent.ts:28-33`:

```ts
export const AgentToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),          // ← a tool result can only ever be text
  isError: z.boolean().optional(),
})
```

`device.screenshot` returns `{ image: '<base64 png>', format: 'png' }` (`capability/device-inspect.ts:104`). `JSON.stringify` turns that into a string of roughly 1.4 million base64 characters, and the model receives it as prose. It cannot see anything. It gets noise, and the request very likely fails outright on size before it even gets the chance.

Every test passed because the fake provider never inspects what it is handed. This is the exact failure mode the series was warned about in its own overview: a green suite that says nothing about whether the thing works.

### 3.2 A tool result carries blocks, not a string

`content: z.string()` becomes `content: z.array(ToolResultContentSchema)` where a block is text or an image reference. Everything that walks messages — `sanitizeMessages`, `compaction`, the Anthropic adapter's mapper (`provider/anthropic.ts:61-64`), the transcript — follows.

This is a **breaking change to a stored shape**, so it needs a migration, and the migration must be lossless: every existing `content: string` becomes `[{type: 'text', text: <the string>}]`. Old rows stay readable and no run's history is lost.

### 3.3 The token arithmetic, corrected

It is worth writing down because the wrong number leads to the wrong design.

| Path | Cost of one 1080×2400 screenshot |
|---|---|
| today, base64 as text | ~1.4 M characters ≈ **350,000+ tokens** — exceeds most context windows in one call |
| as a proper image block | (1080 × 2400) / 750 ≈ **3,456 tokens** |

So fixing the block type is not merely correctness, it is a hundred-fold cost reduction, and it removes the reason to resize before shipping. Anthropic downsamples anything over ~1568px on the long edge server-side, and the hard limit is 5 MB per image; a `screencap -p` PNG is typically well under that.

Resizing would still help — it would cut the ~3.5k further — but it needs an image codec, the core has none (no `sharp`, no `jimp`, and Bun ships no canvas), and adding a native dependency to the core is a stack change. Deferred with the reasoning recorded (§9.1), not silently skipped.

**What must not be deferred is the limit.** An image over the provider's cap fails with `E_IMAGE_TOO_LARGE` naming the actual size and the cap, delivered as an error `tool_result` so the run continues and can say so. A silently dropped image would make an agent confidently describe a screen it never saw — the same class of lie Plan 60 exists to prevent.

### 3.4 Images are stored once, by hash

Inlining base64 into `agent_messages.content` would put a megabyte into every row, repeated for every screenshot of a screen that did not change, and would push that megabyte over `/ws` to every subscriber.

So: a content-addressed blob table. A message holds a reference; the bytes live once.

```ts
{ type: 'image', blobId: 'sha256:…', mediaType: 'image/png', bytes: 184_320, width: 1080, height: 2400 }
```

Four things fall out of content addressing, all of them wanted:

- **Dedupe is free.** An agent screenshotting an unchanged screen five times stores one blob. On a fleet this is the difference between megabytes and gigabytes.
- **`/ws` stays small.** Subscribers get the reference; Studio fetches `GET /api/v1/blobs/:id` and the browser caches it by URL, immutably, because a hash-named resource can never change.
- **The provider view is rebuilt on demand.** Base64 is produced when the request is assembled, never stored.
- **Retention is tractable.** A blob with no referring message is collectable, and reference counting is a query rather than a scan of JSON.

Width and height are stored because the token cost is a function of them, so §3.6's budgeting needs them without decoding anything.

### 3.5 A person can attach an image

`PostThreadMessageInput` is `{ text: z.string().min(1) }` today. It becomes text plus optional attachments, and `min(1)` goes — a message that is only an image is legitimate ("what is wrong with this screen?").

Upload is `POST /api/v1/blobs` returning `{ blobId, mediaType, bytes, width, height }`, then the message references it. Two steps rather than one multipart body, because it lets the composer show a thumbnail and a size before anything is sent, and because a retried send does not re-upload.

Accepted: `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Rejected by **sniffing the magic bytes**, not by trusting the declared `Content-Type` or the filename — a client-declared type is an assertion, and the store must not hold an executable that a browser will later be asked to render.

`GET /api/v1/blobs/:id` serves with the sniffed type, `Content-Disposition: attachment` for anything not on the allowlist, `X-Content-Type-Options: nosniff`, and a long immutable cache header.

### 3.6 Images have a budget, and old ones leave the view first

Vision is cheap per image and expensive in aggregate: twenty screenshots in one run is ~70k tokens of pictures the model has mostly finished with.

Two bounds, both per resolved agent config, both farm-defaulted:

| Setting | Default | Meaning |
|---|---|---|
| `maxImagesPerRequest` | 10 | images kept in the provider view; **oldest dropped first** |
| `maxImageBytes` | 5 MiB | per image, matching the provider cap |

A dropped image is replaced in the view by a text block saying what it was and when — `[screenshot of device ZP2222RMBS at 14:32, dropped from context]` — so the model knows a picture existed rather than silently losing the fact. The stored message is untouched; this is a view, exactly as compaction is (Plan 66 §3.5).

Dropping images before summarising text is deliberate: images are the largest and the least often still relevant.

### 3.7 What the model sees is what the operator sees

The transcript already renders `device.screenshot` inline (Plan 69 §3.2), reading base64 out of the tool result. It changes to render `<img src="/api/v1/blobs/:id">`, which is smaller, cached, and correct.

An image dropped from the provider view under §3.6 must be marked in the transcript as *not currently in the agent's context* — otherwise an operator looking at a screenshot the model can no longer see will misread every answer that follows.

## 4. Technical design

### 4.1 Storage

```ts
export const agentBlobs = sqliteTable('agent_blobs', {
  /** `sha256:<hex>` — the id IS the hash, so a blob is immutable by construction. */
  id: text('id').primaryKey(),
  mediaType: text('media_type').notNull(),
  bytes: integer('bytes').notNull(),
  width: integer('width'),
  height: integer('height'),
  data: blob('data').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
```

Migration for `agent_messages.content`: every `tool_result` block's `content: string` → `[{type: 'text', text}]`, guarded by a `migration_markers` row (the Plan 22.0 pattern used by 62 and 68). Lossless and idempotent.

### 4.2 Protocol

```ts
export const AgentImageRefSchema = z.object({
  type: z.literal('image'),
  blobId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
})

export const ToolResultContentSchema = z.discriminatedUnion('type', [AgentTextBlockSchema, AgentImageRefSchema])

export const AgentToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.array(ToolResultContentSchema),
  isError: z.boolean().optional(),
})
```

`AgentContentBlockSchema` gains `AgentImageRefSchema` so a **user** message can carry one too. `PostThreadMessageInputSchema` becomes `{ text: z.string().default(''), attachments: z.array(z.string()).max(10).optional() }` with a refinement that at least one of the two is non-empty.

### 4.3 The registry declares which outputs are images

A capability whose output contains image bytes says so, rather than the loop pattern-matching on a field called `image` — which would be exactly the "decide by sniffing" mistake Plan 63 §3.3 rejected.

```ts
/**
 * Fields of `output` that hold base64 image bytes, with the field naming the
 * media type. The loop turns each into a stored blob and an image block; a
 * capability that does not declare this has its output serialised as text.
 */
imageOutputs?: { dataField: string; mediaTypeField?: string; mediaType?: string }[]
```

`device.screenshot` declares `[{ dataField: 'image', mediaType: 'image/png' }]`. Nothing else does today. The boot-time registry check (Plan 63 §4.2) asserts every declared `dataField` actually exists in the output schema — a typo here would silently fall back to text, which is the bug this plan exists to fix.

### 4.4 The loop

`run.ts`'s tool-result path becomes:

```
if the capability declares imageOutputs:
  for each declared field:
    decode base64 → bytes
    over maxImageBytes → error tool_result E_IMAGE_TOO_LARGE naming size and cap; run continues
    sniff magic bytes; a mismatch with the declared type is an error tool_result
    store (hash, dedupe) → blobId
    replace the field in the JSON with a marker, so the base64 is never also in the text block
  content = [{type:'text', text: <output minus the image fields>}, {type:'image', ...}]
else
  content = [{type:'text', text: JSON.stringify(output)}]
```

Emitting both the stripped JSON *and* the image matters: `device.screenshot`'s output also carries `format`, and a future capability may return a picture alongside data the model needs.

`request.ts` resolves blob references to base64 when assembling, applies §3.6's window, and inserts the placeholder text for anything dropped. `sanitize.ts` gains no new rule but must not treat an image-only tool result as empty (§6.9).

### 4.5 Provider

`ProviderContentBlock` gains an image variant; `anthropic.ts:61` maps it to `{ type: 'image', source: { type: 'base64', media_type, data } }`.

`countTokens` gets the real figure from the provider, so §3.6's window is enforced against the truth rather than the `(w × h) / 750` estimate — the estimate is for the UI only, and is labelled as an estimate where it is shown.

### 4.6 API and Studio

- `POST /api/v1/blobs` (multipart or raw body), `GET /api/v1/blobs/:id`. Permission `agent.run` to write, `agent.view` to read.
- The composer gains a paste-and-drop attach area, thumbnails with a remove control, the size in a human unit, and a refusal that names the reason.
- The transcript renders `<img>` from the blob URL, and marks an image no longer in the agent's context (§3.7).

## 5. Implementation steps

**70.1 — Blob store** (§4.1): hashing, dedupe, magic-byte sniffing, PNG/JPEG/WebP/GIF dimension parsing from the header. Pure and fully tested first; everything else trusts it.

**70.2 — Protocol shapes and the lossless migration** (§4.1, §4.2).

**70.3 — `imageOutputs` on the registry** plus the boot assertion (§4.3); `device.screenshot` declares it.

**70.4 — Loop: store, strip, emit blocks** (§4.4), including both refusals.

**70.5 — Request assembly**: resolve, window, placeholder (§3.6, §4.4).

**70.6 — Provider mapping and real token counts** (§4.5).

**70.7 — Blob API** (§4.6), with the response-header rules.

**70.8 — Composer attachments and transcript images** (§4.6, §3.7).

## 6. Acceptance criteria

1. `device.screenshot`'s result reaches the provider as an **image block**, and its base64 appears nowhere in any text block of the request.
2. Two identical screenshots store **one** blob row; the second reuses the first's id.
3. An image over `maxImageBytes` produces an error `tool_result` naming the actual size and the cap; the run **continues**; no blob is stored.
4. A payload whose magic bytes disagree with its declared media type is refused; nothing is stored.
5. `agent_messages.content` from before this plan still renders, and its text is unchanged — the migration is lossless and running it twice changes nothing.
6. With more than `maxImagesPerRequest` images in a thread, the **oldest** are dropped from the request and each is replaced by a placeholder naming what it was; the stored messages are untouched.
7. `/ws` never carries base64 image bytes — a subscriber receives a blob reference.
8. `GET /api/v1/blobs/:id` returns the sniffed media type, `nosniff`, and an immutable cache header; an unknown id is 404.
9. A tool result containing only an image is **not** dropped by `sanitizeMessages` as empty.
10. A user can send a message that is an image with no text, and the model receives it as an image.
11. A capability declaring `imageOutputs` with a field absent from its output schema **fails the boot**, naming the capability and the field.
12. The transcript renders images from the blob URL, and marks any image no longer in the agent's context.
13. `bun run typecheck` passes; `bun test` is green.

## 7. Test plan

**Unit — blob store:** hashing and dedupe; magic bytes for all four types plus a mismatch and a truncated header; dimension parsing per format; a zero-byte body.

**Unit — migration:** a `content: string` tool result becomes one text block with identical text; an already-migrated row is untouched; the marker makes it idempotent.

**Unit — loop:** a declared `imageOutputs` field becomes a blob and an image block **and is removed from the text**; an undeclared capability serialises as text; both refusals; a run continuing after each.

**Unit — request assembly:** the window keeps the newest N; placeholders name what was dropped; base64 is materialised only at assembly and never stored.

**Integration (fake provider):** a screenshot tool call end to end, asserting the provider received an image block whose bytes round-trip to the original PNG — this is the whole point of the plan and gets an explicit byte-equality assertion, not a shape check.

**Device-gated (`ENKAKU_TEST_DEVICE=1`):** a real `device.screenshot` against hardware, asserting a stored blob whose dimensions match the device's real resolution.

**Manual smoke:**
```bash
bun run dev && bun run dev:studio
# 1. ask an agent to screenshot a device and describe it — the description must match the screen
# 2. ask again without changing the screen → a second blob row must NOT appear
# 3. attach a picture in the composer and ask what it shows
# 4. take 12 screenshots in one thread → the request carries 10 and two placeholders
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A model still cannot see the screen after this lands, for some other reason. | §7's integration test asserts byte-equality of what the provider received against the source PNG, and the device-gated test asserts real dimensions. Neither can pass on a text path. |
| The blob table grows without bound. | Content addressing dedupes the common case (an unchanged screen), and reference counting makes collection a query. GC itself is §9.3 — deliberately not invented here, but the schema does not preclude it. |
| Base64 sneaks back into a text block and doubles every request. | Criterion 1 asserts its absence in the request, and §4.4 strips the field rather than merely adding a block beside it. |
| Attachment upload becomes a file-drop endpoint for arbitrary content. | Magic-byte sniffing (§3.5), a four-type allowlist, a size cap, `agent.run` permission, and `nosniff` plus attachment disposition on read. |
| A dropped image makes the model answer about a screen it cannot see. | The placeholder states plainly that an image was dropped and when (§3.6), and the transcript marks it too (§3.7) so the operator reads the answer correctly. |

## 9. Open questions

1. Server-side downscaling. It would cut the per-image cost further and needs an image codec the core does not have. The cleanest route may be capturing at a lower resolution on the device rather than resizing on the host — `scrcpy` already downscales, and Plan 24's stream lane already carries its frames.
2. Should `fs.read` on an image return a vision block? Convenient, and it turns every file an agent can read into a potential vision payload. If it lands it should be an explicit `fs.readImage`, not a widening of `fs.read`.
3. Blob garbage collection. Reference counting makes it easy; nothing collects yet. It belongs with artifact retention (Plan 09) rather than here.
