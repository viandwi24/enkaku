'use client'

import { useEffect, useState } from 'react'
import { coreBase, ws } from '@/lib/ws'

interface ToolEntry {
  id: string
  displayName: string
  swappable: boolean
  managedByCore: boolean
  activeVersion: string | null
  installed: Array<{ version: string; active: boolean; sha256: string | null; installedAt: number | null }>
  available: Array<{ version: string; knownGood: boolean; installable: boolean; compatibleWithThisCore?: boolean }>
  health: { ok: boolean; checkedAt: number; detail: string } | null
}

interface Progress {
  phase: string
  percent: number | null
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const res = await fetch(`${coreBase()}/api/tools`)
    const body = (await res.json()) as { tools: ToolEntry[] }
    setTools(body.tools)
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e)))
    const off = ws.on((msg) => {
      if (msg.type === 'tool.install.progress') {
        setProgress((p) => ({
          ...p,
          [msg.payload.toolId]: { phase: msg.payload.phase, percent: msg.payload.percent ?? null },
        }))
        if (msg.payload.phase === 'done' || msg.payload.phase === 'error') void load()
      } else if (msg.type === 'tool.changed') {
        void load()
      }
    })
    return off
  }, [])

  async function call(path: string, init?: RequestInit) {
    setError(null)
    setBusy(path)
    try {
      const res = await fetch(`${coreBase()}${path}`, init)
      const body = (await res.json()) as { error?: { message: string } }
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const jsonPost = (version: string): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  })

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Tools</h1>
        <button onClick={() => void call('/api/tools/manifest/refresh', { method: 'POST' })} disabled={busy !== null}>
          Refresh manifest
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      {tools.map((tool) => {
        const prog = progress[tool.id]
        return (
          <div className="panel" key={tool.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b>{tool.displayName}</b>{' '}
                {tool.managedByCore && <span className="badge">managed by core</span>}
                <div className="meta">
                  aktif: {tool.activeVersion ?? '—'}
                  {tool.health && ` · health: ${tool.health.ok ? 'ok' : 'gagal'} (${tool.health.detail})`}
                </div>
              </div>
              {tool.swappable && (
                <button onClick={() => void call(`/api/tools/${tool.id}/check`, { method: 'POST' })}>
                  Health check
                </button>
              )}
            </div>

            {prog && prog.phase !== 'done' && (
              <div className="hint">
                {prog.phase} {prog.percent !== null ? `${prog.percent}%` : ''}
              </div>
            )}

            {!tool.swappable ? (
              <p className="hint" style={{ marginBottom: 0 }}>
                Versi dikunci ke rilis core — protokol client↔server tool ini berubah antar versi, jadi tidak bisa
                dipilih bebas (spec §7.6).
              </p>
            ) : (
              <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse' }}>
                <tbody>
                  {tool.available.map((v) => {
                    const installed = tool.installed.find((i) => i.version === v.version)
                    const active = tool.activeVersion === v.version
                    return (
                      <tr key={v.version} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '0.45rem 0' }}>
                          {v.version} {v.knownGood && <span className="hint">(known good)</span>}
                        </td>
                        <td>{active ? <span className="badge idle">aktif</span> : installed ? 'terpasang' : ''}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="row" style={{ justifyContent: 'flex-end' }}>
                            {!installed && (
                              <button
                                disabled={!v.installable || busy !== null}
                                onClick={() => void call(`/api/tools/${tool.id}/install`, jsonPost(v.version))}
                              >
                                Install
                              </button>
                            )}
                            {installed && !active && (
                              <>
                                <button
                                  disabled={busy !== null}
                                  onClick={() => void call(`/api/tools/${tool.id}/activate`, jsonPost(v.version))}
                                >
                                  Aktifkan
                                </button>
                                <button
                                  disabled={busy !== null}
                                  onClick={() => void call(`/api/tools/${tool.id}/${v.version}`, { method: 'DELETE' })}
                                >
                                  Hapus
                                </button>
                              </>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
    </>
  )
}
