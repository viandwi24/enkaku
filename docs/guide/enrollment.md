# Device enrollment guide

One phone is one record, however it connects. Enkaku uses a **stable identity** (the hardware serial, falling back to ANDROID_ID) rather than the adb address — so the same phone over USB and then over WiFi does not become two devices.

## USB

1. On the phone: Settings → About phone → tap "Build number" seven times to unlock Developer options.
2. Developer options → turn on **USB debugging**.
3. Plug it into the machine running the core.
4. The phone shows an "Allow USB debugging?" dialog → tick **Always allow from this computer** → **Allow**.
5. The phone appears in Studio under **Discovered**, not in the fleet.
6. Open it, give it a name, and press **Add to farm**.

Connecting a phone to adb does not put it in the farm — the same adb server usually serves Android Studio too, so a phone plugged in to charge would otherwise become schedulable. Admission is the deliberate step that makes it a farm device.

If Studio shows the device as `unauthorized`, the dialog in step 4 has not been accepted.

## Wireless (Android 11+)

Wireless debugging uses **two different ports**: one for pairing (single-use, and it changes every time the screen is opened) and one for connecting.

1. Developer options → **Wireless debugging** → turn it on.
2. Tap **Pair device with pairing code**. The screen shows an IP, a pairing port, and a 6-digit code. **Leave that screen open** — closing it cancels the code.
3. In Studio: Devices → **Add device** → fill in the IP, the pairing port, and the 6-digit code.
4. Also fill in the **connect port** (the number on the main Wireless debugging screen, which differs from the pairing port).
5. Press **Pair and connect**.
6. The phone arrives under **Discovered**; admit it there, exactly as for USB.

If it fails, adb's own message is shown verbatim in the wizard — usually the cause is an expired code or a pairing port that has already changed.

## Moving a device to the network (Wi-Fi and OTG)

A phone connects one of two ways, and Enkaku shows both facts, never a
guess: the **badge** on its card and tile is **USB**, **OTG**, **WI-FI**, or
**TCP**. The first two are what you actually plug in or unplug; the last two
are Enkaku telling you how confident it is about a device it reaches over
the network:

| Badge | What it means |
|---|---|
| **USB** | Plugged into this computer by cable. |
| **OTG** | On the network, over a connection Enkaku knows is wired — the address falls inside a **farm network** you have labelled "wired". |
| **WI-FI** | Same as OTG, but the matching farm network is labelled "wireless". |
| **TCP** | On the network, medium not known — no farm network matches its address, or none is labelled at all. This is not a fault; it is Enkaku refusing to guess. |

**As shipped today, every network device reads TCP.** OTG and WI-FI are real
badge values the product computes, but the step that reads a configured
Farm Network back into what a device card actually shows has not landed yet
— so labelling a network "wired" in Settings does not yet change a device's
badge, even though the network itself already works for its other job
(narrowing what a scan is allowed to probe, below). Do not rely on the
badge to distinguish OTG from Wi-Fi until this note is removed from the
guide.

**Once a device is reachable over the network, Enkaku remembers how to find
it again.** Every address it has connected from is kept (up to four per
device), so a device that drops off — a reboot, a Wi-Fi hiccup, someone
walking out of range and back — reconnects on its own from the last address
it used, no scan and no operator action needed. If the device comes back at
a *different* address (a new DHCP lease), pressing **Reconnect** on the
device, or **Scan network** next to the Discovered tray, finds it again by
probing the farm networks you have configured and matching the phone's
identity, not just its address — so it lands back on the exact same record,
tags, cluster and job history intact. Scanning is **always something you
ask for**: Enkaku never sweeps a network on a timer in the background.

**A chassis's USB↔OTG port flip is a hardware action, not a software one,**
and today Enkaku has no on-screen wizard for the whole sequence — that guided
flow (arm → flip the physical switch → watch it come back) is still being
built. Until it ships, moving a phone from a USB/OTG chassis onto the network
is a manual sequence:

1. With the phone still on USB and already admitted to the farm, put it into
   TCP mode: `adb tcpip 5555` (or your chassis vendor's own port-5555
   convention).
2. Flip the chassis port from USB to OTG — on most vendor chassis this is a
   double-click on the port's physical button; the status light usually
   changes colour.
3. Once the phone has a network address, either wait for the periodic
   discovery pass to pick it up, or press **Rescan** / **Scan network** in
   Studio. The phone should reappear as the **same** device — same record,
   tags, cluster and history — badged TCP for now (see the badge note
   above).
4. If it does not reappear on its own, open the device and use its
   **Connection** menu → **Reconnect** once you know it has a network
   address.

**What survives a reboot is not yet confirmed on real hardware.** Android
exposes two different properties for the TCP listening port:
`service.adb.tcp.port`, which does **not** survive a reboot, and
`persist.adb.tcp.port`, which does — but setting the persistent one normally
needs root, which most farm phones do not have. In practice, expect to
re-run step 1 after a phone reboots unless you have verified on your own
device that the persistent property stuck. Enkaku does not yet measure and
report which one your phone actually gave you; treat "did TCP mode survive
that reboot" as a question worth checking by hand the first time, on your
own hardware, before relying on it for a whole chassis.

**Returning to USB needs no Enkaku step at all.** A phone in TCP mode still
works perfectly over USB — flip the chassis port back, and USB hotplug
re-announces the phone on its own.

## Removing a phone from the farm

**Forget** takes a device out of the farm. If it is still connected it returns to **Discovered**, so you can admit it again later — it does not have to be unplugged first.

**Block** is the stronger one: the phone is skipped before it is even probed and never reaches the tray. Blocked phones are listed under Settings → **Blocked devices**, with when and by whom, and can be unblocked there.

**Dismiss**, in the tray, only clears the entry. The phone reappears the next time it connects. If you want it gone for good, block it.

## Battery and heat

A farm on permanent charge risks swollen batteries. The core watches each device's temperature and automatically **pulls an overheating device out of the queue** (status `quarantined`). The temperature threshold and polling interval are configurable in Settings. A quarantined device is released by hand once you have checked on it.

## Telling phones apart: numbers and physical labels

Twenty admitted phones with the same model name look identical everywhere in Studio unless you look closer. Admission is also the moment a device gets its short, permanent **number** (`#7`) — assigned the first time a phone becomes a farm device, never at the literal first adb connection, so a phone that was only ever charging in the Discovered tray never burns one. The number survives Forget and re-admission: it lives in its own reservation table, keyed on the phone's hardware identity, the same way blocked and discovered devices already are, and it is released only if you explicitly ask (a device's **Release number** action, or the fleet-wide **Renumber fleet…**). Renaming a device never changes its number, and the number is never folded into the name — the two are always rendered side by side, `#7 Pixel 5`.

Optionally, Enkaku can also write that number — and the name — onto the phone's own screen, as a black wallpaper or as lock-screen text, so a rack of identical phones is readable by eye instead of only in Studio. This is off by default because it overwrites something on the phone, and once applied it stays on the phone until you explicitly clear it — it does not revert when a session ends. See `docs/guide/physical-labelling.md` for the full walkthrough, including what is and is not yet confirmed on real hardware.
