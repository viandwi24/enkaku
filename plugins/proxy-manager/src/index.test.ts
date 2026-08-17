import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginSurface, ViewSpec } from '@enkaku/protocol'
import { ICON_NAMES, PLUGIN_UI_API_VERSION, PluginSurfaceSchema, validatePluginSurface } from '@enkaku/protocol'
import plugin, { checkScript } from './index'
import { PROXY_KEY_HINT, PROXY_KEY_PREFIX, PROXY_KINDS, ProxyRecordSchema } from './record'
import { readProxy, writeProxy } from './ui/parts/api'
import {
  ASSIGNMENT_KEY,
  ASSIGNMENT_NOTE,
  BANNER_NOT_BUILT,
  CATALOGUE_EMPTY_HINT,
  CHECK_NOT_BUILT,
  CREDENTIAL_NOT_STORED,
  DEFAULT_DRAIN_MS,
  DEFAULT_MAX_CONNECTIONS,
  PLUGIN_NOT_BUILT,
  PROXY_KIND_LABELS,
  PROXY_SECRET_KEY_PREFIX,
  RUNS_NOTE,
  VIEW_NOT_BUILT,
  proxySecretKeyFor,
  secretHintLeak,
} from './shared'

/**
 * The pack is deliberately blank, so almost everything worth testing is about
 * the SHAPE it declares rather than about behaviour it does not have.
 *
 * Two tests here are not about the schema, and both guard a failure nothing
 * else in the toolchain can see:
 *
 * - **The drift test** (`the form writes exactly the shape a record is`) — a
 *   form and a reader that disagree produce a screen that looks finished and
 *   shows empty cells. The surface is valid, the schemas are valid, the write
 *   succeeds, and the row is blank.
 * - **The honesty test** (plan 111 criterion 12) — the screen is React now, so
 *   there is no declared `empty.hint` for a test to read. What is asserted
 *   instead is stronger: the sentences live in `shared.ts`, the manifest uses
 *   those exact constants, and the React half's SOURCE names every one of
 *   them. Deleting a line of honesty copy from the screen therefore fails
 *   here, which is exactly what the old assertion bought.
 */

function surfaceOf(): PluginSurface {
  const surface = plugin.surface
  if (!surface) throw new Error('the pack declares no surface — the whole point of this plugin is the screen')
  return surface
}

function viewOf(id: string): ViewSpec {
  const view = surfaceOf().views[id]
  if (!view) throw new Error(`no such view: ${id}`)
  return view
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The React half, as text. Read rather than imported: `src/ui/index.tsx` calls
 * `window.__enkaku__.register` at the top level, so importing it would need a
 * DOM and a host global that only Studio provides. `src/ui/parts/api.ts` has
 * no such side effect and IS imported above — which is why the drift test
 * below can execute both halves rather than grep for them.
 */
async function readUi(file: string): Promise<string> {
  return await Bun.file(join(HERE, 'ui', file)).text()
}

const RECORD_FIELDS = Object.keys(ProxyRecordSchema.shape)

/** Every member the pack authors, as authored — see the title/description test for why this is not `plugin.scripts`. */
const MEMBERS = [checkScript]

describe('the plugin definition', () => {
  test('definePlugin accepted the whole thing at import time', () => {
    // `definePlugin` throws on the author's machine for an unknown icon, a nav
    // entry naming a missing view, an action reference naming a missing
    // action, a duplicate nav id, and every cap — so reaching this line at all
    // is the assertion. The identity checks below are what stops a rename from
    // silently changing the KV namespace, which is the plugin id.
    expect(plugin.id).toBe('proxy-manager')
    expect(plugin.version).toBe('0.3.1')
    expect(plugin.scripts.length).toBe(1)
  })

  test('every member carries a title and a description', () => {
    // Read off the AUTHORED members, not `plugin.scripts`: `definePlugin`
    // returns `ScriptDefinition[]`, which does not carry `title`/`description`
    // in its type at all (they are `PluginMemberScript` fields, reported
    // separately by the verify child). The id equality below is what keeps
    // this honest — a member added to `definePlugin` and not to `MEMBERS`
    // fails here rather than skipping the check.
    expect(plugin.scripts.map((s) => s.id)).toEqual(MEMBERS.map((m) => m.id))
    for (const member of MEMBERS) {
      expect(member.title).toBeTruthy()
      expect(member.description).toBeTruthy()
    }
  })

  test('the member is a real, runnable script — not a stub that throws', () => {
    expect(checkScript.id).toBe('check')
    expect(typeof checkScript.run).toBe('function')
    expect(checkScript.params).toBeDefined()
  })

  test("the member's declared result accepts exactly what its run() returns", () => {
    expect(checkScript.result?.safeParse({ proxy: 'proxy:office-uk', reachable: false }).success).toBe(true)
  })

  test('the UI rewrite did not touch the scripts (step 111.7 changes the screen, not the members)', () => {
    expect(checkScript.result?.safeParse({ proxy: 'proxy:x', reachable: true }).success).toBe(true)
    // The one thing `run` may ever report, until something actually dials.
    expect(checkScript.description).toContain('not reachable')
  })
})

describe('the honesty copy is NARROWED by plan 112, never widened and never deleted (criteria 12 and 17)', () => {
  /**
   * These assertions were written when the pack did nothing at all and said
   * so. Plan 112 steps 112.1–112.7 made part of that untrue — a record marked
   * `enabled` now binds a real listener and dials a real upstream — so each
   * sentence is narrowed to exactly what stopped being true.
   *
   * The assertions below are **extended, not relaxed**. Each caveat that still
   * holds is still asserted, in its own expectation; the ones that changed are
   * asserted against the NEW claim, and paired with a `not.toMatch` for the
   * old one so a revert cannot pass silently.
   */

  test('the sentences say what is now true: a bridge runs, and it is not a route', () => {
    expect(PLUGIN_NOT_BUILT).toMatch(/runs a local bridge/)
    expect(PLUGIN_NOT_BUILT).toMatch(/routes no device’s traffic/)
    expect(VIEW_NOT_BUILT).toMatch(/started by the farm when this plugin loads/)
    expect(BANNER_NOT_BUILT).toMatch(/It is not a route/)
  })

  test('the sentences that stopped being true are GONE, not merely softened', () => {
    // The exact claims plan 112 falsified. A revert that reinstated any of
    // them would put a lie back on the screen.
    expect(PLUGIN_NOT_BUILT).not.toMatch(/Nothing here starts/)
    expect(VIEW_NOT_BUILT).not.toMatch(/does not connect to anything/)
    expect(BANNER_NOT_BUILT).not.toMatch(/never contacted|is ever contacted/)
    for (const copy of [PLUGIN_NOT_BUILT, VIEW_NOT_BUILT, BANNER_NOT_BUILT, CATALOGUE_EMPTY_HINT]) {
      expect(copy).not.toMatch(/never opens a socket/)
    }
  })

  test('every caveat that still holds is still stated', () => {
    // The screen cannot drive any of this (steps 112.9, 112.10).
    expect(PLUGIN_NOT_BUILT).toMatch(/not built yet/)
    expect(VIEW_NOT_BUILT).toMatch(/cannot start or stop one yet/)
    expect(BANNER_NOT_BUILT).toMatch(/Starting and stopping from this screen/)
    expect(CATALOGUE_EMPTY_HINT).toMatch(/is not built yet/)
    // Per-proxy logs (step 112.8) and the password field (step 112.2).
    expect(BANNER_NOT_BUILT).toMatch(/per-proxy logs/)
    expect(BANNER_NOT_BUILT).toMatch(/saving an upstream password/)
    // Routing is still nobody's here, word for word (§3.12).
    expect(ASSIGNMENT_NOTE).toMatch(/a note, not a route/)
    // The `check` member still dials nothing.
    expect(RUNS_NOTE).toMatch(/nothing was dialled/)
    expect(CHECK_NOT_BUILT).toMatch(/Does nothing yet/)
    expect(CHECK_NOT_BUILT).toMatch(/dials nothing/)
  })

  test('the Assignments note survives this plan VERBATIM — §3.12 says it does', () => {
    // Not a paraphrase check: the exact sentence, character for character,
    // because plan 112 narrows this one only in step 112.11.
    expect(ASSIGNMENT_NOTE).toBe(
      'An assignment is a note, not a route. It records which proxy a device is MEANT to use; nothing reads it, and the device’s traffic is unchanged. Routing belongs to the network driver layer (spec §7.9), which no plugin can reach today.',
    )
  })

  test('the one caveat plan 112 ADDED says why there is no password field', () => {
    expect(CREDENTIAL_NOT_STORED).toMatch(/cannot be saved yet/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/storage hint/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/112\.2/)
  })

  test('the manifest uses those exact sentences, not paraphrases of them', () => {
    expect(plugin.description).toBe(PLUGIN_NOT_BUILT)
    expect(viewOf('proxies').description).toBe(VIEW_NOT_BUILT)
    expect(checkScript.description).toBe(CHECK_NOT_BUILT)
  })

  test('the React half names every one of them, so a rewrite cannot quietly drop one', async () => {
    const sources = (await Promise.all(['index.tsx', 'parts/catalogue.tsx', 'parts/assignments.tsx', 'parts/runs.tsx'].map(readUi))).join('\n')
    for (const name of ['BANNER_NOT_BUILT', 'CATALOGUE_EMPTY_HINT', 'ASSIGNMENT_NOTE', 'RUNS_NOTE', 'CREDENTIAL_NOT_STORED']) {
      expect(sources).toContain(name)
    }
  })

  test('the screen never hard-codes a sentence the manifest also states', async () => {
    // A copy-pasted duplicate is how the plugin list and the screen start
    // disagreeing. Both halves import from `shared.ts`; neither inlines it.
    const sources = (await Promise.all(['index.tsx', 'parts/catalogue.tsx', 'parts/assignments.tsx', 'parts/runs.tsx'].map(readUi))).join('\n')
    expect(sources).not.toContain(BANNER_NOT_BUILT)
    expect(sources).not.toContain(ASSIGNMENT_NOTE)
    expect(sources).not.toContain(CREDENTIAL_NOT_STORED)
  })

  test('the screen offers no password field while one cannot be stored safely', async () => {
    const sources = (await Promise.all(['index.tsx', 'parts/catalogue.tsx', 'parts/assignments.tsx', 'parts/runs.tsx'].map(readUi))).join('\n')
    expect(sources).not.toMatch(/type="password"/)
    expect(sources).not.toContain(PROXY_SECRET_KEY_PREFIX)
    // Control — the search is looking at the real dialog, which DOES have the
    // other upstream fields.
    expect(sources).toContain('pm-username')
    expect(sources).toContain('Upstream host')
  })
})

describe('the surface', () => {
  test('parses through PluginSurfaceSchema', () => {
    const parsed = PluginSurfaceSchema.safeParse(surfaceOf())
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  test('passes the same validatePluginSurface the farm runs at verify', () => {
    const checked = validatePluginSurface(surfaceOf())
    expect(checked.ok ? [] : checked.errors).toEqual([])
  })

  test('every nav entry names a view this surface declares, with an allowlisted icon', () => {
    const surface = surfaceOf()
    expect(surface.nav.length).toBe(1)
    for (const entry of surface.nav) {
      expect(Object.keys(surface.views)).toContain(entry.view)
      expect(ICON_NAMES).toContain(entry.icon)
    }
  })

  test('the view is tier C — a React module, and no declared renderer beside it', () => {
    const view = viewOf('proxies')
    expect(view.react).toEqual({ entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION })
    // `table` and `react` are mutually exclusive at verify; asserting it here
    // as well is what catches a half-finished revert that leaves both.
    expect(view.table).toBeUndefined()
  })

  test('the tier-A vocabulary is gone rather than left beside the React view', () => {
    // 00-overview §4.3: no weaker parallel path kept "for one release". A
    // tier-C view calls `fetch` directly (plan 111 §3.4), so this pack
    // declares no data source and no actions at all.
    const surface = surfaceOf()
    expect(surface.actions).toEqual({})
    expect(viewOf('proxies').data).toBeUndefined()
    expect(viewOf('proxies').toolbar).toEqual([])
    expect(viewOf('proxies').rowActions).toEqual([])
  })

  test('the entry the manifest names is the file the build will produce', async () => {
    // `enkaku publish` builds every top-level source file in `src/ui/` into
    // `ui/<name>.js`, so `index.tsx` is what makes `entry: 'index.js'` true.
    // A rename of one without the other publishes a package whose view 404s.
    expect(await Bun.file(join(HERE, 'ui', 'index.tsx')).exists()).toBe(true)
    expect(viewOf('proxies').react?.entry).toBe('index.js')
  })

  test('the stylesheet is named after the entry, which is what makes Studio link it', async () => {
    // Convention, not a manifest field (plan 111 step 111.9): `index.tsx` →
    // `index.css` → `ui/index.css` → the `<link>` the host injects.
    expect(await Bun.file(join(HERE, 'ui', 'index.css')).exists()).toBe(true)
  })

  test('the stylesheet imports utilities only — a second preflight would restyle Studio', async () => {
    const css = await Bun.file(join(HERE, 'ui', 'index.css')).text()
    expect(css).toContain("@import 'tailwindcss/utilities.css' layer(plugin);")
    expect(css).toContain("@import 'tailwindcss/theme.css' theme(reference);")
    expect(css).toContain("@import '@enkaku/ui/theme.css' theme(reference);")
    // The one DIRECTIVE that must never appear: it pulls in the global reset.
    // Anchored to the start of a line, because the file's own comment warns
    // against it by name and that warning is not an import.
    expect(css).not.toMatch(/^\s*@import\s+['"]tailwindcss['"]/m)
  })

  /**
   * The layer name is load-bearing and this assertion exists because the wrong
   * one shipped and was caught in a browser, not by a test (plan 111 §5 111.9's
   * correction block).
   *
   * `layer(utilities)` puts this sheet in the SAME layer as Studio's own
   * utilities. Same-named layers merge, and inside a layer document order
   * breaks ties — the host injects this `<link>` AFTER its own stylesheet, so
   * every collision at equal specificity went to the plugin. The observed
   * result: this pack emitted `.flex{display:flex}` (its markup uses `flex`),
   * which outranked Studio's `.lg\:hidden{display:none}` and un-hid Studio's
   * mobile header on a 1426 px screen. This file never mentioned `lg:hidden`.
   *
   * Paired assertion, so reverting the fix fails rather than passing quietly.
   */
  test('the stylesheet lands in the plugin layer, which Studio orders BELOW its own utilities', async () => {
    const css = await Bun.file(join(HERE, 'ui', 'index.css')).text()
    expect(css).toContain('layer(plugin)')
    expect(css).not.toContain('layer(utilities)')

    // Control: the order this depends on is declared by the host, and declared
    // BEFORE `utilities`. Without that line `plugin` would be appended last and
    // win again — the same bug with a different name, so assert position, not
    // mere presence.
    const globals = await Bun.file(join(HERE, '..', '..', '..', 'packages', 'studio', 'src', 'app', 'globals.css')).text()
    const order = globals.match(/@layer\s+([a-z,\s]+);/)?.[1] ?? ''
    const names = order.split(',').map((s) => s.trim())
    expect(names).toContain('plugin')
    expect(names.indexOf('plugin')).toBeLessThan(names.indexOf('utilities'))
  })

  test('the screen writes classes Studio does not have, or the stylesheet would be pointless', async () => {
    const source = await readUi('index.tsx')
    expect(source).toContain('bg-[repeating-linear-gradient(')
    expect(await readUi('parts/catalogue.tsx')).toContain('grid-cols-[max-content_1fr]')
  })

  test('the module registers the view id the manifest declares', async () => {
    const source = await readUi('index.tsx')
    expect(source).toContain("window.__enkaku__.register('proxies'")
    expect(Object.keys(surfaceOf().views)).toEqual(['proxies'])
  })
})

describe('the shape the screen writes is the shape a record is', () => {
  /**
   * The drift guard, moved rather than dropped (see `record.ts`'s header).
   * Tier A got this for free by deriving its form and its columns from one Zod
   * object; a hand-written React dialog gets it by funnelling every write
   * through `writeProxy` and every read through `readProxy`, and by this test
   * actually RUNNING both against the schema.
   */
  test('what the screen writes round-trips through what it reads, and parses as a ProxyRecord', () => {
    const typed = {
      label: 'Office UK',
      listen: { proto: 'http' as const, bindHost: '127.0.0.1', port: 9902 },
      upstream: { proto: 'socks5' as const, host: '10.4.0.9', port: 1080, username: 'country-id-r9931204' },
      enabled: false,
      logDestinations: false,
      maxConnections: DEFAULT_MAX_CONNECTIONS,
      drainMs: DEFAULT_DRAIN_MS,
      notes: 'expires in March',
    }
    const stored = writeProxy(typed)
    expect(Object.keys(stored)).toEqual(RECORD_FIELDS)
    const parsed = ProxyRecordSchema.safeParse(stored)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(readProxy(stored)).toEqual(typed)
  })

  test('a stored row this pack never wrote renders as blanks instead of throwing inside a table', () => {
    // A KV namespace is the plugin's own scratch space and an admin with
    // `kv.manage` can put anything under `proxy:`. A row that threw while
    // rendering would take the whole tab down through the error boundary.
    const fallback = readProxy({ nonsense: true })
    expect(Object.keys(fallback)).toEqual(RECORD_FIELDS)
    expect(fallback.upstream.proto).toBe('socks5')
    expect(readProxy(null).upstream.host).toBe('')
  })

  test('the browser half and the service half read a record through the SAME function', async () => {
    // The drift this pack has always guarded against, now across three
    // compiled halves instead of two. `api.ts` must delegate rather than
    // re-implement, because a second reader in the browser would disagree
    // with the one the core opens sockets on the strength of.
    const api = await Bun.file(join(HERE, 'ui', 'parts', 'api.ts')).text()
    expect(api).toContain('readProxyRecord')
    expect(api).toContain('writeProxyRecord')
    // …and it does not carry its own copy of the field list any more.
    expect(api).not.toMatch(/kind:\s*PROXY_KINDS\.find/)
  })

  test('the catalogue is read from the plugin’s own GLOBAL storage, under the proxy: prefix', async () => {
    // Global because a proxy catalogue is not a fact about one phone — plan
    // 108 §3.1: if forgetting the device should forget the fact, it is
    // device-scoped. Forgetting a phone must not empty this table.
    const source = await readUi('parts/catalogue.tsx')
    expect(source).toContain('/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}')
    expect(source).toContain("scope: 'global'")
    expect(PROXY_KEY_PREFIX).toBe('proxy:')
  })

  test('an assignment is device-scoped, because forgetting the phone SHOULD forget it', async () => {
    const source = await readUi('parts/assignments.tsx')
    expect(source).toContain("scope: 'device'")
    expect(source).toContain('key: ASSIGNMENT_KEY')
    expect(ASSIGNMENT_KEY).toBe('assigned')
  })

  test('the transport is a closed list, so no row can hold "socks 5"', () => {
    const proto = ProxyRecordSchema.shape.upstream.unwrap().shape.proto
    expect(proto.safeParse('socks 5').success).toBe(false)
    for (const kind of PROXY_KINDS) expect(proto.safeParse(kind).success).toBe(true)
    // And every one of them has a label the screen can show — a missing entry
    // here renders `undefined` in a badge.
    expect(Object.keys(PROXY_KIND_LABELS).sort()).toEqual([...PROXY_KINDS].sort())
  })

  test('the service is declared, with nothing it does not need', () => {
    const service = plugin.service
    if (!service) throw new Error('the pack declares no service — plan 112 step 112.7 is what makes this pack run anything')
    // `permissions: []` is what keeps plan 109 step 109.3's capability broker
    // off this plan's critical path (plan 112 §4.5). A permission appearing
    // here is a new line in the operator's install consent, and should be a
    // decision rather than a drive-by.
    expect(service.permissions).toEqual([])
    expect(service.events).toEqual([])
    expect(service.isolation).toBe('in-process')
    // The listener is DECLARED as a shape, not reserved — and it does not
    // claim device reachability, which is step 112.11 and plan 109 steps
    // 109.9–109.11.
    expect(service.listeners.length).toBe(1)
    expect(service.listeners[0]?.id).toBe('proxy-bridge')
    expect(service.listeners[0]?.proto).toBe('tcp')
    expect(service.listeners[0]?.deviceReachable).toBe(false)
    expect(service.listeners[0]?.port).toBeUndefined()
  })

  test('the storage key is not one of the record’s fields, and the rule about it is still stated', () => {
    // A rename is structurally impossible: the write upserts and cannot move
    // an entry, so the Edit dialog disables the key rather than offering one.
    expect(RECORD_FIELDS).not.toContain('key')
    expect(PROXY_KEY_HINT).toContain(PROXY_KEY_PREFIX)
    expect(PROXY_KEY_HINT).toMatch(/still saved, but will not appear/)
  })
})

/**
 * ## The credential gap, kept visible until step 112.2 closes it
 *
 * This pack is the first thing in the repo that wants to put a real credential
 * in KV, and the store leaks part of every secret onto the row's own `hint`
 * column — `list()` keeps it, and every HTTP path returns it, to anyone who
 * holds `plugin.data` (plan 112 F12). There is no way to turn it off. Step
 * 112.2 adds `hint?: boolean`; it is **not built**.
 *
 * So the pack does not write the key, the dialog offers no password field, and
 * the tests below fail the day 112.2 lands — which is the point. A gap that
 * only lives in a comment is a gap that gets forgotten; a gap with a red test
 * attached is a gap somebody has to walk past.
 *
 * They assert against the CORE's own source rather than importing it, because
 * a plugin has no dependency on `enkaku-core` and should not grow one for a
 * temporary guard. Each claim carries the two controls plan 109 step 109.5
 * requires: that the thing being looked for is real, and that the detector
 * would see the fix if it were there.
 */
describe('step 112.2 is not built, and the credential is not safe to store yet', () => {
  const REPO = join(HERE, '..', '..', '..')
  const SECRETS_STORE = join(REPO, 'packages', 'core', 'src', 'secrets', 'store.ts')
  const KV_STORE = join(REPO, 'packages', 'core', 'src', 'kv', 'store.ts')

  /** Reading the core's source is the whole mechanism; a missing file must fail loudly, never skip. */
  async function coreSource(path: string): Promise<string> {
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`this guard reads the core's own source and could not find ${path} — if the file MOVED, move this test with it; do not delete it`)
    return await file.text()
  }

  /** Does `KvSetOptions` carry the `hint` flag step 112.2 adds? */
  function hasHintOption(source: string): boolean {
    const start = source.indexOf('export interface KvSetOptions')
    if (start === -1) throw new Error("`KvSetOptions` is no longer declared in packages/core/src/kv/store.ts — this guard's anchor moved")
    const body = source.slice(start, source.indexOf('}', start))
    return /\bhint\??\s*:/.test(body)
  }

  test('control 1 — the leak is real: `secretHint` still returns the first seven and the last four characters', async () => {
    const source = await coreSource(SECRETS_STORE)
    expect(source).toContain('export function secretHint(plaintext: string): string')
    expect(source).toContain('plaintext.slice(0, 7)')
    expect(source).toContain('plaintext.slice(-4)')
    // And `shared.ts`'s reimplementation of it agrees, so the measurement
    // below is of the real algorithm rather than of a guess about it.
    expect(secretHintLeak('sk-ant-api03-abcdefgh7Xq2')).toBe('sk-ant-…7Xq2')
    expect(secretHintLeak('short')).toBe('••••')
  })

  test('control 2 — the detector would see the fix: a synthetic fixed `KvSetOptions` reads as fixed', () => {
    const fixed = 'export interface KvSetOptions {\n  secret?: boolean\n  hint?: boolean\n  ttlSec?: number\n}'
    expect(hasHintOption(fixed)).toBe(true)
    const unfixed = 'export interface KvSetOptions {\n  secret?: boolean\n  ttlSec?: number\n}'
    expect(hasHintOption(unfixed)).toBe(false)
  })

  test('THE CLAIM — `hint: false` does not exist, so this pack must not store a credential yet', async () => {
    expect(hasHintOption(await coreSource(KV_STORE))).toBe(false)
    // `secretHint` is still called unconditionally for every secret write.
    expect(await coreSource(KV_STORE)).toContain('const hint = secret ? secretHint(')
  })

  test('what a stored credential would actually leak, measured rather than asserted', async () => {
    // The store hints the JSON when the value is not a string, so the object
    // shape is a mitigation and a bare string would be far worse. Measured
    // against the real farm on 2026-08-17: writing `{"password":"Sup3r…"}`
    // with `secret: true` produced `hint: '{"passw…rd"}'`.
    const password = 'Sup3rSecretUpstreamPassword'
    const asObject = secretHintLeak({ password })
    const asString = secretHintLeak(password)
    expect(asObject).toBe('{"passw…rd"}')
    expect(asString).toBe('Sup3rSe…word')
    // The object form leaks the tail of the password and the string form leaks
    // both ends of it. Neither is acceptable; one is much worse.
    expect(asString).toContain(password.slice(0, 7))
    expect(asObject).not.toContain(password.slice(0, 7))
    void (await coreSource(SECRETS_STORE))
  })

  test('so nothing in this pack writes the secret key, and the copy says why', async () => {
    const sources = [
      await Bun.file(join(HERE, 'index.ts')).text(),
      await Bun.file(join(HERE, 'service', 'supervisor.ts')).text(),
      await readUi('parts/catalogue.tsx'),
    ].join('\n')
    // The supervisor READS it — a credential written by hand, or by a later
    // step, must work — and nothing WRITES it.
    expect(sources).toContain('proxySecretKeyFor')
    expect(sources).not.toMatch(/data\/entry[\s\S]{0,400}proxy-secret/)
    expect(proxySecretKeyFor('x')).toBe('proxy-secret:x')
    expect(CREDENTIAL_NOT_STORED).toMatch(/not built/)
  })
})
