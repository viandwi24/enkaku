'use client'

import { useState } from 'react'
import { cn } from '@enkaku/ui'
import type { GenericActionId } from '@/lib/generic-actions'
import { DeviceJobs } from './DeviceJobs'
import { DeviceFiles } from './DeviceFiles'

/**
 * The Device tab (design handoff README.md:279-280; plan 215 §4.12): "a
 * generic container tab, not one tab per feature." A chip switch selects
 * Jobs or Files; a third section touches only this file.
 */
export function DeviceTab({ deviceId, onAction, nodeOwned }: { deviceId: string; onAction: (id: GenericActionId, params?: Record<string, unknown>) => void; nodeOwned: boolean }) {
  const [section, setSection] = useState<'jobs' | 'files'>('jobs')

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex gap-1">
        <Chip active={section === 'jobs'} onClick={() => setSection('jobs')}>
          Jobs
        </Chip>
        <Chip active={section === 'files'} onClick={() => setSection('files')}>
          Files
        </Chip>
      </div>
      {section === 'jobs' ? <DeviceJobs deviceId={deviceId} /> : <DeviceFiles deviceId={deviceId} onAction={onAction} nodeOwned={nodeOwned} />}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-chip px-[10px] py-1 text-[12px]',
        active ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-muted',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
