'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/', label: 'Devices' },
  { href: '/scripts', label: 'Scripts' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/tools', label: 'Tools' },
  { href: '/settings', label: 'Settings' },
]

/**
 * Navigasi memakai `Link`, bukan `<a>`: tautan biasa memicu navigasi dokumen
 * penuh — React di-mount ulang, koneksi WebSocket terputus, dan stream video
 * yang sedang berjalan ikut mati. `Link` berpindah halaman di sisi klien
 * sehingga state tetap hidup.
 */
export function Nav() {
  const pathname = usePathname()
  const isActive = (href: string) => (href === '/' ? pathname === '/' || pathname === '/device' : pathname.startsWith(href))

  return (
    <nav className="row">
      {ITEMS.map((item) => (
        <Link key={item.href} href={item.href} className={`navlink${isActive(item.href) ? ' active' : ''}`}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
