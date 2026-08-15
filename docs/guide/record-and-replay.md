# Record and replay

A **recording** captures what you do on a device — taps, swipes, drags, long
presses, key presses, typed text — and turns it into an ordinary script:
versioned, runnable from the run dialog, schedulable, batchable, and callable
from an AI agent. There is exactly one runnable artefact in Enkaku; a
recording is source for it, not a second kind of thing. The full design is
`docs/plans/94-m59-action-recorder-and-task-scheduling.md`; the SDK's
interpreter and the three timing layers are `packages/sdk/README.md`; the
recorder and the pacer are `packages/core/README.md`.

## Record

Open a device's **Control** tab, take control, and switch to the **Record**
mode button beside Live and Inspect. The picture does not restart or flash —
recording is a mode of the same live view, not a different screen. Click
**Start recording**, then use the device exactly as you normally would: tap,
drag, long-press, type. Each action appears in the step strip as it lands.

**Element candidates and screenshots need the Inspect tab to have attached an
inspector to this device first.** If you have opened Control on this device
at all recently, one is probably already attached; if not, open Inspect once
before recording. A recording still captures every tap, swipe and key by
coordinate with no inspector attached — you just get no selector candidates
and no per-step screenshots for that session.

A recording ends four ways: you click **Stop** (lands you on the review
panel), you click **Discard** (throws it away), it hits the farm's configured
`maxSteps` or `maxDurationSec` and stops itself — cleanly, with the reason
shown, never a silent truncation — or you lose control of the device (someone
takes over, your lease times out, you release it) and it stops on its own,
also landing on the review panel and naming why.

**A recording lives only in the core's memory until you save it.** A core
restart, or losing control of the device, discards anything not yet
published. Save early.

## Review

Give the recording a name and version to save it as a draft, then open its
detail page. Each step shows the screenshot it produced, the gap since the
previous step, and — for taps that landed on an identifiable element — a
**candidate selector** with its match count and how stale the anchor was when
it was captured.

**Promote** is disabled unless the candidate matches exactly one element on
the recorded screen. This is deliberate, not a bug you're waiting on: a
recording replays by **coordinate** by default, never by a selector you did
not explicitly choose. Promoting a candidate switches that one step to
replay against the selector instead — one step at a time, so you see exactly
what you are choosing and why. A candidate that matched three elements would
tap a different one depending on what happens to be on screen that run;
promoting it anyway would trade a visible coordinate replay for an invisible
selector gamble.

You can also trim, reorder, or delete a step, and adjust `speed` (a multiplier
on every recorded gap), `maxGapMs` (a ceiling, so a four-minute pause you took
to read something does not become a four-minute wait on replay), and
`cleanup` (force-stop the packages the recording touched when the job
finishes, the default).

**Every unparameterised typed-text step stores its literal string, verbatim,
regardless of the farm's "log typed text" setting.** The review panel says so
next to the value, every time — this is not softened, because it is a real
privacy exposure: a recording can contain a password or a one-time code, in
the clear, on disk, in the published script's own generated source. If a step
typed something that should vary per run rather than being frozen into the
script — a caption, a search term, a login — click **Parameterise** and give
it a name. It becomes a real script parameter (`{ param: 'caption' }`), the
same as any script's `params.caption` — the run form, the schedule form, and
an agent capability call all render it as a field, and the literal disappears
from the saved document once you save. Parameterising a credential is not
just tidier; it is the only way this product has to keep one out of a
published script's source.

## What a recording will not replay faithfully

Read this before you schedule a recording unattended across a fleet. A
recording is a sequence of inputs, not a state machine — it has no branches
and no assertions, so it cannot tell whether the screen it expects actually
arrived.

**Faithful:**
- A tap, at its recorded position, with its recorded hold duration.
- A long press — a tap whose hold exceeded the recorder's long-press
  threshold — replays as a long press, not a different action.
- A drag replays your own sampled path, sample-for-sample. Its curvature and
  velocity are yours, not a synthesised curve.
- Typed text, delivered through the device's own typing cadence.
- The gaps between your own steps, scaled by the recording's `speed`.

**Approximated, and the review panel says so:**
- **Scroll momentum.** The path and its timing are exact; how far the list
  then coasts is Android's own decision, and a busy device will not always
  land on the same row. If a recording depends on landing on a specific
  item, Detach it and add a real assertion.
- **Typing cadence.** The recording stores the string you typed, not
  per-keystroke timing (the manual control path batches text before sending
  it) — cadence at replay comes from the device's own typing settings, not
  from how fast you typed it originally.

**Not attempted, at all:**
- Multi-touch, pinch, or rotate.
- Anything the recording did not itself cause: a notification, an incoming
  call, an interstitial ad, a system permission dialog that shows on one
  device and not another. A recording has no way to notice and no way to
  react.
- Clipboard content, file pickers, and OEM system UI.

**Detach** (on the review panel) is the honest escape hatch: it turns the
recording into a plain script you own — every step expanded as a literal,
ordered call — and stops it regenerating. From that point you have the full
scripting language, including real conditionals and waits, and the recording
is no longer its source. It is one-way: once detached, the recording can no
longer be re-published over the script file.

## Publish

**Publish as script**, name a version, and from that moment the recording is
gone as a distinct concept — it is a `scripts` row, exactly like any other,
with no marker anywhere distinguishing it. It appears in the scripts list,
resolves as `name@version` and `name@latest`, and its generated source is
human-readable (`GET /api/scripts/:id`) — one `import` and one
`defineRecording({...})` call with the document inlined, never a minified
bundle.

## Run it 20 times across a cluster, on a jittered clock

Open the run dialog for the published recording, pick a cluster, and open the
**Repeat** section:

- **Repetitions** — `count: 20`.
- **Interval** — a range, e.g. `3–8 min`, drawn fresh before each repetition.
- **Stagger** — a per-device offset, e.g. `30 s`, applied once at each
  device's first repetition so the whole cluster does not fire in the same
  second.

The consequence sentence spells out what this means before you commit: *"5
devices, one at a time, in random order × 20 repeats, 3–8 min apart, started
30 s apart — about 2 h 10 m, finishing around 16:45."* If the estimated
continuous busy time on one device would exceed roughly 30 minutes with no
meaningful gap, a non-blocking warning appears below the sentence — a battery
and thermal concern, not a scheduling one. Targeting the whole fleet requires
typing the device count into a confirmation field, the same friction reserved
for any unrecoverable action.

**Repeat is not the same knob as "pause between actions."** The pause between
one action and the next inside a single run lives on the **device's own**
Settings → Human-like touch panel and applies to everything that device ever
runs. Repeat pacing lives on the **run** and applies only to this run. No
screen shows both at once; each screen that has one names where the other one
lives.

**Every draw is written down.** The batch detail page shows, per device, the
repetition it is on (`7 / 20`), the next planned start, and the delay each
completed repetition actually waited — not just the range you configured, but
the number that was actually drawn. If a schedule fires this recording
instead of a one-off run, its own `jitterSec` shifts the **whole firing**
once, before the batch exists; the repeat interval above shifts **each
repetition**, once it does. Two different knobs, on two different screens.

## Stop it

**Stop** on the batch detail page (or the schedule's last-run card) means
stop: no further repetition is ever planned, every queued repetition is
cancelled, every running repetition is aborted, and every device the
recording's `cleanup` setting names gets force-stopped — force-stopping twice
is a no-op, so this is safe even if a repetition happens to settle at the
same moment you click Stop. You are refused for any device you do not have
rights to, by name, while the rest of the batch still stops around it.
