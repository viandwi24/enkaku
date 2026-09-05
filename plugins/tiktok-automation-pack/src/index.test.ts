import { describe, expect, test } from 'bun:test'
import type { ActionSpec, PluginSurface, Selector } from '@enkaku/protocol'
import { PluginSurfaceSchema, validatePluginSurface } from '@enkaku/protocol'
import type { z } from 'zod'
import plugin, { autoScrollScript, matches, scoreContent } from './index'
import { makeRng, pickWatchMs, pngSize } from './human'
import { ACK_SELECTORS, DENY_SELECTORS, nextDialogAction } from './dialogs'
import { ACCOUNTS_KEY } from './accounts'
import switchAccount from './switch-account'
import searchFollow from './search-follow'
import listAccounts from './list-accounts'
import postVideo from './post-video'
import enqueueVideo from './enqueue-video'
import searchKeyword from './search-keyword'
import keywordVideos from './keyword-videos'
import liveBrowse from './live-browse'
import shopBrowse from './shop-browse'
import notificationActivity from './notification-activity'

/** The three-site version bump `CLAUDE.md` requires: `package.json`, `src/index.ts`, and this assertion. */
describe('tiktok-automation-pack manifest', () => {
  test('version matches package.json', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
    expect(plugin.version).toBe('1.18.0')
    expect(plugin.version).toBe(pkg.version)
  })
})

/**
 * Plan 97 §3.2, §5 step 97.8's own verifiable result — every member's
 * declared `result` schema accepts the real shape its `run()` returns.
 * `switch-account`/`search-follow` are unit-tested by parsing exactly what
 * their own `run()` bodies construct (`switch-account.ts:427-433`,
 * `search-follow.ts:345-357`/`378-392`); `auto-scroll`'s is the H3 worked
 * example (`index.ts:597+`).
 */
describe('plan 97 — declared result schemas accept what each script actually returns', () => {
  // `Plugin.scripts: ScriptDefinition[]` erases each member's own `R` (the
  // array itself is deliberately homogeneous — see `plugin.ts`'s own
  // `PluginMemberScripts<S>` doc comment on why a member's `result` type is
  // proven at its own `const` declaration, not recovered from this array).
  // This helper is the runtime-only bridge back to a concrete Zod schema for
  // a TEST, which needs no static type from the array position at all.
  function resultSchemaOf(id: string): z.ZodTypeAny {
    const s = plugin.scripts.find((x) => x.id === id)
    if (!s) throw new Error(`no such member: ${id}`)
    if (!s.result) throw new Error(`member "${id}" declares no result schema`)
    return s.result as z.ZodTypeAny
  }

  test('auto-scroll — thirteen fields, twelve scalars and one Record<string, number>', () => {
    const sample = {
      videos: 312,
      watchSeconds: 2520,
      meanWatchSeconds: 8,
      byLabel: { skim: 100, full: 212 },
      backScrolls: 5,
      idlePauses: 2,
      recoveries: 0,
      matched: 40,
      commentVisits: 12,
      unreadable: 1,
      endedOnStall: false,
      dialogSweeps: 0,
      seed: 123456,
    }
    const result = resultSchemaOf('auto-scroll')
    expect(result.safeParse(sample).success).toBe(true)
  })

  test('switch-account — the shape `run()` actually constructs', () => {
    const sample = { from: 'alice', to: 'bob', position: 2, accounts: ['alice', 'bob'], verified: true }
    const result = resultSchemaOf('switch-account')
    expect(result.safeParse(sample).success).toBe(true)
  })

  test('list-accounts — the shape `run()` actually constructs (plan 108 step 108.11)', () => {
    const sample = { accounts: ['alice', 'bob'], count: 2, current: 'alice', currentEvidence: 'confirmed', readAt: 1_776_000_000 }
    expect(resultSchemaOf('list-accounts').safeParse(sample).success).toBe(true)
  })

  test('search-follow — both branches `run()` can return (already-following, and freshly followed)', () => {
    const alreadyFollowing = {
      query: 'trading',
      target: 'alice',
      matchDisplayName: false,
      handle: 'alice',
      displayName: 'Alice',
      followers: 1200,
      followersLabel: '1.2K',
      alreadyFollowing: true,
      verified: true,
      seed: 1,
      handlesSeen: ['alice', 'bob'],
    }
    const freshlyFollowed = { ...alreadyFollowing, alreadyFollowing: false, followButtonBefore: 'Follow', followButtonAfter: 'Following' }
    const result = resultSchemaOf('search-follow')
    expect(result.safeParse(alreadyFollowing).success).toBe(true)
    expect(result.safeParse(freshlyFollowed).success).toBe(true)
  })
})

/**
 * Plan 108 §4.3, step 108.11 — the pack is this plan's proving vehicle, so the surface it declares
 * is checked here against the same schema the farm re-validates it with (§3.9), plus the two
 * cross-branch properties a schema structurally cannot see on its own.
 *
 * `definePlugin` has already run `validatePluginSurface` at import time, so a defect would have
 * thrown before these tests began. They are still worth writing: they say WHICH properties this
 * pack depends on, so a later edit that breaks one fails with a name rather than a stack trace out
 * of an import.
 */
describe('plan 108 §4.3 — the declared surface', () => {
  function surfaceOf(): PluginSurface {
    const surface = plugin.surface
    if (!surface) throw new Error('the pack declares no surface — plan 108 step 108.11 requires one')
    return surface
  }

  test('parses through PluginSurfaceSchema, the schema the farm re-validates with', () => {
    const parsed = PluginSurfaceSchema.safeParse(surfaceOf())
    expect(parsed.success).toBe(true)
  })

  test('passes the full gate, cross-branch checks and caps included', () => {
    const checked = validatePluginSurface(surfaceOf())
    expect(checked.ok ? [] : checked.errors).toEqual([])
  })

  test('every nav entry names a view this surface declares', () => {
    const surface = surfaceOf()
    expect(surface.nav.length).toBeGreaterThan(0)
    for (const entry of surface.nav) {
      expect(Object.keys(surface.views)).toContain(entry.view)
    }
  })

  test('every action id a view references exists in `actions`', () => {
    const surface = surfaceOf()
    const declared = Object.keys(surface.actions)
    for (const [viewId, view] of Object.entries(surface.views)) {
      for (const id of [...view.toolbar, ...view.rowActions]) {
        expect({ viewId, id, declared: declared.includes(id) }).toEqual({ viewId, id, declared: true })
      }
    }
  })

  /**
   * Existence of a referenced script is deliberately NOT checked by `validatePluginSurface` (§3.9 —
   * a pack may reference a script published separately). Every ref this pack writes names one of
   * its OWN members, though, and a typo there would only surface as `script_not_found` at click
   * time on somebody's device.
   */
  test('every script an action names is a member of this very plugin', () => {
    const memberIds = plugin.scripts.map((s) => s.id)
    const withScript = (action: ActionSpec): action is Extract<ActionSpec, { kind: 'job' | 'batch' }> => action.kind === 'job' || action.kind === 'batch'
    const refs = Object.values(surfaceOf().actions).filter(withScript).map((a) => a.script)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const [name = '', version = ''] = ref.split('@')
      const [pluginId, scriptId] = name.split('/')
      expect(pluginId).toBe(plugin.id)
      expect(memberIds).toContain(scriptId ?? '')
      expect(version).toBe('latest')
    }
  })

  /**
   * The screen and the scripts must read and write ONE key. `ACCOUNTS_KEY` is the single constant
   * both sides import; this asserts the surface really used it rather than a string that happens to
   * match today.
   */
  test('the accounts view scans the same KV key the scripts write', () => {
    const view = surfaceOf().views.accounts
    expect(view?.data).toEqual({ kind: 'kv.scan', key: ACCOUNTS_KEY, rows: 'items', itemsAt: 'accounts', includeMissing: true })
  })

  /**
   * The owner's standard for identifying a device on any plugin screen: the unique id, the number
   * that is easy to remember (and is printed on the phone), and the name. All three, in that order,
   * before anything about the account.
   *
   * `Device ID` is bound to `$device.stableId`, NOT to `$device.id`: `stableId` is the identity the
   * whole farm keys on and the one an operator can match to a physical phone, where the internal
   * uuid means nothing to a human. That distinction is the reason this test names the field rather
   * than only the header.
   */
  test('the accounts table opens with Device ID, Device # and Device, in that order', () => {
    const columns = surfaceOf().views.accounts?.table?.columns ?? []
    expect(columns.slice(0, 3).map((c) => [c.header, c.field])).toEqual([
      ['Device ID', '$device.stableId'],
      ['Device #', '$device.number'],
      ['Device', '$device.label'],
    ])
    expect(columns[1]?.width).toBe('narrow')
    // The account columns still follow, unchanged — this widened the row, it did not replace it.
    expect(columns.map((c) => c.field)).toContain('username')
  })

  test('the row action binds the row field the table keys on, so a click cannot target a row it did not read', () => {
    const surface = surfaceOf()
    const view = surface.views.accounts
    const action = surface.actions.switchTo
    expect(view?.table?.rowKey).toBe('username')
    expect(action?.kind).toBe('job')
    if (action?.kind === 'job') {
      expect(action.params).toEqual({ target: { $row: 'username' } })
      expect(action.device).toBe('row')
    }
  })

  test('the sync action is a batch — syncing is a per-device read an operator wants across a fleet', () => {
    const action = surfaceOf().actions.sync
    expect(action?.kind).toBe('batch')
    if (action?.kind === 'batch') expect(action.target).toBe('picker')
  })
})

/**
 * Plan 108 P8 — a plugin's members finally get a human name in Studio, so every member of this pack
 * must carry one. The list is spelled out rather than read off `plugin.scripts`, because
 * `Plugin.scripts: ScriptDefinition[]` erases `title`/`description` from the static type (they
 * survive at runtime); the first assertion is what keeps the two in step.
 */
describe('every member is presentable (plan 108 P8)', () => {
  const members: Array<{ id: string; title?: string; description?: string }> = [
    switchAccount,
    searchFollow,
    listAccounts,
    postVideo,
    enqueueVideo,
    autoScrollScript,
    searchKeyword,
    keywordVideos,
    liveBrowse,
    shopBrowse,
    notificationActivity,
  ]

  test('the spelled-out list is exactly the plugin\'s own members', () => {
    expect(members.map((m) => m.id).sort()).toEqual(plugin.scripts.map((s) => s.id).sort())
  })

  test('every member declares a title and a description', () => {
    for (const member of members) {
      expect({ id: member.id, title: (member.title ?? '').length > 0 }).toEqual({ id: member.id, title: true })
      expect({ id: member.id, description: (member.description ?? '').length > 0 }).toEqual({ id: member.id, description: true })
    }
  })

  test('the plugin itself declares a title and a description too', () => {
    expect((plugin.title ?? '').length).toBeGreaterThan(0)
    expect((plugin.description ?? '').length).toBeGreaterThan(0)
  })
})

describe('keyword matching', () => {
  const KEYWORDS = ['trade', 'trading', 'xau', 'usd', 'scalping', 'swing', 'smc', 'ict']

  /**
   * The short trading acronyms are the whole reason this is not a plain `includes`. A false hit
   * does not merely miss — it tilts an unrelated video towards a long watch, which teaches the feed
   * the opposite of what the operator asked for.
   */
  test('short keywords do not match inside unrelated words', () => {
    for (const hay of ['predictions daily', 'addictive content', 'the victim', 'cosmetics haul']) {
      expect(scoreContent(hay, KEYWORDS, [])).toBe(0)
    }
  })

  test('short keywords still match when a separator is punctuation, not a space', () => {
    expect(matches('xau_ict setup', 'ict')).toBe(true)
    expect(matches('usd/jpy', 'usd')).toBe(true)
  })

  test('long keywords match inside a run-together handle, where nobody typed a space', () => {
    expect(matches('goldxauusdtrader', 'xauusd')).toBe(true)
    expect(scoreContent('scalpingsignals', KEYWORDS, [])).toBeGreaterThan(0)
  })

  test('a blocked word wins over any number of keyword hits', () => {
    expect(scoreContent('xau trading scalping', KEYWORDS, ['scalping'])).toBe(-1)
  })

  test('score counts distinct hits, so a stronger signal tilts further', () => {
    expect(scoreContent('trading xau', KEYWORDS, [])).toBe(2)
  })
})

describe('watch-time tilt', () => {
  /**
   * The tilt must SHIFT the distribution, never replace it. A matched video that is always watched
   * long and an unmatched one always skipped produces a perfectly bimodal watch time — a sharper
   * fingerprint than no randomisation at all, because no person is that consistent.
   */
  const sample = (tilt: number): Record<string, number> => {
    const rng = makeRng(12345)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 400; i++) {
      const { label } = pickWatchMs(rng, tilt)
      counts[label] = (counts[label] ?? 0) + 1
    }
    return counts
  }

  test('a positive tilt raises long watches without eliminating short ones', () => {
    const tilted = sample(0.9)
    expect((tilted.engaged ?? 0) + (tilted.hooked ?? 0)).toBeGreaterThan(0)
    expect(tilted.skip ?? 0).toBeGreaterThan(0)
  })

  test('a negative tilt raises skips without eliminating long watches', () => {
    const tilted = sample(-0.9)
    expect(tilted.skip ?? 0).toBeGreaterThan(0)
    expect((tilted.watch ?? 0) + (tilted.engaged ?? 0) + (tilted.hooked ?? 0)).toBeGreaterThan(0)
  })

  test('a positive tilt produces more long watches than a negative one', () => {
    const long = (c: Record<string, number>) => (c.engaged ?? 0) + (c.hooked ?? 0)
    expect(long(sample(0.9))).toBeGreaterThan(long(sample(-0.9)))
  })

  test('the same seed replays the same sequence', () => {
    const a = makeRng(7)
    const b = makeRng(7)
    expect([pickWatchMs(a).ms, pickWatchMs(a).ms]).toEqual([pickWatchMs(b).ms, pickWatchMs(b).ms])
  })
})

describe('frame size from a screenshot', () => {
  // `DeviceApi` exposes no frame size and `find()` refuses viewport-sized containers, so the PNG
  // header is where the geometry comes from. Getting it wrong aims every swipe at the wrong place.
  test('reads width and height out of the IHDR', () => {
    const png = new Uint8Array(24)
    const dv = new DataView(png.buffer)
    dv.setUint32(0, 0x89504e47)
    dv.setUint32(16, 720)
    dv.setUint32(20, 1640)
    expect(pngSize(png)).toEqual({ width: 720, height: 1640 })
  })

  test('refuses anything that is not a PNG rather than guessing', () => {
    expect(pngSize(new Uint8Array(24))).toBeNull()
    expect(pngSize(new Uint8Array(4))).toBeNull()
  })
})

describe('dialog dismiss selectors — the safety invariant', () => {
  const textOf = (sel: Selector): string | undefined => ('text' in sel ? sel.text : undefined)
  const ackTexts = ACK_SELECTORS.map(textOf).filter((t): t is string => t !== undefined)
  const denyTexts = DENY_SELECTORS.map(textOf).filter((t): t is string => t !== undefined)

  /**
   * This is the one property the whole "tap a button in a modal" mechanism depends on: it must
   * never be possible for the same label to read as both "acknowledge" and "deny", because
   * `clearBlockingDialog` tries ACK first and returns on the first match — a duplicate would make
   * DENY's branch dead code, silently.
   */
  test('ACK and DENY selectors are disjoint', () => {
    const denyKeys = new Set(DENY_SELECTORS.map((sel) => JSON.stringify(sel)))
    for (const sel of ACK_SELECTORS) expect(denyKeys.has(JSON.stringify(sel))).toBe(false)
  })

  /**
   * The load-bearing rule from the plugin's own comments: neither list may ever contain a label
   * that grants, buys, subscribes, or follows. Checked as an exact (case-insensitive) label match,
   * not a substring — `DENY_SELECTORS` legitimately contains "Jangan izinkan" ("don't allow"),
   * which contains the substring "izinkan" while meaning the opposite of granting it.
   */
  test('neither list contains a label that grants, buys, subscribes, or follows', () => {
    const granting = new Set(['izinkan', 'allow', 'ikuti', 'follow', 'beli', 'berlangganan'])
    for (const t of [...ackTexts, ...denyTexts]) {
      expect(granting.has(t.trim().toLowerCase())).toBe(false)
    }
  })

  test('"Mengerti" — the label confirmed on hardware — is present in ACK', () => {
    expect(ackTexts).toContain('Mengerti')
  })
})

describe('nextDialogAction — escalation for "the feed nodes are not there"', () => {
  test('below the two-in-a-row threshold, keep going', () => {
    expect(nextDialogAction(0, 0)).toBe('continue')
    expect(nextDialogAction(1, 0)).toBe('continue')
    expect(nextDialogAction(1, 3)).toBe('continue')
  })

  test('two consecutive blind reads trigger a sweep, regardless of how many already happened', () => {
    expect(nextDialogAction(2, 0)).toBe('sweep')
    expect(nextDialogAction(2, 1)).toBe('sweep')
    expect(nextDialogAction(2, 2)).toBe('sweep')
  })

  test('three fruitless sweeps stop the run as blocked instead of trying a fourth', () => {
    expect(nextDialogAction(2, 3)).toBe('blocked')
    expect(nextDialogAction(3, 5)).toBe('blocked')
  })

  test('a successful read resets both counters, which overrides any prior sweep count', () => {
    // consecutiveBlind back to 0 after signals.ok === true — even with sweeps still at 3, the
    // ladder starts over rather than staying latched in a blocked state.
    expect(nextDialogAction(0, 3)).toBe('continue')
  })
})
