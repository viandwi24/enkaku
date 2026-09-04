'use client'

import { useEffect, useState } from 'react'
import { GroupResponseSchema, type GroupInfo } from '@enkaku/protocol'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Textarea, api, useAction } from '@enkaku/ui'

export interface GroupRow extends GroupInfo {}

/**
 * Create and edit a group's own identity (plan 22.0 §4.5, renamed by plan
 * 207 — MVP 15 §0.1 item 3): a name and an optional description, nothing
 * else. A group is a container now — its members are put in and taken out
 * through `GroupMembersDialog`, not declared here as tags or a device list.
 */
export function GroupEditorDialog({
  group,
  onClose,
  onSaved,
}: {
  group: GroupRow | 'new' | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const { run, isPending } = useAction()

  const isNew = group === 'new'
  const open = group !== null

  useEffect(() => {
    if (group === 'new') {
      setName('')
      setDescription('')
    } else if (group) {
      setName(group.name)
      setDescription(group.description ?? '')
    }
  }, [group])

  if (!open) return null

  const save = () =>
    run(
      'save',
      () =>
        group === 'new'
          ? api('/api/groups', GroupResponseSchema, {
              method: 'POST',
              json: { name, description: description || null },
            })
          : api(`/api/groups/${group.id}`, GroupResponseSchema, {
              method: 'PATCH',
              json: { name, description: description || null },
            }),
      {
        success: isNew ? 'Group created' : 'Group saved',
        failure: 'Could not save the group',
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
          <DialogTitle>{group === 'new' ? 'New group' : `Edit ${group.name}`}</DialogTitle>
          <DialogDescription>
            A group is a container — a region, a rack, a customer. Add and remove devices from its members panel.
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
              placeholder="What this group is for"
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
            {isPending('save') ? 'Saving…' : isNew ? 'Create group' : 'Save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
