import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { ASSIGNMENTS, GroupSchema, groupKeyFor, maxDevicesFor, newGroupId, shuffled } from './groups'
import { PLATFORM_IDS } from './platforms'
import { PostSchema, newPost, postKeyFor, stateFor } from './posts'

/**
 * One named upload session: forty videos, forty phones, started when the
 * operator says so.
 *
 * ## The session this is built for
 *
 * A folder of videos, one per phone, posted as a batch the operator can name
 * ("post hari Senin 14 Sep 2026"), watch as one thing, and retry as one thing.
 * `add-posts` already turns N videos into N rows; what it cannot express is
 * the three things that batch needs:
 *
 * - **one video per phone**, rather than each video to every labelled phone;
 * - **not all at once** — forty phones lighting up in the same second is the
 *   opposite of what this farm exists to look like;
 * - **held until Start**, because picking forty videos and posting them are
 *   two decisions, and the operator makes the second one deliberately.
 *
 * ## Nothing is sent by creating a group
 *
 * Every row lands with no schedule, which the router reads as "not started"
 * (`isRowDue`). `start-group` stamps the turns and the router does the rest.
 * So a group can be built up, looked at, and thrown away without a single
 * phone touching a platform.
 *
 * ## A video belongs to one row
 *
 * A post row is keyed by its video, so adding a video that already has a row
 * moves that row into this group and keeps every platform it has already been
 * dispatched to — the same carry-over `add-post`/`add-posts` use, and for the
 * same reason: re-posting a video to an account it already reached is the one
 * mistake this farm cannot take back.
 */

const params = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe('What this batch is called, in your words — it is how you will find it later.')
    .meta(ui({ title: 'Group title', group: 'Group' })),
  videoArtifactIds: z
    .array(z.string().min(1))
    .min(1)
    .describe('The uploaded videos in this batch. Upload them on the Files screen first.')
    .meta(ui({ title: 'Videos', kind: 'artifactIds', group: 'Group' })),
  captions: z
    .string()
    .min(1)
    .max(2_200 * 60)
    .describe('One caption per line. A single line is used for every video; otherwise exactly one line per video.')
    .meta(ui({ title: 'Captions', group: 'Group' })),
  platforms: z
    .array(z.enum(PLATFORM_IDS))
    .min(1)
    .describe('Which platforms this batch posts to. Each one sends to the phones carrying that platform\'s label.')
    .meta(ui({ title: 'Platforms', group: 'Group' })),
  assignment: z
    .enum(ASSIGNMENTS)
    .default('one-per-phone')
    .describe('Spread the batch one video per phone, or send every video to every phone carrying the label.')
    .meta(
      ui({
        title: 'How to spread it',
        group: 'Spread',
        labels: { 'one-per-phone': 'One video per phone (a folder of forty)', 'every-phone': 'Every video to every phone' },
      }),
    ),
  order: z
    .enum(['as-listed', 'random'])
    .default('random')
    .describe('The order the videos take their turn. Random is drawn once, when the group starts.')
    .meta(ui({ title: 'Order', group: 'Spread', labels: { 'as-listed': 'As listed', random: 'Shuffled' } })),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(4)
    .describe('How many of this group\'s videos may be uploading at the same moment.')
    .meta(ui({ title: 'At once', kind: 'count', group: 'Spread' })),
  gapMinSec: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(30)
    .describe('Shortest gap between one video\'s turn and the next.')
    .meta(ui({ title: 'Gap from (seconds)', kind: 'duration', unit: 's', group: 'Spread' })),
  gapMaxSec: z
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(90)
    .describe('Longest gap between one video\'s turn and the next. Each gap is drawn between the two.')
    .meta(ui({ title: 'Gap to (seconds)', kind: 'duration', unit: 's', group: 'Spread' })),
  deviceIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Which phones this batch may use. Leave empty for any phone carrying the platform\'s label; choose phones and those phones are used as chosen, labelled or not.')
    .meta(ui({ title: 'Phones', kind: 'deviceIds', group: 'Spread' })),
})

const result = z.object({
  groupId: z.string().describe('The group these videos joined.').meta(ui({ title: 'Group', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  created: z.number().int().describe('How many new post rows were written.').meta(ui({ title: 'Created', summary: true })),
  updated: z.number().int().describe('How many existing rows joined this group instead.').meta(ui({ title: 'Updated' })),
  keys: z.array(z.string()).describe('The rows written, in the order the videos were given.').meta(ui({ title: 'Rows' })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'add-group',
  title: 'New group',
  description:
    'Names a batch of uploaded videos and writes one post row per video, held until you press Start. Nothing is sent to a phone by creating it.',
  icon: 'upload',
  params,
  result,
  /** N KV round trips and no device work at all; generous for forty videos. */
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { title, videoArtifactIds, captions, platforms, assignment, order, concurrency, gapMinSec, gapMaxSec, deviceIds } = ctx.params

    // Deduplicated BEFORE the caption count is checked, so "40 videos, 40 captions"
    // is not silently satisfied by a list holding one video twice.
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
    const groupId = newGroupId(now)
    const group = GroupSchema.parse({
      version: 1,
      id: groupId,
      title: title.trim(),
      createdAt: now,
      platforms,
      assignment,
      pacing: { order, concurrency, gapSec: [Math.min(gapMinSec, gapMaxSec), Math.max(gapMinSec, gapMaxSec)] },
      videoArtifactIds: videos,
    })

    const keys: string[] = []
    let created = 0
    let updated = 0

    /*
      One video, one phone, decided HERE and kept (0.12.0).

      With a known phone pool and "one video per phone", each video is paired with a phone now: the
      pool is shuffled once and walked in video order, so the pairing is random but fixed, visible
      on the session's page before Start, and the phone every retry goes back to. It used to be
      decided at each turn by "whichever labelled phone is free", which on the owner's production
      farm put three videos of one session on the same phone and sent a retried video to a phone
      that had already posted another. Videos beyond the pool get no phone and are not sent — the
      router says so on the row — rather than doubling up on a phone that already has one.
    */
    const pairing = assignment === 'one-per-phone' && deviceIds && deviceIds.length > 0 ? shuffled([...new Set(deviceIds)], Math.random) : []

    for (const [index, videoArtifactId] of videos.entries()) {
      const caption = lines.length === 1 ? (lines[0] as string) : (lines[index] as string)
      const key = postKeyFor(videoArtifactId)

      // Read through the schema, which THROWS on a shape this build does not
      // understand. One unreadable row must not take the other thirty-nine
      // down with it, so this is caught per video and counted as new.
      const existing = await ctx.storage.global.get(key, PostSchema).catch(() => null)
      const next = newPost({ videoArtifactId, caption, platforms, deviceIds, now: existing?.createdAt ?? now })
      next.groupId = groupId
      // Held: no turn until `start-group` stamps one.
      next.notBeforeAt = null
      next.maxDevices = maxDevicesFor(assignment)
      next.assignedDeviceId = pairing[index] ?? null

      if (existing) {
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

    await ctx.storage.global.set(groupKeyFor(groupId), group)
    ctx.log.info('group written, held until Start', {
      groupId,
      title: group.title,
      videos: videos.length,
      created,
      updated,
      assignment,
      order,
      concurrency,
      gapSec: `${group.pacing.gapSec[0]}-${group.pacing.gapSec[1]}`,
      phones: !deviceIds || deviceIds.length === 0 ? 'any labelled' : String(deviceIds.length),
    })
    return { groupId, title: group.title, created, updated, keys }
  },
}

export default script
