'use client'

import { useState } from 'react'
import { Button, ClipboardIcon, CodeIcon, CopyIcon, TrayArrowDownIcon, UploadSimpleIcon } from '@enkaku/ui'
import { useOverlay } from '@/lib/overlays'

/**
 * The four ways a document leaves and enters this editor, behind one icon.
 *
 * They were four labelled buttons — Export, Copy JSON, Import, Paste JSON —
 * taking a third of the toolbar for something an author reaches for once a
 * session. Collapsing them loses nothing: each still has its own row, its own
 * label, and the same handler.
 */
export function JsonMenu({
  disabled,
  onExport,
  onCopy,
  onImport,
  onPaste,
}: {
  disabled: boolean
  onExport: () => void
  onCopy: () => void
  onImport: () => void
  onPaste: () => void
}) {
  const [open, setOpen] = useState(false)
  useOverlay('menu', open, () => setOpen(false))

  const rows: Array<{ label: string; icon: typeof CopyIcon; run: () => void; off?: boolean }> = [
    { label: 'Export to a file', icon: TrayArrowDownIcon, run: onExport, off: disabled },
    { label: 'Copy JSON', icon: CopyIcon, run: onCopy, off: disabled },
    { label: 'Import a file', icon: UploadSimpleIcon, run: onImport },
    { label: 'Paste JSON', icon: ClipboardIcon, run: onPaste },
  ]

  return (
    <div className="relative">
      <Button type="button" variant="ghost" size="icon" active={open} aria-label="Import and export" onClick={() => setOpen((v) => !v)}>
        <CodeIcon className="size-4" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+6px)] z-50 w-[190px] overflow-hidden rounded-card border border-border-2 bg-panel p-1 shadow-panel-2">
          {rows.map((r) => (
            <button
              key={r.label}
              type="button"
              role="menuitem"
              disabled={r.off}
              onClick={() => {
                setOpen(false)
                r.run()
              }}
              className="flex w-full items-center gap-2 rounded-button px-2.5 py-2 text-left text-[12.5px] text-text hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <r.icon className="size-3.5 flex-none text-dim" aria-hidden />
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
