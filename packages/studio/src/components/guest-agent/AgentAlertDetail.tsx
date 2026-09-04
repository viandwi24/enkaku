'use client'

import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react'
import { PreparationComponentStatusSchema, type AgentState, type PreparationComponentStatus } from '@enkaku/protocol'
import { toast } from 'sonner'
import { Button, ErrorState, cn, describeApiError, relativeTime } from '@enkaku/ui'
import { usePreparation } from '@/lib/use-preparation'
import { useNow } from '@/lib/useNow'
import { runOnDevice } from '@/lib/actions'

/**
 * What the `Agent failed` chip opens (the owner's own ask: *"kalau ada agent
 * failed badge harusnya ada tombol cepat dong buat retry, terus kalau ada
 * error failed tampilkan juga errornya kenapa dong"*).
 *
 * Until this component the chip carried ONE fixed `title` string — "the guest
 * agent could not be installed or reached" — which is true of every possible
 * cause and therefore says nothing. The real reason has existed all along; it
 * was simply never on screen next to the badge that announces it.
 *
 * **Where the reason comes from, and why not the other route.** `GET
 * /api/devices/:id/preparation` (`api/device-preparation.ts`), fetched on
 * demand when this panel mounts — NOT a widened `agent` field on `GET
 * /api/devices`. The list route flattens the whole status to a bare
 * `AgentState` string on purpose (`DeviceInfoSchema.agent`'s own doc
 * comment), and the reasons this farm actually produces are up to ~1.4 KB of
 * Java stack trace each. Widening the list field would put that trace on
 * every device row of every poll, and on every `device.added`/`device.status`
 * broadcast, for a fleet the owner intends to grow to twenty phones — the
 * Wall renders all of them, and five of nine devices were `failed` on this
 * farm when this was built, so that is not a hypothetical cost. The price of
 * fetching on demand is real too (a click waits, and the fetch can fail on
 * its own), and it is paid honestly here: a spinner while it loads, an
 * `ErrorState` with its own Retry when it does not, and the coarse state from
 * the chip shown in the header meanwhile so the panel is never blank.
 *
 * **Every reason is opaque text.** It is never parsed, never matched against
 * known substrings, never rewritten into prettier copy — the same rule
 * `AgentStatus.reason`/`PreparationComponentStatus.reason` already state
 * ("always verbatim, never summarised"). The only structure imposed is the
 * first newline: the actionable sentence in every real example leads, and the
 * rest is one click away rather than either dominating the panel or being
 * thrown away.
 *
 * **A state this build does not recognise renders as its own raw string,
 * with no action offered.** That is not defensive decoration: `AgentState`
 * grew a seventh member (`consent-required`) from another worker WHILE this
 * component was being written, and every lookup below is keyed
 * `Record<string, …>` or ends in a `default:` for exactly that reason — a
 * `Record<PreparationState, …>` would have made this file fail to compile
 * the moment that landed, which is the right behaviour for an exhaustive
 * mapping and the wrong one for a panel whose whole job is to show an
 * operator whatever the server actually said.
 */

/**
 * `packages/core/src/device/preparation/guest-agent-status.ts`'s
 * `GUEST_AGENT_COMPONENT_ID`, which is a core-side constant with no protocol
 * export — the same literal `PreparationPanel.tsx` already keys off.
 */
const GUEST_AGENT_ID = 'guest-agent'

/**
 * Deliberately `Record<string, …>` rather than `Record<PreparationState, …>`
 * — see this file's header. An unmapped state falls back to its own raw
 * value, never to `undefined` and never to a fabricated stand-in.
 */
const STATE_WORD: Record<string, string> = {
  absent: 'not installed',
  provisioning: 'installing…',
  ready: 'ready',
  outdated: 'update available',
  failed: 'failed',
  unsupported: 'unsupported',
  // Not "partly ready" and not "failed" — `AgentStateSchema`'s own comment is
  // explicit that this state is neither, and `docs/design.md`'s rule ("a
  // degraded or partial state is never worded as the full one") forbids
  // rounding it toward either.
  'consent-required': 'needs VPN consent',
}

const STATE_TONE: Record<string, string> = {
  absent: 'text-fg-subtle',
  provisioning: 'text-led-active',
  ready: 'text-led-ok',
  outdated: 'text-led-warn',
  failed: 'text-led-danger',
  unsupported: 'text-fg-subtle',
  'consent-required': 'text-led-warn',
}

/**
 * Which states earn a retry — and which must not offer one.
 *
 * `unsupported` is the load-bearing exclusion (`AgentStateSchema`'s own doc
 * comment: "the device's API level is below the agent's floor, terminal by
 * design, not a failure to retry"). A button there would spend an operator's
 * click on a pass that cannot possibly change the answer, and the panel says
 * so in words instead. `ready` has nothing to fix; `provisioning` is already a
 * pass in flight and a second one would only race the provisioner's own
 * dedup. `absent`/`outdated`/`failed` are the three a forced pass can
 * genuinely move — the SAME split `PreparationPanel.tsx` makes, worded the
 * same way so the two surfaces do not name one action two things.
 *
 * `consent-required` gets one too, and it is the interesting case: the pass
 * itself succeeded, so there is nothing to repair — but the state "clears
 * itself… the next pass after a human accepts it reports `ready`"
 * (`AgentStateSchema`). So the honest verb is "Check again", after the
 * operator has done the part only they can do, and the note below says which
 * part that is. Calling it "Retry" would imply the last pass went wrong.
 *
 * An unrecognised state returns `null`: this build cannot know whether
 * retrying it means anything, and guessing is how a button ends up spending
 * a click on nothing.
 */
function retryLabel(state: string): string | null {
  switch (state) {
    case 'absent':
      return 'Check now'
    case 'outdated':
      return 'Update'
    case 'failed':
      return 'Retry'
    case 'consent-required':
      return 'Check again'
    default:
      return null
  }
}

/** The same verb, in flight — a disabled button must say what it is doing, not just go grey. */
function busyLabel(state: string): string {
  switch (state) {
    case 'absent':
    case 'consent-required':
      return 'Checking…'
    case 'outdated':
      return 'Updating…'
    default:
      return 'Retrying…'
  }
}

/**
 * The sentence a state needs beyond its own reason — either why there is no
 * button, or what the operator has to do before the button can help.
 */
function stateNote(state: string): string | null {
  switch (state) {
    case 'unsupported':
      return 'This device is below the guest agent’s Android version floor. Retrying cannot change that — nothing here is broken, this phone is simply not eligible.'
    case 'ready':
      return 'The agent is ready. The badge was showing an older reading; this panel is the current one.'
    case 'provisioning':
      return 'A pass is running on this device right now. It will settle on its own.'
    case 'consent-required':
      return 'The agent is installed and answering — only Android’s VPN permission is missing, and this phone refuses to grant it over adb. Accept the VPN dialog on the phone itself, then check again. Everything except VPN routing already works.'
    case 'absent':
    case 'outdated':
    case 'failed':
      return null
    default:
      return 'This build of Studio does not know this state, so it does not offer an action for it.'
  }
}

type Outcome = { tone: 'ok' | 'warn' | 'danger'; text: string }

/** What a finished pass actually produced — never "done", always the state it landed on. */
function outcomeOf(status: PreparationComponentStatus, deviceLabel: string): Outcome {
  switch (status.state) {
    case 'ready':
      return { tone: 'ok', text: `The guest agent is ready on ${deviceLabel} now.` }
    case 'outdated':
      return { tone: 'warn', text: 'Installed, but still not the pinned build — the reason above is from this attempt.' }
    case 'provisioning':
      return { tone: 'warn', text: 'The pass is still running — this panel updates when it settles.' }
    case 'unsupported':
      return { tone: 'warn', text: 'The pass reported this device as unsupported, so there is nothing further to retry.' }
    case 'consent-required':
      return { tone: 'warn', text: 'Still waiting on the VPN permission — it has to be accepted on the phone, not from here.' }
    case 'failed':
      return { tone: 'danger', text: 'Still failing — the reason above is from this attempt, not the previous one.' }
    default:
      return { tone: 'warn', text: `The pass finished in state “${status.state}”.` }
  }
}

export function AgentAlertDetail({
  deviceId,
  deviceLabel,
  /** The coarse `DeviceInfo.agent` the chip already had — shown in the header while the real record loads, so the panel is never blank. */
  fallbackState,
}: {
  deviceId: string
  deviceLabel: string
  fallbackState: AgentState
}) {
  // The SAME hook `PreparationPanel` and the popup's screen overlay read, so
  // a retry started here shows up there and vice versa — see its own file
  // header for why it polls (there is a WS event for a pass FINISHING, none
  // for one STARTING). Mounted only while this panel is open, which Radix
  // unmounts with the popover, so a fleet list of twenty cards never fetches
  // more than the one device an operator actually opened.
  const { preparation, loadError, reload, patch } = usePreparation(deviceId)
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [showFull, setShowFull] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const status = preparation?.[GUEST_AGENT_ID] ?? null
  const state = status?.state ?? fallbackState
  const reason = status?.reason?.trim() ?? null
  const lines = reason ? reason.split('\n') : []
  const headline = lines[0] ?? null
  const rest = lines.slice(1).join('\n').trimEnd()

  const nowS = Math.floor(now / 1000)
  const waitingUntil = status?.nextAttemptAt ?? null
  const secondsToAuto = waitingUntil !== null ? Math.max(0, waitingUntil - nowS) : null
  const exhausted = status !== null && status.state === 'failed' && status.attempts > 0 && waitingUntil === null

  const label = status === null ? null : retryLabel(status.state)
  const note = status === null ? null : stateNote(status.state)

  async function copyReason(): Promise<void> {
    if (!reason) return
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(reason)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Refused without a secure context or a user gesture in some browsers.
      // The text is on screen either way, so this is best-effort — but it
      // must SAY it failed rather than flash "Copied" over nothing.
      setCopyFailed(true)
    }
  }

  async function retry(): Promise<void> {
    setBusy(true)
    setOutcome(null)
    try {
      // `retry-prepare` (plan 207 §4.2), the single-device, single-component
      // verb (plan 106 §3.3), not the fleet-wide `POST /api/guest-agent/
      // provision`, which has no way to scope a run to one phone and would
      // provision the whole farm. It calls `AgentProvisioner.ensure(id, {
      // force: true })`, and `force` is what makes this honest:
      // `nextBoundedRetry` resets `priorAttempts` to 0 for a forced pass, so
      // the standing backoff window and an exhausted attempt budget are both
      // cleared rather than waited out. That is exactly what the button
      // below is worded to promise.
      const next = PreparationComponentStatusSchema.parse((await runOnDevice('retry-prepare', deviceId, { component: GUEST_AGENT_ID })).detail)
      patch(GUEST_AGENT_ID, next)
      const result = outcomeOf(next, deviceLabel)
      setOutcome(result)
      if (result.tone === 'ok') toast.success(result.text)
      else toast.warning(result.text)
    } catch (err) {
      // A retry that silently does nothing is worse than no button at all —
      // the operator now believes they tried. Both on screen AND in a toast,
      // because the popover may already be closed by the time this resolves.
      const text = describeApiError(err)
      setOutcome({ tone: 'danger', text: `The retry could not be started: ${text}` })
      toast.error(`Could not retry the guest agent on ${deviceLabel}`, { description: text })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="@container">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="rack-label">guest agent</h2>
        <span className={cn('text-[11px] font-medium', STATE_TONE[state] ?? 'text-fg-muted')}>{STATE_WORD[state] ?? state}</span>
      </div>

      {loadError ? (
        <ErrorState message={loadError} onRetry={reload} />
      ) : status === null ? (
        <p className="flex items-center gap-2 text-[12px] text-fg-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Reading why…
        </p>
      ) : (
        <>
          {/* The first line is the actionable half of every real reason this
              farm produces — an `adb … exited 1` command line, `bad or
              missing token`, an `appops … did not take` readback. It leads;
              the stack trace that follows is one click away rather than
              either buried in a `title` attribute that cannot hold it or
              dumped on top of the sentence that matters.
              `wrap-anywhere`, never `break-words`: a reason carries paths,
              `adb -s <serial>` command lines and Java FQNs with no break
              opportunity in them, and `break-words` leaves a min-content
              floor that pushes this popover off the edge of the window. */}
          {headline ? (
            <p className="wrap-anywhere text-[12.5px] leading-relaxed font-medium">{headline}</p>
          ) : (
            // A `ready` agent has no reason and never should — saying so
            // would read as a missing field rather than a healthy one.
            status.state !== 'ready' && (
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                No reason was recorded for this state — the core did not write one.
              </p>
            )
          )}

          {rest.length > 0 && (
            <>
              <button
                type="button"
                className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-fg-muted transition-colors hover:text-fg"
                aria-expanded={showFull}
                onClick={() => setShowFull((v) => !v)}
              >
                {showFull ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
                {showFull ? 'Hide the rest' : `Show the rest (${rest.split('\n').length} more lines)`}
              </button>
              {showFull && (
                // `whitespace-pre` + its OWN `overflow-x-auto`, so a 120-column
                // Java frame scrolls inside this box instead of widening the
                // popover and taking the page sideways with it.
                //
                // Horizontal only, deliberately: the VERTICAL scroll belongs to
                // the popover as a whole (`AgentAlertChip`'s
                // `--radix-popover-content-available-height`), so there is one
                // vertical scroller in this panel rather than a box inside a box
                // that a trackpad has to guess between.
                <pre className="readout mt-1.5 overflow-x-auto rounded-md border bg-surface-2 p-2 text-[11px] leading-relaxed whitespace-pre">
                  {rest}
                </pre>
              )}
            </>
          )}

          {/* "Failed once, 3 minutes ago" and "failed 40 times over two hours"
              call for different responses from an operator, and both numbers
              are already in the record. */}
          <p className="mt-2 text-[11.5px] text-fg-muted">
            {status.attempts > 0 && (
              <>
                <span className="readout">{status.attempts}</span> failed {status.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
              </>
            )}
            last checked <span className="readout">{relativeTime(status.checkedAt, now)}</span>
          </p>

          {/* Say what the backoff is actually doing, rather than pretending a
              click starts something that was going to happen anyway. */}
          {secondsToAuto !== null && secondsToAuto > 0 && (
            <p className="mt-1 text-[11.5px] text-fg-subtle">
              The farm retries this on its own in <span className="readout">{secondsToAuto}s</span>.
            </p>
          )}
          {secondsToAuto === 0 && <p className="mt-1 text-[11.5px] text-fg-subtle">Another automatic attempt is already due.</p>}
          {exhausted && (
            <p className="mt-1 text-[11.5px] text-fg-subtle">
              Automatic retries for this device are used up — nothing will try again unless you do.
            </p>
          )}

          {/* `ready`'s note explains a STALE badge ("this panel is the current
              one"). After a pass that just landed on `ready` the badge was
              not stale — this panel is what changed it — so the outcome
              sentence below says that instead, and the note stands down. */}
          {note && !(outcome !== null && status.state === 'ready') && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-muted">{note}</p>
          )}

          {outcome && (
            <p
              className={cn(
                'mt-2 wrap-anywhere text-[11.5px] leading-relaxed',
                outcome.tone === 'ok' ? 'text-led-ok' : outcome.tone === 'warn' ? 'text-led-warn' : 'text-led-danger',
              )}
              role="status"
            >
              {outcome.text}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            {label && (
              <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy} onClick={() => void retry()}>
                {busy ? busyLabel(status.state) : label}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={!reason} onClick={() => void copyReason()}>
              {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
              {copied ? 'Copied' : 'Copy reason'}
            </Button>
          </div>
          {/* Worded as what `force: true` actually does, not as a euphemism. */}
          {label && secondsToAuto !== null && secondsToAuto > 0 && (
            <p className="mt-1.5 text-[11px] text-fg-subtle">{label} runs the pass now instead of waiting out that window.</p>
          )}
          {label && exhausted && (
            <p className="mt-1.5 text-[11px] text-fg-subtle">{label} starts a fresh pass and resets the attempt count.</p>
          )}
          {copyFailed && (
            <p className="mt-1.5 text-[11px] text-led-danger">This browser refused the clipboard — select the text above instead.</p>
          )}
        </>
      )}
    </div>
  )
}
