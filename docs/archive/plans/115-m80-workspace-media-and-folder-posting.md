# Plan 115 — M80 : The workspace gets a content store, and a post reads a folder

> Status: implemented — **all eight steps (115.1–115.8) shipped 2026-08-18**, in one day, by seven workers running in parallel. This plan exists because the farm owner overturned plan 113 §3.1, and then overturned the obvious implementation of that overturn: told that holding video in the workspace meant blobs in SQLite and quotas raised ~50×, they specified the better design instead — bytes in a protected folder, SQLite holding only the catalogue, and *which driver* holds the bytes recorded per row so the same table can later point at S3. **What shipped:** the `ContentDriver` seam with `inline` and `fs` drivers, the `storage`/`locator` columns and migration `0060_fluffy_king_bedlam`, write-routing by policy (small text stays inline; the threshold is the new `workspace.inlineMaxBytes`), quota defaults reframed as a DISK budget (256 MiB per file, 8 GiB per scope) with an `E_QUOTA` message that names the setting to raise, `POST /api/workspace/file`, Upload and Rename on the workspace page, `ctx.artifact.file()` returning the `{ artifactId }` that `device.push` needs, and `post-video`'s third source — a workspace folder, with the video pick and the caption pick independent. **Verified 2026-08-18, re-run independently by the orchestrator:** `packages/core/src/workspace/` + `api/workspace.test.ts` 103 pass / 0 fail; the TikTok pack 238 pass / 0 fail across 13 files; `packages/session/src/runner/` 174 pass / 0 fail; `bun run typecheck` clean in every package. **Three deviations from this document, each recorded rather than smoothed over:** (1) `ContentDriver.put/get/delete` are SYNCHRONOUS, not `Promise`-returning as §4.1 sketches — making them async would ripple `await` through `capability/fs.ts`, `scripts/build.ts`, `api/recordings.ts`, `enkaku-vfs.ts` and `plugins/auto-rebuild.ts`, several of which other steps were extending concurrently; Bun's `node:fs` is synchronous and an `s3` driver is the point to widen the seam, not now. (2) `packages/node/src/hosts.ts` needed a locally-generated id to satisfy the new required `SavedArtifact.id`, which does NOT match the id a control plane later assigns — so on a node-owned device a script calling `push` after `artifact.file` gets an honest 'artifact not found' rather than silence. A real gap, named here, not papered over. (3) `docs/spec.md` §12 was written directly rather than opening a `DIV-` row, following the precedent plans 88 and 108 set for shipped, owner-directed growth. **The plan-number collision, for anyone reading a `115.x` citation in git history:** this was written as 114/M79 and renumbered to 115/M80 the same day, because a concurrent session's `114-m79-device-proxy.md` had already landed five steps under that number. The two plans collided on SECTION numbers too — both had a `§4.3` and a `step 114.3` — so the sweep classified each citation by topic rather than by string, and two false positives in `capability/context.ts` and `network/route-service.ts` were caught and reverted. **What this plan does not prove:** the six-screen TikTok walk has still never run against a real phone. That is plan 113 step 113.4, it belongs to the operator, and until it happens `post-video` reports `unverified` and never `posted`.
>
> **Note on the driver seam's concurrency (deviation from §4.1's literal code block):** §4.1 sketches `ContentDriver.put/get/delete` as `Promise`-returning. They are implemented SYNCHRONOUSLY instead (`packages/core/src/workspace/drivers/index.ts`'s header explains why in full) — making them async would force `WorkspaceStore.read/write/delete` to become `async`, rippling `await` through `capability/fs.ts`, `scripts/build.ts`'s import-graph walk, `api/recordings.ts`, `agent/harness/enkaku-vfs.ts`, and `plugins/auto-rebuild.ts`, several of which steps 115.3–115.6 are actively extending concurrently with this work. Bun's `node:fs` is fully synchronous and the `fs` driver has no correctness need for `Promise`s today; an `s3` driver, when actually built (§2's explicit non-goal), is the point to widen the seam, not now. The interface's *shape* (`id`/`put`/`get`/`delete`) is unchanged.
>
> Depends on: Plan 113 (M78) — `post-video`'s modal register, screen machine and queue, which this plan extends rather than replaces. Plan 64 — the workspace store, its quotas and its CAS. Plan 39 — the artifact store and `device.push`. Plan 109 (M74) — `ctx.farm`, the only door a script has to `fs.*`.
> Spec references: §11.6 (plugins), §12 (data model — `workspace_files`), §19 (Studio screens)
> Ships: packages/core/src/workspace/drivers/index.ts

---

## 0. Evidence

Checked against the code on 2026-08-18.

| # | Finding | Consequence |
|---|---|---|
| **W1** | **`fs.write` already accepts binary.** `encodeContent(content, contentType)` base64-decodes whenever `isTextContentType` is false, and `fs.read` base64-encodes on the way back. | Gap G2 is narrower than plan 113 recorded: the *capability* is binary-capable. What is missing is a way to get bytes to it without a 67 MB JSON body, and a control in Studio. |
| **W2** | **The store keeps content in the row.** `workspaceFiles` carries the bytes, and `store.ts`'s header states as a property that it "NEVER touches `node:fs`" — its own tests run with the data directory read-only to prove it. | That property is what this plan changes, deliberately and in one place. It was a correct property for a code store and is the wrong one for a content store. |
| **W3** | **The quotas are already settings**: `workspace.maxFileBytes` (1 MiB), `maxFilesPerScope` (1 000), `maxTotalBytesPerScope` (64 MiB). | A defaults change, not a schema change. |
| **W4** | **Studio's workspace page already creates, edits, saves, deletes and publishes**, and `lib/workspace.ts` already exports `moveWorkspaceFile`. | Of the five operations the owner listed, three exist. **Upload** has no control at all; **rename** has a client and no button (`grep -c rename page.tsx` → 0). |
| **W5** | **`ctx.artifact.file()` returns `void`**, and `MAX_FILE_BYTES` caps a saved artifact at 8 MB on both the job and device paths. | A script can read a video out of the workspace and has nowhere to put it: `device.push` takes an `artifactId` and nothing hands one back. This is gap G5 in its narrowest form, and it is the bridge. |
| **W6** | **`device.push` resolves any artifact row**, and `transfer.maxPushBytes` defaults to 512 MiB. | Once a script can mint an artifact, the rest of the chain is proven (plan 113 finding E1). |
| **W7** | The store already computes a **sha256 per file** and exposes it as `hash`, used as the CAS token. | The content address this plan needs already exists; it is not a new concept to introduce. |
| **W8** | The TikTok pack declares `permissions: ['fs.read', 'job.run', 'device.list']`. | Folder mode needs `fs.list` added or it is refused before it runs. |

## 1. Goals

1. **The workspace stores bytes behind a named driver**, with SQLite holding the catalogue — path, size, hash, content type, driver, locator — and not the content.
2. **A second driver can be added without touching the store**, S3 being the case the owner named. This plan builds two: `inline` (what exists) and `fs`.
3. **An operator can upload a video into the workspace from Studio**, and rename, edit, create and delete files there.
4. **A script can turn bytes into an artifact** and push it to a device.
5. **`post-video` accepts a workspace FOLDER and a captions file**, picking video and caption line independently, each random or in order.
6. The owner's manual test passes end to end.

## 2. Non-goals

- **Building the S3 driver.** The seam is the deliverable; a second real backend is a plan of its own once someone needs it. Building it now would be designing against an imagined deployment.
- **Migrating existing rows.** They keep their bytes in the row and are read through the `inline` driver, forever if need be (§3.2).
- **Streaming.** A file is read whole into memory, as everything here already is. Stated in §8, not engineered around.
- **A media browser, thumbnails, previews.** A file list with real sizes is the deliverable.
- **Changing the queue.** Plan 113's `queue.ts` and `source: 'queue'` are untouched; folder mode is a third source.

## 3. Design decisions

### 3.1 SQLite keeps the catalogue; a driver keeps the bytes

Two columns carry the whole idea:

- **`storage`** — the driver that holds this file's bytes (`inline` | `fs`, and later `s3`).
- **`locator`** — how that driver finds them. Meaningless to everyone except the driver that wrote it.

Everything else about a workspace file — its path, size, hash, content type, timestamps, and the CAS the whole store already runs on — stays exactly where it is. `fs.list`, `fs.move`, `fs.grep` and every quota never learn that drivers exist, because none of them touch content.

### 3.2 `inline` is a driver, which is why there is no migration

The bytes-in-the-row behaviour becomes the `inline` driver rather than a legacy path to be migrated away from. An existing row has `storage: 'inline'` and its content column, and reads exactly as it always did. Nothing is rewritten, nothing is moved on upgrade, and a farm that never uploads a video never leaves the shape it has today.

This is also what keeps plan 64's property honest instead of quietly false: `store.ts` still never touches `node:fs`. The **driver** does, and the store calls a driver.

### 3.3 The `fs` driver is content-addressed, and the operator's filename never reaches the disk

The locator is the file's own sha256 — which W7 shows the store already computes — laid out as `<dataDir>/workspace-content/<aa>/<sha256>`. Three consequences, all of them the reason for the choice:

- **A rename is a row update.** No file moves, so a rename cannot half-fail with the row and the disk disagreeing.
- **The same bytes uploaded twice are stored once.** Two rows share a locator.
- **No user-supplied name ever becomes a path.** Path traversal is not defended against here; it is structurally absent, because nothing but a hex digest is ever joined to the root.

Its cost is refcounting: deleting a row must not delete bytes another row still points at. The delete path checks for another row with the same locator before unlinking, and a failed unlink is logged rather than failing the delete — an orphaned blob is a wasted byte, while a missing row for a file the operator deleted is a bug.

### 3.4 Which driver a write lands on is a policy, not a caller's choice

A caller writes a file; it does not pick a backend. The store decides: small text stays `inline` (a script, a note, a `captions.txt` — where a round trip to disk buys nothing and the DB is the simpler place), and anything over a threshold, or anything not text, goes to the content driver. The threshold is a setting.

Refusing the caller a choice is what keeps the seam honest — the day an S3 driver exists, no plugin, script or page has to be taught about it.

### 3.5 The limits stay the operator's, and a refusal names them

Defaults move to fit the owner's workflow (`maxFileBytes` 256 MiB, `maxTotalBytesPerScope` 8 GiB) and stay settings. They are now a **disk** budget rather than a database one, which is what makes numbers of this size reasonable at all. `E_QUOTA` must name the setting to raise: "over the maxFileBytes limit of 1048576" says what happened and not what to do.

### 3.6 `ctx.artifact.file()` returns the artifact it made

The smallest change that closes W5. `file()` becomes `Promise<{ artifactId: string }>` — additive for every existing caller, all of which ignore the return today. `MAX_FILE_BYTES` (8 MB) is raised for the `file` kind and driven from the transfer settings that already bound a push; the screenshot path is untouched.

### 3.7 Folder mode is a third source, and its two picks are independent

`post-video` gains `source: 'folder'`: list the folder through `fs.list`, filter to video extensions, pick by `videoPick`, read the chosen file, mint an artifact, hand it to the flow plan 113 already built. The six-screen walk, the modal register and the confirmation do not change.

`videoPick` and `captionPick` are separate parameters. The owner asked for a random video *and* a random caption line; one shared `pick` would have conflated two independent choices.

### 3.8 A random pick that remembers

Random with no memory reposts the same video. Folder mode records what it posted in the plugin's own storage, keyed by content hash — not by path, so renaming a file does not make it new — and prefers an unposted file, falling back to the least recently posted when every file has been used. Deliberately weaker than the queue's CAS claim: a folder has no status column, and inventing one would be a second queue.

## 4. Technical design

### 4.1 The driver seam

```ts
export interface ContentDriver {
  readonly id: 'inline' | 'fs' | 's3'
  put(content: Uint8Array, hash: string): Promise<{ locator: string }>
  get(locator: string): Promise<Uint8Array>
  /** `false` when another row still references `locator` — the store decides, the driver obeys. */
  delete(locator: string): Promise<void>
}
```

`inline`'s `put` returns the empty locator and the store keeps writing the content column, so the existing path is expressed in the new vocabulary rather than special-cased around it.

### 4.2 Schema

`workspaceFiles` gains `storage TEXT NOT NULL DEFAULT 'inline'` and `locator TEXT`. Generated through `bun run --cwd packages/core db:generate` — never hand-written.

### 4.3 `POST /api/workspace/file`

Multipart (`path`, `file`), because base64 through JSON inflates by a third and holds the whole string in memory before decoding — the problem `POST /api/artifacts` already solved this way. Same auth as the artifact upload (`device.files`, widened by `shell.mode`), same quotas, same audit row. Returns the file's metadata including the `hash` a later CAS write needs. `fs.write` stays exactly as it is: the capability is how a *script* writes, the route is how a *browser* uploads.

### 4.4 Studio

The workspace page gains an **Upload** control and a **Rename** action (the existing `moveWorkspaceFile`, which already requires the CAS token). Sizes render through the existing byte formatter. Nothing else on the page changes.

### 4.5 `post-video`'s new parameters

```ts
source: z.enum(['queue', 'folder', 'direct']).default('folder')
videoFolder: z.string().optional()   // kind: 'workspaceFolder'
videoPick: z.enum(['random', 'in-order']).default('random')
captionsFile: z.string().optional()  // kind: 'workspaceFile', extensions: ['.txt']
captionPick: z.enum(['random', 'in-order']).default('random')
```

`VIDEO_EXTENSIONS` is `.mp4`, `.mov`, `.m4v`, `.webm`. A folder holds `captions.txt` too, so a non-video must be skipped, never pushed.

## 5. Implementation steps

| step | what |
|---|---|
| **115.1** | DONE — The driver seam, the `inline` and `fs` drivers, the schema columns and their migration, and the store routing writes by policy (§3.4). Drivers are synchronous rather than the §4.1 sketch's `Promise`-returning shape — see the status note above. |
| **115.2** | DONE — Quota defaults raised (`maxFileBytes` 256 MiB, `maxTotalBytesPerScope` 8 GiB), the new `workspace.inlineMaxBytes` routing threshold added, and every workspace `E_QUOTA` message now names the setting to raise, not just the limit that was hit. |
| **115.3** | DONE (not yet unit-tested — 115.7's job) — `POST /api/workspace/file` (`packages/core/src/api/workspace.ts`, wired as `workspaceFileRoutes` in `daemon.ts`/`server/http.ts`) — multipart, the same `device.files`/`shell.mode` auth and audit row `POST /api/artifacts` uses, writing through the store's existing `write()` so quotas/CAS/driver routing all apply automatically. |
| **115.4** | DONE (not yet unit-tested — 115.7's job) — Studio: an Upload control (`packages/studio/src/app/workspace/page.tsx`, `lib/workspace.ts`'s `uploadWorkspaceFile`) and a per-file Rename action (inline, using the listing's own `hash` as `moveWorkspaceFile`'s CAS token — no need to open the file first), with real sizes rendered through `@enkaku/ui`'s `fileSize`. A quota refusal surfaces the server's message verbatim. |
| **115.5** | DONE (verified against the code, not built in this pass) — `ctx.artifact.file()` returns `{ artifactId }`; the file-kind cap raised and settings-driven. |
| **115.6** | DONE (verified against the code, not built in this pass) — `post-video`: `source: 'folder'`, the two picks, the extension filter, the posted-memory, `fs.list` added to the pack's permissions. |
| **115.7** | DONE — Tests, one pass at the end, scoped to what changed (see the status line above for the five files and the real pass counts). |
| **115.8** | Docs: the pack README's folder workflow, the workspace guide, and `docs/spec.md` §12 for the two new columns. |

## 6. Acceptance criteria

The owner's manual test, restated:

1. A video uploads into the workspace from Studio and appears with its real size; its bytes are on disk under `workspace-content/`, and the `workspace_files` row holds no content.
2. `captions.txt` is created and edited in the same page, stays `inline`, and a file can be renamed.
3. A file over `workspace.maxFileBytes` refuses with a message naming the setting.
4. `post-video` with `source: 'folder'`, a folder of several videos and a captions file picks one video and one caption line, each independently random or in order.
5. `captions.txt` in that same folder is never chosen as the video.
6. Running twice does not post the same file twice while an unposted file remains.
7. `ctx.artifact.file()` returns an id `ctx.device.push()` accepts.
8. Deleting one of two files with identical content does not break the other.
9. Plan 113's `direct` and `queue` modes still work unchanged.
10. An existing `inline` row — written before this plan — still reads, writes, moves and deletes.

## 7. Test plan

Unit, scoped, one pass: the driver seam against both drivers, including the shared-locator delete (criterion 8) and an `inline` row that predates the change (criterion 10); the write-routing policy; the quota refusal's wording; the extension filter and both picks (pure); the posted-memory preference; the multipart route's auth and quota paths. The flow onto a real phone is the operator's, as in plan 113 §7.

## 8. Risks

| risk | mitigation |
|---|---|
| **The store's "never touches `node:fs`" property is deliberately broken.** Its tests run with a read-only data dir to prove it. | The property moves rather than dying: `store.ts` still never calls `node:fs`, the driver does, and the read-only test keeps running against the `inline` driver. Stated here because a reader of that header will otherwise think it still holds everywhere. |
| **Orphaned blobs** after a crash between the row write and the unlink. | Wasted disk, never a wrong answer: a locator with no row is unreachable, and a row is never written before its bytes. A sweeper is not built — it is named here as the known cost. |
| **A backup that copies the DB no longer copies the content.** | Documented in 115.8. This is the direct consequence of the owner's design and operators must know it before they need a restore. |
| **A 256 MiB read into memory** to push one video. | Measured in 115.7 and reported honestly; §2 records that streaming was not built. |
| **Random reposting the same video.** | §3.8's posted-memory; criterion 6. |

## 9. Open questions

**Q1 — Does the `fs` driver's root need to be a setting?** It is `<dataDir>/workspace-content/` here. An operator with media on a second disk would want it elsewhere. *Recommendation: a setting, once someone asks; the driver already takes its root as a parameter, so it is a wiring change and not a redesign.*

**Q2 — Should `post-video` delete the workspace file after a successful post?** It would make the folder a true queue. Left open: plan 113 §3.8 already records that nothing deletes the copy on the *device*, and half a cleanup story is worse than none.

**Q3 — Who sweeps orphaned blobs?** Named in §8 as a known cost. *Recommendation: a `doctor` check that counts them before anything automatic deletes anything.*
