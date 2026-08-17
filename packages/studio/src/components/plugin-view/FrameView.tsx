'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { PluginActionResponseSchema, type ActionSpec, type ViewSpec } from '@enkaku/protocol'
import { fetchPluginRows } from '@/components/plugin-view/data'
import {
  FRAME_PROTOCOL,
  FrameRequestSchema,
  buildFrameStylesheet,
  readDocumentToken,
  type FrameHostMessage,
} from '@/components/plugin-view/frame-rpc'
import { api } from '@/lib/actions'
import { coreBase } from '@/lib/ws'

/**
 * Plan 108 §3.2 tier B, §4.4, §5 step 108.10 — the escape hatch: a plugin's
 * own HTML, drawn inside a sandboxed frame.
 *
 * ## What this component is, and what it costs
 *
 * Tier A (`ViewRenderer`) draws with Studio's REAL components. Tier B cannot:
 * `Table` and `Button` are React in the parent document and do not cross a
 * frame boundary. §3.2 states that as the accepted cost of this tier, and this
 * file does not try to buy it back — there is no bridge, no serialised React
 * tree, and no component protocol. What the frame does inherit is the
 * PALETTE: the host posts its design tokens as CSS custom properties plus a
 * minimal reset (`frame-rpc.ts`), which the frame's own bootstrap applies.
 *
 * ## The sandbox is the whole security model
 *
 * `sandbox="allow-scripts"` — and deliberately **not**
 * `allow-same-origin`. Those two together would be worse than no sandbox at
 * all: a frame that is both scripted and same-origin can reach into the
 * parent document and call every API as the operator, which is exactly the
 * module-federation tier (§3.2 C) the plan refuses permanently. Without
 * `allow-same-origin` the frame's document has an opaque origin, so it holds
 * no cookie, no storage, and no reference into Studio.
 *
 * The server backs this up rather than trusting it: `GET
 * /api/plugins/:name/ui/*` serves every byte with `sandbox allow-scripts` in
 * its own CSP and `connect-src 'none'`, so the frame has no `fetch`, no
 * `XMLHttpRequest` and no `WebSocket` to ANY host — including the farm.
 *
 * ## The RPC, and why an action id is re-checked here
 *
 * The frame's only channel is `postMessage`, and this component acts on three
 * messages (`frame-rpc.ts` documents the grammar). Every inbound message is
 * checked three times before it is honoured — it must come from THIS frame's
 * window, it must carry an origin the sandbox can produce, and it must parse
 * against `FrameRequestSchema` — and an `action.run` must then name an action
 * **this view declared**. The server checks that too (`GET
 * /:name/view/:viewId` narrows the map, and the executor looks the id up in
 * the verified surface), so this is the second of two independent gates rather
 * than the only one; it exists because the cheapest place to refuse a
 * fabricated id is before a request is made at all.
 *
 * The frame is never handed a token, a cookie, or a URL. It cannot choose what
 * an action does — only which declared action runs, over which row — exactly
 * the authority `PluginActionBodySchema` gives a tier-A click.
 */

/** `null` is what a `sandbox`ed, non-`allow-same-origin` document reports as its origin. Studio's own origin is accepted too, so a browser that ever reports the real one is not silently broken. */
function allowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>(['null'])
  const base = coreBase()
  if (base) origins.add(base)
  if (typeof location !== 'undefined' && location.origin) origins.add(location.origin)
  return origins
}

/**
 * The frame's URL. Each SEGMENT is encoded, never the whole path — a
 * `frame.entry` of `assets/app.html` has to stay two segments, and
 * `encodeURIComponent` over the lot would turn its `/` into `%2F` and 404.
 * The core resolves what arrives here by exact match against the package's own
 * entry list, so a hostile `entry` reaches nothing (`plugins/asset-store.ts`).
 */
function frameSrc(plugin: string, entry: string): string {
  const path = entry
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${coreBase()}/api/plugins/${encodeURIComponent(plugin)}/ui/${path}`
}

export interface FrameViewProps {
  plugin: string
  viewId: string
  view: ViewSpec
  /** Only the actions this view references — `GET /:name/view/:viewId` already narrowed them, and this component narrows nothing further. */
  actions: Record<string, ActionSpec>
}

export function FrameView({ plugin, viewId, view, actions }: FrameViewProps) {
  const ref = useRef<HTMLIFrameElement | null>(null)
  const frame = view.frame
  const declared = useMemo(() => new Set(Object.keys(actions)), [actions])
  const source = view.data

  const post = useCallback((message: FrameHostMessage) => {
    const target = ref.current?.contentWindow
    if (!target) return
    // `'*'` is not a widening: the target is THIS frame's window, and its
    // origin is opaque (`'null'`), which no `targetOrigin` string can name.
    // Nothing here carries a credential — the tokens are a stylesheet, and a
    // result is data the operator is already looking at.
    target.postMessage(message, '*')
  }, [])

  const init = useCallback(() => {
    post({
      protocol: FRAME_PROTOCOL,
      type: 'init',
      plugin,
      viewId,
      // What the frame is ALLOWED to run, stated up front so a well-behaved
      // frame never has to guess and a misbehaving one learns nothing it could
      // not have read in its own manifest.
      actions: [...declared],
      tokens: buildFrameStylesheet(readDocumentToken),
    })
  }, [post, plugin, viewId, declared])

  useEffect(() => {
    const origins = allowedOrigins()

    const onMessage = (event: MessageEvent) => {
      const element = ref.current
      if (!element) return
      // Gate 1 — it must be THIS frame. Any other window (another frame, an
      // opener, the top window, a browser extension) is ignored outright.
      if (!event.source || event.source !== element.contentWindow) return
      // Gate 2 — an origin the sandbox can actually produce.
      if (!origins.has(event.origin)) return
      // Gate 3 — the closed grammar. Anything else is dropped in silence:
      // answering an unparseable message would tell a probing frame which of
      // its guesses was closest.
      const parsed = FrameRequestSchema.safeParse(event.data)
      if (!parsed.success) return
      const request = parsed.data

      if (request.method === 'ready') {
        init()
        return
      }

      if (request.method === 'data.query') {
        if (!source) {
          post({
            protocol: FRAME_PROTOCOL,
            type: 'result',
            id: request.id,
            ok: false,
            error: { code: 'no_data_source', message: `The view “${viewId}” declares no data source, so there is nothing to query.` },
          })
          return
        }
        void fetchPluginRows(plugin, source)
          .then((rows) => post({ protocol: FRAME_PROTOCOL, type: 'result', id: request.id, ok: true, data: rows }))
          .catch((err: unknown) =>
            post({
              protocol: FRAME_PROTOCOL,
              type: 'result',
              id: request.id,
              ok: false,
              error: { code: 'request_failed', message: err instanceof Error ? err.message : String(err) },
            }),
          )
        return
      }

      // `action.run`. An id this view did not declare is refused HERE, before
      // any request leaves the tab — the frame cannot invent an action, and it
      // cannot reach another view's actions either, because `actions` is
      // already only the ones this view names.
      if (!declared.has(request.actionId)) {
        post({
          protocol: FRAME_PROTOCOL,
          type: 'result',
          id: request.id,
          ok: false,
          error: { code: 'action_not_declared', message: `The view “${viewId}” does not declare an action called “${request.actionId}”.` },
        })
        return
      }

      void api(`/api/plugins/${encodeURIComponent(plugin)}/action/${encodeURIComponent(request.actionId)}`, PluginActionResponseSchema, {
        method: 'POST',
        json: {
          ...(request.row !== undefined ? { row: request.row } : {}),
          ...(request.form !== undefined ? { form: request.form } : {}),
          ...(request.deviceIds && request.deviceIds.length > 0 ? { deviceIds: request.deviceIds } : {}),
        },
      })
        .then((response) => post({ protocol: FRAME_PROTOCOL, type: 'result', id: request.id, ok: true, data: response.result }))
        .catch((err: unknown) =>
          post({
            protocol: FRAME_PROTOCOL,
            type: 'result',
            id: request.id,
            ok: false,
            error: { code: 'request_failed', message: err instanceof Error ? err.message : String(err) },
          }),
        )
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [plugin, viewId, source, declared, post, init])

  if (!frame) return null

  // `height: 'fill'` fills what is left of the page rather than guessing at it
  // with a viewport `calc()` — the page puts this component in an `h-full`
  // flex column below `PageHeader`, so `flex-1 min-h-0` is the whole answer
  // and it stays right when the header's own height changes (plan 73 §3.1,
  // enforced by `design-rules.test.ts`).
  const fill = frame.height !== 'auto'

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col px-5 py-4' : 'px-5 py-4'}>
      <iframe
        ref={ref}
        // Written out rather than composed, so the one attribute this tier's
        // safety rests on is greppable and cannot acquire `allow-same-origin`
        // by a template that "just needed one more flag".
        sandbox="allow-scripts"
        src={frameSrc(plugin, frame.entry)}
        title={view.title}
        referrerPolicy="no-referrer"
        // `onLoad` covers the frame that never says `ready` — a plain
        // `<script>` that applies the tokens on receipt still gets them.
        onLoad={init}
        className={fill ? 'min-h-0 w-full flex-1 rounded-lg border bg-surface' : 'h-[32rem] w-full rounded-lg border bg-surface'}
      />
    </div>
  )
}
