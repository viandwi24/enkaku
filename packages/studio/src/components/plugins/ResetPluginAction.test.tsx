import { afterEach, describe, expect, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { PluginResetResponse } from '@enkaku/protocol'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type { PluginListRow } from '@/app/plugins/plugin-list'
import { ResetPluginAction } from './ResetPluginAction'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * **Reset data**, from the operator's side.
 *
 * Two claims are worth a rendered test rather than a reading of the source:
 *
 * 1. The confirm names what is at stake BEFORE anything happens — the plugin,
 *    the entry count, and the plugin's own sentence about what its cleanup
 *    handler will do to real devices.
 * 2. A pass that did not fully succeed is **not** wrapped in a success toast.
 *    `blocked` and `reset-with-debts` open a dialog that stays open and says,
 *    in as many words, whether anything was deleted.
 */

function pluginRow(over: Partial<PluginListRow> = {}): PluginListRow {
  return {
    id: 'row-1',
    name: 'proxy-manager',
    title: null,
    description: null,
    version: '0.8.0',
    status: 'active',
    verifiedAt: null,
    verifyError: null,
    verifyErrorCode: null,
    scriptCount: 0,
    declaredScripts: [],
    hasService: true,
    createdBy: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    ...over,
  }
}

/**
 * The reset-handler declaration, which since plan 126 §3.2 arrives with the
 * VERSION rather than on the row: the confirm reads it from
 * `GET /api/plugins/:name/:version` when it opens, so a Plugins tab twenty
 * versions deep no longer carries a service declaration per row to describe a
 * button that renders on one of them.
 */
function versionRoute(resetData: unknown) {
  return {
    '/api/plugins/proxy-manager/0.8.0': {
      status: 200,
      body: {
        plugin: {
          ...pluginRow(),
          manifest: {
            scripts: [],
            service: { permissions: ['device.list'], isolation: 'in-process', listeners: [], events: [], webhooks: [], resetData },
          },
        },
      },
    },
  }
}

const HANDLER = versionRoute({
  permissions: ['device.network.clear'],
  description: 'Turns off the network route on every device this plugin routed.',
})

function response(over: Partial<PluginResetResponse> = {}): PluginResetResponse {
  return {
    plugin: 'proxy-manager',
    status: 'reset',
    handler: { declared: true, ran: true, skipped: null, error: null, items: [], note: null, counts: { cleared: 0, unchanged: 0, pending: 0, failed: 0 } },
    data: { deleted: true, keptBecause: null, entries: 3, global: 2, device: 1, devices: 1 },
    message: 'proxy-manager was reset.',
    ...over,
  }
}

const COUNT = { '/api/plugins/proxy-manager/data/count': { status: 200, body: { global: 2, device: 1 } }, ...HANDLER }

describe('the confirm', () => {
  test("names the plugin, the count, and the plugin's own sentence about what it will touch", async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, COUNT)
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }))

    await waitFor(() => expect(screen.getByText("Reset proxy-manager's data?")).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/3 stored entries \(2 farm-wide, 1 across your devices\)/)).toBeTruthy())
    expect(screen.getByText(/There is no undo/)).toBeTruthy()
    expect(screen.getByText(/Turns off the network route on every device this plugin routed/)).toBeTruthy()
    // The borrowed capability, by name, on the screen where consent is given.
    expect(screen.getByText('device.network.clear')).toBeTruthy()
    // And the rule that decides whether anything is deleted at all.
    expect(screen.getByText(/nothing is deleted/)).toBeTruthy()
  })

  test('a plugin with no cleanup handler says there is nothing to undo, rather than staying silent about it', async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, {
      ...COUNT,
      ...versionRoute(null),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }))
    await waitFor(() => expect(screen.getByText(/declares no cleanup handler/)).toBeTruthy())
  })

  /**
   * Plan 126 §3.2 — the state the lazy read introduced, and the one it would be
   * easiest to get wrong. "Declares no cleanup handler" promises that nothing
   * outside this farm's database is touched; printing it because a request
   * failed would be that promise made on no evidence, on the screen where an
   * operator decides to destroy data.
   */
  test('a version read that fails says so, and never spells it "declares no cleanup handler"', async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, {
      ...COUNT,
      '/api/plugins/proxy-manager/0.8.0': { status: 500, body: { error: { code: 'E_INTERNAL', message: 'boom' } } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }))
    await waitFor(() => expect(screen.getByText(/could not read whether/)).toBeTruthy())
    expect(screen.queryByText(/declares no cleanup handler/)).toBeNull()
    // The confirm is still offered — what actually runs is decided server-side,
    // off the active row's own manifest, not by what this dialog could read.
    expect(screen.getByText("Reset proxy-manager's data?")).toBeTruthy()
  })

  test('nothing is posted until Reset data is confirmed', async () => {
    const { apiMock } = renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, COUNT)
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }))
    await waitFor(() => expect(screen.getByText("Reset proxy-manager's data?")).toBeTruthy())
    expect(apiMock.calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('the result', () => {
  const confirm = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reset data' }))
    await waitFor(() => expect(screen.getByText("Reset proxy-manager's data?")).toBeTruthy())
    // The dialog's own confirm button, which shares its label with the trigger.
    const buttons = screen.getAllByRole('button', { name: 'Reset data' })
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement)
  }

  test('a blocked pass says NOTHING WAS DELETED and lists the failures first', async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, {
      ...COUNT,
      '/api/plugins/proxy-manager/reset': {
        status: 200,
        body: response({
          status: 'blocked',
          handler: {
            declared: true,
            ran: true,
            skipped: null,
            error: null,
            note: null,
            counts: { cleared: 1, unchanged: 0, pending: 0, failed: 1 },
            items: [
              { kind: 'device', id: 's-bad', label: 'Pixel 9', outcome: 'failed', message: 'somebody is driving this phone' },
              { kind: 'device', id: 's-ok', label: 'Pixel 3', outcome: 'cleared', message: 'route off' },
            ],
          },
          data: { deleted: false, keptBecause: 'one cleanup step failed', entries: 0, global: 0, device: 0, devices: 0 },
          message: 'proxy-manager was NOT reset. one cleanup step failed',
        }),
      },
    })
    await confirm()

    await waitFor(() => expect(screen.getByText('proxy-manager was not reset')).toBeTruthy())
    expect(screen.getByText(/Nothing was deleted\. Every entry this plugin stored is still there/)).toBeTruthy()
    expect(screen.getByText('somebody is driving this phone')).toBeTruthy()
    // Order is the server's, and the failure is first.
    const rows = screen.getAllByText(/Pixel [39]/)
    expect(rows[0]?.textContent).toBe('Pixel 9')
  })

  test('a pass with debts is not worded as a plain success', async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, {
      ...COUNT,
      '/api/plugins/proxy-manager/reset': {
        status: 200,
        body: response({
          status: 'reset-with-debts',
          handler: {
            declared: true,
            ran: true,
            skipped: null,
            error: null,
            note: null,
            counts: { cleared: 0, unchanged: 0, pending: 1, failed: 0 },
            items: [{ kind: 'device', id: 's1', label: 'Pixel 1', outcome: 'pending', message: 'the phone was away' }],
          },
          message: 'proxy-manager was reset — but 1 cleanup step is still owed.',
        }),
      },
    })
    await confirm()

    await waitFor(() => expect(screen.getByText('proxy-manager was reset — with 1 still owed')).toBeTruthy())
    expect(screen.getByText('the phone was away')).toBeTruthy()
    expect(screen.getByText(/3 stored entries deleted/)).toBeTruthy()
  })

  test('a handler that could not run is shown with its code, not swallowed', async () => {
    renderWithApi(<ResetPluginAction selected={pluginRow()} onChanged={() => {}} />, {
      ...COUNT,
      '/api/plugins/proxy-manager/reset': {
        status: 200,
        body: response({
          status: 'blocked',
          handler: {
            declared: true,
            ran: false,
            skipped: { code: 'E_PLUGIN_RUNTIME_NOT_RUNNING', message: 'its service is "stopped", so the cleanup cannot run' },
            error: null,
            note: null,
            items: [],
            counts: { cleared: 0, unchanged: 0, pending: 0, failed: 0 },
          },
          data: { deleted: false, keptBecause: 'its service is "stopped"', entries: 0, global: 0, device: 0, devices: 0 },
          message: 'proxy-manager was NOT reset. its service is "stopped"',
        }),
      },
    })
    await confirm()

    await waitFor(() => expect(screen.getByText('E_PLUGIN_RUNTIME_NOT_RUNNING')).toBeTruthy())
    expect(screen.getByText(/so the cleanup cannot run/)).toBeTruthy()
  })
})
