import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent } from '@testing-library/react'
import type { ClusterInfo, CommandTarget, DeviceInfo } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TooltipProvider } from '@enkaku/ui'
import { TargetPicker } from './TargetPicker'

/**
 * Plan 93 §3.14 guard 1, step 93.7 — "TargetPicker: a preview that names,
 * before the run, every device that will and will not receive the
 * command." Covers all three target shapes and the always-visible preview.
 *
 * Wrapped in `TooltipProvider` because `DevicePicker` (device mode) shows an
 * unavailable row's reason as a Radix `Tooltip`, which throws if mounted
 * with no provider ancestor — even when the tooltip itself is never opened.
 */

// happy-dom does not implement the Pointer Capture APIs Radix's Select uses
// to open on click (same workaround `MonitorPane.test.tsx` uses).
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false)
Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

afterEach(cleanup)

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 'dev-1',
    stableId: 'stable-1',
    label: 'Pixel 6',
    status: 'idle',
    tags: [],
    cluster: null,
    heldBy: null,
    assistedBy: [],
    battery: null,
    lastCrashAt: null,
    readiness: 'awake',
    connection: { medium: 'USB' },
    agent: 'absent',
    ...overrides,
  } as unknown as DeviceInfo
}

function Picker(props: {
  devices: DeviceInfo[]
  clusters: ClusterInfo[]
  target: CommandTarget | null
  onChange: (target: CommandTarget | null) => void
  mySessionId?: string | null
}) {
  return (
    <TooltipProvider>
      <TargetPicker devices={props.devices} clusters={props.clusters} target={props.target} onChange={props.onChange} mySessionId={props.mySessionId ?? null} />
    </TooltipProvider>
  )
}

describe('TargetPicker', () => {
  test('device mode: picking devices shows the always-on preview naming who will run it', () => {
    const devices = [device({ id: 'a', label: 'Rack A' }), device({ id: 'b', label: 'Rack B', status: 'offline' })]
    let target: CommandTarget | null = null
    const { getByText, rerender } = renderWithApi(<Picker devices={devices} clusters={[]} target={null} onChange={(t) => (target = t)} />)
    fireEvent.click(getByText('Rack A'))
    expect(target).toEqual({ deviceIds: ['a'] })

    rerender(<Picker devices={devices} clusters={[]} target={target} onChange={(t) => (target = t)} />)
    expect(getByText(/1 device will be targeted/)).toBeTruthy()
  })

  test('an offline device in the target is named as excluded, not silently dropped', () => {
    const devices = [device({ id: 'a' }), device({ id: 'b', label: 'Offline One', status: 'offline' })]
    const { getByText } = renderWithApi(<Picker devices={devices} clusters={[]} target={{ deviceIds: ['a', 'b'] }} onChange={() => {}} />)
    expect(getByText(/1 device will be targeted/)).toBeTruthy()
    expect(getByText(/1 excluded/)).toBeTruthy()
    expect(getByText('Offline One — offline')).toBeTruthy()
  })

  test('tag mode: AND semantics — a device must carry every selected tag', () => {
    const devices = [device({ id: 'a', tags: ['pool:smoke', 'rack:a'] }), device({ id: 'b', tags: ['pool:smoke'] })]
    let target: CommandTarget | null = null
    const { getByText, rerender } = renderWithApi(<Picker devices={devices} clusters={[]} target={null} onChange={(t) => (target = t)} />)
    fireEvent.click(getByText('Tags'))
    fireEvent.click(getByText('pool:smoke'))
    expect(target).toEqual({ tags: ['pool:smoke'] })
    rerender(<Picker devices={devices} clusters={[]} target={target} onChange={(t) => (target = t)} />)
    expect(getByText(/2 devices will be targeted/)).toBeTruthy()

    fireEvent.click(getByText('rack:a'))
    expect(target).toEqual({ tags: ['pool:smoke', 'rack:a'] })
  })

  test('cluster mode: choosing a cluster targets its members', () => {
    const clusters: ClusterInfo[] = [{ id: 'c1', name: 'Rack A', description: null, createdAt: 0, deviceCount: 1, usableCount: 1 }]
    const devices = [device({ id: 'a', cluster: { id: 'c1', name: 'Rack A' } })]
    let target: CommandTarget | null = null
    const { getByText, getByRole, rerender } = renderWithApi(<Picker devices={devices} clusters={clusters} target={null} onChange={(t) => (target = t)} />)
    fireEvent.click(getByText('Cluster'))
    fireEvent.click(getByRole('combobox'))
    fireEvent.click(getByText(/Rack A/))
    expect(target).toEqual({ clusterId: 'c1' })
    rerender(<Picker devices={devices} clusters={clusters} target={target} onChange={(t) => (target = t)} />)
    expect(getByText(/1 device will be targeted/)).toBeTruthy()
  })

  test('a busy or held device is attempted with a caution, never silently promised', () => {
    const devices = [device({ id: 'a', status: 'busy' })]
    const { getByText } = renderWithApi(<Picker devices={devices} clusters={[]} target={{ deviceIds: ['a'] }} onChange={() => {}} />)
    expect(getByText(/1 device will be targeted/)).toBeTruthy()
    expect(getByText(/may be skipped/)).toBeTruthy()
  })

  test('no target selected yet: no preview panel at all', () => {
    const { queryByTestId } = renderWithApi(<Picker devices={[device()]} clusters={[]} target={null} onChange={() => {}} />)
    expect(queryByTestId('target-preview')).toBeNull()
  })
})
