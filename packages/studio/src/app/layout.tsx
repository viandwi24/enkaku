import type { ReactNode } from 'react'
import Link from 'next/link'
import { Nav } from '@/components/Nav'
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
          <Link href="/" className="brand">
            Enkaku <span className="brand-sub">Studio</span>
          </Link>
          <Nav />
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
