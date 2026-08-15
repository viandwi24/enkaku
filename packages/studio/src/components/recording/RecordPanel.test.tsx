import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { RecordPanel } from './RecordPanel'
import type { RecordedStepEntry, RecordingPhase } from './useRecording'

/**
 * `RecordPanel` (plan 94 §4.10, §5 steps 94.4, 94.5) — purely presentational
 * beyond its own "Save & review" form, so this file only proves what the
 * props render into: the caveat, the step strip, the phase-specific chrome
 * (idle / active / reviewing), and the save flow. The WS lifecycle itself is
 * `useRecording`'s own test (`useRecording.test.ts`); `ScreenCard.test.tsx`
 * proves the two are wired together without restarting the video.
 */

// A real value, matching every other page/component test that exercises `api()`
// (e.g. `app/batches/detail/page.test.tsx`) — without it, `coreBase()` falls
// back to `location.origin`, which happy-dom's default un-navigated
// `about:blank` document reports as the opaque-origin string `"null"`.
process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const BASE = {
  deviceId: 'dev1',
  steps: [] as RecordedStepEntry[],
  stepCount: 0,
  startedAt: null,
  endedAt: null,
  stoppedReason: null,
  error: null,
  onStart: () => {},
  onStop: () => {},
  onDiscard: () => {},
  onReset: () => {},
}

function render(
  phase: RecordingPhase,
  overrides: Partial<React.ComponentProps<typeof RecordPanel>> = {},
  responses: Parameters<typeof renderWithApi>[1] = {},
) {
  return renderWithApi(<RecordPanel phase={phase} {...BASE} {...overrides} />, responses)
}

describe('RecordPanel — the core-restart caveat (plan 94 §5 step 94.4)', () => {
  test('is stated on screen in every phase, not only idle', () => {
    for (const phase of ['idle', 'active', 'reviewing'] as const) {
      const { unmount } = render(phase)
      expect(screen.getByText(/lives only in this core.s memory until it is saved/)).toBeTruthy()
      unmount()
    }
  })
})

describe('RecordPanel — idle', () => {
  test('offers Start recording, and names why it cannot be pressed when disabled', () => {
    render('idle', { disabledReason: 'Take control to record.' })
    const button = screen.getByRole('button', { name: 'Start recording' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Take control to record.')).toBeTruthy()
  })

  test('names the inspector gap (94.3 decision 3) rather than leaving it silent', () => {
    render('idle')
    expect(screen.getByText(/Inspect tab to have attached an inspector/)).toBeTruthy()
  })

  test('Start recording fires onStart when enabled', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onStart = mock(() => {})
    render('idle', { onStart })
    await user.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})

describe('RecordPanel — active', () => {
  test('shows the duration, the step count, and Stop/Discard', () => {
    render('active', { stepCount: 4, startedAt: Date.now() - 65_000 })
    expect(screen.getByText('Recording')).toBeTruthy()
    expect(screen.getByText('1:05')).toBeTruthy()
    expect(screen.getByText('4 steps')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Discard/ })).toBeTruthy()
  })

  test('Stop and Discard fire their own handlers', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onStop = mock(() => {})
    const onDiscard = mock(() => {})
    render('active', { onStop, onDiscard })
    await user.click(screen.getByRole('button', { name: /Stop/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: /Discard/ }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  test('the step strip fills in as steps arrive, in order', () => {
    render('active', {
      steps: [
        { index: 0, kind: 'tap', hasCandidate: true },
        { index: 1, kind: 'swipe', hasCandidate: false },
        { index: 2, kind: 'longPress', hasCandidate: false },
      ],
    })
    const items = screen.getAllByRole('listitem')
    expect(items.map((el) => el.textContent)).toEqual(['1Tap', '2Swipe', '3Long press'])
  })

  test('no steps yet reads honestly rather than an empty strip', () => {
    render('active')
    expect(screen.getByText(/No steps yet/)).toBeTruthy()
  })
})

describe('RecordPanel — reviewing (plan 94 §5 step 94.4 — "lands on the review panel")', () => {
  test('a deliberate Stop shows Review with no stoppedReason banner', () => {
    render('reviewing', { stepCount: 7, startedAt: 1_000, endedAt: 13_000 })
    expect(screen.getByText('Review')).toBeTruthy()
    expect(screen.getByText('7 steps · 0:12')).toBeTruthy()
    expect(screen.queryByText(/reached the maximum/)).toBeNull()
  })

  test('an automatic stop names WHY, honestly, per reason', () => {
    render('reviewing', { stoppedReason: 'max-steps' })
    expect(screen.getByText(/reached the maximum number of steps/)).toBeTruthy()
  })

  test('a lease loss is named as such — the operator did not press Stop', () => {
    render('reviewing', { stoppedReason: 'lease-lost' })
    expect(screen.getByText(/control of this device was lost/)).toBeTruthy()
  })

  test('"Start a new recording" resets local state, no server call implied by this component', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const onReset = mock(() => {})
    render('reviewing', { onReset })
    await user.click(screen.getByRole('button', { name: 'Start a new recording' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})

describe('RecordPanel — Save & review (plan 94 §5 step 94.5)', () => {
  test('Save & review is disabled until a valid name is typed (version already defaults to a valid 1.0.0)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render('reviewing')
    const save = screen.getByRole('button', { name: /Save & review/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(screen.getByPlaceholderText(/name, e.g/), 'checkout-flow')
    expect(save.disabled).toBe(false)
  })

  test('an invalid name (uppercase, matching neither the recording nor script grammar) keeps Save disabled', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render('reviewing')
    await user.type(screen.getByPlaceholderText(/name, e.g/), 'Checkout Flow')
    expect((screen.getByRole('button', { name: /Save & review/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('POSTs deviceId/name/version to /api/recordings and shows a review link on success', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    const { apiMock } = render(
      'reviewing',
      { deviceId: 'dev-42' },
      {
        '/api/recordings': {
          status: 201,
          body: {
            slug: 'checkout-flow',
            hash: 'abc',
            doc: {
              schema: 1,
              name: 'checkout-flow',
              version: '1.0.0',
              description: '',
              recordedAt: 1_700_000_000,
              recordedOn: { stableId: 'dev-42', model: 'moto g06 power', width: 1080, height: 2400 },
              speed: 1,
              maxGapMs: 15_000,
              cleanup: 'force-stop',
              packages: [],
              steps: [],
            },
          },
        },
      },
    )
    await user.type(screen.getByPlaceholderText(/name, e.g/), 'checkout-flow')
    await user.click(screen.getByRole('button', { name: /Save & review/ }))
    expect(await screen.findByRole('link', { name: /Review "checkout-flow"/ })).toBeTruthy()
    expect(apiMock.calls).toEqual([{ path: '/api/recordings', method: 'POST', body: { deviceId: 'dev-42', name: 'checkout-flow', version: '1.0.0' } }])
    const link = screen.getByRole('link', { name: /Review "checkout-flow"/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/recordings/detail?slug=checkout-flow')
  })

  test('a save failure shows the error and keeps the form editable', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    render('reviewing', {}, { '/api/recordings': { status: 409, body: { error: { code: 'E_EXISTS', message: 'already exists' } } } })
    await user.type(screen.getByPlaceholderText(/name, e.g/), 'checkout-flow')
    await user.click(screen.getByRole('button', { name: /Save & review/ }))
    expect(await screen.findByText('already exists')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save & review/ })).toBeTruthy()
  })

  test('a fresh recording (new startedAt) never shows a stale saved link', () => {
    const { rerender } = render('reviewing', { startedAt: 1_000 })
    rerender(<RecordPanel {...BASE} phase="reviewing" startedAt={2_000} />)
    expect(screen.queryByRole('link', { name: /Review "/ })).toBeNull()
  })
})
