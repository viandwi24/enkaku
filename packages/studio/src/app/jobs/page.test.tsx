import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@enkaku/ui'
import { AuthContext, type AuthState } from '@/lib/auth'
import { cleanup, renderWithApi } from '@/lib/test/render'
import JobsPage from './page'

// `JobsPage` renders a `<Tooltip>` around the "created" timestamp, relying
// on the app-wide `<TooltipProvider>` from `app/layout.tsx` — absent here
// since the test mounts the page in isolation, so it is supplied locally.
function Wrapped() {
  return (
    <TooltipProvider>
      <JobsPage />
    </TooltipProvider>
  )
}

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'running',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
}

describe('JobsPage — smoke render', () => {
  test('loaded: shows the job row', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [job], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
  })

  test('loaded: empty list shows the empty state', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [], nextCursor: null, total: 0 } },
    })
    await waitFor(() => expect(screen.getByText('No jobs yet')).toBeTruthy())
  })

  test('loading: shows a busy skeleton before the job list loads', () => {
    renderWithApi(<Wrapped />, {}, { unmatched: 'pending' })
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  test('error: a failed /api/jobs fetch shows a named error', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'jobs boom' } } },
    })
    await waitFor(() => expect(screen.getByText('jobs boom')).toBeTruthy())
  })
})

/** Plan 91 §1, §5 step 91.5 — the job row's own "was this helped" tell (`JobsList.tsx`). */
describe('JobsPage — the assisted badge (plan 91 §5 step 91.5)', () => {
  test('a job with assistCount > 0 shows the "assisted" badge', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [{ ...job, assistCount: 3 }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.getByText('assisted')).toBeTruthy()
  })

  test('an ordinary job (assistCount 0) shows no "assisted" badge', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
      '/api/jobs*': { body: { items: [{ ...job, assistCount: 0 }], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('checkout@1.0.0')).toBeTruthy())
    expect(screen.queryByText('assisted')).toBeNull()
  })
})

/**
 * Plan 124 §1 goals 1 and 3, §4.4 Group D, criterion 1, step 124.4.
 *
 * Two separate claims about this page, both previously false: the device cell
 * names the phone with its number, and the search box finds it BY that number
 * — typing `7` matches `#7` and nothing else, which is the difference between
 * one hit and four on a 45-device farm.
 *
 * Negatives are asserted as counts, never as `expect(node).toBeNull()` inside
 * a retrying `waitFor`: that combination serialises a happy-dom element into a
 * failure report large enough to look like a hang.
 */
describe('JobsPage — the number, in the cell and in the search box (plan 124 §4.4)', () => {
  const device = (over: Record<string, unknown>) => ({
    id: 'device-1',
    // Deliberately free of the digit 7 in BOTH the label and the stableId:
    // `matchesDeviceQuery` matches those two as SUBSTRINGS, so a fixture like
    // `SM-F721U1` / `R5CW0017` would make the "typing 7 finds only #7" test
    // pass or fail for the wrong reason entirely.
    label: 'Galaxy A15',
    stableId: 'R5CWAAAA',
    status: 'idle',
    tags: [],
    number: 7,
    ...over,
  })

  // Two phones with the SAME label and different numbers — the exact rack
  // this plan exists for (§0's opening paragraph).
  const devices = [
    device({}),
    device({ id: 'device-2', stableId: 'R5CWBBBB', number: 17 }),
  ]
  const jobs = [job, { ...job, jobId: 'job-2', deviceId: 'device-2' }]

  const mount = () =>
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: devices, nextCursor: null, total: 2 } },
      '/api/jobs*': { body: { items: jobs, nextCursor: null, total: 2 } },
    })

  test('the device cell renders "#7" beside the label, as two nodes', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(2))
    expect(screen.getAllByText('#7').length).toBe(1)
    expect(screen.getAllByText('#17').length).toBe(1)
  })

  test('typing "7" finds #7 and NOT #17 — the number matches exactly (criterion 1)', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(2))
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: '7' } })
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(1))
    expect(screen.getAllByText('#7').length).toBe(1)
    expect(screen.queryAllByText('#17').length).toBe(0)
  })

  test('typing "#7" behaves identically — an operator reads the "#" off the phone (criterion 1)', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(2))
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: '#7' } })
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(1))
    expect(screen.queryAllByText('#17').length).toBe(0)
  })

  test('the stableId still matches, and so does the script name — the box did not narrow', async () => {
    mount()
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(2))
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'R5CWBBBB' } })
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(1))
    fireEvent.change(screen.getByLabelText('Search jobs'), { target: { value: 'checkout' } })
    await waitFor(() => expect(screen.getAllByText('Galaxy A15').length).toBe(2))
  })

  test('a device with no number renders the bare label — no stray "#" (criterion 7)', async () => {
    renderWithApi(<Wrapped />, {
      '/api/devices*': { body: { items: [device({ number: null })], nextCursor: null, total: 1 } },
      '/api/jobs*': { body: { items: [job], nextCursor: null, total: 1 } },
    })
    await waitFor(() => expect(screen.getByText('Galaxy A15')).toBeTruthy())
    expect(screen.queryAllByText(/^#/).length).toBe(0)
  })
})

/**
 * Plan 128 §4.3, §9 Q4, step 128.8 — "Clear history". The route is gated on
 * `job.history.purge`, a NEW admin-only permission deliberately outside the
 * `OPERATOR` set: it selects by FILTER, not by a device the caller owns, so
 * on `job.run` any operator could have erased every run on every device in
 * the farm along with the trace frames that are the only record of what they
 * did. Studio renders the control disabled with the reason rather than
 * hiding it (the `/tools` pattern); the server re-checks regardless.
 */
describe('JobsPage — Clear history (plan 128 §5 step 128.8)', () => {
  function authValue(overrides: Partial<AuthState>): AuthState {
    return { user: null, authMode: 'server', setupNeeded: false, refresh: async () => {}, logout: async () => {}, ...overrides }
  }

  const responses = {
    '/api/devices*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/jobs*': { body: { items: [job], nextCursor: null, total: 1 } },
  }

  function mountAs(role: 'admin' | 'operator') {
    return renderWithApi(
      <AuthContext.Provider value={authValue({ user: { id: 'u1', email: `${role}@x.com`, role } })}>
        <Wrapped />
      </AuthContext.Provider>,
      { ...responses, '/api/jobs/history/clear': { body: { deleted: { jobs: 4, events: 40, artifacts: 3, nodes: 0, traceDirs: 4 }, skipped: 1 } } },
    )
  }

  test('an operator sees the button, disabled, with the reason', async () => {
    mountAs('operator')
    const button = (await waitFor(() => screen.getByRole('button', { name: 'Clear history' }))) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('Only an admin can clear job history')
  })

  test('an admin can clear — the dialog names the blast radius, and the POST goes out', async () => {
    const { apiMock } = mountAs('admin')
    const button = (await waitFor(() => screen.getByRole('button', { name: 'Clear history' }))) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Clear every settled job from history?')
    expect(dialog.textContent).toContain('Queued and running jobs are left alone')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear history' }))
    await waitFor(() => {
      const call = apiMock.calls.find((c) => c.path === '/api/jobs/history/clear')
      expect(call?.method).toBe('POST')
      expect(call?.body).toEqual({})
    })
  })

})
