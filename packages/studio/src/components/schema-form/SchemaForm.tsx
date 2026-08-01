'use client'

import { useEffect, useMemo, useState } from 'react'
import { applyDefaults, deref, getAtPath, getNodeKind, humanize, setAtPath } from './resolve'
import type { FieldProps, JsonSchemaNode } from './types'
import { validateAgainstSchema } from './validate'

/**
 * Renderer form dari JSON Schema (spec §8, §19): tiap engine/tool/script
 * otomatis punya panel setting tanpa UI hardcode. Schema di-generate dari
 * Zod di core, jadi satu sumber kebenaran.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  serverErrors,
  onSubmit,
  submitLabel = 'Simpan',
  busy,
}: {
  schema: JsonSchemaNode
  value: unknown
  onChange(next: unknown): void
  serverErrors?: Record<string, string>
  onSubmit?: () => void
  submitLabel?: string
  busy?: boolean
}) {
  const [touched, setTouched] = useState(false)

  // Nilai awal diisi dari `default` schema secara rekursif.
  useEffect(() => {
    const filled = applyDefaults(schema, value, schema)
    if (JSON.stringify(filled) !== JSON.stringify(value)) onChange(filled)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema])

  const clientErrors = useMemo(() => validateAgainstSchema(schema, value, schema), [schema, value])
  const errors = { ...(touched ? clientErrors : {}), ...(serverErrors ?? {}) }
  const hasErrors = Object.keys(clientErrors).length > 0

  const handleChange = (path: string, next: unknown) => onChange(setAtPath(value, path, next))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        setTouched(true)
        if (!hasErrors) onSubmit?.()
      }}
    >
      <SchemaField
        schema={schema}
        root={schema}
        path=""
        label=""
        value={value}
        errors={errors}
        onChange={handleChange}
      />
      {onSubmit && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Menyimpan…' : submitLabel}
          </button>
          {touched && hasErrors && <span className="error">Perbaiki isian yang bertanda merah dulu.</span>}
        </div>
      )}
    </form>
  )
}

function SchemaField(props: FieldProps & { root: JsonSchemaNode }) {
  const { root, path, label, value, errors, onChange } = props
  const schema = deref(props.schema, root)
  const kind = getNodeKind(schema, root)
  const error = errors[path]
  const help = schema.description

  if (kind === 'object') {
    const entries = Object.entries(schema.properties ?? {})
    return (
      <fieldset
        style={{
          border: path ? '1px solid var(--border)' : 'none',
          borderRadius: 8,
          padding: path ? '0.75rem' : 0,
          margin: path ? '0.5rem 0' : 0,
        }}
      >
        {path && <legend style={{ padding: '0 0.4rem', color: 'var(--muted)', fontSize: 12.5 }}>{label}</legend>}
        {entries.map(([key, child]) => (
          <SchemaField
            key={key}
            root={root}
            schema={child}
            path={path ? `${path}.${key}` : key}
            label={deref(child, root).title ?? humanize(key)}
            value={getAtPath(value, key)}
            errors={errors}
            onChange={onChange}
          />
        ))}
      </fieldset>
    )
  }

  const wrap = (input: React.ReactNode) => (
    <div style={{ margin: '0.5rem 0' }}>
      <label>
        {label}
        {input}
      </label>
      {help && <div className="hint">{help}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )

  if (kind === 'boolean') {
    return (
      <div style={{ margin: '0.5rem 0' }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(path, e.target.checked)} />
          <span>{label}</span>
        </label>
        {help && <div className="hint">{help}</div>}
      </div>
    )
  }

  if (kind === 'enum') {
    return wrap(
      <select value={String(value ?? '')} onChange={(e) => onChange(path, e.target.value)}>
        {(schema.enum ?? []).map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>,
    )
  }

  if (kind === 'number') {
    return wrap(
      <input
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(path, e.target.value === '' ? undefined : Number(e.target.value))}
      />,
    )
  }

  if (kind === 'range-tuple') {
    const arr = Array.isArray(value) ? value : [undefined, undefined]
    return wrap(
      <span className="row">
        <input
          type="number"
          placeholder="min"
          value={arr[0] === undefined ? '' : String(arr[0])}
          onChange={(e) => onChange(path, [Number(e.target.value), arr[1] ?? 0])}
          style={{ width: 100 }}
        />
        <span className="hint">s/d</span>
        <input
          type="number"
          placeholder="max"
          value={arr[1] === undefined ? '' : String(arr[1])}
          onChange={(e) => onChange(path, [arr[0] ?? 0, Number(e.target.value)])}
          style={{ width: 100 }}
        />
      </span>,
    )
  }

  if (kind === 'array') {
    const arr = Array.isArray(value) ? value : []
    return wrap(
      <span>
        {arr.map((item, i) => (
          <span key={i} className="row" style={{ marginBottom: '0.25rem' }}>
            <input
              value={String(item ?? '')}
              onChange={(e) => {
                const next = [...arr]
                next[i] = e.target.value
                onChange(path, next)
              }}
            />
            <button type="button" onClick={() => onChange(path, arr.filter((_, j) => j !== i))}>
              Hapus
            </button>
          </span>
        ))}
        <button type="button" onClick={() => onChange(path, [...arr, ''])}>
          Tambah
        </button>
      </span>,
    )
  }

  if (kind === 'string') {
    return wrap(<input value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(path, e.target.value)} />)
  }

  // Tipe di luar dukungan renderer → editor JSON mentah + peringatan jujur.
  return wrap(
    <span>
      <textarea
        rows={3}
        style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        value={value === undefined ? '' : JSON.stringify(value)}
        onChange={(e) => {
          try {
            onChange(path, JSON.parse(e.target.value))
          } catch {
            onChange(path, e.target.value)
          }
        }}
      />
      <span className="hint">Tipe ini belum punya editor khusus — isi sebagai JSON.</span>
    </span>,
  )
}
