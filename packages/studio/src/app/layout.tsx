import type { ReactNode } from 'react'
import { Toaster, TooltipProvider } from '@enkaku/ui'
import { ActionDialogHost } from '@/components/actions/ActionDialogHost'
import { AuthGate } from '@/components/layout/AuthGate'
import { THEME_BOOT } from '@/components/shell/theme-boot'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './globals.css'

export const metadata = {
  title: 'Enkaku Studio',
  description: 'Android device farm — remote control and automation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` because the boot script below writes
    // `data-theme` on this element before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger -- a fixed string constant, no interpolation */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <TooltipProvider delayDuration={200}>
          {/* Every route is gated behind the core's own auth state (plan 09
              §4.14) — `AuthGate` renders `/login` or `/setup` standalone when
              unauthenticated, and only wraps `children` in `AppShell` once
              there is a session (or local mode's implicit admin). */}
          <AuthGate>{children}</AuthGate>
        </TooltipProvider>
        <Toaster position="bottom-right" richColors closeButton />
        {/* Mounted once, beside the Toaster (plan 216 §4.9). `AppShell` is
            unauthenticated-route-conditional (`AuthGate`); this is not, so it
            lives here rather than there — a discrepancy from the plan's own
            text, recorded in plan 216 §11. */}
        <ActionDialogHost />
      </body>
    </html>
  )
}
