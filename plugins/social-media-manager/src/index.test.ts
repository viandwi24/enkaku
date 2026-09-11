import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import plugin, { partialNote, settleJob } from './index'
import addPost from './add-post'
import retryFailed from './retry-failed'
import addPosts from './add-posts'
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
    expect(plugin.version).toBe('0.5.0')
    expect(plugin.version).toBe(pkg.version)
  })

  test('every member is presentable in Studio', () => {
    expect(plugin.scripts.map((s) => s.id)).toEqual(['add-post', 'retry-failed', 'add-posts'])
    // Typed against the members themselves rather than the manifest's erased
    // `ScriptDefinition`, which drops `title`/`description` from the type.
    const members: Array<{ id: string; title?: string; description?: string }> = [addPost, retryFailed, addPosts]
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

  test('a service exists — the Platforms view is a handler source and cannot render without one', () => {
    expect(plugin.service).toBeDefined()
  })
})

describe('the surface', () => {
  const surface = plugin.surface!

  test('both nav entries name a view that exists', () => {
    for (const entry of surface.nav) {
      expect(Object.keys(surface.views)).toContain(entry.view)
    }
  })

  test('the Posts view reads the same prefix the router writes', () => {
    // Two readers of one constant. A literal here instead would be the classic
    // way a screen quietly goes empty: the router writes `post:` and the table
    // lists `posts:`, and nothing anywhere fails.
    expect(surface.views.posts?.data).toEqual({ kind: 'kv.list', scope: 'global', prefix: POST_PREFIX })
  })

  test('every platform has its own column in the Posts table', () => {
    const fields = (surface.views.posts?.table?.columns ?? []).map((c) => c.field)
    for (const platform of PLATFORMS) {
      expect(fields).toContain(`dispatch.${platform.id}.state`)
    }
  })

  test('the manual post action targets the same member the platform table names', () => {
    const action = surface.actions.postToTikTokNow
    expect(action?.kind).toBe('batch')
    // The one place the manual path and the router could drift apart. Read
    // through the registry rather than restated, so renaming the member in
    // `platforms.ts` and forgetting the button is a failure here.
    const script = PLATFORMS.find((p) => p.id === 'tiktok')?.script
    expect(script).not.toBeNull()
    expect(action?.kind === 'batch' && action.script).toBe(script as string)
  })

  test('the manual post action asks for confirmation — it publishes to a real account', () => {
    const action = surface.actions.postToTikTokNow
    expect(action?.kind === 'batch' && action.confirm).toBeTruthy()
  })

  test('there is NO manual action for a platform that cannot post', () => {
    // An affordance that always fails is worse than none. If someone adds an
    // Instagram button, this fails until Instagram genuinely has a flow.
    const scripts = Object.values(surface.actions)
      .map((a) => (a.kind === 'batch' || a.kind === 'job' ? a.script : null))
      .filter((s): s is string => s !== null)
    for (const platform of PLATFORMS) {
      if (platform.script !== null) continue
      expect(scripts.some((s) => s.startsWith(`${platform.id}/`))).toBe(false)
    }
  })

  test('New post writes through the member, because a binding cannot build the key', () => {
    const action = surface.actions.addPost
    expect(action?.kind).toBe('form')
    expect(action?.kind === 'form' && action.then.kind).toBe('job')
    expect(action?.kind === 'form' && action.then.kind === 'job' && action.then.script).toBe('smm/add-post@latest')
  })

  test('the New post form offers exactly the declared platforms', () => {
    const action = surface.actions.addPost
    const schema = action?.kind === 'form' ? (action.schema as Record<string, any>) : null
    expect(schema?.properties?.platforms?.items?.enum).toEqual(PLATFORMS.map((p) => p.id))
  })

  test('Remove deletes by the entry key, needing no script at all', () => {
    const action = surface.actions.removePost
    expect(action?.kind).toBe('kv.delete')
    expect(action?.kind === 'kv.delete' && action.key).toEqual({ $entry: 'key' })
  })

  test('the auto-post form writes every field its stored schema requires', () => {
    // `AutoPostSettingsSchema` is `.strict()`, so a form that omits `version`
    // stores a row the service then refuses to read — and, failing closed,
    // silently stops auto-posting. That is the defect this pins.
    const action = surface.actions.autoPostSettings
    const value = action?.kind === 'form' && action.then.kind === 'kv.set' ? (action.then.value as Record<string, unknown>) : null
    expect(Object.keys(value ?? {}).sort()).toEqual(['enabled', 'intervalMinutes', 'maxDevicesPerPlatform', 'version'])
  })
})

/**
 * The bulk builder (0.4.0). Its whole reason is the hundred-device farm:
 * `add-post` takes one video, and twenty videos meant twenty trips through
 * the same dialog.
 */
describe('the bulk builder', () => {
  const surface = plugin.surface!
  // Through `unknown`: `ActionSpec` is a union whose `schema` is the whole
  // `JsonSchemaNode`, and asserting the two fields this test reads is not a
  // narrowing the compiler can check.
  const action = surface.actions.addManyPosts as unknown as {
    kind: string
    schema: { required: string[]; properties: Record<string, { 'x-enkaku'?: { kind?: string } }> }
    then: { script: string; params: Record<string, unknown> }
  }

  test('it is offered on the Posts toolbar beside the single-video form', () => {
    expect(surface.views.posts?.toolbar).toContain('addManyPosts')
    expect(surface.views.posts?.toolbar).toContain('addPost')
  })

  test('the videos field is an artifact MULTI-picker, not a text box of ids', () => {
    expect(action.schema.properties.videoArtifactIds?.['x-enkaku']?.kind).toBe('artifactIds')
    expect(action.schema.properties.deviceIds?.['x-enkaku']?.kind).toBe('deviceIds')
  })

  /*
    Phones are deliberately NOT required: empty means "any phone carrying the
    platform's label", which is the whole point on a fleet that grows.
  */
  test('videos, captions and platforms are required; phones are not', () => {
    expect(action.schema.required.sort()).toEqual(['captions', 'platforms', 'videoArtifactIds'])
  })

  test('every form field reaches the member it submits to', () => {
    expect(action.then.script).toBe('smm/add-posts@latest')
    expect(Object.keys(action.then.params).sort()).toEqual(['captions', 'deviceIds', 'platforms', 'videoArtifactIds'])
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
