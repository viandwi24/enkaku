import type { InputSink, Point } from '@enkaku/protocol'

/**
 * InputSink `scrcpy-aoa` — OPT-IN, butuh kabel USB (spec §9.1).
 *
 * AOA (Android Open Accessory) membuat host tampil sebagai **HID peripheral
 * fisik**, melewati seluruh input stack Android — bahkan tidak butuh USB
 * debugging. Ini mode paling menyerupai perangkat keras, dan berguna untuk
 * menguji aplikasi yang memeriksa asal input sangat dalam.
 *
 * Batasan yang membuatnya tidak jadi default:
 * - **wajib kabel USB** (tidak bisa wireless) — bertabrakan dengan pola
 *   operasional farm yang mayoritas WiFi;
 * - **tidak membawa video** — display tetap harus lewat jalur lain;
 * - butuh akses USB level libusb di host, yang di container/VM merepotkan.
 *
 * Implementasi transport USB-nya belum ada: engine ini terdaftar di registry
 * dengan `available: false` supaya UI bisa menjelaskan keberadaannya, dan
 * pemilihan mode `aoa` di DeviceSettings otomatis turun ke UHID (lihat
 * `selectInputEngine`) alih-alih gagal diam-diam.
 */
export class ScrcpyAoaInput implements InputSink {
  readonly id = 'scrcpy-aoa'
  readonly mode = 'aoa' as const

  private unavailable(): never {
    throw new Error(
      'engine scrcpy-aoa belum tersedia: butuh transport USB AOA (libusb) — pakai scrcpy-uhid untuk input hardware-like tanpa kabel',
    )
  }

  tap(_p: Point): Promise<void> {
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
