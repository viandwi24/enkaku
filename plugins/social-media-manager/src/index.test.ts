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
import resolveAttempt from './resolve-attempt'
import { PLATFORMS } from './platforms'
import { POST_PREFIX, RESULT_UNREADABLE } from './posts'

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
    expect(plugin.version).toBe('0.23.0')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every member is presentable in Studio', () => {
    expect(plugin.scripts.map((s) => s.id)).toEqual(['add-post', 'retry-failed', 'add-posts', 'add-group', 'start-group', 'retry-group', 'update-post', 'resolve-attempt'])
    // Typed against the members themselves rather than the manifest's erased
    // `ScriptDefinition`, which drops `title`/`description` from the type.
    const members: Array<{ id: string; title?: string; description?: string }> = [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost, resolveAttempt]
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
    for (const member of members) {
      expect({ id: member.id, titled: (member.title ?? '').length > 0 }).toEqual({ id: member.id, titled: true })
      expect({ id: member.id, described: (member.description ?? '').length > 0 }).toEqual({ id: member.id, described: true })
    }
  })

  test('every member parameter description fits the farm\'s 300-character limit', () => {
    // The farm refuses a longer one at install, which no typecheck can see.
    for (const member of [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost, resolveAttempt]) {
      const json = z.toJSONSchema(member.params, { io: 'input' }) as { properties?: Record<string, { description?: string }> }
      for (const [name, property] of Object.entries(json.properties ?? {})) {
        expect({ member: member.id, name, length: (property.description ?? '').length <= 300 }).toEqual({ member: member.id, name, length: true })
      }
    }
  })
})

describe('resolve-attempt — the hand-mark member', () => {
  test('takes the three actions, and every selector but the video and platform is optional', () => {
    const json = z.toJSONSchema(resolveAttempt.params, { io: 'input' }) as { required?: string[]; properties?: Record<string, { enum?: string[] }> }
    expect(json.properties?.action?.enum).toEqual(['mark-posted', 'unmark-posted', 'mark-failed'])
    expect([...(json.required ?? [])].sort()).toEqual(['platform', 'videoArtifactId'])
  })

  test('still accepts the 0.21.0 call shape', () => {
    const parsed = resolveAttempt.params.safeParse({ videoArtifactId: 'v', platform: 'instagram', deviceId: 'd1', jobId: 'j1', resolution: 'posted' })
    expect(parsed.success).toBe(true)
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

/**
 * The mapping from a finished job to an attempt, one test per row of `settleJob`'s table (0.21.0).
 * The owner's requirement: the report must be accurate — an error says error, with the text a tester
 * needs to retry by themselves.
 */
describe('settleJob — the exact mapping from a finished job to an attempt', () => {
  test('a failed (thrown) job is failed, with the job\'s error verbatim', () => {
    const error = 'E_SECURITY_CHECK: TikTok is showing a security check on the profile — complete it by hand, then retry'
    expect(settleJob({ status: 'failed', error })).toEqual({ state: 'failed', error })
  })

  test('a failed job with no error of its own falls back to the result\'s reason, then to a sentence — never a blank', () => {
    expect(settleJob({ status: 'failed', error: null, result: { outcome: 'failed', reason: 'no upload button' } })).toEqual({ state: 'failed', error: 'no upload button' })
    const bare = settleJob({ status: 'failed', error: null })
    expect(bare?.state).toBe('failed')
    expect(bare?.error).toContain('without an error message')
  })

  test('a failed job keeps its own error even when finish() returned a failed outcome (the TikTok shape)', () => {
    // `tiktok/post-video`'s finish() returns `{ outcome: 'failed', reason: ctx.error.message }` after run() threw;
    // the core settles that job `failed` with the thrown message as `error` and the return as a partial result.
    const settled = settleJob({ status: 'failed', error: 'E_UPLOAD_BUTTON: no Post button', result: { outcome: 'failed', reason: 'E_UPLOAD_BUTTON: no Post button' } })
    expect(settled).toEqual({ state: 'failed', error: 'E_UPLOAD_BUTTON: no Post button' })
  })

  test('a failed job whose script had ALREADY said posted or unverified is not confirmed — a retry could post twice', () => {
    const posted = settleJob({ status: 'failed', error: 'process exited during finish', result: { outcome: 'posted' } })
    expect(posted?.state).toBe('unverified')
    expect(posted?.error).toContain('already reported the post as done')
    expect(posted?.error).toContain('process exited during finish')
    const unsure = settleJob({ status: 'failed', error: null, result: { outcome: 'unverified', reason: 'profile unreadable' } })
    expect(unsure?.state).toBe('unverified')
    expect(unsure?.error).toContain('could not confirm')
  })

  test('a cancelled job is failed, and says it was cancelled', () => {
    expect(settleJob({ status: 'cancelled', error: null })).toEqual({ state: 'failed', error: 'The job was cancelled before it finished.' })
    expect(settleJob({ status: 'cancelled', error: 'cancelled (no executor was running)' })).toEqual({
      state: 'failed',
      error: 'The job was cancelled before it finished: cancelled (no executor was running)',
    })
  })

  test('an expired job is failed, and says it expired', () => {
    expect(settleJob({ status: 'expired', error: null })).toEqual({ state: 'failed', error: 'The job expired before a phone ran it.' })
  })

  test('a SUCCEEDED job whose result is outcome "failed" is failed, with the result\'s reason', () => {
    expect(settleJob({ status: 'success', result: { outcome: 'failed', reason: 'E_UPLOAD_BUTTON' } })).toEqual({ state: 'failed', error: 'E_UPLOAD_BUTTON' })
    expect(settleJob({ status: 'success', result: { outcome: 'skipped', reason: 'nothing pending' } })).toEqual({ state: 'failed', error: 'nothing pending' })
    expect(settleJob({ status: 'success', result: { outcome: 'failed' } })?.error).toContain('without saying why')
  })

  test('outcome "posted" is a success', () => {
    expect(settleJob({ status: 'success', result: { outcome: 'posted', reason: null } })).toEqual({ state: 'success', error: null })
  })

  test('outcome "unverified" is unverified, keeping the reason — the measured Instagram and TikTok case', () => {
    const settled = settleJob({ status: 'success', result: { outcome: 'unverified', reason: 'after 30s no readable video grid was found' } })
    expect(settled).toEqual({ state: 'unverified', error: 'after 30s no readable video grid was found' })
    expect(settleJob({ status: 'success', result: { outcome: 'unverified' } })?.error).toContain('could not confirm')
  })

  test('a success with no readable outcome is unverified, saying the result could not be read — never a success', () => {
    for (const result of [null, undefined, {}, 'done', { outcome: 3 }]) {
      expect(settleJob({ status: 'success', result })).toEqual({ state: 'unverified', error: RESULT_UNREADABLE })
    }
    expect(RESULT_UNREADABLE).toContain('could not be read')
  })

  test('an outcome this build does not know is unverified, naming it', () => {
    const settled = settleJob({ status: 'success', result: { outcome: 'scheduled', reason: 'posts at 18:00' } })
    expect(settled?.state).toBe('unverified')
    expect(settled?.error).toContain('"scheduled"')
    expect(settled?.error).toContain('posts at 18:00')
  })

  test('a job still in flight has no answer yet', () => {
    expect(settleJob({ status: 'queued' })).toBeNull()
    expect(settleJob({ status: 'running' })).toBeNull()
  })

  test('a long error is kept up to the attempt\'s limit, not cut at 300', () => {
    const error = 'x'.repeat(700)
    expect(settleJob({ status: 'failed', error })?.error).toBe(error)
  })
})

describe('partialNote', () => {
  test('not-confirmed phones are named, kept out of the retry, and told how to settle', () => {
    const note = partialNote(0, 1, 1)
    expect(note).toBe(
      '1 failed, 1 not confirmed. "Retry failed" sends it again to the phone that failed only — the ones that posted are left alone. Check the account that was not confirmed on the phone, then mark it as posted or failed — it is never re-sent on its own.',
    )
  })

  test('without not-confirmed phones it names only the retry', () => {
    expect(partialNote(1, 2, 0)).toBe('1 posted, 2 failed. "Retry failed" sends it again to those 2 only — the ones that posted are left alone.')
  })
})
