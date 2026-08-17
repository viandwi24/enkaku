'use client'

import { useEffect, useState } from 'react'
import { ClusterResponseSchema, type ClusterInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Textarea, api, useAction } from '@enkaku/ui'

export interface ClusterRow extends ClusterInfo {}

/**
 * Create and edit a cluster's own identity (plan 22.0 §4.5): a name and an
 * optional description, nothing else. A cluster is a container now — its
 * members are put in and taken out through `ClusterMembersDialog`, not
 * declared here as tags or a device list.
 */
export function ClusterEditorDialog({
  cluster,
  onClose,
  onSaved,
}: {
  cluster: ClusterRow | 'new' | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const { run, isPending } = useAction()

  const isNew = cluster === 'new'
  const open = cluster !== null

  useEffect(() => {
    if (cluster === 'new') {
      setName('')
      setDescription('')
    } else if (cluster) {
      setName(cluster.name)
      setDescription(cluster.description ?? '')
    }
  }, [cluster])

  if (!open) return null

  const save = () =>
    run(
      'save',
      () =>
        cluster === 'new'
          ? api('/api/clusters', ClusterResponseSchema, {
              method: 'POST',
              json: { name, description: description || null },
            })
          : api(`/api/clusters/${cluster.id}`, ClusterResponseSchema, {
              method: 'PATCH',
              json: { name, description: description || null },
            }),
      {
        success: isNew ? 'Cluster created' : 'Cluster saved',
        failure: 'Could not save the cluster',
        onSuccess: () => {
          onSaved()
          onClose()
        },
      },
    )

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cluster === 'new' ? 'New cluster' : `Edit ${cluster.name}`}</DialogTitle>
          <DialogDescription>
            A cluster is a container — a region, a rack, a customer. Add and remove devices from its members panel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jakarta" className="h-8 text-[12.5px]" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px] font-normal">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this cluster is for"
              className="text-[12.5px]"
              rows={2}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || isPending('save')}>
            {isPending('save') ? 'Saving…' : isNew ? 'Create cluster' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
