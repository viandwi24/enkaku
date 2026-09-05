import { countMatches, matchSelector, type FindOutcome, type Inspector, type Selector, type Transport, type UiNode } from '@enkaku/protocol'
import { parseUiDump } from './xml-parser'

/** A device's reply, bounded for a log line: a real dump is a whole view tree. */
function short(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return '(nothing)'
  return trimmed.length > 200 ? `${JSON.stringify(trimmed.slice(0, 200))}… (${trimmed.length} chars)` : JSON.stringify(trimmed)
}

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
  /** The last tree a successful `dump()` produced and when (plan 208 §4.6, "the cheap cache"). */
  private last: { root: UiNode; at: number } | null = null

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
      /**
       * Output with no `<?xml` is not a dump, whatever this device did last
       * time. The `else` this replaces returned it verbatim once `/dev/tty`
       * had worked ONCE, so a later failure — `uiautomator` printing an
       * error, an empty read, a truncated pipe — was handed to the parser and
       * surfaced as "the XML dump has no <hierarchy> element", which names
       * the symptom and hides the sentence the phone actually printed (owner,
       * 2026-09-05). A device that answered XML before can still fail now;
       * the file path is the answer either way.
       */
      if (this.useTty === null) {
        this.onLog?.('debug', 'dump via /dev/tty is unsupported — falling back to the file path')
      } else {
        this.onLog?.('warn', `dump via /dev/tty stopped returning XML (${short(out)}) — using the file path`)
      }
      this.useTty = false
    }
    // Fallback: dump to a file, then cat it.
    const path = '/sdcard/enkaku-dump.xml'
    /**
     * `uiautomator dump` prints its verdict and this used to ignore it, so a
     * failed dump was followed by `cat` on a file that was never written and
     * the operator got `cat: … No such file or directory` — the shell's
     * complaint about the second command, never the reason the first one
     * failed (owner, 2026-09-05). The tool announces success with "UI
     * hierarchy dumped to: <path>"; anything else is its own error text, and
     * that text is the diagnosis.
     */
    /**
     * `uiautomator dump` writes its "UI hierarchy dumped to: <path>" line to
     * STDERR on most builds, not stdout. Gating the read on stdout alone
     * rejected dumps that had in fact succeeded and reported "(nothing)"
     * (2026-09-05) — a check that broke the working path to improve an error
     * message. So: run it, keep both streams, and let the FILE decide. Its
     * output only matters when the read then fails, which is exactly when it
     * is the diagnosis.
     */
    const said = await this.transport.exec(`uiautomator dump ${path}`, { profile: 'inspectorDump' })
    const toolOutput = `${said.stdout ?? ''}${said.stderr ?? ''}`.trim()
    const xml = new TextDecoder().decode(await this.transport.execOut(`cat ${path}`, { profile: 'inspectorDump' }))
    await this.transport.exec(`rm -f ${path}`, { profile: 'inspectorDump' })
    if (!xml.includes('<?xml')) {
      throw new InspectorError(
        'INSPECTOR_DUMP_FAILED',
        `uiautomator dump produced no hierarchy — the tool said ${short(toolOutput)}, reading ${path} gave ${short(xml)}`,
      )
    }
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
        const root = parseUiDump(raw)
        this.last = { root, at: Date.now() }
        return root
      } catch (err) {
        // With what the phone actually sent: the parser's own message names
        // the element it wanted, never the text it was given, and on a device
        // where `uiautomator` is failing that text IS the diagnosis.
        lastError = `failed to parse the dump: ${String(err)} — the device sent ${short(raw)}`
      }
    }
    throw new InspectorError('INSPECTOR_DUMP_FAILED', lastError || 'the dump failed with no detail')
  }

  /** The last tree `dump()` returned and when, or null (plan 208 §4.6). */
  lastDump(): { root: UiNode; at: number } | null {
    return this.last
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
