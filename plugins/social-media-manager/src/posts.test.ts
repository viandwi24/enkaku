import { describe, expect, test } from 'bun:test'
import {
  PENDING_STATE,
  PostSchema,
  describePlatform,
  deviceDisplayName,
  failedDevices,
  newPost,
  planDispatch,
  applyPostEdit,
  NO_PHONE_ASSIGNED,
  sessionOwner,
  unassignedNote,
  HISTORY_LIMIT,
  nextRound,
  pickAssignment,
  withRetired,
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
    expect(fresh.dispatch.tiktok).toEqual({ state: 'pending', at: null, deviceCount: 0, attempts: [], history: [], note: null, summary: 'Waiting for a phone' })
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
    expect(plan.states.tiktok).toEqual({ state: 'dispatched', at: NOW, deviceCount: 1, attempts: [], history: [], note: null, summary: null })
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
    const already = post({ dispatch: { tiktok: { state: 'dispatched', at: NOW - 100, deviceCount: 2, attempts: [], history: [], note: null, summary: null } } })
    const plan = planDispatch({ post: already, devices: [device({ id: 'd1' })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok).toBeUndefined()
  })

  test('Instagram routes to its own post member, to the phones carrying its label', () => {
    const p = post({ platforms: ['instagram'], dispatch: { instagram: { state: 'pending', at: null, deviceCount: 0, attempts: [], history: [], note: null, summary: null } } })
    const plan = planDispatch({ post: p, devices: [device({ id: 'd1', labels: [{ name: 'instagram' }] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([{ platform: 'instagram', script: 'instagram/post-video@latest', deviceId: 'd1', stableId: 'stable-d1' }])
    expect(plan.states.instagram?.state).toBe('dispatched')
  })

  test('a post an older build stored as Instagram "unsupported" is not settled — it routes once Instagram can post', () => {
    // 0.13.0's changelog says so to the operator; this is what makes it true.
    const stored = post({
      platforms: ['instagram'],
      dispatch: { instagram: { state: 'unsupported', at: NOW - 999, deviceCount: 0, attempts: [], history: [], note: 'x', summary: null } },
    })
    expect(planDispatch({ post: stored, devices: [], now: NOW, maxDevicesPerPlatform: 5 }).states.instagram?.state).toBe('pending')
    const plan = planDispatch({ post: stored, devices: [device({ id: 'd1', labels: [{ name: 'instagram' }] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.script)).toEqual(['instagram/post-video@latest'])
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
    expect(plan.dispatches.map((d) => `${d.platform}:${d.deviceId}`)).toEqual(['tiktok:d1', 'instagram:d2'])
    expect(plan.states.tiktok?.state).toBe('dispatched')
    expect(plan.states.instagram?.state).toBe('dispatched')
  })
})

describe('postSummary', () => {
  test('reads as a sentence per platform', () => {
    const p = post({
      platforms: ['tiktok', 'instagram'],
      dispatch: {
        tiktok: { state: 'dispatched', at: NOW, deviceCount: 3, attempts: [], history: [], note: null, summary: null },
        instagram: { state: 'unsupported', at: NOW, deviceCount: 0, attempts: [], history: [], note: 'x', summary: null },
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
    history: [],
    note: null,
    summary: null,
    ...over,
  })
  const attempt = (over: Partial<Attempt> & { deviceId: string }): Attempt => ({
    at: null,
    settledAt: null,
    round: 1,
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
          attempts: [{ jobId: 'j1', deviceId: 'd1', deviceName: null, state: 'success', error: null, at: NOW, settledAt: NOW, round: 1 }],
          history: [],
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
    at: null,
    settledAt: null,
    round: 1,
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
        { jobId: 'j1', deviceId: 'd1', deviceName: '#1 moto g06 power', state: 'success' as const, error: null, at: null, settledAt: null, round: 1 },
        { jobId: 'j2', deviceId: 'd2', deviceName: '#2 moto g06 power', state: 'failed' as const, error: 'no upload button', at: null, settledAt: null, round: 1 },
        { jobId: 'j3', deviceId: 'd3', deviceName: null, state: 'failed' as const, error: 'timed out', at: null, settledAt: null, round: 1 },
      ],
      history: [],
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
        { jobId: 'j1', deviceId: 'd1', deviceName: '#1 moto g06 power', state: 'unverified' as const, error: 'no readable grid', at: null, settledAt: null, round: 1 },
        { jobId: 'j2', deviceId: 'd2', deviceName: '#2 moto g06 power', state: 'failed' as const, error: 'app missing', at: null, settledAt: null, round: 1 },
      ],
      history: [],
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
      post.dispatch.tiktok = { state, at: 1, deviceCount: 1, attempts: [], history: [], note: null, summary: null }
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

/**
 * One video, one phone (0.12.0). The owner's production session of five videos over five phones put
 * three videos on #21 and sent a retried video to a phone that had posted another: the phone was
 * whoever was free at each turn. These pin the rule that replaced it.
 */
describe('one video, one phone', () => {
  const att = (deviceId: string, state: Attempt['state'], at: number): Attempt => ({ jobId: `j-${deviceId}-${at}`, deviceId, deviceName: null, state, error: null, at, settledAt: at, round: 1 })

  test('an assigned phone is the ONLY phone the row may use — labelled or not, however many others are free', () => {
    const plan = planDispatch({ post: post({ assignedDeviceId: 'd9' }), devices: [device({ id: 'd1' }), device({ id: 'd9', labels: [] })], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches.map((d) => d.deviceId)).toEqual(['d9'])
  })

  test('while its phone is busy the row waits, and is never sent to a free phone instead', () => {
    const busy = device({ id: 'd9', activities: [{ kind: 'job' }] })
    const plan = planDispatch({ post: post({ assignedDeviceId: 'd9' }), devices: [device({ id: 'd1' }), busy], now: NOW, maxDevicesPerPlatform: 5 })
    expect(plan.dispatches).toEqual([])
    expect(plan.states.tiktok?.note).toContain("this video's phone")
  })

  test('the suggestion is where something LANDED before anything that only failed, replaced attempts included', () => {
    const p = post({
      deviceIds: ['d2', 'd3'],
      dispatch: { tiktok: { ...PENDING_STATE, attempts: [att('d3', 'queued', NOW - 10)], history: [att('d2', 'failed', NOW - 100)] } },
    })
    expect(pickAssignment({ post: p, ownedByOthers: new Set(), fleet: [], sessionVideos: 5 })).toEqual({ deviceId: 'd3', reason: null })
  })

  test('with nothing that landed, the suggestion is the phone of its earliest attempt', () => {
    const p = post({ deviceIds: ['d2', 'd3'], dispatch: { tiktok: { ...PENDING_STATE, attempts: [att('d3', 'failed', NOW - 10)], history: [att('d2', 'failed', NOW - 100)] } } })
    expect(pickAssignment({ post: p, ownedByOthers: new Set(), fleet: [], sessionVideos: 5 }).deviceId).toBe('d2')
  })

  test('...unless another video owns that phone — the production "three videos on #21" case — then a phone nobody owns', () => {
    const p = post({ deviceIds: ['d21', 'd22', 'd23'], dispatch: { tiktok: { ...PENDING_STATE, history: [att('d21', 'failed', NOW - 100)] } } })
    expect(pickAssignment({ post: p, ownedByOthers: new Set(['d21']), fleet: [], sessionVideos: 5 }).deviceId).toBe('d22')
  })

  test('with no phone left the row gets none and a sentence — never a phone that already has a video', () => {
    const p = post({ deviceIds: ['d1', 'd2'] })
    const pick = pickAssignment({ post: p, ownedByOthers: new Set(['d1', 'd2']), fleet: [], sessionVideos: 3 })
    expect(pick.deviceId).toBeNull()
    expect(pick.reason).toContain('No phone is left for this video')
    expect(pick.reason).toContain('3 videos and 2 phones')
  })

  test('with no phones chosen, the pool is the phones carrying one of the row\'s platform labels', () => {
    const fleet = [
      { id: 'b-youtube-only', labels: [{ name: 'youtube' }] },
      { id: 'a-tiktok', labels: [{ name: 'TikTok' }] },
    ]
    expect(pickAssignment({ post: post({ deviceIds: [] }), ownedByOthers: new Set(), fleet, sessionVideos: 1 }).deviceId).toBe('a-tiktok')
  })
})

describe('attempt history (0.12.0)', () => {
  const att = (round: number): Attempt => ({ jobId: `j${round}`, deviceId: 'd1', deviceName: null, state: 'failed', error: 'x', at: round, settledAt: round, round })

  test('replaced attempts are kept oldest first, capped at the newest HISTORY_LIMIT', () => {
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => att(i + 1))
    const kept = withRetired(many.slice(0, 10), many.slice(10))
    expect(kept).toHaveLength(HISTORY_LIMIT)
    expect(kept[0]?.round).toBe(6)
    expect(kept.at(-1)?.round).toBe(HISTORY_LIMIT + 5)
  })

  test('the next round is one past everything tried, current and replaced', () => {
    expect(nextRound({ attempts: [], history: [] })).toBe(1)
    expect(nextRound({ attempts: [att(3)], history: [att(1), att(2)] })).toBe(4)
  })

  test('history is outside the roll-up: a platform whose current attempt posted reads succeeded, whatever failed before', () => {
    expect(rollUp([{ ...att(2), state: 'success', error: null }])).toBe('succeeded')
  })
})

/**
 * Editing a video after its session was made (0.12.0) — the owner: "harusnya bisa di edit juga …
 * ganti assign devicesnya atau platformnya sehingga pas di rerun/retry yah bisa".
 */
describe('applyPostEdit', () => {
  const inSession = (over: Partial<Post> = {}): Post => post({ groupId: 'g1', maxDevices: 1, assignedDeviceId: 'd1', ...over })
  const queued: Attempt = { jobId: 'j', deviceId: 'd1', deviceName: '#1 moto', state: 'queued', error: null, at: NOW, settledAt: null, round: 1 }

  test('moves the video to a phone nobody in the session has', () => {
    const out = applyPostEdit({ post: inSession(), edit: { assignedDeviceId: 'd5' }, sessionRows: [inSession({ videoArtifactId: 'other', assignedDeviceId: 'd2' })] })
    expect(out.ok && out.post.assignedDeviceId).toBe('d5')
    expect(out.ok && out.changed).toEqual(['phone'])
  })

  test('a phone another video of the session owns is ALLOWED, with a warning naming that video', () => {
    const other = inSession({ videoArtifactId: 'other', caption: 'kenapa stop loss selalu kena', assignedDeviceId: 'd2' })
    const out = applyPostEdit({ post: inSession(), edit: { assignedDeviceId: 'd2' }, sessionRows: [other] })
    expect(out.ok && out.post.assignedDeviceId).toBe('d2')
    expect(out.ok && out.warnings.join(' ')).toContain('kenapa stop loss')
  })

  test('a phone where another video only FAILED is free to take', () => {
    const other = inSession({
      videoArtifactId: 'other',
      assignedDeviceId: 'd3',
      dispatch: { tiktok: { ...PENDING_STATE, state: 'failed', attempts: [{ ...queued, deviceId: 'd2', state: 'failed', settledAt: NOW }] } },
    })
    const out = applyPostEdit({ post: inSession(), edit: { assignedDeviceId: 'd2' }, sessionRows: [other] })
    expect(out.ok && out.warnings).toEqual([])
  })

  test('an edit while the video is uploading is applied, and warns that the running upload is unchanged', () => {
    const busy = inSession({ dispatch: { tiktok: { ...PENDING_STATE, state: 'dispatched', attempts: [queued] } } })
    const out = applyPostEdit({ post: busy, edit: { caption: 'new' }, sessionRows: [] })
    expect(out.ok && out.post.caption).toBe('new')
    expect(out.ok && out.warnings.join(' ')).toContain('uploading on #1 moto')
  })

  test('adding a platform seeds it waiting; what already posted keeps its record', () => {
    const posted = inSession({ dispatch: { tiktok: { ...PENDING_STATE, state: 'succeeded', attempts: [{ ...queued, state: 'success', settledAt: NOW }] } } })
    const out = applyPostEdit({ post: posted, edit: { platforms: ['youtube', 'tiktok'] }, sessionRows: [] })
    expect(out.ok && out.post.platforms).toEqual(['tiktok', 'youtube'])
    expect(out.ok && out.post.dispatch.youtube?.state).toBe('pending')
    expect(out.ok && out.post.dispatch.tiktok?.state).toBe('succeeded')
  })

  test('a platform list that empties the video, or an empty caption, is refused', () => {
    expect(applyPostEdit({ post: inSession(), edit: { platforms: [] }, sessionRows: [] }).ok).toBe(false)
    expect(applyPostEdit({ post: inSession(), edit: { caption: '   ' }, sessionRows: [] }).ok).toBe(false)
  })

  test('an ungrouped post has no phone of its own to change', () => {
    const out = applyPostEdit({ post: post(), edit: { assignedDeviceId: 'd2' }, sessionRows: [] })
    expect(!out.ok && out.code).toBe('E_PARAMS_INVALID')
  })

  test('an edit that matches what is stored changes nothing', () => {
    const out = applyPostEdit({ post: inSession(), edit: { assignedDeviceId: 'd1', caption: 'hello', platforms: ['tiktok'] }, sessionRows: [] })
    expect(out.ok && out.changed).toEqual([])
  })
})

/**
 * Upgrading a production farm (0.12.0). The owner's farm holds a session written by 0.11.0 and asked
 * that the new version read it without error and without guessing. This is that session's shape:
 * none of 0.12.0's fields exist in it.
 */
describe('a session written by 0.11.0, read by 0.12.0', () => {
  async function legacy(): Promise<{ rows: unknown[]; names: Record<string, string> }> {
    return (await Bun.file(new URL('./__fixtures__/legacy-session-0.11.0.json', import.meta.url)).json()) as { rows: unknown[]; names: Record<string, string> }
  }

  test('every row parses, with every new field defaulted — no phone, empty history, round 1', async () => {
    const { rows } = await legacy()
    for (const raw of rows) {
      const p = PostSchema.parse(raw)
      expect(p.assignedDeviceId).toBeNull()
      for (const id of p.platforms) {
        const s = p.dispatch[id]
        expect(s?.history).toEqual([])
        for (const a of s?.attempts ?? []) expect({ at: a.at, settledAt: a.settledAt, round: a.round }).toEqual({ at: null, settledAt: null, round: 1 })
      }
    }
  })

  test('the migrated shape round-trips — writing it back and reading it again changes nothing', async () => {
    const { rows } = await legacy()
    for (const raw of rows) {
      const once = PostSchema.parse(raw)
      expect(PostSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once)
    }
  })

  test('each row owns at most ONE phone, so a tangled row does not use up two', async () => {
    const { rows } = await legacy()
    const owners = rows.map((raw) => sessionOwner(PostSchema.parse(raw)))
    // Only the two rows with an unverified attempt may have landed anything; everything else only failed.
    expect(owners).toEqual([null, null, null, 'd21', 'd22'])
  })

  test('every unassigned row is held with a note, and no suggestion is a phone another video owns', async () => {
    const { rows, names } = await legacy()
    const posts = rows.map((raw) => PostSchema.parse(raw))
    const owned = new Map<string, string>()
    posts.forEach((p) => {
      const phone = sessionOwner(p)
      if (phone !== null && !owned.has(phone)) owned.set(phone, p.videoArtifactId)
    })
    for (const p of posts) {
      const others = new Set([...owned].filter(([, vid]) => vid !== p.videoArtifactId).map(([d]) => d))
      const pick = pickAssignment({ post: p, ownedByOthers: others, fleet: [], sessionVideos: posts.length })
      if (pick.deviceId !== null) expect(others.has(pick.deviceId)).toBe(false)
      const note = unassignedNote(pick, new Map(Object.entries(names)))
      expect(note.startsWith(NO_PHONE_ASSIGNED)).toBe(true)
      expect(note).toContain('not sent')
    }
  })

  test('an assigned phone is only ever the one the operator chose — nothing binds a legacy row on its own', async () => {
    const { rows } = await legacy()
    // `pickAssignment` returns a suggestion and writes nothing; the row is unchanged by asking.
    const p = PostSchema.parse(rows[0])
    pickAssignment({ post: p, ownedByOthers: new Set(), fleet: [], sessionVideos: 5 })
    expect(p.assignedDeviceId).toBeNull()
  })
})
