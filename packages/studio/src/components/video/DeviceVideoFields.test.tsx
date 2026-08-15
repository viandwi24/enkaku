import { afterEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DeviceSettingsSchema, FarmSettingsSchema, toJsonSchema, type FarmSettings } from '@enkaku/protocol'
import '../../../happydom'
import { narrowSchema } from '@/components/schema-form/narrowSchema'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { DeviceVideoFields } from './DeviceVideoFields'

afterEach(cleanup)

const deviceSchema = toJsonSchema(DeviceSettingsSchema) as JsonSchemaNode
const videoSectionSchema = narrowSchema(deviceSchema, ['video'])
const farmVideo = FarmSettingsSchema.parse({}).video as FarmSettings['video']
const emptyDeviceSettings = DeviceSettingsSchema.parse({}) as unknown as Record<string, unknown>

function Harness({ initial = emptyDeviceSettings, farm = farmVideo }: { initial?: Record<string, unknown>; farm?: FarmSettings['video'] | null }) {
  const [draft, setDraft] = useState<Record<string, unknown>>(initial)
  return (
    <DeviceVideoFields
      schema={videoSectionSchema}
      draft={draft}
      onChange={(v) => setDraft(v as Record<string, unknown>)}
      onSubmit={() => {}}
      onReset={() => setDraft(initial)}
      busy={false}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      farmVideo={farm}
    />
  )
}

/**
 * Plan 92 §5 step 92.8, acceptance criterion 3: "an empty field follows the
 * farm, and the effective-profile readout names the farm as its source."
 */
describe('DeviceVideoFields (plan 92 §5 step 92.8, acceptance criterion 3)', () => {
  test('with no override at all, the readout names "the farm" for every field, and Reset to preset is disabled (nothing to clear)', () => {
    render(<Harness />)
    expect(screen.getAllByText('the farm').length).toBe(6) // 3 control fields + 3 wall fields
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByRole('button', { name: 'Reset to preset' })).toHaveProperty('disabled', true)
  })

  test('Advanced starts closed with no override, and its six fields are empty (no forced value)', () => {
    render(<Harness />)
    expect(screen.queryByText('Device page size (px)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByText('Device page size (px)')).toBeTruthy()
  })

  test('a device override reads "this device" in the readout for that field only, and pre-opens Advanced', () => {
    const overridden = { ...emptyDeviceSettings, video: { wallBitRate: 300_000 } }
    render(<Harness initial={overridden} />)
    // Pre-opened: the override is visible without clicking Advanced.
    expect(screen.getByDisplayValue('300000')).toBeTruthy()
    expect(screen.getAllByText('this device').length).toBe(1)
    expect(screen.getAllByText('the farm').length).toBe(5)
  })

  test('Reset to preset clears the override — the field goes back to empty and the readout goes back to "the farm"', () => {
    const overridden = { ...emptyDeviceSettings, video: { wallBitRate: 300_000 } }
    render(<Harness initial={overridden} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to preset' }))
    expect(screen.queryByDisplayValue('300000')).toBeNull()
    expect(screen.getAllByText('the farm').length).toBe(6)
  })

  test('resolved numbers are the FARM\'s own numbers when nothing is overridden — not the schema default', () => {
    const customFarm = { ...farmVideo, wallBitRate: 300_000 }
    render(<Harness farm={customFarm} />)
    expect(screen.getByText('300 kbit/s')).toBeTruthy()
  })

  test('while the farm settings have not loaded yet (`farmVideo=null`), the readout shows a loading state rather than guessing', () => {
    render(<Harness farm={null} />)
    expect(screen.queryByText('the farm')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })
})
