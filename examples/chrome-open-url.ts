import { defineScript, type UiNode } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * Open a URL in Chrome, wait for the page to render, keep a screenshot, and
 * put the phone back the way it was found.
 *
 * Written as a probe of what the SDK can actually do end to end, so the parts
 * that had to be worked around are called out where they happen rather than
 * hidden behind a helper. The three that matter:
 *
 * 1. The URL is typed into Chrome's address bar, one character at a time,
 *    because that is what a person does. An earlier draft of this file called
 *    the absence of an intent launcher (`am start -a VIEW -d <url>`) the
 *    script's biggest gap — that was wrong. Firing an intent opens the page
 *    with nothing tapped and nothing typed, which is faster, sturdier, and
 *    unlike any human. The farm's `natural` timing profile exists for exactly
 *    this reason; the script's job is to use it, not route around it.
 * 2. Selectors are `id` / `desc` / `text` / `point`, matched exactly, with no
 *    parent, sibling, or nth-child navigation. A value can be located when it
 *    is known in advance; it cannot be *read out* of the page. `run` returns
 *    the fact that the page rendered, not the IP it rendered.
 * 3. Closing one tab needs Chrome's own UI, whose controls this script cannot
 *    assume are present. It tries, and says so when it cannot — the teardown
 *    that always works is `forceStop`, in `finish`.
 *
 * The resource id and the marker text below were read off a real device with
 * the Inspect panel rather than guessed.
 */
/**
 * The deepest node carrying Chrome's url_bar id.
 *
 * Deepest, not first: the tree contains an outer container with the same id
 * (the one `find` wrongly returns) wrapping the EditText that actually holds
 * the text. Depth is what separates them, and depth is not something a
 * selector can express — which is the whole argument for `dump()`.
 */
/** Every node in the tree, depth-first. The one primitive the rest is built on. */
function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = []
  const walk = (n: UiNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

function pickAddressBar(root: UiNode): UiNode | null {
  let best: UiNode | null = null
  let bestDepth = -1
  const walk = (n: UiNode, depth: number): void => {
    if (n.resourceId === 'com.android.chrome:id/url_bar' && depth > bestDepth) {
      best = n
      bestDepth = depth
    }
    for (const c of n.children) walk(c, depth + 1)
  }
  walk(root, 0)
  return best
}

export default defineScript({
  id: 'chrome-open-url',
  version: '4.0.0',
  params: z.object({
    url: z.string().default('whoer.net'),
    /** Chrome's package. Split out so a device with a different build can be pointed at it. */
    package: z.string().default('com.android.chrome'),
    /**
     * Exact text that only appears once the page has rendered — not merely
     * once Chrome has painted a frame. Defaults to a label on whoer.net.
     * Matching is exact after trimming, so this is a whole node's text.
     */
    loadedText: z.string().default('My IP:'),
    pageTimeoutMs: z.number().int().min(1_000).default(30_000),
  }),
  timeout: 120_000,
  // No retries: a partial run leaves Chrome open on some page, and `finish`
  // already restores the phone. A retry would start from a state the script
  // does not describe.
  retries: 0,

  async prepare(ctx) {
    // Start from a cold Chrome. Without this, a restored session can leave the
    // previous tab in front and the script would screenshot the wrong page —
    // and still pass, which is worse than failing.
    ctx.log.info(`stopping ${ctx.params.package} for a clean start`)
    await ctx.device.app.forceStop(ctx.params.package)
    await ctx.device.app.launch(ctx.params.package)
  },

  async run(ctx) {
    const { url, loadedText, pageTimeoutMs } = ctx.params

    // The address bar is located through the TREE, not through `find`.
    //
    // `find({ id: 'com.android.chrome:id/url_bar' })` cannot reach it on this
    // device: the on-device server answers with a FrameLayout covering the
    // whole 720×1640 screen, which the host guard now correctly rejects
    // (plan 60 §3.1). Rejecting it is right — but it leaves the address bar
    // unreachable by selector, and no selector grammar would fix that.
    //
    // `dump()` does. One tree, then ordinary TypeScript: take the deepest node
    // carrying that resource id, which is the EditText the Inspect panel
    // shows, and tap its real centre. This is the loop the inspector exists
    // to serve — look at the tree, then act on what is actually there.
    // Chrome hides its toolbar once the page is scrolled down, and a hidden
    // toolbar is not in the tree at all — the first run of this version failed
    // with "no address bar" while Chrome was plainly on screen. Scrolling up
    // brings it back, which is also what a person does before typing a new
    // address.
    await ctx.device.scroll({ direction: 'up' })

    const bar = pickAddressBar(await ctx.device.dump())
    if (!bar) {
      throw new Error(
        'no address bar in the tree after scrolling up — Chrome may be showing a dialog over the page',
      )
    }
    ctx.log.info('address bar located via dump', { bounds: bar.bounds, className: bar.className })

    const centre = {
      x: Math.round((bar.bounds.left + bar.bounds.right) / 2),
      y: Math.round((bar.bounds.top + bar.bounds.bottom) / 2),
    }
    await ctx.device.tap({ point: centre })
    // Typed character by character, deliberately. The farm's `natural` timing
    // profile spaces keystrokes by `perCharMs` ([40,140] ms here), jitters tap
    // timing and coordinates, and pauses between actions — and a URL is
    // exactly where opting out would show. `instant: true` would deliver the
    // whole string in one shot: faster, more reliable, and nothing a person
    // has ever done. It also skips the autocomplete and per-keystroke
    // listeners a real page runs, which is half of what is being tested.
    await ctx.device.type(url)
    await ctx.device.key('ENTER')

    // Waiting on page CONTENT, not on a timer — but through `dump()`, not
    // `waitFor`. On this device `find` cannot reach the marker either: the
    // page renders "My IP: 103.186.169.250" as one node, so an exact-match
    // selector never fires, and the run before this one timed out for 30 s
    // while the screenshot showed the page perfectly loaded.
    //
    // Polling the tree costs a dump per turn (334–584 ms) and is spaced
    // accordingly. What it buys is a check that matches how the page actually
    // renders rather than how a four-shape selector wishes it did.
    const deadline = Date.now() + pageTimeoutMs
    let marker: UiNode | undefined
    for (;;) {
      marker = flatten(await ctx.device.dump()).find((n) => n.text.includes(loadedText))
      if (marker) break
      if (Date.now() >= deadline) {
        throw new Error(`no node containing ${JSON.stringify(loadedText)} after ${pageTimeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }

    // And now the thing a selector could never do: read the value out. The
    // IP sits in the same node as its label, which is exactly why locating it
    // is not the same as extracting it.
    const ip = marker.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0] ?? null
    ctx.log.info('marker found', { text: marker.text, ip })

    // ...and then proving the script is the reason it is there.
    //
    // Version 1 stopped at the line above and reported success. It was wrong:
    // the marker text was already on screen from a previous session, so the
    // check passed while the script had navigated nowhere. A screenshot of an
    // entirely different site is what exposed it. A test that passes when the
    // work did not happen is worse than no test.
    //
    // So the address bar is read back. `find` returned an unusable node for
    // this id on a moto g06 (a full-screen FrameLayout instead of the EditText
    // the inspector shows), which is exactly why this is a verification and
    // not an assumption: if the bar cannot be read, or does not carry the
    // host that was typed, the run fails and says which.
    const host = url.replace(/^https?:\/\//, '').split('/')[0] ?? url
    const after = pickAddressBar(await ctx.device.dump())
    const shown = (after?.text ?? '').trim()
    if (!shown.includes(host)) {
      throw new Error(
        `the address bar reads ${JSON.stringify(shown)}, not ${JSON.stringify(host)} — ` +
          'the marker text was on screen but this script did not put it there',
      )
    }
    ctx.log.info('page rendered and confirmed in the address bar', { url, shown })

    // Taken in the core and stored against the job, so it outlives the run.
    await ctx.artifact.screenshot('page-loaded')

    // Closing a single tab is Chrome's own UI. `find` rather than `waitFor`:
    // a missing control is a fact to report, not a reason to fail a run whose
    // real work is already done and saved.
    const tabSwitcher = await ctx.device.find({ id: 'com.android.chrome:id/tab_switcher_button' })
    let tabClosed = false
    if (tabSwitcher) {
      await ctx.device.tap({ id: 'com.android.chrome:id/tab_switcher_button' })
      const close = await ctx.device.find({ desc: 'Close tab' })
      if (close) {
        await ctx.device.tap({ desc: 'Close tab' })
        tabClosed = true
      }
    }
    if (!tabClosed) {
      ctx.log.warn('could not close the tab through Chrome’s UI — finish() stops the app instead', {
        sawTabSwitcher: Boolean(tabSwitcher),
      })
    }

    // Deliberately NOT the IP address: see the header note. Reporting what was
    // proven — that the page rendered — beats reporting a value the selector
    // API cannot actually read.
    return { ok: true, url, exitIp: ip, marker: marker.text, addressBar: shown, tabClosed }
  },

  async finish(ctx) {
    // Stateless and idempotent: it reads `ctx` and nothing else, so the core
    // may run it again in a fresh process after a timeout kill and get the
    // same result.
    if (ctx.error) await ctx.artifact.screenshot('failed')
    await ctx.device.app.forceStop(ctx.params.package)
    await ctx.device.key('HOME')
  },
})
