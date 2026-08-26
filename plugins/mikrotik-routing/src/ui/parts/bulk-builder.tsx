import type { FleetDeviceRow, Path } from './api'

/**
 * The bulk-assignment builder — plan 131 §3.1, §4.1. The owner's own ask
 * (§0.1, verbatim in the plan): type a device-NUMBER range and a starting
 * path INDEX, pair them positionally, and show the result before anything is
 * written. Shared by the Assignments tab (131.2, not built here) and the
 * group editor (131.3, not built here); this step ships only the pure
 * pairing function both will render identically, so the preview and the
 * writer can never compute two different answers.
 *
 * The preview is the feature (§3.1, §0.1's "plan, then apply" rule aimed at
 * the database instead of the router): a builder that writes twenty rows
 * from a typed range without showing its work first is exactly the failure
 * plan 122 §4.4 forbids for the router.
 */

export interface BulkPairing {
  /** Inclusive device-number range, as typed. `toNumber < fromNumber` is rejected, never silently swapped. */
  fromNumber: number
  toNumber: number
  /** Index into the ordered path list (the Paths tab's own array order) where pairing starts. */
  pathStartIndex: number
  /**
   * What happens once the device range outruns the path list counted from
   * `pathStartIndex`. This function takes no default — §9 Q1 is a UI-layer
   * decision for whichever step builds the control (131.2), not this pure
   * function's to assume — but the recommendation, decided against the
   * owner's own fleet shape (20 devices, ~22 paths, so the two modes rarely
   * even disagree): default the control to `'stop'`. `'wrap'` re-pairs a
   * later device onto a path an earlier device already got, silently
   * doubling up an egress path across two devices — exactly the class of
   * surprise a bulk builder exists to prevent. `'stop'` instead leaves the
   * remaining numbers visibly `no-path` in the preview: a fact the operator
   * sees and can act on (extend the path list, or shorten the range),
   * rather than a shared path they were never told about.
   */
  overflow: 'wrap' | 'stop'
}

export type PairingNote = 'ok' | 'no-such-device' | 'already-assigned' | 'no-path'

export interface PairingRow {
  deviceNumber: number
  /** `null` when no enrolled device carries this number — never dropped from the result, per §0.1/§3.1. */
  deviceId: string | null
  /** `null` when pairing ran out of paths under `overflow: 'stop'`. */
  pathId: string | null
  pathLabel: string | null
  note: PairingNote
}

/**
 * Pure. The preview renders exactly what this returns, and the writer
 * (131.2/131.3) consumes the same rows — what is shown is what gets written.
 *
 * Devices are matched by their farm NUMBER (`FleetDeviceRow.number`); a
 * device with no number can never be matched by a range and is simply never
 * looked up. Paths are addressed purely by their position in `paths` — the
 * caller (the Paths tab's own list order) owns what "index" means, not this
 * function. Pairing is strictly positional: the i-th number in the range
 * (`fromNumber + i`) pairs with path index `pathStartIndex + i`, wrapped
 * modulo `paths.length` under `overflow: 'wrap'`, or left unpaired past the
 * end of the list under `overflow: 'stop'`.
 *
 * Every anomaly is a ROW, never an omission: a number nobody has is
 * `no-such-device` (`deviceId: null`); a device that already carries an
 * assignment is `already-assigned` but still shows the path it would be
 * repointed to, so the operator can see exactly what they are about to
 * overwrite; running out of paths under `'stop'` is `no-path`
 * (`pathId: null`). The returned array always has exactly
 * `toNumber - fromNumber + 1` rows — nothing in the range is ever dropped.
 *
 * An inverted range (`toNumber < fromNumber`) is rejected outright (throws),
 * never silently swapped into the other order — §5 step 131.1's own test.
 */
export function buildPairings(input: BulkPairing, devices: readonly FleetDeviceRow[], paths: readonly Path[]): PairingRow[] {
  const { fromNumber, toNumber, pathStartIndex, overflow } = input
  if (toNumber < fromNumber) {
    throw new Error(`invalid device range: ${fromNumber}..${toNumber} — "to" must be >= "from"`)
  }

  const deviceByNumber = new Map<number, FleetDeviceRow>()
  for (const device of devices) {
    if (device.number !== null) deviceByNumber.set(device.number, device)
  }

  const rows: PairingRow[] = []
  for (let deviceNumber = fromNumber; deviceNumber <= toNumber; deviceNumber++) {
    const offset = deviceNumber - fromNumber
    const device = deviceByNumber.get(deviceNumber) ?? null

    let path: Path | null = null
    if (paths.length > 0) {
      const rawIndex = pathStartIndex + offset
      const pathIndex = overflow === 'wrap' ? rawIndex % paths.length : rawIndex < paths.length ? rawIndex : null
      path = pathIndex !== null ? (paths[pathIndex] ?? null) : null
    }

    let note: PairingNote
    if (!device) note = 'no-such-device'
    else if (!path) note = 'no-path'
    else if (device.assignment.pathId !== '') note = 'already-assigned'
    else note = 'ok'

    rows.push({
      deviceNumber,
      deviceId: device ? device.deviceId : null,
      pathId: path ? path.id : null,
      pathLabel: path ? path.table : null,
      note,
    })
  }
  return rows
}
