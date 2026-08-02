'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { applyDefaults, deref, getAtPath, getNodeKind, humanize, setAtPath } from './resolve'
import type { FieldProps, JsonSchemaNode } from './types'
import { useEnumOptions } from './useEnumSource'
import { validateAgainstSchema } from './validate'

/**
 * Form renderer driven by JSON Schema (spec §8): every engine, tool, and
 * script gets a settings panel with no hardcoded UI. The schema is generated
 * from Zod in the core, so there is a single source of truth — and values
 * outside the list are rejected by the server, not merely hidden in the UI.
 */
export function SchemaForm({
  schema,
  value,
  onChange,
  serverErrors,
  onSubmit,
  onReset,
  submitLabel = 'Save changes',
  busy,
  dirty,
}: {
  schema: JsonSchemaNode
  value: unknown
  onChange(next: unknown): void
  serverErrors?: Record<string, string>
  onSubmit?: () => void
  onReset?: () => void
  submitLabel?: string
  busy?: boolean
  dirty?: boolean
}) {
  const [touched, setTouched] = useState(false)

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
        // Solid background, not translucent: the save bar often covers the
        // last field, and text bleeding through makes both unreadable.
        <div
          className="sticky bottom-0 z-10 mt-5 flex flex-wrap items-center gap-2 border-t bg-bg py-3"
        >
          <Button type="submit" disabled={busy || dirty === false}>
            {busy ? 'Saving…' : submitLabel}
          </Button>
          {onReset && (
            <Button type="button" variant="ghost" onClick={onReset} disabled={busy || dirty === false}>
              Discard changes
            </Button>
          )}
          {touched && hasErrors && (
            <span className="text-[12px] text-led-danger">Fix the fields marked in red first.</span>
          )}
          {dirty === false && <span className="text-[12px] text-fg-subtle">No changes</span>}
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
  const id = `f-${path.replace(/\./g, '-') || 'root'}`

  if (kind === 'object') {
    const entries = Object.entries(schema.properties ?? {})
    if (!path) {
      return (
        <div className="space-y-5">
          {entries.map(([key, child]) => (
            <SchemaField
              key={key}
              root={root}
              schema={child}
              path={key}
              label={deref(child, root).title ?? humanize(key)}
              value={getAtPath(value, key)}
              errors={errors}
              onChange={onChange}
            />
          ))}
        </div>
      )
    }
    // Top-level groups become cards; nested groups only get a left rule.
    // Cards inside cards add borders without adding clarity.
    const nested = path.includes('.')
    const body = (
      <div className={cn('space-y-4', nested ? 'mt-2.5' : 'mt-4')}>
        {entries.map(([key, child]) => (
          <SchemaField
            key={key}
            root={root}
            schema={child}
            path={`${path}.${key}`}
            label={deref(child, root).title ?? humanize(key)}
            value={getAtPath(value, key)}
            errors={errors}
            onChange={onChange}
          />
        ))}
      </div>
    )

    if (nested) {
      return (
        <section className="border-l-2 pl-3.5">
          <h4 className="rack-label">{label}</h4>
          {help && <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">{help}</p>}
          {body}
        </section>
      )
    }

    return (
      <section className="rounded-lg border bg-surface p-5">
        <h3 className="text-[14px] font-semibold tracking-tight">{label}</h3>
        {help && <p className="mt-1 text-[12px] leading-relaxed text-fg-muted">{help}</p>}
        {body}
      </section>
    )
  }

  const Wrap = ({ children, inline }: { children: React.ReactNode; inline?: boolean }) => (
    <div className={cn(inline ? 'flex items-start justify-between gap-4' : 'space-y-1.5')}>
      <div className={inline ? 'min-w-0 flex-1' : undefined}>
        <Label htmlFor={id} className="text-[13px] font-normal">
          {label}
        </Label>
        {help && <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">{help}</p>}
      </div>
      <div className={inline ? 'shrink-0' : undefined}>{children}</div>
      {error && !inline && <p className="text-[11.5px] text-led-danger">{error}</p>}
    </div>
  )

  if (kind === 'boolean') {
    return (
      <Wrap inline>
        <Switch id={id} checked={value === true} onCheckedChange={(v) => onChange(path, v)} />
      </Wrap>
    )
  }

  if (kind === 'enum') {
    return <EnumField id={id} schema={schema} label={label} help={help} value={value} error={error} path={path} onChange={onChange} />
  }

  if (kind === 'number') {
    return (
      <Wrap>
        <Input
          id={id}
          type="number"
          className="readout max-w-40"
          value={value === undefined || value === null ? '' : String(value)}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(path, e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </Wrap>
    )
  }

  if (kind === 'range-tuple') {
    const arr = Array.isArray(value) ? value : [undefined, undefined]
    return (
      <Wrap>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            aria-label={`${label} minimum`}
            className="readout w-24"
            value={arr[0] === undefined ? '' : String(arr[0])}
            onChange={(e) => onChange(path, [Number(e.target.value), arr[1] ?? 0])}
          />
          <span className="text-[11px] text-fg-subtle">to</span>
          <Input
            type="number"
            aria-label={`${label} maximum`}
            className="readout w-24"
            value={arr[1] === undefined ? '' : String(arr[1])}
            onChange={(e) => onChange(path, [arr[0] ?? 0, Number(e.target.value)])}
          />
        </div>
      </Wrap>
    )
  }

  if (kind === 'array') {
    const arr = Array.isArray(value) ? value : []
    return (
      <Wrap>
        <div className="space-y-1.5">
          {arr.map((item, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={String(item ?? '')}
                aria-label={`${label} ${i + 1}`}
                onChange={(e) => {
                  const next = [...arr]
                  next[i] = e.target.value
                  onChange(path, next)
                }}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange(path, arr.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(path, [...arr, ''])}>
            Add
          </Button>
        </div>
      </Wrap>
    )
  }

  if (kind === 'string') {
    return (
      <Wrap>
        <Input
          id={id}
          value={value === undefined || value === null ? '' : String(value)}
          aria-invalid={Boolean(error)}
          onChange={(e) => onChange(path, e.target.value)}
        />
      </Wrap>
    )
  }

  return (
    <Wrap>
      <Textarea
        id={id}
        rows={3}
        className="readout text-[12px]"
        value={value === undefined ? '' : JSON.stringify(value)}
        onChange={(e) => {
          try {
            onChange(path, JSON.parse(e.target.value))
          } catch {
            onChange(path, e.target.value)
          }
        }}
      />
      <p className="text-[11px] text-fg-subtle">No dedicated editor for this type yet — enter it as JSON.</p>
    </Wrap>
  )
}

/** A dropdown that knows which engines are unavailable, and why. */
function EnumField({
  id,
  schema,
  label,
  help,
  value,
  error,
  path,
  onChange,
}: {
  id: string
  schema: JsonSchemaNode
  label: string
  help?: string
  value: unknown
  error?: string
  path: string
  onChange(path: string, value: unknown): void
}) {
  const enumSource = (schema as { enumSource?: string }).enumSource
  const options = useEnumOptions(schema.enum, enumSource)
  const selected = options.find((o) => o.value === String(value ?? ''))

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px] font-normal">
        {label}
      </Label>
      {help && <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">{help}</p>}
      <Select value={String(value ?? '')} onValueChange={(v) => onChange(path, v)}>
        {/* Fixed width: dropdowns that size to their content leave the form's
            right edge ragged and hard to scan. */}
        <SelectTrigger id={id} className="w-full max-w-96" aria-invalid={Boolean(error)}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) =>
            o.available ? (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ) : (
              <Tooltip key={o.value}>
                <TooltipTrigger asChild>
                  <div>
                    <SelectItem value={o.value} disabled>
                      {o.label}
                      <span className="ml-2 text-[10px] text-fg-subtle">not available</span>
                    </SelectItem>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">{o.reason ?? 'This engine is not available yet'}</TooltipContent>
              </Tooltip>
            ),
          )}
        </SelectContent>
      </Select>
      {selected && !selected.available && (
        <p className="text-[11.5px] text-led-warn">
          This engine is not available{selected.reason ? ` — ${selected.reason}` : ''}. The device will use a fallback.
        </p>
      )}
      {error && <p className="text-[11.5px] text-led-danger">{error}</p>}
    </div>
  )
}
