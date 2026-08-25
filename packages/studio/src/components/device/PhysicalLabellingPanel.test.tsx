import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { DeviceSettingsSchema, toJsonSchema, type DeviceLabelState } from '@enkaku/protocol'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { renderWithApi } from '@/lib/test/render'
import { PhysicalLabellingPanel } from './PhysicalLabellingPanel'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const deviceSchema = toJsonSchema(DeviceSettingsSchema) as JsonSchemaNode
const labellingSchema = narrowSchema(deviceSchema, ['labelling'])
const emptyDeviceSettings = DeviceSettingsSchema.parse({}) as unknown as Record<string, unknown>

const device = { id: 'dev-1', label: 'Pixel 5', number: 7, screenW: 1080, screenH: 2340 }

function Harness({
  initial = emptyDeviceSettings,
  labelState = null,
}: {
  initial?: Record<string, unknown>
  labelState?: DeviceLabelState | null
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  const [state, setState] = useState<DeviceLabelState | null>(labelState)
  return (
    <PhysicalLabellingPanel
      device={device}
      schema={labellingSchema}
      draft={draft}
      onChange={(v) => setDraft(v as Record<string, unknown>)}
      onSubmit={() => {}}
      onReset={() => setDraft(initial)}
      busy={false}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      labelState={state}
      onLabelStateChange={setState}
    />
  )
}

/**
 * Plan 89 §3.4, §3.5, §3.6, §3.8, §5 step 89.8 — the three things this
 * step's own brief names: two tiers with no silent fallback, a preview that
 * never claims pixel fidelity, and opt-in stated where the choice is made.
 */
describe('PhysicalLabellingPanel', () => {
  test('mode off shows no status row, no actions, and no false claim of anything applied', () => {
    renderWithApi(<Harness />)
    expect(screen.getByText(/Labelling is off for this device/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Re-apply label/ })).toBeNull()
  })

  test('the preview states it is a content preview, never a pixel-accurate one (§3.4)', () => {
    renderWithApi(<Harness />)
    expect(screen.getByText(/the phone renders the real image itself/)).toBeTruthy()
  })

  test('the opt-in banner states, where the choice is made, that this writes to the phone and outlives the session (§3.6, §3.8)', () => {
    renderWithApi(<Harness />)
    expect(screen.getByText(/writes to the phone itself, not just to this session/)).toBeTruthy()
  })

  test('a partial state renders the badge and the reason, never rounded up to Labelled (§3.5)', () => {
    renderWithApi(
      <Harness
        initial={{ ...emptyDeviceSettings, labelling: { mode: 'wallpaper', showName: true } }}
        labelState={{
          mode: 'wallpaper',
          state: 'partial',
          reason: 'only the home screen accepted the label',
          fingerprint: 'abc',
          appliedAt: 1000,
          originalCaptured: true,
          capturedLockScreen: null,
        }}
      />,
    )
    expect(screen.getByText(/Partial — only the home screen accepted the label/)).toBeTruthy()
    expect(screen.queryByText('Labelled')).toBeNull()
  })

  test('Re-apply label posts to the apply endpoint and updates the badge from the response', async () => {
    const { container } = renderWithApi(
      <Harness initial={{ ...emptyDeviceSettings, labelling: { mode: 'wallpaper', showName: true } }} />,
      {
        '/api/devices/dev-1/label/apply': {
          body: { mode: 'wallpaper', state: 'applied', reason: null, fingerprint: 'f1', appliedAt: 1234, originalCaptured: true, capturedLockScreen: null },
        },
      },
    )
    fireEvent.click(screen.getByRole('button', { name: /Re-apply label/ }))
    await waitFor(() => expect(screen.getByText('Labelled')).toBeTruthy())
    expect(container.textContent).not.toContain('Partial')
  })

  test('Re-apply label is disabled when the device has no number assigned (plan 89 §3.1)', () => {
    renderWithApi(
      <PhysicalLabellingPanel
        device={{ ...device, number: null }}
        schema={labellingSchema}
        draft={{ ...emptyDeviceSettings, labelling: { mode: 'wallpaper', showName: true } }}
        onChange={() => {}}
        onSubmit={() => {}}
        onReset={() => {}}
        busy={false}
        dirty={false}
        labelState={null}
        onLabelStateChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /Re-apply label/ })).toHaveProperty('disabled', true)
  })

  test('Clear label offers "Restore the original" only when the service reported it was captured (originalCaptured: true)', () => {
    renderWithApi(
      <Harness
        initial={{ ...emptyDeviceSettings, labelling: { mode: 'wallpaper', showName: true } }}
        labelState={{
          mode: 'wallpaper',
          state: 'applied',
          reason: null,
          fingerprint: 'f1',
          appliedAt: 1000,
          originalCaptured: true,
          capturedLockScreen: null,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Clear label/ }))
    expect(screen.getByText('Restore the original')).toBeTruthy()
    // Plan 124 §4.4, step 124.3 — the confirm names the phone with its number.
    // The label being cleared IS the black wallpaper carrying that number, so
    // a title omitting it asks the operator to confirm wiping the one thing
    // currently telling this handset from its neighbours.
    expect(screen.getByText("Clear #7 Pixel 5's label?")).toBeTruthy()
  })

  test('Clear label states plainly it resets to the system default when nothing was captured (originalCaptured: false)', () => {
    renderWithApi(
      <Harness
        initial={{ ...emptyDeviceSettings, labelling: { mode: 'wallpaper', showName: true } }}
        labelState={{
          mode: 'wallpaper',
          state: 'applied',
          reason: null,
          fingerprint: 'f1',
          appliedAt: 1000,
          originalCaptured: false,
          capturedLockScreen: null,
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Clear label/ }))
    expect(screen.getByText(/could not be saved when labelling was first turned on/)).toBeTruthy()
    expect(screen.queryByText('Restore the original')).toBeNull()
  })
})
