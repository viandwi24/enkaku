import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import '@/lib/test/nav'
import { mockRouter } from '@/lib/test/nav'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { RunScriptDialog, type ScriptRow } from './RunScriptDialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

const script: ScriptRow = {
  id: 'script-1',
  name: 'checkout',
  version: '1.0.0',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
}

const device = {
  id: 'device-1',
  stableId: 'stable-1',
  serial: 'serial-1',
  number: 7,
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

const job = {
  jobId: 'job-1',
  deviceId: 'device-1',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  status: 'queued',
  error: null,
  priority: 0,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
}

describe('RunScriptDialog — smoke render', () => {
  test('closed: no script and no scripts list renders nothing', () => {
    renderWithApi(<RunScriptDialog script={null} devices={[device]} onClose={() => {}} />, {})
    expect(screen.queryByText(/^Run /)).toBeNull()
  })

  test('open on a single script: shows the run dialog for a single device target', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByText('Run checkout')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  /**
   * Plan 124 §4.4, step 124.3 — the locked-device readout. `lockedDevice` is
   * the popup/device-page path where the target is fixed and the script is
   * the question; that one line is the only thing telling the operator which
   * phone the script is about to touch, and it named a model until now. The
   * script `<Select>` above it is deliberately NOT converted here — plan 124
   * §4.5 turns it into a `Combobox` in its own step.
   */
  test('a locked device is named with its number in the "running on" readout', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device]} lockedDevice={device} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByText('running on')).toBeTruthy())
    expect(screen.getByText('#7')).toBeTruthy()
    expect(screen.getByText('Pixel 7')).toBeTruthy()
  })

  test('no scripts published: shows the "nothing published" message', () => {
    renderWithApi(<RunScriptDialog script={null} scripts={[]} devices={[device]} onClose={() => {}} />, {})
    expect(screen.getByText('Nothing is published to this farm yet.')).toBeTruthy()
  })

  test('run: a successful POST /api/jobs navigates to the new job', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/jobs': { body: { job } },
      },
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/jobs/detail?id=job-1'))
  })
})

describe('RunScriptDialog — the collapsed Runtime section (plan 98 §3.9 item 2, §5 step 98.8)', () => {
  test('collapsed by default, and untouched: POST /api/jobs carries no runtimeOverride key', async () => {
    const { apiMock } = renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } }, '/api/jobs': { body: { job } } },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    // Collapsed: the override fields are not in the document at all.
    expect(screen.queryByLabelText('Timeout')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/jobs')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/jobs')
    expect(call?.body).toMatchObject({ scriptId: 'script-1', deviceId: 'device-1' })
    expect((call?.body as Record<string, unknown>).runtimeOverride).toBeUndefined()
  })

  test('expanded and filled: the typed override travels in the POST body', async () => {
    const { apiMock } = renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } }, '/api/jobs': { body: { job } } },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    fireEvent.click(screen.getByText('Runtime'))
    const timeoutField = await screen.findByLabelText('Timeout')
    fireEvent.change(timeoutField, { target: { value: '60000' } })

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/jobs')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/jobs')
    expect((call?.body as { runtimeOverride?: { timeoutMs?: number } } | undefined)?.runtimeOverride).toEqual({ timeoutMs: 60_000 })
  })

  test('switching to a different script clears a previously typed override', async () => {
    renderWithApi(
      <RunScriptDialog script={null} scripts={[script, pluginLogin]} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByText('Runtime')).toBeTruthy())
    fireEvent.click(screen.getByText('Runtime'))
    const timeoutField = await screen.findByLabelText('Timeout')
    fireEvent.change(timeoutField, { target: { value: '60000' } })
    expect((screen.getByLabelText('Timeout') as HTMLInputElement).value).toBe('60000')

    // Pick a different script — the override must not silently ride along.
    // The Runtime section itself is not remounted on a script switch (only
    // the params `SchemaForm` is, keyed on `chosen.id`), so it stays open —
    // this asserts its VALUE was cleared, not merely that the section
    // exists.
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByText('tiktok/login'))
    await waitFor(() => expect((screen.getByLabelText('Timeout') as HTMLInputElement).value).toBe(''))
  })
})

const pluginLogin: ScriptRow = {
  id: 'p-login', name: 'tiktok/login', version: '1.0.0', paramsSchema: null, enabled: true, createdAt: 0, pluginName: 'tiktok',
}
const pluginWarmup: ScriptRow = {
  id: 'p-warmup', name: 'tiktok/warmup', version: '1.0.0', paramsSchema: null, enabled: true, createdAt: 0, pluginName: 'tiktok',
}
const devScript: ScriptRow = {
  id: 'dev:tiktok/login', name: 'tiktok/login-dev', version: '1.0.0+dev.1', paramsSchema: null, enabled: true, createdAt: null, pluginName: 'tiktok', isDev: true,
}

describe('RunScriptDialog — groups by plugin and marks dev entries (plan 82 §4.6, step 13)', () => {
  test('the picker groups tiktok/login and tiktok/warmup under a "tiktok" heading, and a dev entry carries a DEV marker', async () => {
    renderWithApi(
      <RunScriptDialog script={null} scripts={[script, pluginLogin, pluginWarmup, devScript]} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toBeTruthy())
    fireEvent.click(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText('tiktok')).toBeTruthy()) // the group heading
    expect(screen.getByText('tiktok/login')).toBeTruthy()
    expect(screen.getByText('tiktok/warmup')).toBeTruthy()
    expect(screen.getByText('tiktok/login-dev')).toBeTruthy()
    expect(screen.getByText('DEV')).toBeTruthy()
    // A name carrying no plugin is not swallowed into the plugin group (it appears once as
    // the trigger's current value, and once as its own list item).
    expect(screen.getAllByText('checkout').length).toBeGreaterThanOrEqual(1)
  })
})

const scriptWithParams: ScriptRow = {
  ...script,
  paramsSchema: { type: 'object', properties: { videos: { type: 'integer', title: 'Videos', default: 10 } } },
}

describe('RunScriptDialog — named parameter sets (plan 95 §4.7, §4.8, §5 step 95.8)', () => {
  test('a script with params shows the preset picker; applying one fills the form', async () => {
    renderWithApi(
      <RunScriptDialog script={scriptWithParams} devices={[device]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/scripts/checkout/param-sets': {
          body: { items: [{ id: 'set-1', scriptName: 'checkout', name: 'Aggressive', params: { videos: 500 }, createdBy: 'u1', createdAt: 0, updatedAt: 0 }] },
        },
      },
    )
    await waitFor(() => expect(screen.getByText('Preset')).toBeTruthy())
    // Seeded from the schema's own default before any preset is touched.
    await waitFor(() => expect((screen.getByLabelText('Videos') as HTMLInputElement).value).toBe('10'))

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByText('Aggressive'))
    await waitFor(() => expect((screen.getByLabelText('Videos') as HTMLInputElement).value).toBe('500'))
  })

  test('a script with no params shows no preset picker — nothing to save a preset of', async () => {
    renderWithApi(<RunScriptDialog script={script} devices={[device]} onClose={() => {}} />, { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } })
    await waitFor(() => expect(screen.getByText('This script takes no parameters.')).toBeTruthy())
    expect(screen.queryByText('Preset')).toBeNull()
  })
})

/**
 * Plan 99 §3.1, §4.11, step 99.10 — the Workflow | Script segmented filter,
 * the sanctioned `kind === 'workflow'` comparison this file is one of only
 * four places in the repo allowed to make.
 */
const workflow: ScriptRow = {
  id: 'wf-1',
  name: 'my-pipeline',
  version: '1.0.0',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
  kind: 'workflow',
}

const nodeScript: ScriptRow = {
  id: 'node-script-1',
  name: 'tiktok/auto-scroll',
  version: '1.0.0',
  paramsSchema: null,
  enabled: true,
  createdBy: null,
  source: null,
  createdAt: 0,
  kind: 'script',
}

const workflowDetailResponse = {
  script: {
    id: 'wf-1',
    name: 'my-pipeline',
    version: '1.0.0',
    kind: 'workflow',
    paramsSchema: null,
    enabled: true,
    createdBy: null,
    createdAt: 0,
    source: null,
    workflow: {
      schema: 1,
      name: 'my-pipeline',
      version: '1.0.0',
      title: '',
      description: '',
      params: [],
      nodes: [
        { kind: 'script', id: 'scroll1', title: '', script: 'tiktok/auto-scroll@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    },
  },
}

describe('RunScriptDialog — Workflow | Script filter (plan 99 §3.1, §4.11, step 99.10)', () => {
  test('defaults to Script, and switching to Workflow filters the picker to workflow rows only', async () => {
    renderWithApi(
      <RunScriptDialog script={null} scripts={[script, workflow]} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } }, '/api/scripts/wf-1': { body: workflowDetailResponse } },
    )
    // Default filter is Script — the picker preselects the script, not the workflow.
    await waitFor(() => expect(screen.getByText('Run checkout')).toBeTruthy())

    // Radix's `Tabs.Trigger` activates on `mousedown` (not `click` —
    // `@radix-ui/react-tabs`'s own `TabsTrigger`), so `fireEvent.click`
    // alone never fires it; a real click's `mousedown` is what a browser
    // (or `userEvent.click`) sends first.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Workflow' }))
    await waitFor(() => expect(screen.getByText('Run my-pipeline')).toBeTruthy())
    // The plain script is gone from the picker's own dropdown once filtered.
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByText('checkout')).toBeNull()
  })

  test('Workflow with none published shows the empty state and a link to the editor', async () => {
    renderWithApi(
      <RunScriptDialog script={null} scripts={[script]} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Workflow' })).toBeTruthy())
    // Radix's `Tabs.Trigger` activates on `mousedown` (not `click` —
    // `@radix-ui/react-tabs`'s own `TabsTrigger`), so `fireEvent.click`
    // alone never fires it; a real click's `mousedown` is what a browser
    // (or `userEvent.click`) sends first.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Workflow' }))
    await waitFor(() => expect(screen.getByText('No workflow is published to this farm yet.')).toBeTruthy())
    const link = screen.getByRole('link', { name: 'Open the workflow editor' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/workflows/editor')
  })

  test('nothing published at all (any kind) keeps the original generic message, with no filter to show', () => {
    renderWithApi(<RunScriptDialog script={null} scripts={[]} devices={[device]} onClose={() => {}} />, {})
    expect(screen.getByText('Nothing is published to this farm yet.')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Workflow' })).toBeNull()
  })

  test('the duration estimate sums a workflow node\'s own declared timeout ("up to about")', async () => {
    renderWithApi(
      <RunScriptDialog script={null} scripts={[script, workflow, nodeScript]} devices={[device]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/scripts/wf-1': { body: workflowDetailResponse },
        '/api/scripts/node-script-1': { body: { script: { runtime: { timeoutMs: 600_000 } } } },
      },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Workflow' }))
    await waitFor(() => expect(screen.getByText('1 node, up to about 10 min per device.')).toBeTruthy())
  })
})

/**
 * Plan 94 §3.6, §4.10, §9 Q4, step 94.10 — the Repeat section: the
 * comprehension test itself ("pause between actions" vs "interval between
 * repeats" must read as two different things from this dialog alone), the
 * finish-time estimate built off the SAME numbers as the pacer, the
 * continuous-duty warning, and the fleet-wide typed confirmation.
 */
const device2 = { ...device, id: 'device-2', stableId: 'stable-2', label: 'Pixel 8' }

const batch = {
  id: 'batch-1',
  status: 'queued',
  scriptId: 'script-1',
  scriptName: 'checkout',
  scriptVersion: '1.0.0',
  clusterId: null,
  concurrency: 0,
  order: 'as-listed',
  createdAt: 0,
  counts: { total: 2, success: 0, failed: 0, failedInfra: 0, failedScript: 0, cancelled: 0 },
  pacing: null,
  repeats: [],
}

describe('RunScriptDialog — Repeat section (plan 94 §3.6, §4.10, step 94.10)', () => {
  test('the section names the pause-between-actions setting as a DIFFERENT knob, living on the device', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    // The comprehension test itself: the Repeat section's own copy must
    // point at the OTHER knob by its real location, not just say "different".
    await waitFor(() => expect(screen.getByText(/Human-like touch/)).toBeTruthy())
    expect(screen.getByText(/pause BETWEEN ACTIONS inside one run/)).toBeTruthy()
  })

  test('a real repeat draft extends the consequence sentence with count, interval, stagger and a finish estimate', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))

    fireEvent.change(screen.getByLabelText('Repetitions'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Interval minimum (seconds)'), { target: { value: '180' } })
    fireEvent.change(screen.getByLabelText('Interval maximum (seconds)'), { target: { value: '480' } })
    fireEvent.change(screen.getByLabelText('Stagger across devices (s)'), { target: { value: '30' } })

    // "× 20 repeats, 3–8 min apart, started 30 s apart — about ..., finishing around ..." —
    // built from the exact same three numbers just typed, never a re-derivation.
    await waitFor(() => expect(screen.getByText(/× 20 repeats, 3–8 min apart, started 30 s apart/)).toBeTruthy())
    expect(screen.getByText(/finishing around/)).toBeTruthy()
  })

  test('leaving Repeat at its default (1 repetition) reproduces the plain consequence sentence unchanged', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    await waitFor(() => expect(screen.getByText(/2 devices, all at once\./)).toBeTruthy())
  })

  test('an unpaced multi-device run sends no `pacing` key at all', async () => {
    const { apiMock } = renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/batches': { body: { batch } },
      },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    // Both devices = every usable device = fleet-wide (§9 Q4) — the typed
    // confirmation gates Run regardless of pacing.
    fireEvent.change(await screen.findByLabelText('Type the device count to confirm'), { target: { value: '2' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Run batch' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/batches')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/batches')
    expect((call?.body as Record<string, unknown>).pacing).toBeUndefined()
  })

  test('setting repetitions > 1 sends a `pacing` block on the batch POST', async () => {
    const { apiMock } = renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      {
        '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } },
        '/api/batches': { body: { batch } },
      },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    fireEvent.change(screen.getByLabelText('Repetitions'), { target: { value: '20' } })
    fireEvent.change(await screen.findByLabelText('Type the device count to confirm'), { target: { value: '2' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Run batch' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/batches')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/batches')
    const body = call?.body as { pacing?: { count: number; intervalMs: [number, number]; deviceIntervalMs: number } }
    expect(body.pacing).toEqual({ count: 20, intervalMs: [0, 0], deviceIntervalMs: 0 })
  })

  test('a single device with repetitions > 1 creates a batch, not a plain job', async () => {
    const { apiMock } = renderWithApi(
      <RunScriptDialog script={script} devices={[device]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } }, '/api/batches': { body: { batch } } },
    )
    await waitFor(() => expect(screen.getByLabelText('Repetitions')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Repetitions'), { target: { value: '5' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Run batch' }))
    await waitFor(() => expect(apiMock.calls.some((c) => c.path === '/api/batches')).toBe(true))
    const call = apiMock.calls.find((c) => c.path === '/api/batches')
    expect((call?.body as { target?: { deviceIds?: string[] } }).target).toEqual({ deviceIds: ['device-1'] })
  })

  test('an inverted interval (min > max) disables Run', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    fireEvent.change(screen.getByLabelText('Interval minimum (seconds)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Interval maximum (seconds)'), { target: { value: '5' } })
    await waitFor(() => expect(screen.getByText("The interval's minimum is greater than its maximum.")).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('targeting every usable device requires typing the device count before Run is enabled', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 8'))
    await waitFor(() => expect(screen.getByText('This targets every usable device on the farm')).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Type the device count to confirm'), { target: { value: '2' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(false))
  })

  test('a partial (non-fleet-wide) pick shows no typed confirmation', async () => {
    renderWithApi(
      <RunScriptDialog script={script} devices={[device, device2]} onClose={() => {}} />,
      { '/api/clusters*': { body: { items: [], nextCursor: null, total: 0 } } },
    )
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Multiple devices' }))
    fireEvent.click(await screen.findByText('Pixel 7'))
    expect(screen.queryByText('This targets every usable device on the farm')).toBeNull()
    expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
