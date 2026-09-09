import { describe, expect, test } from 'bun:test'
import { PENDING_STATE, PostSchema, failedDevices, newPost, planDispatch, postKeyFor, postSummary, rollUp, stateFor, type Post, type RouterDevice } from './posts'

const NOW = 1_770_000_000

function device(input: Partial<RouterDevice> & { id: string }): RouterDevice {
  return {
    stableId: `stable-${input.id}`,
    status: 'online',
    activities: [],
    labels: [{ name: 'tiktok' }],
    ...input,
  }
}

function post(overrides: Partial<Post> = {}): Post {
  return { ...newPost({ videoArtifactId: 'vid-1', caption: 'hello', platforms: ['tiktok'], now: NOW }), ...overrides }
}

describe('the stored shape', () => {
  test('a fresh post parses, and round-trips through its own schema', () => {
    const fresh = newPost({ videoArtifactId: 'vid-1', caption: 'hi', platforms: ['youtube', 'tiktok'], now: NOW })
    expect(PostSchema.parse(fresh)).toEqual(fresh)
  })

  test('platforms are canonically ordered and deduplicated, so two identical posts compare equal', () => {
    const a = newPost({ videoArtifactId: 'v', caption: 'c', platforms: ['youtube', 'tiktok', 'tiktok'], now: NOW })
    const b = newPost({ videoArtifactId: 'v', caption: 'c', platforms: ['tiktok', 'youtube'], now: NOW })
    expect(a.platforms).toEqual(['tiktok', 'youtube'])
    expect(a).toEqual(b)
  })

  test('every targeted platform is seeded pending — "not targeted" and "waiting" must not look alike in the table', () => {
    const fresh = newPost({ videoArtifactId: 'v', caption: 'c', platforms: ['tiktok'], now: NOW })
    expect(fresh.dispatch.tiktok).toEqual({ state: 'pending', at: null, deviceCount: 0, attempts: [], note: null })
    expect(fresh.dispatch.instagram).toBeUndefined()
  })

  test('an unknown field is REFUSED rather than silently dropped — a row from a newer build must fail loudly', () => {
    const fresh = newPost({ videoArtifactId: 'v', caption: 'c', platforms: [], now: NOW })
    expect(PostSchema.safeParse({ ...fresh, scheduledFor: 123 }).success).toBe(false)
  })

  test('the key is derived from the artifact, so re-adding the same video updates one row', () => {
    expect(postKeyFor('vid-1')).toBe('post:vid-1')
  })

  test('a caption is REQUIRED — the post flow refuses an empty one, so a row without it could never send', () => {
    // Not this plugin's preference: `tiktok/post-video` with `source: 'direct'`
    // throws `E_PARAMS_INVALID` on an empty caption, because its captions-file
    // fallback belongs to the queue and folder sources. A stored caption-less
    // post would dispatch and fail on every phone it reached.
    const fresh = newPost({ videoArtifactId: 'v', caption: 'c', platforms: [], now: NOW })
    expect(PostSchema.safeParse({ ...fresh, caption: '' }).success).toBe(false)
    expect(PostSchema.safeParse({ ...fresh, caption: null }).success).toBe(false)
  })
})

describe('planDispatch — the routing rules', () => {
  test('one idle labelled phone gets the job, and the state records it', () => {
    const plan = planDispatch({ post: post(), devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([{ platform: 'tiktok', script: 'tiktok/post-video@latest', deviceId: 'd1', stableId: 'stable-d1' }])
    // `attempts` is empty here on purpose: the ids do not exist until the
    // service enqueues, and it writes them back in the same state.
    expect(plan.states.tiktok).toEqual({ state: 'dispatched', at: NOW, deviceCount: 1, attempts: [], note: null })
  })

  test('a phone WITHOUT the label is never used, however idle it is', () => {
    const plan = planDispatch({ post: post(), devices: [device({ id: 'd1', labels: [{ name: 'instagram' }] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok?.state).toBe('pending')
    // The note names the missing setup step rather than saying "no devices",
    // because the operator's next action is on the Devices screen.
    expect(plan.states.tiktok?.note).toContain('No phone carries the "tiktok" label yet')
  })

  test('a busy phone waits, and the note says so differently from an unlabelled fleet', () => {
    const busy = device({ id: 'd1', activities: [{ kind: 'job' }] })
    const plan = planDispatch({ post: post(), devices: [busy], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    // The distinction that matters: this is a normal, self-resolving wait, not
    // a setup mistake, and the two must not read the same.
    expect(plan.states.tiktok?.note).toContain('offline or busy')
  })

  test('an offline phone is not eligible', () => {
    const plan = planDispatch({ post: post(), devices: [device({ id: 'd1', status: 'offline' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
  })

  test('a post already dispatched is NEVER dispatched again — a duplicate post cannot be undone', () => {
    const already = post({ dispatch: { tiktok: { state: 'dispatched', at: NOW - 100, deviceCount: 2, attempts: [], note: null } } })
    const plan = planDispatch({ post: already, devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok).toBeUndefined()
  })

  test('a platform with no verified flow is marked unsupported once, with its own reason', () => {
    const p = post({ platforms: ['instagram'], dispatch: { instagram: { state: 'pending', at: null, deviceCount: 0, attempts: [], note: null } } })
    const plan = planDispatch({ post: p, devices: [device({ id: 'd1', labels: [{ name: 'instagram' }] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.instagram?.state).toBe('unsupported')
    expect(plan.states.instagram?.note).toContain('No verified upload flow')
    // Named at post level too, so the operator reads it in the table without
    // opening anything.
    expect(plan.note).toContain('Instagram')
  })

  test('an unsupported platform is not REWRITTEN every tick, but still keeps saying why', () => {
    const settled = post({ platforms: ['instagram'], dispatch: { instagram: { state: 'unsupported', at: NOW - 999, deviceCount: 0, attempts: [], note: 'x' } } })
    const plan = planDispatch({ post: settled, devices: [], now: NOW, maxDevicesPerPlatform: 5 })
    // No state write — an unchanged row must not bump `updatedAt` forever and
    // make the table look permanently busy.
    expect(plan.states.instagram).toBeUndefined()
    expect(plan.note).toContain('No verified upload flow')
  })

  test('the per-tick cap bounds the blast radius, and says that it did', () => {
    const devices = [device({ id: 'd1' }), device({ id: 'd2' }), device({ id: 'd3' })]
    const plan = planDispatch({ post: post(), devices, now: NOW, maxDevicesPerPlatform: 2 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d1', 'd2'])
    expect(plan.states.tiktok?.deviceCount).toBe(2)
    expect(plan.states.tiktok?.note).toContain('2 of 3')
  })

  test('a cap of zero still sends to one phone rather than stalling silently', () => {
    // A stored 0 (an older settings row, a hand-edited entry) must not become
    // a fleet that never posts and never explains itself.
    const plan = planDispatch({ post: post(), devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 0 })
    expect(plan.dispatches).toHaveLength(1)
  })

  test('a post targeting nothing does nothing, and does not throw', () => {
    const plan = planDispatch({ post: post({ platforms: [], dispatch: {} }), devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan).toEqual({ dispatches: [], states: {}, note: null })
  })

  test('a platform id this build does not know is recorded, never guessed at', () => {
    // Reached by a row written by a newer build. `as never` only bypasses the
    // compile-time enum — the point is exactly what happens at run time.
    const p = post({ platforms: ['myspace' as never], dispatch: {} })
    const plan = planDispatch({ post: p, devices: [], now: NOW, maxDevicesPerPlatform: 5 })
    // `states` is keyed by the KNOWN platform ids, so reading an unknown one
    // needs a widened view of the same object — the point of the test is
    // exactly that the planner writes a key its own type does not enumerate.
    const states: Record<string, { state: string } | undefined> = plan.states
    expect(states.myspace).toMatchObject({ state: 'unsupported' })
    expect(plan.note).toContain('myspace')
  })

  test('two platforms on one post are planned independently', () => {
    const p = post({ platforms: ['tiktok', 'instagram'], dispatch: {} })
    const devices = [device({ id: 'd1' }), device({ id: 'd2', labels: [{ name: 'instagram' }] })]
    const plan = planDispatch({ post: p, devices, now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.platform)).toEqual(['tiktok'])
    expect(plan.states.instagram?.state).toBe('unsupported')
  })
})

describe('postSummary', () => {
  test('reads as a sentence per platform', () => {
    const p = post({
      platforms: ['tiktok', 'instagram'],
      dispatch: { tiktok: { state: 'dispatched', at: NOW, deviceCount: 3, attempts: [], note: null }, instagram: { state: 'unsupported', at: NOW, deviceCount: 0, attempts: [], note: 'x' } },
    })
    expect(postSummary(p)).toBe('TikTok: running on 3 · Instagram: unsupported')
  })

  test('says so plainly when a post targets nothing', () => {
    expect(postSummary(post({ platforms: [], dispatch: {} }))).toBe('no platforms')
  })
})

describe('stateFor', () => {
  test('a platform with no stored state reads pending, so a newly added one needs no migration', () => {
    expect(stateFor(post({ dispatch: {} }), 'youtube').state).toBe('pending')
  })
})

/**
 * The half of a post's life this plugin used not to have.
 *
 * Before these, a fan-out ended at `dispatched` and stayed there: ten failed
 * uploads and ten successful ones were the same row, reading "sent to 10".
 */
describe('rollUp — dispatched is a waypoint, not an outcome', () => {
  const attempt = (state: 'queued' | 'success' | 'failed', n: number) => ({
    jobId: `j${n}`,
    deviceId: `d${n}`,
    state,
    error: state === 'failed' ? 'boom' : null,
  })

  test('nothing dispatched yet is pending, not a verdict', () => {
    expect(rollUp([])).toBe('pending')
  })

  test('one phone still queued holds the whole platform at dispatched', () => {
    // Not `partial`: an answer is not owed until every phone has given one,
    // and a normal in-flight post must not read like a problem.
    expect(rollUp([attempt('success', 1), attempt('failed', 2), attempt('queued', 3)])).toBe('dispatched')
  })

  test('all succeeded, all failed, and the mixed case each get their own word', () => {
    expect(rollUp([attempt('success', 1), attempt('success', 2)])).toBe('succeeded')
    expect(rollUp([attempt('failed', 1), attempt('failed', 2)])).toBe('failed')
    expect(rollUp([attempt('success', 1), attempt('failed', 2)])).toBe('partial')
  })
})

describe('failedDevices — a retry re-targets the failures and nobody else', () => {
  test('only the failed phones come back', () => {
    const state = {
      state: 'partial' as const,
      at: 100,
      deviceCount: 3,
      attempts: [
        { jobId: 'j1', deviceId: 'd1', state: 'success' as const, error: null },
        { jobId: 'j2', deviceId: 'd2', state: 'failed' as const, error: 'no upload button' },
        { jobId: 'j3', deviceId: 'd3', state: 'failed' as const, error: 'timed out' },
      ],
      note: null,
    }
    // d1 posted. Re-sending to it would put the same video on that account
    // twice, which is the one mistake this farm cannot take back.
    expect(failedDevices(state)).toEqual(['d2', 'd3'])
  })

  test('a platform that never dispatched has nothing to retry', () => {
    expect(failedDevices(PENDING_STATE)).toEqual([])
  })
})

describe('planDispatch — the router never retries a settled platform on its own', () => {
  for (const state of ['succeeded', 'partial', 'failed'] as const) {
    test(`${state} is left alone by the tick`, () => {
      const post = { ...newPost({ videoArtifactId: 'v1', caption: 'c', platforms: ['tiktok'], now: 1 }) }
      post.dispatch.tiktok = { state, at: 1, deviceCount: 1, attempts: [], note: null }
      const plan = planDispatch({ post, devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
      expect(plan.dispatches).toEqual([])
      expect(plan.states.tiktok).toBeUndefined()
    })
  }
})

describe('planDispatch — a chosen phone list narrows the label’s fleet, never widens it', () => {
  const labelled = (id: string) => device({ id, labels: [{ name: 'tiktok' }] })
  const unlabelled = (id: string) => device({ id, labels: [] })

  test('empty means any — what every post written before the picker existed meant', () => {
    const p = { ...post(), deviceIds: [] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), labelled('d2')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId).sort()).toEqual(['d1', 'd2'])
  })

  test('a chosen list keeps only those phones', () => {
    const p = { ...post(), deviceIds: ['d2'] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), labelled('d2'), labelled('d3')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d2'])
  })

  /*
    The label is what says "this phone posts to TikTok". A device picker is a
    way to send to FEWER phones, not a way to overrule that — otherwise an
    operator could aim a post at a phone with no TikTok account on it.
  */
  test('choosing a phone that lacks the label does not make it eligible', () => {
    const p = { ...post(), deviceIds: ['d9'] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), unlabelled('d9')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok?.state).toBe('pending')
    // And it says which of the two problems this is, rather than the generic
    // "everything is busy" that would send the operator looking at uptime.
    expect(plan.states.tiktok?.note).toContain('None of the phones chosen for this post')
  })

  test('a chosen phone that is merely busy still reads as a normal wait', () => {
    const busy = device({ id: 'd2', labels: [{ name: 'tiktok' }], activities: [{ kind: 'job' }] })
    const p = { ...post(), deviceIds: ['d2'] }
    const plan = planDispatch({ post: p, devices: [busy], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.states.tiktok?.note).toContain('offline or busy')
  })
})
