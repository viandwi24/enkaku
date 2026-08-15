import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { ScheduleEditorDialog, type ScheduleRow } from './ScheduleEditorDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const schedule: ScheduleRow = {
  id: 'sched-1',
  name: 'Nightly smoke',
  enabled: true,
  cron: '0 2 * * *',
  timezone: 'UTC',
  target: { kind: 'script', ref: 'checkout@latest' },
  scriptRef: 'checkout@latest',
  params: null,
  clusterId: null,
  deviceIds: ['device-1'],
  concurrency: 0,
  order: 'as-listed',
  onOverlap: 'skip',
  queueTimeoutSec: null,
  catchUp: 'skip',
  jitterSec: 0,
  priority: 0,
  threadMode: 'new',
  threadId: null,
  onApprovalRequired: 'deny',
  lastFiredAt: null,
  lastBatchId: null,
  lastAgentRunId: null,
  createdBy: null,
  createdAt: 0,
  nextFireAt: null,
}

const device = {
  id: 'device-1',
  stableId: 'stable-1',
  serial: 'serial-1',
  label: 'Pixel 7',
  androidVersion: '14',
  apiLevel: 34,
  screenW: 1080,
  screenH: 2400,
  density: 420,
  status: 'online',
  lastSeen: 0,
  tags: [],
  cluster: null,
}

function baseResponses(validateBody: unknown = { valid: true, nextFires: [1000] }) {
  return {
    '/api/scripts*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
    '/api/agents': { body: { agents: [] } },
    '/api/schedules/validate': { body: validateBody },
  }
}

describe('ScheduleEditorDialog — smoke render', () => {
  test('new: renders the create form with its default cron', async () => {
    renderWithApi(<ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    expect(screen.getByText('New schedule')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create schedule' })).toBeTruthy())
  })

  test('edit: seeds the fields from the given schedule', async () => {
    renderWithApi(<ScheduleEditorDialog schedule={schedule} devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    await waitFor(() => expect(screen.getByDisplayValue('Nightly smoke')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })

  test('closed: renders nothing', () => {
    renderWithApi(<ScheduleEditorDialog schedule={null} devices={[device]} onClose={() => {}} onSaved={() => {}} />, {})
    expect(screen.queryByText('New schedule')).toBeNull()
  })

  test('an invalid cron: the preview shows the named error, not a crash', async () => {
    renderWithApi(
      <ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      baseResponses({ valid: false, nextFires: [], error: 'bad cron expression' }),
    )
    await waitFor(() => expect(screen.getByText('bad cron expression')).toBeTruthy())
  })

  test('save: a successful PATCH calls onSaved and onClose', async () => {
    let saved = false
    let closed = false
    renderWithApi(
      <ScheduleEditorDialog
        schedule={schedule}
        devices={[device]}
        onClose={() => {
          closed = true
        }}
        onSaved={() => {
          saved = true
        }}
      />,
      { ...baseResponses(), '/api/schedules/sched-1': { body: { schedule, resolvesTo: null } } },
    )
    // `canSubmit` only flips true once the debounced cron preview resolves
    // (300ms) — waiting for the button to stop being disabled, not merely
    // to exist, is what makes the click below actually fire. (`toBeDisabled()`
    // is not wired up for this workspace's `bun:test` — a plain property
    // read is what actually reflects the live DOM node on every poll.)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(saved).toBe(true))
    expect(closed).toBe(true)
  })
})

/**
 * Plan 94 §3.6, §4.9, §4.10, step 94.10 — the Repeat section is now
 * FUNCTIONAL (94.9 shipped the schedule-level pacing columns and their
 * pass-through into `createBatch` while this step was in progress): the
 * comprehension distinction from Jitter, hydration from an existing
 * schedule's own pacing, and the seconds→milliseconds conversion on save.
 */
describe('ScheduleEditorDialog — Repeat section (plan 94 §3.6, §4.9, §4.10, step 94.10)', () => {
  test('names Jitter and the Repeat interval as two different knobs', async () => {
    renderWithApi(<ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    await waitFor(() => expect(screen.getByText('Repeat')).toBeTruthy())
    expect(screen.getByText(/shifts the WHOLE firing's own start time, once/)).toBeTruthy()
    expect(screen.getByText(/a different knob from Jitter above/)).toBeTruthy()
  })

  test('a schedule with existing pacing hydrates the fields in seconds', async () => {
    const pacedSchedule: ScheduleRow = {
      ...schedule,
      repeatCount: 5,
      intervalMinMs: 180_000,
      intervalMaxMs: 480_000,
      deviceIntervalMs: 30_000,
    }
    renderWithApi(<ScheduleEditorDialog schedule={pacedSchedule} devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    await waitFor(() => expect((screen.getByLabelText('Repetitions') as HTMLInputElement).value).toBe('5'))
    expect((screen.getByLabelText('Repeat interval minimum (seconds)') as HTMLInputElement).value).toBe('180')
    expect((screen.getByLabelText('Repeat interval maximum (seconds)') as HTMLInputElement).value).toBe('480')
    expect((screen.getByLabelText('Stagger across devices (s)') as HTMLInputElement).value).toBe('30')
  })

  test('an inverted interval blocks Save', async () => {
    renderWithApi(<ScheduleEditorDialog schedule={schedule} devices={[device]} onClose={() => {}} onSaved={() => {}} />, baseResponses())
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.change(screen.getByLabelText('Repeat interval minimum (seconds)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Repeat interval maximum (seconds)'), { target: { value: '5' } })
    await waitFor(() => expect(screen.getByText("The interval's minimum is greater than its maximum.")).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('setting repetitions sends repeatCount/intervalMinMs/intervalMaxMs/deviceIntervalMs on the PATCH body', async () => {
    const { apiMock } = renderWithApi(
      <ScheduleEditorDialog schedule={schedule} devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      { ...baseResponses(), '/api/schedules/sched-1': { body: { schedule, resolvesTo: null } } },
    )
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.change(screen.getByLabelText('Repetitions'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Repeat interval minimum (seconds)'), { target: { value: '180' } })
    fireEvent.change(screen.getByLabelText('Repeat interval maximum (seconds)'), { target: { value: '480' } })
    fireEvent.change(screen.getByLabelText('Stagger across devices (s)'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/schedules/sched-1')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/schedules/sched-1')
    expect(call?.body).toMatchObject({ repeatCount: 5, intervalMinMs: 180_000, intervalMaxMs: 480_000, deviceIntervalMs: 30_000 })
  })
})

/**
 * Plan 95 §4.4, §5 step 95.7 — the editor is an ATTENDED caller: it never
 * refuses to open or blocks the whole dialog the way an unattended firing
 * does. It shows the findings and, for the non-blocking ones only, offers a
 * one-click way to accept the reconciled defaults.
 */
describe('ScheduleEditorDialog — reconciliation findings (plan 95 §4.4, §5 step 95.7)', () => {
  test('a missing required field (no default) is listed as a finding and highlighted on the form, without refusing to open', async () => {
    const scheduleWithParams: ScheduleRow = { ...schedule, params: { videos: 30 } }
    renderWithApi(
      <ScheduleEditorDialog schedule={scheduleWithParams} devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      {
        ...baseResponses(),
        '/api/scripts*': {
          body: {
            items: [
              {
                id: 'checkout-1.1.0',
                name: 'checkout',
                version: '1.1.0',
                kind: 'script',
                enabled: true,
                createdAt: 1000,
                hasResult: false,
                paramsSchema: { type: 'object', properties: { videos: { type: 'number' }, region: { type: 'string' } }, required: ['videos', 'region'] },
              },
            ],
            nextCursor: null,
            total: 1,
          },
        },
      },
    )
    await waitFor(() => expect(screen.getByText(/no longer match this version.s schema/)).toBeTruthy())
    expect(screen.getByText('region')).toBeTruthy()
    // The dialog still opens and still offers Save — an attended caller is not stopped (§4.4).
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })

  test('a non-blocking finding (a tightened bound with a default) offers "fill from the new version\'s defaults", which clears the finding once applied', async () => {
    const scheduleWithParams: ScheduleRow = { ...schedule, params: { chance: 5 } }
    renderWithApi(
      <ScheduleEditorDialog schedule={scheduleWithParams} devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      {
        ...baseResponses(),
        '/api/scripts*': {
          body: {
            items: [
              {
                id: 'checkout-1.1.0',
                name: 'checkout',
                version: '1.1.0',
                kind: 'script',
                enabled: true,
                createdAt: 1000,
                hasResult: false,
                paramsSchema: { type: 'object', properties: { chance: { type: 'number', minimum: 0, maximum: 1, default: 0.5 } } },
              },
            ],
            nextCursor: null,
            total: 1,
          },
        },
      },
    )
    const fillButton = await screen.findByRole('button', { name: /Fill from the new version.s defaults/ })
    fireEvent.click(fillButton)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Fill from the new version.s defaults/ })).toBeNull())
  })

  test('no findings for an ordinary, unchanged schema: no panel, no highlighted fields', async () => {
    const scheduleWithParams: ScheduleRow = { ...schedule, params: { videos: 30 } }
    renderWithApi(
      <ScheduleEditorDialog schedule={scheduleWithParams} devices={[device]} onClose={() => {}} onSaved={() => {}} />,
      {
        ...baseResponses(),
        '/api/scripts*': {
          body: {
            items: [
              { id: 'checkout-1.1.0', name: 'checkout', version: '1.1.0', kind: 'script', enabled: true, createdAt: 1000, hasResult: false, paramsSchema: { type: 'object', properties: { videos: { type: 'number' } } } },
            ],
            nextCursor: null,
            total: 1,
          },
        },
      },
    )
    await waitFor(() => expect(screen.getByDisplayValue('Nightly smoke')).toBeTruthy())
    expect(screen.queryByText(/no longer match this version.s schema/)).toBeNull()
  })
})

/**
 * The design decision the whole step is about (plan 95 §5 step 95.8, and the
 * task's own instruction to write a test that would FAIL if a reference were
 * stored instead): applying a preset here fills `params` with a plain,
 * reconciled COPY — never a `paramSetId` — so what gets POSTed to
 * `/api/schedules` is exactly what a hand-typed value would have been. The
 * durable, no-mock-required version of this guarantee lives in
 * `packages/core/src/scripts/param-sets.test.ts`'s own describe block of the
 * same name; this one proves the UI wiring reaches that same plain value.
 */
describe('ScheduleEditorDialog — named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8)', () => {
  function responsesWithPreset() {
    return {
      // Listed BEFORE `/api/scripts*` on purpose: `installApiMock`'s matcher
      // takes the FIRST key (in object insertion order) whose pattern
      // matches, and `/api/scripts*`'s own wildcard also matches this exact
      // nested path — `/api/scripts` immediately followed by anything. Put
      // the specific path second and the paginated scripts LIST silently
      // answers the preset fetch instead, which fails `ParamSetListResponseSchema`
      // parsing and is swallowed by `ParamSetPicker`'s own `.catch(() => setSets([]))`.
      '/api/scripts/checkout/param-sets': {
        body: { items: [{ id: 'set-1', scriptName: 'checkout', name: 'Aggressive', params: { videos: 500 }, createdBy: 'u1', createdAt: 0, updatedAt: 0 }] },
      },
      ...baseResponses(),
      '/api/scripts*': {
        body: {
          items: [
            { id: 'checkout-1.1.0', name: 'checkout', version: '1.1.0', kind: 'script', enabled: true, createdAt: 1000, hasResult: false, paramsSchema: { type: 'object', properties: { videos: { type: 'integer', title: 'Videos' } } } },
          ],
          nextCursor: null,
          total: 1,
        },
      },
    }
  }

  test('picking a script with params shows the preset picker; applying one fills the form', async () => {
    renderWithApi(<ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />, responsesWithPreset())
    await waitFor(() => expect(screen.getByText('New schedule')).toBeTruthy())

    const scriptTrigger = screen.getAllByRole('combobox')[0]!
    fireEvent.click(scriptTrigger)
    fireEvent.click(await screen.findByText('checkout'))
    await waitFor(() => expect(screen.getByText('Preset')).toBeTruthy())

    const presetRow = screen.getByText('Preset').closest('div')!
    // Wait for the preset FETCH to actually settle (the placeholder flips
    // from "No presets saved yet" once `sets` has loaded) before opening the
    // dropdown — opening it while still empty is a real race, not a fixture
    // of this component under test.
    await waitFor(() => expect(within(presetRow).getByText('Pick a preset')).toBeTruthy())
    fireEvent.click(within(presetRow).getByRole('combobox'))
    fireEvent.click(await screen.findByText('Aggressive'))
    await waitFor(() => expect((screen.getByLabelText('Videos') as HTMLInputElement).value).toBe('500'))
  })

  test('creating a schedule from a preset POSTs the RECONCILED VALUE, not a reference to the preset', async () => {
    const responses = {
      ...responsesWithPreset(),
      // `target` defaults to 'cluster' — supplying one here means the flow
      // needs no interaction with the Target tabs at all, keeping this test
      // scoped to the preset wiring it actually exists to prove.
      '/api/clusters*': { body: { items: [{ id: 'c1', name: 'Pool A', usableCount: 3 }], nextCursor: null, total: 1 } },
      '/api/schedules': (req: { method: string; body: unknown }) =>
        req.method === 'POST'
          ? { status: 201, body: { schedule: { ...schedule, id: 'sched-new' } } }
          : { status: 404, body: { error: { code: 'E_NOT_FOUND', message: 'unexpected' } } },
    }
    const { apiMock } = renderWithApi(<ScheduleEditorDialog schedule="new" devices={[device]} onClose={() => {}} onSaved={() => {}} />, responses)
    await waitFor(() => expect(screen.getByText('New schedule')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Nightly smoke run'), { target: { value: 'From a preset' } })
    fireEvent.click(screen.getAllByRole('combobox')[0]!)
    fireEvent.click(await screen.findByText('checkout'))
    await waitFor(() => expect(screen.getByText('Preset')).toBeTruthy())
    const presetRow = screen.getByText('Preset').closest('div')!
    await waitFor(() => expect(within(presetRow).getByText('Pick a preset')).toBeTruthy())
    fireEvent.click(within(presetRow).getByRole('combobox'))
    fireEvent.click(await screen.findByText('Aggressive'))
    await waitFor(() => expect((screen.getByLabelText('Videos') as HTMLInputElement).value).toBe('500'))

    fireEvent.click(await screen.findByText('Pick a cluster'))
    fireEvent.click(await screen.findByText('Pool A'))

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Create schedule' }) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }))

    await waitFor(() => expect(apiMock.calls.some((c) => c.method === 'POST' && c.path === '/api/schedules')).toBe(true))
    const post = apiMock.calls.find((c) => c.method === 'POST' && c.path === '/api/schedules')!
    const body = post.body as { workTarget: { params: unknown } }
    // A plain, reconciled copy — never `{ paramSetId: 'set-1' }` or anything
    // that could re-resolve later against an edited preset.
    expect(body.workTarget.params).toEqual({ videos: 500 })
  })
})
