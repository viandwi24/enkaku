import { ui, type PluginMemberScript, type ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Post a video to TikTok — **declared, not implemented.**
 *
 * This member exists to prove the two workspace path parameters end to end: an
 * author declares them, the run form renders a real browser for each, and the
 * chosen paths arrive in `ctx.params` as ordinary strings. Everything after
 * that — reading the folder, picking a caption line, pushing the file to the
 * device, driving TikTok's upload flow — is deliberately absent, and `run()`
 * says so in the job log rather than pretending.
 *
 * ## Why it cannot do the work yet, stated so nobody wires it half-way
 *
 * A script cannot read the workspace at all. `ScriptContext` carries `device`,
 * `params`, `artifact`, `log`, `job`, `kv`, `jobs`, `onAssist` and `progress` —
 * there is no `ctx.workspace` and no `ctx.fs`. So this member can be TOLD where
 * the videos are and cannot open them.
 *
 * Two more things are missing behind that one, and both are decisions rather
 * than code:
 *
 * - **`ctx.device.push()` takes an `artifactId`, not a path** — so even given
 *   the bytes, putting a video on the phone needs either an artifact or a new
 *   API.
 * - **The workspace is sized for source, not media.** `workspace.maxFileBytes`
 *   defaults to 1 MiB and `maxTotalBytesPerScope` to 64 MiB; a single TikTok
 *   video is 5–50 MB. Holding video here means raising both by ~50× and
 *   streaming uploads, which turns a code store into a media store — the
 *   alternative being artifacts, which already do "a large binary that gets
 *   pushed to a device" and already have an upload endpoint.
 *
 * That choice is the farm owner's, and it is not made here.
 */

const params = z.object({
  videoFolder: z
    .string()
    .min(1)
    .describe('The workspace folder holding the videos to post. Upload them there first.')
    .meta(ui({ title: 'Video folder', kind: 'workspaceFolder', group: 'Source' })),

  captionsFile: z
    .string()
    .min(1)
    .describe('A plain-text file in the workspace, one caption per line. A line is picked per post.')
    .meta(ui({ title: 'Captions file', kind: 'workspaceFile', extensions: ['.txt'], group: 'Source' })),

  captionPick: z
    .enum(['random', 'in-order'])
    .default('random')
    .describe('How a line is chosen from the captions file.')
    .meta(ui({ title: 'Caption order', group: 'Source' })),
})

/**
 * Reports what it WOULD have used, and that it did nothing. `posted: false` is
 * not a placeholder to be flipped later — it is the honest answer for a run
 * that never touched the device, and a run reporting nothing at all would read
 * like a pass (the same reasoning `proxy-manager`'s `check` member applies to
 * its own `reachable: false`).
 */
const result = z.object({
  posted: z.boolean().describe('Always false — this member is a declaration, not an implementation.').meta(ui({ title: 'Posted', summary: true })),
  videoFolder: z.string().describe('The folder the operator chose.').meta(ui({ title: 'Video folder' })),
  captionsFile: z.string().describe('The captions file the operator chose.').meta(ui({ title: 'Captions file' })),
  captionPick: z.string().describe('The caption order the operator chose.').meta(ui({ title: 'Caption order' })),
  reason: z.string().describe('Why nothing happened.').meta(ui({ title: 'Reason', summary: true })),
})

const postVideo: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  title: 'Post a video (not implemented)',
  description:
    'Declares where videos and captions live in the workspace and does nothing else. It exists to demonstrate the folder and file pickers; posting is not built.',
  params,
  result,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const { videoFolder, captionsFile, captionPick } = ctx.params
    const reason = 'posting is not implemented: a script cannot read the workspace (ctx has no workspace/fs), and ctx.device.push takes an artifactId rather than a path'

    ctx.log.warn(`post-video did nothing — ${reason}`)
    ctx.log.info(`it would have read videos from "${videoFolder}" and captions from "${captionsFile}" (${captionPick})`)

    return { posted: false, videoFolder, captionsFile, captionPick, reason }
  },
}

export default postVideo
