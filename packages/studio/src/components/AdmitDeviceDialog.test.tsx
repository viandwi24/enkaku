import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { DiscoveredDevice } from '@/lib/api'
import { cleanup, renderWithApi } from '@/lib/test/render'

// See `AdbEndpointCard.test.tsx` for why `@/lib/ws` needs mocking even
// though this component never imports it.
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {}, onReconnected: () => () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

// Plan 89 §5 step 89.3 — the success toast names the number the device was
// ACTUALLY given (§3.1: "predicting one is a promise a concurrent admit
// could break"), so it has to come from the server response, never be
// guessed. Spied here since nothing else in this workspace asserts toast
// copy from a rendered DOM.
const toastSuccess = mock(() => {})
// `Toaster` is part of the stub because `@enkaku/ui` is a single barrel (plan
// 111 step 111.1): importing ANY component from it evaluates `sonner.tsx`, the
// wrapper that re-exports sonner's own `Toaster`.
mock.module('sonner', () => ({
  toast: { success: toastSuccess, error: () => {}, warning: () => {} },
  Toaster: () => null,
}))

const { AdmitDeviceDialog } = await import('./AdmitDeviceDialog')

afterEach(cleanup)

const entry: DiscoveredDevice = {
  stableId: 'ZP2222RMBS',
  serial: 'ZP2222RMBS',
  label: 'moto g06',
  androidVersion: '15',
  firstSeen: 1,
  lastSeen: 1,
}

describe('AdmitDeviceDialog', () => {
  test('renders the probed facts for the entry', () => {
    const { getByText } = renderWithApi(
      <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={() => {}} />,
      {},
    )
    expect(getByText('Add moto g06 to the farm')).toBeTruthy()
  })

  test('Add to farm posts the admit request and reports success', async () => {
    const onDone = mock(() => {})
    const { getByText } = renderWithApi(
      <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={onDone} />,
      {
        '/api/devices/discovered/ZP2222RMBS/admit': {
          body: { device: { id: 'dev-1', label: 'moto g06', stableId: 'ZP2222RMBS', serial: 'ZP2222RMBS', androidVersion: '15', apiLevel: 35, screenW: 720, screenH: 1600, density: 280, status: 'idle', lastSeen: 1, battery: null, quarantineReason: null, tags: [], cluster: null, lastCrashAt: null, readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 } } },
        },
      },
    )
    fireEvent.click(getByText('Add to farm'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  test('the success toast names the number the device was actually given (plan 89 §3.1, §5 step 89.3)', async () => {
    toastSuccess.mockClear()
    const onDone = mock(() => {})
    const { getByText } = renderWithApi(
      <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={onDone} />,
      {
        '/api/devices/discovered/ZP2222RMBS/admit': {
          body: {
            device: {
              id: 'dev-1',
              label: 'moto g06',
              stableId: 'ZP2222RMBS',
              serial: 'ZP2222RMBS',
              androidVersion: '15',
              apiLevel: 35,
              screenW: 720,
              screenH: 1600,
              density: 280,
              status: 'idle',
              lastSeen: 1,
              battery: null,
              quarantineReason: null,
              tags: [],
              cluster: null,
              lastCrashAt: null,
              readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
              number: 7,
            },
          },
        },
      },
    )
    fireEvent.click(getByText('Add to farm'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(toastSuccess).toHaveBeenCalledWith('Added as #7 moto g06')
  })

  /**
   * Plan 89 §3.8, §5 step 89.8 — "one checkbox reflecting the farm default,
   * and the copy next to it says what it does without softening it," verbatim.
   */
  describe('the physical labelling checkbox (plan 89 §3.8, §5 step 89.8)', () => {
    const admitResponse = {
      device: {
        id: 'dev-1',
        label: 'moto g06',
        stableId: 'ZP2222RMBS',
        serial: 'ZP2222RMBS',
        androidVersion: '15',
        apiLevel: 35,
        screenW: 720,
        screenH: 1600,
        density: 280,
        status: 'idle',
        lastSeen: 1,
        battery: null,
        quarantineReason: null,
        tags: [],
        cluster: null,
        lastCrashAt: null,
        readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
        number: 1,
      },
    }

    test('the copy is verbatim, unsoftened', () => {
      const { getByText } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={() => {}} />,
      )
      expect(
        getByText(
          /Replaces this phone.s wallpaper with a black label\. Enkaku will try to save the current one first, but on many Android versions it cannot read it back — if that fails, turning labelling off restores the system default wallpaper, not the original\./,
        ),
      ).toBeTruthy()
    })

    test('reflects an "off" farm default as unchecked', () => {
      const { getByRole } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={() => {}} />,
      )
      expect(getByRole('switch', { name: "Label this phone's screen" }).getAttribute('aria-checked')).toBe('false')
    })

    test('reflects a "wallpaper" farm default as checked', () => {
      const { getByRole } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="wallpaper" open={true} onOpenChange={() => {}} onDone={() => {}} />,
      )
      expect(getByRole('switch', { name: "Label this phone's screen" }).getAttribute('aria-checked')).toBe('true')
    })

    test('leaving the box matching the farm default issues no follow-up settings PATCH', async () => {
      const onDone = mock(() => {})
      const { getByText } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={onDone} />,
        { '/api/devices/discovered/ZP2222RMBS/admit': { body: admitResponse } },
      )
      fireEvent.click(getByText('Add to farm'))
      await waitFor(() => expect(onDone).toHaveBeenCalled())
    })

    test('checking it against an "off" farm default re-fetches the device and PATCHes labelling.mode to wallpaper', async () => {
      const onDone = mock(() => {})
      const { getByText, getByRole } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={onDone} />,
        {
          '/api/devices/discovered/ZP2222RMBS/admit': { body: admitResponse },
          '/api/devices/dev-1': ({ method }) =>
            method === 'GET'
              ? { body: { ...admitResponse.device, transport: 'adb-usb', display: 'scrcpy', input: 'adb-input', inspection: 'ui-server', settings: { labelling: { mode: 'off', showName: true } }, nodeId: null } }
              : { body: admitResponse },
        },
      )
      fireEvent.click(getByRole('switch', { name: "Label this phone's screen" }))
      fireEvent.click(getByText('Add to farm'))
      await waitFor(() => expect(onDone).toHaveBeenCalled())
    })

    test('a follow-up PATCH failure is tolerated with a warning, never blocking the admission itself', async () => {
      const onDone = mock(() => {})
      const { getByText, getByRole } = renderWithApi(
        <AdmitDeviceDialog entry={entry} clusters={[]} farmLabellingMode="off" open={true} onOpenChange={() => {}} onDone={onDone} />,
        {
          '/api/devices/discovered/ZP2222RMBS/admit': { body: admitResponse },
          '/api/devices/dev-1': { status: 500, body: { error: { code: 'boom', message: 'boom' } } },
        },
      )
      fireEvent.click(getByRole('switch', { name: "Label this phone's screen" }))
      fireEvent.click(getByText('Add to farm'))
      await waitFor(() => expect(onDone).toHaveBeenCalled())
    })
  })
})
