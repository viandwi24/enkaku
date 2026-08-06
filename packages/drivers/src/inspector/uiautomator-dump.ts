import { countMatches, matchSelector, type FindOutcome, type Inspector, type Selector, type Transport, type UiNode } from '@enkaku/protocol'
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
      const out = new TextDecoder().decode(
        await this.transport.execOut('uiautomator dump /dev/tty', { profile: 'inspectorDump' }),
      )
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
    await this.transport.exec(`uiautomator dump ${path}`, { profile: 'inspectorDump' })
    const xml = new TextDecoder().decode(await this.transport.execOut(`cat ${path}`, { profile: 'inspectorDump' }))
    await this.transport.exec(`rm -f ${path}`, { profile: 'inspectorDump' })
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

  /**
   * `find`, honest about why (plan 74 §3.4, §4.3) — a deliberately separate
   * implementation from `find()` above, NOT a refactor of it into this
   * method: `find()` has always returned the first depth-first match
   * regardless of how many nodes matched, and a previously published script
   * bundle must keep getting exactly that (criterion 10, plan 62 §3.1). This
   * dumps the same tree `find()` would and additionally counts matches
   * (`countMatches`, shared with the Inspect tab's own match-count promise),
   * so an ambiguous selector — 2+ matches — is reported as such here without
   * changing what plain `find()` does for the same selector.
   *
   * No oversized-container guard: that check needs a known viewport
   * (plan 60 §3.1), which this bridge engine — unlike `ui-server` — has no
   * plumbing to read; it only ever answers `not-found`/`ambiguous`/`ok`.
   */
  async findDetailed(sel: Selector): Promise<FindOutcome> {
    if ('point' in sel) {
      const synthetic = matchSelector({} as UiNode, sel)
      return synthetic ? { ok: true, node: synthetic } : { ok: false, reason: 'not-found', matches: 0 }
    }
    const root = await this.dump()
    const count = countMatches(root, sel)
    if (count === 0) return { ok: false, reason: 'not-found', matches: 0 }
    if (count > 1) return { ok: false, reason: 'ambiguous', matches: count }
    const node = matchSelector(root, sel)
    return node ? { ok: true, node } : { ok: false, reason: 'not-found', matches: 0 }
  }

  screenshot(): Promise<Uint8Array> {
    return this.transport.execOut('screencap -p', { profile: 'screencap' })
  }
}
