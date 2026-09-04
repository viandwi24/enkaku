/**
 * The RULE for the boot-time `adb forward --list` cleanup, extracted so it is
 * unit-testable without spawning adb or building the whole daemon (plan 223
 * §4.4) — mirrors `parseListForwardBlock`/`parseReverseList`'s own precedent
 * of pure parsers beside their spawn-heavy callers.
 */

export interface ListForwardEntry {
  serial: string
  local: string
  remote: string
}

export interface BootForwardCleanupConfig {
  uiServerDevicePort: number // UI_SERVER_DEVICE_PORT, 9008
  uiServerRangeStart: number
  uiServerRangeEnd: number
}

/**
 * Whether a boot-time cleanup should remove this ONE forward entry (plan 223
 * §3.4). Two independent reasons, either sufficient on its own: it is ours by
 * construction because its LOCAL port falls in the configured ui-server range
 * and its REMOTE names ui-server's fixed device port (unchanged from the
 * pre-existing cleanup, plan 85 §4.8); or its REMOTE matches this codebase's
 * own scrcpy socket-name pattern (`isOwnScrcpyForwardRemote`, plan 223 §4.2),
 * regardless of its LOCAL port, because scrcpy's local port is always
 * `tcp:0`-allocated and therefore tells us nothing.
 */
export function shouldRemoveBootForward(
  entry: ListForwardEntry,
  cfg: BootForwardCleanupConfig,
  isOwnScrcpyForwardRemote: (remote: string) => boolean,
): boolean {
  const portMatch = /^tcp:(\d+)$/.exec(entry.local)
  const isUiServer =
    entry.remote === `tcp:${cfg.uiServerDevicePort}` &&
    portMatch !== null &&
    Number(portMatch[1]) >= cfg.uiServerRangeStart &&
    Number(portMatch[1]) <= cfg.uiServerRangeEnd
  return isUiServer || isOwnScrcpyForwardRemote(entry.remote)
}

/** Parses one `adb forward --list` line into `ListForwardEntry`, or null for a blank/malformed line. Pure, so the merged loop below and its test share one parser. */
export function parseForwardListLine(rawLine: string): ListForwardEntry | null {
  const fields = rawLine.trim().split(/\s+/)
  const [serial, local, remote] = fields
  if (!serial || !local || !remote) return null
  return { serial, local, remote }
}
