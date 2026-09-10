import { describe, expect, test } from 'bun:test'
import plugin from './index'
import addPost from './add-post'
import retryFailed from './retry-failed'
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
    expect(plugin.version).toBe('0.3.2')
    expect(plugin.version).toBe(pkg.version)
  })

  test('both members are presentable in Studio', () => {
    expect(plugin.scripts.map((s) => s.id)).toEqual(['add-post', 'retry-failed'])
    // Typed against the members themselves rather than the manifest's erased
    // `ScriptDefinition`, which drops `title`/`description` from the type.
    const members: Array<{ id: string; title?: string; description?: string }> = [addPost, retryFailed]
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
