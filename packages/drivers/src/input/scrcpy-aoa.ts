import type { InputSink, Point } from '@enkaku/protocol'

/**
 * The `scrcpy-aoa` InputSink — OPT-IN, requires a USB cable (spec §9.1).
 *
 * AOA (Android Open Accessory) makes the host appear as a **physical HID
 * device**, bypassing the entire Android input stack — it does not even need
 * USB debugging. This is the closest thing to real hardware, and it is useful
 * for testing apps that inspect input provenance very deeply.
 *
 * What keeps it from being the default:
 * - **a USB cable is mandatory** (no wireless) — which clashes with how most
 *   farms operate, largely over WiFi;
 * - **it carries no video** — the display still needs another path;
 * - it needs libusb-level USB access on the host, which is awkward in containers and VMs.
 *
 * The USB transport is not implemented: the engine is listed in the registry
 * with `available: false` so the UI can explain that it exists, and
 * selecting `aoa` mode in DeviceSettings automatically falls back to UHID (see
 * `selectInputEngine`) rather than failing silently.
 */
export class ScrcpyAoaInput implements InputSink {
  readonly id = 'scrcpy-aoa'
  readonly mode = 'aoa' as const

  private unavailable(): never {
    throw new Error(
      'the scrcpy-aoa engine is not available yet: it needs an AOA USB transport (libusb) — use scrcpy-uhid for hardware-like input without a cable',
    )
  }

  tap(_p: Point, _opts?: { holdMs?: [number, number]; rng?: () => number }): Promise<void> {
    this.unavailable()
  }
  swipe(_from: Point, _to: Point, _ms: number): Promise<void> {
    this.unavailable()
  }
  key(_code: number): Promise<void> {
    this.unavailable()
  }
  text(_s: string): Promise<void> {
    this.unavailable()
  }
}
