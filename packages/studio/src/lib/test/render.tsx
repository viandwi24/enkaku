/**
 * `renderWithApi` (plan 72 §4.4) — a component test declares what the core
 * returns instead of hand-mocking `fetch` in every file. Every Studio smoke
 * render and component test goes through this so `fetch` is stubbed the
 * same way everywhere.
 *
 * The DOM itself is registered by `packages/studio/bunfig.toml`'s preload
 * of `happydom.ts` — REQUIRED reading if you are about to run a Studio
 * component test any way other than `bun run --cwd packages/studio test`
 * (or a plain `bun test` with that cwd): `@testing-library/dom`'s `screen`
 * binding is computed once at first import, before this file's own
 * same-directory `import` below would take effect, so this import alone
 * is a defensive fallback, not the real mechanism.
 */
import '../../../happydom'
import type { ReactElement } from 'react'
import { cleanup, render, type RenderResult } from '@testing-library/react'

/**
 * `raw`, when given, is returned AS THE RESPONSE VERBATIM instead of being
 * JSON-encoded — the only way to mock a streaming body (e.g. `useChat`'s
 * `text/event-stream` chat transport, plan 83 §4.2/§7), which is not a JSON
 * document at all. `status`/`body` are ignored when `raw` is present.
 */
export type MockResult = { status?: number; body?: unknown; raw?: Response }
export type MockEntry = MockResult | ((req: { method: string; path: string; body: unknown }) => MockResult | Promise<MockResult>)

export interface ApiMockCall {
  path: string
  method: string
  body: unknown
}

export interface ApiMock {
  calls: ApiMockCall[]
  restore(): void
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true
  if (!pattern.includes('*')) return false
  const escaped = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(path)
}

/**
 * Installs a `fetch` stub keyed by path (exact, or `*`-wildcarded — e.g.
 * `'/api/devices/*'`). An unmatched call 404s by default; pass
 * `unmatched: 'pending'` to exercise a loading state (the promise never
 * resolves, which is exactly what a still-loading screen looks like).
 */
export function installApiMock(responses: Record<string, MockEntry> = {}, opts: { unmatched?: '404' | 'pending' } = {}): ApiMock {
  const calls: ApiMockCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const full = String(url)
    const path = full.replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path, method, body })

    const key = Object.keys(responses).find((k) => pathMatches(k, path))
    if (!key) {
      if (opts.unmatched === 'pending') return new Promise<Response>(() => {})
      return new Response(JSON.stringify({ error: { code: 'E_NOT_FOUND', message: `no mock for ${method} ${path}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const entry = responses[key]!
    const resolved = typeof entry === 'function' ? await entry({ method, path, body }) : entry
    if (resolved.raw) return resolved.raw
    const status = resolved.status ?? 200
    return new Response(resolved.body === undefined ? null : JSON.stringify(resolved.body), {
      status,
      headers: resolved.body === undefined ? {} : { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/**
 * Renders `ui` with `fetch` stubbed from `responses`. Callers are
 * responsible for `afterEach(cleanup)` (re-exported below) — Bun's test
 * runner does not put `afterEach` on `globalThis`, so `@testing-library/react`'s
 * own auto-cleanup detection never fires.
 */
export function renderWithApi(
  ui: ReactElement,
  responses: Record<string, MockEntry> = {},
  opts: { unmatched?: '404' | 'pending' } = {},
): RenderResult & { apiMock: ApiMock } {
  const apiMock = installApiMock(responses, opts)
  const result = render(ui)
  return { ...result, apiMock }
}

export { cleanup }
