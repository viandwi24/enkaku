import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { all, flatten, rowsById } from './tree'
import { YOUTUBE_PACKAGE, capture, centre, labelled, relaunch, sleep, waitForTree } from './youtube'

/**
 * `post-video` — upload one video as a YouTube Short, for the Social Media
 * Manager's router (it sends `{ source: 'direct', videoArtifactId, caption }`
 * to every platform's post member, exactly as it does to `tiktok/post-video`).
 *
 * ## Where every anchor came from
 *
 * One hand walk on the owner's moto g06 power (Android 15, id-ID, YouTube
 * signed in to a channel created that morning), 2026-09-11, each screen dumped
 * and checked into `__fixtures__/`. Nothing here was written from memory.
 *
 * | screen            | anchor                                          | fixture                          |
 * | ----------------- | ----------------------------------------------- | -------------------------------- |
 * | home              | bottom-bar `Buat` (desc)                         | screen-home.json                 |
 * | signed out        | "Login untuk mengakses…" + `Login` on Anda      | screen-signed-out.json           |
 * | create, no camera | `unified_permissions_primary_button`             | screen-create-no-camera.json     |
 * | gallery           | `thumb_image_view` desc = the FILE NAME          | screen-gallery.json              |
 * | gallery, picked   | `selected_state` inside the cell, `multi_select_next_button` | screen-gallery-selected.json |
 * | trim              | `creation_next_button` ("Selesai")               | screen-trim.json                 |
 * | Shorts editor     | `shorts_post_bottom_button` ("Berikutnya")       | screen-shorts-editor.json        |
 * | details           | NONE — see below                                 | screen-details-hidden.json       |
 * | You tab           | `Lihat channel` (desc)                           | screen-you.json                  |
 * | channel           | `Edit channel` (desc), cells below it            | screen-channel-draft.json        |
 *
 * The gallery naming its cells by file name is the best anchor this farm has
 * on any platform: the video is pushed under a name unique to this job, so the
 * cell tapped is provably the video meant — where TikTok's picker can only be
 * trusted to be sorted newest-first.
 *
 * ## Two screens the farm's reader cannot see
 *
 * Android 14+ lets an app mark a window "accessibility data sensitive", which
 * hides it from every accessibility service that is not a declared assistive
 * tool. Measured on the walk: both runtime-permission dialogs YouTube raises
 * (camera, then photos) and YouTube's own "Tambahkan detail" screen come back
 * from the guest agent's tree as NOTHING — the permission dialogs as no
 * YouTube node at all, the details screen as YouTube's `content` frame with no
 * children. `uiautomator` (a test instrumentation, which Android exempts) sees
 * both, which is how the details layout below was measured.
 *
 * The guest agent is NOT made to claim it is an assistive tool to get past
 * that. The flag exists so that a background service cannot quietly grant
 * itself permissions or act inside an app's sensitive screens; lying about
 * what the service is to defeat it is not a trade this pack makes. So:
 *
 * - **Permission dialogs** are answered ONCE per phone, by the operator: the
 *   camera "Jangan izinkan" (twice makes it permanent — uploads never need
 *   it), photos "Izinkan semua". A run that meets one stops with
 *   `E_PERMISSION_DIALOG_HIDDEN` and says which answer to give.
 * - **The details screen** is driven blind, the way `tiktok-automation-pack`
 *   already drives its two unreadable video screens: taps aimed from a layout
 *   measured on hardware, then the outcome proven on a screen that CAN be
 *   read — the channel's own video list.
 *
 * ## What `posted` means
 *
 * The channel page is read before the walk and again after Upload. Only a new
 * cell carrying this post's title, or a channel with more videos than before,
 * is `posted`. A cell still processing is worded as such and stays
 * `unverified`, as does anything the confirmation cannot read — never
 * `posted` on the strength of a tap.
 */

/**
 * The details screen, measured with `uiautomator` on the walk (720x1640, id-ID).
 * Fractions of the full frame so another resolution scales; the layout is a
 * top-anchored title and a bottom-anchored button bar.
 *
 * - title field: EditText `[192,190][699,258]` — centre (445, 224).
 * - Upload: `upload_bottom_button` `[370,1465][699,1535]` — centre x 534.
 *
 * The Upload y is 1480, not the centre, on purpose. Typing opens the farm's
 * own input method (a ~125px bar at the bottom); if YouTube resizes for it,
 * the button moves up to about `[..,1424][..,1494]`, and if it does not, the
 * bar covers the button below ~1515. y = 1480 is inside the button either way.
 */
const DETAILS_TITLE = { x: 445 / 720, y: 224 / 1640 }
const DETAILS_UPLOAD = { x: 534 / 720, y: 1480 / 1640 }

/** YouTube's title limit. A longer caption is cut, and the cut is logged. */
const TITLE_MAX = 100

const params = z.object({
  source: z
    .enum(['direct'])
    .default('direct')
    .describe('Where the video comes from. Only "direct" — the one artifact named below — exists for YouTube.')
    .meta(ui({ title: 'Source' })),
  videoArtifactId: z.string().min(1).describe('The uploaded video to post as a Short.').meta(ui({ title: 'Video', kind: 'artifact' })),
  caption: z.string().min(1).describe('Used as the Short\'s title (YouTube keeps the first 100 characters).').meta(ui({ title: 'Title' })),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Walk the whole flow and stop at the Upload button without pressing it. YouTube keeps what was entered as a draft.')
    .meta(ui({ title: 'Dry run' })),
})

const result = z.object({
  outcome: z.enum(['posted', 'unverified', 'failed']).meta(ui({ title: 'Outcome', summary: true })),
  videoArtifactId: z.string(),
  title: z.string(),
  remotePath: z.string().nullable().describe('Where the video was left on the device — nothing removes it.'),
  screens: z.array(z.string()).describe('The screens the run reached, in order.'),
  reason: z.string().nullable().meta(ui({ title: 'Reason', summary: true })),
})

type Screen = 'home' | 'create' | 'gallery' | 'trim' | 'editor' | 'details' | 'uploaded'

// ---------------------------------------------------------------------------
// Pure readings — each tested against the walk's fixtures.
// ---------------------------------------------------------------------------

const fromYouTube = (n: UiNode): boolean => n.packageName === YOUTUBE_PACKAGE

/** YouTube nodes that carry anything a person could read or press. */
function readableYouTubeNodes(tree: UiNode): UiNode[] {
  return all(tree, (n) => fromYouTube(n) && (n.text.trim() !== '' || n.desc.trim() !== '' || n.clickable))
}

/**
 * YouTube is in front but its window gave the reader nothing: the signature
 * of a window Android hides from accessibility services (see the header).
 * With no YouTube node at all it is a permission dialog over the app; with
 * YouTube's frame present and empty it is the details screen.
 */
export function hiddenWindow(tree: UiNode): 'none' | 'dialog' | 'details' {
  if (readableYouTubeNodes(tree).length > 0) return 'none'
  const anyYouTube = all(tree, fromYouTube).length > 0
  return anyYouTube ? 'details' : 'dialog'
}

/** The signed-out "You" page: a login pitch and a Login button, no channel. */
export function isSignedOut(tree: UiNode): boolean {
  const strings = all(tree, fromYouTube).map((n) => `${n.text} ${n.desc}`.toLowerCase())
  const pitch = strings.some((s) => s.includes('login untuk') || s.includes('sign in to'))
  const button = labelled(tree, 'Login').length > 0 || labelled(tree, 'Sign in').length > 0
  return pitch && button
}

/** The bottom-bar Create button — `Buat` in id-ID, `Create` in English. */
export function createButton(tree: UiNode): UiNode | null {
  return all(tree, (n) => fromYouTube(n) && n.clickable && (n.desc === 'Buat' || n.desc === 'Create'))[0] ?? null
}

/** The gallery cell for exactly this file, found by the name YouTube writes on its thumbnail. */
export function galleryCellFor(tree: UiNode, fileName: string): UiNode | null {
  return rowsById(tree, 'thumb_image_view').find((n) => n.desc === fileName) ?? null
}

/** True when the gallery shows a selection badge inside `cell`'s bounds. */
export function isSelectedCell(tree: UiNode, cell: UiNode): boolean {
  const b = cell.bounds
  return rowsById(tree, 'selected_state').some((s) => s.bounds.left >= b.left && s.bounds.right <= b.right && s.bounds.top >= b.top && s.bounds.bottom <= b.bottom)
}

/** Labels YouTube puts on a cell that is not a published video. */
const NOT_A_VIDEO = ['Draf', 'Drafts', 'Draft']

/**
 * The channel page's video cells, top-left first, each as the words it carries.
 *
 * A cell is a clickable node below the header's `Edit channel` button, above
 * the bottom bar, between a fifth and a half of the frame wide. Drafts are
 * left out — the walk itself left one, and a draft is exactly the thing that
 * must never be mistaken for a post.
 */
export function readChannelCells(tree: UiNode, frameWidth: number): string[] {
  const header = labelled(tree, 'Edit channel')[0] ?? labelled(tree, 'Edit saluran')[0]
  const bar = labelled(tree, 'Beranda')[0] ?? labelled(tree, 'Home')[0]
  const top = header ? header.bounds.bottom : 0
  const bottom = bar ? bar.bounds.top : Number.POSITIVE_INFINITY
  const words = (n: UiNode): string =>
    flatten(n)
      .flatMap((m) => [m.desc.trim(), m.text.trim()])
      .filter((s) => s !== '')
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .join(' · ')
  return all(tree, (n) => {
    if (!fromYouTube(n) || !n.clickable) return false
    if (n.bounds.top < top || n.bounds.bottom > bottom) return false
    const w = (n.bounds.right - n.bounds.left) / frameWidth
    return w >= 0.2 && w <= 0.5 && n.bounds.bottom - n.bounds.top > 100
  })
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
    .map(words)
    .filter((s) => s !== '' && !NOT_A_VIDEO.includes(s.split(' · ')[0] as string))
}

/** Lowercased, hashtags' `#` dropped, whitespace collapsed — how a title is compared to a cell's words. */
function norm(s: string): string {
  return s.toLowerCase().replace(/#/g, '').replace(/\s+/g, ' ').trim()
}

const IN_FLIGHT = /mengupload|uploading|memproses|processing|\b\d{1,3}\s?%/i

export type ChannelJudgement = { kind: 'new'; via: 'title' | 'count' } | { kind: 'processing'; words: string } | { kind: 'same' } | { kind: 'unreadable' }

/**
 * Did THIS post appear on the channel? `before` is the reading taken before the
 * walk (`null` when it could not be read), `after` the reading now.
 */
export function judgeChannel(before: string[] | null, after: string[] | null, title: string): ChannelJudgement {
  if (after === null) return { kind: 'unreadable' }
  const want = norm(title).slice(0, 40)
  const fresh = after.filter((cell) => before === null || !before.includes(cell))
  const titled = fresh.find((cell) => want !== '' && norm(cell).includes(want))
  if (titled && !IN_FLIGHT.test(titled)) return { kind: 'new', via: 'title' }
  const busy = fresh.find((cell) => IN_FLIGHT.test(cell))
  if (busy) return { kind: 'processing', words: busy }
  if (titled) return { kind: 'processing', words: titled }
  if (before !== null && after.length > before.length) return { kind: 'new', via: 'count' }
  return { kind: 'same' }
}

/** True when the caption's last token is a hashtag or mention — the case that can leave a suggestion list open. */
export function endsInTagToken(caption: string): boolean {
  return /(^|\s)[#@][^\s#@]+$/.test(caption)
}

/** The frame the tree describes — the widest/tallest bounds in it, since a root can arrive as 0,0,0,0. */
function frameOf(tree: UiNode): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const n of flatten(tree)) {
    width = Math.max(width, n.bounds.right)
    height = Math.max(height, n.bounds.bottom)
  }
  return { width: width || 720, height: height || 1640 }
}

// ---------------------------------------------------------------------------
// Device steps.
// ---------------------------------------------------------------------------

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

async function tapCentre(ctx: ScriptContext<unknown>, node: UiNode): Promise<void> {
  await ctx.device.tap({ point: centre(node) })
}

/** Poll for a node by short id; returns it with the tree it was found in. */
async function waitForId(ctx: ScriptContext<unknown>, shortId: string, budgetMs: number): Promise<{ node: UiNode | null; tree: UiNode }> {
  const got = await waitForTree(ctx, (t) => rowsById(t, shortId).length > 0, { budgetMs })
  return { node: rowsById(got.tree, shortId)[0] ?? null, tree: got.tree }
}

/**
 * Open the own channel page and read its cells. Never throws: a failed reading
 * is not evidence about the post, and the caller words it as such.
 */
async function readOwnChannel(ctx: ScriptContext<unknown>, label: string): Promise<string[] | null> {
  try {
    const you = await waitForTree(ctx, (t) => labelled(t, 'Anda').length > 0 || labelled(t, 'You').length > 0, { budgetMs: 15_000 })
    const tab = labelled(you.tree, 'Anda').find((n) => n.clickable) ?? labelled(you.tree, 'You').find((n) => n.clickable)
    if (!tab) return null
    await tapCentre(ctx, tab)
    const page = await waitForTree(ctx, (t) => labelled(t, 'Lihat channel').length > 0 || labelled(t, 'View channel').length > 0 || isSignedOut(t), { budgetMs: 15_000 })
    if (isSignedOut(page.tree)) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account that should post (and create its channel), then re-run.')
    const view = labelled(page.tree, 'Lihat channel').find((n) => n.clickable) ?? labelled(page.tree, 'View channel').find((n) => n.clickable)
    if (!view) return null
    await tapCentre(ctx, view)
    const channel = await waitForTree(ctx, (t) => labelled(t, 'Edit channel').length > 0, { budgetMs: 15_000 })
    await sleep(1_500) // the cells arrive after the header
    const tree = await capture(ctx, label)
    return channel.ok ? readChannelCells(tree, frameOf(tree).width) : null
  } catch (err) {
    if ((err as { code?: string }).code === 'E_NOT_SIGNED_IN') throw err
    ctx.log.warn('could not read the own channel page', { error: String(err) })
    return null
  }
}

const PERMISSION_HELP =
  'answer it once on the phone — camera: "Jangan izinkan" (uploads never need it; a second refusal makes it permanent), photos and videos: "Izinkan semua" — then re-run. Android hides these dialogs from the farm\'s reader, so a run cannot answer them.'

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'post-video',
  icon: 'upload',
  node: { category: 'device', icon: 'upload', summary: ['caption'], keywords: ['youtube', 'shorts', 'upload', 'post'] },
  title: 'Post a Short',
  description: 'Uploads one video from Files as a YouTube Short with the caption as its title, then confirms it on the channel page.',
  params,
  result,
  timeout: 10 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const screens: Screen[] = []
    let title = ctx.params.caption.replace(/\s+/g, ' ').trim()
    if (title.length > TITLE_MAX) {
      ctx.log.warn(`caption is longer than YouTube's ${TITLE_MAX}-character title — the rest was cut`, { length: title.length })
      title = title.slice(0, TITLE_MAX).trim()
    }

    const home = await capture(ctx, 'yt-01-home')
    // The details screen is driven by taps measured in PORTRAIT. On landscape
    // those points land on other controls — "Simpan draf" among them — so a
    // landscape screen stops the run before anything is touched. Observed on
    // the owner's moto (2026-09-11): lying on its side, the system re-enabled
    // auto-rotate on every YouTube launch, over the farm's own portrait lock.
    const homeFrame = frameOf(home)
    if (homeFrame.width > homeFrame.height) {
      fail('E_SCREEN_LANDSCAPE', `YouTube opened in landscape (${homeFrame.width}x${homeFrame.height}). Stand the phone upright or lock it to portrait, then re-run — this flow taps positions measured in portrait.`)
    }
    if (!createButton(home)) {
      // The signed-out app has no Create button at all; say which, rather than "anchor not found".
      const you = labelled(home, 'Anda').find((n) => n.clickable)
      if (you) {
        await tapCentre(ctx, you)
        const page = await waitForTree(ctx, isSignedOut, { budgetMs: 8_000 })
        if (page.ok) fail('E_NOT_SIGNED_IN', 'YouTube on this phone is signed out. Sign in to the account that should post (and create its channel), then re-run.')
      }
      fail('E_ANCHOR_NOT_FOUND', 'YouTube\'s bottom bar has no Create ("Buat") button — see artifact yt-01-home.')
    }
    screens.push('home')

    const remotePath = `/sdcard/DCIM/Camera/yt-${ctx.job.id}-${ctx.job.attempt}.mp4`
    const fileName = remotePath.slice(remotePath.lastIndexOf('/') + 1)
    await ctx.device.push({ artifactId: ctx.params.videoArtifactId, remotePath, mediaScan: 'auto' })

    // The baseline the confirmation compares against. A dry run posts nothing and skips it.
    const before = ctx.params.dryRun ? null : await readOwnChannel(ctx, 'yt-02-channel-before')
    ctx.log.info('read the channel before posting', { cells: before === null ? 'unreadable' : String(before.length) })

    // --- Create -> gallery ----------------------------------------------------
    const bar = await waitForTree(ctx, (t) => createButton(t) !== null, { budgetMs: 10_000 })
    const create = createButton(bar.tree)
    if (!create) fail('E_ANCHOR_NOT_FOUND', 'the Create ("Buat") button was not found after reading the channel.')
    await tapCentre(ctx, create)
    screens.push('create')

    const opened = await waitForTree(
      ctx,
      (t) => rowsById(t, 'unified_permissions_primary_button').length > 0 || rowsById(t, 'gallery_header_create_title').length > 0 || hiddenWindow(t) === 'dialog',
      { budgetMs: 12_000 },
    )
    await capture(ctx, 'yt-03-create', opened.tree)
    if (hiddenWindow(opened.tree) === 'dialog') fail('E_PERMISSION_DIALOG_HIDDEN', `YouTube is asking for a permission (the camera, on Create) — ${PERMISSION_HELP}`)
    const fromGallery = rowsById(opened.tree, 'unified_permissions_primary_button')[0]
    if (fromGallery) {
      await tapCentre(ctx, fromGallery)
    } else if (rowsById(opened.tree, 'gallery_header_create_title').length === 0) {
      fail(
        'E_ANCHOR_NOT_FOUND',
        'Create did not show "Tambahkan dari Galeri". This flow was walked with the camera refused; a phone that granted YouTube the camera shows a different screen — see artifact yt-03-create.',
      )
    }

    const gallery = await waitForTree(ctx, (t) => rowsById(t, 'gallery_header_create_title').length > 0 || hiddenWindow(t) === 'dialog', { budgetMs: 12_000 })
    if (hiddenWindow(gallery.tree) === 'dialog') fail('E_PERMISSION_DIALOG_HIDDEN', `YouTube is asking for access to photos and videos — ${PERMISSION_HELP}`)
    if (!gallery.ok) {
      await capture(ctx, 'yt-04-gallery', gallery.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the gallery did not open after "Tambahkan dari Galeri" — see artifact yt-04-gallery.')
    }

    // The pushed file is the newest, so its cell is on the first screen; the scan can lag a moment.
    const found = await waitForTree(ctx, (t) => galleryCellFor(t, fileName) !== null, { budgetMs: 10_000 })
    const galleryTree = await capture(ctx, 'yt-04-gallery', found.tree)
    const cell = galleryCellFor(galleryTree, fileName)
    if (!cell) fail('E_GALLERY_ITEM_NOT_FOUND', `the gallery has no cell named "${fileName}" — the pushed video did not appear. See artifact yt-04-gallery.`)
    await tapCentre(ctx, cell)
    const picked = await waitForTree(ctx, (t) => {
      const c = galleryCellFor(t, fileName)
      return c !== null && isSelectedCell(t, c) && rowsById(t, 'multi_select_next_button').length > 0
    }, { budgetMs: 8_000 })
    if (!picked.ok) {
      await capture(ctx, 'yt-05-picked', picked.tree)
      fail('E_ANCHOR_NOT_FOUND', `tapped "${fileName}" but the gallery did not mark it selected — see artifact yt-05-picked.`)
    }
    await tapCentre(ctx, rowsById(picked.tree, 'multi_select_next_button')[0] as UiNode)
    screens.push('gallery')

    // --- trim -> editor -> details --------------------------------------------
    const trim = await waitForId(ctx, 'creation_next_button', 20_000)
    if (!trim.node) {
      await capture(ctx, 'yt-06-trim', trim.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the trim screen ("Selesai") did not appear — see artifact yt-06-trim.')
    }
    await tapCentre(ctx, trim.node)
    screens.push('trim')

    const editor = await waitForId(ctx, 'shorts_post_bottom_button', 20_000)
    if (!editor.node) {
      await capture(ctx, 'yt-07-editor', editor.tree)
      fail('E_ANCHOR_NOT_FOUND', 'the Shorts editor\'s "Berikutnya" did not appear — see artifact yt-07-editor.')
    }
    await tapCentre(ctx, editor.node)
    screens.push('editor')

    const details = await waitForTree(ctx, (t) => hiddenWindow(t) === 'details', { budgetMs: 15_000 })
    await ctx.artifact.screenshot('yt-08-details')
    if (!details.ok) fail('E_ANCHOR_NOT_FOUND', 'the details screen did not open after the editor — see artifact yt-08-details.')
    screens.push('details')

    // --- the blind part (see the header) ---------------------------------------
    const frame = frameOf(details.tree)
    await ctx.device.tap({ point: { x: Math.round(frame.width * DETAILS_TITLE.x), y: Math.round(frame.height * DETAILS_TITLE.y) } })
    await sleep(800)
    await ctx.device.type(title)
    if (endsInTagToken(title)) await ctx.device.type(' ')
    await sleep(1_000)
    await ctx.artifact.screenshot('yt-09-titled')

    if (ctx.params.dryRun) {
      return {
        outcome: 'unverified' as const,
        videoArtifactId: ctx.params.videoArtifactId,
        title,
        remotePath,
        screens,
        reason: 'dry run: the title was entered and the run stopped before Upload. YouTube keeps it as a draft on the channel.',
      }
    }

    await ctx.device.tap({ point: { x: Math.round(frame.width * DETAILS_UPLOAD.x), y: Math.round(frame.height * DETAILS_UPLOAD.y) } })
    ctx.log.info('tapped Upload — confirming on the channel rather than trusting the tap')

    // A tap that took leaves the details screen. One that did not leaves it in
    // place, and then nothing was uploaded — a failure a retry may safely repeat.
    const left = await waitForTree(ctx, (t) => hiddenWindow(t) !== 'details', { budgetMs: 20_000 })
    if (!left.ok) {
      await ctx.artifact.screenshot('yt-10-still-details')
      fail('E_UPLOAD_TAP_NOT_TAKEN', 'Upload was tapped but YouTube stayed on the details screen, so nothing was uploaded. See artifact yt-10-still-details.')
    }
    screens.push('uploaded')
    await capture(ctx, 'yt-10-after-upload', left.tree)

    // --- confirmation ------------------------------------------------------------
    let last: ChannelJudgement = { kind: 'unreadable' }
    for (let round = 0; round < 6; round++) {
      if (round > 0) {
        await relaunch(ctx, { clearRecents: false })
      }
      const after = await readOwnChannel(ctx, `yt-11-channel-after-${round + 1}`)
      last = judgeChannel(before, after, title)
      if (last.kind === 'new') {
        return {
          outcome: 'posted' as const,
          videoArtifactId: ctx.params.videoArtifactId,
          title,
          remotePath,
          screens,
          reason: last.via === 'title' ? 'a new cell with this title appeared on the channel page' : 'the channel page shows one more video than before this run',
        }
      }
      ctx.log.warn(`the channel does not show this Short yet (attempt ${round + 1}/6)`, { judged: JSON.stringify(last) })
      await sleep(10_000)
    }
    const saw =
      last.kind === 'processing'
        ? `it was still processing ("${last.words.slice(0, 80)}") — uploaded, not yet live.`
        : last.kind === 'same'
          ? 'the channel page was as it was before Upload was tapped.'
          : 'the channel page could not be read.'
    return {
      outcome: 'unverified' as const,
      videoArtifactId: ctx.params.videoArtifactId,
      title,
      remotePath,
      screens,
      reason: `Upload was tapped and YouTube left the details screen, but after ~2 minutes ${saw} Reporting "unverified" rather than assuming it posted.`,
    }
  },

  async finish(ctx) {
    if (!ctx.error) return undefined
    await ctx.artifact.screenshot('yt-failed').catch(() => {})
    // A permission dialog is left on screen for the operator to answer; anything else is closed.
    if (ctx.error.code !== 'E_PERMISSION_DIALOG_HIDDEN') {
      await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true }).catch(() => {})
    }
    return undefined
  },
}

export default script
