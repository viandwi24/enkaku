import type { PluginMemberScript } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import type { UiNode } from '@enkaku/protocol'
import { z } from 'zod'
import { YOUTUBE_PACKAGE, capture, firstMatch, relaunch, sleep, tapNode, waitForTree } from './youtube'
import { SEARCH_ENTRY, SEARCH_FIELD, openSearchField, adEvidence, clickableFor, hasResultRows, playerEvidence, resultRowsOf, skipControlOf, titleFromRow } from './search-channel'
import { between, browseComments, keywordBoost, makeRng, pickWatchMs, pressLike, readableStrings, scrollCommentsRandomised, frameOf } from './behavior'

/**
 * `watch-video` — search for a video and watch it with human-like behavior.
 *
 * Searches for a keyword, picks a video (random or top), watches it with
 * human-like dwell times, and optionally interacts with like/comment features.
 * The behavior mimics real human watching patterns with varied watch times,
 * random interactions, and natural scrolling patterns.
 */

/** How long to let the result list grow before picking from it, and how often to look. */
const SETTLE_BUDGET_MS = 12_000
const SETTLE_STEP_MS = 800
/** Below this many real videos the page is still loading, whatever the count did between two looks. */
const SETTLE_MIN_ROWS = 5
/** How long one video is watched when a minimum was asked for — a long-video range, not the Shorts dwell table. */
const LONG_WATCH_MIN_MS = 35_000
const LONG_WATCH_MAX_MS = 95_000
/**
 * How much of the job's own timeout a run may spend before it stops opening
 * new videos, and what one more round is assumed to cost.
 *
 * A round is a search, a settle, a player wait, possibly a minute of advert,
 * the watch itself and a relaunch — up to about three and a half minutes at
 * its worst. Six of those is over twenty minutes inside a member whose
 * `timeout` is fifteen, and a run killed at the timeout reports a bare failure
 * that throws away everything it watched. So the run watches the clock itself
 * and stops while it can still report.
 */
const RUN_BUDGET_MS = 11 * 60_000
const ROUND_COST_MS = 3.5 * 60_000

const paramsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What to search for.')
    .meta(ui({ title: 'Search query' })),
  pick: z
    .enum(['random', 'top'])
    .default('random')
    .describe('Play a random video from the first page of ranked results, or the top result.')
    .meta(ui({ title: 'Which result', labels: { random: 'Random from the first page', top: 'The top result' } })),
  skipAds: z.boolean().default(true).describe('Press YouTube\'s own "Skip ad" control when it appears. Only that button.').meta(ui({ title: 'Skip skippable ads' })),
  likeProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Chance to press like during the watch. A signed-out device reports `not-signed-in`.')
    .meta(ui({ title: 'Like chance' })),
  commentProbability: z
    .number()
    .min(0)
    .max(1)
    .default(0.05)
    .describe('Chance to open the comment section, scroll it, and close it. Reading only.')
    .meta(ui({ title: 'Comment chance' })),
  keywordBoostFactor: z
    .number()
    .min(1)
    .max(10)
    .default(3)
    .describe('Multiplier applied to like/comment chance when a keyword matches the video title or channel.')
    .meta(ui({ title: 'Keyword boost' })),
  keywords: z.array(z.string()).default([]).describe('Keywords to tilt behaviour toward; the title read off the result row is what gets matched.').meta(ui({ title: 'Keywords' })),
  queries: z
    .array(z.string().min(1).max(120))
    .max(20)
    .default([])
    .describe('More things to search for. Each video this run opens draws one of these (or the query above), so a phone does not search the same words every time.')
    .meta(ui({ title: 'More queries' })),
  minWatchMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60_000)
    .default(0)
    .describe('Keep opening videos until this much has been watched in total. A short video is not stretched — another one is opened. 0 watches exactly one video.')
    .meta(ui({ title: 'Watch at least (ms)' })),
  maxWatchMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60_000)
    .default(0)
    .describe('Never watch longer than this in total, whatever the minimum says. 0 leaves it to the dwell model.')
    .meta(ui({ title: 'Watch at most (ms)' })),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('The most videos one run may open while working toward the minimum.')
    .meta(ui({ title: 'Most videos' })),
  seed: z.number().int().min(0).default(0).describe('RNG seed; 0 derives one per run.').meta(ui({ title: 'Seed (0 = random)' })),
})

const resultSchema = z.object({
  query: z.string().meta(ui({ title: 'Query' })),
  resultCount: z.number().int().describe('How many result rows the first page showed.').meta(ui({ title: 'Results' })),
  pickedRank: z.number().int().describe('1-based rank of the row that was opened. Always 1 when `pick` was `top`.').meta(ui({ title: 'Picked rank', summary: true })),
  played: z.boolean().describe('Whether a player was confirmed on screen.').meta(ui({ title: 'Played', summary: true })),
  videoTitle: z.string().describe('The video that opened, read off its own row before the tap.').meta(ui({ title: 'Video', summary: true })),
  playEvidence: z.string().describe('What proved the video was playing, and whether an advert ran first.').meta(ui({ title: 'Evidence' })),
  like: z.string().describe('Outcome of the like attempt, or `not attempted`.').meta(ui({ title: 'Like' })),
  comments: z.string().describe('Outcome of the comment visit, or `not attempted`.').meta(ui({ title: 'Comments' })),
  watchTime: z.number().int().describe('How long was watched in total, across every video this run opened (ms).').meta(ui({ title: 'Watch time', summary: true })),
  videosWatched: z.number().int().describe('How many videos it took to reach the minimum.').meta(ui({ title: 'Videos', summary: true })),
  /* False when a round could not open a video and the run stopped with what it had — `steps` says which round and why. */
  reachedMinimum: z.boolean().describe('Whether the minimum watch time was met.').meta(ui({ title: 'Reached minimum', summary: true })),
  videos: z.array(z.string()).describe('Each video, with how long it was watched.').meta(ui({ title: 'Watched' })),
  steps: z.array(z.string()).meta(ui({ title: 'Steps' })),
})

/** Toolbar and filter-chip labels that `resultRowsOf` also matches. Not results, in any locale this pack has met. */
const CHROME_LABELS = /^(more options|more actions|navigate up|clear|voice search|search|filters|shorts|unwatched|watched|videos|recently uploaded|view channel|community|subscribe)$/i

/*
  A video result says how long it is, how many times it was watched, or how
  long ago it went up. Each pattern is anchored on a DIGIT, and that is not
  fussiness: an unanchored `views?` matched "View Channel", so a run picked a
  channel card, tapped it, and opened the channel instead of a player
  (moto g06 power, 2026-09-20). The words around the number are localised and
  the number is not.
*/
/*
  And in BOTH languages the fleet runs (2026-09-21). These three were measured on the moto in
  `en-US`, and the owner's production phones — SM-A075F, `id-ID` — write every one of them
  differently. A real result row there reads:

    Trading Modal $100 Profit $12/Hari | AYQ 230 - 9 menit, 49 detik - Buka channel … -
    6,4 ribu x ditonton - 13 jam yang lalu - putar video

  with a duration badge drawn as `9.49` (a DOT, not a colon) and a meta line that says `6,4 rb`
  where the description says `6,4 ribu`. Not one of the English patterns matched any of it, so every
  row was judged "not a video", and `watch-video` failed 10 runs in 10 with "0 of 13 rows are
  videos" on a results page full of videos. Every pattern is still anchored on a digit.
*/
const HAS_DURATION = /\b\d{1,2}[:.]\d{2}\b|\b\d+\s+(?:menit|detik|minutes?|seconds?)\b/i
const HAS_VIEWS = /\d[\d.,]*\s*(?:k|m|b|rb|jt|ribu|juta|miliar|thousand|million|billion)?\s*(?:x\s+)?(?:views?|ditonton|penayangan)\b/i
const HAS_AGE = /\d+\s*\w*\s+(?:ago|(?:yang\s+)?lalu)\b/i

/** Every readable string inside a row, in tree order. */
function readableOf(row: UiNode): string[] {
  const out: string[] = []
  const walk = (node: UiNode): void => {
    out.push(node.text ?? '', node.desc ?? '')
    for (const child of node.children ?? []) walk(child)
  }
  walk(row)
  return out.filter((value) => value.trim() !== '')
}

/**
 * Is this row a video worth opening?
 *
 * ## Why the question is "is it a video" and not "is it an advert"
 *
 * Measured on the owner's moto g06 power (2026-09-20). A round tapped a result
 * and the phone left YouTube entirely for an advertiser's ebook sign-up form.
 * The obvious fix — skip rows labelled `Sponsored` — did not work, and reading
 * the captured tree showed why: on a half-loaded results page `resultRowsOf`
 * returns the sponsored card's own SUB-nodes as rows. A search for
 * "gold xau analysis" produced three "rows": the ad's `More options` button,
 * the advertiser's name `Take Profit Trader`, and one real video. The
 * `Sponsored` label is a sibling of those two, not inside them, so no filter
 * that walks the row can see it.
 *
 * So this asks the positive question instead. A real result row carries a
 * duration (`4:35`), a view count, or an age (`2 years ago`) somewhere in its
 * own subtree; a toolbar button and an advertiser's name carry none of them.
 * That holds for the partial page and the full one alike, which is what makes
 * it worth more than the label test it replaces.
 *
 * Verified offline against both captured trees before it went near a phone.
 */
export function looksPlayable(row: UiNode): boolean {
  const readable = readableOf(row)
  if (readable.length === 0) return false
  if (readable.every((value) => CHROME_LABELS.test(value.trim()))) return false
  if (readable.some((value) => /^(sponsored|bersponsor)\b/i.test(value.trim()))) return false
  /* A subscriber count means a CHANNEL card. Tapping one opens the channel, which is a different script's job. */
  if (readable.some((value) => /\bsubscribers?\b/i.test(value))) return false
  return readable.some((value) => HAS_DURATION.test(value) || HAS_VIEWS.test(value) || HAS_AGE.test(value))
}

/**
 * Poll until the result list stops growing, or the budget runs out.
 *
 * Returns the last tree seen either way — a page that never settles is still a
 * page to pick from, and refusing to pick would turn a slow network into a
 * failed run.
 */
async function settleResults(ctx: Parameters<NonNullable<(typeof script)['run']>>[0], first: UiNode): Promise<UiNode> {
  const playable = (tree: UiNode): number => resultRowsOf(tree).filter(looksPlayable).length
  let tree = first
  let last = playable(first)
  const deadline = Date.now() + SETTLE_BUDGET_MS
  while (Date.now() < deadline) {
    await sleep(SETTLE_STEP_MS)
    const next = await ctx.device.dump()
    const count = playable(next)
    tree = next
    /*
      Stable AND worth picking from. Counting every row, and accepting any
      stable count, is what made this return a three-row page twice in a row —
      of which one row was a button and one was an advertiser's name. A page
      with fewer than `SETTLE_MIN_ROWS` real videos is a page still loading.
    */
    if (count === last && count >= SETTLE_MIN_ROWS) return tree
    last = count
  }
  return tree
}

const script: PluginMemberScript<typeof paramsSchema, typeof resultSchema> = {
  id: 'watch-video',
  /** Plan 310 §3.3 — the script's own icon; `node.icon` (same value) stays as a fallback read for a core older than this plan. */
  icon: 'play',
  node: { category: 'device', icon: 'play', summary: ['query'], keywords: ['watch', 'video', 'long'] },
  title: 'Watch Video',
  description: 'Searches YouTube and watches videos with human-like behaviour. Give it a minimum watch time and it keeps opening fresh videos — a different query and a row it has not seen — until that time is met.',
  params: paramsSchema,
  result: resultSchema,
  timeout: 15 * 60_000,

  async prepare(ctx) {
    await relaunch(ctx)
  },

  async run(ctx) {
    const rng = makeRng(ctx.params.seed || Date.now() >>> 0)
    const steps: string[] = []
    const fail = (step: string, message: string): never => {
      steps.push(`${step}: FAILED`)
      throw new Error(`${message} (steps: ${steps.join(' → ')})`)
    }

    /*
      The queries this run may use.

      One video is one search, and a phone that searches the same words every
      time is a phone with one habit. The caller passes the account's whole
      interest list and a round draws from it; `query` stays as the first and
      as the only one a caller who passes nothing else gets.
    */
    const pool = [ctx.params.query, ...ctx.params.queries].filter((q, i, all) => q.trim() !== '' && all.indexOf(q) === i)

    const minMs = ctx.params.minWatchMs
    const maxMs = ctx.params.maxWatchMs > 0 ? ctx.params.maxWatchMs : Number.POSITIVE_INFINITY
    /* Titles already opened, so a second round never reopens the first round's video. */
    const seen = new Set<string>()
    const watched: { title: string; rank: number; ms: number; like: string; comments: string }[] = []
    let total = 0
    let round = 0

    /*
      Filled by the first round and reported as the run's headline video.
      An OBJECT rather than two `let`s, because TypeScript narrows a `let`
      assigned only inside a closure to its initialiser and then reads it as
      `never` — the object's fields are read fresh instead.
    */
    const first: { evidence: string | null; pick: { title: string; rank: number; results: number; query: string } | null } = { evidence: null, pick: null }

    /** One search, one video, one watch. Returns the ms actually spent watching. */
    const watchOne = async (budgetMs: number): Promise<number> => {
      round += 1
      const tag = (name: string): string => `${String(round).padStart(2, '0')}-${name}`
      const query = pool[Math.floor(rng() * pool.length)] as string

      // --- search -------------------------------------------------------------
      const home = await capture(ctx, tag('home'))
      const entry = firstMatch(home, SEARCH_ENTRY)
      if (!entry) fail('open-search', `no search button on the YouTube home screen — see artifact ${tag('home')}`)
      await tapNode(ctx, entry!.node)
      // No fixed wait here: `openSearchField` polls for the search screen itself.
      const screen = await capture(ctx, tag('search-open'))
      const field = await openSearchField(ctx)
      if (!field) fail('type-query', `the search screen opened with no text field — see artifact ${tag('search-open')}`)
      void screen
      await tapNode(ctx, field!)
      await sleep(between(rng, 400, 800))
      await ctx.device.type(query, {
        // Typed the way a person does (0.39.8). Typos stay off — YouTube's search box edits its
        // suggestion list under the cursor, and a backspace there can commit a suggestion.
        human: { typo: { probability: 0 } },
      })
      await ctx.device.key('ENTER')

      const loaded = await waitForTree(ctx, hasResultRows, { budgetMs: 30_000 })
      /*
        Wait for the LIST to settle, not for its first row.

        `hasResultRows` answers as soon as anything is there, and on this
        device that was three rows of an eventual twenty-one. Picking from the
        short list then tapping is a tap at coordinates the page has since
        moved: measured on the owner's moto g06 power, round two picked
        "rank 2/3", the page finished loading, and the tap landed on nothing
        (2026-09-20). Round one rarely sees it — the phone has been sitting on
        the home screen and the search is the first thing it does.

        Settled means the row count stopped changing, not that it reached some
        number: the count is YouTube's business and the budget is short enough
        that a genuinely slow page just gets picked from as it is.
      */
      const settled = await settleResults(ctx, loaded.tree)
      const results = await capture(ctx, tag('results'), settled)
      steps.push(loaded.ok ? `results(${query})` : `results(timeout, ${query})`)
      if (!loaded.ok) fail('results', `no result rows appeared within the budget — see artifact ${tag('results')}`)

      // --- pick from the ranked first page ------------------------------------
      const rows = resultRowsOf(results)
      if (rows.length === 0) fail('pick-row', `the results page reported rows but the walk found none — see artifact ${tag('results')}`)
      /*
        Rows this run has not already watched. A second round that reopened the
        first round's video is the exact tell the owner named — *"biar ga
        dikira bot nonton video yang sama terus terusan"* — and it is easy to
        hit, because the same query returns the same ranking.
      */
      /* Only real videos are candidates — see `looksPlayable`. Filtered first, so a button is never even a fallback. */
      let page = results
      let playable = rows.filter(looksPlayable)
      /*
        No video at all is a page still loading, not a page without videos —
        `settleResults` gives up on its own budget and a slow search can spend
        all of it showing chrome. One more look costs a second and turned a
        failed round into a watched video on the owner's device.
      */
      if (playable.length === 0) {
        await sleep(SETTLE_BUDGET_MS / 2)
        page = await capture(ctx, tag('results-again'))
        playable = resultRowsOf(page).filter(looksPlayable)
      }
      if (playable.length < resultRowsOf(page).length) steps.push(`${playable.length} of ${resultRowsOf(page).length} rows are videos`)
      /*
        A page of channels and adverts carries no video, and that is an answer
        about THIS QUERY, not about the run. Recovered rather than failed, so
        the next round searches for something else — which is what the operator
        asked for when a video does not work out.
      */
      if (playable.length === 0) {
        steps.push(`no video on the results for "${query}" — trying another search`)
        return 0
      }
      const fresh = playable.filter((row) => !seen.has(titleFromRow(row)))
      const pickFrom = fresh.length > 0 ? fresh : playable
      const chosen = (ctx.params.pick === 'top' ? pickFrom[0] : pickFrom[Math.floor(rng() * pickFrom.length)]) as UiNode
      const videoTitle = titleFromRow(chosen)
      seen.add(videoTitle)
      const index = resultRowsOf(page).indexOf(chosen)
      steps.push(`picked rank ${index + 1}/${resultRowsOf(page).length}`)

      /*
        Tap, and if no player follows, FIND THE ROW AGAIN and tap it again.

        Measured on the owner's moto g06 power (2026-09-20): round two's
        artifact showed the results page unchanged — the search had worked, the
        tap had landed, and nothing had opened. YouTube's results load
        incrementally and a Sponsored card arrives late at the top, pushing
        every row down by its height between the dump the coordinates came from
        and the tap that used them. Round one rarely sees it because the ad has
        not arrived yet; the later rounds almost always do.

        So the retry re-dumps and matches the row by its TITLE rather than its
        position — the one thing about it that does not move. Three attempts,
        because two consecutive relayouts is already improbable and a fourth
        tap on a page that genuinely will not open a video is just noise.
      */
      let player = results
      let evidence = playerEvidence(results)
      let tapped = 0
      while (tapped < 3) {
        /*
          A retry re-DUMPS rather than reusing the tree the failed wait
          returned: that tree is whatever was on screen when the wait gave up,
          which on a page that relaid out is exactly the stale picture the tap
          already missed with.
        */
        const surface = tapped === 0 ? page : await ctx.device.dump()
        const target = tapped === 0 ? chosen : (resultRowsOf(surface).find((row) => titleFromRow(row) === videoTitle) ?? null)
        if (target === null) {
          steps.push('retap: the row is no longer on the page')
          break
        }
        await tapNode(ctx, target.clickable ? target : clickableFor(surface, target))
        tapped += 1
        const playing = await waitForTree(ctx, (t) => playerEvidence(t).playing, { budgetMs: 30_000 })
        player = playing.tree
        evidence = playerEvidence(player)
        if (evidence.playing) break
        if (tapped < 3) steps.push(`retap ${tapped}`)
      }
      await capture(ctx, tag('player'), player)
      if (!evidence.playing) {
        /*
          Left the app entirely — an advert's landing page opens in a custom
          tab, and the phone is no longer in YouTube at all. `isSponsored`
          should stop this happening; the recovery is here because "should" is
          not "does", and a phone parked on an advertiser's sign-up form is the
          worst state this script can end in.

          Recovered, not failed: the app goes back and the round returns
          nothing, so the run carries on and its own round budget bounds it.
        */
        if (player.packageName !== undefined && player.packageName !== '' && player.packageName !== YOUTUBE_PACKAGE) {
          steps.push(`left YouTube for ${player.packageName} — going back`)
          await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
          await relaunch(ctx)
          return 0
        }
        fail('verify-player', `a result was tapped ${tapped} time(s) and nothing that looks like a player appeared — see artifact ${tag('player')}`)
      }

      let adSeen = false
      if (adEvidence(player).ad) {
        adSeen = true
        const started = Date.now()
        let cleared = false
        while (Date.now() - started < 60_000) {
          const t = await ctx.device.dump()
          if (!adEvidence(t).ad) {
            cleared = true
            break
          }
          if (ctx.params.skipAds) {
            const skip = skipControlOf(t)
            if (skip) {
              await tapNode(ctx, skip)
              await sleep(700)
              continue
            }
          }
          await sleep(1_000)
        }
        steps.push(cleared ? 'ad-cleared' : 'ad(timeout)')
      }
      if (first.evidence === null) first.evidence = `${evidence.via}${adSeen ? ' (after advert)' : ''}`
      if (first.pick === null) first.pick = { title: videoTitle, rank: index + 1, results: resultRowsOf(page).length, query }
      steps.push('watching')

      let like = 'not attempted'
      let comments = 'not attempted'
      // The keyword tilt reads the title the row gave us plus whatever the player shows.
      const tiltText = `${videoTitle} ${query} ${readableStrings(player).join(' ')}`
      const likeP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.likeProbability, ctx.params.keywordBoostFactor)
      const comP = keywordBoost(tiltText, ctx.params.keywords, ctx.params.commentProbability, ctx.params.keywordBoostFactor)

      const watchStart = Date.now()
      let lastInteraction = Date.now()
      /*
        The dwell is drawn ONCE (0.39.9).

        It used to be drawn inside the loop and compared against elapsed time, which reads as "one
        sample per round" but is not: with a fresh draw every 5–15 s, the run stops as soon as ANY
        draw falls under the time already spent, and the chance of that accumulates. The heavy tail
        this model exists for — a 0.1 chance of watching 25–55 s — was therefore almost never
        reached. One draw, held for the whole watch, is what the distribution means.

        `budgetMs` then CAPS it, and only ever downwards: a minimum is met by watching more videos,
        never by stretching one past what the model says a person would give it.
      */
      /*
        With a MINIMUM asked for, the per-video dwell comes from a long-video
        range instead of the Shorts table.

        `WATCH_BUCKETS` is a scrolling model — half its mass is 4 to 10
        seconds, and 0.15 of it is under four. That is right for a phone
        flicking through Shorts and wrong for one asked to watch a long video:
        measured on the owner's moto g06 power, a 90 s minimum was being
        approached 9 seconds at a time, which is ten searches to do what the
        operator asked for once. A minimum is a statement about how the phone
        should behave, so it changes the behaviour rather than only the exit
        condition.

        Still capped by `budgetMs`, and still never stretched past it: the
        maximum wins over the minimum.
      */
      const drawn = minMs > 0 ? { ms: between(rng, LONG_WATCH_MIN_MS, LONG_WATCH_MAX_MS), label: 'long' } : pickWatchMs(rng)
      const targetMs = Math.min(drawn.ms, budgetMs)

      while (true) {
        if (like === 'not attempted' && rng() < likeP * 0.3) {
          like = await pressLike(ctx, rng)
          steps.push(`like:${like}`)
          lastInteraction = Date.now()
        }

        if (comments === 'not attempted' && rng() < comP * 0.2) {
          comments = await browseComments(ctx, rng, { scrollTimes: 3 })
          steps.push(`comments:${comments}`)
          lastInteraction = Date.now()
        }

        // Human-like pause/check interval, never longer than what is left to watch.
        const left = targetMs - (Date.now() - watchStart)
        if (left <= 0) break
        await sleep(Math.min(between(rng, 5_000, 15_000), left))

        if (Date.now() - watchStart >= targetMs) break

        // A while since anything happened: a small scroll, the way a person fidgets.
        if (Date.now() - lastInteraction > 30_000 && rng() < 0.4) {
          const frame = await frameOf(ctx)
          if (rng() < 0.5) await scrollCommentsRandomised(ctx, frame, rng, 1)
          lastInteraction = Date.now()
        }
      }

      const ms = Date.now() - watchStart
      steps.push(`watched ${Math.round(ms / 1000)}s (${drawn.label})`)
      watched.push({ title: videoTitle, rank: index + 1, ms, like, comments })
      return ms
    }

    /*
      Keep watching until the MINIMUM is met.

      The owner's ask: *"akan selalu nonton video selama belum capai minimum
      waktunya, kalau satu video tidak kuat sampai minimum misalnya yah cari
      video lagi"*. So a short video is not stretched — the run opens another
      one, with a fresh query and a row it has not seen. `minWatchMs: 0` (the
      default) is one video, exactly as before.
    */
    const startedAt = Date.now()
    while (true) {
      try {
        total += await watchOne(maxMs - total)
      } catch (err) {
        /*
          A round that could not open a video does not throw away the ones that
          did.

          Opening a result is the flaky step — a row can be a Short, a
          playlist, a channel, or an advert that swallows the tap — and the
          longer a run goes the more likely it is to meet one. Before this, a
          run that watched 44 s across two videos and met a bad row on the
          third reported a bare failure with nothing watched, which is both
          false and the opposite of useful. Nothing watched at all is still a
          failure: there is no outcome to report and the reason belongs on the
          job.
        */
        if (watched.length === 0) throw err
        steps.push(`round ${round} gave up: ${err instanceof Error ? err.message.split(' (steps:')[0] : String(err)}`)
        break
      }
      if (total >= minMs) break
      /*
        Bounded by ROUNDS, not by videos watched. A round that recovered from
        leaving the app watched nothing, and bounding on `watched.length` would
        let a run that keeps meeting adverts go round for ever.
      */
      if (round >= ctx.params.maxVideos) {
        steps.push(`stopped after ${round} attempts with ${Math.round(total / 1000)}s watched`)
        break
      }
      /*
        Stop while there is still time to REPORT. A run killed at the member's
        timeout loses everything it watched and reads as a broken script; one
        that stops short says how far it got and why.
      */
      if (Date.now() - startedAt + ROUND_COST_MS > RUN_BUDGET_MS) {
        steps.push(`stopped with ${Math.round(total / 1000)}s watched — no time for another video inside this job`)
        break
      }
      if (total >= maxMs) break
      // Back to a clean home screen for the next search. A force-stop plus
      // relaunch is what `prepare` already does, and it is the one way back
      // that does not depend on how deep the player left us.
      await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
      await relaunch(ctx)
      await sleep(between(rng, 1_200, 2_500))
    }

    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
    /*
      Nothing watched at all is a failure, whatever recovered along the way.
      There is no outcome to report, and a `success` with `videosWatched: 0`
      would be the run claiming it did its job.
    */
    if (watched.length === 0) {
      throw new Error(`no video was watched in ${round} attempt(s) (steps: ${steps.join(' → ')})`)
    }
    return {
      query: first.pick?.query ?? ctx.params.query,
      resultCount: first.pick?.results ?? 0,
      pickedRank: first.pick?.rank ?? 0,
      played: true,
      videoTitle: first.pick?.title ?? '',
      playEvidence: first.evidence ?? '',
      like: watched.find((v) => v.like !== 'not attempted')?.like ?? 'not attempted',
      comments: watched.find((v) => v.comments !== 'not attempted')?.comments ?? 'not attempted',
      watchTime: total,
      videosWatched: watched.length,
      reachedMinimum: total >= minMs,
      videos: watched.map((v) => `${v.title} — ${Math.round(v.ms / 1000)}s (rank ${v.rank})`),
      steps,
    }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(YOUTUBE_PACKAGE, { clearRecents: true })
  },
}

export default script