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
 * The M4 inspector (spec §7.4) — a BRIDGE, not the final answer:
 * one dump takes 0.5–2 seconds and fails while the UI keeps changing ("could not get idle
 * state"), and offers no per-element actions. Plan 06 replaces it with
 * `ui-server` without changing this interface.
 */
export class UiautomatorDumpInspector implements Inspector {
  readonly id = 'uiautomator-dump'
  /** The dump path is probed once per device and then cached. */
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
        this.onLog?.('debug', 'dump via /dev/tty is unsupported — falling back to the file path')
        this.useTty = false
      } else {
        return out
      }
    }
    // Fallback: dump to a file, then cat it.
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
        lastError = 'uiautomator: could not get idle state (the UI keeps changing)'
        this.onLog?.('debug', `${lastError} — retry ${attempt + 1}/3`)
        continue
      }
      try {
        return parseUiDump(raw)
      } catch (err) {
        lastError = `failed to parse the dump: ${String(err)}`
      }
    }
    throw new InspectorError('INSPECTOR_DUMP_FAILED', lastError || 'the dump failed with no detail')
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
