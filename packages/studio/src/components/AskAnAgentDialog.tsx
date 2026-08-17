'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bot } from 'lucide-react'
import { ListAgentsResponseSchema, RunResponseSchema, ThreadResponseSchema } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Textarea, cn, EmptyState, LoadingRows, api, useAction } from '@enkaku/ui'
import type { Agent } from '@/lib/agents'

/**
 * "Ask an agent" from a device page (plan 73 §3.5, §4.6). Plan 69 gave the
 * device page a read-only badge (who holds it); nothing let an operator
 * actually USE an agent from the place they are already looking at the
 * phone.
 *
 * Opens a NEW thread with `deviceScope: [deviceId]` (plan 73 §4.6's own
 * addition to `POST /api/v1/threads` — every run this thread ever starts is
 * narrowed to that one device via plan 67 §4.2's existing per-run
 * `deviceGrantsOverride`, the same mechanism `agent.spawn` uses). That is a
 * safer default than a general thread, and it is what someone means when
 * they ask from a device page.
 *
 * The picker lists only agents that MAY reach this device (plan 65 §3.5's
 * grants, including the empty-means-all rule) and are enabled — every other
 * one is shown, disabled, with the reason. Offering an agent that would
 * then refuse is the "precondition presented as an error" failure plan 59
 * was written to remove.
 */
export function AskAnAgentDialog({
  deviceId,
  deviceLabel,
  open,
  onOpenChange,
}: {
  deviceId: string
  deviceLabel: string
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const router = useRouter()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const { run, isPending } = useAction()

  useEffect(() => {
    if (!open) return
    setSelected(null)
    setPrompt('')
    setAgents(null)
    void api('/api/agents', ListAgentsResponseSchema)
      .then((b) => setAgents(b.agents))
      .catch(() => setAgents([]))
  }, [open])

  function reachability(a: Agent): { ok: true } | { ok: false; reason: string } {
    if (!a.enabled) return { ok: false, reason: 'This agent is disabled.' }
    if (a.deviceGrants.length > 0 && !a.deviceGrants.includes(deviceId)) {
      return { ok: false, reason: `${a.name} is not granted access to ${deviceLabel}.` }
    }
    return { ok: true }
  }

  const start = () => {
    if (!selected) return
    void run(
      'ask-agent-start',
      () => api('/api/v1/threads', ThreadResponseSchema, { method: 'POST', json: { agentId: selected, deviceScope: [deviceId] } }),
      {
        failure: 'Could not start a conversation',
        onSuccess: (b) => {
          const threadId = b.thread.id
          const done = () => {
            onOpenChange(false)
            router.push(`/agents/detail?id=${selected}&thread=${threadId}`)
          }
          const trimmed = prompt.trim()
          if (trimmed) {
            void api(`/api/v1/threads/${threadId}/messages`, RunResponseSchema, { method: 'POST', json: { text: trimmed } })
              .catch(() => undefined) // The thread exists either way — the composer is right there to retry a send that failed.
              .finally(done)
          } else {
            done()
          }
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ask an agent about {deviceLabel}</DialogTitle>
          <DialogDescription>
            Opens a new conversation scoped to this device — the agent it starts can touch {deviceLabel} and no other phone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {agents === null ? (
            <LoadingRows rows={3} />
          ) : agents.length === 0 ? (
            <EmptyState icon={<Bot className="size-4" aria-hidden />} title="No agents yet" description="Create one from the Agents page first." />
          ) : (
            <div role="listbox" aria-label="Agents" className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1">
              {agents.map((a) => {
                const r = reachability(a)
                return (
                  <div key={a.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected === a.id}
                      disabled={!r.ok}
                      // A plain `title` (not a Radix Tooltip needing a `TooltipProvider` ancestor
                      // this dialog does not control) plus the always-visible line below —
                      // discoverable without hovering, same reasoning as the composer's own
                      // model/effort caption (plan 73 §4.2).
                      title={r.ok ? undefined : r.reason}
                      onClick={() => setSelected(a.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors',
                        !r.ok ? 'cursor-not-allowed opacity-50' : selected === a.id ? 'bg-accent/10' : 'hover:bg-surface-2',
                      )}
                    >
                      <Bot className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    </button>
                    {!r.ok && <p className="px-2.5 pb-1 text-[10.5px] text-fg-subtle">{r.reason}</p>}
                  </div>
                )
              })}
            </div>
          )}

          <div className="space-y-1.5">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`What should it check on ${deviceLabel}? (optional — you can also just start typing after)`}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!selected || isPending('ask-agent-start')} onClick={() => void start()}>
              {isPending('ask-agent-start') ? 'Starting…' : 'Start conversation'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
