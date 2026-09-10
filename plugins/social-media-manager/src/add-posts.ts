import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS } from './platforms'
import { PostSchema, newPost, postKeyFor, stateFor } from './posts'

/**
 * Twenty videos, one action.
 *
 * ## The problem this exists for
 *
 * `add-post` takes one video. An operator with twenty of them walks the same
 * dialog twenty times, choosing the same platforms and the same phones each
 * time — and the farm this is built for has a hundred devices, not two. The
 * fan-out to devices was never the hard part (the router already spreads
 * posts across free labelled phones, claiming each so two posts never land on
 * one phone in a tick); the hard part was making twenty rows without twenty
 * trips.
 *
 * ## Captions: one, or exactly one each
 *
 * `captions` is one per line. One line applies to every video; N lines pair
 * with N videos in the order they were chosen. **Anything else is refused**,
 * naming both counts.
 *
 * Refusing rather than cycling is deliberate. Reusing five captions across
 * twenty videos would put the same text on four accounts each, silently — and
 * "every device looks a little different" is the entire reason this farm
 * exists. An operator who genuinely wants one caption everywhere says so by
 * writing one line, which is unambiguous.
 *
 * ## Re-adding is safe
 *
 * A video that is already a post keeps every platform that has been dispatched
 * — the same carry-over rule `add-post` follows — because re-posting a video
 * to the same account is the one mistake this farm cannot take back. Adding
 * twenty videos twice creates twenty rows, not forty, and re-sends nothing.
 */

const params = z.object({
  videoArtifactIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('The uploaded videos to post. Upload them on the Files screen first.')
    .meta(ui({ title: 'Videos', kind: 'artifactIds', group: 'Post' })),
  captions: z
    .string()
    .min(1)
    .max(2_200 * 50)
    .describe('One caption per line. A single line is used for every video; otherwise there must be exactly one line per video.')
    .meta(ui({ title: 'Captions', group: 'Post' })),
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .min(1)
    .describe('Which platforms these videos are for. Each one sends to the phones carrying that platform\'s label.')
    .meta(ui({ title: 'Platforms', group: 'Post' })),
  /*
    `.optional()`, NOT `.default([])`.

    A Zod default still lands in the generated JSON Schema's `required` list,
    so a form that legitimately leaves this empty is refused before the member
    ever runs — "deviceIds: required" on a field whose whole point is that
    empty means "any phone carrying the label". Found by submitting the real
    form, not in review.
  */
  deviceIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Which phones these posts may go to. Leave empty for any phone carrying the platform’s label — a choice here narrows that fleet, it never widens it.')
    .meta(ui({ title: 'Phones', kind: 'deviceIds', group: 'Post' })),
})

const result = z.object({
  created: z.number().int().describe('How many new posts were written.').meta(ui({ title: 'Created', summary: true })),
  updated: z.number().int().describe('How many existing posts were updated instead of created.').meta(ui({ title: 'Updated', summary: true })),
  keys: z.array(z.string()).describe('The post rows written, in the order the videos were given.').meta(ui({ title: 'Rows' })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'add-posts',
  title: 'Add many posts',
  description:
    'Writes one post row per uploaded video — same platforms, same phones, a caption each. Nothing on any device is touched; the router sends them as phones come free.',
  icon: 'upload',
  params,
  result,
  /** N KV round trips and no device work at all; generous for a large batch. */
  timeout: 120_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { videoArtifactIds, captions, platforms, deviceIds } = ctx.params

    // Deduplicated BEFORE the caption count is checked, so "20 videos, 20
    // captions" is not silently satisfied by a list holding one video twice.
    const videos = [...new Set(videoArtifactIds)]
    const lines = captions
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')

    if (lines.length === 0) {
      throw Object.assign(new Error('No caption was given. Every post needs one — the upload flow refuses an empty caption on the device.'), {
        code: 'E_PARAMS_INVALID',
      })
    }
    if (lines.length !== 1 && lines.length !== videos.length) {
      throw Object.assign(
        new Error(
          `${videos.length} video${videos.length === 1 ? '' : 's'} but ${lines.length} caption lines. Give one line (used for every video) or exactly one line per video — reusing a few captions across many videos would put the same text on several accounts.`,
        ),
        { code: 'E_PARAMS_INVALID' },
      )
    }

    const now = Math.floor(Date.now() / 1000)
    const keys: string[] = []
    let created = 0
    let updated = 0

    for (const [index, videoArtifactId] of videos.entries()) {
      const caption = lines.length === 1 ? (lines[0] as string) : (lines[index] as string)
      const key = postKeyFor(videoArtifactId)

      // Read through the schema, which THROWS on a shape this build does not
      // understand. One unreadable row must not take the other nineteen down
      // with it, so this is caught per video and reported rather than thrown.
      const existing = await ctx.storage.global.get(key, PostSchema).catch(() => null)
      const next = newPost({ videoArtifactId, caption, platforms, deviceIds, now: existing?.createdAt ?? now })

      if (existing) {
        // Same carry-over rule as `add-post`: every platform that has already
        // been handed to phones keeps its state verbatim, so re-running this
        // action over the same twenty videos re-posts nothing.
        for (const id of next.platforms) {
          const carried = stateFor(existing, id)
          if (carried.state !== 'pending') next.dispatch[id] = carried
        }
        updated += 1
      } else {
        created += 1
      }

      await ctx.storage.global.set(key, next)
      keys.push(key)
    }

    ctx.log.info('bulk post rows written', {
      created,
      updated,
      videos: videos.length,
      platforms: platforms.join(','),
      phones: !deviceIds || deviceIds.length === 0 ? 'any labelled' : String(deviceIds.length),
    })
    return { created, updated, keys }
  },
}

export default script
