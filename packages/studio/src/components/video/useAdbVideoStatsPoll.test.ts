import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import '../../../happydom'
import { cleanup as apiCleanup, installApiMock } from '@/lib/test/render'
import { useAdbVideoStatsPoll } from './useAdbVideoStatsPoll'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(() => {
  cleanup()
  apiCleanup()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

const statsBody = () => ({
  global: { maxConcurrent: 4, auto: true, inFlight: 0, waiting: 0 },
  streams: { maxStreams: 8, maxStreamsPerDevice: 1, active: 0, perDevice: {} },
  idleSessions: [],
  devices: [],
  transport: { connections: 1, bufferedBytesMax: 0, bufferedBytesP95: 0, videoBytesPerSec: 1_137_500, controlReplyMsP50: 0, controlReplyMsP95: 0, watchdogReconnects: 0 },
  hostAdb: { running: 0, maxConcurrent: 4, installsRunning: 0, longLived: 0 },
  adbHealth: {
    status: 'ok',
    versionRttMs: 1,
    lastCheckedAt: 0,
    window: { seconds: 60, execs: 0, timeouts: 0, timeoutRate: 0 },
    wedged: [],
    stuckOffline: [],
    symptoms: [],
    restartAdvised: false,
  },
  video: { controlStreams: 1, wallStreams: 12, buildsRunning: 0, buildQueueDepth: 0, maxConcurrentBuilds: 2, maxTiles: 25, maxTilesAuto: true, transport: 'loopback' },
})

/**
 * Plan 92 §3.9, §5 step 92.8 — the measured block's own polling discipline.
 * `useNow.ts` already established the pattern (`document.hidden`/
 * `visibilitychange`) this hook copies rather than reinvents; these tests
 * are this step's own proof of the brief's third warning: "prove the
 * interval is cleared on unmount."
 */
describe('useAdbVideoStatsPoll (plan 92 §3.9, §5 step 92.8)', () => {
  test('loads immediately on mount and polls again after intervalMs', async () => {
    const apiMock = installApiMock({ '/api/adb/stats': () => ({ body: statsBody() }) })
    const { result, unmount } = renderHook(() => useAdbVideoStatsPoll(20))
    await waitFor(() => expect(result.current.stats).not.toBeNull())
    expect(result.current.stats?.video?.wallStreams).toBe(12)
    const firstCount = apiMock.calls.length
    await waitFor(() => expect(apiMock.calls.length).toBeGreaterThan(firstCount))
    unmount()
    apiMock.restore()
  })

  test('the interval is cleared on unmount — no further calls arrive after unmounting', async () => {
    const apiMock = installApiMock({ '/api/adb/stats': () => ({ body: statsBody() }) })
    const { result, unmount } = renderHook(() => useAdbVideoStatsPoll(15))
    await waitFor(() => expect(result.current.stats).not.toBeNull())
    unmount()
    const countAtUnmount = apiMock.calls.length
    await new Promise((r) => setTimeout(r, 120))
    expect(apiMock.calls.length).toBe(countAtUnmount)
    apiMock.restore()
  })

  test('polling pauses while the tab is hidden and resumes (with an immediate refresh) when it becomes visible again', async () => {
    const apiMock = installApiMock({ '/api/adb/stats': () => ({ body: statsBody() }) })
    const { result, unmount } = renderHook(() => useAdbVideoStatsPoll(500_000)) // long enough that only visibility transitions drive calls below
    await waitFor(() => expect(result.current.stats).not.toBeNull())
    const countWhileVisible = apiMock.calls.length

    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 50))
    expect(apiMock.calls.length).toBe(countWhileVisible) // no call while hidden

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(apiMock.calls.length).toBeGreaterThan(countWhileVisible)) // resyncs immediately on becoming visible again

    unmount()
    apiMock.restore()
  })

  test('starts paused when mounted while already hidden — no call until the tab becomes visible', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    const apiMock = installApiMock({ '/api/adb/stats': () => ({ body: statsBody() }) })
    const { result, unmount } = renderHook(() => useAdbVideoStatsPoll(500_000))
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.stats).toBeNull()
    expect(apiMock.calls.length).toBe(0)

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(result.current.stats).not.toBeNull())

    unmount()
    apiMock.restore()
  })

  test('a failed fetch surfaces as `error`, not a thrown exception', async () => {
    const apiMock = installApiMock({ '/api/adb/stats': { status: 500, body: { error: { code: 'boom', message: 'stats unavailable' } } } })
    const { result, unmount } = renderHook(() => useAdbVideoStatsPoll(50_000))
    await waitFor(() => expect(result.current.error).toBe('stats unavailable'))
    expect(result.current.stats).toBeNull()
    unmount()
    apiMock.restore()
  })
})
