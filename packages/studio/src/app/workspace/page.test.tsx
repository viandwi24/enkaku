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

/**
 * Plan 116, step 116.4 (criterion 10, finding P7) — `loadFile` in `page.tsx`
 * calls `headWorkspaceFile` (a real `fetch` `HEAD` against
 * `GET /api/workspace/file`, mirrored here as a raw `Response` with the
 * headers the core route actually sets — see `packages/core/src/api/
 * workspace.ts`'s `HEAD` branch) and resolves a presenter from THAT alone.
 * `readWorkspaceFile` (`fs.read`, the capability that base64-encodes
 * content) is called only when the resolved presenter both wants content
 * and the file is under its `maxBytes` — never for a video, whatever its
 * size. This is the page-level proof: 116.6 extracted no standalone
 * decision function, so the closest honest test is asserting the capability
 * call never happens while the page still ends up rendering a working
 * `<video>` element from `src` alone.
 */
function headResponse(headers: Record<string, string>): { raw: Response } {
  return { raw: new Response(null, { status: 200, headers }) }
}

const VIDEO_HEADERS = {
  'content-type': 'video/mp4',
  'content-length': '5000000',
  etag: '"vid123"',
  'x-enkaku-created-by': 'user:u1',
  'x-enkaku-updated-by': 'user:u1',
  'x-enkaku-created-at': '0',
  'x-enkaku-updated-at': '0',
}

describe('WorkspacePage — opening a video transfers no bytes through the capability API (criterion 10, P7)', () => {
  beforeEach(() => setSearchParams({}))

  test('fs.read is never called for a video/mp4 file, and the video still renders from the GET url alone', async () => {
    setSearchParams({ path: '/clip.mp4' })
    const { apiMock } = renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [{ path: '/clip.mp4', kind: 'file', size: 5_000_000, hash: 'vid123', updatedAt: 0 }] } } },
      '/api/workspace/file*': ({ method }) => (method === 'HEAD' ? headResponse(VIDEO_HEADERS) : { raw: new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp4' } }) }),
    })

    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())

    // The claim itself: no `fs.read` capability call happened opening a 5 MB video.
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/fs.read')).toBe(false)
    // And the metadata really did come from the HEAD request, not a guess.
    expect(apiMock.calls.some((c) => c.method === 'HEAD' && c.path.startsWith('/api/workspace/file'))).toBe(true)
  })
})

describe('WorkspacePage — Save is bound to capabilities.edit (criterion 4)', () => {
  beforeEach(() => setSearchParams({}))

  test('a video shows no Save control, and states in words why it cannot be edited', async () => {
    setSearchParams({ path: '/clip.mp4' })
    renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [{ path: '/clip.mp4', kind: 'file', size: 1000, hash: 'vid123', updatedAt: 0 }] } } },
      '/api/workspace/file*': ({ method }) => (method === 'HEAD' ? headResponse({ ...VIDEO_HEADERS, 'content-length': '1000' }) : { raw: new Response(new Uint8Array(), { status: 200 }) }),
    })

    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
    expect(screen.getByText(/Videos can be viewed but not edited/)).toBeTruthy()
  })

  test('a text file DOES show a Save control', async () => {
    setSearchParams({ path: FILE_PATH })
    renderWithApi(<WorkspacePage />, publishMocks())

    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/ })).toBeTruthy())
  })
})

describe('WorkspacePage — a file over its presenter\'s maxBytes shows metadata and a download (criterion 7)', () => {
  beforeEach(() => setSearchParams({}))

  test('a .txt over the text presenter\'s 2 MB ceiling skips the editor and names the limit', async () => {
    setSearchParams({ path: '/huge.txt' })
    const { apiMock } = renderWithApi(<WorkspacePage />, {
      '/api/v1/cap/fs.list': { body: { ok: true, output: { entries: [{ path: '/huge.txt', kind: 'file', size: 5_000_000, hash: 'h9', updatedAt: 0 }] } } },
      '/api/workspace/file*': () =>
        headResponse({
          'content-type': 'text/plain',
          'content-length': '5000000',
          etag: '"h9"',
          'x-enkaku-created-at': '0',
          'x-enkaku-updated-at': '0',
        }),
    })

    await waitFor(() => expect(screen.getByText(/over the/)).toBeTruthy())
    expect(screen.getByText(/over the/).textContent).toContain('limit for viewing it here')
    // Over the ceiling means content was never fetched either — the same P7 discipline as a video.
    expect(apiMock.calls.some((c) => c.path === '/api/v1/cap/fs.read')).toBe(false)
  })
})
