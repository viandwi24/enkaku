'use client'

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AppShell } from './AppShell'
import { Spinner } from '@enkaku/ui'
import { AuthContext, fetchMe, logout as requestLogout, type AuthMode, type AuthState, type AuthUser } from '@/lib/auth'
import { ws } from '@/lib/ws'

const AUTH_ROUTES = new Set(['/login', '/setup'])

interface GateState {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  user: AuthUser | null
  authMode: AuthMode
  setupNeeded: boolean
}

const INITIAL_STATE: GateState = { status: 'loading', user: null, authMode: 'local', setupNeeded: false }

function FullScreenLoading() {
  return (
    <div className="grid h-dvh place-items-center bg-bg">
      <Spinner className="size-6 text-fg-subtle" />
    </div>
  )
}

/** Only ever follow an internal path — never let a `?next=` value send this tab off-origin. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
}

/**
 * The gated part of `AuthGate` — split out so the outer component can wrap
 * it in `<Suspense>`: `useSearchParams()` requires one for a static export
 * to prerender at all (the same reason `app/page.tsx` and `app/device/page.tsx`
 * wrap their own `useSearchParams()` users), even though at runtime a plain
 * client read like this never actually suspends.
 */
function AuthGateInner({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [state, setState] = useState<GateState>(INITIAL_STATE)

  const refresh = useCallback(async () => {
    try {
      const result = await fetchMe()
      if (result.status === 'authenticated') {
        ws.setAuthMode(result.authMode)
        setState({ status: 'authenticated', user: result.user, authMode: result.authMode, setupNeeded: false })
      } else {
        setState({ status: 'unauthenticated', user: null, authMode: 'server', setupNeeded: result.setupNeeded })
      }
    } catch {
      // The core is unreachable at all — do not strand the tab on an
      // infinite spinner. Treat it like "not logged in": the login screen's
      // own submit hits the same failure and explains it there, instead of a
      // blank page with no control on it anywhere.
      setState({ status: 'unauthenticated', user: null, authMode: 'server', setupNeeded: false })
    }
  }, [])

  // Initial check, once — plus a WS ticket fetch coming back 401 means the
  // session died while the tab sat open. React the same way a fresh 401 from
  // `/me` would ("fails cleanly when it has expired").
  useEffect(() => {
    void refresh()
    return ws.onAuthExpired(() => void refresh())
  }, [refresh])

  // Route enforcement — re-evaluated on every state change AND every
  // navigation, since `router.replace` alone does not re-run this with a
  // settled `state` from a stale closure.
  useEffect(() => {
    if (state.status === 'loading') return
    const onAuthRoute = AUTH_ROUTES.has(pathname)

    if (state.status === 'unauthenticated') {
      if (state.setupNeeded) {
        if (pathname !== '/setup') router.replace('/setup')
        return
      }
      if (pathname !== '/login') {
        const qs = searchParams.toString()
        const next = qs ? `${pathname}?${qs}` : pathname
        router.replace(`/login?next=${encodeURIComponent(next)}`)
      }
      return
    }

    // Authenticated (including local mode's implicit admin) — an auth route
    // has nothing left to do here.
    if (onAuthRoute) router.replace(safeNext(searchParams.get('next')))
  }, [state.status, state.setupNeeded, pathname, searchParams, router])

  const logout = useCallback(async () => {
    await requestLogout()
    ws.disconnect()
    await refresh()
  }, [refresh])

  if (state.status === 'loading') return <FullScreenLoading />

  const value: AuthState = {
    user: state.user,
    authMode: state.authMode,
    setupNeeded: state.setupNeeded,
    refresh,
    logout,
  }

  if (state.status === 'unauthenticated') {
    // Only the two auth pages render standalone (no sidebar, no device
    // fetches, no WS) — anything else is one render frame away from the
    // redirect effect above sending it to one of them.
    if (AUTH_ROUTES.has(pathname)) return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    return <FullScreenLoading />
  }

  if (AUTH_ROUTES.has(pathname)) return <FullScreenLoading />

  return (
    <AuthContext.Provider value={value}>
      <AppShell>{children}</AppShell>
    </AuthContext.Provider>
  )
}

/**
 * Gates every Studio route behind the core's own auth state (plan 09 §4.14).
 * A static export has no server to redirect from, so this decides
 * client-side, on every navigation, whether the route the user asked for is
 * `/login`, `/setup`, or the real app — driven entirely by `GET
 * /api/auth/me` and the `setupNeeded` flag its 401 body carries
 * (`packages/core/src/auth/middleware.ts`).
 *
 * Local mode (loopback bind) never reaches the login branch at all: the
 * core's `authMiddleware` injects an implicit admin for every request in
 * that mode, so `/api/auth/me` always answers 200 with `authMode: 'local'`
 * — there is no 401 to react to, and this component is a pass-through
 * straight to `AppShell`, exactly as frictionless as `bun run dev` was
 * before this existed.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<FullScreenLoading />}>
      <AuthGateInner>{children}</AuthGateInner>
    </Suspense>
  )
}
