import { IBM_Plex_Mono, Outfit } from 'next/font/google'

/**
 * Plan 101 (M66) step 101.1 — Outfit replaces Archivo, through the IDENTICAL
 * `next/font/google` mechanism: the reference (`refs/ui`) loads Outfit from
 * the Google Fonts CDN via a runtime `<link>`, which this app deliberately
 * does not copy — Studio is a static export served by the core, routinely on
 * closed networks, and on at least one real farm every request already
 * routes through the guest agent's SOCKS5 tunnel, where an external font
 * fetch does not degrade, it hangs. `next/font` self-hosts the font file at
 * BUILD time instead, so nothing is requested from a third party at runtime.
 *
 * IBM Plex Mono carries every instrument readout (temperature, fps, serial)
 * and is UNCHANGED by this refresh — the reference has no monospace face at
 * all, because it never had to render a temperature that changes twice a
 * second beside one that does not (`docs/design.md` §Typography).
 */
export const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  display: 'swap',
})

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})
