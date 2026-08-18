import type { KvListItem, ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Picking a video out of a workspace folder — `post-video`'s `source: 'folder'` mode (plan 115 §3.7,
 * §3.8, §4.5), and the owner's own manual workflow: upload videos into the workspace, keep
 * `captions.txt` beside them, run this member against the folder with a random pick.
 *
 * Every DECISION below — which extensions count as video, which candidate a pick chooses, which of
 * two already-posted candidates is the staler one — is a pure function with no `ctx` at all, so
 * step 115.7's test pass can cover the logic without a device (task instruction 6). Everything that
 * touches `ctx` is a thin wrapper around `ctx.farm.call('fs.list' | 'fs.read', …)` — the same broker
 * `captions.ts` already goes through, subject to the same three refusals that file's own header
 * documents (`E_FARM_UNDECLARED`, `E_FARM_NO_PLUGIN`, `E_FORBIDDEN`) and translated into a sentence
 * here the same way, generalised over the capability name since this module calls two of them.
 */

/**
 * §4.5, verbatim. `.txt` is deliberately absent — which is the entire reason `captions.txt`, sitting
 * in the very folder this filter runs against, can never be chosen as the video (task instruction 3,
 * plan criterion 5). There is no separate "skip captions.txt by name" check anywhere in this file:
 * the extension filter alone is both necessary and sufficient, and staying that way is deliberate — a
 * name-based exclusion would silently stop protecting the day an operator names their captions file
 * something else, while an extension filter keeps working for ANY non-video file dropped in the
 * folder by mistake.
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'] as const

export function isVideoPath(path: string): boolean {
  const lower = path.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** One `fs.list` entry, narrowed to what this module reads — declared locally rather than imported
 * from core, the same "the caller validates against what it needs, not whatever core answers with
 * today" posture `captions.ts`'s own `FsReadOutput` documents. */
export interface FolderEntry {
  path: string
  kind: 'file' | 'dir'
  hash: string | null
}

export interface VideoCandidate {
  path: string
  hash: string
}

/**
 * Files only (never a subdirectory `fs.list` returns), filtered to `VIDEO_EXTENSIONS`. Throws on a
 * file entry with no hash — the workspace store's own `list()` gives every FILE row a hash (only a
 * synthesised `dir` row omits one), so a null hash on a `kind: 'file'` entry is a store defect this
 * module must not paper over by silently pretending the file does not exist.
 */
export function filterVideoFiles(entries: FolderEntry[]): VideoCandidate[] {
  const out: VideoCandidate[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !isVideoPath(entry.path)) continue
    if (!entry.hash) {
      throw new Error(`workspace file "${entry.path}" has no hash — cannot use it as a folder-mode candidate`)
    }
    out.push({ path: entry.path, hash: entry.hash })
  }
  return out
}

/**
 * §3.8's memory: which content hash was last posted when. Keyed by the file's own sha256 — not its
 * path — so renaming a file in the workspace does not make it look new (§3.8, verbatim). Scope is
 * `storage.global`, the same reasoning `queue.ts`'s own header gives for its queue: a video folder is
 * not a fact about any one device, so forgetting a device must not forget which of its files were
 * already posted.
 *
 * This is deliberately weaker than the queue's CAS claim (§3.3 vs §3.8): a folder has no status
 * column, and giving it one would be building a second queue. Two devices racing `pickVideoRandom`
 * below can both land on the same "unposted" candidate — the cost is an occasional duplicate post
 * across a multi-device run against one shared folder, not a wrong answer anywhere else.
 */
export const FOLDER_POSTED_PREFIX = 'folder-posted:'

export function postedMemoryKey(hash: string): string {
  return `${FOLDER_POSTED_PREFIX}${hash}`
}

/** `.strict()` and a literal `version`, the same posture `queue.ts`'s `QueueItemSchema` and
 * `accounts.ts`'s own schema take: a shape a future version of this pack writes must throw rather
 * than be half-understood by an older one reading it back. */
const PostedRecordSchema = z
  .object({
    version: z.literal(1),
    path: z.string(),
    lastPostedAt: z.number().int(),
  })
  .strict()

/**
 * Builds the hash → last-posted-at map from a raw `storage.global.list()` page set. Throws on a
 * record whose shape this build cannot understand — the same fail-loud posture `queue.ts`/
 * `accounts.ts` already take on their own stored shapes, so a value a newer version of this pack
 * wrote is never silently misread as "never posted" (which would make `pickVideoRandom` prefer it
 * over a file that genuinely has not been posted yet).
 */
export function parsePostedMemory(items: KvListItem[]): Map<string, number> {
  const memory = new Map<string, number>()
  for (const item of items) {
    if (!item.key.startsWith(FOLDER_POSTED_PREFIX)) continue
    const hash = item.key.slice(FOLDER_POSTED_PREFIX.length)
    const result = PostedRecordSchema.safeParse(item.value)
    if (!result.success) {
      throw new Error(`folder-posted memory entry "${item.key}" has an incompatible shape (expected version 1): ${result.error.message}`)
    }
    memory.set(hash, result.data.lastPostedAt)
  }
  return memory
}

/** A single index drawn from `crypto.getRandomValues` — the same RNG choice `queue.ts`'s own
 * `shuffled` makes and for the same reason: never `Math.random()`. */
function randomIndex(length: number): number {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return (arr[0] as number) % length
}

/** The candidates tied for the smallest `lastPostedAt` — 0 (i.e. "the epoch") for one that has never
 * been posted, which only matters here as a tie-break floor: `pickVideoRandom` only ever calls this
 * once every candidate already HAS a memory entry (the "prefer unposted" branch already returned). */
function leastRecentlyPosted(candidates: VideoCandidate[], memory: Map<string, number>): VideoCandidate[] {
  let minAt = Infinity
  for (const candidate of candidates) {
    const at = memory.get(candidate.hash) ?? 0
    if (at < minAt) minAt = at
  }
  return candidates.filter((candidate) => (memory.get(candidate.hash) ?? 0) === minAt)
}

/**
 * §3.8's random pick, pure: prefers a candidate whose hash is absent from `memory` (never posted);
 * only when every candidate has been posted at least once does it fall back to the least-recently-
 * posted one. Ties within either tier are broken uniformly at random — this IS the random pick, and a
 * tie that always resolved the same way (e.g. "first in the list") would not be random at all.
 */
export function pickVideoRandom(candidates: VideoCandidate[], memory: Map<string, number>): VideoCandidate {
  if (candidates.length === 0) throw new Error('pickVideoRandom: no candidates to pick from')
  const unposted = candidates.filter((candidate) => !memory.has(candidate.hash))
  const pool = unposted.length > 0 ? unposted : leastRecentlyPosted(candidates, memory)
  return pool[randomIndex(pool.length)] as VideoCandidate
}

/**
 * The in-order pick, pure: a deterministic order (by path, ascending — the same convention
 * `queue.ts`'s own `byKeyAscending` uses for ITS `in-order` mode) walked by a caller-owned cursor that
 * wraps modulo the candidate count, so a folder that gained or lost files between runs still resolves
 * to some real index rather than throwing. No posted-memory here: a cycling cursor already guarantees
 * every file is reached once before any of them repeats, which is what §3.8's memory exists to
 * approximate for the mode that has no cursor at all.
 */
export function pickVideoInOrder(candidates: VideoCandidate[], cursor: number): VideoCandidate {
  if (candidates.length === 0) throw new Error('pickVideoInOrder: no candidates to pick from')
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const index = ((cursor % sorted.length) + sorted.length) % sorted.length
  return sorted[index] as VideoCandidate
}

/** `fs.read`'s own predicate for "is this content text or base64" (`packages/core/src/capability/
 * fs.ts`'s private `isTextContentType`), duplicated here for the same reason `captions.ts` duplicates
 * it: it is not exported from core, and a plugin cannot reach into core's internals regardless
 * (cross-package imports go through a package name, and core is not one this pack depends on). A
 * video is never a text content type in practice, so this branch is defensive rather than expected —
 * but guessing which branch applies rather than checking would silently corrupt the bytes on the one
 * case it matters, so the check stays explicit. */
function looksLikeText(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/javascript' ||
    contentType === 'application/typescript' ||
    contentType.endsWith('+json') ||
    contentType.endsWith('+xml')
  )
}

/** Turns the two checks `farm-broker.ts` performs (this pack's own manifest, then the publishing
 * user's live role — plan 113 §0.3 C3–C5, the same three refusals `captions.ts`'s `readCaptionsFile`
 * documents) into a sentence naming the capability that was refused, rather than a bare coded error.
 * Generalised over `capability` because this module, unlike `captions.ts`, calls two of them
 * (`fs.list` and `fs.read`). */
async function withFarmErrorContext<T>(promise: Promise<T>, capability: string, action: string): Promise<T> {
  try {
    return await promise
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    const detail = err instanceof Error ? err.message : String(err)
    if (code === 'E_FARM_UNDECLARED') {
      throw Object.assign(
        new Error(`${action}: this pack has not declared "${capability}" — add it to defineService({ permissions }) and republish the pack. (${detail})`),
        { code },
      )
    }
    if (code === 'E_FARM_NO_PLUGIN') {
      throw Object.assign(
        new Error(
          `${action}: this member is running from a dev slot, which has no published service for "${capability}" to be checked against — publish the pack once (\`bun run publish:farm\`) and run this member from the published version. (${detail})`,
        ),
        { code },
      )
    }
    if (code === 'E_FORBIDDEN') {
      throw Object.assign(
        new Error(
          `${action}: "${capability}" is declared but was refused — the user who published this pack does not hold the "${capability}" permission. Republish under a user whose role holds it, or grant that role "${capability}". (${detail})`,
        ),
        { code },
      )
    }
    throw err
  }
}

/** `fs.list`'s own output shape, narrowed to what this module reads — same posture as `captions.ts`'s
 * `FsReadOutput`. */
const FsListOutput = z.object({
  entries: z.array(z.object({ path: z.string(), kind: z.enum(['file', 'dir']), hash: z.string().nullable() })),
})

/**
 * Lists `folder`'s immediate children through the broker and filters to video files (§4.5's flow,
 * step 1). Not recursive — `fs.list` itself is not (core's own `fs.ts` header calls it "the immediate
 * children"), and a folder of folders is not the workflow this plan builds.
 */
export async function listVideoCandidates(ctx: ScriptContext<unknown>, folder: string): Promise<VideoCandidate[]> {
  const listed = await withFarmErrorContext(ctx.farm.call('fs.list', { prefix: folder }, FsListOutput), 'fs.list', `cannot list the video folder "${folder}"`)
  return filterVideoFiles(listed.entries)
}

/** `fs.read`'s own output shape, narrowed — same posture as `captions.ts`'s `FsReadOutput`. */
const FsReadOutput = z.object({ content: z.string(), contentType: z.string() })

/**
 * Reads one video file's bytes through the broker. `fs.read` base64-encodes anything that is not a
 * text content type (plan 113's own correction #2 to this pack's understanding of the capability,
 * carried forward here for a binary file rather than a caption) — decoded once, here, rather than
 * trusted to whatever called this.
 */
export async function readVideoBytes(ctx: ScriptContext<unknown>, path: string): Promise<Uint8Array> {
  const file = await withFarmErrorContext(ctx.farm.call('fs.read', { path }, FsReadOutput), 'fs.read', `cannot read the video "${path}"`)
  if (looksLikeText(file.contentType)) return new TextEncoder().encode(file.content)
  return new Uint8Array(Buffer.from(file.content, 'base64'))
}

/**
 * Mints an artifact from the picked video's bytes (task instruction 2, plan 115 §3.6, §1 goal 4).
 * `ctx.artifact.file()` returning `{ artifactId }` instead of `void` is a change another worker is
 * landing under this same plan (step 115.5) — this module is written against that new contract, not
 * the `Promise<void>` it replaces. See this step's own report for whether it had landed by the time
 * this was typechecked.
 *
 * `ext` is passed WITHOUT its leading dot — `artifact-store.ts`'s own `save()` builds the filename as
 * `` `${...}.${extension}` ``, so a dot here would double up (`post-video-folder..mp4`). `path.slice`
 * is `+ 1` past the dot for exactly that reason.
 */
export async function mintVideoArtifact(ctx: ScriptContext<unknown>, path: string, bytes: Uint8Array): Promise<string> {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1) : undefined
  const minted = await ctx.artifact.file('post-video-folder', bytes, { ext })
  return minted.artifactId
}

/** Every `folder-posted:` record currently in `storage.global`, paged the same way `queue.ts`'s own
 * (unexported) `listAll` pages the queue — duplicated here rather than shared, since it is not
 * exported from that module. */
async function listAllPosted(kv: ScriptContext<unknown>['storage']['global']): Promise<KvListItem[]> {
  const items: KvListItem[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: FOLDER_POSTED_PREFIX, cursor })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return items
}

export async function readPostedMemory(ctx: ScriptContext<unknown>): Promise<Map<string, number>> {
  return parsePostedMemory(await listAllPosted(ctx.storage.global))
}

/**
 * Records that `hash` (found at `path` at the time it was posted) was just posted — the far side of
 * `pickVideoRandom`'s "prefer unposted" preference. Call this only once a post was actually
 * attempted (Post was tapped) — never on an earlier failure, so a file whose run never reached the
 * post screen stays exactly as eligible as it was before that run touched it.
 */
export async function recordVideoPosted(ctx: ScriptContext<unknown>, hash: string, path: string): Promise<void> {
  await ctx.storage.global.set(postedMemoryKey(hash), { version: 1, path, lastPostedAt: Math.floor(Date.now() / 1000) })
}

function videoCursorKey(folder: string): string {
  return `video-cursor:${folder}`
}

export interface ResolvedVideo {
  artifactId: string
  path: string
  hash: string
}

/**
 * The whole §4.5 flow for `source: 'folder'`: list, filter (both inside `listVideoCandidates`), pick,
 * read, mint. `pick`'s two modes reach different state: `random` consults §3.8's posted-memory;
 * `in-order` advances a plain farm-wide cursor keyed on the folder's own path, the same
 * `ctx.storage.global.increment` pattern `post-video.ts`'s own `nextCaptionIndex` already uses for the
 * captions cursor.
 *
 * Throws `E_FOLDER_EMPTY` on a folder with no video file — not `outcome: 'skipped'` the way an empty
 * queue is (queue.ts §3.3): an empty queue is an ordinary, expected state a content calendar passes
 * through; an empty video folder is a misconfiguration an operator needs to see and fix, and folding
 * it into the same silent "nothing to do this time" outcome the queue uses would bury it.
 */
export async function resolveVideoFromFolder(ctx: ScriptContext<unknown>, opts: { folder: string; pick: 'random' | 'in-order' }): Promise<ResolvedVideo> {
  const candidates = await listVideoCandidates(ctx, opts.folder)
  if (candidates.length === 0) {
    throw Object.assign(
      new Error(
        `no video file (${VIDEO_EXTENSIONS.join(', ')}) was found under "${opts.folder}" — upload one to the workspace before running this member with Source: folder`,
      ),
      { code: 'E_FOLDER_EMPTY' },
    )
  }

  const chosen =
    opts.pick === 'random'
      ? pickVideoRandom(candidates, await readPostedMemory(ctx))
      : pickVideoInOrder(candidates, (await ctx.storage.global.increment(videoCursorKey(opts.folder), 1)) - 1)

  const bytes = await readVideoBytes(ctx, chosen.path)
  const artifactId = await mintVideoArtifact(ctx, chosen.path, bytes)
  return { artifactId, path: chosen.path, hash: chosen.hash }
}
