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
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
