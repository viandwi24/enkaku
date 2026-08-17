import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthGate } from '@/components/layout/AuthGate'
import { outfit, plexMono } from './fonts'
import './globals.css'

export const metadata = {
  title: 'Enkaku Studio',
  description: 'Android device farm — remote control and automation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${plexMono.variable}`}>
      <body>
        <TooltipProvider delayDuration={200}>
          {/* Every route is gated behind the core's own auth state (plan 09
              §4.14) — `AuthGate` renders `/login` or `/setup` standalone when
              unauthenticated, and only wraps `children` in `AppShell` once
              there is a session (or local mode's implicit admin). */}
          <AuthGate>{children}</AuthGate>
        </TooltipProvider>
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  )
}
