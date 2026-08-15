'use client'

import { createContext, useContext } from 'react'
import { z } from 'zod'
import { UserSchema } from '@enkaku/protocol'
import { coreBase } from './ws'

export type AuthUser = z.infer<typeof UserSchema>
export type AuthMode = 'local' | 'server'

/**
 * A coded failure from an `/api/auth/*` call (the `{ error: { code, message
 * } }` envelope every core route uses, `packages/core/src/util/errors.ts`).
 * Studio never shows `message` verbatim for these — see `describeAuthError`.
 */
export class AuthApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AuthApiError'
  }
}

const MeSuccessSchema = z.object({ user: UserSchema, authMode: z.enum(['local', 'server']) })
const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /**
   * Only present on the 401 `GET /api/auth/me` sends before any admin
   * exists (`packages/core/src/auth/middleware.ts`) — the one signal that
   * tells Studio to show `/setup` instead of `/login`.
   */
  setupNeeded: z.boolean().optional(),
})

export type MeResult = { status: 'authenticated'; user: AuthUser; authMode: AuthMode } | { status: 'unauthenticated'; setupNeeded: boolean }

/**
 * `GET /api/auth/me` — the one call that answers "who am I, and does Studio
 * need to show a login screen at all". Local mode (loopback bind) always
 * answers 200 with an implicit admin (`authMode: 'local'`); server mode
 * answers 401 with `setupNeeded: true` until the first admin exists, then
 * 401 without it until someone logs in.
 */
export async function fetchMe(): Promise<MeResult> {
  const res = await fetch(`${coreBase()}/api/auth/me`, { credentials: 'include' })
  if (res.ok) {
    const body = MeSuccessSchema.parse(await res.json())
    return { status: 'authenticated', user: body.user, authMode: body.authMode }
  }
  if (res.status === 401) {
    const parsed = ErrorEnvelopeSchema.safeParse(await res.json().catch(() => null))
    return { status: 'unauthenticated', setupNeeded: parsed.success ? (parsed.data.setupNeeded ?? false) : false }
  }
  throw new Error(`GET /api/auth/me → ${res.status}`)
}

async function postCredentials(path: string, email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${coreBase()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } } | null)?.error
    throw new AuthApiError(err?.code ?? 'unknown', err?.message ?? `Request failed (HTTP ${res.status})`)
  }
  return z.object({ user: UserSchema }).parse(body).user
}

/** `POST /api/auth/login`. */
export function login(email: string, password: string): Promise<AuthUser> {
  return postCredentials('/api/auth/login', email, password)
}

/** `POST /api/auth/setup` — succeeds exactly once per core; every call after the first 409s with `auth.setup_done`. */
export function setupAdmin(email: string, password: string): Promise<AuthUser> {
  return postCredentials('/api/auth/setup', email, password)
}

/**
 * `POST /api/auth/logout`. Best-effort: the caller (`AuthGate.logout`)
 * re-checks `/api/auth/me` right after this either way, so a network failure
 * here should not trap the user on the current screen.
 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${coreBase()}/api/auth/logout`, { method: 'POST', credentials: 'include' })
  } catch {
    // Non-fatal — see above.
  }
}

/**
 * Human, actionable copy for each code `/api/auth/*` actually returns.
 * Deliberately never falls through to the server's own `message` for these
 * codes — `POST /api/auth/setup`'s `auth.weak_password` in particular can
 * come back in Indonesian ("password minimal 8 karakter",
 * `packages/core/src/auth/service.ts`'s `createUser`), because that check
 * lives one layer below the English text the route itself writes for the
 * SAME code on a different validation path (a missing/malformed body vs. a
 * present-but-short password). Keying off `code` sidesteps the
 * inconsistency entirely.
 */
export function describeAuthError(code: string, fallback: string): string {
  switch (code) {
    case 'auth.invalid_credentials':
      return 'That email or password is not right.'
    case 'auth.rate_limited':
      return 'Too many attempts. Wait a bit before trying again.'
    case 'auth.weak_password':
      return 'Password must be at least 8 characters.'
    case 'auth.setup_done':
      return 'An admin already exists — sign in instead.'
    case 'auth.email_taken':
      return 'That email is already registered.'
    default:
      return fallback
  }
}

// ---- Shared auth state — provided by `AuthGate`, read anywhere with `useAuth()` ----

export interface AuthState {
  user: AuthUser | null
  authMode: AuthMode
  setupNeeded: boolean
  /** Re-checks `/api/auth/me` — call after a successful login/setup, or to recover once a session has expired. */
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

/**
 * Local-mode shape by default (no user, hidden menu), so any component that
 * reads `useAuth()` without an ancestor `AuthGate` — e.g. a component test
 * that renders `<AppShell>` on its own — behaves like local mode rather than
 * throwing.
 */
const DEFAULT_AUTH_STATE: AuthState = {
  user: null,
  authMode: 'local',
  setupNeeded: false,
  refresh: async () => {},
  logout: async () => {},
}

export const AuthContext = createContext<AuthState>(DEFAULT_AUTH_STATE)

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/**
 * Whether `user` may use a control gated on an admin-only permission
 * (`tool.manage`, `device.quarantine`, `device.owner.set` — the real matrix
 * lives server-side in `packages/core/src/auth/acl.ts`'s `OPERATOR` set,
 * which none of those three are ever in, `shell.mode`-style widening
 * included). Studio has no dependency on `@enkaku/core` and deliberately
 * does not reimplement the general `can(role, permission)` matrix here —
 * that would be a second, driftable source of truth. This only encodes the
 * one fact every one of those three permissions already reduces to: they
 * admit `admin` and nobody else. Convenience only — the server re-checks
 * the real permission on every request regardless of what this returns
 * (spec §10.1).
 *
 * Local mode's implicit admin (`ensureLocalAdmin`, `packages/core/src/auth/service.ts`)
 * always has `role: 'admin'`, so this is `true` there unconditionally — the
 * gates built on it must never hide or disable anything in local mode.
 */
export function isAdmin(user: AuthUser | null): boolean {
  return user?.role === 'admin'
}
