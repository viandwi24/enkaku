import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import type { LeaseHolder } from '@enkaku/protocol'
import {
  ASSIST_ACTIVITY_WINDOW_SEC,
  assistEndCopy,
  assistRowState,
  computeControlState,
  DEFAULT_ASSIST_GRANT_TTL_SEC,
  deriveAssistActivity,
  heldByMe,
  useControlState,
  type ControlState,
} from './ControlState'

afterEach(cleanup)

const JOB_HOLDER: LeaseHolder = { kind: 'job', id: 'job-1', label: 'checkout@1.4.2', runId: null, takeable: false, acquiredAt: 0, expiresAt: null }
const HUMAN_HOLDER: LeaseHolder = { kind: 'user', id: 'u2', label: 'Bob', runId: null, takeable: true, acquiredAt: 0, expiresAt: 1_700_000_000 }
const AGENT_HOLDER: LeaseHolder = { kind: 'agent', id: 'a1', label: 'Triage bot', runId: 'run-1', takeable: true, acquiredAt: 0, expiresAt: null }
const ME: LeaseHolder = { kind: 'user', id: 'me', label: 'Me', runId: null, takeable: true, acquiredAt: 0, expiresAt: null }

/**
 * `myUserId` is deliberately ABSENT from `BASE` (plan 125 §3.10, step
 * 125.5): every pre-existing test in this file therefore runs the
 * auth-disabled path unchanged, and the whole file passing is itself plan
 * 125 acceptance criterion 10 ("with auth disabled, control behaves exactly
 * as it does today"). The §3.10 block below adds the explicit,
 * named version of that assertion on top.
 */
const BASE = {
  status: 'idle' as const,
  heldBy: null as LeaseHolder | null,
  myLeaseExpiresAt: null as number | null,
  myAssistGrant: null as { expiresAt: number; primary: LeaseHolder } | null,
  coControlMode: 'operator' as const,
}

/**
 * `computeControlState` (plan 105 §5 step 105.1) — one discriminated state,
 * one primary action, per the plan's own test-plan section: "each of the
 * five states resolves one action; a state change mid-render never yields
 * two." Called directly, not through `useControlState`, for the pure cases
 * — the same precedent `useBulkSelection.test.ts` sets for a `use*`-named
 * function with no hooks of its own to speak of; `useControlState` itself
 * (the `useMemo` wrapper) gets its own small `renderHook`-based block below.
 */
describe('computeControlState — the five states (plan 105 §5 step 105.1)', () => {
  test('free: nobody holds it — one primary action, Take control', () => {
    const state = computeControlState(BASE)
    expect(state.kind).toBe('free')
    if (state.kind !== 'free') throw new Error('unreachable')
    expect(state.primary).toEqual({ kind: 'take-control', label: 'Take control', disabledReason: null, description: null })
  })

  test('free but offline: Take control is disabled, naming why', () => {
    const state = computeControlState({ ...BASE, status: 'offline' })
    if (state.kind !== 'free') throw new Error('unreachable')
    expect(state.primary.disabledReason).toBe('The device is not connected to this farm')
  })

  test('held-by-job (the owner’s own ruling, plan 91 §0.3): Assist is primary, Take control… is reachable as secondary', () => {
    const state = computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER })
    expect(state.kind).toBe('held-by-job')
    if (state.kind !== 'held-by-job') throw new Error('unreachable')
    expect(state.primary).toEqual({ kind: 'assist', label: 'Assist', disabledReason: null, description: null })
    expect(state.secondary.kind).toBe('take-over')
  })

  test('held-by-job with coControl off: Assist is disabled, naming why — Take control… stays reachable', () => {
    const state = computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, coControlMode: 'off' })
    if (state.kind !== 'held-by-job') throw new Error('unreachable')
    expect(state.primary.disabledReason).toBe('Assisting is turned off for this farm.')
    expect(state.secondary.disabledReason).toBeNull()
  })

  test('held-by-human (a person): both actions offered — Take control first (plan 105 §9 Q1, answered by plan 125 §3.11)', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER })
    expect(state.kind).toBe('held-by-human')
    if (state.kind !== 'held-by-human') throw new Error('unreachable')
    expect(state.weighting).toBe('take-over-first')
    expect(state.options.map((o) => o.kind)).toEqual(['take-over', 'assist'])
  })

  test('held-by-human also covers an agent holder (both are `takeable`) — not a sixth state', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: AGENT_HOLDER })
    expect(state.kind).toBe('held-by-human')
  })

  test('i-hold: this client holds the lease — one primary action, Release control', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: ME, myLeaseExpiresAt: 1_700_000_300 })
    expect(state.kind).toBe('i-hold')
    if (state.kind !== 'i-hold') throw new Error('unreachable')
    expect(state.expiresAt).toBe(1_700_000_300)
    expect(state.primary).toEqual({ kind: 'release-control', label: 'Release control', disabledReason: null, description: null })
  })

  test('i-assist: this client holds an assist grant — one primary action, Stop assisting', () => {
    const grant = { expiresAt: 1_700_000_300, primary: JOB_HOLDER }
    const state = computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, myAssistGrant: grant })
    expect(state.kind).toBe('i-assist')
    if (state.kind !== 'i-assist') throw new Error('unreachable')
    expect(state.primaryHolder).toBe(JOB_HOLDER)
    expect(state.primary).toEqual({ kind: 'stop-assisting', label: 'Stop assisting', disabledReason: null, description: null })
  })

  test('precedence: i-assist beats i-hold beats held-by-* beats free — a device that is (in stale local state) somehow both still resolves to exactly ONE state', () => {
    // Holding both an assist grant AND the manual lease locally is not a
    // real reachable combination, but the precedence must still resolve to
    // exactly one state rather than picking arbitrarily or returning both.
    const grant = { expiresAt: 1_700_000_300, primary: HUMAN_HOLDER }
    const state = computeControlState({
      ...BASE,
      status: 'busy',
      heldBy: HUMAN_HOLDER,
      myLeaseExpiresAt: 1_700_000_999,
      myAssistGrant: grant,
    })
    expect(state.kind).toBe('i-assist')
  })

  test('every state produces exactly one control-relevant surface — never a state with two primaries or a primary AND an unrelated one', () => {
    const states: ControlState[] = [
      computeControlState(BASE),
      computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER }),
      computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER }),
      computeControlState({ ...BASE, status: 'manual', heldBy: ME, myLeaseExpiresAt: 1 }),
      computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, myAssistGrant: { expiresAt: 1, primary: JOB_HOLDER } }),
      computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: 'me' }),
    ]
    expect(states.map((s) => s.kind)).toEqual(['free', 'held-by-job', 'held-by-human', 'i-hold', 'i-assist', 'held-by-me-elsewhere'])
  })
})

/**
 * Plan 125 (M90) §3.10, step 125.5 — report 3, verbatim: *"I open a device in
 * browser A — that auto-takes control — and it tells me
 * `bitorex.it@gmail.com is using this device now.` As if it isn't me in this
 * tab, when it is me, under that very account."*
 *
 * The whole state exists because `myLeaseExpiresAt` is a fact about ONE
 * client and says nothing about the operator's other tabs. Every test below
 * pins one half of the rule; the two that matter most are the precedence
 * pair (`myLeaseExpiresAt` first, always) and the auth-off pair (criterion
 * 10: `myUserId === null` changes nothing at all).
 */
describe('held-by-me-elsewhere (plan 125 §3.10, step 125.5)', () => {
  test('two tabs, same signed-in user: the second tab is told it already has control elsewhere, and is offered Resume — never a takeover', () => {
    // Tab A took control explicitly and closed; the lease survives (an
    // explicit lease is deliberately not released on close). Tab B opens:
    // the device is `manual`, the holder is this same user, and THIS client
    // holds nothing of its own.
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: 'me' })
    expect(state.kind).toBe('held-by-me-elsewhere')
    if (state.kind !== 'held-by-me-elsewhere') throw new Error('unreachable')
    expect(state.holder).toBe(ME)
    expect(state.primary).toEqual({ kind: 'resume-control', label: 'Resume control here', disabledReason: null, description: null })
  })

  test('it is never a takeover: the state offers no take-over action at all, and nothing about it is disabled', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: 'me' })
    if (state.kind !== 'held-by-me-elsewhere') throw new Error('unreachable')
    expect(state.primary.kind).not.toBe('take-over')
    expect(state.primary.disabledReason).toBeNull()
  })

  test('criterion 10 — auth OFF (myUserId null) behaves EXACTLY as before: the same holder resolves to held-by-human', () => {
    expect(computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: null }).kind).toBe('held-by-human')
  })

  test('criterion 10 — an OMITTED myUserId is identical to an explicit null, field for field', () => {
    const omitted = computeControlState({ ...BASE, status: 'manual', heldBy: ME })
    const explicitNull = computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: null })
    expect(omitted).toEqual(explicitNull)
  })

  test('criterion 10 — with auth off, EVERY state is unchanged, not just the held-by-human one', () => {
    const withoutAuth = [
      computeControlState(BASE),
      computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER }),
      computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER }),
      computeControlState({ ...BASE, status: 'manual', heldBy: ME, myLeaseExpiresAt: 1 }),
      computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, myAssistGrant: { expiresAt: 1, primary: JOB_HOLDER } }),
    ]
    const withNullUser = withoutAuth.map((_, i) => {
      const inputs = [
        { ...BASE },
        { ...BASE, status: 'busy' as const, heldBy: JOB_HOLDER },
        { ...BASE, status: 'manual' as const, heldBy: HUMAN_HOLDER },
        { ...BASE, status: 'manual' as const, heldBy: ME, myLeaseExpiresAt: 1 },
        { ...BASE, status: 'busy' as const, heldBy: JOB_HOLDER, myAssistGrant: { expiresAt: 1, primary: JOB_HOLDER } },
      ]
      return computeControlState({ ...inputs[i]!, myUserId: null })
    })
    expect(withNullUser).toEqual(withoutAuth)
  })

  test('someone ELSE holding it is still held-by-human, signed in or not — the id comparison must not become a wildcard', () => {
    expect(computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER, myUserId: 'me' }).kind).toBe('held-by-human')
  })

  test('an empty-string user id never matches anybody — "everyone is me" is the one wrong answer here', () => {
    const holderWithNoId: LeaseHolder = { ...HUMAN_HOLDER, id: '' }
    expect(computeControlState({ ...BASE, status: 'manual', heldBy: holderWithNoId, myUserId: '' }).kind).toBe('held-by-human')
  })

  test('an AGENT whose id happens to equal a user id is not you — agent ids and user ids are different id spaces', () => {
    const agent: LeaseHolder = { ...AGENT_HOLDER, id: 'me' }
    expect(computeControlState({ ...BASE, status: 'manual', heldBy: agent, myUserId: 'me' }).kind).toBe('held-by-human')
  })

  test('a JOB whose id happens to equal a user id is still held-by-job — a job hold is never yours to resume', () => {
    const job: LeaseHolder = { ...JOB_HOLDER, id: 'me' }
    expect(computeControlState({ ...BASE, status: 'busy', heldBy: job, myUserId: 'me' }).kind).toBe('held-by-job')
  })

  test('precedence — myLeaseExpiresAt stays the FIRST check: a client that genuinely holds the lease reads i-hold, never "resume" a lease it is already holding', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: ME, myLeaseExpiresAt: 1_700_000_300, myUserId: 'me' })
    expect(state.kind).toBe('i-hold')
  })

  test('precedence — an assist grant still wins over everything, this state included', () => {
    const grant = { expiresAt: 1, primary: HUMAN_HOLDER }
    expect(computeControlState({ ...BASE, status: 'manual', heldBy: ME, myAssistGrant: grant, myUserId: 'me' }).kind).toBe('i-assist')
  })

  test('precedence — a device nobody holds is still free, whoever is signed in', () => {
    expect(computeControlState({ ...BASE, heldBy: null, myUserId: 'me' }).kind).toBe('free')
  })

  test('assistRowState — assisting yourself is not on offer (co-control.ts refuses a grant unless someone ELSE holds it)', () => {
    expect(assistRowState(computeControlState({ ...BASE, status: 'manual', heldBy: ME, myUserId: 'me' }))).toBe('unavailable')
  })
})

describe('heldByMe — the one shared definition of "that holder is me" (plan 125 §3.10)', () => {
  test('a signed-in user holding it returns the holder itself, so a caller can read its id for the takeOverFrom CAS', () => {
    expect(heldByMe(ME, 'me')).toBe(ME)
  })

  test('null holder, null user, empty user, another user, an agent, a job — all null', () => {
    expect(heldByMe(null, 'me')).toBeNull()
    expect(heldByMe(ME, null)).toBeNull()
    expect(heldByMe(ME, undefined)).toBeNull()
    expect(heldByMe({ ...HUMAN_HOLDER, id: '' }, '')).toBeNull()
    expect(heldByMe(HUMAN_HOLDER, 'me')).toBeNull()
    expect(heldByMe({ ...AGENT_HOLDER, id: 'me' }, 'me')).toBeNull()
    expect(heldByMe({ ...JOB_HOLDER, id: 'me' }, 'me')).toBeNull()
  })
})

/**
 * Plan 105 §9 Q1, ANSWERED by plan 125 §3.11 (step 125.6, 2026-08-25): for a
 * person, Take control is primary and Assist secondary; for an agent the two
 * stay equal. The caption that used to stand in for this decision — "Join
 * them, or take over — not decided which should be the default here" — is
 * gone, and each action carries its own explanation instead.
 */
describe('held-by-human weighting (plan 105 §9 Q1, answered by plan 125 §3.11)', () => {
  test('a PERSON holding it: Take control is first and the weighting says so', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER })
    if (state.kind !== 'held-by-human') throw new Error('unreachable')
    expect(state.weighting).toBe('take-over-first')
    expect(state.options[0]?.kind).toBe('take-over')
  })

  test('an AGENT holding it: the two stay EQUAL — joining a running automation is a genuinely likely intent', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: AGENT_HOLDER })
    if (state.kind !== 'held-by-human') throw new Error('unreachable')
    expect(state.weighting).toBe('equal')
    expect(state.options.map((o) => o.kind).sort()).toEqual(['assist', 'take-over'])
  })

  test('both actions explain themselves — the operator is told what each button does, never handed our own indecision', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER })
    if (state.kind !== 'held-by-human') throw new Error('unreachable')
    for (const opt of state.options) {
      expect(opt.description).toBeTruthy()
      expect(opt.description).not.toMatch(/not decided|undecided/i)
    }
    // Two different acts, two different sentences — never one pasted twice.
    expect(new Set(state.options.map((o) => o.description)).size).toBe(state.options.length)
  })

  test('a disabled Assist keeps its reason, which is what the operator needs when the button cannot be pressed', () => {
    const state = computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER, coControlMode: 'off' })
    if (state.kind !== 'held-by-human') throw new Error('unreachable')
    const assist = state.options.find((o) => o.kind === 'assist')
    expect(assist?.disabledReason).toBe('Assisting is turned off for this farm.')
  })

  test('held-by-job’s secondary take-over carries NO description: "ends their control" is a plainly wrong sentence for a hold that is never takeable', () => {
    const state = computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER })
    if (state.kind !== 'held-by-job') throw new Error('unreachable')
    expect(state.secondary.description).toBeNull()
  })
})

describe('useControlState — the useMemo-wrapped hook (plan 105 §5 step 105.1)', () => {
  test('wraps computeControlState identically', () => {
    const { result } = renderHook(() => useControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER }))
    expect(result.current.kind).toBe('held-by-job')
  })

  test('re-rendering with the same inputs is stable (memoized), and a real input change updates it', () => {
    const { result, rerender } = renderHook((props: Parameters<typeof useControlState>[0]) => useControlState(props), {
      initialProps: BASE,
    })
    expect(result.current.kind).toBe('free')
    const first = result.current
    rerender(BASE)
    expect(result.current).toBe(first)
    rerender({ ...BASE, status: 'busy', heldBy: JOB_HOLDER })
    expect(result.current.kind).toBe('held-by-job')
  })
})

/**
 * `deriveAssistActivity` (plan 105 §3.2) — the badge split, derived purely
 * from the grant's own `expiresAt` plus the configured TTL (no new field,
 * no core change — see the file's own header for the math).
 */
describe('deriveAssistActivity (plan 105 §3.2)', () => {
  const ttl = 300

  test('a grant touched just now (expiresAt = now + ttl) reads "assisting"', () => {
    const now = 1_700_000_000_000
    const holder = { expiresAt: Math.floor(now / 1000) + ttl }
    expect(deriveAssistActivity(holder, ttl, now)).toBe('assisting')
  })

  test('a grant touched exactly at the activity window boundary still reads "assisting"', () => {
    const now = 1_700_000_000_000
    const holder = { expiresAt: Math.floor(now / 1000) + ttl - ASSIST_ACTIVITY_WINDOW_SEC }
    expect(deriveAssistActivity(holder, ttl, now)).toBe('assisting')
  })

  test('a grant touched just past the activity window reads "may assist"', () => {
    const now = 1_700_000_000_000
    const holder = { expiresAt: Math.floor(now / 1000) + ttl - ASSIST_ACTIVITY_WINDOW_SEC - 1 }
    expect(deriveAssistActivity(holder, ttl, now)).toBe('may-assist')
  })

  test('an idle grant, touched long ago but not yet expired, reads "may assist" — an authorization is not an activity', () => {
    const now = 1_700_000_000_000
    const holder = { expiresAt: Math.floor(now / 1000) + 10 } // 290s since touch, well past the window
    expect(deriveAssistActivity(holder, ttl, now)).toBe('may-assist')
  })

  test('a holder with no expiry at all reads "may assist", never overclaiming activity', () => {
    expect(deriveAssistActivity({ expiresAt: null }, ttl, Date.now())).toBe('may-assist')
  })
})

/**
 * `assistEndCopy` (plan 105 §3.4, §5 step 105.3) — every `AssistEndReason`
 * gets its own wording; `released` gets none ("they stopped — no message
 * needed"); `primary_ended` is the only one that offers Take control.
 */
describe('assistEndCopy — every AssistEndReason, worded per §3.4 (plan 105 §5 step 105.3)', () => {
  test('released: no message at all', () => {
    expect(assistEndCopy('released', DEFAULT_ASSIST_GRANT_TTL_SEC)).toBeNull()
  })

  test('ttl: names the real duration, and that re-assisting is one click', () => {
    const copy = assistEndCopy('ttl', 300)
    expect(copy?.message).toContain('5 minutes')
    expect(copy?.offerTakeControl).toBe(false)
  })

  test('disconnected: their own connection dropped', () => {
    const copy = assistEndCopy('disconnected', DEFAULT_ASSIST_GRANT_TTL_SEC)
    expect(copy?.message).toMatch(/connection dropped/)
    expect(copy?.offerTakeControl).toBe(false)
  })

  test('primary_ended: the device is free now, AND Take control is offered in place', () => {
    const copy = assistEndCopy('primary_ended', DEFAULT_ASSIST_GRANT_TTL_SEC)
    expect(copy?.message).toMatch(/free now/)
    expect(copy?.offerTakeControl).toBe(true)
  })

  test('mode_off: nothing the operator can do', () => {
    const copy = assistEndCopy('mode_off', DEFAULT_ASSIST_GRANT_TTL_SEC)
    expect(copy?.message).toMatch(/turned off for this farm/)
    expect(copy?.offerTakeControl).toBe(false)
  })

  test('every non-released reason produces DISTINCT wording — none is a copy-paste of another', () => {
    const messages = (['ttl', 'disconnected', 'primary_ended', 'mode_off'] as const).map(
      (r) => assistEndCopy(r, DEFAULT_ASSIST_GRANT_TTL_SEC)?.message,
    )
    expect(new Set(messages).size).toBe(messages.length)
  })
})

describe('assistRowState — ActionsList’s pre-existing shape, still derived from the one state (plan 105 §5 step 105.1)', () => {
  test('free -> unavailable', () => {
    expect(assistRowState(computeControlState(BASE))).toBe('unavailable')
  })
  test('held-by-job, coControl on -> available', () => {
    expect(assistRowState(computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER }))).toBe('available')
  })
  test('held-by-job, coControl off -> off', () => {
    expect(assistRowState(computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, coControlMode: 'off' }))).toBe('off')
  })
  test('held-by-human -> available', () => {
    expect(assistRowState(computeControlState({ ...BASE, status: 'manual', heldBy: HUMAN_HOLDER }))).toBe('available')
  })
  test('i-assist -> busy', () => {
    const grant = { expiresAt: 1, primary: JOB_HOLDER }
    expect(assistRowState(computeControlState({ ...BASE, status: 'busy', heldBy: JOB_HOLDER, myAssistGrant: grant }))).toBe('busy')
  })
})
