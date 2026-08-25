import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

/**
 * `AssistDialog` (plan 91 §3.12, §5 step 91.6) — the WARNING the operator
 * acknowledges before Assist grants concurrent input, modelled on
 * `TakeControlDialog.test.tsx`'s own mocking shape: `@/lib/ws` is mocked so
 * `confirm()`'s `ws.request` never opens a real socket in happy-dom.
 */
let requestImpl: (msg: unknown) => Promise<unknown> = () => Promise.reject(new Error('ws.request is not mocked in this test'))

mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    send: () => {},
    on: () => () => {},
    onBinary: () => () => {},
    onStatus: (cb: (v: boolean) => void) => {
      cb(false)
      return () => {}
    },
    onReconnected: () => () => {},
    isConnected: () => false,
    getSessionId: () => null,
    request: (msg: unknown) => requestImpl(msg),
    connect: () => {},
  },
  newId: () => 'test-id',
  WsRequestError: class WsRequestError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const { AssistDialog, humanTtl } = await import('./AssistDialog')

afterEach(cleanup)

const JOB_PRIMARY = { kind: 'job' as const, id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }

describe('AssistDialog — smoke render (plan 91 §3.12)', () => {
  test('names the running script and the grant TTL', async () => {
    renderWithApi(
      <AssistDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        primary={JOB_PRIMARY}
        grantTtlSec={300}
        open
        onOpenChange={() => {}}
        onAssisted={() => {}}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('Assist Pixel 7 while its job keeps control?')).toBeTruthy())
    // §3.12 requires BOTH the script and the TTL to be named, verbatim per
    // the plan's own example (checkout@1.4.2, 5 minutes for the shipped default).
    expect(screen.getByText('checkout@1.4.2')).toBeTruthy()
    expect(screen.getByText(/5 minutes without input/)).toBeTruthy()
    // The job is explicitly said to keep control — never "taking over".
    expect(document.body.textContent).toContain('is not paused and is not cancelled')
  })

  /**
   * Plan 124 §4.4, step 124.3 — `deviceLabel` stays a plain `string` prop and
   * the caller composes it with `formatDeviceName()`. What this pins is the
   * other half of that contract: the value is rendered VERBATIM at every
   * mention, so a composed name never arrives twice (`#7 #7 Galaxy A15`),
   * which is exactly the failure plan 124 §10's note on `MirrorMember`
   * records for the popup's own member list.
   */
  test('an already-composed name is rendered verbatim, never composed twice', async () => {
    renderWithApi(
      <AssistDialog
        deviceId="dev-1"
        deviceLabel="#7 Galaxy A15"
        primary={JOB_PRIMARY}
        grantTtlSec={300}
        open
        onOpenChange={() => {}}
        onAssisted={() => {}}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText('Assist #7 Galaxy A15 while its job keeps control?')).toBeTruthy())
    expect(document.body.textContent).not.toContain('#7 #7')
  })

  test('a non-round TTL still reads correctly (mm:ss form)', async () => {
    renderWithApi(
      <AssistDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        primary={JOB_PRIMARY}
        grantTtlSec={90}
        open
        onOpenChange={() => {}}
        onAssisted={() => {}}
      />,
      {},
    )
    await waitFor(() => expect(screen.getByText(/1m 30s without input/)).toBeTruthy())
  })

  test('confirming sends assist.start and reports the grant back on assist.started', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let sent: unknown
    requestImpl = (msg: unknown) => {
      sent = msg
      return Promise.resolve({
        type: 'assist.started',
        payload: { deviceId: 'dev-1', expiresAt: 1_700_000_300, primary: JOB_PRIMARY },
      })
    }
    const onAssisted = mock(() => {})
    const onOpenChange = mock(() => {})
    renderWithApi(
      <AssistDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        primary={JOB_PRIMARY}
        grantTtlSec={300}
        open
        onOpenChange={onOpenChange}
        onAssisted={onAssisted}
      />,
      {},
    )
    await user.click(screen.getByRole('button', { name: 'Assist' }))
    await waitFor(() => expect(onAssisted).toHaveBeenCalledTimes(1))
    expect(sent).toMatchObject({ type: 'assist.start', payload: { deviceId: 'dev-1' } })
    // `expiresAt` on the wire is unix SECONDS (matching `lease.acquired`'s own
    // convention) — the dialog converts to ms epoch before handing it back.
    expect(onAssisted).toHaveBeenCalledWith(1_700_000_300_000, JOB_PRIMARY)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('a refusal (e.g. assist_denied_by_script) is shown, not thrown', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const { WsRequestError } = await import('@/lib/ws')
    requestImpl = () => Promise.reject(new WsRequestError('assist_denied_by_script', 'the running script has disabled assisting for this job'))
    const onAssisted = mock(() => {})
    renderWithApi(
      <AssistDialog
        deviceId="dev-1"
        deviceLabel="Pixel 7"
        primary={JOB_PRIMARY}
        grantTtlSec={300}
        open
        onOpenChange={() => {}}
        onAssisted={onAssisted}
      />,
      {},
    )
    await user.click(screen.getByRole('button', { name: 'Assist' }))
    await waitFor(() => expect(screen.getByText(/disabled assisting for this job/)).toBeTruthy())
    expect(onAssisted).not.toHaveBeenCalled()
  })

  test('closed: renders nothing throw-worthy', () => {
    expect(() =>
      renderWithApi(
        <AssistDialog
          deviceId="dev-1"
          deviceLabel="Pixel 7"
          primary={JOB_PRIMARY}
          grantTtlSec={300}
          open={false}
          onOpenChange={() => {}}
          onAssisted={() => {}}
        />,
        {},
      ),
    ).not.toThrow()
  })
})

describe('humanTtl', () => {
  test('a round number of minutes reads "N minutes" (§3.12\'s own example)', () => {
    expect(humanTtl(300)).toBe('5 minutes')
    expect(humanTtl(60)).toBe('1 minute')
  })

  test('under a minute reads in seconds', () => {
    expect(humanTtl(30)).toBe('30 seconds')
    expect(humanTtl(1)).toBe('1 second')
  })

  test('a non-round value reads as mm:ss', () => {
    expect(humanTtl(90)).toBe('1m 30s')
  })
})
