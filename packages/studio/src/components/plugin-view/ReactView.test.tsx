import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { cleanup, renderWithApi } from '@/lib/test/render'
import type {
  PluginHost,
  PluginViewFailure,
  PluginViewFailureKind,
  PluginViewProps,
  PluginViewRequest,
  PluginViewResult,
} from '@/lib/plugin-host'
import { ReactView } from './ReactView'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

afterEach(cleanup)

/**
 * Plan 111 §5 step 111.3, criteria 1 and 6 — `ReactView`'s three states, plus
 * the fourth one nothing else can produce: a component that throws while
 * RENDERING, which `loadView` cannot see because it had already handed the
 * component over successfully.
 *
 * Every test drives an injected host. The real one injects a `<script
 * type="module">` and waits for a browser to evaluate it, and none of that
 * happens under `happy-dom` — `plugin-host.test.ts` covers the registry, the
 * import map and the three failure paths against its own DOM seam. What is
 * left for this file is what `ReactView` alone owns: which state it renders,
 * what the operator reads in each, what it asks the host for, and that a
 * plugin's crash costs its own panel rather than the page.
 */

function host(impl: (request: PluginViewRequest) => PluginViewResult | Promise<PluginViewResult>): {
  host: PluginHost
  calls: PluginViewRequest[]
} {
  const calls: PluginViewRequest[] = []
  return {
    calls,
    host: {
      globals: { hostApiVersion: 1, register: () => {}, hostModules: {} },
      loadView: async (request) => {
        calls.push(request)
        return impl(request)
      },
    },
  }
}

function failure(kind: PluginViewFailureKind, over: Partial<PluginViewFailure> = {}): PluginViewFailure {
  return {
    kind,
    plugin: 'proxy-manager',
    version: '1.2.0',
    viewId: 'catalogue',
    entry: 'index.js',
    url: 'http://core.test/api/plugins/proxy-manager/ui/index.js?v=1.2.0',
    title: `TITLE-${kind}`,
    message: `MESSAGE-${kind}`,
    detail: `DETAIL-${kind}`,
    ...over,
  }
}

const BASE = {
  plugin: 'proxy-manager',
  version: '1.2.0',
  viewId: 'catalogue',
  entry: 'index.js',
  params: {} as Record<string, string>,
  setParams: () => {},
}

/** A plugin component that renders everything the host handed it, so the props can be asserted from the DOM. */
function Echo({ plugin, version, viewId, params }: PluginViewProps) {
  return (
    <div>
      <p>mounted {plugin}</p>
      <p>
        {version} · {viewId}
      </p>
      <p>tab={params.tab ?? '(none)'}</p>
    </div>
  )
}

describe('ReactView — loading', () => {
  test('a load that has not answered yet shows a busy skeleton, captioned with the plugin and version', () => {
    const h = host(() => new Promise<PluginViewResult>(() => {}))
    renderWithApi(<ReactView {...BASE} host={h.host} />)

    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(screen.getByText(/Loading this screen’s code from “proxy-manager” 1\.2\.0/)).toBeTruthy()
  })
})

describe('ReactView — the registered component (criterion 1)', () => {
  test('mounts the component the host resolved, inside Studio’s own tree', async () => {
    const h = host(() => ({ ok: true, component: Echo }))
    renderWithApi(<ReactView {...BASE} host={h.host} />)

    await waitFor(() => expect(screen.getByText('mounted proxy-manager')).toBeTruthy())
    expect(screen.getByText('1.2.0 · catalogue')).toBeTruthy()
  })

  test('asks the host for exactly the plugin, version, view id and entry it was given', async () => {
    const h = host(() => ({ ok: true, component: Echo }))
    renderWithApi(<ReactView {...BASE} version="1.2.0+dev.7" entry="views/catalogue.js" host={h.host} />)

    await waitFor(() => expect(h.calls.length).toBe(1))
    expect(h.calls[0]).toMatchObject({
      pluginName: 'proxy-manager',
      // A dev slot's `buildVersion`, which increments on every push — the
      // whole of criterion 8 rests on this string reaching the script URL.
      version: '1.2.0+dev.7',
      viewId: 'catalogue',
      entry: 'views/catalogue.js',
      attempt: 0,
    })
  })

  test('a rebuild — a new version — is a NEW load, never the cached component', async () => {
    const h = host(() => ({ ok: true, component: Echo }))
    const { rerender } = renderWithApi(<ReactView {...BASE} version="1.2.0+dev.1" host={h.host} />)
    await waitFor(() => expect(screen.getByText('1.2.0+dev.1 · catalogue')).toBeTruthy())

    rerender(<ReactView {...BASE} version="1.2.0+dev.2" host={h.host} />)
    await waitFor(() => expect(screen.getByText('1.2.0+dev.2 · catalogue')).toBeTruthy())
    expect(h.calls.map((c) => c.version)).toEqual(['1.2.0+dev.1', '1.2.0+dev.2'])
  })
})

describe('ReactView — a named failure, never a blank page (criterion 6)', () => {
  const KINDS: PluginViewFailureKind[] = ['module-load-failed', 'module-threw', 'view-not-registered']

  for (const kind of KINDS) {
    test(`${kind} renders the host’s own title, message and detail`, async () => {
      const h = host(() => ({ ok: false, failure: failure(kind) }))
      renderWithApi(<ReactView {...BASE} host={h.host} />)

      await waitFor(() => expect(screen.getByText(`TITLE-${kind}`)).toBeTruthy())
      expect(screen.getByText(`MESSAGE-${kind}`)).toBeTruthy()
      expect(screen.getByText(`DETAIL-${kind}`)).toBeTruthy()
    })
  }

  test('the three kinds are told apart by what they tell the operator to DO', async () => {
    const seen: string[] = []
    for (const kind of KINDS) {
      const h = host(() => ({ ok: false, failure: failure(kind) }))
      const view = renderWithApi(<ReactView {...BASE} host={h.host} />)
      await waitFor(() => expect(screen.getByText(`TITLE-${kind}`)).toBeTruthy())
      seen.push(view.container.textContent ?? '')
      cleanup()
    }
    expect(new Set(seen).size).toBe(3)
    expect(seen[0]).toContain('ui/ directory')
    expect(seen[1]).toContain('The browser console has the stack.')
    expect(seen[2]).toContain('window.__enkaku__.register()')
  })

  test('Retry re-asks the host with a bumped attempt, and a load that then succeeds mounts', async () => {
    let ok = false
    const h = host(() => (ok ? { ok: true, component: Echo } : { ok: false, failure: failure('module-load-failed') }))
    renderWithApi(<ReactView {...BASE} host={h.host} />)

    await waitFor(() => expect(screen.getByText('TITLE-module-load-failed')).toBeTruthy())
    ok = true
    fireEvent.click(screen.getByText('Try again'))

    await waitFor(() => expect(screen.getByText('mounted proxy-manager')).toBeTruthy())
    // The bumped attempt is the point: it changes the script URL, and only a
    // changed URL escapes the module map's cached FAILURE for the old one.
    expect(h.calls.map((c) => c.attempt)).toEqual([0, 1])
  })
})

describe('ReactView — the query passthrough (plan 111 §9 Q2)', () => {
  test('the unclaimed parameters reach the component', async () => {
    const h = host(() => ({ ok: true, component: Echo }))
    renderWithApi(<ReactView {...BASE} params={{ tab: 'assignments' }} host={h.host} />)

    await waitFor(() => expect(screen.getByText('tab=assignments')).toBeTruthy())
  })

  test('the component can write them back', async () => {
    const setParams = mock(() => {})
    function Tabs({ setParams: write }: PluginViewProps) {
      return (
        <button type="button" onClick={() => write({ tab: 'logs' })}>
          Logs
        </button>
      )
    }
    const h = host(() => ({ ok: true, component: Tabs }))
    renderWithApi(<ReactView {...BASE} setParams={setParams} host={h.host} />)

    await waitFor(() => expect(screen.getByText('Logs')).toBeTruthy())
    fireEvent.click(screen.getByText('Logs'))
    expect(setParams).toHaveBeenCalledWith({ tab: 'logs' })
  })
})

/**
 * §8, and `docs/design.md`'s "Tier A or tier C": the boundary contains a
 * MISTAKE. It is not a sandbox and the copy must not read like one — a
 * plugin's code runs in this page with the operator's session either way.
 */
describe('ReactView — a component that throws while rendering', () => {
  function quietly(fn: () => Promise<void>): Promise<void> {
    // React logs every caught error itself, and `componentDidCatch` logs the
    // component stack on top. Both are wanted in a browser and neither is
    // wanted in a test transcript.
    const original = console.error
    console.error = () => {}
    return fn().finally(() => {
      console.error = original
    })
  }

  test('the crash is named, the page survives, and the copy claims no isolation', async () => {
    function Boom(): never {
      throw new Error('cannot read properties of undefined (reading "rows")')
    }
    const h = host(() => ({ ok: true, component: Boom }))

    await quietly(async () => {
      const { container } = renderWithApi(<ReactView {...BASE} host={h.host} />)
      await waitFor(() => expect(screen.getByText('This view crashed while rendering')).toBeTruthy())

      expect(screen.getByText(/threw an error while drawing its “catalogue” view/)).toBeTruthy()
      expect(screen.getByText(/cannot read properties of undefined/)).toBeTruthy()
      // Not "sandboxed", not "safely" — §2 makes non-containment explicit.
      expect(container.textContent).toContain('nothing here isolates it')
      expect(container.textContent).not.toContain('sandbox')
    })
  })

  test('its heading is NOT the one a module that threw while evaluating gets — different moment, different fix', async () => {
    function Boom(): never {
      throw new Error('boom')
    }
    const h = host(() => ({ ok: true, component: Boom }))

    await quietly(async () => {
      renderWithApi(<ReactView {...BASE} host={h.host} />)
      await waitFor(() => expect(screen.getByText('This view crashed while rendering')).toBeTruthy())
      expect(screen.queryByText('TITLE-module-threw')).toBeNull()
    })
  })

  test('Try again remounts the component, so a one-off crash recovers', async () => {
    let broken = true
    function Flaky(props: PluginViewProps) {
      if (broken) throw new Error('first render only')
      return <Echo {...props} />
    }
    const h = host(() => ({ ok: true, component: Flaky }))

    await quietly(async () => {
      renderWithApi(<ReactView {...BASE} host={h.host} />)
      await waitFor(() => expect(screen.getByText('This view crashed while rendering')).toBeTruthy())

      broken = false
      fireEvent.click(screen.getByText('Try again'))
      await waitFor(() => expect(screen.getByText('mounted proxy-manager')).toBeTruthy())
    })
  })
})
