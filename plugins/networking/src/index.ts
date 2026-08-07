import { definePlugin, type UiNode } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * What the network on this phone tells the outside world about itself.
 *
 * Three pages, driven through Chrome the way a person drives it — tap the
 * omnibox, type, press enter — and read back out of the accessibility tree:
 *
 * - `whoer.net`               the exit address, ISP, and the resolver it observes
 * - `browserleaks.com/dns`    every DNS server that answered, with its operator
 * - `browserleaks.com/webrtc` the addresses WebRTC hands out behind the page's back
 *
 * One page is not a network test. An exit IP alone says nothing about whether
 * DNS is going somewhere else, and neither says anything about WebRTC quietly
 * publishing an interface address that no proxy setting covers. The value is
 * in the disagreements between the three, so the script gathers all of them
 * and compares them in `assess`, rather than reporting a single green tick.
 *
 * Every label and resource id below was read off a real moto g06 with the
 * Inspect panel — including the two that decide when a page is finished
 * (`Found N Servers` and the `rtc-leak` verdict line), which is the difference
 * between waiting for data and waiting for a timer.
 */

/* ------------------------------------------------------------------ */
/* Tree primitives                                                     */
/* ------------------------------------------------------------------ */

/** Every node in the tree, depth-first — which is document order. */
export function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = []
  const walk = (n: UiNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

function pickById(root: UiNode, id: string): UiNode | null {
  return flatten(root).find((n) => n.resourceId === id) ?? null
}

/**
 * The deepest node carrying Chrome's url_bar id.
 *
 * Deepest, not first: the tree holds an outer container with the same id
 * wrapping the EditText that actually carries the text, and `find` answers
 * with the container — a full-screen FrameLayout that is not tappable. Depth
 * separates them, and depth is not something a selector can express.
 */
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

function centreOf(n: UiNode): { x: number; y: number } {
  return {
    x: Math.round((n.bounds.left + n.bounds.right) / 2),
    y: Math.round((n.bounds.top + n.bounds.bottom) / 2),
  }
}

/** Non-empty trimmed text of every node, in document order. */
function texts(nodes: UiNode[]): string[] {
  return nodes.map((n) => n.text.trim()).filter(Boolean)
}

/**
 * The value that follows a label, in document order.
 *
 * Both sites render facts as label/value pairs with nothing tying them
 * together but their position — an `"ISP"` node, then the ISP. `dump()`
 * returns the tree depth-first, which IS document order, so "the next node
 * with text" is the value beside the label. There is no selector shape for
 * that, and there does not need to be.
 *
 * `stops` is what keeps it honest. These pages fill in as their probes return,
 * so a dump taken a moment early sees a label with nothing after it yet, and
 * "the next text" is then the *following label*. An earlier version reported
 * `isp: "DNS"` and `hostname: "OS:"` exactly that way: plausible, entirely
 * wrong, and green. Absent is the right answer for a value that has not
 * arrived.
 */
export function valueAfter(nodes: UiNode[], label: string, stops: readonly string[]): string | null {
  const i = nodes.findIndex((n) => n.text.trim() === label)
  if (i === -1) return null
  for (const n of nodes.slice(i + 1)) {
    const t = n.text.trim()
    if (!t || t === label) continue
    if (stops.includes(t)) return null
    return t
  }
  return null
}

/**
 * The ADDRESS that follows a label — not merely the next text.
 *
 * `valueAfter` is right for prose values (an ISP name, a location) and wrong
 * for addresses, because browserleaks puts things between the label and the
 * number. Two of them, both found by testing this against the tree the Inspect
 * panel actually showed rather than the one I assumed:
 *
 * - `Local IP Address` is followed by an `Image` whose text is `"Local"`, so
 *   "the next text" is the word Local.
 * - `Public IP Address` with no leak is followed by an EMPTY node, so "the next
 *   text" is the *next section heading*, `"Session Description :"`.
 *
 * Both would have been reported as addresses. Requiring the value to parse as
 * one, skipping short decorative words, and refusing anything else is the
 * difference between reading the page and reading past it.
 */
export function addressAfter(nodes: UiNode[], label: string, stops: readonly string[]): string | null {
  const i = nodes.findIndex((n) => n.text.trim() === label)
  if (i === -1) return null
  for (const n of nodes.slice(i + 1)) {
    const t = n.text.trim()
    if (!t) continue
    if (stops.includes(t)) return null
    if (isAddress(t)) return t
    const inline = ipIn(t)
    if (inline) return inline
    // A decorative cell — a flag's alt text, the word "Local". Short, purely
    // alphabetic, no punctuation: skip it. Anything else (a heading, a
    // sentence) means the value is absent, and absent is the honest answer.
    if (/^[A-Za-z]{1,12}$/.test(t)) continue
    return null
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Address shapes                                                      */
/* ------------------------------------------------------------------ */

/** An IPv4 anywhere in a string, or null. */
export function ipIn(text: string | null | undefined): string | null {
  const m = text?.match(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/)
  if (!m) return null
  return m.slice(1, 5).every((o) => Number(o) <= 255) ? m[0] : null
}

/** Whether a whole string is an address — v4 or v6. Used to find table cells. */
export function isAddress(t: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t.split('.').every((o) => Number(o) <= 255)
  // v6: colon-separated hex groups and nothing else. Deliberately loose —
  // browserleaks prints compressed forms like `2a02:6ea0:d16a::45`.
  return /^[0-9a-f]{0,4}(:{1,2}[0-9a-f]{0,4}){2,}$/i.test(t)
}

/**
 * The exit IP recovered from a reverse-DNS name.
 *
 * whoer shows the address plainly, but the node holding it carries a resource
 * id and no text at all — it never reaches the accessibility tree, so no
 * selector and no dump can read it. The hostname beside it does carry it, with
 * dots written as dashes (`FAST-INTERNET-103-186-169-250.solnet.net.id`).
 *
 * That is one ISP's naming convention, not a universal one, so this is
 * explicitly a derivation and the caller is told which source it got. Where
 * the hostname does not encode an address the answer is null, not a guess.
 */
export function ipFromHostname(hostname: string | null): string | null {
  const m = hostname?.match(/(?:^|[^0-9])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})(?:[^0-9]|$)/)
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  return octets.every((o) => o >= 0 && o <= 255) ? octets.join('.') : null
}

/**
 * Whether an address belongs to a range that only exists inside a host.
 *
 * `198.18.0.0/15` is the one that matters here. It is RFC 2544 benchmark
 * space, which no ISP routes, and it is what a local tunnel interface hands
 * out — the moto g06 under test reports `198.18.0.1` through WebRTC. That is
 * not a leak of anything the operator owns, but it IS a signal: a page that
 * reads it knows this device is behind a tunnel, whatever the exit IP says.
 */
export function addressKind(ip: string): 'tunnel' | 'private' | 'public' {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return 'public'
  const a = p[0] ?? 0
  const b = p[1] ?? 0
  if (a === 198 && (b === 18 || b === 19)) return 'tunnel'
  if (a === 10) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private'
  if (a === 169 && b === 254) return 'private'
  if (a === 127) return 'private'
  return 'public'
}

/**
 * Whether two IPv4 addresses sit on the same carrier network, judged by their
 * first two octets.
 *
 * A blunt instrument, and deliberately so. The precise question — "does this
 * resolver belong to the same autonomous system as the exit address?" — needs
 * a whois lookup this script cannot make from a phone. browserleaks does make
 * it, and prints the operator names, but on four consecutive runs those names
 * never arrived within the page's budget while the addresses always did.
 *
 * A /16 match is not proof of shared ownership, and it is reported as evidence
 * rather than as a verdict. What it does catch is the case that matters: a
 * resolver sitting in the same block the exit address came from, which is what
 * a DNS request escaping a tunnel looks like — and it catches it from the
 * addresses alone, with nothing to wait for.
 */
export function sharesNetwork(a: string | null, b: string | null): boolean {
  if (!a || !b || a.includes(':') || b.includes(':')) return false
  const x = a.split('.')
  const y = b.split('.')
  if (x.length !== 4 || y.length !== 4) return false
  return x[0] === y[0] && x[1] === y[1]
}

/**
 * Compare two operator names loosely enough to survive punctuation, case, and
 * the legal-form suffix that half of them carry and the other half do not
 * ("Datacamp Limited" on one row, "DataCamp" on the next).
 */
export function sameOrg(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const norm = (v: string) =>
    v
      .toLowerCase()
      .replace(/\b(limited|ltd|inc|llc|corp|corporation|company|co|pt|tbk|gmbh|bv)\b/g, '')
      .replace(/[^a-z0-9]+/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

/**
 * Chrome's permission prompt, and the button that says no.
 *
 * Both whoer and browserleaks ask for Local Network Access — probing the LAN
 * is part of their own leak checks — and the prompt sits over the page until
 * it is answered, so the content never renders and the script waits out its
 * whole budget behind a dialog.
 *
 * Answering it is a privacy decision, so this only ever presses the negative
 * button. Letting a page scan the operator's network is not a formality an
 * automation script gets to wave through, and declining costs nothing: every
 * value this script reads still arrives.
 *
 * Matched by resource id first — the visible label is localised, and this
 * device shows "Blokir", so text matching would work in exactly one language.
 */
function findDenyButton(nodes: UiNode[]): UiNode | null {
  const byId = nodes.find((n) => /(?:negative_button|permission_dialog_deny)$/.test(n.resourceId))
  if (byId) return byId
  return nodes.find((n) => /^(block|blokir|deny|tolak|no thanks)$/i.test(n.text.trim())) ?? null
}

/**
 * How many tabs Chrome says are open.
 *
 * The tab-switcher button renders the count, which makes it the one honest way
 * to check that "new tab" and "close tab" did anything. Tapping a button and
 * assuming is how an earlier version reported a closed tab that was still open.
 */
export function tabCount(nodes: UiNode[]): number | null {
  const btn = nodes.find((n) => n.resourceId === 'com.android.chrome:id/tab_switcher_button')
  if (!btn) return null
  // `text` first, then `desc`: on this device the counter is a custom-drawn
  // view with no text at all, so the number only exists in the content
  // description ("5 tab" / "5 tabs", localised).
  const fromText = Number.parseInt(btn.text.trim(), 10)
  if (Number.isFinite(fromText)) return fromText
  const m = btn.desc.match(/\d+/)
  return m ? Number.parseInt(m[0], 10) : null
}

/**
 * Compare what the omnibox shows against what was meant, ignoring only the
 * cosmetic differences Chrome introduces (scheme, `www.`, trailing slash,
 * case).
 *
 * A substring test is what let corruption through once: `whoer.netwhoer.net`
 * *contains* `whoer.net`, so the check passed and the run navigated somewhere
 * unintended. The comparison has to be equality on the normalised address, or
 * it is not a check. The path is kept — `/dns` and `/webrtc` are the whole
 * difference between two of these three pages.
 */
export function sameAddress(shown: string, wanted: string): boolean {
  const norm = (v: string) =>
    v
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
  return norm(shown) === norm(wanted)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* The slice of a run context these helpers touch                      */
/* ------------------------------------------------------------------ */

/** The only browser this pack drives: every selector below is a `com.android.chrome:id/...`. */
const CHROME_PACKAGE = 'com.android.chrome'

interface Ctx {
  device: {
    tap: (t: { point: { x: number; y: number } }) => Promise<void>
    key: (k: 'DEL' | 'ENTER' | 'BACK') => Promise<void>
    type: (s: string, o?: { instant?: boolean }) => Promise<void>
    app: { launch: (pkg: string, o?: { url?: string }) => Promise<void> }
    dump: () => Promise<UiNode>
    scroll: (o: { direction: 'up' }) => Promise<void>
  }
  log: {
    info: (m: string, d?: Record<string, unknown>) => void
    warn: (m: string, d?: Record<string, unknown>) => void
  }
}

/**
 * Run something that talks to the network, and give it more room each time.
 *
 * Every wait in this script is a wait on a web page, so its duration is a
 * property of the connection, not of the code. A fixed delay is therefore
 * always wrong somewhere: too short on mobile data during a cell handover,
 * wasted on WiFi. Attempts back off — 4 s, 8 s, 12 s — and the reason for each
 * retry is logged, so a run that eventually succeeded still shows what it had
 * to survive.
 */
async function withRetry<T>(
  ctx: Ctx,
  label: string,
  attempts: number,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      last = err
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === attempts) {
        ctx.log.warn(`${label} failed after ${attempts} attempts`, { error: message })
        break
      }
      const backoffMs = 4_000 * attempt
      ctx.log.warn(`${label} failed — retrying`, { attempt, of: attempts, backoffMs, error: message })
      await sleep(backoffMs)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/**
 * Focus the omnibox and leave it EMPTY before anything is typed.
 *
 * Two failures made this necessary, both seen producing `wwho.erwhoer.net`
 * instead of `whoer.net`:
 *
 * 1. Tapping the bar does not reliably select its contents, so a new address
 *    was appended to the old one.
 * 2. Chrome's inline autocomplete rewrites the field while a human-paced
 *    typist is still going, so characters interleave with the completion.
 *
 * `DEL` is backspace on Android; the count comes from what is actually in the
 * field, and the loop stops when the field says it is empty rather than after
 * a fixed number of presses.
 */
async function focusAndClear(ctx: Ctx, point: { x: number; y: number }, humanTyping: boolean): Promise<void> {
  await ctx.device.tap({ point })
  await sleep(700)
  // The field is ALWAYS emptied first, in both modes.
  //
  // An earlier version skipped this in fast mode, reasoning that `type(..., { instant: true })`
  // replaces the contents via the inspector's `setText`. It does not, here: the executor only
  // reaches `setText` when a selector-based tap has recorded a target, and this taps by point — so
  // it falls back to a bulk `input text`, which APPENDS. The result was an address bar holding
  // `browserleaks.cbrowsbrowbrowsbrow…` and three failed attempts. Cheap assumption, expensive bug.
  for (let round = 0; round < 3; round++) {
    const current = (pickAddressBar(await ctx.device.dump())?.text ?? '').trim()
    if (!current) return
    // A few extra presses absorb whatever autocomplete added after the read.
    for (let i = 0; i < current.length + 4; i++) await ctx.device.key('DEL')
    await sleep(400)
  }
}

/**
 * The new-tab page's search box.
 *
 * Chrome's NTP has NO omnibox. Its toolbar is home, profile, tab count, menu —
 * `url_bar` is genuinely absent from the tree, and the Google field in the
 * middle of the page is a different widget with a different id that merely
 * opens the omnibox when tapped.
 *
 * This cost a run. Opening a new tab worked (the counter went 1 → 2) and then
 * every attempt to type failed with "no address bar", which the error message
 * blamed on a dialog. There was no dialog; there was a new tab page, which is
 * the one screen the script guarantees it will be on, because it just asked
 * for one.
 */
function pickNewTabSearchBox(root: UiNode): UiNode | null {
  return (
    flatten(root).find((n) => /:id\/(search_box_text|search_box|fakebox|fake_search_box)$/.test(n.resourceId)) ?? null
  )
}

/**
 * Bring the omnibox back into the tree and return it.
 *
 * Chrome hides its toolbar once a page is scrolled down, and a hidden toolbar
 * is not in the tree at all — a run failed with "no address bar" while Chrome
 * was plainly on screen. Scrolling up brings it back, which is also what a
 * person does before typing a new address. The scroll is repeated between
 * attempts because one flick does not always reach the top of a long page, and
 * the tree is polled rather than dumped once because the toolbar slides back
 * in over several frames.
 */
async function reachAddressBar(ctx: Ctx, budgetMs: number): Promise<UiNode> {
  const deadline = Date.now() + budgetMs
  let ntpTaps = 0
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await ctx.device.scroll({ direction: 'up' })
    await sleep(600)
    const tree = await ctx.device.dump()
    const bar = pickAddressBar(tree)
    if (bar) return bar

    // On the new-tab page the omnibox has to be summoned before it exists.
    const fake = ntpTaps < 3 ? pickNewTabSearchBox(tree) : null
    if (fake) {
      ntpTaps += 1
      ctx.log.info('on the new-tab page — tapping its search box to summon the omnibox', { attempt: ntpTaps })
      await ctx.device.tap({ point: centreOf(fake) })
      await sleep(1_200)
      continue
    }

    if (Date.now() >= deadline) {
      // Name what was actually on screen. The previous wording guessed at a
      // dialog and sent an investigation looking for one that was never there;
      // the ids present identify the screen in a line.
      throw new Error(
        `no address bar after ${attempt + 1} attempts — ids on screen: ` +
          JSON.stringify(
            [...new Set(flatten(tree).map((n) => n.resourceId).filter(Boolean))].slice(0, 12),
          ),
      )
    }
  }
}

/**
 * Open a genuinely new tab, and prove it.
 *
 * Two routes, because neither works everywhere. `optional_toolbar_button` is
 * the `+` beside the omnibox, and "optional" is literal — Chrome swaps that
 * slot for share or voice search, and on the new-tab page the toolbar has no
 * omnibox at all, so the `+` is simply absent. That is what happened on a cold
 * launch: the run reported "no new-tab button" and carried on in whatever tab
 * Chrome had restored.
 *
 * The overflow menu always has the item. Its label is localised ("Tab baru"
 * here), so it is matched over text and content description both.
 *
 * The tab counter decides, either way. Tapping something that looks like the
 * right control and assuming is how an earlier version reported a tab it never
 * opened.
 */
async function openNewTab(ctx: Ctx): Promise<boolean> {
  const before = tabCount(flatten(await ctx.device.dump()))

  const plus = pickById(await ctx.device.dump(), 'com.android.chrome:id/optional_toolbar_button')
  if (plus) {
    await ctx.device.tap({ point: centreOf(plus) })
    await sleep(2_000)
    const after = tabCount(flatten(await ctx.device.dump()))
    if (before !== null && after !== null && after > before) {
      ctx.log.info('opened a new tab with the toolbar button', { before, after })
      return true
    }
    ctx.log.warn('the + button did not add a tab — falling back to the menu', { before, after })
  }

  const menu = pickById(await ctx.device.dump(), 'com.android.chrome:id/menu_button')
  if (!menu) {
    ctx.log.warn('no menu button either — continuing in the current tab')
    return false
  }
  await ctx.device.tap({ point: centreOf(menu) })
  await sleep(1_500)
  const items = flatten(await ctx.device.dump())
  const newTab = items.find((n) => /^(new tab|tab baru)$/i.test(n.text.trim() || n.desc.trim()))
  if (!newTab) {
    ctx.log.warn('no "new tab" item in the menu', {
      items: items.map((n) => n.text.trim()).filter(Boolean).slice(0, 10),
    })
    await ctx.device.key('BACK')
    return false
  }
  await ctx.device.tap({ point: centreOf(newTab) })
  await sleep(2_000)
  const after = tabCount(flatten(await ctx.device.dump()))
  const opened = before !== null && after !== null && after > before
  ctx.log.info(opened ? 'opened a new tab from the menu' : 'the menu item did not add a tab', { before, after })
  return opened
}

/** Type an address into the omnibox, verify it landed, and commit it. */
async function navigate(ctx: Ctx, url: string, humanTyping: boolean, pkg: string): Promise<void> {
  // The fast path does not touch the omnibox at all.
  //
  // Driving a browser through its address bar is unreliable in a way retrying cannot fix: focusing
  // does not reliably select, Chrome's autocomplete rewrites the field mid-keystroke, and a
  // clear-then-type races itself. Real runs produced `wwho.erwhoer.net`, `hoer.net` and
  // `bsssom/dnsom/dns` — each one either a failed check or, worse, a reading taken from the wrong
  // page. An intent hands Chrome the address exactly, once, with nothing to clear first.
  //
  // The address bar is still read back below either way: the intent can be intercepted, redirected,
  // or land on a different page, and this script's entire output depends on which page it measured.
  if (!humanTyping) {
    // The checks name their targets the way a person would type them (`whoer.net`), but an intent
    // needs a real URL — `am start -d whoer.net` has no scheme to act on and Chrome never moves.
    const absolute = /^https?:\/\//i.test(url) ? url : `https://${url}`
    await ctx.device.app.launch(pkg, { url: absolute })
    // NOTHING is verified here, deliberately.
    //
    // The first version of this read the address bar back to confirm the intent landed. That is a
    // proxy for the thing that matters, and it happened to lean on the least reliable part of the
    // stack: the address bar comes from the UI tree, and a session whose inspector has fallen back
    // to one-shot `uiautomator dump` reads an EMPTY tree while the persistent ui-server holds
    // UiAutomation. The runs failed with `the address bar holds ""` on a Chrome that was sitting on
    // exactly the right page.
    //
    // The real proof is downstream and already exists: `awaitPage` waits on `ready()`, and every
    // check's `read()` looks for content only its own page has — whoer's IP block, browserleaks'
    // resolver table. A wrong page cannot satisfy them, so it fails there, with a message about
    // what was missing rather than about a bar nobody cares about.
    return
  }

  const bar = await reachAddressBar(ctx, 20_000)
  const centre = centreOf(bar)
  await focusAndClear(ctx, centre, humanTyping)
  // Character-by-character typing was once unconditional here, justified as exercising Chrome's
  // autocomplete and per-keystroke listeners. That justification does not survive contact with what
  // this script actually reports: DNS resolvers, an exit address, and WebRTC candidates. None of
  // them depend on how the URL got into the bar. Measured against the log of a real run, the
  // human-paced path cost roughly two minutes per page — three pages, six minutes — for output that
  // is byte-identical either way.
  //
  // So it is now a choice with a fast default. `instant` also removes a whole class of bug at the
  // root rather than papering over it: `setText` replaces the field atomically, so the interleaving
  // that produced `wwho.erwhoer.net` and `hoer.net` cannot happen at all.
  await ctx.device.type(url, humanTyping ? {} : { instant: true })

  // Read the bar back BEFORE committing, and retype if it disagrees.
  //
  // Not defensive padding — an observed failure. A run typed `whoer.net` and
  // the bar held `hoer.net`: the first keystroke landed while Chrome was still
  // focusing the omnibox, so it went nowhere. ENTER then navigated to a real,
  // different site, and every check after that measured the wrong page.
  for (let attempt = 0; attempt < 3; attempt++) {
    const typed = (pickAddressBar(await ctx.device.dump())?.text ?? '').trim()
    if (sameAddress(typed, url)) break
    if (attempt === 2) {
      throw new Error(`typed ${JSON.stringify(url)} but the address bar holds ${JSON.stringify(typed)}`)
    }
    ctx.log.warn('the address bar does not hold what was typed — clearing and retyping', { typed, url })
    await focusAndClear(ctx, centre, humanTyping)
    await ctx.device.type(url, humanTyping ? {} : { instant: true })
  }

  await ctx.device.key('ENTER')
}

/**
 * One step of "has this stopped changing?".
 *
 * Kept separate and pure because the rule it encodes is easy to get subtly
 * wrong and impossible to test through a device. `fp` is a fingerprint of the
 * part of the page that matters; when it repeats `stableFor` times in a row,
 * the page has settled.
 */
export function settleStep(
  prev: { fp: string | null; count: number },
  fp: string,
  stableFor: number,
): { fp: string; count: number; done: boolean } {
  const count = fp === prev.fp ? prev.count + 1 : 1
  return { fp, count, done: count >= stableFor }
}

/**
 * Poll the tree until the page has answered, and deal with what gets in the way.
 *
 * `ready` decides — not a timer, and not merely that Chrome painted a frame.
 * Each site passes its own completion signal (`Found N Servers`, the WebRTC
 * verdict line, whoer's ISP row), because "the marker text appeared" only
 * proves the page rendered its own labels, which it does long before any probe
 * comes back.
 *
 * Two things routinely interrupt it and neither is a reason to fail: a
 * permission prompt, which is dismissed, and Chrome's network error page,
 * which is retried after a growing delay. A reset connection on mobile data is
 * a fact about the link, not about the script.
 */
async function awaitPage(
  ctx: Ctx,
  opts: {
    url: string
    /** Passed through only so a reload re-opens the address the same way the first attempt did. */
    humanTyping: boolean
    package: string
    ready: (nodes: UiNode[]) => boolean
    /**
     * The weaker bar: enough on the page for the reading to mean something,
     * even though `ready` never fired.
     *
     * Without this, insisting on completeness would turn a page that gave up
     * one operator name out of two into a failed run with no data at all —
     * trading a partial answer for none. At the deadline the run keeps what it
     * has and marks the page partial, so the shortfall is visible rather than
     * silently absorbed.
     */
    acceptable?: (nodes: UiNode[]) => boolean
    budgetMs: number
    maxReloads: number
    /**
     * What to watch for further change once `ready` first fires, and how many
     * identical polls end the wait.
     *
     * `ready` is necessary and not sufficient. browserleaks announces "Found 1
     * Server" the moment its first answer arrives and keeps going — three runs
     * of this script read 6 servers, then 3, then 1, each of them a truthful
     * snapshot of a test that had not finished. The operator names arrive later
     * still, on a second lookup, which is why they read as null.
     *
     * A fixed extra sleep would trade one wrong guess for another. Waiting for
     * the values themselves to stop moving is the only version that adapts to
     * the connection, which is what actually varies here.
     */
    settle?: { fingerprint: (nodes: UiNode[]) => string; stableFor: number; intervalMs: number }
  },
): Promise<{ nodes: UiNode[]; deniedPrompt: boolean; reloads: number; settled: boolean }> {
  const deadline = Date.now() + opts.budgetMs
  let deniedPrompt = false
  let reloads = 0
  let seen: { fp: string | null; count: number } = { fp: null, count: 0 }

  for (;;) {
    const nodes = flatten(await ctx.device.dump())
    if (opts.ready(nodes)) {
      if (!opts.settle) return { nodes, deniedPrompt, reloads, settled: true }
      const step = settleStep(seen, opts.settle.fingerprint(nodes), opts.settle.stableFor)
      seen = step
      if (step.done) return { nodes, deniedPrompt, reloads, settled: true }
      // Stop as soon as the page carries what this reading needs, instead of waiting for the whole
      // screen to hold still. Measured: `browserleaks.com/dns` never stops moving — it keeps
      // appending resolvers and rotating adverts — so it burned the entire 75s budget on EVERY
      // attempt and then reported "did not fully complete" anyway. The data it was asked for had
      // been on screen for most of that time. `acceptable` already encodes "enough to read"; it was
      // only ever consulted at the deadline, which is the one moment it is too late to be useful.
      if (opts.acceptable?.(nodes)) {
        ctx.log.info('the page already carries what this check needs — not waiting for it to go still', {
          url: opts.url,
        })
        return { nodes, deniedPrompt, reloads, settled: true }
      }
      if (Date.now() >= deadline) {
        // The page answered but never stopped moving. Returning what is there
        // beats failing a run that has real data in it — but the caller is
        // told, so a partial reading is never mistaken for a complete one.
        ctx.log.warn('the page answered but was still changing when the budget ran out', {
          url: opts.url,
          lastSeen: step.fp.slice(0, 160),
        })
        return { nodes, deniedPrompt, reloads, settled: false }
      }
      await sleep(opts.settle.intervalMs)
      continue
    }

    const deny = findDenyButton(nodes)
    if (deny) {
      ctx.log.warn('a permission prompt was blocking the page — denying it', {
        label: deny.text || deny.resourceId,
      })
      await ctx.device.tap({ point: centreOf(deny) })
      deniedPrompt = true
      await sleep(1_000)
      continue
    }

    const netErr = nodes.map((n) => n.text).find((t) => /\bERR_[A-Z_]+\b/.test(t))
    if (netErr) {
      if (reloads >= opts.maxReloads) {
        throw new Error(`the page could not be reached after ${reloads} reloads: ${netErr.trim()}`)
      }
      reloads += 1
      const backoffMs = 3_000 * reloads
      ctx.log.warn('Chrome showed a network error — waiting, then reloading', {
        error: netErr.trim(),
        attempt: reloads,
        backoffMs,
      })
      await sleep(backoffMs)
      await navigate(ctx, opts.url, opts.humanTyping, opts.package)
      await sleep(2_000)
      continue
    }

    if (Date.now() >= deadline) {
      if (opts.acceptable?.(nodes)) {
        ctx.log.warn('the page did not fully complete, keeping what it did report', { url: opts.url })
        return { nodes, deniedPrompt, reloads, settled: false }
      }
      // Say what was actually seen. Reporting "the marker never appeared" for
      // a page that plainly rendered sent one investigation looking for a bug
      // in the script; the first few texts identify the screen in one line.
      throw new Error(
        `${opts.url} did not finish in ${opts.budgetMs}ms — ${nodes.length} nodes, showing: ` +
          JSON.stringify(texts(nodes).slice(0, 10)),
      )
    }
    await sleep(1_500)
  }
}

/* ------------------------------------------------------------------ */
/* The three pages                                                     */
/* ------------------------------------------------------------------ */

const WHOER_LABELS = ['My IP:', 'ISP:', 'DNS', 'Hostname:', 'OS:', 'Browser:', 'Proxy:'] as const

export interface WhoerFacts {
  exitIp: string | null
  exitIpSource: 'inline' | 'value-node' | 'hostname' | null
  isp: string | null
  dns: string | null
  hostname: string | null
  os: string | null
  browser: string | null
}

export function readWhoer(nodes: UiNode[]): WhoerFacts {
  const marker = nodes.find((n) => n.text.includes('My IP:'))
  let exitIp: string | null = null
  let exitIpSource: WhoerFacts['exitIpSource'] = null
  const hostname = valueAfter(nodes, 'Hostname:', WHOER_LABELS)

  if (marker) {
    // Three shapes, because the page does not commit to one. On WiFi the label
    // and the address were separate nodes and the address node carried no text
    // at all; on mobile data they arrive as one string.
    const i = nodes.indexOf(marker)
    exitIp = ipIn(marker.text)
    exitIpSource = exitIp ? 'inline' : null
    if (!exitIp) {
      exitIp = ipIn(
        nodes
          .slice(i + 1, i + 4)
          .map((n) => n.text)
          .join(' '),
      )
      exitIpSource = exitIp ? 'value-node' : null
    }
    if (!exitIp) {
      exitIp = ipFromHostname(hostname)
      exitIpSource = exitIp ? 'hostname' : null
    }
  }

  return {
    exitIp,
    exitIpSource,
    isp: valueAfter(nodes, 'ISP:', WHOER_LABELS),
    dns: valueAfter(nodes, 'DNS', WHOER_LABELS),
    hostname,
    os: valueAfter(nodes, 'OS:', WHOER_LABELS),
    browser: valueAfter(nodes, 'Browser:', WHOER_LABELS),
  }
}

/** whoer has answered when it has painted AND at least one probe has landed. */
export function whoerReady(nodes: UiNode[]): boolean {
  if (!nodes.some((n) => n.text.includes('My IP:'))) return false
  const f = readWhoer(nodes)
  return Boolean(f.exitIp || f.isp)
}

const DNS_LABELS = ['IP Address', 'ISP', 'Location', 'ISP :', 'IP Address :'] as const

export interface DnsFacts {
  exitIp: string | null
  isp: string | null
  location: string | null
  summary: string | null
  servers: Array<{ isp: string | null; ip: string }>
}

/**
 * browserleaks says when it is done, in words: "Found 6 Servers, 2 ISP, 1
 * Location". Until that line exists the table below it is still filling, and a
 * dump taken earlier returns a truthful-looking but partial server list — the
 * worst kind of wrong, because nothing about it looks wrong.
 */
export function dnsSummary(nodes: UiNode[]): string | null {
  return texts(nodes).find((t) => /Found\s+\d+\s+Server/i.test(t)) ?? null
}

/**
 * What the summary line PROMISES: "Found 6 Servers, 2 ISP, 1 Location".
 *
 * The page states its own completion criteria in a sentence, which is better
 * than any heuristic this script could invent — and better than the settle
 * window, which only knows that nothing changed recently, not that everything
 * has arrived. Operator names come from a second lookup that can land well
 * after the addresses; three runs read `?` for every operator while the same
 * line said two of them were known.
 */
export function dnsExpected(summary: string | null): { servers: number; isps: number } | null {
  const m = summary?.match(/Found\s+(\d+)\s+Servers?,\s*(\d+)\s+ISPs?/i)
  if (!m) return null
  return { servers: Number(m[1]), isps: Number(m[2]) }
}

/** Whether the DNS page has delivered everything it said it found. */
export function dnsComplete(nodes: UiNode[]): boolean {
  const f = readDns(nodes)
  const expected = dnsExpected(f.summary)
  if (!expected) return false
  const orgs = new Set(f.servers.map((x) => x.isp).filter((v): v is string => Boolean(v)))
  return f.servers.length >= expected.servers && orgs.size >= expected.isps
}

export function readDns(nodes: UiNode[]): DnsFacts {
  // "IP Address" (no colon) is the your-IP row; "IP Address :" (spaced colon)
  // is the results-table header. They are different strings on the page and
  // the your-IP block comes first, so the first exact match is the right one.
  const exitIp = addressAfter(nodes, 'IP Address', DNS_LABELS)

  // The resolver table: rows of (operator, address) with nothing structural
  // joining them. Pairing on "the last label before each address" is sturdier
  // than counting columns, because IPv4 and IPv6 rows interleave and a row
  // whose operator is unknown renders with the name cell empty.
  const header = nodes.findIndex((n) => n.text.trim() === 'IP Address :')
  const servers: DnsFacts['servers'] = []
  if (header !== -1) {
    let pending: string | null = null
    for (const n of nodes.slice(header + 1)) {
      const t = n.text.trim()
      if (!t) continue
      if (/^(Leave a Comment|BrowserLeaks|All Rights Reserved)/i.test(t)) break
      if (isAddress(t)) {
        servers.push({ isp: pending, ip: t })
        pending = null
      } else if (t.split(/\s+/).some(isAddress)) {
        // A cell holding an address TOKEN is not an operator name. On one run
        // the operator column had not resolved yet and the address column
        // rendered as `"SG 79.127.170.12"` — flag plus address in one node —
        // which the previous rule happily filed as the resolver's operator, and
        // findings were then written about a company called "SG 79.127.170.12".
        //
        // Token-wise, not `ipIn`: `ipIn` only knows IPv4, so the v6 half of the
        // same table still slipped through. Unknown is the right answer here.
        pending = null
      } else {
        pending = t
      }
    }
  }

  return {
    exitIp,
    isp: valueAfter(nodes, 'ISP', DNS_LABELS),
    location: valueAfter(nodes, 'Location', DNS_LABELS),
    summary: dnsSummary(nodes),
    servers,
  }
}

const WEBRTC_LABELS = [
  'IPv4 Address',
  'IPv6 Address',
  'Local IP Address',
  'Public IP Address',
  // The headings that follow the last field in each block. Without them, an
  // empty field reads as though its value were the next heading.
  'WebRTC Support Detection :',
  'Your WebRTC IP :',
  'Session Description :',
  'Media Devices :',
] as const

export interface WebrtcFacts {
  remoteIp: string | null
  localIps: string[]
  publicIp: string | null
  verdicts: string[]
  peerConnection: boolean
}

/**
 * The WebRTC page finishes by writing its own verdict into `rtc-leak`, in one
 * of a handful of phrasings. Waiting on that rather than on the address fields
 * matters because "no public IP leak" renders as an EMPTY field — identical,
 * to a dump, to "the probe has not come back yet".
 */
export function webrtcVerdicts(nodes: UiNode[]): string[] {
  return texts(nodes).filter((t) => /(?:Public IP Leak|exposes your Local IP|No Leak)/i.test(t))
}

export function readWebrtc(nodes: UiNode[]): WebrtcFacts {
  const localIps = new Set<string>()
  // Both the labelled row and any address inside the SDP blob. The SDP is
  // where the candidates actually live, and it is an EditText (`rtc-sdp`) that
  // carries its whole body as one string.
  const fromLabel = addressAfter(nodes, 'Local IP Address', WEBRTC_LABELS)
  if (fromLabel) localIps.add(fromLabel)
  const sdp = nodes.find((n) => n.resourceId === 'rtc-sdp')?.text ?? ''
  for (const m of sdp.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
    const ip = m[1]
    // `0.0.0.0` and `127.0.0.1` appear in every SDP as placeholders; they are
    // not candidates, and reporting them as exposed addresses would be noise.
    if (ip && ip !== '0.0.0.0' && ip !== '127.0.0.1') localIps.add(ip)
  }

  return {
    remoteIp: addressAfter(nodes, 'IPv4 Address', WEBRTC_LABELS),
    localIps: [...localIps],
    publicIp: addressAfter(nodes, 'Public IP Address', WEBRTC_LABELS),
    verdicts: webrtcVerdicts(nodes),
    peerConnection: texts(nodes).some((t) => /RTCPeerConnection/i.test(t)),
  }
}

/* ------------------------------------------------------------------ */
/* The comparison, which is the point                                  */
/* ------------------------------------------------------------------ */

export type Severity = 'info' | 'warn' | 'leak'

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
}

/**
 * Turn three pages of facts into findings.
 *
 * Deliberately no single boolean. Whether something is "a leak" depends on
 * what the operator meant to happen, and this script does not know that — it
 * knows what the network revealed. So each finding names one concrete
 * disagreement and says what it implies, and `verdict` is only a summary of
 * the worst severity present.
 *
 * The one inference worth making is the last: a tunnel interface visible to
 * WebRTC while DNS is still answered by the carrier means the tunnel is
 * installed but not carrying the traffic. That is the failure mode a device
 * farm actually has, and no single page reports it.
 */
export function assess(input: { whoer: WhoerFacts | null; dns: DnsFacts | null; webrtc: WebrtcFacts | null }): {
  findings: Finding[]
  verdict: 'clean' | 'fingerprintable' | 'leaking' | 'unknown'
} {
  const { whoer, dns, webrtc } = input
  const findings: Finding[] = []
  const exitIps = [whoer?.exitIp, dns?.exitIp, webrtc?.remoteIp].filter((v): v is string => Boolean(v))
  const exitIp = exitIps[0] ?? null
  const exitIsp = dns?.isp ?? whoer?.isp ?? null

  // Do the sites agree on who is asking? They should: one device, one route.
  const distinct = [...new Set(exitIps)]
  if (distinct.length > 1) {
    findings.push({
      id: 'exit-ip-disagreement',
      severity: 'leak',
      title: 'The sites saw different exit addresses',
      detail:
        `${distinct.join(', ')} — the route is not the same for every destination, ` +
        'which is what a partial or per-app tunnel looks like from outside.',
    })
  }

  if (dns) {
    if (dns.servers.length === 0) {
      findings.push({
        id: 'dns-no-servers',
        severity: 'info',
        title: 'No DNS resolvers were reported',
        detail: 'The page finished without listing a server, so nothing can be concluded about DNS.',
      })
    } else {
      const resolverOrgs = [...new Set(dns.servers.map((s) => s.isp).filter((v): v is string => Boolean(v)))]
      const matching = resolverOrgs.filter((org) => sameOrg(org, exitIsp))
      if (matching.length > 0) {
        findings.push({
          id: 'dns-resolver-is-exit-isp',
          severity: 'warn',
          title: 'DNS is answered by the same network as the exit address',
          detail:
            `resolver operator ${matching.join(', ')} matches the exit ISP ${JSON.stringify(exitIsp)}. ` +
            'Harmless on a direct connection; on a tunnelled one it means DNS is bypassing the tunnel.',
        })
      } else {
        findings.push({
          id: 'dns-resolver-third-party',
          severity: 'info',
          title: 'DNS is answered by a different operator than the exit address',
          detail: `resolvers: ${resolverOrgs.join(', ') || 'unknown'}; exit ISP: ${exitIsp ?? 'unknown'}.`,
        })
      }
      // The check that does not depend on the operator names arriving.
      const onExitNetwork = dns.servers.filter((s) => sharesNetwork(s.ip, exitIp))
      if (onExitNetwork.length > 0) {
        findings.push({
          id: 'dns-resolver-on-exit-network',
          severity: 'warn',
          title: 'A resolver sits in the same network block as the exit address',
          detail:
            `${onExitNetwork.map((s) => s.ip).join(', ')} shares a /16 with the exit address ${exitIp}. ` +
            'Expected on a direct connection; on a tunnelled one it is DNS going around the tunnel.',
        })
      }

      const v6 = dns.servers.filter((s) => s.ip.includes(':'))
      if (v6.length > 0) {
        findings.push({
          id: 'dns-ipv6-resolvers',
          severity: 'info',
          title: 'Some resolvers answered over IPv6',
          detail:
            `${v6.length} of ${dns.servers.length}. IPv6 routinely escapes an IPv4-only tunnel, so this is ` +
            'the first place to look if the exit address is ever inconsistent.',
        })
      }
    }
  }

  if (webrtc) {
    if (webrtc.publicIp && exitIp && webrtc.publicIp !== exitIp) {
      findings.push({
        id: 'webrtc-public-ip-leak',
        severity: 'leak',
        title: 'WebRTC published a public address that is not the exit address',
        detail: `WebRTC says ${webrtc.publicIp}; the sites see ${exitIp}. This is a real leak — the page learns both.`,
      })
    }
    const tunnelIps = webrtc.localIps.filter((ip) => addressKind(ip) === 'tunnel')
    const privateIps = webrtc.localIps.filter((ip) => addressKind(ip) === 'private')
    if (tunnelIps.length > 0) {
      findings.push({
        id: 'webrtc-tunnel-interface-exposed',
        severity: 'warn',
        title: 'WebRTC exposed a tunnel interface address',
        detail:
          `${tunnelIps.join(', ')} is in 198.18.0.0/15, which no ISP routes — it belongs to a local tunnel. ` +
          'The address itself is worthless to the page, but its presence says this device is behind one.',
      })
    }
    if (privateIps.length > 0) {
      findings.push({
        id: 'webrtc-local-ip-exposed',
        severity: 'warn',
        title: 'WebRTC exposed a private LAN address',
        detail: `${privateIps.join(', ')} — usable for fingerprinting and for mapping the network the device sits on.`,
      })
    }
    if (webrtc.localIps.length === 0 && webrtc.peerConnection) {
      findings.push({
        id: 'webrtc-no-candidates',
        severity: 'info',
        title: 'WebRTC is available but published no addresses',
        detail: 'mDNS candidate obfuscation is doing its job, or the tunnel blocks STUN outright.',
      })
    }
  }

  // whoer reports the resolver IT saw, from a different vantage point and at a
  // different moment. A second opinion costs nothing here and covers the case
  // where browserleaks' own list came back empty.
  if (whoer?.dns && sharesNetwork(whoer.dns, exitIp)) {
    findings.push({
      id: 'dns-resolver-on-exit-network',
      severity: 'warn',
      title: 'The resolver whoer observed sits in the exit address block',
      detail: `${whoer.dns} shares a /16 with ${exitIp}.`,
    })
  }

  // The inference neither page makes on its own.
  if (webrtc && dns && webrtc.localIps.some((ip) => addressKind(ip) === 'tunnel')) {
    if (dns.servers.some((s) => sameOrg(s.isp, exitIsp) || sharesNetwork(s.ip, exitIp))) {
      findings.push({
        id: 'tunnel-present-but-bypassed',
        severity: 'leak',
        title: 'A tunnel is installed but traffic is not going through it',
        detail:
          'WebRTC sees a tunnel interface, yet DNS is answered by the exit ISP itself — ' +
          'the interface is up and the traffic is going around it.',
      })
    }
  }

  const verdict = findings.some((f) => f.severity === 'leak')
    ? 'leaking'
    : findings.some((f) => f.severity === 'warn')
      ? 'fingerprintable'
      : findings.length > 0
        ? 'clean'
        : 'unknown'

  return { findings, verdict }
}

/* ------------------------------------------------------------------ */

/**
 * The `networking` pack — everything that answers "what does this device look like to the
 * internet, and is anything leaking around the tunnel". `leak-test` is its first member; the pack
 * exists so the next one (an exit-address watcher, a DNS-only probe) has an obvious home rather
 * than becoming another loose script.
 */
export default definePlugin({
  id: 'networking',
  version: '3.0.0',
  title: 'Networking',
  description: 'Leak and egress checks driven through a real browser on the device.',
  scripts: [
    {
      id: 'leak-test',
      title: 'Browser leak test',
      description:
        'Opens Chrome in a fresh tab, reads whoer.net, browserleaks DNS and WebRTC, and reports the exit address, resolvers, and any address that escapes the tunnel.',
  /**
   * NO PARAMETERS, on purpose.
   *
   * The audience here is an operator or an agent asking one question — what does this device look
   * like to the internet, and is anything escaping the tunnel. Every knob this used to expose
   * either could not be changed safely or changed nothing about that answer:
   *
   * - `package` was a lie. Every selector in this file is a `com.android.chrome:id/...`, so pointing
   *   it at another browser produces a run that finds nothing and then reports it as a network
   *   fault. Marking it `hidden` was worse than removing it: the form does not honour that flag, so
   *   it still rendered — a field that could break the run, dressed as one nobody could see.
   * - `checks` asked which of the three pages to visit. A leak report missing its DNS half is not a
   *   faster report, it is a wrong one.
   * - `humanTyping` stopped meaning anything once navigation moved to an intent.
   * - `pageTimeoutMs`, `pageAttempts`, `settleReads` are engineering constants. They live next to
   *   the code they govern, where changing one is a decision with a reason attached rather than a
   *   number typed into a box by someone who cannot see what it does.
   *
   * Press Run. It reports.
   */
  params: z.object({}),
  timeout: 480_000,
  // No script-level retries: a partial run leaves Chrome open on some page,
  // and `finish` restores the phone. The retries that matter are per-page,
  // inside `run`, where there is enough context to retry the right thing.
  retries: 0,

  async prepare(ctx) {
    // Start from a cold Chrome. Without this a restored session leaves the
    // previous tab in front, and the script measures a page it did not open —
    // and still passes, which is worse than failing.
    ctx.log.info(`stopping ${CHROME_PACKAGE} for a clean start`)
    await ctx.device.app.forceStop(CHROME_PACKAGE)
    await ctx.device.app.launch(CHROME_PACKAGE)
    await sleep(3_000)
  },

  async run(ctx) {
    // Fixed, and deliberately not operator-facing — see the `params` comment above.
    const pkg = CHROME_PACKAGE
    const pageTimeoutMs = 75_000
    const pageAttempts = 2
    const settleReads = 3
    const humanTyping = false

    // A NEW tab, as asked — not whatever Chrome restored.
    //
    // `optional_toolbar_button` is the `+` beside the omnibox. "Optional" is
    // literal: Chrome swaps that slot for share or voice search depending on
    // configuration, so the tap is checked against the tab counter rather than
    // trusted. Typing into someone else's restored tab is how earlier runs
    // ended up measuring the wrong page.
    const openedTab = await openNewTab(ctx)

    let whoer: WhoerFacts | null = null
    let dns: DnsFacts | null = null
    let webrtc: WebrtcFacts | null = null
    let deniedPrompt = false
    const visited: Array<{ url: string; attempts: number; reloads: number }> = []
    /** Pages that answered but were still changing when their budget expired. */
    const partial: string[] = []

    /** Drive to one page, wait for it to finish, and read it. */
    const visit = async <T>(
      name: string,
      url: string,
      ready: (nodes: UiNode[]) => boolean,
      read: (nodes: UiNode[]) => T,
      fingerprint: (nodes: UiNode[]) => string,
      acceptable?: (nodes: UiNode[]) => boolean,
    ): Promise<T> => {
      const result = await withRetry(ctx, name, pageAttempts, async (attempt) => {
        ctx.log.info(`opening ${url}`, { attempt, of: pageAttempts })
        await navigate(ctx, url, humanTyping, pkg)
        const page = await awaitPage(ctx, {
          url,
          humanTyping,
          package: pkg,
          ready,
          acceptable,
          budgetMs: pageTimeoutMs,
          maxReloads: 2,
          settle: { fingerprint, stableFor: settleReads, intervalMs: 2_500 },
        })
        if (page.deniedPrompt) deniedPrompt = true
        if (!page.settled) partial.push(url)

        // Prove the script is the reason the page is there.
        //
        // An earlier version stopped at "the marker text is on screen" and
        // reported success while it had navigated nowhere — the text was left
        // over from a previous session. A screenshot of an entirely different
        // site is what exposed it.
        const shown = (pickAddressBar(await ctx.device.dump())?.text ?? '').trim()
        if (!sameAddress(shown, url)) {
          throw new Error(`the address bar reads ${JSON.stringify(shown)}, not ${JSON.stringify(url)}`)
        }
        visited.push({ url, attempts: attempt, reloads: page.reloads })
        return read(page.nodes)
      })
      await ctx.artifact.screenshot(name)
      return result
    }

    {
      whoer = await visit('whoer', 'whoer.net', whoerReady, readWhoer, (n) => {
        const f = readWhoer(n)
        return [f.exitIp, f.isp, f.dns, f.hostname].join('|')
      })
      ctx.log.info('whoer read', { ...whoer })
    }
    {
      dns = await visit(
        'dns-leak',
        'browserleaks.com/dns',
        dnsComplete,
        readDns,
        // Both the count line and the rows: the count moves as answers arrive,
        // and the operator names fill in afterwards without changing it.
        (n) => {
          const f = readDns(n)
          return `${f.summary}|${f.servers.map((s2) => `${s2.isp ?? '?'}@${s2.ip}`).join(',')}`
        },
        // Enough to be worth reporting: the page named at least one resolver.
        (n) => readDns(n).servers.length > 0,
      )
      ctx.log.info('dns leak test read', {
        summary: dns.summary,
        exitIp: dns.exitIp,
        isp: dns.isp,
        servers: dns.servers.length,
      })
    }
    {
      webrtc = await visit(
        'webrtc-leak',
        'browserleaks.com/webrtc',
        (n) => webrtcVerdicts(n).length > 0,
        readWebrtc,
        (n) => {
          const f = readWebrtc(n)
          return `${f.verdicts.join(',')}|${f.localIps.join(',')}|${f.publicIp}`
        },
      )
      ctx.log.info('webrtc leak test read', {
        remoteIp: webrtc.remoteIp,
        localIps: webrtc.localIps.join(', '),
        publicIp: webrtc.publicIp,
        verdicts: webrtc.verdicts.join(' / '),
      })
    }

    const { findings, verdict } = assess({ whoer, dns, webrtc })
    for (const f of findings) {
      const line = `${f.title} — ${f.detail}`
      if (f.severity === 'leak') ctx.log.warn(`LEAK: ${line}`)
      else if (f.severity === 'warn') ctx.log.warn(line)
      else ctx.log.info(line)
    }
    ctx.log.info(`verdict: ${verdict}`, { findings: findings.length })

    // Close the tab that was opened — verified, like opening it was.
    //
    // The tab switcher is the only route; Chrome's menu has no "close tab".
    // The close affordance inside it is a content description, which is
    // localised (this device is Indonesian, so "Tutup"), hence matching a small
    // set rather than one English string.
    //
    // And only when this run opened one. A previous run left an extra tab
    // behind, and the close step happily took it: the counter went 2 → 1 and
    // the result said `openedTab: false, tabClosed: true`, which is a script
    // closing somebody else's tab and reporting it as tidying up after itself.
    let tabClosed = false
    const switcher = openedTab ? pickById(await ctx.device.dump(), 'com.android.chrome:id/tab_switcher_button') : null
    if (!openedTab) ctx.log.info('no tab was opened by this run, so none is closed')
    if (switcher) {
      const before = tabCount(flatten(await ctx.device.dump()))
      await ctx.device.tap({ point: centreOf(switcher) })
      await sleep(1_800)
      const inSwitcher = flatten(await ctx.device.dump())
      const close =
        inSwitcher.find((n) => /close|tutup/i.test(n.desc)) ??
        inSwitcher.find((n) => /(?:close_button|action_button)$/.test(n.resourceId)) ??
        null
      if (close) {
        await ctx.device.tap({ point: centreOf(close) })
        await sleep(1_500)
        // Leave the switcher BEFORE counting: the counter lives on the toolbar,
        // and the toolbar is not on screen while the switcher is — reading it
        // here returned null and reported a working close as a failure.
        await ctx.device.key('BACK')
        await sleep(1_500)
        const after = tabCount(flatten(await ctx.device.dump()))
        tabClosed = before !== null && after !== null && after < before
        ctx.log.info(tabClosed ? 'closed the tab' : 'tapped close but the count did not drop', { before, after })
      } else {
        ctx.log.warn('no close control in the tab switcher', {
          candidates: inSwitcher
            .map((n) => n.resourceId)
            .filter(Boolean)
            .slice(0, 12),
        })
        await ctx.device.key('BACK')
      }
    }

    return {
      ok: true,
      verdict,
      exitIp: whoer?.exitIp ?? dns?.exitIp ?? webrtc?.remoteIp ?? null,
      exitIsp: dns?.isp ?? whoer?.isp ?? null,
      location: dns?.location ?? null,
      findings,
      whoer,
      dns,
      webrtc,
      visited,
      /** Pages whose values were still moving when the budget ran out — read as incomplete. */
      partial,
      /** True when Chrome asked for a permission mid-run and the script declined it. */
      deniedPrompt,
      openedTab,
      tabClosed,
    }
  },

  async finish(ctx) {
    // Stateless and idempotent: it reads `ctx` and nothing else, so the core
    // may run it again in a fresh process after a timeout kill and get the
    // same result.
    if (ctx.error) await ctx.artifact.screenshot('failed')
    // `clearRecents` too — see the tiktok pack's own `finish` for why force-stop is not enough.
    await ctx.device.app.forceStop(CHROME_PACKAGE, { clearRecents: true })
    await ctx.device.key('HOME')
  },
  },
  ],
})
