'use client'

import { useState } from 'react'
import { CaretDownIcon, CaretRightIcon, DotOutlineIcon, cn } from '@enkaku/ui'
import { formatNodeValue, type JsonNodeType } from '@/components/jobs/json-nodes'

/**
 * The clickable value tree (plan 306 §3.3, §4.2) — the input pane's own
 * control, and the reason a data-flow editor reads as one: every leaf is
 * clickable, and a click inserts a REFERENCE to that leaf, never the value
 * itself. Row formatting (`formatNodeValue`, the quoted-string / "N items" /
 * type-coloured value convention) is reused from `components/jobs/json-nodes.ts`
 * — the same convention the Jobs screen's own Inputs/Output panes already
 * draw (design handoff, "Screen: Jobs") — rather than invented a second time.
 *
 * What `json-nodes.ts` does NOT carry is the ORIGINAL key segments needed to
 * build a reference (its `path` field is a display string, unsafe to split
 * back apart — an Android `resource-id` can itself contain a literal `.`).
 * So this file walks the value itself, carrying a `segments` array per row
 * alongside the same depth-first shape `jsonNodes` produces.
 */

export type DataTreeSegment = { key: string; index: false } | { key: number; index: true }

interface DataTreeRow {
  path: string
  depth: number
  key: string
  segments: readonly DataTreeSegment[]
  display: string
  type: JsonNodeType
  collapsible: boolean
}

const MAX_ROWS = 2000

function walk(value: unknown, depth: number, key: string, path: string, segments: DataTreeSegment[], collapsed: ReadonlySet<string>, rows: DataTreeRow[]): boolean {
  if (rows.length >= MAX_ROWS) return false
  const { value: display, type } = formatNodeValue(value)
  const isContainer = type === 'object' || type === 'array'
  rows.push({ path, depth, key, segments, display, type, collapsible: isContainer })
  if (!isContainer || collapsed.has(path)) return true

  if (type === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!walk(value[i], depth + 1, String(i), `${path}[${i}]`, [...segments, { key: i, index: true }], collapsed, rows)) return false
    }
  } else if (type === 'object' && value && typeof value === 'object') {
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      if (!walk(child, depth + 1, k, path ? `${path}.${k}` : k, [...segments, { key: k, index: false }], collapsed, rows)) return false
    }
  }
  return true
}

function dataTreeRows(value: unknown, collapsed: ReadonlySet<string>): DataTreeRow[] {
  const rows: DataTreeRow[] = []
  walk(value, 0, '', '', [], collapsed, rows)
  return rows
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Plan 306 §9 Q5 — a string-literal bracket index is refused at parse time
 * by `@enkaku/expr` (`get(obj, "a.b.c")` is the closed-table substitute for
 * exactly that case, per the parser's own doc comment). So: an identifier
 * key segment reads as native `.key` (or `[i]` for an array index); the
 * moment ANY segment on the path is not a bare identifier, the WHOLE
 * reference is built with `get(root, "dotted.path")` instead — one rule,
 * not a per-segment mix.
 */
export function refFor(root: '$input' | `$nodes.${string}`, segments: readonly DataTreeSegment[]): string {
  if (segments.length === 0) return root
  const allIdentifiers = segments.every((s) => s.index || IDENT_RE.test(s.key))
  if (allIdentifiers) {
    return root + segments.map((s) => (s.index ? `[${s.key}]` : `.${s.key}`)).join('')
  }
  const dotted = segments.map((s) => String(s.key)).join('.')
  return `get(${root}, ${JSON.stringify(dotted)})`
}

const TYPE_COLOR: Record<JsonNodeType, string> = {
  string: 'text-led-ok',
  number: 'text-accent',
  boolean: 'text-led-warn',
  null: 'text-fg-subtle',
  object: 'text-fg-muted',
  array: 'text-fg-muted',
}

export function DataTree({
  value,
  root,
  onInsert,
  emptyLabel = 'No data',
}: {
  value: unknown
  /** Which root this tree's leaves belong to — `$input` for the input pane, `$nodes.<id>` for a browsed earlier node's output. */
  root: '$input' | `$nodes.${string}`
  /**
   * Fired when a leaf — or a container, which inserts a reference to the
   * WHOLE value — is clicked: the built reference (`$input.foo`,
   * `get($input, "foo-bar")`, …) plus the raw segments, so the caller can
   * build a `{ from, path }` binding instead when the focused field is in
   * that form (plan 306 §3.3's second paragraph — the picker does not
   * silently convert a legacy binding into an expression). `undefined`
   * renders the tree read-only (no hover affordance, no click handler).
   */
  onInsert?: (ref: string, segments: readonly DataTreeSegment[]) => void
  emptyLabel?: string
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const rows = dataTreeRows(value, collapsed)

  if (rows.length === 0 || (rows.length === 1 && rows[0]?.type === 'null' && value === undefined)) {
    return <p className="px-2 py-3 text-[11.5px] text-fg-subtle">{emptyLabel}</p>
  }

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="space-y-px overflow-x-auto font-mono text-[11.5px]" role="tree">
      {rows.map((row) => {
        const ref = refFor(root, row.segments)
        return (
          <div
            key={row.path || '$root'}
            role="treeitem"
            style={{ paddingLeft: `${row.depth * 14}px` }}
            className={cn('flex items-center gap-1 rounded px-1 py-0.5', onInsert && 'cursor-pointer hover:bg-panel-2')}
            onClick={onInsert ? () => onInsert(ref, row.segments) : undefined}
            title={onInsert ? `Insert ${ref}` : ref}
          >
            {row.collapsible ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(row.path)
                }}
                className="shrink-0 text-fg-subtle hover:text-fg"
                aria-label={collapsed.has(row.path) ? 'Expand' : 'Collapse'}
              >
                {collapsed.has(row.path) ? <CaretRightIcon className="size-3" aria-hidden /> : <CaretDownIcon className="size-3" aria-hidden />}
              </button>
            ) : (
              <DotOutlineIcon className="size-3 shrink-0 text-fg-subtle" aria-hidden />
            )}
            <span className="shrink-0 text-fg-muted">{row.key || '(root)'}</span>
            {row.display !== '' && <span className={cn('min-w-0 truncate', TYPE_COLOR[row.type])}>{row.display}</span>}
          </div>
        )
      })}
    </div>
  )
}
