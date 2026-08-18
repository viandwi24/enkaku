import type { ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Reading a captions file from the workspace (plan 113 §4.5, step 113.8).
 *
 * `ctx.farm.call('fs.read', …)` is the only door onto the workspace a script has (C2) — there is
 * still no `ctx.fs`. Every call through it is checked TWICE (`farm-broker.ts`'s own header): first
 * against this pack's `defineService({ permissions })` list, before the capability even runs, then
 * by the farm's real ACL under the publishing user's role. Both checks can refuse a call the caller
 * did nothing wrong to deserve, and `readCaptionsFile` exists to turn each refusal into a sentence an
 * operator watching a failed job can actually act on, rather than a bare error code.
 */

/**
 * `fs.read`'s own predicate for "is this content text or base64" (`packages/core/src/capability/
 * fs.ts`'s private `isTextContentType`) — duplicated here rather than imported, because it is not
 * exported and a plugin cannot reach into core's internals anyway (cross-package imports go through
 * a package name, and core is not one this pack depends on). This is the ONLY way, from the script
 * side, to tell whether `content` below came back as real UTF-8 text or as base64: the capability
 * decodes text types and base64-encodes everything else, and the string itself does not say which.
 */
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

/**
 * `fs.read`'s output shape, declared again here rather than imported from core — `FarmApi.call`'s own
 * doc comment (`packages/sdk/src/runtime.ts`) says why: the farm's output schema can change under a
 * plugin published months ago, so the CALLER validates against its own expectation instead of
 * trusting whatever shape the farm answers with today. Only the two fields this module reads are
 * kept; the rest of `fs.read`'s real output (hash, size, timestamps, …) would be dead weight here.
 */
const FsReadOutput = z.object({
  content: z.string(),
  contentType: z.string(),
})

export interface CaptionSource {
  path: string
  lines: string[]
}

/**
 * Reads one workspace text file and turns it into non-empty, trimmed lines — one caption per line.
 * Blank lines are dropped so an operator's own spacing in the file never turns into an empty caption
 * being posted.
 *
 * ## The three refusals this WILL hit, and what each one means (plan 113 §0.3 C3–C5, §8)
 *
 * - **`E_FARM_UNDECLARED`** — this pack was published before step 113.5 added
 *   `service: defineService({ permissions: ['fs.read'] })` to its manifest. Fix: republish the pack
 *   (`bun run publish:farm` from `plugins/tiktok-automation-pack`) so the running copy carries the
 *   declaration.
 * - **`E_FARM_NO_PLUGIN`** — the script is running from a dev slot (`enkaku dev`). A dev slot shadows
 *   the active plugin's tier-B assets but NOT its service declaration (`farm-broker.ts`'s own
 *   documented "Known gap"), so there is nothing to check `fs.read` against yet. Fix: publish the
 *   pack once, then iterate against the published version — this is a hard ordering constraint, not
 *   a preference.
 * - **`E_FORBIDDEN`** — `fs.read` IS declared, but the farm re-checks it live against the publishing
 *   user's own role (`farm-broker.ts`'s `roleOf`) and that role does not hold it. Fix: republish the
 *   pack under a user whose role holds `fs.read`, or grant that role the permission — a manifest
 *   listing a permission is never sufficient on its own.
 *
 * Every other rejection (`E_OUT_OF_SCOPE`, `E_FARM_SCHEMA_MISMATCH`, …) already names its own fix and
 * is rethrown unchanged.
 */
export async function readCaptionsFile(ctx: ScriptContext<unknown>, path: string): Promise<CaptionSource> {
  let file: z.infer<typeof FsReadOutput>
  try {
    file = await ctx.farm.call('fs.read', { path }, FsReadOutput)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    const detail = err instanceof Error ? err.message : String(err)
    if (code === 'E_FARM_UNDECLARED') {
      throw Object.assign(
        new Error(
          `cannot read captions file "${path}": this pack has not declared "fs.read" — add service: defineService({ permissions: ['fs.read'] }) to the plugin (step 113.5) and republish it. (${detail})`,
        ),
        { code },
      )
    }
    if (code === 'E_FARM_NO_PLUGIN') {
      throw Object.assign(
        new Error(
          `cannot read captions file "${path}": this member is running from a dev slot, which has no published service for "fs.read" to be checked against — publish the pack once (\`bun run publish:farm\`) and run this member from the published version. (${detail})`,
        ),
        { code },
      )
    }
    if (code === 'E_FORBIDDEN') {
      throw Object.assign(
        new Error(
          `cannot read captions file "${path}": "fs.read" is declared but was refused — the user who published this pack does not hold the "fs.read" permission. Republish under a user whose role holds it, or grant that role "fs.read". (${detail})`,
        ),
        { code },
      )
    }
    throw err
  }

  if (!looksLikeText(file.contentType)) {
    // fs.read base64-encodes anything that is not a text content type (packages/core/src/capability/
    // fs.ts's decodeContent) — posting that string as-is would post binary garbage as a caption with
    // no error anywhere. Refuse instead of guessing.
    throw new Error(
      `captions file "${path}" is not plain text (content type "${file.contentType}") — fs.read returns a non-text file base64-encoded rather than as UTF-8, and this pack will not post that as a caption. Upload a real .txt file`,
    )
  }

  const lines = file.content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    // An empty file is an error, not an empty caption (plan 113 §4.5 step 113.8) — a queued item
    // whose caption came back "" would post with no caption at all and no run would ever notice.
    throw new Error(`captions file "${path}" has no usable lines — it is empty, or every line is blank`)
  }

  return { path, lines }
}

/**
 * Picks one caption from an already-read source. Pure — no `ctx`, no device, no farm call — so
 * `in-order` cycling is testable without hardware, the same reason `modals.ts`'s register and sweep
 * are pure over a dumped tree (plan 113 §5 step 113.1).
 *
 * `cursor` names the line to use NEXT and wraps modulo `source.lines.length`, so a queue that
 * outlives the file (more posts than caption lines) starts back over instead of throwing. `random`
 * ignores `cursor` for the pick itself but still returns a `nextCursor`, so a caller can thread the
 * return value through unconditionally regardless of which `pick` mode is active.
 */
export function pickCaption(source: CaptionSource, pick: 'in-order' | 'random', cursor: number): { caption: string; nextCursor: number } {
  const count = source.lines.length
  if (count === 0) {
    // Defensive: readCaptionsFile never returns an empty source, but this function is exported and
    // pure, so it must not silently hand back an empty string to a caller that built a CaptionSource
    // some other way (a test, most obviously) and skipped that guard.
    throw new Error(`cannot pick a caption: "${source.path}" has no lines`)
  }
  const index = pick === 'random' ? Math.floor(Math.random() * count) : (((cursor % count) + count) % count)
  return { caption: source.lines[index] as string, nextCursor: (index + 1) % count }
}
