import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter, setSearchParams } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { defaultPublishName } from '@/lib/workspace'
import WorkspacePage from './page'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * `/workspace` (plan 64) talks to the `fs.*` capabilities through
 * `lib/workspace.ts`'s own `invokeCap` wrapper (out of scope for this plan —
 * owned elsewhere, already migrated to `api()` + a real schema on its own).
 * Every call lands on `POST /api/v1/cap/:id`; this smoke render mocks that
 * one path for the page's own call sites.
 */
describe('WorkspacePage — smoke render', () => {
  beforeEach(() => setSearchParams({}))

  test('loaded: lists the root directory', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': {
        body: { ok: true, output: { entries: [{ path: '/hello.ts', kind: 'file', size: 12, hash: 'abc', updatedAt: 0 }] } },
      },
    })
    await waitFor(() => expect(screen.getByText('hello.ts')).toBeTruthy())
  })

  test('loaded: empty directory shows the empty hint', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [] } } },
    })
    await waitFor(() => expect(screen.getByText('Nothing here yet.')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the directory loads', () => {
    renderWithApi(<WorkspacePage />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed fs.list call shows a named error', async () => {
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'workspace boom' } } },
    })
    await waitFor(() => expect(screen.getByText('workspace boom')).toBeTruthy())
  })
})

/**
 * Publishing (plan 110 §3.2) — a script is published as `<plugin>/<script>`,
 * because a script cannot exist outside a plugin. The form collects the two
 * halves separately and checks the SAME shapes `script.publish` enforces, so a
 * bad name is a field hint here rather than a schema refusal that comes back
 * naming neither half.
 */
describe('defaultPublishName', () => {
  test('a file directly under /scripts/ names its own plugin, member `main`', () => {
    expect(defaultPublishName('/scripts/checkout.ts')).toEqual({ plugin: 'checkout', script: 'main' })
  })

  test('a folder under /scripts/ is taken as the plugin', () => {
    expect(defaultPublishName('/scripts/tiktok/search.ts')).toEqual({ plugin: 'tiktok', script: 'search' })
  })

  test('characters neither half allows are reduced, never passed through', () => {
    expect(defaultPublishName('/scripts/My Checkout Flow.ts')).toEqual({ plugin: 'my-checkout-flow', script: 'main' })
  })
})

const FILE_PATH = '/scripts/checkout.ts'

function publishMocks(onPublish?: (body: unknown) => void) {
  return {
    '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [{ path: FILE_PATH, kind: 'file', size: 12, hash: 'h1', updatedAt: 0 }] } } },
    '/api/v1/cap/fs.read': {
      body: {
        ok: true,
        output: {
          path: FILE_PATH,
          content: 'export default {}',
          contentType: 'text/plain',
          size: 17,
          hash: 'h1',
          createdBy: 'user:u1',
          updatedBy: 'user:u1',
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
    '/api/v1/cap/script.publish': (req: { body: unknown }) => {
      onPublish?.(req.body)
      return { body: { ok: true, output: { id: 'sc_1', name: 'checkout/main', version: '1.0.0' } } }
    },
  }
}

async function openPublishDialog(onPublish?: (body: unknown) => void) {
  setSearchParams({ path: FILE_PATH })
  const rendered = renderWithApi(<WorkspacePage />, publishMocks(onPublish))
  await waitFor(() => expect(screen.getByText('Publish as script')).toBeTruthy())
  fireEvent.click(screen.getByText('Publish as script'))
  await waitFor(() => expect(screen.getByLabelText('Plugin')).toBeTruthy())
  return rendered
}

describe('WorkspacePage — publish', () => {
  beforeEach(() => {
    setSearchParams({})
    mockRouter.push.mockClear()
  })

  test('the dialog opens prefilled from the file path', async () => {
    await openPublishDialog()
    expect((screen.getByLabelText('Plugin') as HTMLInputElement).value).toBe('checkout')
    expect((screen.getByLabelText('Script') as HTMLInputElement).value).toBe('main')
    expect((screen.getByLabelText('Version') as HTMLInputElement).value).toBe('1.0.0')
    expect(screen.getByText('checkout/main')).toBeTruthy()
  })

  test('the rule is explained in the dialog, not only in a refusal', async () => {
    await openPublishDialog()
    expect(screen.getByText(/A script is published as part of a plugin/)).toBeTruthy()
  })

  test('a valid qualified name sends exactly what script.publish accepts', async () => {
    let sent: unknown = null
    const { apiMock } = await openPublishDialog((body) => {
      sent = body
    })

    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))

    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toEqual({ path: FILE_PATH, name: 'checkout/main', version: '1.0.0' })
    // The three fields the capability forbids a caller to assert.
    const body = sent as Record<string, unknown>
    expect('pluginId' in body).toBe(false)
    expect('exportId' in body).toBe(false)
    expect('kind' in body).toBe(false)
    expect(apiMock.calls.filter((c) => c.path === '/api/v1/cap/script.publish').length).toBe(1)
  })

  test('after publishing it navigates to the version that now exists', async () => {
    await openPublishDialog()
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/scripts/detail?id=sc_1'))
  })

  test('a bad plugin half is refused here, and says which half is wrong', async () => {
    const { apiMock } = await openPublishDialog()

    fireEvent.change(screen.getByLabelText('Plugin'), { target: { value: 'Check Out' } })

    await waitFor(() => expect(screen.getByText(/^Plugin name can only use/)).toBeTruthy())
    expect(screen.queryByText(/^Script name can only use/)).toBeNull()
    const button = screen.getByRole('button', { name: /^Publish$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/script.publish')).toBe(false)
  })

  test('a bad script half is refused here, and says which half is wrong', async () => {
    const { apiMock } = await openPublishDialog()

    fireEvent.change(screen.getByLabelText('Script'), { target: { value: 'Main Flow' } })

    await waitFor(() => expect(screen.getByText(/^Script name can only use/)).toBeTruthy())
    expect(screen.queryByText(/^Plugin name can only use/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/script.publish')).toBe(false)
  })

  test('an empty plugin half says the plugin is required, and nothing is sent', async () => {
    const { apiMock } = await openPublishDialog()

    fireEvent.change(screen.getByLabelText('Plugin'), { target: { value: '' } })

    await waitFor(() => expect(screen.getByText(/^Plugin name is missing/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/script.publish')).toBe(false)
  })

  test('a bad version is refused here too', async () => {
    const { apiMock } = await openPublishDialog()

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'latest' } })

    await waitFor(() => expect(screen.getByText('Version must be three numbers, like 1.0.0.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/script.publish')).toBe(false)
  })

  test("the server's own refusal is shown when it is the server that says no", async () => {
    setSearchParams({ path: FILE_PATH })
    renderWithApi(<WorkspacePage />, {
      ...publishMocks(),
      '/api/v1/cap/script.publish': {
        status: 409,
        body: { error: { code: 'script_version_exists', message: 'checkout/main@1.0.0 already exists' } },
      },
    })
    await waitFor(() => expect(screen.getByText('Publish as script')).toBeTruthy())
    fireEvent.click(screen.getByText('Publish as script'))
    await waitFor(() => expect(screen.getByLabelText('Plugin')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }))

    await waitFor(() => expect(screen.getByText('checkout/main@1.0.0 already exists')).toBeTruthy())
    expect(mockRouter.push).not.toHaveBeenCalled()
  })
})
