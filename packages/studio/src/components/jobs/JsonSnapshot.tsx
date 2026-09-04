'use client'

import { useState } from 'react'
import type { ParamIssue, ResultStatus } from '@enkaku/protocol'
import { CaretDownIcon, CaretRightIcon, DotOutlineIcon, EmptyState, cn, fileSize } from '@enkaku/ui'
import { toast } from 'sonner'
import { byteLength } from './job-view'
import { jsonNodes } from './json-nodes'

/**
 * Inputs / Output (design handoff, "Screen: Jobs"): "a JSON snapshot
 * rendered as a node tree, not raw text: header ('Input snapshot' / 'Output
 * snapshot'), size + capture moment ('1.4 KB · captured at start'), and a
 * **Copy JSON** action ... each node indents 16px per depth with a
 * `ph-caret-down` (object/array) or `ph-dot-outline` (leaf), the key in
 * `Geist Mono` `var(--text)`, the value colored by type ... and the type
 * name at the right edge in 10px `var(--faint-2)`."
 */
export function JsonSnapshot({
  title,
  moment,
  value,
  bytes,
  status,
  issues,
}: {
  title: string
  moment: string
  value: unknown
  bytes?: number | null
  status?: ResultStatus | null
  issues?: ParamIssue[] | null
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const empty = value === null || value === undefined

  return (
    <div className="p-[14px]">
      <div className="flex items-center justify-between gap-[10px] pb-[10px]">
        <span className="text-[12px] font-semibold">{title}</span>
        <span className="flex items-center gap-3 text-meta">
          <span className="text-faint">
            {fileSize(bytes ?? byteLength(value))} · {moment}
          </span>
          <button
            type="button"
            className="font-medium text-accent"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(value, null, 2) ?? 'null').then(() => toast.success('Copied'))
            }}
          >
            Copy JSON
          </button>
        </span>
      </div>

      {status === 'invalid' && (
        <div className="mb-[10px] rounded-inner bg-danger-soft px-3 py-2 text-meta text-danger">
          This result did not match its declared schema{issues && issues.length > 0 ? `: ${issues.map((i) => i.path).join(', ')}` : '.'}
        </div>
      )}
      {status === 'partial' && (
        <div className="mb-[10px] rounded-inner bg-warn-soft px-3 py-2 text-meta text-warn">
          This run failed. These are the values it had reached.
        </div>
      )}
      {status === 'oversize' && (
        <div className="mb-[10px] rounded-inner bg-warn-soft px-3 py-2 text-meta text-warn">
          The result was {fileSize(bytes ?? null)}, over the limit. Save large output with ctx.artifact.file instead.
        </div>
      )}

      {empty ? (
        <EmptyState title={`No ${title.toLowerCase()}`} description="This run recorded nothing here." />
      ) : (
        <div className="rounded-inner border border-line-2 bg-panel-2 px-1 pt-[10px] pb-3">
          {jsonNodes(value, collapsed).map((row) => (
            <div key={row.path} className="flex items-center gap-[9px] py-1 pr-3" style={{ paddingLeft: 12 + row.depth * 16 }}>
              {row.collapsible ? (
                <button
                  type="button"
                  className="w-[13px] flex-none text-[11px] text-faint-2"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(row.path)) next.delete(row.path)
                      else next.add(row.path)
                      return next
                    })
                  }
                >
                  {collapsed.has(row.path) ? <CaretRightIcon /> : <CaretDownIcon />}
                </button>
              ) : (
                <DotOutlineIcon className="w-[13px] flex-none text-[11px] text-faint-2" />
              )}
              <span className="flex-none font-mono text-meta text-text">{row.key}</span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-meta',
                  row.type === 'string' && 'text-accent',
                  row.type === 'number' && 'text-warn',
                  row.type === 'boolean' && 'text-warn-2',
                  (row.type === 'null' || row.type === 'object' || row.type === 'array') && 'text-faint',
                )}
              >
                {row.value}
              </span>
              <span className="flex-none text-tip text-faint-2">{row.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
