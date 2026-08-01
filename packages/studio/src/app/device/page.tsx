'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { DeviceInfo } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { fetchDevices } from '@/lib/api'

function DeviceDetail() {
  // Query param (bukan route dinamis) karena static export tidak bisa
  // pre-render id dinamis — lihat README studio.
  const deviceId = useSearchParams().get('id')
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!deviceId) return
    fetchDevices()
      .then((list) => {
        const found = list.find((d) => d.id === deviceId)
        if (!found) setError('Device tidak ditemukan')
        else setDevice(found)
      })
      .catch((err) => setError(String(err)))
  }, [deviceId])

  if (!deviceId) return <p className="error">Parameter ?id= wajib.</p>
  if (error) return <p className="error">{error}</p>
  if (!device) return <p className="hint">Memuat device…</p>

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>{device.label}</h1>
          <div className="meta">
            {device.serial} · stableId {device.stableId}
          </div>
        </div>
        <span className={`badge ${device.status}`}>{device.status}</span>
      </div>
      <LiveView deviceId={device.id} />
    </>
  )
}

export default function DevicePage() {
  return (
    <Suspense fallback={<p className="hint">Memuat…</p>}>
      <DeviceDetail />
    </Suspense>
  )
}
