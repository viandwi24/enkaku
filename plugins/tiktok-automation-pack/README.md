# @enkaku/plugin-tiktok

TikTok automation pack (`com.ss.android.ugc.trill`) — watch-and-scroll, account switching,
search-and-follow, and posting a video. Every screen this pack anchors on, and every selector it
refuses to trust, was read off a real device and is recorded in `src/index.ts`'s own module header
and the `src/__fixtures__/` dumps its tests run against — read those before adding a seventh
screen or a new selector.

## Members (`tiktok/<id>`)

| member | what it does |
|---|---|
| `auto-scroll` | Watches videos until a target count or a wall-clock ceiling is reached, human-shaped timing, optional interest-keyword matching and comment visits. Never likes, follows, comments, or shares. |
| `switch-account` | Switches to another already-signed-in account, by list position or by username, and verifies the switch landed before reporting success. |
| `search-follow` | Types a search query, matches a handle (optionally the display name too), and follows it — refuses rather than guesses when more than one account matches. |
| `list-accounts` | Reads the switch-account sheet and stores which accounts are signed in on a device, for the **TikTok accounts** screen. Never taps an account. |
| `enqueue-video` | Writes one entry to the post queue, keyed by the video's artifact id. What the **Post queue** screen's "Add video" action runs — see below. |
| `post-video` | Pushes a video to the device and drives TikTok's own upload flow (feed → camera → picker → preview → editor → post), sweeping every known blocking modal along the way. Three sources: a workspace **folder** of videos plus a captions file (`source: 'folder'`, the default — see below), the next item claimed from the post queue (`source: 'queue'`), or a video and caption given directly (`source: 'direct'`). `dryRun: true` walks the whole flow and stops at the Post button without pressing it. |

`post-video` and `enqueue-video`, and the **Post queue** screen and the auto-post service below,
are what plan 113 (M78) added; the other three members and the **TikTok accounts** screen predate
it (plan 86, M51). Plan 115 (M80) then added a third `post-video` source, **`folder`** — reading
videos straight out of a workspace folder — and made it the default; see "The folder workflow"
below.

## The folder workflow (`source: 'folder'`) — the owner's own manual routine

This is the workflow to actually use `post-video` day to day, and it is now the member's default
source. End to end:

1. **Upload your videos into a workspace folder.** Open Studio's **Workspace** page, create (or
   pick) a folder — say `/tiktok/queue/` — and use its **Upload** button to add one or more video
   files (`.mp4`, `.mov`, `.m4v`, `.webm`). Each upload goes through `POST /api/workspace/file`,
   which writes through the workspace store's own quotas and content-addressed storage (plan 115) —
   nothing about this pack's own logic needs to know or care that a video's bytes end up on disk
   behind the `fs` content driver rather than in the database row.
2. **Put a `captions.txt` beside them, in the same folder.** One caption per line — create it and
   type into it right there on the Workspace page (it stays a small inline row; no upload needed for
   a plain text file).
3. **Run `post-video`** with `Source` left on **Folder** (the default), `Video folder` pointing at
   `/tiktok/queue/`, and `Captions file` pointing at `/tiktok/queue/captions.txt`. Pick `Video order`
   and `Caption order` independently — each is `random` (the default) or `in-order`; they are two
   separate knobs on purpose, because a random video paired with an in-order caption (or vice versa)
   is a real thing an operator might want, and one shared "pick" could not express it.

Two behaviours worth knowing before you rely on this unattended:

- **`captions.txt` in that same folder is never picked as a video.** The folder listing is filtered
  to `.mp4`/`.mov`/`.m4v`/`.webm` before anything else happens (`src/folder.ts`'s
  `VIDEO_EXTENSIONS`) — there is no separate "skip the file named captions.txt" check, which is
  deliberate: the extension filter alone keeps working even if you name your captions file something
  else, where a name-based exclusion would not.
- **A file already posted is not posted again while an unposted file remains.** `Video order: random`
  remembers what it has posted, keyed by the file's own content hash (not its path — renaming a file
  does not make it look new), in this plugin's own KV storage. It always prefers a video it has never
  posted; only once every video in the folder has been posted at least once does it fall back to the
  least-recently-posted one. `Video order: in-order` instead walks the folder by path in a cycling
  order, which gives the same "everyone gets a turn before anyone repeats" property a different way.
  This is deliberately weaker than the post queue's compare-and-swap claim above — a folder has no
  status column, and two devices sharing one folder can occasionally land on the same "unposted"
  video at the same moment. That is an occasional duplicate post, not a wrong answer anywhere else.

Under the hood, folder mode never stores video bytes anywhere this pack owns: it lists the folder
and reads the chosen file through the same `fs.list`/`fs.read` capabilities `captions.ts` already
used for the captions file, mints a fresh job **artifact** from those bytes
(`ctx.artifact.file()`, which returns the new artifact's id), and pushes that artifact to the device
exactly the way `direct`/`queue` mode already did. `fs.list` is declared alongside `fs.read` below
for exactly this reason.

## The post queue, and how a video gets into it (`source: 'queue'`)

This is the OTHER way to feed `post-video` — a video queued explicitly, one at a time, rather than
picked from a folder. A video is posted from an **artifact** (`POST /api/artifacts`), never a
workspace file, for this source — the workspace is a code store, sized for source, and the artifact
store already is a file-on-disk media store with a push path that reaches the device (plan 113 §3.1
has the full reasoning this pack was built against; plan 115 §3.1 keeps that boundary for the
workspace's own catalogue even though large workspace files now live on disk too — see "The folder
workflow" above for the source that reads the workspace directly). The queue itself is **this
plugin's own KV storage** (`storage.global`, one entry per item under `queue:<artifactId>`), not a
listing of the artifact store — nothing in the SDK can list what artifacts exist, so an operator
adds a video explicitly rather than the pack discovering one.

Reach the queue from the **Post queue** screen (the `content` nav entry):

- **Add video** — pick or upload an artifact, optionally type a caption, submit. This runs
  `enqueue-video` as a job rather than a plain KV write: computing the `queue:<artifactId>` key
  needs real code, which the surface's binding language cannot express (see `enqueue-video.ts`'s
  own header). The job asks for a device to run on even though it never touches one — every `job`
  action structurally requires one.
- **Retry** / **Remove** (row actions) — reset a `failed` item back to `pending` (history kept), or
  delete an entry outright.

`post-video` in queue mode then claims the next `pending` item by compare-and-swap, in the order
`pick` names, so two devices sharing the queue can never claim the same video. A claim that is
never settled — a crash, a killed run — becomes claimable again once it goes stale; there is no
separate reaper process (`src/queue.ts`'s own header has the full mechanism).

**A queued item's own caption wins when it has one.** Only when it is blank does `post-video` fall
back to a workspace captions file (`.txt`, one caption per line), read through
`ctx.farm.call('fs.read', …)` — which is why `fs.read` is one of this pack's declared permissions,
below.

## Auto-posting is OFF by default

The pack ships a `service` (`defineService`) that runs a 60-second timer for as long as the plugin
is active. On its own that timer does nothing: whether any tick actually posts anything is gated by
a stored, operator-editable setting — **Auto-post settings**, the other action on the Post queue
screen's toolbar (`enabled: boolean`, default **false**; `intervalMinutes`, default 60, 5–1440).
Installing or activating this pack does not start posting to a real account — an operator has to
turn the switch on explicitly, from that dialog, on this farm.

Once enabled, and once `intervalMinutes` has genuinely elapsed since the last dispatch, one tick
enqueues `tiktok/post-video@latest` with `params: { source: 'queue' }` on every device that is
`idle` and not already held by a job, a person, or an agent — one job per eligible device per tick,
skipping (never queuing behind) a device that is already busy.

## Permissions this pack declares, and why

```ts
service: defineService({ permissions: ['fs.read', 'fs.list', 'job.run', 'device.list'] })
```

This is the farm's capability broker (plan 109): a capability is refused before it runs unless it
is named here, and refused again, live, if the publishing user's role does not hold it. The list is
exhaustive — nothing in this pack calls a capability this array does not also name.

- **`fs.read`** — reads the workspace captions file (both `post-video`'s folder mode and its queue
  mode's own fallback, `src/captions.ts`) and, in folder mode, the chosen video file itself
  (`src/folder.ts`).
- **`fs.list`** *(plan 115 §1 goal 5, W8)* — lists a workspace folder's contents so folder mode can
  find its video candidates (`src/folder.ts`'s `listVideoCandidates`).
- **`job.run`** — the auto-post timer enqueues `post-video` jobs on its own clock.
- **`device.list`** — the auto-post timer reads each device's `status`/`heldBy` to decide who is
  eligible. `job.list` is deliberately **not** declared: `device.list`'s own `heldBy` already
  answers "is this device already mid-job" without it.

## Read this before you rely on it

**Nothing removes the pushed video from the device.** There is no capability in this SDK that
deletes a file from a device (`DeviceApi` has neither a shell nor a remove), so `post-video` leaves
the pushed file under `/sdcard/DCIM/Camera/` on every run — its path is reported back in the job's
own result (`remotePath`) rather than quietly disposed of. `direct`/`queue` mode names it `.mp4`
always, unchanged from before plan 115; folder mode instead keeps the source file's own extension
(so a `.mov` stays a `.mov` on the device — some gallery apps refuse to play a mismatched
container/extension pair). A farm posting on a schedule
accumulates this history on every phone's own storage, indefinitely; there is no cleanup mechanism
here, and none planned in this pack. Watch device storage yourself, or clear it by hand. Plan 113
§3.8/§9 Q4 records a `device.rm` capability as the real fix — unbuilt.

A few more things worth knowing before this runs unattended:

- **`outcome: 'posted'` is earned, not assumed.** Tapping Post is not evidence a post happened —
  `post-video` opens the account's own profile afterward and looks for the new video, with a
  bounded wait, before it ever reports `posted`. A run that tapped Post but could not confirm
  reports `unverified` instead. Both paths are shipped and typechecked, but neither the
  confirmation step nor the auto-post timer that depends on it has been proven on real hardware
  yet — the hardware walk this pack was built from stopped at the Post button and discarded the
  draft. Check the plan's own status line for exactly what is proven and what is not.
- **Only `privacy: 'leave'` is supported.** No selector for TikTok's Public/Friends/Private
  audience sub-menu has been confirmed on hardware, so `post-video` refuses loudly
  (`E_PRIVACY_CONTROL_UNKNOWN`) rather than guess one.
- **No liking, following, commenting, sharing, or camera use anywhere in this pack.** `auto-scroll`
  only watches and scrolls; `post-video` is the one member that writes to the account, and it only
  ever posts the video it was given.

## Development

```bash
bunx enkaku dev ./src/index.ts --farm http://localhost:7700
```

See `packages/sdk/README.md` for what `definePlugin`, `defineService`, `ctx.farm`, and a plugin's
`surface` actually are.
