import { afterEach, describe, expect, test } from 'bun:test'
import * as ui from './index'
import { coreBase, setCoreBase } from './lib/core-base'

/**
 * The guard that would have caught plan 111's one broken promise.
 *
 * §3.3 said `@enkaku/ui` carried a behaviour layer beyond the components;
 * 111.1 shipped the components and `cn`, the document was not corrected, and
 * the gap surfaced only when a real plugin author (111.7) went looking for
 * imports that were not there. Nothing in the workspace would have failed.
 *
 * These names are also **the plugin-facing surface by construction**:
 * `plugin-host.ts` builds its import-map shim from `Object.keys()` of this
 * exact namespace, so a name dropped here is a name a plugin's
 * `import { api } from '@enkaku/ui'` stops resolving — at runtime, in an
 * operator's browser, in a package the farm has already accepted.
 */
describe('the barrel keeps the behaviour layer §3.3 promises', () => {
  const REQUIRED = [
    // The three list states, and the confirmation. A plugin screen BEHAVES
    // like a Studio screen because of these, not because of its buttons.
    'EmptyState',
    'ErrorState',
    'LoadingRows',
    'ConfirmDialog',
    // Reaching the farm.
    'api',
    'useAction',
    'coreBase',
    'setCoreBase',
    'describeApiError',
    'issuesFromError',
    'BadResponseError',
    // `api()`'s schema argument is required, so Zod has to be reachable or
    // `api()` is unusable from a plugin that has no Zod of its own.
    'z',
    // Reading a value the way the rest of the farm reads it.
    'relativeTime',
    'duration',
    'fileSize',
    'formatFieldValue',
    'formatTokens',
    'formatUsd',
    // The one helper 111.1 did ship.
    'cn',
    // Naming a device, and finding one (plan 124 §4.1–§4.3). These are on the
    // list for the same reason as everything above it: a plugin's tab names
    // devices, and if these three stop resolving from `@enkaku/ui` the plugin
    // does not fail to build — it fails in an operator's browser, on a farm
    // that has already accepted the package.
    'formatDeviceName',
    'deviceSearchTerms',
    'matchesDeviceQuery',
    'DeviceName',
    'Combobox',
  ] as const

  for (const name of REQUIRED) {
    test(`exports \`${name}\``, () => {
      expect(name in ui).toBe(true)
      expect((ui as Record<string, unknown>)[name]).toBeDefined()
    })
  }

  test('`z` is Zod itself, not a stub', () => {
    expect(typeof ui.z.object).toBe('function')
    expect(ui.z.string().safeParse('x').success).toBe(true)
  })
})

describe('coreBase', () => {
  afterEach(() => setCoreBase(null))

  test('an explicit base wins over everything, trailing slash trimmed', () => {
    setCoreBase('http://farm.example/')
    expect(coreBase()).toBe('http://farm.example')
  })

  test('setCoreBase(null) restores the derived answer', () => {
    setCoreBase('http://farm.example')
    setCoreBase(null)
    expect(coreBase()).not.toBe('http://farm.example')
  })

  /**
   * `"null"` is the OPAQUE origin — a `file:` document, a sandboxed iframe,
   * and happy-dom's default. It is a string, so a naive `location.origin`
   * read produces the base `null`, and every request becomes
   * `GET null/api/…`. That is exactly why nearly fifty of Studio's component
   * tests mocked `coreBase` before this moved here; the guard makes the mock
   * unnecessary rather than merely conventional.
   */
  test('an opaque origin is not a base — it falls through to the dev default', () => {
    expect(globalThis.location?.origin).toBe('null')
    expect(coreBase()).toBe('http://localhost:7700')
  })
})
