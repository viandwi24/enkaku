import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

/**
 * `tool.provision.progress` was broadcast from three points in
 * `packages/core/src/tools/provision.ts` and rendered nowhere, so a first run
 * downloading adb, scrcpy-server and ui-server showed a still screen. These
 * tests pin the four things that made it worth building at all: it appears,
 * it names the tool and phase, it CLEARS on `done`, and a `degraded`/`error`
 * outcome STAYS after the noise has passed.
 *
 * `ws` is mocked rather than driven through a real socket: the component's
 * whole contract is "given this message, render this", and `happy-dom` has no
 * WebSocket (see `lib/test/render.tsx`'s own note).
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

const { ProvisioningBanner } = await import('./ProvisioningBanner')

function emit(payload: Record<string, unknown>): void {
  act(() => {
    for (const h of handlers) h({ type: 'tool.provision.progress', payload })
  })
}

afterEach(() => {
  handlers = []
  cleanup()
})

describe('ProvisioningBanner', () => {
  test('renders nothing until the core says provisioning started', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    expect(container.textContent).toBe('')
  })

  test('a start step explains what is happening and that it happens once', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'start' })
    expect(container.textContent).toContain('Setting up the toolchain')
    expect(container.textContent).toContain('once')
  })

  test('a tool step names the tool, the phase, and the percentage', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'tool', toolId: 'scrcpy-server', phase: 'download', percent: 42.4 })
    expect(container.textContent).toContain('Downloading')
    expect(container.textContent).toContain('scrcpy-server')
    expect(container.textContent).toContain('42%')
  })

  test('a tool step with no percentage does not render a stray number', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'tool', toolId: 'adb', phase: 'verify', percent: null })
    expect(container.textContent).toContain('Verifying')
    expect(container.textContent).toContain('adb')
    expect(container.textContent).not.toContain('%')
  })

  test('`done` CLEARS the banner — the one step that does', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'start' })
    expect(container.textContent).not.toBe('')
    emit({ step: 'done' })
    expect(container.textContent).toBe('')
  })

  test('`degraded` STAYS, naming the optional tool that failed', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'degraded', toolId: 'ui-server' })
    expect(container.textContent).toContain('ui-server')
    expect(container.textContent).toContain('without it')
  })

  test('`error` STAYS and shows the message verbatim — only a critical tool gets here', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'error', error: { code: 'E_TOOL_SHA256', message: 'checksum did not match' } })
    expect(container.textContent).toContain('checksum did not match')
  })

  test('it is announced to assistive tech, since it appears with no interaction', () => {
    const { container } = renderWithApi(<ProvisioningBanner />)
    emit({ step: 'start' })
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })
})
