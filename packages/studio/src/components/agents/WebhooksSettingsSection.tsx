'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { WebhookEndpointSchema, WebhooksResponseSchema, type WebhookEndpoint } from '@enkaku/protocol'
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
  PlusIcon,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  relativeTime,
  useAction,
} from '@enkaku/ui'

const WebhookEndpointResponseSchema = z.object({ endpoint: WebhookEndpointSchema })

/**
 * Farm-level webhook endpoints (plan 68 §3.4, §4.1, §4.5) — relocated
 * verbatim from `app/settings/page.tsx`'s `WebhooksSection` (plan 212 §4.7).
 * `notify.send` chooses among these by NAME, never a raw URL, which is what
 * keeps a webhook from leaking farm information to an arbitrary address
 * (§8's risk table). The secret is write-only, same rule
 * `ConnectorsSettingsSection` already follows for a credential.
 * `lastStatus`/`failureCount` make a dead endpoint visible here rather than
 * only in a log (criterion 11).
 */
export function WebhooksSettingsSection() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const { run, isPending } = useAction()

  const load = () => {
    setError(null)
    api('/api/webhooks', WebhooksResponseSchema)
      .then((b) => setEndpoints(b.endpoints))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const create = () =>
    run('create', () => api('/api/webhooks', WebhookEndpointResponseSchema, { method: 'POST', json: { name, url, secret: secret || undefined } }), {
      success: `${name} added`,
      failure: 'Could not add the webhook endpoint',
      onSuccess: () => {
        setOpen(false)
        setName('')
        setUrl('')
        setSecret('')
        load()
      },
    })

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-[12.5px] leading-relaxed text-fg-muted">
          A POST to this URL, signed with HMAC-SHA256 over the body plus a timestamp (the{' '}
          <span className="readout">X-Enkaku-Signature</span> header), so a receiver can verify who sent it. An agent's{' '}
          <span className="readout">notify.send</span> names one of these by name — it never sees or chooses a raw URL.
          Delivered three times with backoff before it is recorded as failed; the in-app notification is written first,
          regardless.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setName('')
            setUrl('')
            setSecret('')
            setOpen(true)
          }}
        >
          <PlusIcon className="size-3.5" aria-hidden />
          Add webhook
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : endpoints === null ? (
        <LoadingRows rows={3} />
      ) : endpoints.length === 0 ? (
        <EmptyState title="No webhooks yet" description="Add one so a scheduled agent's notify.send can reach Slack, Discord, PagerDuty, or anything else." />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">
                    {w.name}
                    {!w.enabled && <Badge variant="outline" className="ml-1.5">disabled</Badge>}
                  </TableCell>
                  <TableCell className="readout max-w-xs truncate text-[12px] text-fg-muted">{w.url}</TableCell>
                  <TableCell>
                    {w.lastStatus === null ? (
                      <span className="text-[12px] text-fg-subtle">never delivered</span>
                    ) : w.failureCount > 0 ? (
                      <Badge variant="destructive">unhealthy · {w.failureCount} failure{w.failureCount === 1 ? '' : 's'}</Badge>
                    ) : (
                      <Badge variant="secondary">ok</Badge>
                    )}
                    {w.lastAttemptAt && (
                      <p className="readout mt-0.5 text-[11px] text-fg-subtle">last attempt {relativeTime(w.lastAttemptAt)}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[12px]"
                        disabled={isPending('toggle-' + w.id)}
                        onClick={() =>
                          run('toggle-' + w.id, () => api(`/api/webhooks/${w.id}`, WebhookEndpointResponseSchema, { method: 'PATCH', json: { enabled: !w.enabled } }), {
                            success: w.enabled ? `${w.name} disabled` : `${w.name} enabled`,
                            failure: 'Could not update the webhook endpoint',
                            onSuccess: load,
                          })
                        }
                      >
                        {w.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="sm" className="h-7 text-[12px]">
                            Remove
                          </Button>
                        }
                        title={`Remove ${w.name}?`}
                        description="An agent naming this endpoint will fail to deliver to it — the in-app notification is unaffected."
                        onConfirm={() =>
                          run('del-' + w.id, () => api(`/api/webhooks/${w.id}`, z.void(), { method: 'DELETE' }), {
                            success: `${w.name} removed`,
                            failure: 'Could not remove the webhook endpoint',
                            onSuccess: load,
                          })
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add webhook</DialogTitle>
            <DialogDescription>The secret is write-only — it is never shown again after this.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="wh-name" className="text-[13px] font-normal">
                Name
              </Label>
              <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="on-call-slack" />
              <p className="text-[11.5px] text-fg-subtle">What an agent's notify.send names in its channels list.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-url" className="text-[13px] font-normal">
                URL
              </Label>
              <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wh-secret" className="text-[13px] font-normal">
                Signing secret
              </Label>
              <Input id="wh-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="optional, but recommended" />
              <p className="text-[11.5px] text-fg-subtle">Used to sign every delivery — leave blank to send unsigned.</p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!name || !url || isPending('create')} onClick={() => void create()}>
                {isPending('create') ? 'Adding…' : 'Add webhook'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
