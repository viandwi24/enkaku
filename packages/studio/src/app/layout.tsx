import type { ReactNode } from 'react'
import './globals.css'

export const metadata = {
  title: 'Enkaku Studio',
  description: 'Device farm — remote control & automation Android',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <header className="topbar">
          <a href="/" className="brand">
            Enkaku <span className="brand-sub">Studio</span>
          </a>
          <nav className="row">
            <a href="/" className="hint">
              Devices
            </a>
            <a href="/scripts" className="hint">
              Scripts
            </a>
            <a href="/jobs" className="hint">
              Jobs
            </a>
            <a href="/tools" className="hint">
              Tools
            </a>
            <a href="/settings" className="hint">
              Settings
            </a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
