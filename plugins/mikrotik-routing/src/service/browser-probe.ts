import type { UiNode } from '@enkaku/protocol'

/**
 * Drives Chrome to a URL and polls the on-device UI tree until a pure
 * extractor (`network-probe.ts`) finds something, or the run's budget runs
 * out — the async half of the "read a network fact off the device's own
 * screen" mechanism `verify-egress`/`discover-lan-ip` both need (§4.8). See
 * `network-probe.ts`'s own header for why a browser page, rather than a
 * shell command, is what the SDK actually makes reachable.
 *
 * Follows the hardware-discovered lessons `plugins/networking`'s own
 * `index.ts` documents at length, WITHOUT importing that plugin's code (its
 * `package.json` declares no `exports`/`main`, so it was never built to be a
 * dependency of another package — this module is a narrower, purpose-built
 * rewrite of the same idea):
 *
 * - An intent hands Chrome the address exactly, once — `ctx.device.app
 *   .launch(pkg, { url })` — never typed through the omnibox. That plugin's
 *   own comment on this: typing races Chrome's own autocomplete and produced
 *   `wwho.erwhoer.net`/`bsssom/dnsom/dns` on real hardware.
 * - A permission prompt (both target pages here can ask for Local Network
 *   Access) is dismissed by tapping its negative button, matched by resource
 *   id first — a visible label is localised, and that plugin's own farm
 *   device showed "Blokir", not "Block".
 *
 * This is deliberately narrower than that plugin's own navigation: one
 * intent, one poll loop, no tab management, no human-typing path, no
 * network-error reload. Both callers here need only "does the page, once it
 * answers, contain the address" rather than a multi-page leak audit. **Not
 * hardware-verified in this session** — no device was available — matching
 * this plugin's own established discipline of naming exactly what is/isn't
 * (`schemas.ts`, `router-driver.ts`'s own header comments).
 */

export interface BrowserProbeDevice {
  app: { launch(pkg: string, opts?: { url?: string }): Promise<void> }
  dump(): Promise<UiNode>
  tap(target: { point: { x: number; y: number } }): Promise<void>
}

export interface BrowserProbeCtx {
  device: BrowserProbeDevice
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }
}

/** The only browser this module drives — matches `plugins/networking`'s own choice: near-universal on a Google-certified farm device, and the intent form (`app.launch`) needs a real package to hand the URL to. */
export const CHROME_PACKAGE = 'com.android.chrome'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function flatten(node: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function centreOf(n: UiNode): { x: number; y: number } {
  return { x: Math.round((n.bounds.left + n.bounds.right) / 2), y: Math.round((n.bounds.top + n.bounds.bottom) / 2) }
}

/** Chrome's (or the OS's) permission-prompt negative button. Exported so a test can prove the matcher against a synthetic tree without driving a browser. */
export function findDenyButton(nodes: readonly UiNode[]): UiNode | null {
  const byId = nodes.find((n) => /(?:negative_button|permission_dialog_deny)$/.test(n.resourceId))
  if (byId) return byId
  return nodes.find((n) => /^(block|blokir|deny|tolak|no thanks)$/i.test(n.text.trim())) ?? null
}

export interface BrowseAndExtractOptions {
  /** Total time budget, from the intent launch to giving up. */
  budgetMs: number
  /** Time between polls once the page has loaded. Default 1500ms. */
  pollMs?: number
}

/**
 * Launch `url` in Chrome and poll `ctx.device.dump()` until `extract`
 * returns non-null or the budget runs out. `extract` receives every node's
 * `text` AND `desc` (content description), flattened in document order and
 * filtered to non-empty strings — a value sometimes lands in one and
 * sometimes the other depending on the device/OEM (`plugins/networking`'s own
 * `texts()`/`tabCount()` make the same choice for the same reason). Returns
 * `null` when the budget runs out with no result — never a guess.
 */
export async function browseAndExtract<T>(ctx: BrowserProbeCtx, url: string, extract: (texts: readonly string[]) => T | null, opts: BrowseAndExtractOptions): Promise<T | null> {
  await ctx.device.app.launch(CHROME_PACKAGE, { url })
  const deadline = Date.now() + opts.budgetMs
  const pollMs = opts.pollMs ?? 1_500

  for (;;) {
    await sleep(pollMs)
    const nodes = flatten(await ctx.device.dump())

    const deny = findDenyButton(nodes)
    if (deny) {
      ctx.log.warn('mikrotik-routing: a permission prompt was blocking the page — denying it', { label: deny.text || deny.resourceId })
      await ctx.device.tap({ point: centreOf(deny) })
      await sleep(1_000)
      continue
    }

    const texts = nodes.flatMap((n) => [n.text, n.desc]).filter((t) => t.length > 0)
    const result = extract(texts)
    if (result !== null) return result

    if (Date.now() >= deadline) return null
  }
}
