import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import '../../../happydom'

/**
 * `useRecording` (plan 94 §5 step 94.4) — the client half of the recorder's
 * WS surface (step 94.3, §4.9). `@/lib/ws` is mocked the same way
 * `AssistDialog.test.tsx` mocks it (a real `WsClient` would try to open an
 * actual `WebSocket` in happy-dom), extended here with a controllable `on()`
 * so a test can simulate the server PUSHING `recording.step`/`recording.state`
 * — the whole point of this hook is reacting to those without this tab
 * having asked for them (§4.6: a bound, or the lease going away).
 */
type Handler = (msg: unknown) => void
let handlers: Set<Handler> = new Set()
let sendCalls: unknown[] = []
let requestImpl: (msg: unknown) => Promise<unknown> = () => Promise.reject(new Error('ws.request is not mocked in this test'))

function emit(msg: unknown): void {
  for (const cb of [...handlers]) cb(msg)
}

mock.module('@/lib/ws', () => ({
  coreBase: () => 'http://core.test',
  ws: {
    send: (msg: unknown) => {
      sendCalls.push(msg)
    },
    on: (cb: Handler) => {
      handlers.add(cb)
      return () => handlers.delete(cb)
    },
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

const { useRecording } = await import('./useRecording')

afterEach(() => {
  cleanup()
  handlers = new Set()
  sendCalls = []
  requestImpl = () => Promise.reject(new Error('ws.request is not mocked in this test'))
})

describe('useRecording — start/stop/discard (plan 94 §5 step 94.4)', () => {
  test('start() requests recording.start and moves to "active" on the reply', async () => {
    requestImpl = (msg: unknown) => {
      expect(msg).toMatchObject({ type: 'recording.start', payload: { deviceId: 'dev-1' } })
      return Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
    }
    const { result } = renderHook(() => useRecording('dev-1'))
    expect(result.current.phase).toBe('idle')
    act(() => result.current.start())
    expect(result.current.phase).toBe('starting')
    await waitFor(() => expect(result.current.phase).toBe('active'))
    expect(result.current.steps).toEqual([])
    expect(result.current.startedAt).not.toBeNull()
  })

  test('a refusal (E_RECORDING_ACTIVE) is surfaced as `error` and returns to idle, not thrown', async () => {
    const { WsRequestError } = await import('@/lib/ws')
    requestImpl = () => Promise.reject(new WsRequestError('E_RECORDING_ACTIVE', 'a recording is already open on this device'))
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('idle'))
    expect(result.current.error).toBe('a recording is already open on this device')
  })

  test('recording.step pushes append to `steps` in order, only while active', async () => {
    requestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
    const { result } = renderHook(() => useRecording('dev-1'))

    // Pushed before `start()` resolves (this tab is not "active" yet) — dropped.
    act(() => emit({ type: 'recording.step', payload: { deviceId: 'dev-1', index: 0, kind: 'tap', hasCandidate: false } }))
    expect(result.current.steps).toEqual([])

    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))

    act(() => emit({ type: 'recording.step', payload: { deviceId: 'dev-1', index: 0, kind: 'tap', hasCandidate: true } }))
    act(() => emit({ type: 'recording.step', payload: { deviceId: 'dev-1', index: 1, kind: 'swipe', hasCandidate: false } }))
    expect(result.current.steps).toEqual([
      { index: 0, kind: 'tap', hasCandidate: true },
      { index: 1, kind: 'swipe', hasCandidate: false },
    ])
    expect(result.current.stepCount).toBe(2)

    // A step for a DIFFERENT device is ignored.
    act(() => emit({ type: 'recording.step', payload: { deviceId: 'dev-2', index: 0, kind: 'tap', hasCandidate: false } }))
    expect(result.current.steps.length).toBe(2)
  })

  test('stop() requests recording.stop and moves to "reviewing" with no stoppedReason', async () => {
    requestImpl = (msg: unknown) => {
      const m = msg as { type: string }
      if (m.type === 'recording.start') {
        return Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
      }
      expect(m.type).toBe('recording.stop')
      return Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: false, stepCount: 3, startedAt: 1000 } })
    }
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))
    act(() => result.current.stop())
    expect(result.current.phase).toBe('stopping')
    await waitFor(() => expect(result.current.phase).toBe('reviewing'))
    expect(result.current.stepCount).toBe(3)
    expect(result.current.stoppedReason).toBeNull()
    expect(result.current.endedAt).not.toBeNull()
  })

  test('an unsolicited recording.state push (a bound, or the lease going away) moves an ACTIVE recording to "reviewing" with its reason — the operator never pressed Stop', async () => {
    requestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))

    act(() =>
      emit({
        type: 'recording.state',
        payload: { deviceId: 'dev-1', active: false, stepCount: 12, startedAt: 1000, stoppedReason: 'max-steps' },
      }),
    )
    expect(result.current.phase).toBe('reviewing')
    expect(result.current.stoppedReason).toBe('max-steps')
    expect(result.current.stepCount).toBe(12)
  })

  test('an unsolicited recording.state push for a device this tab is not recording is ignored', async () => {
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() =>
      emit({ type: 'recording.state', payload: { deviceId: 'dev-1', active: false, stepCount: 5, startedAt: 1000, stoppedReason: 'lease-lost' } }),
    )
    expect(result.current.phase).toBe('idle')
  })

  test('discard() sends recording.cancel and resets local state without waiting on a reply', async () => {
    requestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))
    act(() => emit({ type: 'recording.step', payload: { deviceId: 'dev-1', index: 0, kind: 'tap', hasCandidate: false } }))
    expect(result.current.steps.length).toBe(1)

    act(() => result.current.discard())
    expect(result.current.phase).toBe('idle')
    expect(result.current.steps).toEqual([])
    expect(sendCalls).toContainEqual({ type: 'recording.cancel', payload: { deviceId: 'dev-1' } })
  })

  test('reset() clears a finished (reviewing) recording back to idle with no server call', async () => {
    requestImpl = (msg: unknown) => {
      const m = msg as { type: string }
      if (m.type === 'recording.start') return Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
      return Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: false, stepCount: 1, startedAt: 1000 } })
    }
    const { result } = renderHook(() => useRecording('dev-1'))
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))
    act(() => result.current.stop())
    await waitFor(() => expect(result.current.phase).toBe('reviewing'))

    const sendCountBeforeReset = sendCalls.length
    act(() => result.current.reset())
    expect(result.current.phase).toBe('idle')
    expect(result.current.stepCount).toBe(0)
    expect(sendCalls.length).toBe(sendCountBeforeReset)
  })

  test('changing deviceId resets every field — a recording belongs to one device', async () => {
    requestImpl = () => Promise.resolve({ type: 'recording.state', payload: { deviceId: 'dev-1', active: true, stepCount: 0, startedAt: 1000 } })
    const { result, rerender } = renderHook(({ deviceId }: { deviceId: string }) => useRecording(deviceId), {
      initialProps: { deviceId: 'dev-1' },
    })
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase).toBe('active'))

    rerender({ deviceId: 'dev-2' })
    expect(result.current.phase).toBe('idle')
    expect(result.current.steps).toEqual([])
  })
})
