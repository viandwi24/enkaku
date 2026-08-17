import { z } from 'zod'

/**
 * Plan 108 §3.2 tier B, §4.4, §5 step 108.10 — the ONLY channel between a
 * sandboxed plugin frame and Studio, and the design-token block the host hands
 * it so the two look like one product.
 *
 * Pure and DOM-free apart from one injected reader, so the grammar can be
 * tested the way `binding.ts` is: with no React, no iframe, and no browser.
 *
 * ## What the frame can and cannot say
 *
 * A tier-B frame is `<iframe sandbox="allow-scripts">` with **no**
 * `allow-same-origin`, so its document has an opaque origin: it cannot read
 * Studio's DOM, its storage, or its cookies, and the CSP the asset route
 * serves (`connect-src 'none'`) means it cannot `fetch` anything either. The
 * only thing it can do is `postMessage` to its parent, and the only messages
 * the parent will act on are the three below:
 *
 * | frame → host | maps onto |
 * |---|---|
 * | `ready` | nothing — it asks for the `init` message again |
 * | `data.query` | the view's OWN declared `data` source, over the same helper a tier-A table uses |
 * | `action.run` | `POST /api/plugins/:name/action/:actionId`, for an action THIS VIEW declared |
 *
 * There is no `namespace`, no `script`, no `scope`, no `key` and no URL
 * anywhere in this grammar, and that is the point (§4.4: "the frame changes
 * the *rendering*, never the *authority*"). A tier-B plugin can reach exactly
 * what it could have declared in tier A, and the host re-checks the action id
 * against the view's own declarations before it sends anything, because a
 * frame is untrusted input like any other.
 *
 * ## `data.query` on a frame view
 *
 * `ViewSpecSchema` makes `frame` and `data`/`table` mutually exclusive, so a
 * frame view declares no data source today and `data.query` answers
 * `no_data_source`. That is not an oversight and the method is not dead
 * weight: it is the statement, in code, that a frame reads its plugin's data
 * through a DECLARED source or not at all. If the vocabulary ever lets a frame
 * declare one, this already routes it through the same code path — and the
 * same permission — a table does.
 */

/** Versioned, so a frame built against a future grammar is ignored rather than half-understood. */
export const FRAME_PROTOCOL = 'enkaku.plugin-frame.v1'

const ProtocolSchema = z.literal(FRAME_PROTOCOL)
const CallIdSchema = z.string().min(1).max(64)

/**
 * What the host will act on. `.strict()` throughout: an unknown member is a
 * frame reaching for something this grammar does not have, and the right
 * answer to that is to ignore the message, not to honour the part of it that
 * happens to parse.
 */
export const FrameRequestSchema = z.discriminatedUnion('method', [
  z.object({ protocol: ProtocolSchema, method: z.literal('ready') }).strict(),
  z.object({ protocol: ProtocolSchema, method: z.literal('data.query'), id: CallIdSchema }).strict(),
  z
    .object({
      protocol: ProtocolSchema,
      method: z.literal('action.run'),
      id: CallIdSchema,
      /** Re-checked against the view's own declared actions before anything is sent. */
      actionId: z.string().min(1).max(64),
      /** The same three members `PluginActionBodySchema` accepts, and no others. */
      row: z.unknown().optional(),
      form: z.unknown().optional(),
      deviceIds: z.array(z.string().min(1)).max(1000).optional(),
    })
    .strict(),
])
export type FrameRequest = z.infer<typeof FrameRequestSchema>

/** Why a call was refused. A closed list, so a frame can branch on it. */
export type FrameErrorCode = 'action_not_declared' | 'no_data_source' | 'request_failed'

export type FrameHostMessage =
  | { protocol: typeof FRAME_PROTOCOL; type: 'init'; plugin: string; viewId: string; actions: string[]; tokens: string }
  | { protocol: typeof FRAME_PROTOCOL; type: 'result'; id: string; ok: true; data: unknown }
  | { protocol: typeof FRAME_PROTOCOL; type: 'result'; id: string; ok: false; error: { code: FrameErrorCode; message: string } }

/**
 * The design tokens the frame is given (§4.4: "Studio injects its design
 * tokens as CSS custom properties … plus a minimal reset — so colours,
 * spacing, radius, and typography match").
 *
 * Read from the LIVE document rather than hardcoded, so a palette change in
 * `globals.css` reaches every plugin frame with no edit here. The fallbacks
 * below exist only for the case where a computed value comes back empty (a
 * test DOM, a stylesheet that has not applied yet) — they mirror
 * `app/globals.css` and are not a second source of truth: whenever the real
 * value is available it wins.
 */
export const FRAME_TOKENS: ReadonlyArray<readonly [name: string, fallback: string]> = [
  ['--color-bg', 'oklch(0.185 0.012 245)'],
  ['--color-surface', 'oklch(0.209 0.004 245)'],
  ['--color-surface-2', 'oklch(0.159 0.004 245)'],
  ['--color-surface-3', 'oklch(0.27 0.006 245)'],
  ['--color-line', 'oklch(0.325 0.002 245)'],
  ['--color-line-strong', 'oklch(0.341 0.002 245)'],
  ['--color-fg', 'oklch(0.961 0.002 245)'],
  ['--color-fg-muted', 'oklch(0.64 0.004 245)'],
  ['--color-fg-subtle', 'oklch(0.52 0.004 245)'],
  ['--color-accent', 'oklch(0.756 0.130 250.5)'],
  ['--color-accent-strong', 'oklch(0.82 0.14 250.5)'],
  ['--color-accent-fg', 'oklch(0.16 0.02 245)'],
  ['--color-led-ok', 'oklch(0.800 0.182 151.7)'],
  ['--color-led-warn', 'oklch(0.88 0.17 108)'],
  ['--color-led-danger', 'oklch(0.691 0.199 23.9)'],
  ['--font-sans', 'ui-sans-serif, system-ui, sans-serif'],
  ['--font-mono', 'ui-monospace, SFMono-Regular, monospace'],
  ['--radius-card', '0.5rem'],
]

/**
 * The minimal reset that rides with the tokens. Deliberately small: it sets
 * the page's ground, the body text, and the two things every frame gets wrong
 * on its own (the default 8px body margin and a link colour that fights the
 * palette). It does not attempt to restyle controls — §3.2 is explicit that
 * Studio's components do NOT cross the boundary, and a reset pretending
 * otherwise would produce something that looks like a `Button` and behaves
 * like nothing.
 */
const FRAME_RESET = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  'body{background:var(--color-bg);color:var(--color-fg);font-family:var(--font-sans);font-size:12.5px;line-height:1.5;-webkit-font-smoothing:antialiased}',
  'a{color:var(--color-accent)}',
  'code,kbd,pre,samp{font-family:var(--font-mono)}',
  'button,input,optgroup,select,textarea{font:inherit;color:inherit}',
  'hr{border:0;border-top:1px solid var(--color-line)}',
].join('')

/** A CSS value, made safe to place inside a declaration. A token value cannot contain a `}` or a `;` and still be a token. */
function sanitiseValue(value: string): string {
  return value.replace(/[;{}<>]/g, '').trim()
}

/**
 * The stylesheet the host posts to the frame: every token as a custom property
 * on `:root`, then the reset.
 *
 * `read` is injected so this is testable with no DOM; `FrameView` passes the
 * real `getComputedStyle` reader.
 */
export function buildFrameStylesheet(read: (name: string) => string): string {
  const declarations = FRAME_TOKENS.map(([name, fallback]) => {
    const live = sanitiseValue(read(name) ?? '')
    return `${name}:${live.length > 0 ? live : fallback}`
  }).join(';')
  return `:root{${declarations}}${FRAME_RESET}`
}

/** The reader `FrameView` uses in a browser — the live value of a custom property on the document root. */
export function readDocumentToken(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return ''
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name)
  } catch {
    return ''
  }
}
