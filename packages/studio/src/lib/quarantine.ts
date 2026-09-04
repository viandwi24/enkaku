/**
 * `thermal:49.8C` is not a sentence — turn it into something readable. Moved
 * out of `components/DeviceCard.tsx` by plan 214 §3.5 (the fleet screen's
 * card is deleted, but `WallTile.tsx` still needs this), so both the Screens
 * grid's card and the picker's own tile import the same function.
 *
 * `nowC` exists because of a field report (2026-08-26): `quarantineReason` is
 * a SNAPSHOT frozen at the instant the device was pulled, and it was being
 * rendered inches from the live reading. A card read `Temp 31.8°C` on one
 * line and `temperature reached 45.6°C` on the next, which looks like the
 * farm cannot read its own thermometer rather than like a device that has
 * since cooled. Naming the current figure beside the historical one is what
 * makes the pair legible — and it is exactly the operator's real question:
 * "is it safe to put this back to work?"
 *
 * Only shown when it is genuinely cooler, and never invented: an unknown
 * `nowC`, or one that has not dropped, renders the original phrase unchanged.
 */
export function explainQuarantine(reason: string, nowC?: number | null): string {
  const thermal = /^thermal:([\d.]+)C$/.exec(reason)
  if (thermal) {
    const at = `temperature reached ${thermal[1]}°C`
    const pulledAt = Number(thermal[1])
    return nowC != null && Number.isFinite(nowC) && nowC < pulledAt ? `${at} — now ${nowC.toFixed(1)}°C` : at
  }
  return reason
}
