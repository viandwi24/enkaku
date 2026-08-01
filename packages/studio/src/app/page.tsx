'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { DeviceCard } from '@/components/DeviceCard'
import { EnrollmentWizard } from '@/components/EnrollmentWizard'
import { fetchDevices } from '@/lib/api'
import { ws } from '@/lib/ws'

export default function Dashboard() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [unauthorized, setUnauthorized] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Snapshot awal via REST, lalu realtime via WS (core tidak me-replay).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchDevices()
        .then((d) => {
          if (!cancelled) {
            setDevices(d)
            setError(null)
          }
        })
        .catch((err) => !cancelled && setError(String(err)))
    void load()

    const offStatus = ws.onStatus(setConnected)
    const offReconnect = ws.onReconnected(() => void load())
    const off = ws.on((msg) => {
      if (msg.type === 'device.added') {
        setDevices((prev) => [...prev.filter((d) => d.id !== msg.payload.id), msg.payload])
        setUnauthorized((prev) => prev.filter((s) => s !== msg.payload.serial))
      } else if (msg.type === 'device.status') {
        setDevices((prev) => prev.map((d) => (d.id === msg.payload.id ? { ...d, status: msg.payload.status } : d)))
        if (msg.payload.status === 'idle') void load()
      } else if (msg.type === 'device.removed') {
        setDevices((prev) => prev.filter((d) => d.id !== msg.payload.id))
      } else if (msg.type === 'device.unauthorized') {
        setUnauthorized((prev) => (prev.includes(msg.payload.serial) ? prev : [...prev, msg.payload.serial]))
        setShowWizard(true)
      }
    })
    return () => {
      cancelled = true
      off()
      offStatus()
      offReconnect()
    }
  }, [])

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Devices</h1>
        <div className="row">
          <span className="hint">
            <span className={`dot ${connected ? 'on' : 'off'}`} /> {connected ? 'terhubung' : 'menyambung ulang…'}
          </span>
          <button onClick={() => setShowWizard((v) => !v)}>
            {showWizard ? 'Tutup enrollment' : 'Tambah device'}
          </button>
        </div>
      </div>

      {error && <p className="error">Gagal memuat device: {error}</p>}

      {showWizard && (
        <EnrollmentWizard unauthorizedSerials={unauthorized} onClose={() => setShowWizard(false)} />
      )}

      {devices.length === 0 ? (
        <p className="hint">
          Belum ada device. Colok HP via USB (izinkan USB debugging di layar HP) atau pakai tombol “Tambah device”
          untuk pairing wireless.
        </p>
      ) : (
        <div className="grid">
          {devices.map((d) => (
            <DeviceCard key={d.id} device={d} />
          ))}
        </div>
      )}
    </>
  )
}
