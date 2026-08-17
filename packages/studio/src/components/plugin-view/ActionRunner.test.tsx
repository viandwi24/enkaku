import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { ActionSpecSchema, type ActionSpec } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { PluginViewRow } from './rows'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

// Toast copy is asserted from the spy rather than the DOM — the same
// convention `AdmitDeviceDialog.test.tsx` established, and the only way to
// see a failure toast at all, since `Toaster` is mounted by the app shell.
const toastSuccess = mock(() => {})
const toastError = mock((_message: string, _opts?: { description?: string }) => {})
mock.module('sonner', () => ({ toast: { success: toastSuccess, error: toastError, warning: () => {} } }))

const { ActionRunner } = await import('./ActionRunner')

afterEach(cleanup)

/**
 * Plan 108 §3.4, §5 step 108.7 — the load-bearing assertion in this file is
 * the one about `{{`: `confirm` is a plain sentence and is NEVER interpolated
 * (§3.4, and the retraction comment on the plan's own worked example in
 * §4.3). What names the target is `ActionRunner` itself, from facts it
 * already holds — which is what `docs/design.md`'s "a confirm dialog must
 * name the thing at stake" asks for, reached without a second, weaker
 * templating path beside the bindings.
 */

function action(spec: unknown): ActionSpec {
  return ActionSpecSchema.parse(spec)
}

const ROW: PluginViewRow = {
  id: 'SER1#0',
  value: { username: 'alice', position: 1, current: true },
  device: { id: 'dev-1', stableId: 'SER1', label: 'Pixel 7', status: 'online', clusterId: null, number: 12 },
  entry: { key: 'accounts', version: 3, updatedAt: 1_700_000_000 },
}

const SWITCH_TO = action({
  kind: 'job',
  label: 'Switch to this account',
  script: 'tiktok/switch-account@latest',
  device: 'row',
  params: { target: { $row: 'username' } },
  confirm: 'Switch this device to the selected account?',
})

const ACTION_PATH = '/api/plugins/tiktok/action/switchTo'

function jobResponse() {
  return { body: { plugin: 'tiktok', actionId: 'switchTo', result: { kind: 'job', jobId: 'job-1', deviceId: 'dev-1', scriptId: 'script-1' } } }
}

function renderRunner(
  overrides: {
    action?: ActionSpec
    actionId?: string
    row?: PluginViewRow | null
    selectedDeviceIds?: string[]
    onDone?: () => void
    onClose?: () => void
  } = {},
  responses: Parameters<typeof renderWithApi>[1] = { [ACTION_PATH]: jobResponse() },
) {
  return renderWithApi(
    <ActionRunner
      plugin="tiktok"
      rowKey="username"
      invocation={{
        actionId: overrides.actionId ?? 'switchTo',
        action: overrides.action ?? SWITCH_TO,
        row: overrides.row === undefined ? ROW : overrides.row,
        selectedDeviceIds: overrides.selectedDeviceIds ?? [],
      }}
      onClose={overrides.onClose ?? (() => {})}
      onDone={overrides.onDone ?? (() => {})}
    />,
    responses,
  )
}

describe('ActionRunner — the confirmation names the target, and is never a template', () => {
  test('a row action names the row (by the view’s rowKey) and the device', async () => {
    renderRunner()
    await waitFor(() => expect(screen.getByText('Switch to this account — alice on Pixel 7?')).toBeTruthy())
    // The row's own value and the device label, both present in the body too.
    expect(screen.getByText('alice on Pixel 7')).toBeTruthy()
  })

  test('the author’s `confirm` sentence is rendered verbatim, beneath the named target', async () => {
    renderRunner()
    await waitFor(() => expect(screen.getByText('Switch this device to the selected account?')).toBeTruthy())
  })

  test('nothing rendered anywhere contains `{{` — there is no interpolation path at all', async () => {
    const templated = action({ ...SWITCH_TO, confirm: 'Switch to @{{username}}?' })
    renderRunner({ action: templated })
    await waitFor(() => expect(screen.getByText('Switch to this account — alice on Pixel 7?')).toBeTruthy())
    // The braces survive as literal text — proof they were never a template
    // — and the *named* target came from the row instead.
    expect(document.body.textContent).toContain('Switch to @{{username}}?')
    expect(screen.getByText('Switch to this account — alice on Pixel 7?').textContent).not.toContain('{{')
  })

  test('a device with no label falls back to the stable id rather than saying nothing', async () => {
    renderRunner({ row: { ...ROW, device: { ...ROW.device!, label: null } } })
    await waitFor(() => expect(screen.getByText('Switch to this account — alice on SER1?')).toBeTruthy())
  })

  test('confirming POSTs the row verbatim, with $device and $entry alongside its own fields', async () => {
    const onDone = mock(() => {})
    const { apiMock } = renderRunner({ onDone })
    await waitFor(() => expect(screen.getByText('Switch this device to the selected account?')).toBeTruthy())
    fireEvent.click(screen.getByText('Switch to this account', { selector: 'button' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = apiMock.calls.find((c) => c.path === ACTION_PATH)
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({
      row: {
        username: 'alice',
        position: 1,
        current: true,
        $device: { id: 'dev-1', stableId: 'SER1', label: 'Pixel 7', status: 'online', clusterId: null, number: 12 },
        $entry: { key: 'accounts', version: 3, updatedAt: 1_700_000_000 },
      },
    })
    // Never `params`, never `script`, never `scope` — the browser chooses
    // WHICH declared action to run and over which row, nothing more.
    expect(Object.keys(call?.body as object)).toEqual(['row'])
  })
})

describe('ActionRunner — the form path', () => {
  const RENAME = action({
    kind: 'form',
    label: 'Rename account',
    schema: { type: 'object', properties: { note: { type: 'string', title: 'Note' } } },
    prefill: { note: { $row: 'username' } },
    submitLabel: 'Save',
    then: { kind: 'kv.set', label: 'Rename account', scope: 'device', key: { $literal: 'note' }, value: { $form: 'note' } },
  })

  test('a form action opens SchemaForm on its schema, prefilled from `prefill`', async () => {
    renderRunner({ action: RENAME, actionId: 'rename' }, {})
    await waitFor(() => expect(screen.getByText('Note')).toBeTruthy())
    const input = document.querySelector('input, textarea') as HTMLInputElement
    expect(input.value).toBe('alice')
  })

  test('the form’s own submit label is used, then the confirmation names the target', async () => {
    renderRunner({ action: RENAME, actionId: 'rename' }, {})
    await waitFor(() => expect(screen.getByText('Save')).toBeTruthy())
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('Rename account — alice on Pixel 7?')).toBeTruthy())
  })

  test('the collected values are POSTed as `form`, beside the row', async () => {
    const onDone = mock(() => {})
    const { apiMock } = renderRunner(
      { action: RENAME, actionId: 'rename', onDone },
      { '/api/plugins/tiktok/action/rename': { body: { plugin: 'tiktok', actionId: 'rename', result: { kind: 'kv.set', scope: 'device', stableId: 'SER1', key: 'note' } } } },
    )
    await waitFor(() => expect(screen.getByText('Save')).toBeTruthy())
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByText('Rename account — alice on Pixel 7?')).toBeTruthy())
    fireEvent.click(screen.getByText('Rename account', { selector: 'button' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const call = apiMock.calls.find((c) => c.path === '/api/plugins/tiktok/action/rename')
    expect((call?.body as { form: unknown }).form).toEqual({ note: 'alice' })
  })
})

describe('ActionRunner — the target path', () => {
  const SYNC = action({ kind: 'batch', label: 'Sync accounts', script: 'tiktok/list-accounts@latest', target: 'picker', confirm: 'Read the switch-account sheet on each device?' })
  function device(id: string, stableId: string, label: string) {
    return {
      id,
      stableId,
      serial: stableId,
      label,
      androidVersion: null,
      apiLevel: null,
      screenW: null,
      screenH: null,
      density: null,
      status: 'idle',
      lastSeen: null,
      tags: [],
      cluster: null,
      lastCrashAt: null,
      readiness: { desired: 'awake', actual: 'awake', blocked: null, since: 0 },
    }
  }
  // Three devices, deliberately: picking TWO of three exercises the count
  // without tripping `useTargetSelection`'s fleet-wide gate, which is a
  // separate mechanism with its own tests and would otherwise silently keep
  // this dialog's Continue button disabled.
  const DEVICES = { items: [device('dev-1', 'SER1', 'Pixel 7'), device('dev-2', 'SER2', 'Pixel 4a'), device('dev-3', 'SER3', 'Pixel 6')], nextCursor: null, total: 3 }

  test('a picker target opens TargetPicker over the real device list', async () => {
    renderRunner({ action: SYNC, actionId: 'sync', row: null }, { '/api/devices*': { body: DEVICES } })
    await waitFor(() => expect(screen.getByText('Devices')).toBeTruthy())
    expect(screen.getByText('Targets 0 devices')).toBeTruthy()
  })

  test('a batch confirmation names the RESOLVED device count, which is why confirm comes last', async () => {
    const onDone = mock(() => {})
    const { apiMock } = renderRunner(
      { action: SYNC, actionId: 'sync', row: null, selectedDeviceIds: [], onDone },
      {
        '/api/devices*': { body: DEVICES },
        '/api/plugins/tiktok/action/sync': { body: { plugin: 'tiktok', actionId: 'sync', result: { kind: 'batch', batchId: 'batch-1', scriptId: 'script-1', jobCount: 2 } } },
      },
    )
    await waitFor(() => expect(screen.getByText('Devices')).toBeTruthy())

    // Pick both devices through the picker's own multi-select.
    fireEvent.click(screen.getByText('Pixel 7'))
    fireEvent.click(screen.getByText('Pixel 4a'))
    await waitFor(() => expect(screen.getByText('Targets 2 devices')).toBeTruthy())

    fireEvent.click(screen.getByText('Continue'))
    await waitFor(() => expect(screen.getByText('Sync accounts — 2 devices?')).toBeTruthy())
    fireEvent.click(screen.getByText('Sync accounts', { selector: 'button' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect((apiMock.calls.find((c) => c.path === '/api/plugins/tiktok/action/sync')?.body as { deviceIds: string[] }).deviceIds).toEqual(['dev-1', 'dev-2'])
  })

  test('target: "all" states its resolved count before submitting, and sends no deviceIds', async () => {
    const all = action({ kind: 'batch', label: 'Sync every device', script: 'tiktok/list-accounts@latest', target: 'all' })
    const onDone = mock(() => {})
    const { apiMock } = renderRunner(
      { action: all, actionId: 'syncAll', row: null, onDone },
      {
        '/api/devices*': { body: DEVICES },
        '/api/plugins/tiktok/action/syncAll': { body: { plugin: 'tiktok', actionId: 'syncAll', result: { kind: 'batch', batchId: 'batch-2', scriptId: 'script-1', jobCount: 2 } } },
      },
    )
    await waitFor(() => expect(screen.getByText('Sync every device — every enrolled device (3)?')).toBeTruthy())
    fireEvent.click(screen.getByText('Sync every device', { selector: 'button' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(apiMock.calls.find((c) => c.path === '/api/plugins/tiktok/action/syncAll')?.body).toEqual({})
  })

  test('a selection target sends the table’s own selection, with no picker in between', async () => {
    const bulk = action({ kind: 'batch', label: 'Refresh selected', script: 'tiktok/list-accounts@latest', target: 'selection' })
    const onDone = mock(() => {})
    const { apiMock } = renderRunner(
      { action: bulk, actionId: 'bulk', row: null, selectedDeviceIds: ['dev-1', 'dev-2'], onDone },
      { '/api/plugins/tiktok/action/bulk': { body: { plugin: 'tiktok', actionId: 'bulk', result: { kind: 'batch', batchId: 'batch-3', scriptId: 'script-1', jobCount: 2 } } } },
    )
    await waitFor(() => expect(screen.getByText('Refresh selected — 2 devices?')).toBeTruthy())
    fireEvent.click(screen.getByText('Refresh selected', { selector: 'button' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect((apiMock.calls.find((c) => c.path === '/api/plugins/tiktok/action/bulk')?.body as { deviceIds: string[] }).deviceIds).toEqual(['dev-1', 'dev-2'])
  })
})

describe('ActionRunner — failure', () => {
  test('a refused action toasts the server’s own message and does NOT refresh the table', async () => {
    toastError.mockClear()
    const onDone = mock(() => {})
    renderRunner({ onDone }, { [ACTION_PATH]: { status: 404, body: { error: { code: 'script_not_found', message: 'no script named tiktok/switch-account' } } } })
    await waitFor(() => expect(screen.getByText('Switch this device to the selected account?')).toBeTruthy())
    fireEvent.click(screen.getByText('Switch to this account', { selector: 'button' }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    const [message, opts] = toastError.mock.calls[0] as [string, { description?: string }]
    expect(message).toContain('Could not run')
    expect(message).toContain('Switch to this account')
    expect(opts?.description).toBe('no script named tiktok/switch-account')
    expect(onDone).not.toHaveBeenCalled()
  })

  test('a forbidden action is reworded for a person, not left as a permission name', async () => {
    toastError.mockClear()
    renderRunner({}, { [ACTION_PATH]: { status: 403, body: { error: { code: 'auth.forbidden', message: 'requires the job.run permission' } } } })
    await waitFor(() => expect(screen.getByText('Switch this device to the selected account?')).toBeTruthy())
    fireEvent.click(screen.getByText('Switch to this account', { selector: 'button' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect((toastError.mock.calls[0] as [string, { description?: string }])[1]?.description).toBe('Your role does not allow this — ask an admin.')
  })

  test('a successful run toasts the verb the action produced', async () => {
    toastSuccess.mockClear()
    const onDone = mock(() => {})
    renderRunner({ onDone })
    await waitFor(() => expect(screen.getByText('Switch this device to the selected account?')).toBeTruthy())
    fireEvent.click(screen.getByText('Switch to this account', { selector: 'button' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Job created'))
  })
})
