import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { TooltipProvider } from '@enkaku/ui'
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
