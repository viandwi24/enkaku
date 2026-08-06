/**
 * A minimal `next/navigation` stand-in for component tests (plan 72 §4.5).
 * Studio is a static export reached through the App Router hooks
 * (`useRouter`, `useSearchParams`, `usePathname`) with no server — there is
 * no Next runtime to mount in a bare `@testing-library/react` render, so
 * these hooks throw ("invariant expected app router to be mounted") unless
 * the module itself is replaced.
 *
 * Import this file (for its `mock.module` side effect) before importing any
 * component or page that uses `next/navigation`. `setSearchParams`/
 * `setPathname` are mutable so one test file can cover several routes.
 */
import { mock } from 'bun:test'

let params = new URLSearchParams()
let pathname = '/'

export const mockRouter = {
  push: mock(() => {}),
  replace: mock(() => {}),
  back: mock(() => {}),
  forward: mock(() => {}),
  refresh: mock(() => {}),
  prefetch: mock(async () => {}),
}

export function setSearchParams(init?: string | Record<string, string> | URLSearchParams): void {
  params = new URLSearchParams(init)
}

export function setPathname(p: string): void {
  pathname = p
}

mock.module('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => params,
  usePathname: () => pathname,
  useParams: () => ({}),
  redirect: () => {
    throw new Error('redirect() called in a test — mock it explicitly if a test needs to assert on it')
  },
}))
