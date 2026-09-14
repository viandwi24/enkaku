import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import plugin, { partialNote, settleJob } from './index'
import addPost from './add-post'
import retryFailed from './retry-failed'
import addPosts from './add-posts'
import addGroup from './add-group'
import startGroup from './start-group'
import retryGroup from './retry-group'
import updatePost from './update-post'
import { PLATFORMS } from './platforms'
import { POST_PREFIX } from './posts'

/**
 * Importing `./index` at the top of this file is itself the most valuable
 * assertion here: `definePlugin` runs `validatePluginSurface` at import time,
 * so an unknown icon, a nav entry naming a missing view, an action reference
 * naming a missing action, a bad script ref or an unknown key in any of it
 * throws before a single test body runs. Everything below is what that check
 * cannot see.
 */

describe('social-media-manager manifest', () => {
  test('identity is stable', () => {
    expect(plugin.id).toBe('smm')
    expect(plugin.title).toBe('Social Media Manager')
  })

  /** The three-site version bump: `package.json`, `src/index.ts`, and this assertion. */
  test('version matches package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
    expect(plugin.version).toBe('0.17.0')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every member is presentable in Studio', () => {
    expect(plugin.scripts.map((s) => s.id)).toEqual(['add-post', 'retry-failed', 'add-posts', 'add-group', 'start-group', 'retry-group', 'update-post'])
    // Typed against the members themselves rather than the manifest's erased
    // `ScriptDefinition`, which drops `title`/`description` from the type.
    const members: Array<{ id: string; title?: string; description?: string }> = [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost]
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
    for (const member of members) {
      expect({ id: member.id, titled: (member.title ?? '').length > 0 }).toEqual({ id: member.id, titled: true })
      expect({ id: member.id, described: (member.description ?? '').length > 0 }).toEqual({ id: member.id, described: true })
    }
  })
})

describe('the service declaration', () => {
  test('permissions are exactly what the router calls — no more', () => {
    // Exhaustive by design: this list is what the operator is shown and
    // consents to at install, so a permission asked for and never used is one
    // they granted for nothing.
    expect(plugin.service?.permissions).toEqual(['device.list', 'job.run', 'job.get'])
  })

  test('a service exists — the router is a timer and cannot run without one', () => {
    expect(plugin.service).toBeDefined()
  })
})

/**
 * The surface is ONE screen (0.9.0). The owner's verdict on the three it used
 * to be — posts, sessions, platforms — was that three menus for one job is
 * three places to get lost, and the job is a single sequence: upload a folder,
 * spread it over the phones, watch it. These tests pin the shape of that
 * decision, not the contents of the page (which is React and has no tests, by
 * `docs/plans/200-mvp-program.md` §8.3).
 */
describe('the surface', () => {
  const surface = plugin.surface!

  test('one nav entry, one view, and the entry names it', () => {
    expect(surface.nav).toHaveLength(1)
    expect(Object.keys(surface.views)).toEqual(['posts'])
    expect(surface.nav[0]?.view).toBe('posts')
  })

  test('the view is drawn by this plugin, not declared as a table', () => {
    const view = surface.views.posts
    // Tier C. The page computes answers WHILE the operator decides — how many
    // phones this choice reaches, how long the pacing will take, a caption per
    // file name — and a declared table can render a stored row and nothing else.
    expect(view?.react?.entry).toBe('index.js')
    expect(view?.data).toBeUndefined()
    expect(view?.table).toBeUndefined()
  })

  test('no declared actions — the page owns every write', () => {
    // A tier-A action is a button a declared table puts on a row or a toolbar.
    // With no table there is nothing to put them on, and an action nothing can
    // render is a control that does not exist pretending to.
    expect(Object.keys(surface.actions)).toEqual([])
  })

  test('the page still reads the prefix the router writes', () => {
    // Two readers of one constant, now across the UI boundary: `ui/shared.ts`
    // lists `post:` rows and the router writes them. The literal is asserted
    // here because the browser bundle cannot import this module.
    expect(POST_PREFIX).toBe('post:')
  })

  test('every platform the page offers is one the router knows', async () => {
    const shared = (await Bun.file(new URL('./ui/shared.ts', import.meta.url)).text()) as string
    for (const platform of PLATFORMS) {
      // The page's own list is a literal in the browser bundle; this is what
      // stops it drifting from `platforms.ts` — a platform the page offers and
      // the router cannot route is a post that silently never sends.
      expect(shared).toContain(`id: '${platform.id}'`)
    }
  })
})

/**
 * The "deviceIds: required" bug, pinned.
 *
 * Both post members declare `deviceIds` as the field an operator may leave
 * empty — empty means "any phone carrying the label". Written as
 * `.default([])` it still landed in the generated JSON Schema's `required`
 * list, so the job was refused before the member ever ran, on a field whose
 * whole point is being optional. It cost a real form submission to find, and
 * nothing in the type system would have caught it.
 */
describe('the optional fields are actually optional in the generated schema', () => {
  for (const member of [addPost, addPosts]) {
    test(`${member.id} does not demand deviceIds`, () => {
      const json = z.toJSONSchema(member.params, { io: 'input' }) as { required?: string[]; properties?: Record<string, unknown> }
      // Present as a field...
      expect(Object.keys(json.properties ?? {})).toContain('deviceIds')
      // ...and never demanded.
      expect(json.required ?? []).not.toContain('deviceIds')
    })
  }
})

describe('settleJob — a green job is a post only when the script says so', () => {
  test('the measured false positive: success + unverified is unverified', () => {
    const settled = settleJob({ status: 'success', result: { outcome: 'unverified', reason: 'after 30s no readable video grid was found' } })
    expect(settled).toEqual({ state: 'unverified', error: 'after 30s no readable video grid was found' })
  })

  test('posted is a success', () => {
    expect(settleJob({ status: 'success', result: { outcome: 'posted', reason: null } })).toEqual({ state: 'success', error: null })
  })

  test('a script that walked away without posting is a retryable failure', () => {
    expect(settleJob({ status: 'success', result: { outcome: 'failed', reason: 'E_UPLOAD_BUTTON' } })).toEqual({ state: 'failed', error: 'E_UPLOAD_BUTTON' })
    expect(settleJob({ status: 'success', result: { outcome: 'skipped' } })?.state).toBe('failed')
  })

  test('a script with no verdict is judged by its job status, as before', () => {
    expect(settleJob({ status: 'success', result: null })).toEqual({ state: 'success', error: null })
    expect(settleJob({ status: 'failed', error: 'timed out' })).toEqual({ state: 'failed', error: 'timed out' })
    expect(settleJob({ status: 'running' })).toBeNull()
  })
})

describe('partialNote', () => {
  test('unverified phones are named and kept out of the retry', () => {
    const note = partialNote(0, 1, 1)
    expect(note).toContain('1 unverified')
    expect(note).toContain('re-sends to those 1 only')
    expect(note).toContain('not retried automatically')
  })

  test('without unverified phones it reads as before', () => {
    expect(partialNote(1, 1, 0)).toBe('1 posted, 1 failed. "Re-run failed" re-sends to those 1 only — the ones that posted are left alone.')
  })
})
