'use client'

import { useCallback, useEffect, useState } from 'react'
import { DeviceUpdatesResponseSchema, type DeviceUpdateRow, type DeviceUpdatesResponse } from '@enkaku/protocol'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingRows,
  api,
} from '@enkaku/ui'

/** While an update runs the list is read this often; otherwise only often enough to show the button. */
const ACTIVE_POLL_MS = 2_000
const IDLE_POLL_MS = 60_000

/**
 * Devices → Update devices (0.2.74). Preparation installs what a phone lacks on its own, but no
 * longer REPLACES a build already there — so after a core upgrade the phones keep the build they
 * had, and this is where an operator replaces it, one phone or all of them, a few at a time.
 */
export function useDeviceUpdates(dialogOpen: boolean) {
  const [data, setData] = useState<DeviceUpdatesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api('/api/device-updates', DeviceUpdatesResponseSchema))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const busy = (data?.running ?? 0) + (data?.queued ?? 0) > 0
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), dialogOpen || busy ? ACTIVE_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(t)
  }, [load, dialogOpen, busy])

  const start = useCallback(
    async (deviceIds?: string[]) => {
      try {
        setData(await api('/api/device-updates', DeviceUpdatesResponseSchema, { json: deviceIds ? { deviceIds } : {} }))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [],
  )

  /** Devices with something still to update — what the toolbar button counts. */
  const outstanding = data?.devices.filter((d) => d.state !== 'done' && d.components.length > 0).length ?? 0
  return { data, error, load, start, outstanding, busy }
}

function StateBadge({ row }: { row: DeviceUpdateRow }) {
  switch (row.state) {
    case 'running':
      return <Badge>Updating</Badge>
    case 'queued':
      return <Badge variant="secondary">Queued</Badge>
    case 'done':
      return <Badge variant="outline">Updated</Badge>
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>
    case 'idle':
      return null
  }
}

export function DeviceUpdatesDialog({
  open,
  onOpenChange,
  updates,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  updates: ReturnType<typeof useDeviceUpdates>
}) {
  const { data, error, load, start } = updates
  const idle = data?.devices.filter((d) => d.state === 'idle' || d.state === 'failed') ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Update devices</DialogTitle>
          <DialogDescription>
            These phones run an older build than this farm ships. They keep working on it until you update them.
            {data ? ` ${data.concurrency} phones update at a time, and a phone running a job waits for it to finish.` : ''}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : data === null ? (
          <LoadingRows rows={3} />
        ) : data.devices.length === 0 ? (
          <EmptyState title="Every device is up to date" description="Nothing to update." />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="text-body text-faint">
                {data.devices.length} {data.devices.length === 1 ? 'device' : 'devices'}
                {data.running > 0 ? ` · ${data.running} updating` : ''}
                {data.queued > 0 ? ` · ${data.queued} queued` : ''}
              </div>
              <div className="flex-1" />
              <Button disabled={idle.length === 0} onClick={() => void start()}>
                Update all ({idle.length})
              </Button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto rounded-card border border-line">
              <table className="w-full text-body">
                <thead className="text-left text-faint">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-normal">Device</th>
                    <th className="px-3 py-2 font-normal">Update</th>
                    <th className="px-3 py-2 font-normal">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.devices.map((row) => (
                    <tr key={row.deviceId} className="border-b border-line last:border-b-0 align-top">
                      <td className="px-3 py-2 text-text">
                        {row.number !== null ? <span className="text-faint">#{row.number} </span> : null}
                        {row.label}
                      </td>
                      <td className="px-3 py-2 text-text-2">
                        {row.components.length === 0
                          ? '—'
                          : row.components.map((c) => (
                              <div key={c.id}>
                                {c.label}: {c.installed ?? 'unknown'} → {c.latest ?? 'latest'}
                              </div>
                            ))}
                      </td>
                      <td className="px-3 py-2">
                        <StateBadge row={row} />
                        {row.message ? <div className="mt-1 max-w-[260px] text-[12px] text-faint">{row.message}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {(row.state === 'idle' || row.state === 'failed') && row.components.length > 0 ? (
                          <Button size="sm" variant="outline" onClick={() => void start([row.deviceId])}>
                            {row.state === 'failed' ? 'Retry' : 'Update'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
