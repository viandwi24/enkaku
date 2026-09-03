'use client'

import type { ComponentType } from 'react'
import * as HostReact from 'react'
import * as HostReactDom from 'react-dom'
import * as HostReactDomClient from 'react-dom/client'
import * as HostJsxRuntime from 'react/jsx-runtime'
import * as HostJsxDevRuntime from 'react/jsx-dev-runtime'
import * as HostEnkakuUi from '@enkaku/ui'
import * as HostEnkakuHost from '@/components/host'
import type { PluginViewParams, PluginViewProps, SetPluginViewParams } from '@enkaku/protocol'
import { coreBase } from './ws'

/**
 * `plugin-host.ts` — how a plugin's React module gets from the core's asset
 * route into Studio's own component tree (plan 111 §3.1, §3.2, step 111.2).
 *
 * Four mechanisms, in the order they have to happen:
 *
 * 1. **A host module table** (`window.__enkaku__.hostModules`) holding the
 *    LIVE `react`, `react-dom`, `react-dom/client`, both JSX runtimes,
 *    `@enkaku/ui` and `@enkaku/host` namespaces this Studio bundle is already
 *    running on. Plan 111 T4: two React copies means `Invalid hook call`, so
 *    the plugin must receive these exact objects, never a second copy.
 *    `@enkaku/host` (plan 129 §3.4, step 129.5) is Studio's OWN components —
 *    the ones that reach `/ws`, a control activity, or video — offered
 *    through this same table rather than a second mechanism.
 * 2. **Runtime-generated shim modules**, one per specifier, each re-exporting
 *    the corresponding entry of that table.
 * 3. **One import map**, inserted exactly once and before the first plugin
 *    script, pointing those seven bare specifiers at their shims. This is what
 *    lets a plugin author write `import { useState } from 'react'` — the
 *    whole point of §3.2 — with the host-module global hidden inside the
 *    shim where they never see it.
 * 4. **A `<script type="module">` per (plugin, version, entry)**, injected
 *    into the DOM rather than `import()`-ed, because Next's bundler rewrites
 *    dynamic imports at build time and would never leave a runtime specifier
 *    alone (plan 111 T3).
 * 5. **A `<link rel="stylesheet">` per (plugin, entry)**, injected just before
 *    that script, carrying the Tailwind the plugin compiled for itself (plan
 *    111 §9 Q1, step 111.9). Optional by construction — see
 *    `ensureStylesheet`.
 *
 * A script tag has no return value, so the module does not export — it calls
 * `window.__enkaku__.register(viewId, Component)` and the host resolves a
 * promise waiting on that view id (§3.1).
 *
 * Nothing here renders. `ReactView` (step 111.3) turns a `PluginViewResult`
 * into a mounted component or an error panel; this module's whole job is to
 * produce that result and never to throw a bare string at its caller.
 */

// ---------------------------------------------------------------------------
// The public result type
// ---------------------------------------------------------------------------

/**
 * The props a plugin's view component receives, and the two types that make
 * them up, are **defined in `@enkaku/protocol`** and re-exported here (plan
 * 111, the 111.7 follow-up). They used to be declared in this file, where no
 * plugin could import them: the first tier-C pack hand-copied the shape into
 * its own `enkaku-host.d.ts` and nothing checked the copy against this
 * original. One definition, in the package both halves already depend on,
 * makes that drift a compile error instead of a silent one.
 *
 * Re-exported rather than merely imported because this module's own callers
 * (`ReactView.tsx`, the view page, their tests) name `PluginViewProps` in
 * the same breath as `PluginViewResult`, and a second import line for the
 * same contract is exactly the sort of seam a type wanders across.
 */
export type { PluginViewParams, SetPluginViewParams, PluginViewProps }

/** What a plugin registers. `ComponentType` covers a plain function, `memo`, and `forwardRef` alike. */
export type PluginViewComponent = ComponentType<PluginViewProps>

/**
 * The three ways loading a view fails, kept distinct on purpose (plan 111
 * criterion 6). Collapsing them is what produces "something went wrong" — an
 * author cannot tell a typo'd entry path from a syntax error from a
 * mis-spelled view id, and all three are one-line fixes once named.
 *
 * - `module-load-failed` — the browser could not fetch or parse the module
 *   (404 from the asset route, a wrong entry name, a bad content type
 *   refused by `nosniff`, a dependency that itself 404s).
 * - `module-threw` — the module was fetched and started running, and an
 *   exception escaped it.
 * - `view-not-registered` — the module ran to completion without error and
 *   never called `register()` with the view id the manifest declares.
 */
export type PluginViewFailureKind = 'module-load-failed' | 'module-threw' | 'view-not-registered'

export interface PluginViewFailure {
  kind: PluginViewFailureKind
  plugin: string
  version: string
  viewId: string
  entry: string
  /** The exact URL that was injected, including the cache-busting version query. */
  url: string
  /** A short heading a UI can put above the detail — no plugin name, the UI already knows it. */
  title: string
  /** One sentence naming the plugin and the view, safe to show an operator. */
  message: string
  /** The technical line: the underlying error text, the URL, or what did get registered. */
  detail: string
}

export type PluginViewResult =
  | { ok: true; component: PluginViewComponent }
  | { ok: false; failure: PluginViewFailure }

/**
 * What a caller must know to load a view. A narrow local shape rather than an
 * import of the surface manifest's own types: this module needs four strings
 * and nothing else, and `ViewSpecSchema.react` is landing in `@enkaku/protocol`
 * in a separate step (111.4).
 */
export interface PluginViewRequest {
  pluginName: string
  /**
   * The activated plugin version — part of the registry key AND of the script
   * URL's query string, and both matter for plan 111 criterion 8. The key
   * means a rebuild is a different registry entry; the query means it is a
   * different URL, without which the browser's per-document module map would
   * hand back the already-evaluated OLD module however many times it is
   * re-injected, `cache-control: no-store` or not. A dev slot must therefore
   * vary this string on every rebuild — a constant `"dev"` would defeat both.
   */
  version: string
  viewId: string
  /** The path under the package's `ui/` directory, e.g. `index.js`. */
  entry: string
  /**
   * How many times an operator has pressed Retry on this view, `0`/absent
   * being the first attempt. Appended to the script URL as `&retry=<n>`, and
   * that is not decoration — it is the only thing that makes a retry work.
   *
   * A module map entry is keyed by URL and records **failure** as well as
   * success: once `…/index.js?v=1.2.0` has failed to fetch or parse in this
   * document, every later import of that exact URL is answered from the map
   * with the same failure, without a network request. So dropping the host's
   * own record and re-injecting the same `<script>` would re-report the old
   * error instantly and look like a Retry button that does nothing. Varying
   * the URL is what actually re-fetches.
   *
   * It follows that the host needs no `forget()`: a different URL is a
   * different `modulesLoaded` key already.
   */
  attempt?: number
}

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * How long a module gets to fetch, parse and evaluate before the load is
 * abandoned. Generous on purpose: the first load of an uncached bundle from a
 * remote core over a slow link is the case this must not fail, and no healthy
 * load comes anywhere near it. It is bounded because loads are serialized
 * (see `currentLoad` below) — a module whose script element never fires an
 * event at all would otherwise hold the queue for the life of the tab.
 */
export const MODULE_LOAD_TIMEOUT_MS = 15_000

/**
 * How long after the module has finished evaluating a view may still appear.
 *
 * Almost always zero is enough: a `<script type="module">` fires `load` only
 * after evaluation completes, so a plugin that registers at the top level has
 * already registered by then, and a plugin that awaits at the top level has
 * finished awaiting. The grace exists for the one legal pattern that lands
 * later — registering from a `.then()`, a `queueMicrotask`, or a `setTimeout(0)`.
 * 500 ms covers that comfortably while keeping the "you never registered
 * `<viewId>`" message fast enough to read as an answer rather than a hang.
 *
 * It is also the window during which a late registration is still attributed
 * to the right plugin: the load is not settled and the attribution slot is
 * not released until it expires.
 */
export const REGISTRATION_GRACE_MS = 500

// ---------------------------------------------------------------------------
// The DOM seam
// ---------------------------------------------------------------------------

export interface InjectModuleScriptOptions {
  src: string
  /** `'use-credentials'` when the asset origin differs from the page's, else `null`. */
  crossOrigin: string | null
  /** Fires after the module and its dependency graph have been evaluated. */
  onLoad: () => void
  /** Fires when the module could not be fetched or parsed. */
  onError: () => void
}

export interface InjectStylesheetOptions {
  href: string
  /** `'use-credentials'` when the asset origin differs from the page's, else `null`. */
  crossOrigin: string | null
}

export interface UncaughtErrorInfo {
  /** The URL of the script the exception escaped from — `''` when the browser did not say. */
  filename: string
  message: string
  error: unknown
}

/** Whether this document already carries an import map, and whose. */
export type ImportMapState = 'none' | 'ours' | 'foreign'

/**
 * Every DOM operation this module performs, behind one interface.
 *
 * Not gratuitous indirection: none of what happens here — a module script
 * actually executing, a blob URL actually resolving, an import map actually
 * being honoured — happens under `happy-dom`, so a test that reached for the
 * real `document` could only ever assert that an element was created. This
 * seam lets the registry, the ordering guarantee, the load-once rule and all
 * three failure paths be driven deterministically, and leaves exactly one
 * small implementation (`realDom()`) that a browser has to be trusted with.
 */
export interface PluginHostDom {
  injectModuleScript(options: InjectModuleScriptOptions): void
  /**
   * Injects a `<link rel="stylesheet">`, and takes the node back out again if
   * it fails to load. A plugin drawn only from `@enkaku/ui` ships no
   * stylesheet at all and answers 404, so the failure path here is the normal
   * case rather than an error worth reporting — but a `<link>` left pointing
   * at a 404 is a dead node in `document.head` that reads, to anyone looking,
   * as a stylesheet the page failed to load.
   */
  injectStylesheet(options: InjectStylesheetOptions): void
  importMapState(): ImportMapState
  insertImportMap(json: string): void
  /** Subscribes to window-level uncaught errors; returns the unsubscribe. */
  onUncaughtError(listener: (info: UncaughtErrorInfo) => void): () => void
  /** Turns a module source string into a URL a `<script type="module">` can import. */
  createModuleUrl(source: string): string
}

const IMPORT_MAP_MARKER = 'data-enkaku-plugin-host'

/**
 * The one implementation a browser has to be trusted with. Exported so its
 * three DOM-touching methods can be exercised against a real (`happy-dom`)
 * document — everything else in this file is driven through the seam.
 */
export function realDom(): PluginHostDom {
  return {
    injectModuleScript({ src, crossOrigin, onLoad, onError }) {
      const el = document.createElement('script')
      el.type = 'module'
      // Set before `src`: assigning `src` is what starts the fetch, and the
      // credentials mode has to be decided by then.
      if (crossOrigin !== null) el.crossOrigin = crossOrigin
      el.addEventListener('load', onLoad, { once: true })
      el.addEventListener('error', onError, { once: true })
      el.src = src
      document.head.appendChild(el)
    },

    injectStylesheet({ href, crossOrigin }) {
      const el = document.createElement('link')
      el.rel = 'stylesheet'
      // Same reasoning as the script tag's: set before `href`, because
      // assigning `href` is what starts the fetch.
      if (crossOrigin !== null) el.crossOrigin = crossOrigin
      el.addEventListener('error', () => el.remove(), { once: true })
      el.href = href
      document.head.appendChild(el)
    },

    importMapState() {
      const el = document.querySelector('script[type="importmap"]')
      if (!el) return 'none'
      return el.hasAttribute(IMPORT_MAP_MARKER) ? 'ours' : 'foreign'
    },

    insertImportMap(json) {
      const el = document.createElement('script')
      el.type = 'importmap'
      el.setAttribute(IMPORT_MAP_MARKER, '')
      el.textContent = json
      document.head.appendChild(el)
    },

    onUncaughtError(listener) {
      const handler = (event: ErrorEvent) => {
        listener({ filename: event.filename ?? '', message: event.message ?? '', error: event.error })
      }
      window.addEventListener('error', handler)
      return () => window.removeEventListener('error', handler)
    },

    createModuleUrl(source) {
      return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    },
  }
}

/**
 * The stylesheet that belongs to a build entry — `index.js` → `index.css`
 * (plan 111 step 111.9).
 *
 * A CONVENTION, not a manifest field: `packages/protocol` knows nothing about
 * a plugin's CSS, and `enkaku publish` emits `ui/<name>.css` from
 * `src/ui/<name>.css` beside `src/ui/<name>.tsx`. So both ends derive the same
 * name from the one thing the manifest does declare, and there is no second
 * string that can be wrong.
 *
 * The extension is stripped from the last path segment only, so a plugin
 * shipping `panels/main.js` links `panels/main.css` and a directory with a dot
 * in its name is left alone.
 */
export function stylesheetPathFor(entry: string): string {
  const slash = entry.lastIndexOf('/')
  const dir = slash === -1 ? '' : entry.slice(0, slash + 1)
  const file = entry.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  return `${dir}${dot <= 0 ? file : file.slice(0, dot)}.css`
}

// ---------------------------------------------------------------------------
// The shims
// ---------------------------------------------------------------------------

/**
 * The complete, fixed set of specifiers the import map carries.
 *
 * All seven in one map, always, because an import map can ADD keys to the
 * resolution table but can never override a key an earlier map already
 * defined, and historically only the first map in a document was honoured at
 * all. There is therefore no incremental path: whatever goes in goes in once,
 * so it is the finished list or nothing.
 *
 * `react-dom` is here for a plugin that renders a portal or calls
 * `flushSync`; `react-dom/client` for one that wants its own root inside its
 * own screen. Both JSX runtimes are here because which one a plugin's build
 * emits depends on ITS mode, not ours — a plugin built in development mode
 * imports `react/jsx-dev-runtime`, and leaving that key out would break it
 * with an unresolved-specifier error that names nothing useful. `@enkaku/host`
 * (plan 129 §3.4, §4.4) is here for a plugin that wants a Studio-only
 * component — the wall picker, for one — rather than a pure `@enkaku/ui` one.
 */
export const SHIMMED_SPECIFIERS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  '@enkaku/ui',
  '@enkaku/host',
] as const

export type ShimmedSpecifier = (typeof SHIMMED_SPECIFIERS)[number]

/** The live namespaces this Studio bundle is running on — the objects a plugin must be handed, not copies of them. */
export function hostModules(): Record<ShimmedSpecifier, object> {
  return {
    react: HostReact,
    'react-dom': HostReactDom,
    'react-dom/client': HostReactDomClient,
    'react/jsx-runtime': HostJsxRuntime,
    'react/jsx-dev-runtime': HostJsxDevRuntime,
    '@enkaku/ui': HostEnkakuUi,
    '@enkaku/host': HostEnkakuHost,
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Names that are legal object keys but illegal `export const` bindings.
 * `default` is handled separately (it gets `export default`); the rest would
 * be a syntax error inside the shim and take the whole module with them.
 */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'implements',
  'interface', 'package', 'private', 'protected', 'public',
])

/**
 * Builds one shim module's source from the host namespace's OWN KEYS.
 *
 * Generated at runtime rather than checked in as files, for one reason that
 * decides it: `@enkaku/ui` has ~125 named exports and ESM cannot re-export a
 * namespace object dynamically, so a static shim file would have to enumerate
 * every one of them — which means codegen, plus a drift guard, plus the day
 * the guard is skipped. A body built from `Object.keys(ns)` at the moment of
 * use cannot drift from the namespace it was built from, by construction.
 *
 * The body reads its namespace back off `globalThis.__enkaku__.hostModules`
 * because a module compiled from a string cannot close over a JS value. That
 * global is an implementation detail of this file and of the shim; a plugin
 * author never sees it and never types it.
 *
 * The trailing `sourceURL` is the one cost worth paying back: without it,
 * DevTools and every stack trace through a plugin's `useState` name a
 * `blob:http://…/9f2c-…` nobody can identify.
 */
export function buildShimSource(specifier: string, namespace: object): string {
  const lines: string[] = [
    `// Enkaku plugin shim for "${specifier}" — generated at runtime from Studio's live module namespace.`,
    `const ns = globalThis.__enkaku__ && globalThis.__enkaku__.hostModules[${JSON.stringify(specifier)}]`,
    `if (!ns) throw new Error(${JSON.stringify(`Enkaku: the host module "${specifier}" was not published before a plugin imported it`)})`,
  ]
  for (const name of Object.keys(namespace)) {
    if (name === 'default' || !IDENTIFIER.test(name) || RESERVED.has(name)) continue
    lines.push(`export const ${name} = ns[${JSON.stringify(name)}]`)
  }
  // Only when the host namespace genuinely has one. Synthesising a default
  // export that the real module does not have would let a plugin write an
  // import that works here and nowhere else.
  if ('default' in namespace) lines.push('export default ns.default')
  lines.push(`//# sourceURL=enkaku:shim/${specifier}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The global a plugin talks to
// ---------------------------------------------------------------------------

export interface EnkakuGlobal {
  /** Bumped only if the shape below changes incompatibly; a plugin may read it to adapt. */
  hostApiVersion: 1
  /** What a plugin module calls, once per view it provides. */
  register(viewId: string, component: unknown): void
  /** Read by the generated shims. Not part of the plugin-facing contract — see `buildShimSource`. */
  hostModules: Record<string, object>
}

/**
 * Declared rather than cast: `globalThis.__enkaku__ = …` has to typecheck
 * without an `as`, and a plugin author's editor gets the shape for free.
 */
declare global {
  // eslint-disable-next-line no-var
  var __enkaku__: EnkakuGlobal | undefined
}

interface GlobalCarrier {
  __enkaku__?: EnkakuGlobal
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface PluginHostDeps {
  dom: PluginHostDom
  /** Where the asset route lives — `coreBase()` in the app, an origin in a test. */
  assetBase: () => string
  /** The page's own origin, used only to decide the script tag's credentials mode. */
  pageOrigin: () => string
  /** The object the `__enkaku__` global is installed on. */
  globalTarget: GlobalCarrier
  modules: Record<string, object>
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  warn: (message: string, ...rest: unknown[]) => void
  loadTimeoutMs: number
  registrationGraceMs: number
}

export interface PluginHost {
  /**
   * Resolves to the registered component, or to a named failure. Never
   * rejects and never throws — `ReactView` has three states to render, not a
   * `catch` block to invent copy in.
   */
  loadView(request: PluginViewRequest): Promise<PluginViewResult>
  /** The global installed on `window.__enkaku__`; exposed for tests and for debugging from a console. */
  readonly globals: EnkakuGlobal
}

/** Per-(plugin, version, entry) state: one script tag, one evaluation, one settle. */
interface ModuleRecord {
  plugin: string
  version: string
  entry: string
  url: string
  /** `…/api/plugins/<name>/ui/` — the prefix every asset of this plugin shares, used to attribute uncaught errors. */
  assetRoot: string
  settled: Promise<void>
  /** Set when the module itself failed; a view request then reports this rather than "not registered". */
  failure: { kind: 'module-load-failed' | 'module-threw'; detail: string } | null
  /** Registrations this module made that were not usable as components — reported in the detail line. */
  rejected: string[]
}

/**
 * Per-(plugin, version) view table: view id → component.
 *
 * Keyed on the plugin and version rather than on the module, and shared
 * across a plugin's entries, so a module that registers three views satisfies
 * all three without a second script tag — including the case where two views
 * of one plugin declare different entries and the first one registers both.
 */
type ViewTable = Map<string, PluginViewComponent>

function defaultDeps(): PluginHostDeps {
  return {
    dom: realDom(),
    assetBase: () => coreBase(),
    pageOrigin: () => (typeof location === 'undefined' ? '' : location.origin),
    globalTarget: globalThis as GlobalCarrier,
    modules: hostModules(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    warn: (message, ...rest) => console.warn(message, ...rest),
    loadTimeoutMs: MODULE_LOAD_TIMEOUT_MS,
    registrationGraceMs: REGISTRATION_GRACE_MS,
  }
}

/**
 * A registration is checked, not trusted: a plugin is free to hand
 * `register()` a string, `undefined`, or the result of a call it meant to
 * pass as a reference. A function covers a plain component; a non-null object
 * covers `memo`, `forwardRef` and `lazy`, whose results are objects. Anything
 * else is refused at the door and named in the failure detail, which is a far
 * shorter path to the fix than React's own render-time complaint.
 */
function isComponentLike(value: unknown): value is PluginViewComponent {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
}

export function createPluginHost(overrides: Partial<PluginHostDeps> = {}): PluginHost {
  const deps: PluginHostDeps = { ...defaultDeps(), ...overrides }

  const modulesLoaded = new Map<string, ModuleRecord>()
  const viewTables = new Map<string, ViewTable>()

  /**
   * Which plugin's script is currently executing, and therefore who a bare
   * `register(viewId, …)` belongs to.
   *
   * **The asymmetry this solves.** A plugin calls `register('accounts', View)`
   * — a view id and nothing else. It does not know its own name or version,
   * and it should not have to: those are the manifest's business, not the
   * component's. So the host has to supply the other two thirds of the key,
   * which means knowing whose module is running when the call arrives.
   *
   * **Why a single "currently loading" field and not a per-plugin `register`.**
   * They are the same mechanism — installing `register_A` before A's script
   * is injected is exactly as safe, and exactly as unsafe, as setting a field
   * to `A`. Both are correct only if A's module cannot execute while the slot
   * says B. A dynamically inserted `<script type="module">` is `async` by
   * default and its execution order relative to other injected scripts is NOT
   * guaranteed, so with two loads in flight neither design is safe on its own.
   * What actually makes it safe is the queue below, and given the queue, one
   * field is the smaller thing to hold correct.
   *
   * **The slot is held until the load SETTLES, not until `load` fires.** A
   * plugin that registers from a `setTimeout(0)` does so after its script's
   * `load` event; releasing the slot there would attribute that registration
   * to whatever loaded next. So the slot spans the grace window too, and the
   * queue advances only after it is released.
   *
   * A registration arriving with no slot held is dropped with a warning
   * rather than guessed at — a view attributed to the wrong plugin renders
   * the wrong screen, which is worse than a view that reports it never
   * registered.
   */
  let currentLoad: { plugin: string; version: string } | null = null

  /** The serialization point. One plugin module in flight at a time; see `currentLoad`. */
  let queue: Promise<void> = Promise.resolve()

  const globals: EnkakuGlobal = {
    hostApiVersion: 1,
    hostModules: deps.modules,
    register(viewId, component) {
      const owner = currentLoad
      if (!owner) {
        deps.warn(
          `[enkaku] a plugin registered the view "${viewId}" while no plugin module was loading; ignoring it. ` +
            'Register at module top level, or within half a second of it.',
        )
        return
      }
      if (typeof viewId !== 'string' || viewId.length === 0) {
        deps.warn(`[enkaku] plugin "${owner.plugin}" called register() without a view id; ignoring it.`)
        return
      }
      const table = tableFor(owner.plugin, owner.version)
      if (!isComponentLike(component)) {
        deps.warn(`[enkaku] plugin "${owner.plugin}" registered "${viewId}" as ${describe(component)}, which is not a component; ignoring it.`)
        loadingRecord(owner.plugin, owner.version)?.rejected.push(`${viewId} (${describe(component)})`)
        return
      }
      table.set(viewId, component)
    },
  }

  deps.globalTarget.__enkaku__ = globals

  /**
   * The module record a rejected registration belongs to. There is exactly
   * one candidate for a given plugin+version while a load is in flight,
   * because loads are serialized.
   */
  function loadingRecord(plugin: string, version: string): ModuleRecord | undefined {
    for (const record of modulesLoaded.values()) {
      if (record.plugin === plugin && record.version === version) return record
    }
    return undefined
  }

  function describe(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'an array'
    return `a ${typeof value}`
  }

  function tableFor(plugin: string, version: string): ViewTable {
    const key = `${plugin}@${version}`
    let table = viewTables.get(key)
    if (!table) {
      table = new Map()
      viewTables.set(key, table)
    }
    return table
  }

  /**
   * Inserted once, and always before the first plugin script — an import map
   * has no effect on a module resolution that already happened, so a map that
   * arrives second is a map that does nothing. Both halves of that ordering
   * live here: this is called from `loadView` before anything is injected,
   * and it is idempotent.
   *
   * A map this host did not write is left alone and reported. Appending a
   * second one cannot help (only the first is honoured) and quietly doing it
   * anyway would turn a diagnosable condition into an unresolved-specifier
   * error deep inside somebody's plugin.
   */
  let importMapReady = false
  function ensureImportMap(): void {
    if (importMapReady) return
    const state = deps.dom.importMapState()
    if (state === 'ours') {
      importMapReady = true
      return
    }
    if (state === 'foreign') {
      deps.warn(
        '[enkaku] this document already carries an import map that Studio did not write; ' +
          'plugin modules importing "react" or "@enkaku/ui" will fail to resolve.',
      )
      importMapReady = true
      return
    }
    const imports: Record<string, string> = {}
    for (const specifier of SHIMMED_SPECIFIERS) {
      const namespace = deps.modules[specifier]
      if (!namespace) {
        deps.warn(`[enkaku] no host module published for "${specifier}"; plugins importing it will fail.`)
        continue
      }
      imports[specifier] = deps.dom.createModuleUrl(buildShimSource(specifier, namespace))
    }
    deps.dom.insertImportMap(JSON.stringify({ imports }, null, 2))
    importMapReady = true
  }

  function assetRootFor(pluginName: string): string {
    const base = deps.assetBase().replace(/\/$/, '')
    return `${base}/api/plugins/${encodeURIComponent(pluginName)}/ui/`
  }

  function assetUrl(pluginName: string, path: string): string {
    return `${assetRootFor(pluginName)}${path.split('/').map(encodeURIComponent).join('/')}`
  }

  /**
   * The plugin's own compiled Tailwind, linked immediately before the module
   * that needs it (plan 111 §9 Q1, step 111.9).
   *
   * Three properties, each of which is a decision rather than an accident:
   *
   * - **One `<link>` per (plugin, entry), never per view.** A plugin whose two
   *   views share `index.js` shares `index.css` too, and linking it twice
   *   would be two fetches for one identical sheet. The entry is the unit
   *   because the entry is what the stylesheet is named after.
   * - **A missing stylesheet is not an error.** A screen drawn only from
   *   `@enkaku/ui` needs no classes Studio has not already compiled, so it
   *   ships no CSS and this href answers 404 (`ui_asset_not_found`). Nothing
   *   is warned and nothing is reported to the operator; `realDom` simply
   *   takes the dead node back out. Making the link conditional on a HEAD
   *   request first would cost a round trip on every plugin to avoid a
   *   harmless 404 on some of them.
   * - **It is never removed when the view unmounts.** Utilities are idempotent
   *   — the same class compiles to the same rule from the same theme — so a
   *   sheet left in the document is inert, and removing it would mean
   *   re-fetching on every return to the screen. (Which is also why there is
   *   the stylesheet carries the SAME `?v=<version>` the script does, as of
   *   plan 127 step 127.1 — see `ensureStylesheet` below for why that had to
   *   change before the asset route's cache header could.)
   */
  const stylesheetsLinked = new Set<string>()
  function ensureStylesheet(request: PluginViewRequest): void {
    /**
     * The `?v=<version>` is load-bearing, and it was missing until plan 127
     * §0.4 found the asymmetry: the SCRIPT url has carried a version query
     * since plan 111 (`scriptUrl` below), the stylesheet never did.
     *
     * While the asset route answered `no-store` that cost nothing — a fresh
     * document always re-fetched both. Plan 127 step 127.2 makes that route
     * `immutable`, because a version-unique URL can never serve stale bytes
     * and forbidding the browser to cache it was re-downloading ~159 KB of
     * plugin UI on every single page refresh (invisible on loopback, the
     * whole page over a real link).
     *
     * An unversioned `.css` under an immutable header would then be served
     * from cache FOREVER, including after an operator activates a new plugin
     * version — trading a bandwidth bug for a correctness one. So this line
     * has to land before that header changes, not after. `request.version`
     * is the same value `scriptUrl` uses, so the two URLs now agree.
     */
    const href = `${assetUrl(request.pluginName, stylesheetPathFor(request.entry))}?v=${encodeURIComponent(request.version)}`
    if (stylesheetsLinked.has(href)) return
    stylesheetsLinked.add(href)
    deps.dom.injectStylesheet({ href, crossOrigin: crossOriginFor(href) })
  }

  function scriptUrl(request: PluginViewRequest): string {
    // Only on a real retry, so the first (and overwhelmingly common) URL stays
    // the clean `…?v=<version>` a `enkaku dev` reload produces — see
    // `PluginViewRequest.attempt` for why varying it is what makes Retry work.
    const retry = typeof request.attempt === 'number' && request.attempt > 0 ? `&retry=${encodeURIComponent(String(request.attempt))}` : ''
    return `${assetUrl(request.pluginName, request.entry)}?v=${encodeURIComponent(request.version)}${retry}`
  }

  /**
   * `'use-credentials'` whenever the asset origin is not the page's own.
   * Studio is normally served BY the core on one origin, where the default
   * (`omit` for a cross-origin module, irrelevant same-origin) is fine; in
   * dev the page is on :3001 and the core on :7700, and the asset route is
   * behind `script.view`, so without this the module fetch arrives with no
   * session cookie and 401s.
   */
  function crossOriginFor(url: string): string | null {
    const page = deps.pageOrigin()
    if (!page) return null
    try {
      return new URL(url, page).origin === page ? null : 'use-credentials'
    } catch {
      return null
    }
  }

  /** Injects one module script and resolves once it has settled — evaluated, failed, or timed out. */
  function runLoad(record: ModuleRecord): Promise<void> {
    return new Promise<void>((resolve) => {
      currentLoad = { plugin: record.plugin, version: record.version }

      let done = false
      let timer: ReturnType<typeof deps.setTimeout> | null = null
      // Errors reported by the browser while this module is the one running.
      // A module that throws during evaluation does NOT fire `error` on its
      // script element — per the HTML spec the element still fires `load` and
      // the exception is reported to the global. This listener is the only
      // way to tell "ran and threw" from "ran and stayed quiet", which is the
      // whole difference between `module-threw` and `view-not-registered`.
      let caught: string | null = null
      const stopListening = deps.dom.onUncaughtError((info) => {
        if (caught) return
        const from = info.filename
        // Match the module itself or anything else served out of this
        // plugin's `ui/` directory, so a throw inside a dependency the module
        // imported is still attributed to the plugin rather than lost.
        if (from === record.url || (from !== '' && from.startsWith(record.assetRoot))) caught = info.message
      })

      const settle = (failure: ModuleRecord['failure']) => {
        if (done) return
        done = true
        if (timer !== null) deps.clearTimeout(timer)
        stopListening()
        record.failure = failure
        currentLoad = null
        resolve()
      }

      timer = deps.setTimeout(() => {
        settle({
          kind: 'module-load-failed',
          detail: `the module did not finish loading within ${Math.round(deps.loadTimeoutMs / 1000)}s (${record.url})`,
        })
      }, deps.loadTimeoutMs)

      deps.dom.injectModuleScript({
        src: record.url,
        crossOrigin: crossOriginFor(record.url),
        onLoad: () => {
          if (done) return
          if (timer !== null) deps.clearTimeout(timer)
          // The module has finished evaluating. Hold the attribution slot for
          // the grace window so a late registration still lands on the right
          // plugin, then settle either way — a throw during evaluation is
          // already known by now, since it was reported before `load` fired.
          timer = deps.setTimeout(() => {
            settle(caught === null ? null : { kind: 'module-threw', detail: caught })
          }, deps.registrationGraceMs)
        },
        onError: () => {
          settle({
            kind: 'module-load-failed',
            detail: `the browser could not fetch or parse ${record.url}`,
          })
        },
      })
    })
  }

  /**
   * The module record for this request's URL, loading it if this is the first
   * ask.
   *
   * A settled record is reused whether it succeeded or failed, so a 404 stays
   * a 404 for the life of the tab rather than re-injecting a script tag on
   * every remount. That is deliberate — an error panel that silently retries
   * is an error panel that hammers the core.
   *
   * `ReactView`'s operator-pressed Retry (step 111.3) escapes it through
   * `PluginViewRequest.attempt`, which changes the URL and therefore the key
   * here. A `forget()` that merely dropped the record was considered and is
   * NOT what shipped: it would have re-injected the same URL, which the
   * browser's module map answers from its cached failure without a network
   * request. See `attempt`'s own comment.
   */
  function ensureModule(request: PluginViewRequest): ModuleRecord {
    const url = scriptUrl(request)
    const existing = modulesLoaded.get(url)
    if (existing) return existing

    const record: ModuleRecord = {
      plugin: request.pluginName,
      version: request.version,
      entry: request.entry,
      url,
      assetRoot: assetRootFor(request.pluginName),
      failure: null,
      rejected: [],
      settled: Promise.resolve(),
    }
    // Registered before the load starts so a concurrent `loadView` for the
    // same URL joins this record rather than injecting a second script tag
    // (plan 111 criterion 7).
    modulesLoaded.set(url, record)
    // Chained onto the queue rather than started immediately: `currentLoad`
    // is only meaningful with one module in flight. `queue` never rejects —
    // `runLoad` always resolves — so the chain cannot be poisoned.
    queue = queue.then(() => runLoad(record))
    record.settled = queue
    return record
  }

  function failure(
    request: PluginViewRequest,
    url: string,
    kind: PluginViewFailureKind,
    detail: string,
  ): PluginViewResult {
    const titles: Record<PluginViewFailureKind, string> = {
      'module-load-failed': 'This view’s code could not be loaded',
      'module-threw': 'This view’s code failed while starting',
      'view-not-registered': 'This view was never registered',
    }
    const messages: Record<PluginViewFailureKind, string> = {
      'module-load-failed': `Studio could not load ${request.entry} from the plugin “${request.pluginName}”, so its “${request.viewId}” view cannot render.`,
      'module-threw': `The plugin “${request.pluginName}” threw an error while its code was running, so its “${request.viewId}” view cannot render.`,
      'view-not-registered': `The plugin “${request.pluginName}” loaded, but never registered a view called “${request.viewId}”.`,
    }
    return {
      ok: false,
      failure: {
        kind,
        plugin: request.pluginName,
        version: request.version,
        viewId: request.viewId,
        entry: request.entry,
        url,
        title: titles[kind],
        message: messages[kind],
        detail,
      },
    }
  }

  async function loadView(request: PluginViewRequest): Promise<PluginViewResult> {
    const table = tableFor(request.pluginName, request.version)

    // Load-once, the cheap half (plan 111 criterion 7): a second view of a
    // plugin whose module already registered it never touches the DOM at all.
    const already = table.get(request.viewId)
    if (already) return { ok: true, component: already }

    ensureImportMap()
    // Before the module, and synchronously, so the sheet is in the document
    // ahead of the script tag `ensureModule` queues. A plugin's first paint
    // then happens with its own classes already resolvable, rather than
    // flashing unstyled while a `<link>` inserted afterwards catches up.
    ensureStylesheet(request)
    const record = ensureModule(request)
    await record.settled

    const registered = table.get(request.viewId)
    if (registered) return { ok: true, component: registered }

    if (record.failure) return failure(request, record.url, record.failure.kind, record.failure.detail)

    const others = [...table.keys()]
    const detailParts: string[] = []
    detailParts.push(
      others.length > 0
        ? `it registered ${others.map((id) => `“${id}”`).join(', ')} instead`
        : 'it registered no views at all',
    )
    if (record.rejected.length > 0) detailParts.push(`rejected registrations: ${record.rejected.join(', ')}`)
    detailParts.push(record.url)
    return failure(request, record.url, 'view-not-registered', detailParts.join(' — '))
  }

  return { loadView, globals }
}

let singleton: PluginHost | null = null

/**
 * The one host per page. Created lazily so that importing this module during
 * Next's static prerender — where there is no `document`, no `window` and no
 * `location` — does nothing at all.
 */
export function pluginHost(): PluginHost {
  if (!singleton) singleton = createPluginHost()
  return singleton
}
