'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { ParamIssue } from '@enkaku/protocol'
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
  /** Present on `invalid_job_params` (plan 95 §3.7, §4.3, §4.8) — field-level failures a form can attach to the field that caused them. */
  issues?: ParamIssue[]
}

/**
 * `issues` off a thrown `api()` error, keyed by path — the same
 * `Record<path, message>` shape `SchemaForm`'s `serverErrors` prop takes.
 * `undefined` for every other failure (a network error, a coded error with
 * no `issues`), so a caller can spread it straight into `serverErrors`
 * without an extra null check.
 */
export function issuesFromError(err: unknown): Record<string, string> | undefined {
  if (!err || typeof err !== 'object' || !('issues' in err)) return undefined
  const issues = (err as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return undefined
  const map: Record<string, string> = {}
  for (const issue of issues) {
    if (issue && typeof issue === 'object' && typeof (issue as { path?: unknown }).path === 'string' && typeof (issue as { message?: unknown }).message === 'string') {
      map[(issue as { path: string }).path] = (issue as { message: string }).message
    }
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Turns a thrown `api()` error into what a screen should show a user.
 *
 * `auth.forbidden` (`packages/core/src/auth/middleware.ts`'s `requirePermission`,
 * and the couple of routes with their own admin-only check, e.g.
 * `PATCH /api/devices/:id`'s ownerId transition) is a normal, expected
 * outcome the moment Studio hides or disables a control instead of removing
 * it — a role changed in another tab, or a second click races the
 * server response — not a bug, so it gets a plain-English rewrite rather
 * than the server's `requires the tool.manage permission` (a permission
 * NAME, not something anyone using the product typed or chose). Every
 * other code keeps the server's own message verbatim, same as before —
 * that text already explains the specific failure better than anything
 * generic here could.
 */
export function describeApiError(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : null
  if (code === 'auth.forbidden') return 'Your role does not allow this — ask an admin.'
  return err instanceof Error ? err.message : String(err)
}

/**
 * `api()` used to end its body with an unchecked cast of the response to
 * the caller's own generic type parameter (plan 72 §3.1) — a claim by the
 * caller, checked by nothing. `GET /api/v1/cap`
 * returned a bare array; the agent settings page asked for
 * `{capabilities: [...]}`; TypeScript reported nothing because the claim
 * type-checked against itself, and the Tools tab crashed on every load.
 *
 * A response that does NOT match its schema throws this — named so it is
 * unambiguous that the bug is the page, not the network. It must never be
 * presentable as a transient failure: there is nothing to retry, the server
 * sent something this build of Studio does not understand.
 */
export class BadResponseError extends Error {
  readonly code = 'E_BAD_RESPONSE'
  readonly path: string
  readonly issues: string

  constructor(path: string, issues: string) {
    super(`The server returned something this page did not understand (${path})`)
    this.name = 'BadResponseError'
    this.path = path
    this.issues = issues
  }
}

/**
 * The schema is a REQUIRED positional argument, not an option (plan 72
 * §3.3) — an optional one is one a caller forgets, and a forgotten one is
 * exactly today's behaviour with extra ceremony. Pass `z.void()` when a
 * response body genuinely does not matter, so "I do not care" is written
 * down rather than defaulted into.
 */
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: RequestInit & { json?: unknown },
): Promise<z.infer<S>> {
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
      ...(err?.issues ? { issues: err.issues } : {}),
    })
  }
  // `body` is `null` for "no JSON came back" — normalised to `undefined` so
  // `z.void()` (the explicit "no body" schema) parses it successfully rather
  // than failing on `null !== undefined`.
  const parsed = schema.safeParse(body === null ? undefined : body)
  if (!parsed.success) {
    throw new BadResponseError(path, z.prettifyError(parsed.error))
  }
  return parsed.data
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
        toast.error(opts?.failure ?? 'Action failed', { description: describeApiError(err) })
        return null
      } finally {
        setPending(null)
      }
    },
    [],
  )

  return { run, pending, isPending: (key: string) => pending === key }
}
