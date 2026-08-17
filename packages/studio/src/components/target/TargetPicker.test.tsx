import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen } from '@testing-library/react'
import type { ClusterInfo, DeviceInfo } from '@enkaku/protocol'
import '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { TargetPicker } from './TargetPicker'
import { useTargetSelection, type Target } from './useTargetSelection'

afterEach(cleanup)

function device(id: string, label: string, status: DeviceInfo['status'] = 'online'): DeviceInfo {
  return {
    id,
    stableId: `stable-${id}`,
    serial: `serial-${id}`,
    label,
    androidVersion: '14',
    apiLevel: 34,
    screenW: 1080,
    screenH: 2400,
    density: 420,
    status,
    lastSeen: 0,
    tags: [],
    cluster: null,
  } as DeviceInfo
}

const d1 = device('d1', 'Pixel 7')
const d2 = device('d2', 'Pixel 8')
const d3 = device('d3', 'Pixel 9')
const cluster: ClusterInfo = { id: 'c1', name: 'Smoke pool', usableCount: 2, deviceCount: 2, tags: [] } as ClusterInfo

/**
 * A minimal harness — the real caller is always a dialog that owns
 * `useTargetSelection` itself (`RunScriptDialog`, and every plan 104.4
 * dialog after it); this just proves the hook + component AGREE on what
 * would actually be submitted, under every mode (plan 104 §7's own test
 * plan: "the resolved count matches what a submit would send, under every
 * mode").
 */
function Harness({ allow, usableCount = 3 }: { allow: Target[]; usableCount?: number }) {
  const selection = useTargetSelection({ usableCount, clusters: [cluster] })
  return (
    <div>
      <TargetPicker selection={selection} devices={[d1, d2, d3]} clusters={[cluster]} allow={allow} />
      <p data-testid="submit-count">would submit: {selection.resolvedCount}</p>
      <p data-testid="has-target">hasTarget: {String(selection.hasTarget)}</p>
    </div>
  )
}

describe('TargetPicker — the resolved count matches what a submit would send (plan 104 §7)', () => {
  test('single mode: picking one device makes hasTarget true, and shows no separate count line', () => {
    renderWithApi(<Harness allow={['single', 'cluster', 'devices']} />)
    expect(screen.getByTestId('has-target').textContent).toBe('hasTarget: false')
    fireEvent.click(screen.getByText('Pixel 7'))
    expect(screen.getByTestId('has-target').textContent).toBe('hasTarget: true')
    expect(screen.getByTestId('submit-count').textContent).toBe('would submit: 1')
    // No "Targets N devices" line for single mode — the picked device already says it.
    expect(screen.queryByText(/^Targets \d/)).toBeNull()
  })

  test('devices mode: the visible count always matches deviceIds.length, live as the operator edits it', () => {
    renderWithApi(<Harness allow={['single', 'cluster', 'devices']} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(screen.getByText('Pixel 7'))
    expect(screen.getByText('Targets 1 device')).toBeTruthy()
    expect(screen.getByTestId('submit-count').textContent).toBe('would submit: 1')
    fireEvent.click(screen.getByText('Pixel 8'))
    expect(screen.getByText('Targets 2 devices')).toBeTruthy()
    expect(screen.getByTestId('submit-count').textContent).toBe('would submit: 2')
  })

  test('cluster mode: the visible count reads the chosen cluster\'s own usableCount, matching the submit value', () => {
    renderWithApi(<Harness allow={['single', 'cluster', 'devices']} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cluster' }))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByText('Smoke pool'))
    expect(screen.getByText('Targets 2 devices')).toBeTruthy()
    expect(screen.getByTestId('submit-count').textContent).toBe('would submit: 2')
  })

  test('a mode not in `allow` renders no tab for it at all', () => {
    renderWithApi(<Harness allow={['single', 'devices']} />)
    expect(screen.queryByRole('tab', { name: 'Cluster' })).toBeNull()
  })

  test('a single allowed mode renders no tab switch at all', () => {
    renderWithApi(<Harness allow={['single']} />)
    expect(screen.queryByRole('tab')).toBeNull()
  })

  test('fleet-wide: selecting every usable device requires the typed confirmation before hasTarget-adjacent submit would be honest', () => {
    renderWithApi(<Harness allow={['single', 'cluster', 'devices']} usableCount={2} />)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(screen.getByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    expect(screen.getByText('This targets every usable device on the farm')).toBeTruthy()
    expect(screen.getByLabelText('Type the device count to confirm')).toBeTruthy()
  })
})
