import { useMemo } from 'react'
import type { AssistEndReason, CoControlMode, DeviceStatus, LeaseHolder } from '@enkaku/protocol'

/**
 * Why a device cannot take control or a job right now (plan 19 §4.4) — moved
 * here from `DevicePicker.tsx` (plan 105 §5 step 105.1), which now
 * re-exports it, so `computeControlState`'s `free` state can read the same
 * wording without creating an import cycle: `DevicePicker.tsx` itself
 * renders `HolderBadge`, and `HolderBadge` reads THIS file for the assist
 * activity split — `ControlState.tsx` must therefore depend on nothing that
 * depends on it. Kept as the one place this text lives; the device page and
 * the picker still get it via `DevicePicker.tsx`'s re-export, so neither
 * needed its own import changed.
 */
export const UNAVAILABLE_REASON: Partial<Record<DeviceStatus, string>> = {
  offline: 'The device is not connected to this farm',
  busy: 'An automation job is running',
  manual: 'Another client is controlling it',
  quarantined: 'The device was pulled from the queue — return it from the Devices page first',
}

/**
 * "5 minutes" for a round number of minutes — matches `AssistDialog`'s own
 * §3.12 copy example verbatim for the shipped default (`grantTtlSec: 300`) —
 * else `Xm Ys` / `Ns` for a farm that changed the setting to something that
 * does not divide evenly. Moved here from `AssistDialog.tsx` (plan 105 §5
 * step 105.1, for the same import-cycle reason `UNAVAILABLE_REASON` above
 * was moved — `AssistDialog.tsx` pulls in `@/lib/ws` for `WsRequestError`,
 * which `HolderBadge` must never transitively import just to word a badge);
 * `AssistDialog.tsx` re-exports it unchanged.
 */
export function humanTtl(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  if (seconds % 60 === 0) {
    const m = seconds / 60
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * Plan 105 (M70) — one control state, not two competing buttons.
 *
 * The owner's report (plan 105 §0): *"kok saya sering dapat tabrakan antara
 * take control dan assist, terus kadang assist selalu muncul terus labelnya
 * padahal saya sudah ga melakukan hal apapun lagi."* Two separate bugs, both
 * reproduced from the code before this file existed:
 *
 * 1. **Two buttons, mutually exclusive validity, read as peers.** Assist is
 *    structurally valid ONLY while someone else holds the device
 *    (`co-control.ts`'s `grant()` throws `device_not_held` otherwise); Take
 *    control is valid only while nobody does. The old UI rendered both,
 *    unconditionally, so one of the two always meant something the operator
 *    did not intend, and which one was live could flip between the render
 *    and the click (a third party's lease is not this client's to hold
 *    steady). `computeControlState` below is the single place that decides
 *    which ONE action is on offer for the device's CURRENT state — never two.
 *
 * 2. **An authorization rendered as an activity.** An assist grant lives
 *    `coControl.grantTtlSec` seconds (300 by default) and every accepted
 *    input action refreshes it — so a badge reading "Assisting" stayed lit
 *    for up to five minutes after the operator's last touch. `deriveAssistActivity`
 *    below splits "assisting" (input within a short, visible window — present
 *    tense, because it is) from "may assist" (holds a grant, idle).
 *
 * **Plan 103 step 103.11's audit found two more rows in the same shape** —
 * "what can an operator do about who holds a device" — and this plan folds
 * both in rather than leaving them as a separate pass (see plan 105's own
 * §0 "scope expansion" note):
 *
 * - **Row 27 — no way to release control voluntarily.** `i-hold` below
 *   always carries a `release-control` primary action; `DevicePopup.tsx` is
 *   what finally sends `lease.release` from the popup (it never has before).
 * - **Row 26 — no way to take over a stuck device.** Both states where
 *   someone else holds (`held-by-job`, `held-by-human`) carry a `take-over`
 *   action that reaches the existing `TakeControlDialog` — which already,
 *   correctly, refuses to offer an actual takeover button for a job
 *   (`holder.takeable` is always `false` for one) and shows "View job" /
 *   "Close" instead. Reaching the dialog is the fix; the dialog's own,
 *   already-correct per-kind behaviour needed no change.
 *
 * **`held-by-human` was left undecided for one milestone; plan 125 §3.11
 * decides it (2026-08-25).** The owner's original ruling (plan 91 §0.3)
 * covered a JOB holding the device — a warning, not a permission request,
 * because the lease was never going to move. Nothing in that ruling said
 * whether "join them" (Assist) or "take it from them" (a forced takeover)
 * should be the DEFAULT act when the holder is a PERSON instead, so plan 105
 * step 105.1 shipped the state as designed-undecided: both actions, equal
 * weight, and a caption in the popup saying the choice was not yet made.
 * That caption reached a real operator's screen (plan 125 §0.8, report 3),
 * which `docs/design.md`'s writing rules do not allow — we do not hand an
 * operator our own indecision. The answer, plan 125 §3.11: **for a person,
 * Take control is primary and Assist is secondary** — this product's normal
 * operator is one person driving a rack, so the overwhelmingly common intent
 * is "I want this phone", and Assist is the specialised second choice. Both
 * actions still carry their own plain explanation (`ControlAction.description`
 * below); what is gone is the caption that explained nothing.
 *
 * `held-by-human` also covers an **agent** holder, not only a person: an
 * agent's lease is `takeable: true` (`lease-manager.ts`'s `toHolder`) exactly
 * like a person's, so the discriminator for the STATE stays `holder.takeable`,
 * matching the lease manager's own semantics rather than a literal
 * `kind === 'user'` check. A JOB's hold is the one kind that is never
 * takeable, which is what makes `held-by-job` the one state the owner already
 * ruled on. **Within** the state, though, the holder's `kind` is what decides
 * the WEIGHTING (`held-by-human.weighting`, §3.11): joining a running
 * automation is a genuinely likely intent, so an agent holder keeps the two
 * actions equal, while a person holder promotes Take control. Two different
 * questions — "is this one state or two" (takeable) and "which act is the
 * likely one" (kind) — deliberately answered by two different fields.
 *
 * **A device you already hold somewhere else is not held by a stranger
 * (plan 125 §3.10, step 125.5).** `held-by-me-elsewhere` sits between
 * `i-hold` and `free`, for the case that produced report 3 verbatim: take
 * control in one tab, close it (an explicitly-taken lease is deliberately
 * NOT released on close — `DevicePopup.tsx`'s own rule), reopen or open a
 * second tab, and the fresh popup has no `myLeaseExpiresAt` of its own while
 * the device is `manual` and held by *you*. Before this state existed that
 * fell through to `held-by-human` and the popup told the operator their own
 * email address was using the device. Its one action is **Resume control
 * here**, never a takeover: you cannot take a device from yourself, and a
 * confirmation dialog asking you to seize your own phone is worse than
 * useless.
 *
 * **One hook, three surfaces (§4).** `DevicePopup.tsx` is the only surface
 * that ever tracks "do I personally hold this device's lease/assist grant" —
 * a wall tile and a device card never acquire either (`WallTile`'s own
 * header comment: input is unconditionally off there), so they call this
 * same hook with `myLeaseExpiresAt`/`myAssistGrant` fixed at `null` and read
 * only `state.holder`/`state.kind` for their badges, never `state.primary`.
 * `HolderBadge.tsx` shares `deriveAssistActivity` directly (not the whole
 * hook — a badge has no per-device status/coControlMode context of its own
 * to build a full `ControlState` from) so the activity/authorization split
 * is computed identically everywhere it is rendered: the popup's own
 * "Assisting" chrome, the Wall tile's badge, the device card's badge, the
 * device picker's badge, and the legacy device page's header badge.
 */

/** The shipped default (`coControl.grantTtlSec` in `packages/protocol/src/settings.ts`) — used only by a caller that has not fetched the real farm setting (a wall tile, a device card, the device picker: none of them fetch `/api/settings` today, and adding that fetch to every list row for this alone was judged not worth it). `DevicePopup`/`DeviceHeader`, which DO know the real value, always pass it explicitly. */
export const DEFAULT_ASSIST_GRANT_TTL_SEC = 300

/**
 * How recently an accepted input action must have refreshed a grant for it
 * to read as "assisting" rather than "may assist" (§3.2, §8's own risk:
 * "the activity window becomes its own guess — state the number where it
 * lives"). Ten seconds is comfortably longer than one input round trip and
 * comfortably shorter than anything an operator would read as "not moving
 * anymore" — informed by plan 91's own arbiter numbers (a tap holds
 * 40-120 ms, a swipe defaults to 300 ms), not measured against a live
 * session. H1 (plan 105 §5 step 105.4, owner-run) is the TTL question, not
 * this one, but the same session can inform this number too if it turns out
 * wrong in practice.
 */
export const ASSIST_ACTIVITY_WINDOW_SEC = 10

/** How often a live "assisting" badge re-checks its own activity window. Only ever mounted while a badge is actually rendering an assist grant (see `HolderBadge.tsx`'s `AssistHolderBadge`) — never a farm-wide timer. */
export const ASSIST_ACTIVITY_TICK_MS = 2_000

/**
 * "assisting" (input within `ASSIST_ACTIVITY_WINDOW_SEC`, present tense —
 * because it is) versus "may assist" (holds a grant, idle) — §3.2's split,
 * derived from data the grant already carries rather than a new field.
 *
 * The insight that makes this possible with NO core/protocol change: a
 * grant's `touch()` (fired on every accepted assist input, `co-control.ts`)
 * sets `expiresAt = now + grantTtlSec` — so at any later moment, exactly how
 * long ago the last touch happened is recoverable as
 * `grantTtlSec - (expiresAt - now)`. `LeaseHolder.expiresAt` already carries
 * this for every `assistedBy` entry the server publishes (`DeviceInfo`,
 * `assist.changed`), so every surface — including one that never held the
 * grant itself, like a Wall tile watching someone ELSE assist — can derive
 * the same answer with no new broadcast.
 *
 * `expiresAt: null` (a holder shape with no expiry — never produced by a
 * real assist grant, which always sets one, but tolerated here since
 * `LeaseHolderSchema.expiresAt` is nullable and a defensive fixture might
 * omit it) reads as `'may-assist'`: honestly uncertain rather than an
 * overclaimed "active" with nothing to prove it.
 */
export function deriveAssistActivity(
  holder: Pick<LeaseHolder, 'expiresAt'>,
  grantTtlSec: number,
  nowMs: number,
): 'assisting' | 'may-assist' {
  if (holder.expiresAt === null) return 'may-assist'
  const nowSec = Math.floor(nowMs / 1000)
  const secondsSinceTouch = grantTtlSec - (holder.expiresAt - nowSec)
  return secondsSinceTouch <= ASSIST_ACTIVITY_WINDOW_SEC ? 'assisting' : 'may-assist'
}

/**
 * §3.4's table, worded. `released` is the one reason that happens BECAUSE of
 * the operator (their own "Stop assisting" click) — the other four happen TO
 * them, and each needed its own sentence rather than one generic "assisting
 * stopped" notice. Returns `null` for `released`: §3.4's own words, "they
 * stopped — no message needed."
 *
 * `primary_ended` is the one with teeth (§3.3): the holder released, so
 * every grant on the device died with them — and the device is now FREE,
 * exactly when Take control would succeed. `offerTakeControl: true` is what
 * a caller uses to render a real action in the notice, not just a fact.
 */
export function assistEndCopy(reason: AssistEndReason, grantTtlSec: number): { message: string; offerTakeControl: boolean } | null {
  switch (reason) {
    case 'released':
      return null
    case 'ttl':
      return {
        message: `Assisting stopped automatically after ${humanTtl(grantTtlSec)} without input. Assist again any time.`,
        offerTakeControl: false,
      }
    case 'disconnected':
      return { message: 'Assisting stopped — your connection dropped.', offerTakeControl: false }
    case 'primary_ended':
      return { message: 'Assisting stopped — the holder released this device. It is free now.', offerTakeControl: true }
    case 'mode_off':
      return { message: 'Assisting was turned off for this farm.', offerTakeControl: false }
  }
}

export type ControlActionKind = 'take-control' | 'assist' | 'release-control' | 'stop-assisting' | 'take-over' | 'resume-control'

/**
 * Metadata for the one action a state offers — deliberately NOT a bound
 * `onSelect` closure. `computeControlState` is a pure function with no `ws`,
 * no dialog state, and no React effects, which is what makes it (and the
 * hook wrapping it) trivially unit-testable (plan 105 §7: "each of the five
 * states resolves one action; a state change mid-render never yields two").
 * The caller (`DevicePopup.tsx`) switches on `.kind` to wire the real
 * `ws.request`/dialog-open call — the same separation `ActionsList.tsx`'s
 * own `Row` already draws between "what a row says" and "what it does".
 */
export interface ControlAction {
  kind: ControlActionKind
  label: string
  disabledReason: string | null
  /**
   * One plain line saying what this action DOES, or `null` where the state's
   * own sentence already says it (plan 125 §3.11, step 125.6).
   *
   * Non-null exactly where a state offers a real CHOICE between two acts with
   * different consequences for someone else — today that is `held-by-human`'s
   * Take control / Assist pair, which used to be captioned "Join them, or
   * take over — not decided which should be the default here": our own open
   * design question, rendered verbatim to an operator (plan 125 §0.8). The
   * caption is gone; each button now explains itself instead.
   *
   * Deliberately `null` for a state whose one action is unambiguous from the
   * sentence above it (`free` → "Nobody holds this device.", `i-hold` → a
   * countdown, `held-by-me-elsewhere` → "You are already controlling this
   * device somewhere else."). Repeating the obvious beside a lone button is
   * noise, and `docs/design.md`'s writing rules are as much about what not
   * to say.
   */
  description: string | null
}

export type ControlState =
  | { kind: 'free'; primary: ControlAction }
  /** A job holds it — the owner's own ruling (plan 91 §0.3): Assist is a warning, not a permission request, because the lease was never going to move. `secondary` reaches `TakeControlDialog` (audit row 26) — which, for a job, shows "View job"/"Close" rather than an actual takeover button, since a job's hold is never takeable. */
  | { kind: 'held-by-job'; holder: LeaseHolder; primary: ControlAction; secondary: ControlAction }
  /**
   * A person (or an agent — see the file header) who is NOT you holds it.
   * `options` is always ordered most-prominent-first; `weighting` says
   * whether that order means anything (plan 105 §9 Q1, answered by plan 125
   * §3.11): `'take-over-first'` for a person — Take control is the primary
   * action and Assist the secondary — and `'equal'` for an agent, where
   * joining a running automation is a genuinely likely intent and neither
   * act is the obvious default.
   */
  | { kind: 'held-by-human'; holder: LeaseHolder; weighting: 'take-over-first' | 'equal'; options: ControlAction[] }
  /** This client holds the manual lease. */
  | { kind: 'i-hold'; expiresAt: number; primary: ControlAction }
  /**
   * YOU hold it — in another tab, window, or browser, not in this client
   * (plan 125 §3.10, step 125.5). Reached only when `myLeaseExpiresAt` says
   * nothing (this client never acquired the lease itself) AND the holder's
   * authenticated `userId` is yours. Its one action moves the lease here; it
   * is never worded, weighted, or confirmed as a takeover.
   */
  | { kind: 'held-by-me-elsewhere'; holder: LeaseHolder; primary: ControlAction }
  /** This client holds an assist grant. */
  | { kind: 'i-assist'; expiresAt: number; primaryHolder: LeaseHolder; primary: ControlAction }

export interface UseControlStateInput {
  status: DeviceStatus | null
  heldBy: LeaseHolder | null
  /**
   * THIS client's own manual lease, as an epoch-ms expiry, or `null`. The
   * popup tracks it from its own `lease.acquire` response, which is
   * unambiguous regardless of auth — it is a fact about this client, not an
   * inference about a person.
   *
   * **This comment used to end with a prohibition that has since expired,
   * and the correction is worth keeping visible** (plan 125 §0.8): it said
   * this must be "never derived by comparing `heldBy.id` to a session id:
   * once a farm has real auth, `toHolder` (`lease-manager.ts`) resolves a
   * person's `id` to their authenticated `userId`, not the WS `clientId`."
   * The observation was right and the conclusion aged out. Comparing
   * `heldBy.id` to a SESSION id is still wrong, for exactly that reason —
   * but auth shipped, `GET /api/auth/me` returns a `user.id`, and comparing
   * `heldBy.id` to THAT is now precisely the correct check. It is what
   * `myUserId` below does, and what stops the popup naming the operator to
   * themselves as the device's current holder. What has NOT changed is which
   * of the two is authoritative: this field stays the first check, because
   * "one of my clients holds it" and "THIS client holds it" are different
   * facts and only one of them licenses input.
   */
  myLeaseExpiresAt: number | null
  /** THIS client's own assist grant, or `null`. */
  myAssistGrant: { expiresAt: number; primary: LeaseHolder } | null
  coControlMode: CoControlMode
  /**
   * The signed-in user's `id` (`GET /api/auth/me` → `user.id`, read from
   * `useAuth()`), or `null` when nobody is signed in — plan 125 §3.10, step
   * 125.5.
   *
   * **Optional on purpose.** Three surfaces call this hook only to read
   * `state.kind`/`state.holder` for a badge and never render an action at
   * all (a Wall tile, a device card, `wall/DeviceContextMenu.tsx` — see the
   * file header's "one hook, three surfaces"); none of them has, or needs,
   * an auth context, and an omitted value behaves exactly like `null`, which
   * is exactly today's behaviour. `DevicePopup.tsx` — the one surface that
   * offers control actions — always passes it explicitly.
   *
   * `null` (auth disabled, or a local farm with no signed-in user) must
   * change NOTHING about how this function behaves — plan 125 acceptance
   * criterion 10, pinned by its own test in `ControlState.test.ts`.
   */
  myUserId?: string | null
}

/**
 * Shared by `held-by-job` (where it is a quiet secondary link with no
 * description — the owner's ruling, plan 91 §0.3, already settled that case
 * and `TakeControlDialog` shows "View job"/"Close" for it anyway) and by
 * `held-by-human`, which re-describes it below: "ends their control" is the
 * honest sentence for a person or an agent and a plainly wrong one for a
 * job's untakeable hold, so the wording lives with the state that renders
 * it rather than on the shared constant.
 */
const TAKE_OVER: ControlAction = { kind: 'take-over', label: 'Take control…', disabledReason: null, description: null }

/** §3.11's own answer, worded for the operator: what each of the two buttons actually does to the person already on the device. */
const TAKE_OVER_DESCRIPTION = 'Ends their control and gives the device to you.'
const ASSIST_DESCRIPTION = 'Drive alongside them — they keep control.'

function assistUnavailableReason(coControlMode: CoControlMode): string | null {
  return coControlMode === 'off' ? 'Assisting is turned off for this farm.' : null
}

/**
 * "Is the person holding this device the person reading this screen?" — plan
 * 125 §3.10, step 125.5. The ONE definition of that comparison: both
 * `computeControlState` below (which turns it into `held-by-me-elsewhere`)
 * and `DevicePopup.tsx`'s widened auto-claim (§4.6: "idle, or held by me")
 * read it here rather than each spelling out their own, so the state the
 * popup renders and the claim it decides to make can never disagree.
 *
 * Returns the holder itself, not a boolean, so a caller that needs the id
 * (the auto-claim's `takeOverFrom`) does not have to re-narrow `heldBy`.
 *
 * Every clause is load-bearing:
 * - `myUserId` truthy, not merely non-null — an empty string would match any
 *   holder whose id failed to resolve, and "everyone is me" is the one wrong
 *   answer this whole idea has to avoid.
 * - `kind === 'user'` — an agent's `id` is an agentId from an entirely
 *   different id space (`toHolder`, `lease-manager.ts`), and a job's is a
 *   jobId.
 * - the id equality itself — `LeaseHolderSchema.id` is "clientId for a user
 *   (or the authenticated userId when known)", and `toHolder` writes
 *   `holderUserId ?? holder`, so a match here is always an AUTHENTICATED
 *   match: an unauthenticated hold carries a bare clientId, which can never
 *   equal a real `user.id`.
 */
export function heldByMe(heldBy: LeaseHolder | null, myUserId: string | null | undefined): LeaseHolder | null {
  if (!myUserId || !heldBy) return null
  return heldBy.kind === 'user' && heldBy.id === myUserId ? heldBy : null
}

/**
 * The pure derivation `useControlState` wraps in a `useMemo`. Exported on
 * its own so a test (and a caller with no React tree to hand, if one ever
 * needs it) can call it directly.
 *
 * Precedence, checked in this exact order, so a device that is somehow both
 * "held by me" and "held by someone else" in stale local state still
 * resolves to exactly one state rather than two:
 *
 * 1. I hold an assist grant (`i-assist`) — the narrowest, most specific fact
 *    about THIS client.
 * 2. I hold the manual lease (`i-hold`).
 * 3. I hold it somewhere else (`held-by-me-elsewhere`) — plan 125 §3.10.
 * 4. Nobody holds it (`free`).
 * 5. A job holds it (`held-by-job`).
 * 6. Someone else (person or agent) holds it (`held-by-human`).
 *
 * **Steps 2 and 3 are ordered, not interchangeable, and must stay that way**
 * (plan 125 §3.10, and its own §8 risk row). `myLeaseExpiresAt` is the
 * unambiguous fact about THIS client — it came from this client's own
 * `lease.acquire` response — and it is correct even with auth off, and even
 * when two clients share one identity. The `myUserId` comparison is a
 * second, weaker signal (it can only ever say "one of your clients holds
 * it", never "this one does"), used exclusively when the first says nothing.
 * Reordering them would make a client that genuinely holds the lease render
 * "Resume control here" for a lease it is already holding.
 */
export function computeControlState(input: UseControlStateInput): ControlState {
  const { status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode, myUserId = null } = input

  if (myAssistGrant) {
    return {
      kind: 'i-assist',
      expiresAt: myAssistGrant.expiresAt,
      primaryHolder: myAssistGrant.primary,
      primary: { kind: 'stop-assisting', label: 'Stop assisting', disabledReason: null, description: null },
    }
  }

  if (myLeaseExpiresAt !== null) {
    return {
      kind: 'i-hold',
      expiresAt: myLeaseExpiresAt,
      primary: { kind: 'release-control', label: 'Release control', disabledReason: null, description: null },
    }
  }

  // Plan 125 §3.10 (step 125.5) — report 3, at its source: this client did
  // not acquire the lease, but the person who did is the person reading this
  // screen. `heldByMe` above is the whole comparison, and why each half of
  // it is there.
  const mine = heldByMe(heldBy, myUserId)
  if (mine) {
    return {
      kind: 'held-by-me-elsewhere',
      holder: mine,
      primary: { kind: 'resume-control', label: 'Resume control here', disabledReason: null, description: null },
    }
  }

  if (!heldBy) {
    return {
      kind: 'free',
      primary: {
        kind: 'take-control',
        label: 'Take control',
        disabledReason: status && status !== 'idle' ? (UNAVAILABLE_REASON[status] ?? 'The device is unavailable') : null,
        description: null,
      },
    }
  }

  if (!heldBy.takeable) {
    // A job's hold today (`toHolder`, `lease-manager.ts`) — never takeable,
    // which is exactly the case the owner's own ruling (plan 91 §0.3)
    // covers: Assist is offered as a warning, and `secondary` still reaches
    // `TakeControlDialog` (audit row 26), which shows the honest "View
    // job"/"Close" pair for this holder rather than a takeover button.
    return {
      kind: 'held-by-job',
      holder: heldBy,
      primary: { kind: 'assist', label: 'Assist', disabledReason: assistUnavailableReason(coControlMode), description: null },
      secondary: TAKE_OVER,
    }
  }

  // A person or an agent — both takeable (the file header has why the state
  // is one, not two). Plan 105 §9 Q1, answered by plan 125 §3.11: a person's
  // hold promotes Take control, because a single operator driving a rack
  // overwhelmingly means "I want this phone"; an agent's hold keeps the pair
  // equal, because joining a running automation is a genuinely likely intent.
  // `options` is ordered most-prominent-first either way, so a renderer never
  // has to re-derive the ranking from `weighting`.
  const assist: ControlAction = {
    kind: 'assist',
    label: 'Assist',
    disabledReason: assistUnavailableReason(coControlMode),
    description: ASSIST_DESCRIPTION,
  }
  const takeOver: ControlAction = { ...TAKE_OVER, description: TAKE_OVER_DESCRIPTION }
  return heldBy.kind === 'agent'
    ? { kind: 'held-by-human', holder: heldBy, weighting: 'equal', options: [assist, takeOver] }
    : { kind: 'held-by-human', holder: heldBy, weighting: 'take-over-first', options: [takeOver, assist] }
}

/** `packages/studio/src/components/device-popup/ControlState.tsx` — plan 105's own declared artefact. See the file header for the full design. */
export function useControlState(input: UseControlStateInput): ControlState {
  // `myUserId` is normalised to `null` here (not left `undefined`) so the
  // memo key is stable across a caller that omits the field entirely and one
  // that passes `null` — plan 125 §3.10; see `UseControlStateInput` for why
  // the field is optional at all.
  const { status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode, myUserId = null } = input
  return useMemo(
    () => computeControlState({ status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode, myUserId }),
    [status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode, myUserId],
  )
}

/**
 * A narrow adapter for `ActionsList.tsx`'s pre-existing "Assist" row shape
 * (`'unavailable' | 'off' | 'busy' | 'available'`) — kept rather than
 * widening that component's own prop to the full `ControlState`, since the
 * fixed-height row list (plan 103 §4.2) only ever needed the one fact this
 * mapping produces, and `SidePanel`/`ActionsList`'s existing tests already
 * pin that shape. The state itself still comes from ONE place
 * (`computeControlState` above) — this only re-describes it for a caller
 * that predates this plan and does not need the rest.
 */
export function assistRowState(state: ControlState): 'unavailable' | 'off' | 'busy' | 'available' {
  if (state.kind === 'i-assist') return 'busy'
  if (state.kind === 'held-by-job') return state.primary.disabledReason ? 'off' : 'available'
  if (state.kind === 'held-by-human') {
    const assist = state.options.find((o) => o.kind === 'assist')
    return assist?.disabledReason ? 'off' : 'available'
  }
  // `held-by-me-elsewhere` (plan 125 §3.10) falls through to `'unavailable'`
  // with `free`/`i-hold`, and that is the correct answer rather than a missed
  // case: `co-control.ts`'s `grant()` throws `device_not_held` unless someone
  // ELSE holds the device, and "someone else" is precisely what this state
  // rules out. Assisting yourself is not a thing to offer.
  return 'unavailable'
}
