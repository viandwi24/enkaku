'use client'

import { useState } from 'react'
import { cn } from '@enkaku/ui'
import type { ActionDialogVerb } from '@/components/actions/ActionDialogHost'
import { DeviceJobs } from './DeviceJobs'
import { DeviceFiles } from './DeviceFiles'
import { NetworkPanel } from '@/components/guest-agent/NetworkPanel'
import { TouchCapture } from './TouchCapture'

/**
 * The Device tab (design handoff README.md:279-280; plan 215 §4.12): "a
 * generic container tab, not one tab per feature." A chip switch selects
 * Jobs, Files, or Network.
 *
 * Network moved in here (owner report, 2026-09-13): the top-level tab row
 * (`DeviceControl.tsx`) held four entries — Actions, Inspector, Device,
 * Network — and clipped the last one at the popup's narrower widths. Network
 * is exactly the kind of section this tab already exists for, so it joins
 * Jobs/Files as a third chip rather than growing a fifth mechanism (a
 * scrolling tab row, an overflow menu) the design has no precedent for.
 * `NetworkPanel` renders its own padding (`@container` + `py-4`), so it sits
 * outside the chip row's `p-3` wrapper to avoid doubling it.
 *
 * Touch (plan 1000) joined for the same reason Network did: it is a section,
 * not a fifth top-level tab the 274px column cannot hold.
 */
export function DeviceTab({ deviceId, onAction, nodeOwned }: { deviceId: string; onAction: (id: ActionDialogVerb, params?: Record<string, unknown>) => void; nodeOwned: boolean }) {
  const [section, setSection] = useState<'jobs' | 'files' | 'network' | 'touch'>('jobs')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 p-3 pb-0">
        <Chip active={section === 'jobs'} onClick={() => setSection('jobs')}>
          Jobs
        </Chip>
        <Chip active={section === 'files'} onClick={() => setSection('files')}>
          Files
        </Chip>
        <Chip active={section === 'network'} onClick={() => setSection('network')}>
          Network
        </Chip>
        <Chip active={section === 'touch'} onClick={() => setSection('touch')}>
          Touch
        </Chip>
      </div>
      {section === 'jobs' && (
        <div className="p-3 pt-0">
          <DeviceJobs deviceId={deviceId} />
        </div>
      )}
      {section === 'files' && (
        <div className="p-3 pt-0">
          <DeviceFiles deviceId={deviceId} onAction={onAction} nodeOwned={nodeOwned} />
        </div>
      )}
      {section === 'network' && (
        // `canUse` is a convenience only — the server checks the control
        // activity on every network request regardless (NetworkPanel's own
        // note). This window IS the control surface, so it passes true
        // rather than inventing a second gate.
        <NetworkPanel deviceId={deviceId} canUse />
      )}
      {/*
        Mounted only while its chip is selected, which is exactly the
        attach/detach lifecycle the panel wants (plan 1000 §4.8): selecting
        it opens the `getevent` stream, leaving closes it, and no phone
        carries one for a tab nobody is looking at.
      */}
      {section === 'touch' && (
        <div className="p-3 pt-0">
          <TouchCapture deviceId={deviceId} nodeOwned={nodeOwned} />
        </div>
      )}
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
