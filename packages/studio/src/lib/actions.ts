'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { coreBase } from './ws'

/**
 * One path for every action that calls the core.
 *
 * Each screen used to write its own fetch + try/catch, and it showed:
 * buttons gave no sign they were working, failures surfaced as small red
 * text, and some actions gave no feedback at all.
 */
export interface ApiError {
  code: string
  message: string
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`${coreBase()}${path}`, {
    // Default to POST whenever a body is present — spread BEFORE `...rest` so
    // a caller's own explicit `method` still wins (Plan 42 §4.3). Without
    // this, `fetch` defaulted to GET, and a browser refuses a GET with a
    // body ("Request with GET/HEAD method cannot have body") — the exact
    // failure that blocked install/push/pull before this plan.
    ...(json !== undefined ? { method: 'POST' } : {}),
    ...rest,
    ...(json !== undefined
      ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) } }
      : {}),
  })
  const isJson = res.headers.get('content-type')?.includes('application/json')
  const body = isJson ? await res.json().catch(() => null) : null
  if (!res.ok) {
    const err = (body as { error?: ApiError } | null)?.error
    throw Object.assign(new Error(err?.message ?? `Request failed (HTTP ${res.status})`), {
      code: err?.code ?? 'unknown',
    })
  }
  return body as T
}

export function useAction() {
  const [pending, setPending] = useState<string | null>(null)

  const run = useCallback(
    async <T,>(
      key: string,
      fn: () => Promise<T>,
      opts?: { success?: string; failure?: string; onSuccess?: (result: T) => void },
    ): Promise<T | null> => {
      setPending(key)
      try {
        const result = await fn()
        if (opts?.success) toast.success(opts.success)
        opts?.onSuccess?.(result)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // The server's own message is passed through verbatim — it explains
        // the cause far better than any generic wording could.
        toast.error(opts?.failure ?? 'Action failed', { description: message })
        return null
      } finally {
        setPending(null)
      }
    },
    [],
  )

  return { run, pending, isPending: (key: string) => pending === key }
}
