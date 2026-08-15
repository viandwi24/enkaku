import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `AdbServerBanner` (plan 88 §3.10, §4.8, §5 step 88.8) — mirrors
 * `ProvisioningBanner.test.tsx` exactly, including its own rationale for
 * mocking `ws` rather than driving a real socket: `happy-dom` has no
 * WebSocket, and the component's whole contract is "given this message,
 * render this."
 */

type Handler = (m: { type: string; payload?: unknown }) => void
let handlers: Handler[] = []

mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    on: (cb: Handler) => {
      handlers.push(cb)
      return () => {
        handlers = handlers.filter((h) => h !== cb)
      }
    },
  },
}))

const { AdbServerBanner } = await import('./AdbServerBanner')

function emit(payload: Record<string, unknown>): void {
  act(() => {
    for (const h of handlers) h({ type: 'adb.server.phase', payload })
  })
}

afterEach(() => {
  handlers = []
  cleanup()
})

describe('AdbServerBanner', () => {
  test('renders nothing until a phase arrives', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    expect(container.textContent).toBe('')
  })

  test('names the reason and the phase', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'draining', reason: 'restart', detail: 'pausing the adb queue' })
    expect(container.textContent).toContain('adb restart')
    expect(container.textContent).toContain('Draining')
    expect(container.textContent).toContain('pausing the adb queue')
  })

  test('a version swap is named differently from an operator restart', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'stopping', reason: 'swap', detail: '' })
    expect(container.textContent).toContain('adb version swap')
  })

  test('`done` CLEARS the banner — the one phase that does', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'draining', reason: 'restart', detail: '' })
    expect(container.textContent).not.toBe('')
    emit({ phase: 'done', reason: 'restart', detail: '' })
    expect(container.textContent).toBe('')
  })

  test('`failed` STAYS — a restart that did not complete cleanly is not noise to auto-dismiss', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'failed', reason: 'restart', detail: 'the adb drain exceeded 30000ms' })
    expect(container.textContent).toContain('the adb drain exceeded 30000ms')
  })

  test('every non-terminal phase reassures that reconnection is automatic', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'reattaching', reason: 'restart', detail: '' })
    expect(container.textContent).toContain('every device reconnects automatically')
  })

  test('a failed cycle does NOT claim automatic reconnection', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'failed', reason: 'restart', detail: 'rolled back to the old binary' })
    expect(container.textContent).not.toContain('every device reconnects automatically')
  })

  test('it is announced to assistive tech, since it appears with no interaction', () => {
    const { container } = renderWithApi(<AdbServerBanner />)
    emit({ phase: 'starting', reason: 'restart', detail: '' })
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })
})
