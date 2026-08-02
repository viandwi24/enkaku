import { Archivo, IBM_Plex_Mono } from 'next/font/google'

/**
 * Archivo: a grotesk built for dense, high-performance displays — industrial
 * without turning decorative. IBM Plex Mono carries every instrument readout
 * (temperature, fps, serial), because nearly every number here is a
 * measurement and its digits have to line up.
 *
 * next/font self-hosts the font files at build time, so nothing is requested
 * from a third party at runtime — which matters for farms running on closed
 * networks.
 */
export const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  display: 'swap',
})

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
})
