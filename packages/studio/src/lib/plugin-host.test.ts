import { describe, expect, test } from 'bun:test'
import * as HostReact from 'react'
import * as HostEnkakuUi from '@enkaku/ui'
import * as HostEnkakuHost from '@/components/host'
import {
  SHIMMED_SPECIFIERS,
  buildShimSource,
  createPluginHost,
  hostModules,
  realDom,
  stylesheetPathFor,
  type InjectModuleScriptOptions,
  type InjectStylesheetOptions,
  type PluginHostDeps,
  type PluginHostDom,
  type UncaughtErrorInfo,
} from './plugin-host'

/**
 * Tests for `plugin-host.ts` (plan 111 step 111.2, §7).
 *
 * These drive the host through its DOM seam rather than through `happy-dom`,
 * because none of what the host actually asks a browser for — executing a
 * module script, honouring an import map, resolving a `blob:` URL — exists
 * under `happy-dom`. What IS testable here, and is what this file covers, is
 * every decision the host makes: the registry's keying, load-once, the
 * ordering and one-shot-ness of the import map, attribution under concurrent
 * loads, and all three named failures. The half a browser owns (identity of
 * the shimmed modules) was verified separately, in a real Chrome — see the
 * shim tests at the bottom for what they can and cannot prove.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface InjectedScript extends InjectModuleScriptOptions {
  /** The insertion order of this script among ALL nodes the fake DOM received. */
  seq: number
}

interface InjectedStylesheet extends InjectStylesheetOptions {
  seq: number
}

class FakeDom implements PluginHostDom {
  scripts: InjectedScript[] = []
  stylesheets: InjectedStylesheet[] = []
  importMaps: Array<{ json: string; seq: number }> = []
  foreign = false
  private nextSeq = 0
  private errorListeners = new Set<(info: UncaughtErrorInfo) => void>()

  injectModuleScript(options: InjectModuleScriptOptions): void {
    this.scripts.push({ ...options, seq: this.nextSeq++ })
  }

  injectStylesheet(options: InjectStylesheetOptions): void {
    this.stylesheets.push({ ...options, seq: this.nextSeq++ })
  }

  importMapState(): 'none' | 'ours' | 'foreign' {
    if (this.foreign) return 'foreign'
    return this.importMaps.length > 0 ? 'ours' : 'none'
  }

  insertImportMap(json: string): void {
    this.importMaps.push({ json, seq: this.nextSeq++ })
  }

  onUncaughtError(listener: (info: UncaughtErrorInfo) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  createModuleUrl(source: string): string {
    // Deterministic stand-in for `URL.createObjectURL` — the source is
    // recoverable from the URL so a test can assert what a shim contains.
    return `blob:fake/${encodeURIComponent(source.slice(0, 24))}#${source.length}`
  }

  /** Test-only: what the browser would report for an exception escaping a script. */
  raise(filename: string, message: string): void {
    for (const listener of this.errorListeners) listener({ filename, message, error: new Error(message) })
  }

  /** Test-only: the most recently injected script. */
  last(): InjectedScript {
    const script = this.scripts.at(-1)
    if (!script) throw new Error('no script was injected')
    return script
  }

  importedSpecifiers(): Record<string, string> {
    const map = this.importMaps.at(-1)
    if (!map) throw new Error('no import map was inserted')
    const parsed: unknown = JSON.parse(map.json)
    if (typeof parsed !== 'object' || parsed === null || !('imports' in parsed)) throw new Error('malformed import map')
    const imports = (parsed as { imports: Record<string, string> }).imports
    return imports
  }
}

/** A clock the test drives, so the 15s load timeout and the 500ms grace never cost real seconds. */
function fakeClock() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>) => {
      pending.delete(id as unknown as number)
    },
    /** Runs every timer due within `ms`, in due order. */
    advance(ms: number): void {
      now += ms
      for (;;) {
        let dueId: number | null = null
        let dueAt = Number.POSITIVE_INFINITY
        for (const [id, entry] of pending) {
          if (entry.at <= now && entry.at < dueAt) {
            dueAt = entry.at
            dueId = id
          }
        }
        if (dueId === null) return
        const entry = pending.get(dueId)
        pending.delete(dueId)
        entry?.fn()
      }
    },
    pendingCount: () => pending.size,
  }
}

/** Lets pending microtask chains (`await record.settled`, `.then()`) run to completion. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Harness {
  host: ReturnType<typeof createPluginHost>
  dom: FakeDom
  clock: ReturnType<typeof fakeClock>
  warnings: string[]
  globalTarget: { __enkaku__?: unknown }
}

function harness(overrides: Partial<PluginHostDeps> = {}): Harness {
  const dom = new FakeDom()
  const clock = fakeClock()
  const warnings: string[] = []
  const globalTarget: { __enkaku__?: unknown } = {}
  const host = createPluginHost({
    dom,
    assetBase: () => 'http://core.test:7700',
    pageOrigin: () => 'http://core.test:7700',
    globalTarget,
    modules: { react: { useState: () => {} }, '@enkaku/ui': { Tabs: () => {} } },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: (message) => warnings.push(message),
    ...overrides,
  })
  return { host, dom, clock, warnings, globalTarget }
}

/** What a plugin module's own code would call once the browser ran it. */
function registerAs(globalTarget: { __enkaku__?: unknown }, viewId: string, component: unknown): void {
  const globals = globalTarget.__enkaku__
  if (typeof globals !== 'object' || globals === null || !('register' in globals)) throw new Error('no host global installed')
  ;(globals as { register: (id: string, c: unknown) => void }).register(viewId, component)
}

const ACCOUNTS = { pluginName: 'proxy-manager', version: '1.2.0', viewId: 'accounts', entry: 'index.js' }

// ---------------------------------------------------------------------------

describe('the host global', () => {
  test('is installed on the target as soon as the host exists, before any plugin runs', () => {
    const { globalTarget } = harness()
    expect(globalTarget.__enkaku__).toBeDefined()
    expect(typeof (globalTarget.__enkaku__ as { register: unknown }).register).toBe('function')
  })

  test('publishes the host module table the shims read', () => {
    const { globalTarget } = harness()
    const globals = globalTarget.__enkaku__ as { hostModules: Record<string, object> }
    expect(Object.keys(globals.hostModules)).toEqual(['react', '@enkaku/ui'])
  })

  /**
   * Plan 129 §3.4, §4.4, step 129.5: `@enkaku/host` is Studio's own
   * components, shimmed through the same table `@enkaku/ui` already uses —
   * added here, not to the harness above, because the harness publishes a
   * hand-picked pair of modules and this checks the REAL table `hostModules()`
   * builds from Studio's own live imports.
   */
  test('@enkaku/host is present in the real host module table and resolves to the Studio barrel', () => {
    expect(SHIMMED_SPECIFIERS).toContain('@enkaku/host')
    expect(hostModules()['@enkaku/host']).toBe(HostEnkakuHost)
  })
})

describe('the import map', () => {
  test('is inserted before the first plugin script, never after', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.importMaps).toHaveLength(1)
    expect(h.dom.importMaps[0]!.seq).toBeLessThan(h.dom.last().seq)
  })

  test('is inserted exactly once across several plugins', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    void h.host.loadView({ pluginName: 'other', version: '9', viewId: 'x', entry: 'index.js' })
    await flush()
    expect(h.dom.importMaps).toHaveLength(1)
  })

  test('carries one key per host module, each pointing at a shim URL', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    const imports = h.dom.importedSpecifiers()
    expect(Object.keys(imports).sort()).toEqual(['@enkaku/ui', 'react'])
    for (const url of Object.values(imports)) expect(url.startsWith('blob:')).toBe(true)
  })

  test('carries the complete fixed key set when the real host modules are used', async () => {
    const h = harness({ modules: hostModules() })
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(Object.keys(h.dom.importedSpecifiers()).sort()).toEqual([...SHIMMED_SPECIFIERS].sort())
  })

  test('an import map Studio did not write is reported and left alone', async () => {
    const h = harness()
    h.dom.foreign = true
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.importMaps).toHaveLength(0)
    expect(h.warnings.join('\n')).toContain('already carries an import map')
  })
})

describe('the script tag', () => {
  test('points at the asset route and carries the version as a cache-buster', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.last().src).toBe('http://core.test:7700/api/plugins/proxy-manager/ui/index.js?v=1.2.0')
  })

  test('a retry varies the URL, because the module map caches a FAILED fetch too', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onError()
    await flush()

    // Step 111.3's Retry. Re-injecting the identical URL would be answered
    // from the module map's cached failure with no request at all, so the
    // attempt has to reach the URL — this is what makes the button work.
    void h.host.loadView({ ...ACCOUNTS, attempt: 1 })
    await flush()
    expect(h.dom.scripts).toHaveLength(2)
    expect(h.dom.last().src).toBe('http://core.test:7700/api/plugins/proxy-manager/ui/index.js?v=1.2.0&retry=1')
  })

  test('the first attempt carries no retry marker at all', async () => {
    const h = harness()
    void h.host.loadView({ ...ACCOUNTS, attempt: 0 })
    await flush()
    expect(h.dom.last().src).toBe('http://core.test:7700/api/plugins/proxy-manager/ui/index.js?v=1.2.0')
  })

  test('asks for credentials when the core is on another origin (dev: :3001 → :7700)', async () => {
    const h = harness({ pageOrigin: () => 'http://localhost:3001' })
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.last().crossOrigin).toBe('use-credentials')
  })

  test('sets no crossOrigin when Studio is served by the core itself', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.last().crossOrigin).toBeNull()
  })
})

describe('the plugin’s own stylesheet (step 111.9’s handover contract)', () => {
  test('names the sheet after the entry, stripping only the last segment’s extension', () => {
    expect(stylesheetPathFor('index.js')).toBe('index.css')
    expect(stylesheetPathFor('panels/main.js')).toBe('panels/main.css')
    expect(stylesheetPathFor('v1.2/main.js')).toBe('v1.2/main.css')
    // A dotfile-looking entry has no extension to strip; it keeps its name.
    expect(stylesheetPathFor('.weird')).toBe('.weird.css')
  })

  test('a <link> is injected beside the module, from the same asset route', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.stylesheets).toHaveLength(1)
    expect(h.dom.stylesheets[0]!.href).toBe('http://core.test:7700/api/plugins/proxy-manager/ui/index.css?v=1.2.0')
  })

  test('the <link> comes BEFORE the script that needs it, and after the import map', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.importMaps[0]!.seq).toBeLessThan(h.dom.stylesheets[0]!.seq)
    expect(h.dom.stylesheets[0]!.seq).toBeLessThan(h.dom.last().seq)
  })

  /**
   * Plan 127 §0.4, step 127.1 — this test used to assert the OPPOSITE, and the
   * assertion was correct for its time: while the asset route answered
   * `no-store`, a version query bought nothing, so the sheet went without one.
   *
   * Step 127.2 makes that route `immutable`, and an unversioned `.css` under
   * an immutable header is served from cache forever — including after an
   * operator activates a new plugin version. So the query is now the thing
   * that keeps the stylesheet correct, not a redundancy. Inverted deliberately
   * rather than deleted, so the record shows the rule changed and why.
   */
  test('carries the same ?v=<version> the script does — the asset route caches CSS immutably now', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.stylesheets[0]!.href).toContain('?v=1.2.0')
  })

  test('two versions of one plugin link two distinct stylesheet URLs — the whole point of 127.1', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    void h.host.loadView({ ...ACCOUNTS, version: '1.3.0', viewId: 'accounts-next' })
    await flush()
    const hrefs = h.dom.stylesheets.map((s) => s.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    expect(hrefs.some((href) => href.includes('?v=1.2.0'))).toBe(true)
    expect(hrefs.some((href) => href.includes('?v=1.3.0'))).toBe(true)
  })

  test('two views sharing one entry link the stylesheet once', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    void h.host.loadView({ ...ACCOUNTS, viewId: 'logs' })
    await flush()
    expect(h.dom.stylesheets).toHaveLength(1)
  })

  test('two entries of one plugin are two stylesheets, because each is named after its entry', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    void h.host.loadView({ ...ACCOUNTS, viewId: 'panel', entry: 'panel.js' })
    await flush()
    expect(h.dom.stylesheets.map((s) => s.href)).toEqual([
      'http://core.test:7700/api/plugins/proxy-manager/ui/index.css?v=1.2.0',
      'http://core.test:7700/api/plugins/proxy-manager/ui/panel.css?v=1.2.0',
    ])
  })

  test('a retry does not re-link the stylesheet', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onError()
    await flush()
    void h.host.loadView({ ...ACCOUNTS, attempt: 1 })
    await flush()
    expect(h.dom.scripts).toHaveLength(2)
    expect(h.dom.stylesheets).toHaveLength(1)
  })

  test('asks for credentials on a cross-origin core, exactly as the script does', async () => {
    const h = harness({ pageOrigin: () => 'http://localhost:3001' })
    void h.host.loadView(ACCOUNTS)
    await flush()
    expect(h.dom.stylesheets[0]!.crossOrigin).toBe('use-credentials')
  })

  test('a plugin with no stylesheet is never warned about — a 404 here is the normal case', async () => {
    const h = harness()
    void h.host.loadView(ACCOUNTS)
    await flush()
    // The harness publishes two of the seven host modules, so the import map
    // legitimately warns about the other four; nothing about the stylesheet
    // may add to that list, because a plugin drawing only with `@enkaku/ui`
    // ships no CSS and its 404 is the expected path, not a fault.
    expect(h.warnings.join('\n')).not.toMatch(/stylesheet|\.css/i)
  })
})

/**
 * The one part of the seam a real document has to be trusted with: the shape
 * of the element, and that a sheet which fails to load takes itself back out
 * of the head rather than sitting there pointing at a 404 (step 111.9's
 * handover contract).
 *
 * *(measured, happy-dom 15.11.7)* a `<link rel="stylesheet">` really is
 * fetched the moment it is appended, and `disableCSSFileLoading` turns that
 * into a synchronous `error` (or, with `handleDisabledFileLoadingAsSuccess`, a
 * synchronous `load`) instead of a request to a core that is not running. So
 * both outcomes of the contract are reachable here deterministically and with
 * no network at all — which is better than the `dispatchEvent(new Event(…))`
 * this file would otherwise have to fake, because the event comes from the
 * DOM's own load path.
 */
describe('realDom().injectStylesheet', () => {
  const HREF = 'http://core.test:7700/api/plugins/p/ui/index.css'
  interface CssSettings {
    disableCSSFileLoading: boolean
    handleDisabledFileLoadingAsSuccess: boolean
  }
  const settings = (globalThis as { happyDOM?: { settings: CssSettings } }).happyDOM?.settings

  function withLoading(succeeds: boolean, body: () => void): void {
    if (!settings) throw new Error('this test needs happy-dom’s settings — check packages/studio/happydom.ts')
    const before = { ...settings }
    settings.disableCSSFileLoading = true
    settings.handleDisabledFileLoadingAsSuccess = succeeds
    // happy-dom reports a refused stylesheet to the page's console as well as
    // to the element, and the refusal is the POINT of the failing case here.
    const realError = console.error
    console.error = () => {}
    try {
      document.head.innerHTML = ''
      body()
    } finally {
      console.error = realError
      document.head.innerHTML = ''
      Object.assign(settings, before)
    }
  }

  test('appends a stylesheet link, with no credentials mode by default', () => {
    withLoading(true, () => {
      realDom().injectStylesheet({ href: HREF, crossOrigin: null })
      const el = document.head.querySelector('link[rel="stylesheet"]')
      expect(el).not.toBeNull()
      expect(el?.getAttribute('href')).toBe(HREF)
      expect(el?.getAttribute('crossorigin')).toBeNull()
    })
  })

  test('sets the credentials mode when the core is on another origin', () => {
    withLoading(true, () => {
      realDom().injectStylesheet({ href: HREF, crossOrigin: 'use-credentials' })
      expect(document.head.querySelector('link')?.getAttribute('crossorigin')).toBe('use-credentials')
    })
  })

  test('takes itself back out when the sheet does not load, leaving no dead node', () => {
    withLoading(false, () => {
      realDom().injectStylesheet({ href: HREF, crossOrigin: null })
      expect(document.head.querySelector('link')).toBeNull()
    })
  })
})

describe('load-once (criterion 7)', () => {
  test('two views of one plugin load the module once', async () => {
    const h = harness()
    const first = h.host.loadView(ACCOUNTS)
    const second = h.host.loadView({ ...ACCOUNTS, viewId: 'logs' })
    await flush()
    expect(h.dom.scripts).toHaveLength(1)

    registerAs(h.globalTarget, 'accounts', () => null)
    registerAs(h.globalTarget, 'logs', () => null)
    h.dom.last().onLoad()
    h.clock.advance(600)

    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
  })

  test('a view asked for after the module has already registered it never touches the DOM again', async () => {
    const h = harness()
    const first = h.host.loadView(ACCOUNTS)
    await flush()
    registerAs(h.globalTarget, 'accounts', () => null)
    registerAs(h.globalTarget, 'logs', () => null)
    h.dom.last().onLoad()
    h.clock.advance(600)
    await first

    const second = await h.host.loadView({ ...ACCOUNTS, viewId: 'logs' })
    expect(second.ok).toBe(true)
    expect(h.dom.scripts).toHaveLength(1)
  })
})

describe('a rebuilt plugin (criterion 8)', () => {
  test('a new version is a new key and a new URL, so the stale component is never served', async () => {
    const h = harness()
    const first = h.host.loadView(ACCOUNTS)
    await flush()
    const stale = () => null
    registerAs(h.globalTarget, 'accounts', stale)
    h.dom.last().onLoad()
    h.clock.advance(600)
    expect(await first).toEqual({ ok: true, component: stale })

    const second = h.host.loadView({ ...ACCOUNTS, version: '1.2.1' })
    await flush()
    expect(h.dom.scripts).toHaveLength(2)
    expect(h.dom.last().src).toContain('?v=1.2.1')

    const fresh = () => null
    registerAs(h.globalTarget, 'accounts', fresh)
    h.dom.last().onLoad()
    h.clock.advance(600)
    expect(await second).toEqual({ ok: true, component: fresh })
  })
})

describe('attribution', () => {
  test('two plugins loading at once are never cross-attributed', async () => {
    const h = harness()
    const a = h.host.loadView({ pluginName: 'alpha', version: '1', viewId: 'main', entry: 'index.js' })
    const b = h.host.loadView({ pluginName: 'beta', version: '1', viewId: 'main', entry: 'index.js' })
    await flush()

    // Serialized: only alpha's script is in the document so far.
    expect(h.dom.scripts).toHaveLength(1)
    expect(h.dom.last().src).toContain('/alpha/')

    const alphaMain = () => null
    registerAs(h.globalTarget, 'main', alphaMain)
    h.dom.last().onLoad()
    h.clock.advance(600)
    await flush()

    expect(h.dom.scripts).toHaveLength(2)
    expect(h.dom.last().src).toContain('/beta/')
    const betaMain = () => null
    registerAs(h.globalTarget, 'main', betaMain)
    h.dom.last().onLoad()
    h.clock.advance(600)

    expect(await a).toEqual({ ok: true, component: alphaMain })
    expect(await b).toEqual({ ok: true, component: betaMain })
  })

  test('a registration inside the post-evaluation grace still lands on the right plugin', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onLoad()
    // The plugin registered from a setTimeout(0), i.e. after `load` fired.
    const late = () => null
    registerAs(h.globalTarget, 'accounts', late)
    h.clock.advance(600)
    expect(await pending).toEqual({ ok: true, component: late })
  })

  test('a registration with no load in flight is dropped, not guessed at', async () => {
    const h = harness()
    registerAs(h.globalTarget, 'accounts', () => null)
    expect(h.warnings.join('\n')).toContain('while no plugin module was loading')

    const result = await (async () => {
      const p = h.host.loadView(ACCOUNTS)
      await flush()
      h.dom.last().onLoad()
      h.clock.advance(600)
      return p
    })()
    expect(result.ok).toBe(false)
  })
})

describe('the three named failures (criterion 6)', () => {
  test('a module that 404s is module-load-failed', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onError()
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('module-load-failed')
    expect(result.failure.plugin).toBe('proxy-manager')
    expect(result.failure.viewId).toBe('accounts')
    expect(result.failure.detail).toContain('index.js?v=1.2.0')
  })

  test('a module that throws while executing is module-threw, not "never registered"', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    // A module script that throws during evaluation still fires `load`; the
    // exception reaches the window. That is the pair this asserts.
    h.dom.raise(h.dom.last().src, 'ReferenceError: Tabs is not defined')
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('module-threw')
    expect(result.failure.detail).toContain('ReferenceError')
  })

  test('a throw from a dependency under the same plugin ui/ root is still module-threw', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.raise('http://core.test:7700/api/plugins/proxy-manager/ui/chunk-a1b2.js', 'TypeError: x is not a function')
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('module-threw')
  })

  test('an unrelated Studio error during the load window is not blamed on the plugin', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.raise('http://core.test:7700/_next/static/chunks/main.js', 'TypeError: unrelated')
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('view-not-registered')
  })

  test('a module that runs cleanly but registers nothing is view-not-registered', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('view-not-registered')
    expect(result.failure.detail).toContain('registered no views at all')
  })

  test('a mis-spelled view id names what the module DID register', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    registerAs(h.globalTarget, 'account', () => null)
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('view-not-registered')
    expect(result.failure.detail).toContain('“account”')
  })

  test('registering something that is not a component is refused and reported', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    registerAs(h.globalTarget, 'accounts', 'AccountsView')
    h.dom.last().onLoad()
    h.clock.advance(600)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('view-not-registered')
    expect(result.failure.detail).toContain('rejected registrations: accounts (a string)')
  })

  test('a module that never settles at all fails on the load timeout rather than hanging', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.clock.advance(15_000)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('module-load-failed')
    expect(result.failure.detail).toContain('15s')
  })

  test('a wedged load releases the queue so the next plugin still loads', async () => {
    const h = harness()
    const a = h.host.loadView({ pluginName: 'alpha', version: '1', viewId: 'main', entry: 'index.js' })
    const b = h.host.loadView({ pluginName: 'beta', version: '1', viewId: 'main', entry: 'index.js' })
    await flush()
    h.clock.advance(15_000)
    await flush()
    expect((await a).ok).toBe(false)
    expect(h.dom.scripts).toHaveLength(2)
    expect(h.dom.last().src).toContain('/beta/')
    registerAs(h.globalTarget, 'main', () => null)
    h.dom.last().onLoad()
    h.clock.advance(600)
    expect((await b).ok).toBe(true)
  })

  test('every failure names the plugin and the view in prose an operator can read', async () => {
    const h = harness()
    const pending = h.host.loadView(ACCOUNTS)
    await flush()
    h.dom.last().onError()
    const result = await pending
    if (result.ok) throw new Error('expected a failure')
    expect(result.failure.message).toContain('proxy-manager')
    expect(result.failure.message).toContain('accounts')
    expect(result.failure.title.length).toBeGreaterThan(0)
  })
})

describe('the generated shims', () => {
  test('re-export every own key of the namespace, and cannot drift from it', () => {
    const source = buildShimSource('@enkaku/ui', HostEnkakuUi)
    const names = Object.keys(HostEnkakuUi)
    expect(names.length).toBeGreaterThan(100)
    for (const name of names) expect(source).toContain(`export const ${name} = ns[`)
  })

  test('read the host instance rather than importing a second copy', () => {
    const source = buildShimSource('react', HostReact)
    expect(source).toContain('globalThis.__enkaku__.hostModules["react"]')
    expect(source).not.toContain('import ')
  })

  test('forward a default export only when the namespace has one', () => {
    expect(buildShimSource('react', HostReact)).toContain('export default ns.default')
    expect(buildShimSource('x', { a: 1 })).not.toContain('export default')
  })

  test('skip keys that are not legal export bindings, rather than emitting a syntax error', () => {
    const source = buildShimSource('x', { ok: 1, 'not-an-ident': 2, class: 3, default: 4 })
    expect(source).toContain('export const ok = ')
    expect(source).not.toContain('not-an-ident')
    expect(source).not.toContain('export const class')
    expect(source).toContain('export default ns.default')
  })

  test('end with a sourceURL so DevTools names the shim, not a blob uuid', () => {
    const source = buildShimSource('react/jsx-runtime', { jsx: 1 })
    expect(source.trimEnd().endsWith('//# sourceURL=enkaku:shim/react/jsx-runtime')).toBe(true)
  })

  test('throw a named error if a plugin imports a specifier the host never published', () => {
    expect(buildShimSource('react', HostReact)).toContain('was not published before a plugin imported it')
  })

  /**
   * The half this file cannot prove. A shim only earns its keep if
   * `(await import('react')).useState === hostReact.useState` in a real
   * browser — a second React copy looks fine right up to the first hook. That
   * was checked in Chrome against a real bundle; what is asserted here is the
   * property the source must have for it to be possible at all: every binding
   * is read off the ONE table the host published, so nothing in the shim can
   * introduce a second instance.
   */
  test('every exported binding is read from the single host table', () => {
    const source = buildShimSource('react', HostReact)
    for (const line of source.split('\n')) {
      if (!line.startsWith('export const ')) continue
      expect(line).toMatch(/= ns\["[^"]+"\]$/)
    }
  })

  /**
   * `@enkaku/host` (plan 129 step 129.5) gets the exact same guarantee
   * `@enkaku/ui` has above: every export the shim re-exports is read off the
   * single host table, never imported a second time — which is what makes a
   * plugin's `@enkaku/host` import the SAME React-consuming instance Studio
   * is already running, rather than a second copy that throws `Invalid hook
   * call` the moment it renders (plan 111 T4).
   */
  test('@enkaku/host re-exports every own key of the barrel, and cannot drift from it', () => {
    const source = buildShimSource('@enkaku/host', HostEnkakuHost)
    const names = Object.keys(HostEnkakuHost)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(source).toContain(`export const ${name} = ns[`)
  })

  test('@enkaku/host: every exported binding is read from the single host table', () => {
    const source = buildShimSource('@enkaku/host', HostEnkakuHost)
    for (const line of source.split('\n')) {
      if (!line.startsWith('export const ')) continue
      expect(line).toMatch(/= ns\["[^"]+"\]$/)
    }
  })
})
