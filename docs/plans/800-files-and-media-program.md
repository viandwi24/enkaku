# Plan 800 — Files and media: the program — what already exists, the four decisions, the waves

> Status: draft
> Ships: none — a program document creates no artefact of its own.
> Depends on: plans 39 (transfer), 70 (blobs), 90 (mediaScan), 93 (artifact picker), 113 (`kind: 'artifact'`), 115 (workspace media and folder posting), 212 (settings), 224 (retention)
> Spec references: §4.2, §5, §9, §12

## 1. What this series is

The owner's brief, 2026-09-08, in the owner's own words:

> *"fitur file manager itu ada 2 berarti yah — jalan di enkaku dan di setiap device, entah pakai adb atau pakai bridge apk guest agent kita. tapi yang saya bayangin itu memang kita di enkaku studionya harus ada file manager nya gitu atau media gallery, jadi bisa terima download/upload/move atau rename atau hapus. terus script juga bisa akses api nya bisa upload/download/move dll. terus set policy kaya dihapus per berapa hari atau jam dll. dan di studio dan galery hp yah kalau bisa sync."*

Five asks, and they are not one plan's worth of work:

1. A **file manager / media gallery in Studio** — upload, download, move, rename, delete.
2. The **same surface for a script**, through the capability API.
3. A **retention policy** — deleted after N hours or days.
4. That policy **overridable**: a farm default, an operator's setting, and per script.
5. **Sync** between what Studio holds and what the phone's gallery holds.

### 1.1 The finding that shapes this programme

**Ask 1 and ask 2 are largely already built, under a different name, on the
wrong screen.** This is the single most important fact in this document, and
every plan in the series must be read against it. The workspace — `workspace_files`,
plan 115 — is already a file manager with an upload, a download, a move, a
delete, presenters for image and video, and per-scope quotas. It is filed under
**Agents → Files**, so nobody looking for a media gallery finds it.

Building a second store beside it would give this repo a fourth file store
(`artifacts`, `workspace_files`, `agent_blobs`, and a new one) with a fourth id
shape and a fourth upload route. The programme's governing constraint is
therefore: **promote and present what exists; add a store only where none can
serve.**

### 1.2 What already exists (verified 2026-09-08, by reading these files)

| Fact | Where | Line |
|---|---|---|
| An operator can already upload a file, multipart, audited, capped at 1 GiB | `packages/core/src/api/artifacts.ts` | `151` |
| Previously uploaded files are already listable | same (`?kind=upload`) | `100` |
| A script param can already MEAN "a file": `kind: 'artifact'` | `packages/protocol/src/schema/vocabulary.ts` | `60` |
| …and Studio already renders it as an upload-or-browse picker | `packages/studio/src/components/schema-form/controls/ArtifactControl.tsx` | whole file |
| The workspace is already a full file manager: list, read, write, delete, **move**, grep | `packages/core/src/capability/fs.ts` | `73`–`168` |
| …with a Studio browser, an upload input, and image/video/text presenters | `packages/studio/src/components/agents/FilesTab.tsx` | `404`, `238` |
| …and per-scope quotas: 256 MiB a file, 1 000 files, 8 GiB a scope | `packages/core/src/config/constants.ts` | `217` |
| A push already tells the phone's gallery the file exists | `packages/core/src/device/transfer.ts` (`runMediaScan`) | `~250` |
| A push now also returns the MediaStore `_id` it produced | `packages/protocol/src/messages/transfer.ts` (`MediaScanResult.mediaId`) | this series, wave 1 |
| The phone's MediaStore can now be READ, newest-first | `packages/core/src/device/media-query.ts` | whole file |
| Artifacts are swept by age — **30 days by default, uploads included** | `packages/core/src/retention/sweeper.ts` | `207` |
| Workspace files are **never** swept by age; only quotas bound them | same | — (no workspace sweep exists) |

Read that table before writing any plan in this series.

### 1.3 The gap, stated exactly

| Ask | State | What is actually missing |
|---|---|---|
| 1 — file manager in Studio | mostly built, misfiled | A **media presentation**: a gallery grid with thumbnails, filter by type, on a screen an operator can find. Rename (`fs.move` exists; no UI verb). |
| 2 — script API | built for the workspace; **absent for the device** | The device half. `push`/`pull` move bytes; nothing lists, moves, renames or deletes a file ON the phone. |
| 3 — retention policy | half-built, and wrong where it exists | Uploads are deleted at 30 days with no exemption; the workspace is never swept at all. Neither is what the owner asked for. |
| 4 — overridable policy | absent | No per-file, per-script or per-folder override exists anywhere. |
| 5 — sync | newly possible, not built | Wave 1 makes the phone's gallery readable. Nothing yet compares it to what Studio holds. |

## 2. Non-goals

| Not done in this series | Why |
|---|---|
| A fourth file store | §1.1 — the constraint, not a preference |
| Replacing `artifacts` with the workspace, or vice versa | They answer different questions: an artifact is a run's output or a push's source, a workspace file is the operator's own tree. Merging them is a separate, larger decision |
| A guest-agent file bridge | The shell is not subject to scoped storage, so `content query` and `ls`/`mv`/`rm` answer without an APK — plan 90 §3.1's rule reaches the same conclusion it did for `mediaScan`. Revisit only if a real capability proves unreachable from the shell |
| Two-way automatic sync | D4 below — the decision is deliberately "show the difference", not "reconcile it" |

## 3. Decisions

### D1 — The device file manager is shell-based, and it is a NEW capability family

`device.fs.*`: `list`, `stat`, `move`, `delete`, `mkdir`. Built on `ls -la`,
`mv`, `rm`, `mkdir -p` over the existing exec lane, exactly as wave 1 built
`device.media.list` on `content query`. `push`/`pull` already cover the bytes;
this is the browse-and-manage half they never had.

The two file managers stay **separate and clearly labelled**. A file in Studio
and a file on a phone are different objects with different lifetimes, and a UI
that blurs them will get one deleted in the belief it was the other.

### D2 — The media gallery is a VIEW over stores that already exist

One screen, `/files`, with a source switch: **Workspace** (the operator's tree)
and **Uploads** (ownerless artifacts). Both already have list APIs. The screen
adds what neither has: a grid, thumbnails, filter by media type, and rename.

This is why `kind: 'artifact'` and `workspaceFile` both keep working unchanged —
the picker gets a gallery mode, not a new value shape.

### D3 — Retention becomes a policy with three levels, and a file may opt out

The owner's answer, verbatim: *"tetap ada sistem default, tapi bisa di override
tingkat setting user atau tingkat script."* So:

1. **Farm default** — a constant in `constants.ts` with an `ENKAKU_*` override, because it is a value the owner expects to keep tuning (plan 212's rule).
2. **Operator setting** — the existing `storage.artifacts` section, extended to the workspace, per source.
3. **Per-file** — a `pinned` flag. A pinned file is never swept, at any level.

And the bug this closes, which is not a feature request: **an operator's own
upload is currently deleted after 30 days by `sweepArtifactQuota`**, which
selects every artifact row with no exemption. A media library that silently
loses the operator's videos is not a media library. Uploads become pinned by
default; run output keeps today's behaviour exactly.

### D5 — Fan-out lives in a plugin, and the core gains nothing for it

The programme's own reason to exist was an operator asking to upload a video
once and have it posted on several phones across several apps. That is a
feature, and the temptation is to give the core a `posts` table, a
`device.platform` column and a scheduler — which is exactly how a device farm
turns into one company's social-media tool.

The owner's rule, stated 2026-09-08 and binding here: **the feature lives in
the plugin; the core gains only generic primitives, the way `batches` was born
from a plugin needing bulk.** Applied, that means the fan-out needed nothing
new at all — every primitive already existed:

| what fan-out needs | what it uses | whose it is |
|---|---|---|
| somewhere to keep a post | `kv_entries`, plugin-namespaced | the farm's generic KV |
| "this phone posts to Instagram" | device **labels** (spec §4.2a) | the farm's generic many-to-many |
| "run this on that phone" | the `job.run` capability | the farm's generic dispatch |
| the app's upload flow | each platform pack's own member | that pack |

So `plugins/social-media-manager` (`smm`) is policy over those four and
contributes no core change whatsoever — no table, no column, no migration.
`platforms.ts` is the whole extension point: a row per platform naming the
device label it routes on and the member that posts. Adding a platform is that
row plus the pack it names.

**The honest half.** Only TikTok can post today. `tiktok/post-video` exists and
every anchor in it traces to a real accessibility dump; Instagram and YouTube
have packs and neither has an upload flow. Writing those selectors from memory
would produce a member that typechecks, tests green against fixtures invented
to match it, and reports success without posting — the exact failure this
repo's fixture discipline exists to prevent. So both are declared with
`script: null` and a reason the operator reads in the product, and the router
records `unsupported` rather than skipping in silence. The day someone captures
those dumps, it is a one-line change and every stored post starts routing.

Two consequences worth stating, both found by building it:

- **A caption is required.** It reads like it should be optional, but
  `post-video` with `source: 'direct'` refuses an empty one — its captions-file
  fallback belongs to the `queue` and `folder` sources, and there is nothing to
  fall back to when the caller names the video itself. Storing a caption-less
  post would dispatch and fail on every phone.
- **A post is dispatched once per platform, never re-dispatched.** Re-posting
  the same video to the same account is not a retry; it is a duplicate post,
  and it is the one failure here nobody can undo from the farm.

### D4 — Sync SHOWS a difference; it never reconciles one silently

Wave 1 made the phone's gallery readable, so Studio can now say "this video is
on 4 of 7 devices" and "this phone holds 3 videos Studio does not". That is the
whole of the owner's *"biar tau keadaan di hp"*.

What it must not do is delete or copy on its own. A phone's DCIM is the user's
own camera roll as much as it is the farm's staging area, and a reconciler that
guesses wrong deletes something nobody can get back. Every direction is an
explicit operator or script action — push these, pull those — with the
difference shown first.

## 4. Waves

| Wave | Plan | What lands | State |
|---|---|---|---|
| 1 | — | Read MediaStore: `TransferService.listMedia`, `MediaScanResult.mediaId`, the `content query` parser | **implemented** |
| 2 | — | Retention split: `artifacts.pinned`, `storage.uploads` (keep-forever default), the three override levels (D3) | **implemented** |
| 3 | — | `device.fs.*` — list/stat/move/delete/mkdir, plus SDK (`ctx.device.fs`) and six capabilities (D1) | **implemented** |
| 4 | — | Media metadata: mime, dimensions, duration from the bytes. **No thumbnails** — see below | **implemented** |
| 5 | — | Studio `/files` — the gallery grid, type filter, search, rename, pin, delete (D2) | **implemented** |
| 6 | — | Device Control's Files section moved onto `device.fs.*`; `ls -lA` parsing deleted | **implemented** |
| 7 | — | `plugins/social-media-manager` — one uploaded video, routed to the phones labelled for each platform (D5) | **implemented** |

None of the waves needed a plan number of its own: each is one coherent change
with its own tests, and a plan document per wave would have restated this table.

### What changed from the plan as written

**Thumbnails were dropped from wave 4, on evidence.** There is no ffmpeg or
ffprobe anywhere in this repo and `LICENSES.md` is deliberate about what may be
redistributed, so a poster frame cannot be generated host-side without a new
dependency. It does not need to be: the browser already has a decoder, so
`/files` renders a `<video>` seeked to its first tenth of a second. Storing one
would add a dependency, a file to write, and a file for retention to sweep, to
duplicate what a client does for free.

**Wave 6 turned out to be a REPLACEMENT, not a new screen.** Device Control
already had a Files section (plan 215 §4.12) — and it ran `ls -lA` through the
generic `adb` action and parsed the output in the browser. That parser guessed
at a column layout that differs between toybox and BusyBox and a date format
that varies by locale, and the `adb` action is gated on running arbitrary
shell, which an operator may legitimately have turned off on a network-exposed
farm (`privacy.adbCommand`) — at which point browsing files failed for a reason
that had nothing to do with files. It now calls `device.fs.list`, over the
`device.files` permission push and pull already use, and `files-parse.ts` is
deleted.

**D4's difference view is NOT built.** Wave 1 made the phone's gallery readable
and wave 5 made the farm's library visible, so the comparison is now possible —
but nothing yet renders it, and no user has asked for it. Building a screen on
the strength of "we could" is how the workspace became a file manager nobody
found (§1.1). It stays a decision, not a backlog item.

**A sixth rail entry.** `/files` needed one: a top-level page is unreachable
without it (`scripts/check-routes.ts`), and folding an uploads library into
another screen would have put two different things called "Files" on two
screens, since the workspace already lives under Agents. `ImagesIcon` is one of
the 62 already pinned by the design-token check, so the handoff's icon set is
unchanged.

Wave 1 carries no plan number of its own: it is the one piece that had to exist
before the programme could be written at all — without a readable MediaStore,
D4 is a guess rather than a decision.

Wave 2 is deliberately first among the unbuilt: it is the only one that fixes a
live data-loss bug, and every later wave stores more files under the same policy.

## 5. Vocabulary

- **artifact** — a run's output, or a push's source. Addressed by an opaque id. Swept.
- **workspace file** — the operator's own tree, addressed by an absolute in-workspace path. Quota-bound, never swept today.
- **device media** — a row in the phone's MediaStore. Addressed by `_id`. Never owned by the farm.
- **pinned** — exempt from every sweep, at every level. A property of a file, not of a policy.
- **sync** — showing the difference between two of the above. Never a write.
