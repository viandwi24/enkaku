# Plan 113 — M78 : A TikTok video actually gets posted

> Status: draft — written 2026-08-18 from a hardware walk of the real upload flow (2026-08-17, moto g06 power `ZP2222RMBS`, Android 15 / API 35, `com.ss.android.ugc.trill`, locale id-ID) and a re-read of the plugin runtime as it stands after plans 108–112. Nothing here is built. The walk is recorded in §0.2 because the selectors it found are the plan's actual substance: every screen, every blocking modal, and the two traps (`ambiguous` selectors, an inspector that cannot see an animated screen) were observed on the device, not inferred from the app. **One correction this plan makes to the code it extends:** `post-video.ts`'s own doc comment says posting cannot be built because `ctx.device.push()` takes an `artifactId` rather than a path. That reason no longer holds and probably never did — `resolveArtifact` accepts any artifact row, including the ownerless ones `POST /api/artifacts` creates, and §0.2's walk pushed one and saw it in TikTok's picker. The real blockers were, and mostly still are, elsewhere.
> Depends on: Plan 108 (M73) — the manifest, `plugin.data`, the surface and its actions. Plan 109 (M74) — `defineService`, `ctx.farm` and the capability broker, without which a script still could not read the workspace. Plan 79 (M44) — the KV store this plan makes a work queue. Plan 39 (M?) — the artifact store, its upload route, and `device.push`. Plan 95 (M60) — `SchemaForm`, whose union handling dictates this plan's parameter shape (§3.2).
> Deliberately does NOT depend on: the workspace as a media store. §3.1 is the ruling that media stays in artifacts, and every gap that follows from it is recorded in §0.4 rather than closed here.
> Spec references: §11.6 (plugins), §12 (data model — `artifacts`, `kv_entries`), §19 (Studio screens)
> Ships: plugins/tiktok-automation-pack/src/modals.ts

---

## 0. Evidence

### 0.1 What exists today

`plugins/tiktok-automation-pack/src/post-video.ts` is 91 lines that declare three parameters (`videoFolder`, `captionsFile`, `captionPick`), log what they would have been used for, and return `{ posted: false }`. Its title is `'Post a video (not implemented)'`. It was built during plan 108 step 108.11 to prove the two workspace path parameter kinds end to end, and it is honest about being a declaration — the problem is that two of its three parameters point at a place that structurally cannot hold a video.

The pack is at version `1.7.0` with five members (`switchAccount`, `searchFollow`, `listAccounts`, `postVideo`, `autoScrollScript`) and one surface view (`accounts`). It declares **no service**, which matters for §3.7.

### 0.2 Confirmed findings — the hardware walk

Every row was observed on the device on 2026-08-17. Nothing was published; the run stopped at the Post button and discarded the draft.

| # | Finding | Evidence |
|---|---|---|
| **E1** | **The media chain already works end to end.** A 71 KB mp4 uploaded through `POST /api/artifacts` (201, ownerless row), pushed with `device.push` to `/sdcard/DCIM/Camera/`, appeared as the first cell of TikTok's own gallery picker. | `{"mediaScan":{"ran":true,"method":"scan_file","ms":1586}}`, then the file visible in the picker |
| **E2** | **`resolveArtifact` does not check ownership.** Any artifact id pushes, including one no job or device owns. This is what makes E1 possible with no core change. | `packages/core/src/device/transfer.ts:142` |
| **E3** | **The inspector cannot see the feed.** `device.dump` returned `E_DEADLINE` at 15 s on three consecutive attempts and `device.find` at 10 s; the same calls on every static screen answered in well under a second. The feed plays video continuously, so the accessibility layer never reaches idle. | three retries, same session |
| **E4** | **Five distinct modals appeared in one pass**, three of them system `permissioncontroller` dialogs with stable Android ids, two of them TikTok's own with no ids at all. | §4.2's table |
| **E5** | **Permission dialogs arrive queued.** Denying camera returned straight into the microphone prompt. A one-shot sweep clears one and walks into the next. | consecutive screenshots |
| **E6** | **One dialog must be ALLOWED, not denied.** `permission_allow_all_button` on "Izinkan TikTok mengakses foto dan video di perangkat ini?" is the whole flow; `DENY_SELECTORS` matches "Jangan izinkan" on that same dialog and would make the gallery permanently unreachable — silently, with no error. | `dialogs.ts:21-29`, and the dialog's own dump |
| **E7** | **A denial is re-litigated every run.** After the flow returned to a camera-capable screen, Android asked for camera again. A denied permission is not a remembered decision. | observed on the discard path |
| **E8** | **TikTok's in-app camera/mic wall is not blocking.** The gallery button underneath stays live and carries `upload_hot_area` — one of only seven readable ids in the whole flow. | dump of the wall screen |
| **E9** | **`find` refuses an ambiguous match, and the upload flow produces one.** On the preview screen the picker is still in the window stack, so two nodes read "Berikutnya". | `find { text: 'Berikutnya' } → { ok: false, reason: 'ambiguous', matches: 2 }` |
| **E10** | **TikTok's own view ids are obfuscated** (`pfc`, `pfm`, `gya`, `sp3`, `g9g`, `wz7`, `j_f`, `gge`, `x7f`) and will change with the app. The exceptions, and the only ids worth anchoring on, are `upload_hot_area`, `viewpager_choose_media`, `video_image_mixed_bottom_view_root`, `video_record_new_scene_root`, `tv_title`, `tv_top_text`, `tv_quick_publish`. | dumps of all six screens |
| **E11** | **`tv_title` reads the picker's sort order** ("Terbaru" = newest first), and each cell carries its duration as text. Together they are what makes "tap the first cell" a checkable claim rather than a guess. | picker dump |
| **E12** | **TikTok auto-attaches a soundtrack** on the editor screen, named in `tv_top_text`. A posted video gets a sound whether or not the author chose one. | editor dump — "Beetle Protocol" |
| **E13** | **`device.type` fills the caption correctly**, and opening the keyboard moves Post to the top right while the bottom bar is covered. | typed caption, screenshot |
| **E14** | **Leaving the editor raises its own modal** — "Buang" / "Simpan draf", text-only, no ids. | dump of the exit modal |

### 0.3 Confirmed findings — the code, after plans 108–112

| # | Finding | Evidence |
|---|---|---|
| **C1** | **`ScriptContext` now extends `PluginContext`.** A member script has `ctx.storage`, `ctx.log` and `ctx.farm` in addition to what it always had. This is the single change that makes this plan different from the one that could have been written a week ago. | `packages/sdk/src/types.ts:400`, `packages/sdk/src/runtime.ts:134` |
| **C2** | **`ctx.farm.call('fs.read', …)` is how a script reads the workspace.** There is still no `ctx.fs`; the capability broker is the door, and `fs.list`/`fs.read`/`fs.grep` are all in the registry. | `packages/core/src/plugins/farm-broker.ts`; capability ids enumerated 2026-08-18 |
| **C3** | **A capability must be declared in `defineService({ permissions })` or it is refused before it runs** — `E_FARM_UNDECLARED`, audited, `invoke()` never entered. The pack declares no service at all, so today every `ctx.farm` call from it is refused. | `farm-broker.ts:262-275` |
| **C4** | **A plugin's authority is its publisher's, resolved live.** A capability the publishing user's role does not hold is refused at call time regardless of the manifest. | `farm-broker.ts` `roleOf` |
| **C5** | **A dev slot has no `ctx.farm` at all** until the plugin has been published once — `E_FARM_NO_PLUGIN`. This is a known, documented gap in step 109.3, and it directly affects how this plan is developed. | `farm-broker.ts` header, "Known gap" |
| **C6** | **There is no artifact capability of any kind.** The registry has `device.*`, `fs.*`, `files.*`, `job.*`, `script.*`, `agent.*`, `skills.*`, `notify.send` — nothing that lists, reads or creates an artifact. A script still cannot discover an artifact it was not handed. | capability ids enumerated 2026-08-18 |
| **C7** | **`ctx.kv` and `ctx.storage` are the same object**, the former kept as a compiled-in alias for already-published bundles. New code writes `ctx.storage`. | `packages/sdk/src/types.ts:408-419` |
| **C8** | **`job.run` is a capability**, so a plugin *service* can enqueue jobs on its own clock. Auto-posting does not need the farm's schedules subsystem. | capability registry; `PluginServiceContext` |
| **C9** | **`PARAM_KINDS` has no `artifact` entry**, so no run form can render an artifact picker — though Studio already ships `ArtifactPicker` with upload and browse tabs, wired to `GET /api/artifacts?kind=upload`. | `packages/protocol/src/schema/vocabulary.ts:38-52`; `packages/studio/src/components/ArtifactPicker.tsx` |
| **C10** | **A multi-branch union renders as a raw JSON textarea.** `planField` row 15: `anyOf`/`oneOf` with several real branches falls back to `json`. A discriminated union over "queue vs direct" would hand the operator a JSON blob. | `packages/studio/src/components/schema-form/plan.ts:43` |
| **C11** | **`ctx.storage` has compare-and-swap.** `setIfVersion(key, value, expectedVersion)` returns `null` when the version moved, which is what lets several devices share one queue without two of them claiming the same video. | `packages/sdk/src/types.ts` `KvApi` |
| **C12** | Quotas: KV is 64 KiB per value, 1 000 entries per namespace, 5 000 per device. Artifact upload is capped at 1 GiB; `transfer.maxPushBytes` defaults to 512 MiB. | `packages/protocol/src/settings.ts`; `packages/core/src/api/artifacts.ts:32` |

### 0.4 The gap register

Checked against the running core on 2026-08-17 and re-checked against the source on 2026-08-18. **G4 closed in between** — plan 109's broker shipped.

| # | Gap | Status | Evidence |
|---|---|---|---|
| **G1** | Video cannot live in the workspace — 1 MiB per file, 64 MiB per scope, and the store is a SQLite table that never touches `node:fs`. | open, **and not closed by this plan** (§3.1) | `fs.write` of 1.5 MB → `413 E_QUOTA` |
| **G2** | No binary path into the workspace at all: `fs.write` takes `content: string`, the workspace has no HTTP route of its own, and Studio's workspace page has no file input. | open, out of scope | `packages/studio/src/lib/workspace.ts:57` |
| **G3** | Nothing bridges a workspace file to a device — `device.push` resolves an `artifactId` and nothing else. | open, out of scope | `transfer.ts:142` |
| **G4** | ~~A script cannot read the workspace.~~ | **CLOSED by plan 109** — `ctx.farm.call('fs.read', …)`, subject to C3/C4/C5 | C2 |
| **G5** | A script cannot discover an artifact: `ctx.artifact.file()` returns `void` and no capability lists the store. | open — §3.3 routes around it | C6 |
| **G6** | No `artifact` param kind, so an operator pastes a UUID into the run form. | open — §5 step 113.9 proposes closing it | C9 |
| **G7** | `device.push` returns `{ mediaScan: { ran, method, ms } }` and discards the MediaStore id / `content://` URI that `scan_file` prints. "Did it reach the gallery" is unanswerable from the core, and the far more deterministic share-intent route is unavailable. | open — §9 Q3 | `transfer.ts:227-244` |
| **G8** | Nothing deletes a file from a device. `DeviceApi` has no shell and no remove; `pull` throwing is the only existence probe and it transfers the whole file to find out. | open — §3.8 states the consequence | `packages/sdk/src/types.ts` `DeviceApi` |
| **G9** | The selector grammar cannot disambiguate — no nth, no within-subtree, no topmost-only. | open — §3.5 works around it | E9 |
| **G10** | The inspector is blind on animated screens and the capability deadline is not overridable per call. | open — §3.5 works around it | E3 |
| **G11** | A control lease can only be acquired over `/ws`, expires in five minutes, and has no REST equivalent. | open, affects tooling only | observed while walking the flow |

---

## 1. Goals

1. **A TikTok video is actually posted from a video the operator supplied**, on a real device, end to end.
2. **Two ways to supply the work, one member**: name a video and a caption directly, or take the next item from a queue.
3. **A blocking modal does not end the run.** A named register decides what happens to each known dialog, and an unknown one stops the run loudly rather than being guessed at.
4. **`posted: true` is earned.** The result says `true` only when something other than "the button was tapped" confirms it.
5. **Several devices can share one queue** without two of them posting the same video.
6. **The caption can come from a workspace file**, now that G4 is closed — as one source among several, not as the only one.
7. **Every limit this plan runs into is written down** where the next person will look, rather than rediscovered.

## 2. Non-goals

- **Making the workspace a media store.** G1/G2/G3 stay open. §3.1 is the ruling.
- **Deleting the posted video from the device.** G8 makes it impossible through the sanctioned API, and reaching around it is worse than leaving the file (§3.8).
- **Recording video, using the camera, or anything that needs the camera permission.** This plan denies it and stays on the gallery path.
- **Choosing or removing the soundtrack TikTok attaches** (E12). Observed, recorded, left to a later pass — it is a content decision, not a mechanism.
- **A general "app modal registry" for every pack.** The register built here is TikTok's. Generalising it before a second pack needs it would be inventing a shape from one example.
- **Scheduling policy** — jitter, per-account pacing, shadowban avoidance. The service in 113.10 enqueues; how often is a setting, not a design.
- **Multi-video posts, photo posts, drafts, or Story.** One video, one caption, one post.

---

## 3. Context and design decisions

### 3.1 Media lives in artifacts. The workspace stays a code store.

The tempting reading of `post-video.ts` is that its `videoFolder` parameter is nearly right and just needs the quota raised. It is not nearly right. The workspace is a SQLite table whose store "NOTHING here ever touches `node:fs`" (its own header), whose reader returns a string, and whose quotas are sized for source. Making it hold video means raising `maxFileBytes` ~50×, streaming blobs out of SQLite, and giving the file manager a binary upload path it does not have — turning a code store into a media store to avoid using the media store that already exists.

The artifact store already is that: files on disk, a multipart upload route capped at 1 GiB, ownerless `kind: 'upload'` rows that list independently, and a push path that resolves them (E1, E2). **Decision: video is an artifact. `videoFolder` and its `workspaceFolder` kind are deleted from the member.**

`captionsFile` survives, because a captions file genuinely is text and genuinely belongs in a code store — and as of C2 a script can finally read it.

### 3.2 Two modes, one flat schema — because a union renders as JSON

The natural expression of "queue or direct" is a discriminated union. C10 forbids it: `planField` degrades a multi-branch union to a raw `json` textarea, so the operator would type the parameters as JSON by hand. The shape is therefore flat — a `source` enum plus optional fields — and the cross-field rule ("direct requires `videoArtifactId`") is enforced in `run()`, where it can produce a sentence instead of a schema error.

This is a deliberate concession to the renderer, and it is recorded here so that the day `planField` learns unions, this is a known thing to revisit and not an accident to preserve.

### 3.3 The queue is plugin storage, claimed with CAS

C6 means a script cannot ask the farm what videos exist. The queue is therefore not a listing of the artifact store — it is a list the plugin itself keeps, one KV entry per item, written by an operator through the plugin's own surface and read by the member.

That inversion is what makes the feature buildable now instead of after G5, and it is better on the merits anyway: a queue entry carries the caption, the status and the history alongside the artifact id, which a bare artifact listing never could.

Claiming is `setIfVersion` (C11). A device reads the queue, picks a candidate by the requested order, and writes `status: 'claimed'` with the version it read. A `null` return means another device won the race, and the loser picks the next candidate rather than failing — the run only fails when the queue is genuinely empty.

**Scope: `storage.global`, not `storage.device`.** A per-device queue is the degenerate case of a farm-wide one and would make "twenty phones, one content calendar" impossible. Plan 108 §3.1's rule — *if forgetting the device should forget the fact, it is device-scoped* — points the same way: forgetting a phone must not forget the video that was going to be posted on it.

### 3.4 The modal register is a table with policies, not two flat lists

`dialogs.ts` today is two closed allow-lists (`ACK_SELECTORS`, `DENY_SELECTORS`) and a BACK fallback, and its reasoning about why the lists are closed — never tap anything that grants, buys, subscribes or follows — is correct and is kept verbatim. What the walk broke is the assumption underneath: that clearing a dialog always means refusing it.

E6 is the counter-example. The media permission must be *allowed*, and a deny-everything sweep does not fail loudly there; it makes the gallery unreachable and leaves the run to fail later, somewhere else, for a reason that looks unrelated. So the register gains four things the lists do not have:

1. **Identity before action.** An entry matches the dialog's *message* (`permission_message`, or a text pair for TikTok's own), then names the button. Three of the five modals in §4.2 share an identical three-button layout and mean entirely different things.
2. **A policy per flow.** `allow` / `deny` / `ack` / `ignore` / `abort`, chosen by the caller. Denying the camera is right while uploading a file and wrong while recording one; the entry lists what is possible, the member states what it wants.
3. **A never-list no entry can override.** Nothing that grants beyond the named permission, buys, subscribes, follows, or accepts terms — the existing rule, promoted from a comment to a guard with a test.
4. **Provenance.** Which device, app version and locale each entry was confirmed on. Every string in §4.2 is Indonesian and none of it is proven anywhere else.

And one behaviour: **sweeping loops** (E5), with a bound, and an unknown blocking modal screenshots and aborts (goal 3) rather than pressing whatever single button it can see.

### 3.5 Anchors come from a dump, not from ids

E10 leaves seven usable ids across six screens. E9 makes the obvious text selectors refuse. E3 makes the inspector unusable on the feed. The honest implementation follows from those three facts, and it is not the pretty one:

- **On the feed, do not inspect.** Leave it by coordinate, derived from `screenW`/`screenH`, and inspect only once a static screen is reached.
- **On every other screen, `dump()` once and walk the tree** — matching by role and text within the subtree the anchor id identifies — rather than issuing N `find` calls that can each come back `ambiguous`. `dump` costs 334–584 ms on this device; the flow has six screens, so the whole run pays about three seconds for the thing that makes it survive an app update.
- **Anchor on the seven stable ids** to answer "which screen am I on", and use the walk for "which node do I tap".

### 3.6 `posted: true` has to be earned

Tapping Post is not evidence of a post. The upload can fail, the account can be blocked, the app can raise a modal after the tap. The result therefore has a three-state outcome, not a boolean claim dressed as one: the run reports what it *observed*. The confirmation step is §9 Q1 — it is the one part of this plan whose implementation is not yet decided, and it is not allowed to default to "we tapped it, so it worked". The pack already holds this line elsewhere (`proxy-manager`'s `reachable: false`, the network layer's `unverified`), and `CLAUDE.md` states it as a repo-wide rule.

### 3.7 The pack needs a service block it does not have

C3: `ctx.farm` refuses everything a plugin has not declared, and the declaration lives in `defineService({ permissions })`. The TikTok pack has no service. So even though the *only* thing this plan wants from the broker is `fs.read` (and later `job.run`), the pack has to grow a service block to ask for it.

That is not overhead to be routed around — it is the mechanism working. The list is what the operator is shown at install (plan 109 §4.1), and a pack that reads workspace files should have to say so. C4 and C5 are the two consequences worth stating in advance: the permission is still refused if the publishing user's role does not hold it, and **`enkaku dev` cannot exercise any of this until the pack has been published once**, which changes the development loop for 113.5 onward.

### 3.8 The video stays on the phone, and the plan says so

G8: nothing in the sanctioned API deletes a device file. A farm posting daily accumulates its own history on every phone's storage. Three options were considered and two rejected:

- **Reach around it** — a plugin service runs in the core process and can shell out. Rejected: it is exactly the "reaching around `ctx`" the broker's own header names as the unaudited path, and it would put an `rm` on a user's device outside the audit log.
- **Push to a path the device sweeps** — there is no such path that MediaStore also indexes.
- **Accepted: leave the file, and report its path in the result.** The run states what it left behind. Closing this properly means a `device.rm` capability, which is §9 Q4 and a plan of its own.

---

## 4. Technical design

### 4.1 The member's parameters and result

```ts
const params = z.object({
  source: z
    .enum(['queue', 'direct'])
    .default('queue')
    .describe('Where the video and caption come from.')
    .meta(ui({ title: 'Source', group: 'Source' })),

  // direct
  videoArtifactId: z
    .string()
    .optional()
    .describe('The uploaded video to post. Required when Source is "direct".')
    .meta(ui({ title: 'Video', group: 'Direct' })),
  caption: z
    .string()
    .max(2_200)
    .optional()
    .describe('The caption to type. Required when Source is "direct".')
    .meta(ui({ title: 'Caption', group: 'Direct' })),

  // queue
  pick: z
    .enum(['in-order', 'random'])
    .default('in-order')
    .describe('Which queued item to claim.')
    .meta(ui({ title: 'Order', group: 'Queue' })),
  captionsFile: z
    .string()
    .optional()
    .describe('A workspace text file, one caption per line — used only when a queued item carries no caption of its own.')
    .meta(ui({ title: 'Captions file', kind: 'workspaceFile', extensions: ['.txt'], group: 'Queue' })),

  privacy: z
    .enum(['leave', 'public', 'friends', 'private'])
    .default('leave')
    .describe('Leave the app\'s current setting, or state one explicitly.')
    .meta(ui({ title: 'Who can see it', group: 'Post' })),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Walk the whole flow and stop at the Post button without pressing it.')
    .meta(ui({ title: 'Dry run', group: 'Post' })),
})
```

`dryRun` is not a convenience. It is how this member is developed, how a new device is qualified, and how an app update is checked before it is trusted with a real account.

```ts
const result = z.object({
  outcome: z.enum(['posted', 'unverified', 'skipped', 'failed']).meta(ui({ title: 'Outcome', summary: true })),
  videoArtifactId: z.string().nullable(),
  caption: z.string().nullable(),
  queueKey: z.string().nullable().describe('The queue entry claimed, when Source was "queue".'),
  remotePath: z.string().nullable().describe('Where the video was left on the device — nothing removes it (G8).'),
  screens: z.array(z.string()).describe('The screens the run actually reached, in order.'),
  modalsHandled: z.array(z.string()).describe('Register entry ids that fired.'),
  reason: z.string().nullable().meta(ui({ title: 'Reason', summary: true })),
})
```

`outcome` is four states rather than a boolean because §3.6 needs to distinguish "we saw it published" from "we pressed Post and could not confirm". `skipped` is the empty-queue case, which is not a failure.

### 4.2 The modal register

```ts
export type ModalPolicy = 'allow' | 'deny' | 'ack' | 'ignore' | 'abort'

export interface ModalEntry {
  /** Stable, referenced by result.modalsHandled and by a member's policy map. */
  id: string
  /** How this dialog is RECOGNISED — never how it is dismissed. */
  match: { id?: string; textIncludes?: string[] }
  /** What each policy taps. A policy absent here cannot be chosen for this entry. */
  actions: Partial<Record<Exclude<ModalPolicy, 'ignore' | 'abort'>, Selector>>
  /** Where this was confirmed, so a future reader knows what it is worth. */
  seen: { device: string; app: string; locale: string; at: string }
}
```

The register, as walked:

| id | recognised by | upload policy | taps |
|---|---|---|---|
| `sys.camera` | `permission_message` ⊃ "mengambil gambar dan merekam video" | `deny` | `permission_deny_button` |
| `sys.microphone` | `permission_message` ⊃ "merekam audio" | `deny` | `permission_deny_button` |
| `sys.media` | `permission_message` ⊃ "mengakses foto dan video" | **`allow`** | `permission_allow_all_button` — never `permission_allow_selected_button` |
| `tt.camera-wall` | text ⊃ "mengakses kamera dan mikrofon Anda" | `ignore` | — |
| `tt.discard-draft` | text ⊇ {"Buang", "Simpan draf"} | caller's | "Buang" to abandon, "Simpan draf" to retry later |
| `tt.notice` | single button "Mengerti" / "Got it" | `ack` | the existing `ACK_SELECTORS` |

`permission_allow_selected_button` is listed in the table specifically so it is visibly *not* what `allow` taps: limited access opens a per-item picker and TikTok then sees only what a human hand-selected, which no unattended run can maintain.

The sweep:

```
sweepModals(ctx, policies, { maxRounds: 4 })
  round:
    dump once
    match every register entry against the tree
    no match            → return { cleared: [...] }
    match, policy known → tap, sleep, next round        (E5: they queue)
    match, no policy    → screenshot, throw E_MODAL_UNHANDLED
    rounds exhausted    → screenshot, throw E_MODAL_STUCK
```

`clearBlockingDialog`'s BACK fallback is **not** carried into this sweep. On a six-screen forward walk, BACK undoes the step the run just took — the same argument `dialogs.ts` already makes for `allowBack: false` on `switch-account`.

### 4.3 The flow as a screen machine

Each screen is `{ id, anchor, act }`. `anchor` is one of the seven stable ids (or, on the feed, nothing); `act` walks the dumped tree. The machine sweeps modals before each `act` and re-anchors after it, so an unexpected dialog between two screens is handled where it appears rather than at the end.

| # | screen | anchor | act |
|---|---|---|---|
| 1 | `feed` | — (E3: do not inspect) | tap `+` at `(0.5w, 0.922h)` |
| 2 | `camera` | `video_record_new_scene_root` | tap `upload_hot_area` |
| 3 | `picker` | `viewpager_choose_media` | assert `tv_title` = newest; walk the grid; verify the first cell's duration against the pushed video's; tap it |
| 4 | `preview` | the button row's own subtree | tap "Berikutnya" **within that subtree** (E9) |
| 5 | `editor` | `tv_quick_publish` present | tap "Berikutnya" |
| 6 | `post` | the only `EditText` | tap the field, `type(caption)`, close the keyboard (E13), set privacy if asked, then Post — or stop, on `dryRun` |

Between 2 and 3 the media permission fires (`sys.media`, `allow`). Between 1 and 2, camera and microphone fire in that order. The pushed video's duration is known before the run because the plan pushes it — which is what turns step 3's "first cell" into something checkable rather than assumed (E11).

### 4.4 The queue entry

```ts
const QueueItemSchema = z.object({
  version: z.literal(1),
  artifactId: z.string().min(1),
  caption: z.string().max(2_200).nullable(),
  status: z.enum(['pending', 'claimed', 'posted', 'failed']),
  claimedBy: z.string().nullable(),   // stableId
  claimedAt: z.number().int().nullable(),
  postedAt: z.number().int().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().max(400).nullable(),
}).strict()
```

One entry per item under `queue:<artifactId>`, in `storage.global`. `.strict()` and a literal `version` for the same reason `accounts.ts` uses them: a shape written by a newer member must throw rather than be half-understood.

Claiming:

```
list  storage.global, prefix 'queue:'
filter status === 'pending'
order  by key (in-order) or shuffled (random)
for each candidate:
  setIfVersion(key, { ...item, status: 'claimed', claimedBy, claimedAt }, item.version)
  → null  : lost the race, try the next candidate
  → ok    : claimed
none left → outcome 'skipped', not a failure
```

A claim that never completes is recoverable because `claimedAt` is on the record: a stale claim older than a farm-set window is eligible again. **That reaper is not built in this plan** — it is named here so the field is not mistaken for decoration, and it is §9 Q5.

### 4.5 Reading the captions file

Only when a claimed item's `caption` is `null`:

```ts
const file = await ctx.farm.call('fs.read', { path: captionsFile }, WorkspaceFileSchema)
const lines = file.content.split('\n').map((l) => l.trim()).filter(Boolean)
```

`fs.read` returns UTF-8 as a plain string, so a `.txt` needs no decoding. Which line is chosen follows `pick`, and the index is stored back on the queue entry so `in-order` means something across runs.

### 4.6 The service, and what it is for

Step 113.10 adds `defineService` to the pack for two reasons that arrive together: §3.7 needs it as the home of `permissions`, and C8 makes it the natural home of auto-posting. The service holds a timer, and on each tick calls `ctx.farm.call('job.run', …)` for each eligible device — one post per device per interval.

`permissions: ['fs.read', 'job.run', 'device.list']`, and nothing else. The list is what the operator consents to.

---

## 5. Implementation steps

| step | what | why it is separate |
|---|---|---|
| **113.1** | `modals.ts` — the register, the `sweepModals` loop, the never-list guard, and their tests. Pure functions over a dumped tree; no device. | It is the piece every later step depends on, and the only one fully testable without hardware. |
| **113.2** | `screens.ts` — the six-screen machine, anchors, and the subtree walk that survives E9. Tested against the six dumps captured on 2026-08-17, checked into the pack as fixtures. | Fixtures from a real device turn "does this selector work" into a unit test. |
| **113.3** | `post-video.ts` rewritten: the §4.1 schema, direct mode only, `dryRun` honoured, `outcome` never `posted` yet (§3.6 lands in 113.6). Delete `videoFolder`. | Direct mode needs no new capability, no service, and no queue — it is the shortest path to a real post. |
| **113.4** | Hardware run of 113.3 in `dryRun`, then one real post to a test account. Screenshots of every screen archived as artifacts. | The first time this touches a real account is a step, not a side effect. |
| **113.5** | The pack grows `defineService({ permissions: ['fs.read'] })` and is published once, so `ctx.farm` resolves (C3, C5). | C5 makes this a hard ordering constraint, not a preference: nothing below can be developed in a dev slot until it has happened. |
| **113.6** | The confirmation step behind `outcome: 'posted'` (§9 Q1's answer, once taken). | It is the difference between a feature and a claim. |
| **113.7** | The queue: `QueueItemSchema`, the CAS claim, `source: 'queue'`, `skipped` on empty. | |
| **113.8** | The captions file, via `ctx.farm.call('fs.read', …)`, and the line cursor. | Depends on 113.5 having happened. |
| **113.9** | `kind: 'artifact'` in `PARAM_KINDS` + `WorkspacePathControl`'s sibling in `SchemaForm`, rendering the existing `ArtifactPicker` (G6/C9). | A protocol change with its own compatibility surface — it does not belong inside a pack step. |
| **113.10** | A `content` view on the plugin's surface: upload a video, give it a caption, see the queue and its history. Plus the service and its timer (§4.6). | The queue is unusable by a human until this exists. |
| **113.11** | Docs: the pack README, `docs/feat/plugin-and-script.md`'s member list, and `docs/spec.md` if 113.9 lands a new param kind. | DoD item 8. |

Steps 113.1–113.4 are the shippable slice. Everything after is additive.

## 6. Acceptance criteria

1. A video uploaded through `POST /api/artifacts` is posted to TikTok by a job, on a real device, with the caption the operator supplied.
2. `dryRun: true` reaches the Post button and does not press it, on the same run path — not a separate code path.
3. All five modals in §4.2 are handled without human help, in one run, including the media prompt being **allowed**.
4. A modal not in the register aborts the run with a screenshot artifact and `E_MODAL_UNHANDLED` — it is never guessed at.
5. The never-list guard has a test asserting no register entry taps a label that grants beyond its own permission, buys, subscribes, follows, or accepts terms.
6. `find`-ambiguity is not reachable: no code path in the pack selects a node by text alone across the whole tree (asserted by a test over the source, in the manner of the `adb kill-server` guard).
7. Two devices running the queue concurrently never claim the same entry — proved with a test that forces the CAS collision, not by observation.
8. An empty queue reports `outcome: 'skipped'` and does not fail the job.
9. A caption is read from a workspace file through `ctx.farm`, and the run states which line it used.
10. `outcome: 'posted'` is only ever written by the confirmation in 113.6; a run that tapped Post without confirming reports `unverified`.
11. The result names the device path the video was left at, and the pack's README says nothing removes it.
12. `bash scripts/check-plan-status.sh` passes with this plan's status line updated.

## 7. Test plan

- **Unit, no device**: the register and sweep against the six captured dumps; the CAS claim against a fake store, including the collision; the caption line chooser; the flat-schema cross-field validation (`direct` without `videoArtifactId` produces a sentence).
- **Fixtures**: the 2026-08-17 dumps are checked in under `plugins/tiktok-automation-pack/src/__fixtures__/`, each named for its screen and stamped with device, app version and locale (§3.4 item 4).
- **Guard tests**: the never-list; the no-bare-text-selector sweep over the pack's source.
- **Hardware, `ENKAKU_TEST_DEVICE=1`, operator-run**: the `dryRun` walk end to end, and one real post. These cannot run in CI — no test in this repo touches a physical device — so they are named as the operator's and reported, never assumed.
- **Not tested here**: whether the flow survives a TikTok update. Nothing can test that in advance; §8 records it as the standing risk it is.

## 8. Risks and mitigations

| risk | mitigation |
|---|---|
| **An app update moves everything.** Nine of the sixteen selectors are obfuscated names (E10). | Anchor on the seven stable ids; walk subtrees by role and text; keep the fixtures dated so a diff shows what moved. `dryRun` is the pre-flight check after any update. |
| **A wrong video is posted.** "First cell" is a heuristic (E11). | Verify the first cell's duration against the pushed file's before tapping. G7's `content://` URI would remove the heuristic entirely — §9 Q3. |
| **Posting to the wrong account.** The pack can switch accounts; this member does not check which one is signed in. | The member reads and reports the current account before posting, and refuses when a caller named one that does not match. |
| **The register taps something harmful.** A generic auto-dismisser is one careless entry away. | The never-list, with a test (criterion 5). Entries are added only with a dump and a provenance stamp. |
| **Device storage fills** (G8). | Reported per run; named in the README; `device.rm` proposed as §9 Q4. |
| **A permission dialog appears that the register denies and the flow needs.** | An `abort` policy exists precisely so a wrong `deny` is loud. Criterion 4. |
| **The publisher's role narrows and `fs.read` starts failing** (C4). | The failure is a coded `E_FORBIDDEN` naming the capability; the member reports it as `failed` with that reason rather than falling back to a caption it invented. |

## 9. Open questions

**Q1 — How is a post confirmed?** Three candidates, none free: read the profile's first grid cell after posting; watch for the in-app "posted" toast; or poll the account's video count before and after. The first is most robust and slowest, the second is a race, the third needs a reliable count read. **This must be answered before 113.6**, and until it is, `outcome` never says `posted`. *Recommendation: the profile grid, with a bounded wait.*

**Q2 — Does the pack strip TikTok's auto-attached soundtrack (E12)?** A posted video carries a sound the author never chose, which has copyright and reach implications the farm owner may care about. The `X` beside `tv_top_text` removes it. *Recommendation: a parameter defaulting to leaving it, so the current behaviour is not changed silently.*

**Q3 — Should `device.push` return what `scan_file` printed (G7)?** It would give a `content://` URI, which turns "tap the newest cell" into an intent carrying the exact item, and would answer "did it reach the gallery" without opening an app. It is a change to a shared capability's output for one pack's benefit. *Recommendation: yes, additively — the field is useful to anything that pushes media.*

**Q4 — Does a `device.rm` capability get built (G8)?** Deleting a file on a user's device is a capability with real blast radius, and it needs its own ACL and audit story. *Recommendation: a separate plan, not a step here.*

**Q5 — Who reaps a stale claim (§4.4)?** The service in 113.10 is the obvious owner, but a farm that never runs the service would accumulate stuck entries. *Recommendation: the member itself reclaims entries older than a threshold when it finds no `pending` candidate — no reaper, no daemon.*

**Q6 — Is the queue's caption authoritative over the captions file, or the reverse?** §4.5 assumes the entry wins and the file is a fallback. The opposite (the file is the calendar, the entry is an override) is defensible for someone editing captions in bulk. *Recommendation: keep the entry authoritative; a bulk edit is a surface feature, not a precedence rule.*
