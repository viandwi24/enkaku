'use client'

import { Plus, X } from 'lucide-react'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@enkaku/ui'
import type { FieldPlan } from '../plan'
import { emptyRow } from './empty'
import { renderControl } from './index'
import { FieldRow } from './shell'
import type { BaseControlProps } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * An array of objects — a real row editor, one planned control per column
 * (F18: this used to be `String(item ?? '')`, i.e. `[object Object]`, and
 * editing it destroyed the row). Each cell is rendered `bare` — the column
 * header already carries the label, so a cell showing its own label row too
 * would repeat it once per row for no benefit.
 */
export function TableControl({
  id,
  path,
  label,
  help,
  error,
  value,
  onChange,
  plan,
  bare,
}: BaseControlProps & { plan: Extract<FieldPlan, { control: 'table' }> }) {
  const rows = Array.isArray(value) ? value : []
  const readout = `${rows.length} row${rows.length === 1 ? '' : 's'}`

  const setCell = (rowIndex: number, key: string, cellValue: unknown) => {
    onChange(
      path,
      rows.map((row, j) => (j === rowIndex ? { ...(isRecord(row) ? row : {}), [key]: cellValue } : row)),
    )
  }

  const body = (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {plan.columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i}>
                {plan.columns.map((c) => (
                  <TableCell key={c.key}>
                    {renderControl(c.plan, {
                      id: `${id}-${i}-${c.key}`,
                      path: `${path}[${i}].${c.key}`,
                      label: c.label,
                      value: isRecord(row) ? row[c.key] : undefined,
                      bare: true,
                      onChange: (_p, next) => setCell(i, c.key, next),
                    })}
                  </TableCell>
                ))}
                <TableCell>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${i + 1}`} onClick={() => onChange(path, rows.filter((_, j) => j !== i))}>
                    <X className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(path, [...rows, emptyRow(plan.columns)])}>
        <Plus className="size-3.5" /> Add row
      </Button>
    </div>
  )

  if (bare) return body
  return (
    <FieldRow id={id} label={label} help={help} error={error} readout={readout}>
      {body}
    </FieldRow>
  )
}
