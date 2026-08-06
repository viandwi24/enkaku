'use client'

import { useState } from 'react'
import { ChevronRight, EyeOff, ImageOff } from 'lucide-react'
import type { ToolResultContent } from '@enkaku/protocol'
import { blobUrl, extractDeviceIdForDisplay, findImageBlock, textOfToolResult, wireNameToCapabilityId } from '@/lib/agent-chat'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  /** The wire tool name OR the real capability id — either is accepted; the wire form is reversed for display. */
  name: string
  input: unknown
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  /** The `tool_result`'s own content blocks, once known (plan 70 §3.2) — text and/or one or more images, NEVER a bare string. */
  resultContent?: ToolResultContent[] | null
  /** A device label to show next to the id, resolved by the caller (this component never fetches). */
  deviceLabel?: string | null
  /**
   * Plan 70 §3.7 — false when this result's image has been dropped from the agent's CURRENT
   * provider view (§3.6's per-request window): the model can no longer see it, so an operator
   * reading an answer that follows must not assume it still can. Default (undefined/true) means
   * "still in context" — the ordinary case for most of a run's life.
   */
  inContext?: boolean
}

/**
 * The hookless half of `ToolCallCard` (`expanded` is a plain prop, not
 * `useState`) — the same split `DeviceHeader` uses ("no hooks of its own:
 * every value is a prop"), which is what makes it callable directly in a
 * test with no DOM renderer (this workspace has none — see
 * `TileChips.test.tsx`). Covers plan 69 §7's "`ToolCallCard` for each
 * outcome shape": running, ok, error, and the screenshot special case.
 */
export function ToolCallCardView({ name, input, status, durationMs, resultContent, deviceLabel, inContext, expanded, onToggle }: ToolCallCardProps & { expanded: boolean; onToggle: () => void }) {
  const capabilityId = name.includes('.') ? name : wireNameToCapabilityId(name)
  const deviceId = deviceLabel ?? extractDeviceIdForDisplay(input)
  const image = status === 'ok' && resultContent ? findImageBlock(resultContent) : null
  const text = resultContent ? textOfToolResult(resultContent) : null

  return (
    <div className={cn('rounded-md border text-[12px]', status === 'error' ? 'border-led-danger/40 bg-led-danger/5' : 'bg-surface')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left" aria-expanded={expanded}>
        <ChevronRight className={cn('size-3 shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-90')} aria-hidden />
        <span className="readout truncate font-medium text-fg">{capabilityId}</span>
        {deviceId && <span className="readout shrink-0 truncate text-fg-subtle">{deviceId}</span>}
        <span className="flex-1" />
        {status === 'running' ? (
          <span className="shrink-0 text-fg-subtle">running…</span>
        ) : (
          <Badge variant={status === 'ok' ? 'secondary' : 'destructive'} className="shrink-0">
            {status}
            {durationMs !== undefined ? ` · ${durationMs}ms` : ''}
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <div>
            <p className="mb-1 text-[10.5px] uppercase tracking-wide text-fg-subtle">input</p>
            {/* Full width, never truncated — the same rule the approval inbox holds itself to
                (§3.3): a long input scrolls, it does not elide. */}
            <pre className="readout max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1.5 text-[11px] text-fg">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>

          {image ? (
            <div className="space-y-1">
              {/* A same-origin, cached-by-hash resource (plan 70 §3.4) — no data URI, never re-fetched for an unchanged screen. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a core-served blob URL, never a same-origin asset next/image could optimise */}
              <img src={blobUrl(image.blobId)} alt={`Screenshot from ${deviceId ?? 'the device'}`} className="max-h-96 w-auto rounded border" />
              {inContext === false && (
                <p className="flex items-center gap-1.5 text-fg-subtle">
                  <EyeOff className="size-3.5" aria-hidden />
                  Dropped from the agent&apos;s current context — it can no longer see this screen.
                </p>
              )}
            </div>
          ) : status === 'ok' && capabilityId === 'device.screenshot' ? (
            <p className="flex items-center gap-1.5 text-fg-subtle">
              <ImageOff className="size-3.5" aria-hidden />
              Screenshot data could not be read.
            </p>
          ) : text ? (
            <div>
              <p className="mb-1 text-[10.5px] uppercase tracking-wide text-fg-subtle">result</p>
              <pre className={cn('readout max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1.5 text-[11px]', status === 'error' && 'text-led-danger')}>{text}</pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * A tool call as its own card (plan 69 §3.2, step 69.2) — the interesting
 * part of an agent transcript, not a footnote. Collapsed by default,
 * expanded on click, and expanded automatically on failure: a failure
 * nobody expanded is a failure nobody read.
 *
 * `device.screenshot` renders its image inline (criterion 5) from its blob
 * URL (plan 70 §3.7) — the picture IS the point of the call, and a JSON
 * blob is not that.
 */
export function ToolCallCard(props: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(props.status === 'error')
  return <ToolCallCardView {...props} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
}
