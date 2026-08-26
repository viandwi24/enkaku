import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { TraceScrubber } from './TraceScrubber'

afterEach(cleanup)

/**
 * Plan 130 step 130.6 — the play/pause control itself: the accessible label
 * reflects state, the speed buttons report which one is active, and Space
 * toggles play/pause on the same element the existing ←/→/Home/End bindings
 * already use. `useTracePlayback`'s own test file proves the TIMING claims;
 * this file proves the DOM/ARIA surface a screen reader or a keyboard-only
 * operator actually meets.
 */

function ev(over: Partial<JobTraceEvent>): JobTraceEvent {
  return {
    id: 'e',
    jobId: 'job-1',
    seq: 1,
    atMs: 0,
    attempt: 1,
    phase: 'run',
    nodeId: null,
    kind: 'action',
    name: 'tap',
    durationMs: null,
    ok: true,
    errorCode: null,
    meta: null,
    frameHash: null,
    frameStatus: null,
    uiHash: null,
    ...over,
  }
}

const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'b', atMs: 1_000 })]

function renderScrubber(overrides: Partial<Parameters<typeof TraceScrubber>[0]> = {}) {
  const onSelect = mock(() => {})
  const onToggle = mock(() => {})
  const onSpeedChange = mock(() => {})
  render(
    <TraceScrubber
      events={events}
      selected={0}
      onSelect={onSelect}
      playheadMs={0}
      playing={false}
      speed={1}
      onToggle={onToggle}
      onSpeedChange={onSpeedChange}
      {...overrides}
    />,
  )
  return { onSelect, onToggle, onSpeedChange }
}

describe('TraceScrubber — the play/pause button (plan 130 step 130.6)', () => {
  test('reads "Play" while paused, and clicking it calls onToggle', () => {
    const { onToggle } = renderScrubber({ playing: false })
    const button = screen.getByLabelText('Play trace playback')
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('reads "Pause" while playing — the accessible label reflects state', () => {
    renderScrubber({ playing: true })
    expect(screen.getByLabelText('Pause trace playback')).toBeTruthy()
    expect(screen.queryByLabelText('Play trace playback')).toBeNull()
  })

  test('is disabled when there are no events', () => {
    render(
      <TraceScrubber
        events={[]}
        selected={0}
        onSelect={() => {}}
        playheadMs={0}
        playing={false}
        speed={1}
        onToggle={() => {}}
        onSpeedChange={() => {}}
      />,
    )
    expect((screen.getByLabelText('Play trace playback') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TraceScrubber — speed control (plan 130 step 130.6)', () => {
  test('marks the active speed and calls onSpeedChange for the others', () => {
    const { onSpeedChange } = renderScrubber({ speed: 2 })
    expect(screen.getByLabelText('1× playback speed').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('2× playback speed').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('4× playback speed').getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByLabelText('4× playback speed'))
    expect(onSpeedChange).toHaveBeenCalledWith(4)
  })

  test('at least 1x/2x/4x are offered', () => {
    renderScrubber()
    for (const s of ['1×', '2×', '4×']) {
      expect(screen.getByLabelText(`${s} playback speed`)).toBeTruthy()
    }
  })
})

describe('TraceScrubber — keyboard (plan 130 step 130.6, and plan 128 §4.6\'s existing bindings)', () => {
  test('Space toggles play/pause on the slider, and prevents the page from scrolling', () => {
    const { onToggle } = renderScrubber()
    const slider = screen.getByRole('slider', { name: 'Trace playhead' })
    // `fireEvent` returns `false` when the dispatched event's `preventDefault`
    // was called — exactly what must happen here so Space does not also
    // scroll the page, the same guard the other bindings below already rely on.
    const notCancelled = fireEvent.keyDown(slider, { key: ' ' })
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(notCancelled).toBe(false)
  })

  test('← → still step one event, and Home/End still jump to the ends', () => {
    const { onSelect } = renderScrubber({ selected: 0 })
    const slider = screen.getByRole('slider', { name: 'Trace playhead' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledWith(1)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onSelect).toHaveBeenCalledWith(1)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onSelect).toHaveBeenCalledWith(0)
  })
})

describe('TraceScrubber — the marker positions from playheadMs, not the selected event (plan 130 step 130.6)', () => {
  test('mid-gap: selected stays on the earlier event while playheadMs has moved past it', () => {
    const { container } = render(
      <TraceScrubber
        events={events}
        selected={0}
        onSelect={() => {}}
        playheadMs={400}
        playing
        speed={1}
        onToggle={() => {}}
        onSpeedChange={() => {}}
      />,
    )
    // 400 of a 0..1000 span is 40% — the readout is built from playheadMs, so
    // it shows the axis position even though the nearest event ("a", 0ms) has
    // not changed. This is the "keeps visibly sliding" behaviour, not the
    // discrete event index.
    const marker = container.querySelector('[style*="left"]') as HTMLElement | null
    expect(marker?.style.left).toBe('40%')
  })
})
