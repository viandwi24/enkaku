import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { InstallPluginDialog } from './InstallPluginDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * The two things the page-level test (`app/plugins/page.test.tsx`) cannot
 * reach through the table: the version field's own refusal, and reading a
 * bundle off disk instead of pasting it.
 */
describe('InstallPluginDialog (plan 108 §0.2 P1, §3.10)', () => {
  test('publishing is refused until the version parses, and the field says why', async () => {
    renderWithApi(<InstallPluginDialog trigger={<button type="button">Install plugin</button>} onInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }))
    await waitFor(() => expect(screen.getByText('Install a plugin')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'tiktok' } })
    fireEvent.change(screen.getByLabelText('Bundle text'), { target: { value: 'export default {}' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'latest' } })

    expect(screen.getByText(/Three numbers, e\.g\. 1\.0\.0 — a suffix/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Publish and verify' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.2.3-beta.1' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish and verify' }) as HTMLButtonElement).disabled).toBe(false))
  })

  test('a chosen .mjs file becomes the bundle that is posted', async () => {
    const { apiMock } = renderWithApi(<InstallPluginDialog trigger={<button type="button">Install plugin</button>} onInstalled={() => {}} />, {
      '/api/plugins': {
        status: 201,
        body: {
          plugin: null,
          verify: { ok: false, scripts: [], resetPackages: [], error: 'nope', errorCode: 'E_PLUGIN_VERIFY_FAILED' },
        },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }))
    await waitFor(() => expect(screen.getByText('Install a plugin')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'tiktok' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } })

    const file = new File(['export default { id: "tiktok" }'], 'tiktok.mjs', { type: 'text/javascript' })
    fireEvent.change(screen.getByLabelText('Bundle'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText('tiktok.mjs')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Publish and verify' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST')).toBe(true))
    const post = apiMock.calls.find((c) => c.method === 'POST')
    expect(post?.body).toEqual({ name: 'tiktok', version: '1.0.0', bundle: 'export default { id: "tiktok" }' })
  })
})
