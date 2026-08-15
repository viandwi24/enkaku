import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, waitFor } from '@testing-library/react'
import type { AdbServerHealth } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'

/**
 * `AdbServerCard` (plan 88 §3.9, §3.10, §4.8, §5 step 88.8) — "is adb
 * stuck?" leads, the restart button follows. `ws` is mocked for the same
 * reason `ProvisioningBanner.test.tsx`/`AdbEndpointCard.test.tsx` already
 * document: `happy-dom` has no WebSocket, and `api()` reads `coreBase()`
 * from the same module.
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

const { AdbServerCard } = await import('./AdbServerCard')

function emitHealth(health: AdbServerHealth): void {
  act(() => {
    for (const h of handlers) h({ type: 'adb.health', payload: health })
  })
}

const OK_HEALTH: AdbServerHealth = {
  status: 'ok',
  versionRttMs: 4,
  lastCheckedAt: 1000,
  window: { seconds: 600, execs: 40, timeouts: 0, timeoutRate: 0 },
  wedged: [],
  stuckOffline: [],
  symptoms: [],
  restartAdvised: false,
}

const STUCK_HEALTH: AdbServerHealth = {
  status: 'stuck',
  versionRttMs: null,
  lastCheckedAt: 2000,
  window: { seconds: 600, execs: 40, timeouts: 30, timeoutRate: 0.75 },
  wedged: [],
  stuckOffline: [],
  symptoms: [{ symptom: 'server-unresponsive', detail: 'host:version has not answered within 2000ms across 2 consecutive probes', since: 1900 }],
  restartAdvised: true,
}

const UNREACHABLE_HEALTH: AdbServerHealth = {
  status: 'degraded',
  versionRttMs: null,
  lastCheckedAt: 2000,
  window: { seconds: 600, execs: 0, timeouts: 0, timeoutRate: 0 },
  wedged: [],
  stuckOffline: [],
  symptoms: [{ symptom: 'server-unreachable', detail: 'no adb server answered on 127.0.0.1:5037', since: 1900 }],
  restartAdvised: false,
}

function statsBody(health: AdbServerHealth) {
  return {
    global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
    streams: { maxStreams: 4, maxStreamsPerDevice: 1, active: 0, perDevice: {} },
    idleSessions: [],
    devices: [],
    transport: { connections: 0, bufferedBytesMax: 0, bufferedBytesP95: 0, videoBytesPerSec: 0, controlReplyMsP50: 0, controlReplyMsP95: 0, watchdogReconnects: 0 },
    hostAdb: { running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 },
    adbHealth: health,
  }
}

afterEach(() => {
  handlers = []
  cleanup()
})

describe('AdbServerCard', () => {
  test('renders nothing before the first /api/adb/stats response lands', () => {
    const { container } = renderWithApi(<AdbServerCard canManage={true} />, {}, { unmatched: 'pending' })
    expect(container.textContent).toBe('')
  })

  test('a healthy server shows the ok status and no symptoms', async () => {
    const { getByText, queryByText } = renderWithApi(<AdbServerCard canManage={true} />, {
      '/api/adb/stats': { body: statsBody(OK_HEALTH) },
    })
    await waitFor(() => expect(getByText('ok')).toBeTruthy())
    expect(queryByText(/server-unresponsive/)).toBeNull()
  })

  test('a stuck server names the symptom and says a restart is likely to help', async () => {
    const { getByText } = renderWithApi(<AdbServerCard canManage={true} />, {
      '/api/adb/stats': { body: statsBody(STUCK_HEALTH) },
    })
    await waitFor(() => expect(getByText('stuck')).toBeTruthy())
    expect(getByText(/adb server unresponsive/)).toBeTruthy()
    expect(getByText(/likely to fix this/)).toBeTruthy()
  })

  test('server-unreachable does NOT advise a restart — F22\'s self-heal — and the card says so', async () => {
    const { getByText } = renderWithApi(<AdbServerCard canManage={true} />, {
      '/api/adb/stats': { body: statsBody(UNREACHABLE_HEALTH) },
    })
    await waitFor(() => expect(getByText('degraded')).toBeTruthy())
    expect(getByText(/probably will not fix this/)).toBeTruthy()
  })

  test('the Restart button is disabled for a non-admin, with a reason', async () => {
    const { getByText } = renderWithApi(<AdbServerCard canManage={false} />, {
      '/api/adb/stats': { body: statsBody(OK_HEALTH) },
    })
    await waitFor(() => expect(getByText('ok')).toBeTruthy())
    const button = getByText('Restart adb server').closest('button')
    expect(button?.disabled).toBe(true)
    expect(button?.title).toBe('Only an admin can do this')
  })

  test('the Restart button is enabled for an admin', async () => {
    const { getByText } = renderWithApi(<AdbServerCard canManage={true} />, {
      '/api/adb/stats': { body: statsBody(OK_HEALTH) },
    })
    await waitFor(() => expect(getByText('ok')).toBeTruthy())
    const button = getByText('Restart adb server').closest('button')
    expect(button?.disabled).toBe(false)
  })

  test('adb.health updates the card live, transition-only, without a re-fetch', async () => {
    const { getByText } = renderWithApi(<AdbServerCard canManage={true} />, {
      '/api/adb/stats': { body: statsBody(OK_HEALTH) },
    })
    await waitFor(() => expect(getByText('ok')).toBeTruthy())
    emitHealth(STUCK_HEALTH)
    await waitFor(() => expect(getByText('stuck')).toBeTruthy())
  })
})
