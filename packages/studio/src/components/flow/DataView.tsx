'use client'

import { CaretDownIcon, CaretRightIcon, ImageIcon, cn } from '@enkaku/ui'
import { useState } from 'react'

/**
 * Type-directed rendering for the OUTPUT pane (plan 306 §3.4) — a device
 * farm's node outputs are screenshots, UI trees and coordinates, and a 2 MB
 * screenshot rendered as a base64 string in a JSON pane is hiding the data,
 * not showing it. There is no established schema convention in this
 * codebase for "this field is an image" or "this field is a UI tree" (a
 * `NodeType.resultSchema` is a generic, permissive JSON Schema record,
 * `packages/protocol/src/api/json-schema.ts`) — this renders by VALUE SHAPE
 * instead: a heuristic, named as one, not a schema-driven dispatch (recorded
 * as a discrepancy against plan 306 §3.4's own wording in the handoff
 * report).
 *
 * The output pane is READ-ONLY (plan 306 §2's own non-goal table: "A JSON
 * editor for arbitrary node output — never"), so unlike `DataTree` nothing
 * here is clickable — this is a VIEWER, not a picker.
 */

const IMAGE_KEYS = ['screenshot', 'image', 'png', 'frame', 'dataUrl', 'base64Image']
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/

function isDataUrl(v: unknown): v is string {
  return typeof v === 'string' && DATA_URL_RE.test(v)
}

/** A string that is plausibly raw base64 PNG/JPEG bytes with no `data:` prefix — long, base64-alphabet only. */
function looksLikeBareBase64Image(v: unknown): v is string {
  return typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v)
}

function findImageSrc(value: unknown): string | null {
  if (isDataUrl(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of IMAGE_KEYS) {
      const candidate = (value as Record<string, unknown>)[key]
      if (isDataUrl(candidate)) return candidate
      if (looksLikeBareBase64Image(candidate)) return `data:image/png;base64,${candidate}`
    }
  }
  return null
}

interface UiTreeNode {
  class?: string
  text?: string
  bounds?: unknown
  children?: UiTreeNode[]
}

function isUiTreeNode(v: unknown): v is UiTreeNode {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  const hasShape = 'class' in o || 'bounds' in o || 'children' in o
  const childrenOk = !('children' in o) || Array.isArray(o.children)
  return hasShape && childrenOk
}

function findUiTreeRoot(value: unknown): UiTreeNode | null {
  if (isUiTreeNode(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const root = (value as Record<string, unknown>).root ?? (value as Record<string, unknown>).tree
    if (isUiTreeNode(root)) return root
  }
  return null
}

function UiTreeRow({ node, depth }: { node: UiTreeNode; depth: number }) {
  const [collapsed, setCollapsed] = useState(false)
  const children = node.children ?? []
  return (
    <div>
      <div style={{ paddingLeft: `${depth * 14}px` }} className="flex items-center gap-1 py-0.5 font-mono text-[11.5px]">
        {children.length > 0 ? (
          <button type="button" onClick={() => setCollapsed((v) => !v)} className="shrink-0 text-fg-subtle hover:text-fg" aria-label={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? <CaretRightIcon className="size-3" aria-hidden /> : <CaretDownIcon className="size-3" aria-hidden />}
          </button>
        ) : (
          <span className="inline-block w-3" />
        )}
        <span className="text-accent">{node.class ?? 'node'}</span>
        {node.text ? <span className="truncate text-led-ok">“{node.text}”</span> : null}
        {node.bounds !== undefined ? <span className="truncate text-fg-subtle">{JSON.stringify(node.bounds)}</span> : null}
      </div>
      {!collapsed && children.map((c, i) => <UiTreeRow key={i} node={c} depth={depth + 1} />)}
    </div>
  )
}

export function DataView({ value }: { value: unknown }) {
  if (value === undefined || value === null) {
    return <p className="px-2 py-3 text-[11.5px] text-fg-subtle">No data</p>
  }

  const imageSrc = findImageSrc(value)
  if (imageSrc) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <ImageIcon className="size-3.5" aria-hidden />
          image
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, never a remote fetch */}
        <img src={imageSrc} alt="Node output" className="max-h-64 w-auto rounded border" />
      </div>
    )
  }

  const uiTreeRoot = findUiTreeRoot(value)
  if (uiTreeRoot) {
    return (
      <div className="max-h-80 overflow-y-auto">
        <UiTreeRow node={uiTreeRoot} depth={0} />
      </div>
    )
  }

  return (
    <pre className={cn('max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border bg-panel-2 p-2 font-mono text-[11px] text-fg')}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}
