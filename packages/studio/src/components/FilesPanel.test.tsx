import { afterEach, describe, expect, mock, test } from 'bun:test'
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
