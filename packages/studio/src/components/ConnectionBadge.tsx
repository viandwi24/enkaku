import { EthernetPort, Network, Usb, Wifi } from 'lucide-react'
import { connectionBadge, type DeviceConnection } from '@enkaku/protocol'
import { cn } from '@enkaku/ui'

/**
 * USB | OTG | WI-FI | TCP — plan 88 §3.1, §4.1. `connectionBadge()` is the
 * one place the four-value string is computed from the two-field
 * `kind`/`medium` fact; this is the one place that string turns into pixels,
 * so a wall tile, a card and the device header can never disagree.
 *
 * Deliberately not styled as a `StatusBadge` (`led-*` colours): kind and
 * medium are not good/bad, and `docs/design.md` reserves saturated colour for
 * status alone. The icon carries the distinction instead — `Usb`,
 * `EthernetPort`, `Wifi`, or a plain `Network` glyph for the honest "we don't
 * know" case — so the badge still reads correctly for anyone who cannot see
 * colour, and at the ~10px size a wall tile has room for.
 *
 * No tooltip is required to understand it: the four words (USB / OTG / WI-FI
 * / TCP) ARE the explanation. `title` carries the longer version — the
 * medium's source and the address, when there is one — for anyone who
 * hovers, never as the only way to learn what the badge means.
 */
const CONNECTION_ICON = {
  USB: Usb,
  OTG: EthernetPort,
  'WI-FI': Wifi,
  TCP: Network,
} as const

/** The §3.1 tooltip table, plus the live address when one is known. Exported so a caller that already shows the address elsewhere (`DeviceCard`) is not forced to also read this one. */
export function connectionTooltip(connection: DeviceConnection): string {
  const address = connection.address ? (connection.port ? `${connection.address}:${connection.port}` : connection.address) : null
  switch (connectionBadge(connection)) {
    case 'USB':
      return 'Connected by cable to this computer'
    case 'OTG':
      return address ? `On the network over a wired connection · ${address}` : 'On the network over a wired connection'
    case 'WI-FI':
      return address ? `On the network over Wi-Fi · ${address}` : 'On the network over Wi-Fi'
    default:
      return address
        ? `On the network · ${address} — Enkaku does not know whether this is wired or Wi-Fi`
        : "On the network — Enkaku does not know whether this is wired or Wi-Fi"
  }
}

export function ConnectionBadge({ connection, className }: { connection: DeviceConnection; className?: string }) {
  const badge = connectionBadge(connection)
  const Icon = CONNECTION_ICON[badge]
  return (
    <span
      className={cn(
        'readout inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1 py-0.5 text-[10px] font-semibold leading-none tracking-wide',
        // TCP (medium unknown) reads a shade quieter than the other three —
        // that dimness IS the honest "we don't know", not a warning (plan 88
        // §3.1's whole point: never guess WI-FI here).
        badge === 'TCP' ? 'border-line text-fg-subtle' : 'border-line-strong text-fg-muted',
        className,
      )}
      title={connectionTooltip(connection)}
    >
      <Icon className="size-2.5" aria-hidden />
      {badge}
    </span>
  )
}
