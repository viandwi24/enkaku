import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi, type MockEntry } from '@/lib/test/render'
import { KvPanel } from './KvPanel'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const SECRET_PLAINTEXT = 'sk-this-is-the-real-secret-value-do-not-render-me'

/**
 * `installApiMock` matches the FIRST key whose pattern fits, so the narrower
 * `/api/kv/namespaces*` must be declared before `/api/kv*` — otherwise the
 * entry-list mock swallows the index request and the panel's own Zod parse
 * fails on a shape it never asked for.
 */
function mocks(index: { namespace: string; entries: number; secrets: number }[], entries?: MockEntry): Record<string, MockEntry> {
  return {
    '/api/kv/namespaces*': { body: { items: index } },
    ...(entries ? { '/api/kv*': entries } : {}),
  }
}

const TIKTOK = { namespace: 'tiktok', entries: 4, secrets: 1 }
const PROXY = { namespace: 'proxy-manager', entries: 1, secrets: 0 }

async function typeNamespace(namespace: string) {
  fireEvent.change(screen.getByLabelText('Browse another namespace'), { target: { value: namespace } })
  fireEvent.click(screen.getByRole('button', { name: /browse/i }))
}

describe('KvPanel — the namespace index (the store is browsable without guessing)', () => {
  test('namespaces appear with their counts on mount, without anything being typed', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([PROXY, TIKTOK]))

    // The exact report this route was added for: five entries across two
    // namespaces used to render as a blank page behind a search box.
    await waitFor(() => expect(screen.getByRole('button', { name: /proxy-manager/ })).toBeTruthy())
    expect(screen.getByText('1 value')).toBeTruthy()
    // The secret count is stated, never folded into the total and hidden.
    expect(screen.getByText('4 values · 1 secret')).toBeTruthy()
  })

  test('browsing a namespace is one click on the picker — no typing at all', async () => {
    const { apiMock } = renderWithApi(
      <KvPanel scope={{ kind: 'global' }} />,
      mocks([TIKTOK], { body: { items: [{ key: 'plain-counter', value: 42, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 }], nextCursor: null } }),
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('plain-counter')).toBeTruthy())
    expect(apiMock.calls.some((c) => c.path.includes('namespace=tiktok'))).toBe(true)
  })

  test('the device panel indexes at scope=device with the stableId, so it lists only that device\'s namespaces', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'device', stableId: 'stable-abc' }} />, mocks([TIKTOK]))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path.startsWith('/api/kv/namespaces?'))).toBe(true))
    const call = apiMock.calls.find((c) => c.path.startsWith('/api/kv/namespaces?'))
    expect(call?.path).toContain('scope=device')
    expect(call?.path).toContain('stableId=stable-abc')
  })
})

describe('KvPanel — empty is never confused with unindexed', () => {
  test('an empty index on a device says the DEVICE has nothing, not that a namespace is needed', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'device', stableId: 'stable-abc' }} />, mocks([]))
    await waitFor(() => expect(screen.getByText('This device has no stored values')).toBeTruthy())
    expect(screen.queryByText('Pick a namespace to browse')).toBeNull()
  })

  test('an empty index at global scope says the FARM has nothing', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([]))
    await waitFor(() => expect(screen.getByText('Nothing is stored farm-wide yet')).toBeTruthy())
    expect(screen.queryByText('Pick a namespace to browse')).toBeNull()
  })

  test('a populated index with nothing selected asks for a pick — a different fact from an empty store', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK]))
    await waitFor(() => expect(screen.getByText('Pick a namespace to browse')).toBeTruthy())
    expect(screen.queryByText('Nothing is stored farm-wide yet')).toBeNull()
  })

  test('a chosen namespace holding nothing is its own third state', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK], { body: { items: [], nextCursor: null } }))
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('No values under this namespace yet')).toBeTruthy())
    expect(screen.queryByText('Pick a namespace to browse')).toBeNull()
    expect(screen.queryByText('Nothing is stored farm-wide yet')).toBeNull()
  })
})

describe('KvPanel — the free-text escape hatch', () => {
  test('a namespace with no rows is not in the index by construction, so it can still be typed', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK], { body: { items: [], nextCursor: null } }))
    await waitFor(() => expect(screen.getByLabelText('Browse another namespace')).toBeTruthy())
    await typeNamespace('declared-but-never-written')
    await waitFor(() => expect(apiMock.calls.some((c) => c.path.includes('namespace=declared-but-never-written'))).toBe(true))
    expect(screen.getByText('No values under this namespace yet')).toBeTruthy()
  })

  test('the panel says which list is which, so an absent namespace is not read as a missing one', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK]))
    await waitFor(() => expect(screen.getByText(/every namespace that currently holds values/i)).toBeTruthy())
  })
})

describe('KvPanel — a secret\'s plaintext never reaches the rendered output (plan 79 §3.4)', () => {
  test('a secret entry renders its hint and a "secret" marker, and the plaintext appears NOWHERE in the DOM — even if the server response carried it (defense in depth, not trust in the network)', async () => {
    renderWithApi(
      <KvPanel scope={{ kind: 'global' }} />,
      mocks([TIKTOK], {
        body: {
          items: [
            // A real server always redacts `value` to null for a secret row
            // (`redactEntry`, core `api/kv.ts`) — this mock deliberately does
            // NOT, to prove the component itself never reads `.value` for a
            // secret entry, rather than merely trusting the network never to
            // send it. If this test ever fails because the component started
            // rendering `.value` unconditionally, that is exactly the bug it
            // exists to catch.
            { key: 'token', value: SECRET_PLAINTEXT, secret: true, hint: 'sk-…7Xq2', version: 1, expiresAt: null, updatedAt: 0 },
            { key: 'plain-counter', value: 42, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 },
          ],
          nextCursor: null,
        },
      }),
    )

    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('token')).toBeTruthy())

    // The hint and the "secret" marker ARE shown.
    expect(screen.getByText(/secret · sk-…7Xq2/)).toBeTruthy()
    // The non-secret value renders normally.
    expect(screen.getByText('42')).toBeTruthy()

    // The plaintext is NOWHERE in the rendered document — not in a text
    // node, not in an attribute (title/alt/aria-label), not in a hidden
    // element. `document.body.innerHTML` covers all of the above.
    expect(document.body.innerHTML).not.toContain(SECRET_PLAINTEXT)
  })

  test('the index itself carries no hint, so listing namespaces widened nothing', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK]))
    await waitFor(() => expect(screen.getByText('4 values · 1 secret')).toBeTruthy())
    expect(document.body.innerHTML).not.toContain('sk-')
  })

  test('a device-scoped panel queries entries with the device\'s stableId, not its row id', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'device', stableId: 'stable-abc' }} />, mocks([TIKTOK], { body: { items: [], nextCursor: null } }))
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path.startsWith('/api/kv?') && c.path.includes('stableId=stable-abc'))).toBe(true))
  })
})

/**
 * The reveal (`POST /api/kv/entry/reveal`). The mock keys are ordered narrowest
 * first for the same reason `mocks()` above is: `installApiMock` takes the FIRST
 * pattern that fits, and `/api/kv*` would otherwise swallow the reveal.
 */
describe('KvPanel — showing one secret back, on request and on the record', () => {
  const REVEALED = 'socks5://user-9f:s0ax-p4ssw0rd@proxy.example:1080'

  const SECRET_ROW = { key: 'proxy-secret:1', value: null, secret: true, hint: null, version: 3, expiresAt: null, updatedAt: 0 }
  const PLAIN_ROW = { key: 'plain-counter', value: 42, secret: false, hint: null, version: 1, expiresAt: null, updatedAt: 0 }

  function revealMocks(rows: unknown[] = [SECRET_ROW, PLAIN_ROW]): Record<string, MockEntry> {
    return {
      '/api/kv/namespaces*': { body: { items: [TIKTOK] } },
      '/api/kv/entry/reveal': { body: { namespace: 'tiktok', key: 'proxy-secret:1', value: REVEALED, version: 3, revealedAt: 1_700_000_000 } },
      '/api/kv*': { body: { items: rows, nextCursor: null } },
    }
  }

  async function openTiktok() {
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('proxy-secret:1')).toBeTruthy())
  }

  test('rendering a secret row fetches NO plaintext — the reveal happens only when it is asked for', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, revealMocks())
    await openTiktok()
    expect(apiMock.calls.some((c) => c.path.includes('/reveal'))).toBe(false)
    expect(document.body.innerHTML).not.toContain(REVEALED)
  })

  test('Show posts the row\'s coordinates and renders the plaintext; Hide takes it back out of the DOM', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, revealMocks())
    await openTiktok()

    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(screen.getByText(REVEALED)).toBeTruthy())

    const call = apiMock.calls.find((c) => c.path === '/api/kv/entry/reveal')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ scope: 'global', namespace: 'tiktok', key: 'proxy-secret:1' })

    fireEvent.click(screen.getByRole('button', { name: /hide/i }))
    // Not hidden — removed. The plaintext is nowhere in the document, in any node or attribute.
    await waitFor(() => expect(document.body.innerHTML).not.toContain(REVEALED))
  })

  test('a device panel reveals under the device\'s stableId', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'device', stableId: 'stable-abc' }} />, revealMocks())
    await openTiktok()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/kv/entry/reveal')).toBe(true))
    expect(apiMock.calls.find((c) => c.path === '/api/kv/entry/reveal')?.body).toEqual({
      scope: 'device',
      stableId: 'stable-abc',
      namespace: 'tiktok',
      key: 'proxy-secret:1',
    })
  })

  test('a revealed value does not survive a namespace change', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, revealMocks())
    await openTiktok()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(screen.getByText(REVEALED)).toBeTruthy())

    await typeNamespace('proxy-manager')
    await waitFor(() => expect(document.body.innerHTML).not.toContain(REVEALED))
  })

  test('a plain row has no Show button at all — reveal is for secrets, and the server refuses the rest', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, revealMocks([PLAIN_ROW]))
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('plain-counter')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    // …and the sentence about recording is not shown where there is nothing to reveal.
    expect(screen.queryByText(/records who showed it/)).toBeNull()
  })

  test('the panel says, once, that showing a value is recorded', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, revealMocks())
    await openTiktok()
    expect(screen.getAllByText(/records who showed it, which namespace and key, and when/).length).toBe(1)
  })
})

// Hotfix 96.38 — the panel is the surface that wrote credentials with a hint nobody asked for.
describe('KvPanel — writing a secret decides its hint (96.38)', () => {
  const writeMocks: Record<string, MockEntry> = {
    '/api/kv/namespaces*': { body: { items: [TIKTOK] } },
    '/api/kv/entry': { body: { key: 'proxy-secret:1', value: null, secret: true, hint: null, version: 1, expiresAt: null, updatedAt: 0 } },
    '/api/kv*': { body: { items: [], nextCursor: null } },
  }

  async function openForm() {
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /set a value/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /set a value/i }))
    await waitFor(() => expect(screen.getByLabelText('Key')).toBeTruthy())
  }

  test('a non-secret write sends no hint at all — a plain row has never had one', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, writeMocks)
    await openForm()
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/kv/entry')).toBe(true))
    const body = apiMock.calls.find((c) => c.path === '/api/kv/entry')?.body as Record<string, unknown>
    expect('hint' in body).toBe(false)
  })

  test('a secret write sends hint:false by default, and the hint switch only appears once secret is on', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, writeMocks)
    await openForm()
    expect(screen.queryByText('Store a hint')).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: /secret/i }))
    await waitFor(() => expect(screen.getByText('Store a hint')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'proxy-secret:1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/kv/entry')).toBe(true))
    expect(apiMock.calls.find((c) => c.path === '/api/kv/entry')?.body).toMatchObject({ secret: true, hint: false })
  })

  test('switching the hint on sends hint:true — the disclosure is a choice, made per write', async () => {
    const { apiMock } = renderWithApi(<KvPanel scope={{ kind: 'global' }} />, writeMocks)
    await openForm()
    fireEvent.click(screen.getByRole('switch', { name: /secret/i }))
    await waitFor(() => expect(screen.getByText('Store a hint')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: /store a hint/i }))

    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'api-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/kv/entry')).toBe(true))
    expect(apiMock.calls.find((c) => c.path === '/api/kv/entry')?.body).toMatchObject({ secret: true, hint: true })
  })
})

describe('KvPanel — loading, loaded, and error states', () => {
  test('the index shows a busy skeleton while it is in flight, never an empty store', () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('Nothing is stored farm-wide yet')).toBeNull()
  })

  test('loading: shows a busy skeleton while the entry request is in flight', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK]), { unmatched: 'pending' })
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy())
  })

  test('error: a failed /api/kv fetch shows a named error', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, mocks([TIKTOK], { status: 500, body: { error: { code: 'E_INTERNAL', message: 'kv boom' } } }))
    await waitFor(() => expect(screen.getByRole('button', { name: /tiktok/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /tiktok/ }))
    await waitFor(() => expect(screen.getByText('kv boom')).toBeTruthy())
  })

  test('error: a failed index fetch is named and retryable, never rendered as an empty store', async () => {
    renderWithApi(<KvPanel scope={{ kind: 'global' }} />, {
      '/api/kv/namespaces*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'index boom' } } },
    })
    await waitFor(() => expect(screen.getByText('index boom')).toBeTruthy())
    expect(screen.queryByText('Nothing is stored farm-wide yet')).toBeNull()
  })
})
