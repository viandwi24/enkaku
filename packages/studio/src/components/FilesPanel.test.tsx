import { afterEach, describe, expect, mock, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'

// `FilesPanel` subscribes to `transfer.progress`/`transfer.done` over `ws`
// and uploads through `coreBase()` — both come from `@/lib/ws`, replaced
// here the same way `DeviceLog.test.tsx` replaces it (no real `WebSocket` in
// `happy-dom`).
mock.module('@/lib/ws', () => ({
  ws: { on: () => () => {}, send: () => {} },
  coreBase: () => 'http://localhost:7700',
  newId: () => 'test-id',
}))

const { FilesPanel } = await import('./FilesPanel')

afterEach(cleanup)

describe('FilesPanel', () => {
  test('renders the three transfer sections when control is held', () => {
    const { getByText } = renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {})
    expect(getByText('Install APK')).toBeTruthy()
    expect(getByText('Push a file')).toBeTruthy()
    expect(getByText('Pull a file')).toBeTruthy()
  })

  test('without control, the panel states why rather than hiding', () => {
    const { getByText } = renderWithApi(<FilesPanel deviceId="dev-1" clientId={null} canUse={false} />, {})
    expect(getByText('Take control of this device to push, pull, or install files.')).toBeTruthy()
  })
})

/**
 * Destination presets and the media-scan result line (plan 90 §3.4, §4.6,
 * step 90.7) — "gallery" as a farm operator experiences it is picking a
 * file and picking where it goes, then being told whether the phone's
 * media library actually learned about it.
 */
describe('FilesPanel — destination presets and mediaScan (plan 90 §3.4, §4.6)', () => {
  test('choosing the Pictures preset rewrites the path to /sdcard/Pictures/<filename>', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {})

    const fileInput = screen.getByLabelText('File to push') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    await user.click(screen.getByRole('button', { name: 'Pictures' }))

    const pathInput = screen.getByPlaceholderText('/data/local/tmp/file.bin') as HTMLInputElement
    expect(pathInput.value).toBe('/sdcard/Pictures/photo.jpg')
  })

  test('typing in the path field by hand falls back to custom — a preset stops overriding it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {})

    const fileInput = screen.getByLabelText('File to push') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    await user.click(screen.getByRole('button', { name: 'Movies' }))
    const pathInput = screen.getByPlaceholderText('/data/local/tmp/file.bin') as HTMLInputElement
    expect(pathInput.value).toBe('/sdcard/Movies/photo.jpg')

    await user.clear(pathInput)
    await user.type(pathInput, '/data/local/tmp/custom.jpg')
    // Picking a new file no longer rewrites the path — 'custom' won.
    await user.upload(fileInput, new File(['y'], 'other.jpg', { type: 'image/jpeg' }))
    expect(pathInput.value).toBe('/data/local/tmp/custom.jpg')
  })

  test('after a push, the result line names the method that told the media library (H3, settled in the field)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    let pushBody: unknown
    renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {
      '/api/artifacts': { body: { artifact: { id: 'art-1' } } },
      '/api/devices/dev-1/push': (req) => {
        pushBody = req.body
        return { body: { result: { mediaScan: { ran: true, method: 'scan_file', ms: 7 } } } }
      },
    })

    const fileInput = screen.getByLabelText('File to push') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    await user.click(screen.getByRole('button', { name: 'Pictures' }))
    await user.click(screen.getByRole('button', { name: 'Push' }))

    await waitFor(() => expect(screen.getByText('Told the media library (scan_file, 7ms).')).toBeTruthy())
    expect(pushBody).toMatchObject({ artifactId: 'art-1', remotePath: '/sdcard/Pictures/photo.jpg', clientId: 'c1' })
  })

  test('a scan that never ran is reported, not silence', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {
      '/api/artifacts': { body: { artifact: { id: 'art-1' } } },
      '/api/devices/dev-1/push': { body: { result: { mediaScan: { ran: false, method: null, ms: 0 } } } },
    })

    const fileInput = screen.getByLabelText('File to push') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'note.bin', { type: 'application/octet-stream' }))
    await user.click(screen.getByRole('button', { name: 'Push' }))

    await waitFor(() =>
      expect(screen.getByText('Media library was not told — the destination is outside Pictures/Movies/Music/Download/DCIM.')).toBeTruthy(),
    )
  })

  test('a failed scan is named, and never blocks the push itself from succeeding', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    renderWithApi(<FilesPanel deviceId="dev-1" clientId="c1" canUse={true} />, {
      '/api/artifacts': { body: { artifact: { id: 'art-1' } } },
      '/api/devices/dev-1/push': {
        body: { result: { mediaScan: { ran: false, method: null, ms: 3, error: 'scan_file exited 1; scan_volume exited 1' } } },
      },
    })

    const fileInput = screen.getByLabelText('File to push') as HTMLInputElement
    await user.upload(fileInput, new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    await user.click(screen.getByRole('button', { name: 'Pictures' }))
    await user.click(screen.getByRole('button', { name: 'Push' }))

    await waitFor(() => expect(screen.getByText(/Media library was not told: scan_file exited 1/)).toBeTruthy())
  })
})
