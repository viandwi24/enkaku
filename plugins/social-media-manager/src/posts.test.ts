import { describe, expect, test } from 'bun:test'
import {
  PENDING_STATE,
  PostSchema,
  describePlatform,
  deviceDisplayName,
  failedDevices,
  newPost,
  planDispatch,
  postKeyFor,
  postSummary,
  refreshPost,
  rollUp,
  stateFor,
  type Attempt,
  type PlatformState,
  type Post,
  type RouterDevice,
} from './posts'

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
    // The summary line is seeded with it, so a brand new post reads as waiting
    // before the router has ever looked at it — and whether or not the
    // plugin's service is running at all.
    expect(fresh.dispatch.tiktok).toEqual({ state: 'pending', at: null, deviceCount: 0, attempts: [], note: null, summary: 'Waiting for a phone' })
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
    // `summary` is null here for the same reason `attempts` is empty: the line
    // names the phones, and which phones took the job is not known until the
    // service has the job ids back.
    expect(plan.states.tiktok).toEqual({ state: 'dispatched', at: NOW, deviceCount: 1, attempts: [], note: null, summary: null })
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
    const already = post({ dispatch: { tiktok: { state: 'dispatched', at: NOW - 100, deviceCount: 2, attempts: [], note: null, summary: null } } })
    const plan = planDispatch({ post: already, devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok).toBeUndefined()
  })

  test('a platform with no verified flow is marked unsupported once, with its own reason', () => {
    const p = post({ platforms: ['instagram'], dispatch: { instagram: { state: 'pending', at: null, deviceCount: 0, attempts: [], note: null, summary: null } } })
    const plan = planDispatch({ post: p, devices: [device({ id: 'd1', labels: [{ name: 'instagram' }] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.instagram?.state).toBe('unsupported')
    expect(plan.states.instagram?.note).toContain('No verified upload flow')
    // Named at post level too, so the operator reads it in the table without
    // opening anything.
    expect(plan.note).toContain('Instagram')
  })

  test('an unsupported platform is not REWRITTEN every tick, but still keeps saying why', () => {
    const settled = post({
      platforms: ['instagram'],
      dispatch: { instagram: { state: 'unsupported', at: NOW - 999, deviceCount: 0, attempts: [], note: 'x', summary: null } },
    })
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
      dispatch: {
        tiktok: { state: 'dispatched', at: NOW, deviceCount: 3, attempts: [], note: null, summary: null },
        instagram: { state: 'unsupported', at: NOW, deviceCount: 0, attempts: [], note: 'x', summary: null },
      },
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
 * The line the Posts table actually renders (0.7.0).
 *
 * The state word alone — `succeeded`, `partial` — could not answer the first
 * question an operator asks about a fan-out, which is *which phone was that?*
 * These pin the wording, because the wording is the feature.
 */
describe('describePlatform — where it ran and how it went', () => {
  const state = (over: Partial<PlatformState> = {}): PlatformState => ({
    state: 'pending',
    at: null,
    deviceCount: 0,
    attempts: [],
    note: null,
    summary: null,
    ...over,
  })
  const attempt = (over: Partial<Attempt> & { deviceId: string }): Attempt => ({
    jobId: `job-${over.deviceId}`,
    deviceName: null,
    state: 'success',
    error: null,
    ...over,
  })

  test('one phone names itself', () => {
    const one = state({ state: 'succeeded', attempts: [attempt({ deviceId: 'd1', deviceName: '#3 moto g06 power' })] })
    expect(describePlatform(one)).toBe('#3 moto g06 power · posted')
  })

  test('a fan-out counts itself', () => {
    const many = state({
      state: 'partial',
      attempts: [
        attempt({ deviceId: 'd1', deviceName: '#1 moto' }),
        attempt({ deviceId: 'd2', deviceName: '#2 moto', state: 'failed', error: 'no upload button' }),
      ],
    })
    expect(describePlatform(many)).toBe('2 phones · 1 posted, 1 failed')
  })

  test('unverified is worded as itself — never as a success', () => {
    const unsure = state({ state: 'partial', attempts: [attempt({ deviceId: 'd1', deviceName: '#1 moto', state: 'unverified' })] })
    expect(describePlatform(unsure)).toBe('#1 moto · unverified')
  })

  test('a phone with no recorded name reads as an id, never as a blank', () => {
    const nameless = state({ state: 'failed', attempts: [attempt({ deviceId: '4f3a91c2-0000', state: 'failed', error: 'x' })] })
    expect(describePlatform(nameless)).toBe('device 4f3a91c2 · failed')
  })

  test('waiting, all-posted, all-running and unsupported each get their own line', () => {
    expect(describePlatform(state())).toBe('Waiting for a phone')
    expect(describePlatform(state({ state: 'unsupported', note: 'x' }))).toBe('Not supported in this build')
    expect(describePlatform(state({ state: 'dispatched', attempts: [attempt({ deviceId: 'd1' }), attempt({ deviceId: 'd2' })] }))).toBe('2 phones · all posted')
    expect(
      describePlatform(state({ state: 'dispatched', attempts: [attempt({ deviceId: 'd1', state: 'queued' }), attempt({ deviceId: 'd2', state: 'queued' })] })),
    ).toBe('2 phones · running')
  })

  test('a row written before attempts were recorded still says how many it went to', () => {
    // The 0.1.0 shape: a count and nothing else. It claims exactly that, and
    // does not invent phones it cannot name.
    expect(describePlatform(state({ state: 'dispatched', deviceCount: 4 }))).toBe('Sent to 4 phones')
  })
})

describe('refreshPost — the display fields follow the fleet, the dispatch record never moves', () => {
  const names = new Map([['d1', '#3 moto g06 power']])

  function dispatched(): Post {
    return post({
      dispatch: {
        tiktok: {
          state: 'succeeded',
          at: NOW,
          deviceCount: 1,
          attempts: [{ jobId: 'j1', deviceId: 'd1', deviceName: null, state: 'success', error: null }],
          note: null,
          summary: null,
        },
      },
    })
  }

  test('a row from an older build gains the phone name and the summary line', () => {
    const next = refreshPost(dispatched(), names)
    expect(next?.dispatch.tiktok?.attempts[0]?.deviceName).toBe('#3 moto g06 power')
    expect(next?.dispatch.tiktok?.summary).toBe('#3 moto g06 power · posted')
    // Nothing about what happened may change: this pass is display only.
    expect(next?.dispatch.tiktok?.state).toBe('succeeded')
    expect(next?.dispatch.tiktok?.attempts[0]?.jobId).toBe('j1')
  })

  test('nothing to do returns null, so the router never rewrites an unchanged row', () => {
    const refreshed = refreshPost(dispatched(), names)
    expect(refreshed).not.toBeNull()
    expect(refreshPost(refreshed as Post, names)).toBeNull()
  })

  test('a phone the farm no longer has keeps the name it was recorded with', () => {
    const gone = refreshPost(dispatched(), names) as Post
    const after = refreshPost(gone, new Map())
    // The attempt is a historical fact; the phone leaving the farm does not
    // make it untrue, and the row must not fall back to a uuid.
    expect(after).toBeNull()
    expect(gone.dispatch.tiktok?.attempts[0]?.deviceName).toBe('#3 moto g06 power')
  })
})

describe('deviceDisplayName — the same rule Studio names a phone by', () => {
  test('numbered, unnumbered, and unnamed', () => {
    expect(deviceDisplayName({ id: 'abcdef123456', label: 'moto g06 power', number: 3 })).toBe('#3 moto g06 power')
    expect(deviceDisplayName({ id: 'abcdef123456', label: 'moto g06 power', number: null })).toBe('moto g06 power')
    expect(deviceDisplayName({ id: 'abcdef123456', label: '', number: null })).toBe('device abcdef12')
  })
})

/**
 * The half of a post's life this plugin used not to have.
 *
 * Before these, a fan-out ended at `dispatched` and stayed there: ten failed
 * uploads and ten successful ones were the same row, reading "sent to 10".
 */
describe('rollUp — dispatched is a waypoint, not an outcome', () => {
  const attempt = (state: 'queued' | 'success' | 'failed' | 'unverified', n: number) => ({
    jobId: `j${n}`,
    deviceId: `d${n}`,
    deviceName: `#${n} phone ${n}`,
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

  test('an unverified phone is never counted as posted, nor as failed', () => {
    // The 2026-09-11 run: a green job whose script could not confirm the post.
    expect(rollUp([attempt('unverified', 1)])).toBe('partial')
    expect(rollUp([attempt('success', 1), attempt('unverified', 2)])).toBe('partial')
    expect(rollUp([attempt('unverified', 1), attempt('failed', 2)])).toBe('partial')
  })
})

describe('failedDevices — a retry re-targets the failures and nobody else', () => {
  test('only the failed phones come back', () => {
    const state = {
      state: 'partial' as const,
      at: 100,
      deviceCount: 3,
      attempts: [
        { jobId: 'j1', deviceId: 'd1', deviceName: '#1 moto g06 power', state: 'success' as const, error: null },
        { jobId: 'j2', deviceId: 'd2', deviceName: '#2 moto g06 power', state: 'failed' as const, error: 'no upload button' },
        { jobId: 'j3', deviceId: 'd3', deviceName: null, state: 'failed' as const, error: 'timed out' },
      ],
      note: null,
      summary: null,
    }
    // d1 posted. Re-sending to it would put the same video on that account
    // twice, which is the one mistake this farm cannot take back.
    expect(failedDevices(state)).toEqual(['d2', 'd3'])
  })

  test('an unverified phone is not retried — its post may already be live', () => {
    const state = {
      state: 'partial' as const,
      at: 100,
      deviceCount: 2,
      attempts: [
        { jobId: 'j1', deviceId: 'd1', deviceName: '#1 moto g06 power', state: 'unverified' as const, error: 'no readable grid' },
        { jobId: 'j2', deviceId: 'd2', deviceName: '#2 moto g06 power', state: 'failed' as const, error: 'app missing' },
      ],
      note: null,
      summary: null,
    }
    expect(failedDevices(state)).toEqual(['d2'])
  })

  test('a platform that never dispatched has nothing to retry', () => {
    expect(failedDevices(PENDING_STATE)).toEqual([])
  })
})

describe('planDispatch — a row may cap its own fan-out (what a session spread stores)', () => {
  test('maxDevices 1 takes ONE phone even when five are free and the farm allows five', () => {
    const p = post({ platforms: ['tiktok'], dispatch: {}, maxDevices: 1 })
    const devices = [device({ id: 'd1' }), device({ id: 'd2' }), device({ id: 'd3' }), device({ id: 'd4' }), device({ id: 'd5' })]
    const plan = planDispatch({ post: p, devices, now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d1'])
  })

  test('without a cap the farm setting still decides — the older behaviour is untouched', () => {
    const p = post({ platforms: ['tiktok'], dispatch: {} })
    const devices = [device({ id: 'd1' }), device({ id: 'd2' }), device({ id: 'd3' })]
    expect(planDispatch({ post: p, devices, now: NOW, maxDevicesPerPlatform: 2 }).dispatches).toHaveLength(2)
  })

  test('the row cap cannot widen the farm setting past what is free', () => {
    const p = post({ platforms: ['tiktok'], dispatch: {}, maxDevices: 10 })
    const devices = [device({ id: 'd1' })]
    expect(planDispatch({ post: p, devices, now: NOW, maxDevicesPerPlatform: 1 }).dispatches).toHaveLength(1)
  })
})

describe('planDispatch — the router never retries a settled platform on its own', () => {
  for (const state of ['succeeded', 'partial', 'failed'] as const) {
    test(`${state} is left alone by the tick`, () => {
      const post = { ...newPost({ videoArtifactId: 'v1', caption: 'c', platforms: ['tiktok'], now: 1 }) }
      post.dispatch.tiktok = { state, at: 1, deviceCount: 1, attempts: [], note: null, summary: null }
      const plan = planDispatch({ post, devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
      expect(plan.dispatches).toEqual([])
      expect(plan.states.tiktok).toBeUndefined()
    })
  }
})

describe('planDispatch — who may post is decided by who chose', () => {
  const labelled = (id: string) => device({ id, labels: [{ name: 'tiktok' }] })
  const unlabelled = (id: string) => device({ id, labels: [] })

  test('nothing chosen: the platform label is the fleet', () => {
    const p = { ...post(), deviceIds: [] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), labelled('d2'), unlabelled('d3')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId).sort()).toEqual(['d1', 'd2'])
  })

  test('a chosen list keeps only those phones', () => {
    const p = { ...post(), deviceIds: ['d2'] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), labelled('d2'), labelled('d3')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d2'])
  })

  /*
    The regression this pins, measured on the owner's production farm
    (2026-09-14): a session made on the Social posts page over phones chosen by
    the label "test 5" — none carrying "tiktok" or "youtube" — was started and
    sent nothing, ever, with every row reading "Waiting for a phone". Choosing
    the platforms and the phones in one form already says these phones post to
    these platforms.
  */
  test('a chosen phone is eligible WITHOUT the platform label', () => {
    const p = { ...post(), deviceIds: ['d9'] }
    const plan = planDispatch({ post: p, devices: [labelled('d1'), unlabelled('d9')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d9'])
  })

  test('a chosen phone that is busy reads as a normal wait', () => {
    const busy = device({ id: 'd2', labels: [], activities: [{ kind: 'job' }] })
    const p = { ...post(), deviceIds: ['d2'] }
    const plan = planDispatch({ post: p, devices: [busy], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok?.state).toBe('pending')
    expect(plan.states.tiktok?.note).toContain('offline or busy')
  })

  test('chosen phones that are no longer on the farm say so, rather than waiting on nothing', () => {
    const p = { ...post(), deviceIds: ['gone'] }
    const plan = planDispatch({ post: p, devices: [labelled('d1')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok?.note).toContain('is connected to the farm any more')
  })

  test('nothing chosen and nothing labelled still names the label to add', () => {
    const p = { ...post(), deviceIds: [] }
    const plan = planDispatch({ post: p, devices: [unlabelled('d1')], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.states.tiktok?.note).toContain('No phone carries the "tiktok" label')
  })
})
