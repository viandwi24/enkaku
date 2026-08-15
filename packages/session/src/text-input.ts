import type { GuestAgentClientRunner } from '@enkaku/drivers'
import type { GuestAgentCapability, TextInputMode, Transport } from '@enkaku/protocol'
import type { Logger } from './logger'

/**
 * The three rungs the text ladder actually has, in the order it tries them.
 *
 * Plan 90 §3.3 originally designed a fourth rung between these two — `'clipboard'` (clipboard
 * paste) — fully implemented end to end (a real branch in `ws-handlers.ts`/`device-executor.ts`,
 * a `clipboard.overwritten` device event). It was never once reachable: `resolveTextRoute`'s
 * `hasScrcpyControl` precondition is provably identical, at both call sites, to `session.ts`'s
 * `scrcpy !== null` — the exact boolean that ALSO gates rung 2's `INJECT_TEXT`, and every engine
 * that boolean can be true for (`scrcpy-uhid`, `scrcpy-sdk`) already declares `text-unicode`. So
 * "a scrcpy control socket with ASCII-only text" — the shape the clipboard rung existed for —
 * cannot occur in this codebase's architecture, not merely "does not happen to occur today"
 * (`docs/plans/96-m61-hotfixes.md` §96.7 investigated this and confirmed it; §96.8 removed the
 * dead rung on the strength of that finding). **Do not re-add a clipboard-paste rung here** without
 * first widening `resolveTextRoute`'s signature with a fact that can actually tell "ASCII-only
 * control socket" apart from "unicode control socket" — no such fact exists anywhere in this
 * codebase today, and inventing one would mean forking the version-locked scrcpy-server protocol
 * itself, which CLAUDE.md forbids.
 */
export type TextRung = 'agent-ime' | 'scrcpy-text' | 'adb-ascii'

/** Only printable ASCII (`\x20`-`\x7e`) — the exact range `escapeInputText` (`@enkaku/drivers`) accepts, kept in lockstep so a string this resolver calls ASCII is never one `AdbInput.text()` then refuses. */
const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/

export interface TextRouteDecision {
  rung: TextRung
  /**
   * Always false today. Plan 90 §3.3 designed a clipboard-paste rung with a real clipboard side
   * effect and this field existed to flag it; that rung was proven architecturally unreachable and
   * removed (`docs/plans/96-m61-hotfixes.md` §96.7, §96.8) before any caller ever saw it true.
   * Kept as a boolean rather than deleted, so every existing caller that already destructures it
   * needs no change, and a future rung with a genuine side effect has somewhere honest to report it.
   */
  clobbersClipboard: boolean
  /** Set when NO rung can carry this string as requested — the precondition, phrased for a human (plan 59: a precondition is not a failure). */
  unmet: { code: string; message: string; action?: 'install-agent' | 'update-agent' } | null
}

/**
 * The one place that turns a candidate string plus what this session currently has available into
 * a rung (plan 90 §3.3, §4.5). Pure — no I/O, no Transport, no guest-agent client — so it is fully
 * unit-testable, and every caller (the WS handler, the script executor, and later plan 91's
 * fan-out) reads the SAME decision rather than re-deriving any part of the ladder itself.
 *
 * `prefer` changes how STRICT this is, not which facts it considers:
 * - `'device'` never returns `agent-ime`, even when `agentCapabilities`/`imeCurrent` say it would
 *   otherwise be usable — the mode's whole point is "never touch the device's own default IME".
 * - `'agent'` ALWAYS routes through the agent or refuses with a NAMED precondition — it never
 *   silently falls through to rung 2/3 the way `'auto'` does. This is the one branch that can
 *   set `unmet` while still reporting `rung: 'agent-ime'` (the rung the caller asked for, not one
 *   that was silently substituted).
 * - `'auto'` (the default) tries every rung in order and only sets `unmet` when NONE of them can
 *   carry the string at all — the case a CJK string reaches `adb-input` with no scrcpy control
 *   socket and no usable agent, which today (F25) is forwarded to the driver and dies as
 *   `INPUT_TEXT_UNSUPPORTED` from inside it instead of being refused as an unmet precondition.
 */
export function resolveTextRoute(input: {
  text: string
  /** From the guest agent's own `hello()`, learned once at session start; `null` when no agent is reachable for this session at all (not installed, or the session has no guest-agent client wired). */
  agentCapabilities: GuestAgentCapability[] | null
  /** Whether the agent's IME is this device's live default input method — read back after `ime set`, never assumed from the write alone. */
  imeCurrent: boolean
  /** Whether this session has a scrcpy control socket (rung 2 needs one — F22). `false` on the `adb-input` fallback engine. */
  hasScrcpyControl: boolean
  prefer: TextInputMode
}): TextRouteDecision {
  const { text, agentCapabilities, imeCurrent, hasScrcpyControl, prefer } = input

  const isAscii = PRINTABLE_ASCII_ONLY.test(text)
  const agentHasTextInput = agentCapabilities?.includes('text-input') ?? false
  const agentUsable = agentHasTextInput && imeCurrent

  // Rung 1: agent-ime. Never considered under `prefer: 'device'` — that mode's entire point is
  // leaving the device's own default IME alone (§3.2).
  if (prefer !== 'device' && agentUsable) {
    return { rung: 'agent-ime', clobbersClipboard: false, unmet: null }
  }

  if (prefer === 'agent') {
    // The operator asked specifically for the agent path. It is not usable — refuse with a named
    // precondition naming the actual fix, never a silent fall-through to a different rung.
    return {
      rung: 'agent-ime',
      clobbersClipboard: false,
      unmet: agentHasTextInput
        ? {
            code: 'E_TEXT_AGENT_IME_NOT_CURRENT',
            message: "this device's guest agent keyboard is installed but is not the device's active input method right now",
            action: 'update-agent',
          }
        : {
            code: 'E_TEXT_AGENT_UNAVAILABLE',
            message: "this device has no guest agent keyboard available — install the guest agent to type through it",
            action: 'install-agent',
          },
    }
  }

  // Rung 2: scrcpy INJECT_TEXT — unicode-clean on both scrcpy input engines (F22, and the
  // `TextRung` doc comment above for why a clipboard-paste rung was designed here and then
  // removed rather than ever winning against this one).
  if (hasScrcpyControl) {
    return { rung: 'scrcpy-text', clobbersClipboard: false, unmet: null }
  }

  // No scrcpy control socket (the `adb-input` fallback engine). Plain ASCII still has a real,
  // side-effect-free path (rung 3) — take it.
  if (isAscii) {
    return { rung: 'adb-ascii', clobbersClipboard: false, unmet: null }
  }

  // Nothing can carry this string: refuse with a named precondition instead of letting
  // `AdbInput.text()` throw `INPUT_TEXT_UNSUPPORTED` from inside the driver (F25, the bug this
  // resolver exists to fix). `rung` still names the path that WOULD have run had the text been
  // ASCII, so a caller logging this decision can see which engine was actually active.
  return {
    rung: 'adb-ascii',
    clobbersClipboard: false,
    unmet: {
      code: 'E_TEXT_UNICODE_UNSUPPORTED',
      message: "this device's input engine can only type ASCII; install the guest agent to type non-ASCII text",
      action: 'install-agent',
    },
  }
}

/**
 * [android.view.inputmethod.InputMethodInfo.getId] — mirrors `EnkakuIme.COMPONENT_ID`
 * (`apps/guest-agent/.../input/EnkakuIme.kt`) exactly. Both sides changing this together is the
 * same discipline the guest-agent wire protocol already follows (CLAUDE.md).
 */
export const ENKAKU_IME_COMPONENT_ID = 'dev.enkaku.guestagent/.input.EnkakuIme'

export interface TextInputSetup {
  /** Read first, restore after, idempotent on a second call — `orientation.ts`'s `applyRotation` is the template this mirrors verbatim in shape. */
  revert: () => Promise<void>
  /** From the guest agent's `hello()`, learned once here; `null` when `mode: 'device'` (nothing is even asked) or no agent is reachable. */
  agentCapabilities: GuestAgentCapability[] | null
  /** Whether the agent's IME is confirmed as the device's live default input method — read back after the write, never assumed from it. */
  imeCurrent: boolean
}

/**
 * Screen-keyboard setup (plan 90 §3.2, §4.5, §5 step 90.5): the identical shape `applyRotation`
 * (`./orientation.ts`) uses, called beside it in `createSession` — read what the device already
 * has, apply the requested mode, hand back an idempotent revert thunk restoring the prior value.
 *
 * `mode: 'device'` touches nothing (this session's IME stays whatever it already was) and the
 * returned revert is a no-op — there is nothing to put back, exactly like `applyRotation`'s own
 * `'device'` branch. `'auto'`/`'agent'` both attempt the switch identically here: the DIFFERENCE
 * between the two modes is entirely in `resolveTextRoute`'s STRICTNESS about falling back when the
 * switch did not take, not in whether this function tries.
 *
 * Nothing is attempted at all when no guest-agent client is wired for this session
 * (`withGuestAgentClient` undefined) or the agent does not advertise `text-input` — there is no
 * component to enable, so writing `ime set <id>` would just fail loudly for no benefit; the
 * absence is reported honestly via `agentCapabilities`/`imeCurrent` instead, and
 * `resolveTextRoute` reads that as "rung 1 unavailable".
 */
export async function applyTextInput(
  transport: Transport,
  opts: {
    mode: TextInputMode
    withGuestAgentClient?: GuestAgentClientRunner
    log: Logger
  },
): Promise<TextInputSetup> {
  const { mode, withGuestAgentClient, log } = opts
  const noop: TextInputSetup = { revert: async () => {}, agentCapabilities: null, imeCurrent: false }
  if (mode === 'device') return noop
  if (!withGuestAgentClient) return noop

  const agentCapabilities = await withGuestAgentClient((client) => client.hello())
    .then((hello) => hello.capabilities)
    .catch((err) => {
      log.debug(`text input: could not reach the guest agent to learn its capabilities: ${String(err)}`)
      return null
    })
  if (!agentCapabilities?.includes('text-input')) {
    return { revert: async () => {}, agentCapabilities, imeCurrent: false }
  }

  const previous = await transport
    .exec('settings get secure default_input_method', { profile: 'probe' })
    .then((r) => r.stdout.trim())
    .catch(() => '')

  await transport
    .exec(`ime enable ${ENKAKU_IME_COMPONENT_ID}`, { profile: 'probe' })
    .catch((err) => log.debug(`text input: ime enable failed: ${String(err)}`))
  await transport
    .exec(`ime set ${ENKAKU_IME_COMPONENT_ID}`, { profile: 'probe' })
    .catch((err) => log.debug(`text input: ime set failed: ${String(err)}`))

  // Read back rather than trust the write (the same discipline `Ipv6Leak.isBlocked` and
  // `MockLocation` already use on the Kotlin side) — a component that failed to enable (not
  // installed, R8 stripped it on a bad build) leaves `ime set` a silent no-op, and `imeCurrent`
  // must say so honestly rather than assume the write took.
  const confirmed = await transport
    .exec('settings get secure default_input_method', { profile: 'probe' })
    .then((r) => r.stdout.trim())
    .catch(() => '')
  const imeCurrent = confirmed === ENKAKU_IME_COMPONENT_ID

  const revert = async (): Promise<void> => {
    // No safe guessed value to fall back to when the prior value could not be read — leaving the
    // agent's IME in place is the honest partial recovery, the same reasoning `applyRotation`'s
    // revert uses for `user_rotation` when ITS prior value is unreadable.
    if (!previous || previous === 'null') return
    await transport
      .exec(`ime set ${previous}`, { profile: 'probe' })
      .catch((err) => log.debug(`text input: ime restore failed: ${String(err)}`))
  }

  return { revert, agentCapabilities, imeCurrent }
}
