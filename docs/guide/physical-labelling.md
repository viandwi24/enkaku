# Device numbers and physical labelling

You are standing in front of a rack of 20–100 physically identical phones.
Studio can tell them apart perfectly; you cannot, because every one of them
says `Pixel 5`. This guide covers the two things Enkaku does about that: a
short number every device carries for its whole life, and — optionally — a
mark on the phone's own screen so the number is readable off the rack, not
just off a browser tab.

## The number

### What it is

Every admitted device gets a short, incrementing integer — `#1`, `#2`, `#3`
— shown beside its name everywhere: the Wall, the device list, the device
page header, the device picker, log lines, device events, and `enkaku
doctor`'s output. It is a second, purely presentational identifier. It does
not replace `stableId` (the hardware serial Enkaku already uses to recognise
"the same phone" across USB and WiFi) and it is never folded into the
device's name — the two sit side by side, number first: `#7 Pixel 5`.

### When it is allocated

The number is assigned the moment a device is **admitted** — moved out of
the Discovered tray and into the farm — not the moment it first shows up
over adb. This is deliberate: the adb server on the machine running Enkaku
is usually shared with other things (Android Studio, a developer's own
phone, whatever is plugged in to charge), and none of those should be able
to burn a number just by being plugged in for a minute. A phone gets its
number in the same click that makes it a farm device, which in practice
feels exactly like "the first time it connects" — because for a device you
actually admit, that is the same moment.

A device sitting in the Discovered tray has no number, and the admit dialog
does not try to predict one — it shows you the number you actually got only
after admission succeeds, because a concurrent admission of another phone
could otherwise make a prediction wrong.

### It survives Forget, and re-admission

Forgetting a device returns it to the Discovered tray; it does not delete
its identity or its history, and it does not release its number. Re-admit
the same phone later — a day, a month, whenever — and it gets the **same**
number back.

This is the whole point: if the number only lived on a device record that
Forget deletes, a sticker you put on the back of a phone case would go
stale the first time that phone was ever forgotten and re-admitted, with no
way to notice. The number instead lives in its own table, keyed on the
phone's stable hardware identity, exactly like the tables that already track
blocked and discovered devices for the same reason. Block, unblock, and
re-admission all preserve it too.

The number is released only by an explicit action — never automatically:

- **Release number**, on the device's Settings page, frees just that one
  device's reservation.
- **Renumber fleet…**, on the devices page's overflow menu, compacts every
  current device's number down to `1..n` in list order in one action, and
  re-pushes the physical label (below) of every device whose number moved
  — so a compaction can never leave a phone's screen showing a number that
  has since moved to another device.

The consequence worth knowing: an ordinary farm's numbers will show gaps —
`#3, #7, #8, #15` — where a phone used to be. That is honest, not a bug.
Renumber fleet is one click away whenever the gaps bother you.

### Manual numbers and collisions

You can set a device's number by hand from its Settings page. A number
already held by another device is refused outright — you get an error
naming which device holds it — never silently reassigned or swapped.

### A device with no number

A device can show no number for two different reasons, and only one of
them is unusual:

1. **Its reservation was explicitly released** — someone used Release
   number, or a rare edge case around a very old backup restore. This is
   uncommon and operator-initiated.
2. **It is a device on a cloud node.** Cloud-node devices do not go through
   the same admission path a local farm's devices do, and today nothing
   allocates them a number at all — every device on a cloud node shows no
   number, always, on every farm. This is a known, tracked gap (register
   entry 96.21 in `docs/plans/96-m61-hotfixes.md`), not a bug in the
   dashboard and not a temporary state that will resolve itself on its own.
   If you run a cloud fleet, expect dashes where a local farm would show
   numbers, until that gap is closed.

## Physical labelling: putting the number on the phone itself

Physical labelling writes the device's number (and, optionally, its name)
onto the phone's own screen, so you can identify a device by looking at the
rack instead of looking at Studio.

**This is off by default**, per device, because it overwrites something you
may care about — the phone's existing wallpaper — and on many Android
versions Enkaku cannot read that wallpaper back afterwards to restore it.
Turning labelling on is a decision you make, once, per phone or for the
whole farm's default; it never happens by itself.

### What it writes, and how long it lasts

This is the detail most likely to surprise you: **labelling writes state
directly to the phone, and that state outlives everything else in the
system.** It is not tied to a session, a lease, or even the Enkaku core
process being alive. Once applied, the label stays on the phone through:

- closing the browser tab or losing the WebSocket connection,
- releasing the device's lease,
- a job finishing, a script erroring, or a batch being stopped,
- the Enkaku core restarting, or the machine rebooting.

Nothing in the system quietly reverts it when a session ends, the way some
other per-device settings do. **Clearing a label is a separate, explicit
action** — "Clear label…" on the device's Settings page, or turning
`labelling.mode` back to `off` — never something that happens as a side
effect of anything else. If you turn labelling on for a test and forget
about it, the phone keeps showing the label indefinitely.

Enkaku does re-check the label on its own, but only at specific moments,
never on a timer: when a device reconnects (so a phone unplugged for a
week is caught up in one cheap round trip, not by polling it the whole
time), when you rename or renumber the device, or when you explicitly ask
it to re-apply.

### Two tiers, and no silent fallback

There are two ways Enkaku can label a phone, and they produce genuinely
different results. Enkaku will never quietly use the weaker one and call it
the one you asked for — a device that cannot do what you asked reports
**unavailable**, with the reason, rather than a downgraded result reported
as success.

**Wallpaper (needs the Enkaku guest agent).** A solid black wallpaper with
the device's name and number, large and centred, applied to both the home
screen and the lock screen. This is the feature most people mean by
"physical labelling" — the one visible on a phone that is awake and sitting
in its charging cradle. It needs the on-device guest agent app installed
and running, and specifically needs that agent to advertise a
`screen-label` capability. A device with no guest agent, or an agent build
that predates this feature, reports the wallpaper mode as unavailable and
leaves the phone's wallpaper untouched.

**Lock screen (plain adb, no agent, no image).** One line of text —
`#7 Pixel 5` — written under the lock-screen clock, using the same
"Add text on lock screen" mechanism as Settings → Security on the phone
itself. This needs nothing installed: it works on any device Enkaku can
already reach over adb. It is what a device without the guest agent gets,
and it is genuinely useful on its own — it is exactly the surface you read
on a rack of *sleeping* phones. Unlike the wallpaper, this tier's prior
value is readable back, so turning it off genuinely restores whatever text
was there before, byte for byte.

If you turn on `wallpaper` mode for a phone that turns out to have no
guest agent, Studio shows you `unavailable` and offers a one-click switch
to `lock-screen` instead. It never makes that substitution for you.

### What each state badge means

The device header and Settings page show a truthful state for the label,
never a single colour standing in for every outcome:

| State | What it means |
|---|---|
| `Labelled` (`applied`) | The phone is genuinely showing what you asked for. |
| `Stale` | The phone is showing an older version — a name or number changed and the re-apply has not gone through yet (or the device has been offline). |
| `Partial — <reason>` | Only some of what was requested took — for example, an OEM skin accepted the home-screen wallpaper but refused the lock-screen half. Named, never rounded up to a full success. |
| `Unavailable — <reason>` | The requested mode cannot work on this device right now (no guest agent, missing capability, or the write itself was refused). The phone is untouched. |
| (nothing shown) | Labelling is off for this device, or its status has never been checked — neither is treated as a failure. |

### Turning it on

- **One phone:** open the device's Settings page, find **Physical
  labelling**, choose a mode, and (optionally) whether to include the name
  above the number. Use **Re-apply label** to push it immediately, or
  **Check now** to refresh the status without writing anything.
- **A whole farm going forward:** set the farm's default `labelling.mode`
  in Settings once. Every device admitted *after* that point inherits it
  automatically — flipping the default never reaches back and relabels
  devices that already exist, the same way every other farm default in
  Enkaku works.
- **An existing fleet, right now:** select devices on the devices page and
  use **Apply labels**. This is the explicit fleet-wide switch-on; nothing
  retroactively labels an existing farm on its own.
- **At admission time:** the admit dialog has a checkbox reflecting the
  farm's current default, with the exact consequence spelled out before you
  confirm.

### Clearing a label

**Clear label…** on the device's Settings page removes it. If Enkaku
managed to capture the phone's original wallpaper before it first applied a
label, you can choose **Restore the original** — offered only when a real
capture happened, never as a guess. When no original was captured (the
common case for the wallpaper tier, see below), the confirm dialog says so
plainly: clearing resets the phone to Android's own system default
wallpaper, not necessarily what was on it before Enkaku touched it.

Forgetting or blocking a device also clears its label first, best-effort,
before the device record is removed.

### What is proven, and what is still a hypothesis

Every mechanism above has been built and is covered by unit tests against a
simulated device. **What has not yet been confirmed is how it behaves on
real hardware** — no physical phone has been available to run this against
in the environment this feature was developed in. Concretely, still
unconfirmed on real devices as of this writing:

- Whether the lock-screen text (tier 0) is actually accepted and rendered
  on the exact Android builds you run — the write-then-read-back check
  Enkaku performs is real, but it has never been compared against what a
  human eye sees on a locked screen.
- Whether the wallpaper (tier 1) renders correctly on a real panel, and
  whether an OEM skin (MIUI/HyperOS, ColorOS, One UI) silently refuses the
  lock-screen half of it, which is the scenario the `partial` state exists
  to catch.
- Whether the number stays legible when a home screen's icon grid partly
  covers it.
- Whether an OEM's original wallpaper can actually be read back before the
  first apply, so "Restore the original" has something real to restore.

The code is deliberately written to fail closed in every one of these
cases — a device that cannot be confirmed reports `unavailable` or `stale`,
never a false `applied` — so none of this being unconfirmed changes what
you can already trust the state badges to say. It does mean you should
treat "wallpaper mode is available and everything looks green" as
promising, not as a guarantee, until you have looked at a rack of real
phones yourself. `docs/plans/89-m54-device-identity-and-physical-labelling.md`
§5's consolidated hardware-verification table is the exact command sequence
that settles this, if you want to run it yourself.
