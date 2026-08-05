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

## Removing a phone from the farm

**Forget** takes a device out of the farm. If it is still connected it returns to **Discovered**, so you can admit it again later — it does not have to be unplugged first.

**Block** is the stronger one: the phone is skipped before it is even probed and never reaches the tray. Blocked phones are listed under Settings → **Blocked devices**, with when and by whom, and can be unblocked there.

**Dismiss**, in the tray, only clears the entry. The phone reappears the next time it connects. If you want it gone for good, block it.

## Moving from USB to wireless

Enroll over USB first, then move to wireless. Because device identity comes from the hardware serial, the record stays one; only the transport address column changes.

## Battery and heat

A farm on permanent charge risks swollen batteries. The core watches each device's temperature and automatically **pulls an overheating device out of the queue** (status `quarantined`). The temperature threshold and polling interval are configurable in Settings. A quarantined device is released by hand once you have checked on it.
