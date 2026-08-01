import type { Inspector, Selector, Transport, UiNode } from '@enkaku/protocol'
import { matchSelector } from './selector'
import { parseUiDump } from './xml-parser'

export class InspectorError extends Error {
  constructor(
    public code: 'INSPECTOR_DUMP_FAILED',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Inspector M4 (spec §7.4) — JEMBATAN, bukan solusi akhir:
 * satu dump 0,5–2 detik, gagal saat UI terus berubah ("could not get idle
 * state"), tanpa aksi per-elemen. Diganti `ui-server` di Plan 06 tanpa
 * mengubah interface ini.
 */
export class UiautomatorDumpInspector implements Inspector {
  readonly id = 'uiautomator-dump'
  /** Jalur dump di-probe sekali per device lalu di-cache. */
  private useTty: boolean | null = null

  constructor(
    private transport: Transport,
    private onLog?: (level: 'debug' | 'warn', msg: string) => void,
  ) {}

  private async rawDump(): Promise<string> {
    if (this.useTty !== false) {
      const out = new TextDecoder().decode(await this.transport.execOut('uiautomator dump /dev/tty'))
      if (out.includes('<?xml')) {
        this.useTty = true
        return out
      }
      if (this.useTty === null) {
        this.onLog?.('debug', 'dump via /dev/tty tidak didukung — pakai jalur file')
        this.useTty = false
      } else {
        return out
      }
    }
    // Fallback: dump ke file lalu cat.
    const path = '/sdcard/enkaku-dump.xml'
    await this.transport.exec(`uiautomator dump ${path}`)
    const xml = new TextDecoder().decode(await this.transport.execOut(`cat ${path}`))
    await this.transport.exec(`rm -f ${path}`)
    return xml
  }

  async dump(): Promise<UiNode> {
    let lastError = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await Bun.sleep(500)
      let raw: string
      try {
        raw = await this.rawDump()
      } catch (err) {
        lastError = String(err)
        continue
      }
      if (raw.includes('could not get idle state')) {
        lastError = 'uiautomator: could not get idle state (UI terus berubah)'
        this.onLog?.('debug', `${lastError} — retry ${attempt + 1}/3`)
        continue
      }
      try {
        return parseUiDump(raw)
      } catch (err) {
        lastError = `parse dump gagal: ${String(err)}`
      }
    }
    throw new InspectorError('INSPECTOR_DUMP_FAILED', lastError || 'dump gagal tanpa keterangan')
  }

  async find(sel: Selector): Promise<UiNode | null> {
    if ('point' in sel) return matchSelector({} as UiNode, sel)
    const root = await this.dump()
    return matchSelector(root, sel)
  }

  screenshot(): Promise<Uint8Array> {
    return this.transport.execOut('screencap -p')
  }
}
