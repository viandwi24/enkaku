'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { DeviceInfo, DeviceStatus } from '@enkaku/protocol'
import { LiveView } from '@/components/LiveView'
import { fetchDevices } from '@/lib/api'
import { newId, ws } from '@/lib/ws'

function DeviceDetail() {
  // Query param (bukan route dinamis) karena static export tidak bisa
  // pre-render id dinamis — lihat README studio.
  const deviceId = useSearchParams().get('id')
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [hasLease, setHasLease] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!deviceId) return
    fetchDevices()
      .then((list) => {
        const found = list.find((d) => d.id === deviceId)
        if (!found) setError('Device tidak ditemukan')
        else {
          setDevice(found)
          setStatus(found.status)
        }
      })
      .catch((err) => setError(String(err)))

    const off = ws.on((msg) => {
      if (msg.type === 'device.status' && msg.payload.id === deviceId) {
        setStatus(msg.payload.status)
        if (msg.payload.status !== 'manual') setHasLease(false)
      } else if (msg.type === 'lease.revoked' && msg.payload.deviceId === deviceId) {
        setHasLease(false)
        setNotice(`Kontrol dilepas otomatis (${msg.payload.reason}).`)
      }
    })
    return off
  }, [deviceId])

  async function takeControl() {
    if (!deviceId) return
    setError(null)
    setNotice(null)
    try {
      const res = await ws.request({ type: 'lease.acquire', id: newId(), payload: { deviceId } })
      if (res.type === 'lease.acquired') setHasLease(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function releaseControl() {
    if (!deviceId) return
    ws.send({ type: 'lease.release', payload: { deviceId } })
    setHasLease(false)
  }

  if (!deviceId) return <p className="error">Parameter ?id= wajib.</p>
  if (error && !device) return <p className="error">{error}</p>
  if (!device) return <p className="hint">Memuat device…</p>

  const busy = status === 'busy'

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>{device.label}</h1>
          <div className="meta">
            {device.serial} · stableId {device.stableId}
          </div>
        </div>
        <div className="row">
          <span className={`badge ${status ?? device.status}`}>{status ?? device.status}</span>
          {hasLease ? (
            <button onClick={releaseControl}>Lepas kontrol</button>
          ) : (
            <button className="primary" onClick={() => void takeControl()} disabled={busy}>
              Ambil kontrol
            </button>
          )}
        </div>
      </div>

      {busy && (
        <div className="panel" style={{ borderColor: 'var(--accent)' }}>
          <b>Automation running</b> — input dinonaktifkan, video tetap jalan (watch only).
        </div>
      )}
      {notice && <p className="hint">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {!busy && !hasLease && (
        <p className="hint">Klik “Ambil kontrol” dulu — core menolak input tanpa lease (server-authoritative).</p>
      )}

      <LiveView deviceId={device.id} inputEnabled={hasLease && !busy} />
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
