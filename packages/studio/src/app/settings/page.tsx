'use client'

import { useEffect, useState } from 'react'
import { SchemaForm } from '@/components/schema-form/SchemaForm'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { coreBase } from '@/lib/ws'

export default function SettingsPage() {
  const [schema, setSchema] = useState<JsonSchemaNode | null>(null)
  const [value, setValue] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${coreBase()}/api/settings`)
      .then((r) => r.json() as Promise<{ settings: unknown; schema: JsonSchemaNode }>)
      .then((body) => {
        setSchema(body.schema)
        setValue(body.settings)
      })
      .catch((e) => setError(String(e)))
  }, [])

  async function save() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fetch(`${coreBase()}/api/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
      const body = (await res.json()) as { settings?: unknown; error?: { message: string } }
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      setValue(body.settings)
      setNotice('Tersimpan.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Settings farm</h1>
      <p className="hint">
        Form ini dirender dari JSON Schema yang di-generate core dari Zod — tidak ada field yang di-hardcode di UI.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint">{notice}</p>}
      <div className="panel">
        {schema ? (
          <SchemaForm schema={schema} value={value} onChange={setValue} onSubmit={() => void save()} busy={busy} />
        ) : (
          <p className="hint">Memuat schema…</p>
        )}
      </div>
    </>
  )
}
