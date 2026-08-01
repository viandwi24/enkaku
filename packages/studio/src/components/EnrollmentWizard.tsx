'use client'

import { useState } from 'react'
import { newId, ws } from '@/lib/ws'

/**
 * Enrollment wizard (spec §15.1): dua alur — USB unauthorized (instruksi)
 * dan wireless pairing Android 11+ (adb pair + 6-digit code, lalu connect).
 */
export function EnrollmentWizard({
  unauthorizedSerials,
  onClose,
}: {
  unauthorizedSerials: string[]
  onClose: () => void
}) {
  const [host, setHost] = useState('192.168.1.')
  const [pairPort, setPairPort] = useState('')
  const [code, setCode] = useState('')
  const [connectPort, setConnectPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function pair() {
    setBusy(true)
    setError(null)
    setOutput(null)
    try {
      const req = await ws.request({
        type: 'device.pairing.request',
        id: newId(),
        payload: { host: host.trim(), port: Number.parseInt(pairPort, 10) },
      })
      if (req.type !== 'device.pairing.request.result') throw new Error('balasan core tidak terduga')
      const res = await ws.request({
        type: 'device.pairing.code',
        id: newId(),
        payload: {
          pairingId: req.payload.pairingId,
          code: code.trim(),
          ...(connectPort ? { connectPort: Number.parseInt(connectPort, 10) } : {}),
        },
      })
      if (res.type !== 'device.pairing.code.result') throw new Error('balasan core tidak terduga')
      setOutput(res.payload.message)
      if (!res.payload.success) setError('Pairing gagal — lihat pesan adb di bawah.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pairDisabled = busy || !host.trim() || !/^\d+$/.test(pairPort) || !/^\d{6}$/.test(code.trim())

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Enrollment device</h1>
        <button onClick={onClose}>Tutup</button>
      </div>

      <section style={{ marginTop: '1rem' }}>
        <h2 style={{ fontSize: '0.95rem' }}>1. USB — izinkan USB debugging</h2>
        {unauthorizedSerials.length === 0 ? (
          <p className="hint">Tidak ada device USB yang menunggu otorisasi.</p>
        ) : (
          <>
            <p className="hint">
              Device berikut menunggu otorisasi: <b>{unauthorizedSerials.join(', ')}</b>
            </p>
            <ol className="hint">
              <li>Cek layar HP — muncul dialog “Allow USB debugging?”</li>
              <li>Centang “Always allow from this computer”</li>
              <li>Tap <b>Allow</b> — device akan terdaftar otomatis di sini</li>
            </ol>
          </>
        )}
      </section>

      <section style={{ marginTop: '1.25rem' }}>
        <h2 style={{ fontSize: '0.95rem' }}>2. Wireless (Android 11+) — pairing code</h2>
        <p className="hint">
          Di HP: Developer options → Wireless debugging → <b>Pair device with pairing code</b>. Biarkan layar pairing
          tetap terbuka (kode & port berubah kalau ditutup).
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label>
            Host / IP
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.42" />
          </label>
          <label>
            Pairing port
            <input value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="37129" />
          </label>
          <label>
            Kode 6 digit
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={6} />
          </label>
          <label>
            Connect port (opsional)
            <input value={connectPort} onChange={(e) => setConnectPort(e.target.value)} placeholder="5555" />
          </label>
          <button className="primary" onClick={() => void pair()} disabled={pairDisabled}>
            {busy ? 'Memasangkan…' : 'Pair & connect'}
          </button>
        </div>
        <p className="hint" style={{ marginTop: '0.5rem' }}>
          Connect port berbeda dari pairing port — ambil dari layar utama Wireless debugging.
        </p>
        {error && <p className="error">{error}</p>}
        {output && <pre className="out">{output}</pre>}
      </section>
    </div>
  )
}
