# Virtual devices guide

A **virtual device** is an Android Emulator instance the farm starts, boots, and hands
you as an ordinary device — remote control, scripts, jobs, all of it. It is meant for
**one or two devices, for testing** — never as the main way you fill the farm. If you
need throughput on Linux without buying phones, see [redroid](redroid.md) instead; the
AVD path documented here is the one that also works on macOS and Windows.

## Before you start

Enkaku **never downloads the Android SDK, the emulator, or a system image**. adb is
downloaded on first run and sha256-verified (`LICENSES.md`); a system image is not
fetched at all — it is 1.5–3 GB and covered by the Android SDK Terms of Service, and
the farm treats that licence more strictly than adb's. You install the SDK yourself,
once, on the machine running the core.

Rough sizes, so you know what you are downloading:

- the `emulator` package itself: roughly 300–500 MB
- one system image: 1.5–3 GB
- disk for the AVD's own userdata: grows as you use the device
- RAM while a virtual device is running: about 2 GB per instance (the dialog's default
  is 2048 MB; API 37+ phone profiles require at least 4096 MB)

## macOS

Hardware acceleration is Hypervisor.framework, built into every supported release —
nothing to install for that part.

1. Install Android Studio, or just the command-line tools, from
   `https://developer.android.com/studio`.
2. Pick the ABI for your Mac: **Apple Silicon → `arm64-v8a`**, **Intel → `x86_64`**.
3. Install the pieces:

   ```bash
   sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;<abi>"
   ```

4. Point Enkaku at the SDK if it is not already at the default location
   (`~/Library/Android/sdk`) or named by `ANDROID_SDK_ROOT`/`ANDROID_HOME`:

   ```bash
   export ENKAKU_ANDROID_SDK_PATH=/path/to/Android/sdk
   ```

## Linux

Hardware acceleration is **KVM**. `/dev/kvm` must exist and the user running the core
must be in the `kvm` group (`sudo usermod -aG kvm $USER`, then re-log).

1. Install the command-line tools from
   `https://developer.android.com/studio` (the "command line tools only" download —
   Android Studio itself is not required on a headless box).
2. Install the pieces (Linux is always `x86_64`):

   ```bash
   sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;x86_64"
   ```

3. Point Enkaku at the SDK if it is not already at `~/Android/Sdk`, `~/android-sdk`, or
   named by `ANDROID_SDK_ROOT`/`ANDROID_HOME`:

   ```bash
   export ENKAKU_ANDROID_SDK_PATH=/path/to/Android/Sdk
   ```

## Windows

Two accelerators exist; **prefer WHPX**:

- **WHPX** (Windows Hypervisor Platform) — enable it in "Turn Windows features on or
  off", reboot, and it is done.
- **AEHD** (Android Emulator Hypervisor Driver) — still works today, but Google
  **sunsets it on 2026-12-31**. Only use it if WHPX is unavailable on your machine
  (some virtualization setups, e.g. inside another hypervisor, block it), and plan to
  move off it before that date.

1. Install Android Studio, or just the command-line tools, from
   `https://developer.android.com/studio`.
2. Install the pieces (Windows is always `x86_64`):

   ```
   sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;x86_64"
   ```

3. Point Enkaku at the SDK if it is not already at
   `%LOCALAPPDATA%\Android\Sdk` or named by `ANDROID_SDK_ROOT`/`ANDROID_HOME`:

   ```
   set ENKAKU_ANDROID_SDK_PATH=C:\path\to\Android\Sdk
   ```

*(The Windows and macOS steps above were written from the code and the vendor
documentation, not run on this platform — this guide was authored on Linux. The Linux
steps and the `bun run doctor` output below were run and are copied verbatim.)*

## Creating one

Studio → **Settings → Farm → Virtual devices** → **Create**. This creates the AVD only;
it does not start it — starting is a separate step, and every start is a cold boot
(no saved state is ever restored), which takes 30–90 seconds.

The dialog has five fields:

| Field | What it does |
|---|---|
| Name | The AVD's name. Letters, digits, dot, underscore, hyphen. |
| API level | 36 or 35 (the two levels with published `arm64-v8a`/`x86_64` system images at the time of writing). |
| Variant | `google_apis` (rootable — `adb root` works) or `google_apis_playstore` (not rootable; `adb root` is refused). `google_apis` is the default and the one to pick unless you specifically need Play Store on the image. |
| RAM (MB) | 1536–8192, default 2048. API 37+ phone profiles need at least 4096. |
| Device profile | A hardware profile id, e.g. `pixel_7`. Run `avdmanager list device` on the machine running the core to see the ids it accepts. |

The ABI (`arm64-v8a` vs `x86_64`) is not a field — the core derives it from the host's
own architecture, because asking an operator to pick it is asking them to get it wrong.

If creation fails because the SDK is missing, the dialog shows the exact `sdkmanager`
command to run, verbatim, in place of a generic error — that is deliberate (see
Troubleshooting below).

## While it boots

Press **Start**. The row shows `starting`; a cold boot takes 30–90 seconds. When it
finishes, the emulator is running on the local adb server like any other device — **you
never run `adb connect`**. The adb server discovers local emulators by itself, by
scanning odd-numbered ports in 5555–5585, and the farm's existing device reconciler
picks it up on its own interval. The virtual device then appears on the **Devices**
screen on its own; there is no button that makes it appear sooner.

## Limits

- Concurrent virtual devices: **`ENKAKU_VM_MAX_CONCURRENT`, default 2, hard maximum 8**
  (`.env.example`). This is the owner's own number for this feature — one or two
  instances, for testing, never the main use of the farm.
- Only the **first 16 emulators** are auto-discovered by adb at all (it scans odd ports
  5555–5585). The cap above stays well inside that.
- Boot timeout: **`ENKAKU_VM_BOOT_TIMEOUT_SEC`, default 300 seconds**. A virtual device
  that has not reported booted by then is stopped and marked `failed`.
- API 37 (Android 17) phone AVDs require at least 4096 MB of RAM, strictly enforced by
  the emulator itself.
- A virtual device is an ordinary device row once it appears — as of this writing the
  job queue does not distinguish it from a physical phone, so it can be claimed by any
  job that targets the farm generally. If you want to keep test jobs off it (or off your
  real phones), target it explicitly rather than relying on it being excluded.

## What it is not

An emulator is not a phone, and this feature does not pretend otherwise — the same
warning [`redroid.md`](redroid.md) already gives applies here too:

- No real sensors (accelerometer, gyroscope, and the rest).
- Its IMEI and serial are not hardware.
- Emulator properties are readable — `ro.kernel.qemu`, `ro.hardware`, and similar values
  give it away.
- Its touches do not come from a physical input driver.

Simple automation detection flags a virtual device immediately. Use it for testing your
own scripts and flows, not for testing against detection, and not as a stand-in for a
real device farm.

**Input, specifically:** whether scrcpy's UHID path (a simulated physical HID device)
works through an emulator has **not been verified as of this writing** — it is the
series' largest documented unknown (`docs/plans/400-vm-program.md` R9/K1). If UHID does
not work on your emulator, input falls back to the existing scrcpy injection path the
same way it would for any device where UHID is unavailable. Do not take either path as
guaranteed until you have checked it on your own machine.

## Troubleshooting

- **`bun run doctor`'s "Android SDK" row** reports which tier it would resolve from, and
  what is missing. Run with nothing installed, it prints (observed on Linux, this
  machine, no SDK present):

  ```
  [fail] Android SDK      the Android SDK was not found. Enkaku never downloads it (a system image is 1.5-3 GB and
  is covered by the Android SDK Terms). Install the command-line tools and one system image,
  then set ANDROID_SDK_ROOT or ENKAKU_ANDROID_SDK_PATH:

    sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;x86_64"

  Looked in: ENKAKU_ANDROID_SDK_PATH, ANDROID_SDK_ROOT, ANDROID_HOME, /root/Android/Sdk, /root/android-sdk
  ```

  This check runs on every `bun run doctor`, whether or not you have ever created a
  virtual device — the SDK is resolved lazily, the moment you actually try to create,
  start, or destroy one, not at boot. A farm with no SDK installed boots and runs
  normally; only that first VM mutation fails, with `E_ANDROID_SDK_MISSING` (HTTP 503).
- **A `failed` row** carries the emulator's own stderr in its message — read it before
  asking for help; it usually says exactly what went wrong (a missing system image, no
  accelerator, an unwritable AVD directory).
- **A busy console port** is skipped automatically — the provider probes each candidate
  port before claiming it. If every port your farm would try is already taken (for
  example by your own Android Studio emulator), the `failed` row names the port it could
  not claim.
- **On Linux**, a `warn` instead of `ok` for the accelerator almost always means
  `/dev/kvm` is missing or your user is not in the `kvm` group.
- **On Windows**, prefer WHPX; if the doctor's row or the emulator's own log points at
  AEHD, remember it sunsets 2026-12-31.
