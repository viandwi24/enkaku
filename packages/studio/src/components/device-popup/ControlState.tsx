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
 * `held-by-human` is deliberately left **undecided** (plan 105 §9 Q1): the
 * owner's original ruling (plan 91 §0.3) covered a JOB holding the device —
 * a warning, not a permission request, because the lease was never going to
 * move. Nothing in that ruling says whether "join them" (Assist) or "take it
 * from them" (a forced takeover) should be the DEFAULT act when the holder is
 * a PERSON instead — the two carry different social consequences, and
 * guessing here is exactly how the reported collision was built the first
 * time. So this state offers both, weighted equally, with a caption saying
 * plainly that the choice is not yet made for the operator — never a silent
 * pick of one over the other.
 *
 * `held-by-human` also covers an **agent** holder, not only a person: an
 * agent's lease is `takeable: true` (`lease-manager.ts`'s `toHolder`) exactly
 * like a person's, and the plan's own open question is scoped to "who holds
 * it, not what kind of actor it is" — the discriminator used below is
 * `holder.takeable`, matching the lease manager's own semantics, not a
 * literal `kind === 'user'` check. A JOB's hold is the one kind that is
 * never takeable, which is what makes `held-by-job` the one state the owner
 * already ruled on.
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

export type ControlActionKind = 'take-control' | 'assist' | 'release-control' | 'stop-assisting' | 'take-over'

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
}

export type ControlState =
  | { kind: 'free'; primary: ControlAction }
  /** A job holds it — the owner's own ruling (plan 91 §0.3): Assist is a warning, not a permission request, because the lease was never going to move. `secondary` reaches `TakeControlDialog` (audit row 26) — which, for a job, shows "View job"/"Close" rather than an actual takeover button, since a job's hold is never takeable. */
  | { kind: 'held-by-job'; holder: LeaseHolder; primary: ControlAction; secondary: ControlAction }
  /** A person (or an agent — see the file header) holds it. Deliberately undecided (§9 Q1): both actions are offered, neither is primary. */
  | { kind: 'held-by-human'; holder: LeaseHolder; undecided: true; options: ControlAction[] }
  /** This client holds the manual lease. */
  | { kind: 'i-hold'; expiresAt: number; primary: ControlAction }
  /** This client holds an assist grant. */
  | { kind: 'i-assist'; expiresAt: number; primaryHolder: LeaseHolder; primary: ControlAction }

export interface UseControlStateInput {
  status: DeviceStatus | null
  heldBy: LeaseHolder | null
  /**
   * THIS client's own manual lease, as an epoch-ms expiry, or `null`. Never
   * derived by comparing `heldBy.id` to a session id: once a farm has real
   * auth, `toHolder` (`lease-manager.ts`) resolves a person's `id` to their
   * authenticated `userId`, not the WS `clientId` — the same reason the
   * legacy device page tracks this from its own presence/viewer list rather
   * than an id comparison. The popup tracks it from its own `lease.acquire`
   * response instead, which is unambiguous regardless of auth.
   */
  myLeaseExpiresAt: number | null
  /** THIS client's own assist grant, or `null`. */
  myAssistGrant: { expiresAt: number; primary: LeaseHolder } | null
  coControlMode: CoControlMode
}

const TAKE_OVER: ControlAction = { kind: 'take-over', label: 'Take control…', disabledReason: null }

function assistUnavailableReason(coControlMode: CoControlMode): string | null {
  return coControlMode === 'off' ? 'Assisting is turned off for this farm.' : null
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
 * 3. Nobody holds it (`free`).
 * 4. A job holds it (`held-by-job`).
 * 5. Someone else (person or agent) holds it (`held-by-human`).
 */
export function computeControlState(input: UseControlStateInput): ControlState {
  const { status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode } = input

  if (myAssistGrant) {
    return {
      kind: 'i-assist',
      expiresAt: myAssistGrant.expiresAt,
      primaryHolder: myAssistGrant.primary,
      primary: { kind: 'stop-assisting', label: 'Stop assisting', disabledReason: null },
    }
  }

  if (myLeaseExpiresAt !== null) {
    return {
      kind: 'i-hold',
      expiresAt: myLeaseExpiresAt,
      primary: { kind: 'release-control', label: 'Release control', disabledReason: null },
    }
  }

  if (!heldBy) {
    return {
      kind: 'free',
      primary: {
        kind: 'take-control',
        label: 'Take control',
        disabledReason: status && status !== 'idle' ? (UNAVAILABLE_REASON[status] ?? 'The device is unavailable') : null,
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
      primary: { kind: 'assist', label: 'Assist', disabledReason: assistUnavailableReason(coControlMode) },
      secondary: TAKE_OVER,
    }
  }

  // A person or an agent — both takeable, both left undecided by §9 Q1.
  return {
    kind: 'held-by-human',
    holder: heldBy,
    undecided: true,
    options: [{ kind: 'assist', label: 'Assist', disabledReason: assistUnavailableReason(coControlMode) }, TAKE_OVER],
  }
}

/** `packages/studio/src/components/device-popup/ControlState.tsx` — plan 105's own declared artefact. See the file header for the full design. */
export function useControlState(input: UseControlStateInput): ControlState {
  const { status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode } = input
  return useMemo(
    () => computeControlState({ status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode }),
    [status, heldBy, myLeaseExpiresAt, myAssistGrant, coControlMode],
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
  return 'unavailable'
}
