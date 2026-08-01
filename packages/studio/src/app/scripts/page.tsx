'use client'

import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@enkaku/protocol'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { fetchDevices } from '@/lib/api'
import { coreBase } from '@/lib/ws'

interface ScriptRow {
  id: string
  name: string
  version: string
  paramsSchema: JsonSchemaNode | null
  enabled: boolean
  createdAt: number | null
}

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptRow[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selected, setSelected] = useState<ScriptRow | null>(null)
  const [params, setParams] = useState<unknown>(undefined)
  const [deviceId, setDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function load() {
    const res = await fetch(`${coreBase()}/api/scripts`)
    const body = (await res.json()) as { scripts: ScriptRow[] }
    setScripts(body.scripts)
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e)))
    void fetchDevices()
      .then((d) => {
        setDevices(d)
        setDeviceId((prev) => prev || (d[0]?.id ?? ''))
      })
      .catch((e) => setError(String(e)))
  }, [])

  async function toggle(script: ScriptRow) {
    await fetch(`${coreBase()}/api/scripts/${script.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !script.enabled }),
    })
    await load()
  }

  async function remove(script: ScriptRow) {
    const res = await fetch(`${coreBase()}/api/scripts/${script.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = (await res.json()) as { error?: { message: string } }
      setError(body.error?.message ?? `HTTP ${res.status}`)
      return
    }
    if (selected?.id === script.id) setSelected(null)
    await load()
  }

  async function run() {
    if (!selected) return
    setError(null)
    setNotice(null)
    const res = await fetch(`${coreBase()}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptId: selected.id, deviceId, params: params ?? {} }),
    })
    const body = (await res.json()) as { job?: { jobId: string }; error?: { message: string } }
    if (!res.ok) {
      setError(body.error?.message ?? `HTTP ${res.status}`)
      return
    }
    setNotice(`Job dibuat: ${body.job?.jobId.slice(0, 8)} — lihat halaman Jobs.`)
  }

  return (
    <>
      <h1>Scripts</h1>
      <p className="hint">
        Publish dari mesin sendiri: <code>bunx enkaku publish ./script.ts --farm {coreBase()}</code>
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint">{notice}</p>}

      {scripts.length === 0 ? (
        <p className="hint">Belum ada script ter-publish.</p>
      ) : (
        <div className="panel" style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
                <th style={{ padding: '0.6rem' }}>Nama</th>
                <th>Versi</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scripts.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '0.6rem' }}>{s.name}</td>
                  <td className="meta">{s.version}</td>
                  <td>
                    <span className={`badge ${s.enabled ? 'idle' : 'offline'}`}>
                      {s.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => {
                          setSelected(s)
                          setParams(undefined)
                        }}
                      >
                        Run…
                      </button>
                      <button onClick={() => void toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button>
                      <button onClick={() => void remove(s)}>Hapus</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="panel">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>
              Run {selected.name}@{selected.version}
            </b>
            <button onClick={() => setSelected(null)}>Tutup</button>
          </div>
          <label style={{ margin: '0.5rem 0' }}>
            Device
            <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} — {d.status}
                </option>
              ))}
            </select>
          </label>
          {selected.paramsSchema ? (
            <SchemaForm
              schema={selected.paramsSchema}
              value={params}
              onChange={setParams}
              onSubmit={() => void run()}
              submitLabel="Jalankan"
            />
          ) : (
            <>
              <p className="hint">Script ini tidak menyertakan schema params.</p>
              <button className="primary" onClick={() => void run()}>
                Jalankan
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
