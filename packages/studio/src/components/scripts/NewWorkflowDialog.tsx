'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { WorkflowDoc } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from '@enkaku/ui'
import { saveWorkflow, WorkflowPublishError } from '@/lib/api'

/**
 * Naming a workflow, once, at creation (owner decision, 2026-09-05).
 *
 * The editor used to open on a blank document with an empty `name` field and
 * a red bar quoting the name grammar before the author had typed anything —
 * a rule taught by rejection. And it asked for a `name` AND a `title`, which
 * the owner rightly called confusing: "kenapa ada nama dan judul kenapa ga
 * jadi satu aja".
 *
 * They are one field here, and the answer to why both exist in the document
 * is that only one of them is an identity. `name` goes in the URL, in the
 * API path, and in every schedule that points at this workflow (spec §4.7),
 * so changing it later can break a running schedule. `title` is display text
 * and free to change. So the author writes the title, this dialog derives
 * the identity from it, and the editor shows that identity read-only
 * afterwards. Nobody is asked to invent a slug, and nobody can silently
 * rename an identity that other rows depend on.
 */

/** The `name` grammar, from `WorkflowNameSchema`: lowercase letters, digits, `.`, `_`, `-`, starting on a letter or digit. */
export function slugifyWorkflowName(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64)
}

function docFor(name: string, title: string): WorkflowDoc {
  return {
    schema: 2,
    name,
    title,
    description: '',
    params: [],
    entry: 'start',
    nodes: [{ kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 } }],
    maxSteps: 50,
  }
}

export function NewWorkflowDialog({ trigger }: { trigger: ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = useMemo(() => slugifyWorkflowName(title), [title])

  async function create(): Promise<void> {
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await saveWorkflow(docFor(name, title.trim()), 'create')
      setOpen(false)
      setTitle('')
      // Straight into the editor, in update mode — the workflow exists now,
      // so Save from here on is an update and the identity is settled.
      router.push(`/scripts/editor?name=${encodeURIComponent(name)}`)
    } catch (e) {
      const message =
        e instanceof WorkflowPublishError && e.findings.length > 0 ? e.findings.map((f) => f.message).join('; ') : e instanceof Error ? e.message : String(e)
      setError(message)
      toast.error('Could not create the workflow')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setTitle('')
          setError(null)
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>Name it now — the editor opens as soon as it exists.</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="new-workflow-title" className="text-[11.5px] font-normal text-fg-muted">
            Name
          </Label>
          <Input
            id="new-workflow-title"
            autoFocus
            value={title}
            placeholder="TikTok search pipeline"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name && !busy) void create()
            }}
          />
          {name ? (
            <p className="text-[11.5px] text-fg-subtle">
              Saved as <span className="readout text-fg-muted">{name}</span> — this is the identity schedules point at, and it does not change later.
            </p>
          ) : (
            <p className="text-[11.5px] text-fg-subtle">Letters and digits, please — the identity is derived from what you type.</p>
          )}
          {error && <p className="text-[11.5px] text-led-danger">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!name || busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
