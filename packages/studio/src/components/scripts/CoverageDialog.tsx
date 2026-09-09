'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@enkaku/ui'
import { fetchWorkflowCoverage, type WorkflowCoverageResponse } from '@/lib/api'

/**
 * The rotation report (plan 314 §7.5, §10.3).
 *
 * The client's question, in their own words, is *"jangan sampai ada yang ga
 * kebagian"* — and a warm-up split into three sessions a day cannot answer it
 * from the Jobs screen, because the failure looks like success there: three
 * runs, all green, no red batch, and one phone that opened TikTok twice and
 * Instagram never.
 *
 * So this reads the one thing that records what a run actually DECIDED — the
 * branch its `switch` took — and lists the phones with a gap first. A device
 * with an empty `missing` is proof, not a promise.
 */
export function CoverageDialog({ workflowName, open, onOpenChange }: { workflowName: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = useState<WorkflowCoverageResponse | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'none'>('loading')

  useEffect(() => {
    if (!open) return
    setState('loading')
    void fetchWorkflowCoverage(workflowName)
      .then((res) => {
        setData(res)
        setState(res ? 'ready' : 'none')
      })
      .catch(() => setState('none'))
  }, [open, workflowName])

  const labelOf = (edge: string) => data?.cases.find((c) => c.edge === edge)?.label ?? edge

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rotation coverage</DialogTitle>
          <DialogDescription>
            {state === 'ready' && data
              ? `Which branches each device actually took over its last ${data.window} run${data.window === 1 ? '' : 's'} of ${workflowName}.`
              : `Which branches each device actually took, for ${workflowName}.`}
          </DialogDescription>
        </DialogHeader>

        {state === 'loading' && <p className="text-meta text-faint">Reading the runs…</p>}

        {state === 'none' && (
          <p className="text-meta text-dim">
            This workflow has no switch node, so it expresses no rotation — there is nothing a device could be left out of.
          </p>
        )}

        {state === 'ready' && data && (
          <div className="space-y-3">
            <p className={data.incompleteCount > 0 ? 'text-row text-danger' : 'text-row text-ok'}>
              {data.devices.length === 0
                ? 'No device has run this workflow yet.'
                : data.incompleteCount === 0
                  ? `All ${data.devices.length} device${data.devices.length === 1 ? '' : 's'} covered every branch.`
                  : `${data.incompleteCount} of ${data.devices.length} device${data.devices.length === 1 ? '' : 's'} missed at least one branch.`}
            </p>

            {data.devices.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-meta">
                  <thead>
                    <tr className="border-b border-line text-faint">
                      <th className="py-1 pr-3 text-left font-normal">Device</th>
                      {data.cases.map((c) => (
                        <th key={c.edge} className="px-2 py-1 text-left font-normal">
                          {c.label}
                        </th>
                      ))}
                      <th className="px-2 py-1 text-left font-normal">Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.devices.map((d) => (
                      <tr key={d.deviceId} className="border-b border-line-2">
                        <td className="py-1 pr-3 text-text">{d.deviceLabel}</td>
                        {data.cases.map((c) => (
                          <td key={c.edge} className="px-2 py-1">
                            {d.covered.includes(c.edge) ? (
                              <span className="text-ok" title={`Took ${labelOf(c.edge)}`}>
                                ✓
                              </span>
                            ) : (
                              <span className="text-danger" title={`Never took ${labelOf(c.edge)}`}>
                                —
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="px-2 py-1 text-dim">{d.runs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-caption text-faint">
              Read from the branch each run recorded when it chose, never re-derived from the document. A device that was offline for a session
              shows the run without a branch, which is what makes “3 runs, 2 branches” readable.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
