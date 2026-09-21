import { useEffect, useState, type ReactElement } from 'react'
import { Badge, Button, WarningIcon, useAction } from '@enkaku/ui'
import { accountProblemText, type AccountProblem } from '../../account-status'
import { clearAccountProblem, deviceName, listAccountProblems, listDevices, type Device } from '../shared'

/**
 * Accounts that need a person (0.64.0): one line each, with the fix and a "Signed in" button.
 *
 * The router stops sending posts and warm-ups to a platform on a phone once a script says its
 * account is signed out or held behind a check (`account-status.ts`); this is where an operator
 * sees which, and says it has been dealt with. Nothing is shown when nothing needs a person.
 */
export function AccountAlerts({ refreshKey }: { refreshKey: number }): ReactElement | null {
  const [problems, setProblems] = useState<AccountProblem[]>([])
  const [fleet, setFleet] = useState<ReadonlyMap<string, Device>>(new Map())
  const [reload, setReload] = useState(0)
  const { run, isPending } = useAction()

  useEffect(() => {
    let live = true
    Promise.all([listAccountProblems(), listDevices()])
      .then(([list, devices]) => {
        if (!live) return
        setProblems(list)
        setFleet(new Map(devices.map((d) => [d.id, d])))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [refreshKey, reload])

  if (problems.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-inner border border-line p-3">
      <div className="flex items-center gap-1.5 text-[12px] text-warn">
        <WarningIcon aria-hidden />
        {problems.length} account{problems.length === 1 ? ' needs' : 's need'} a person — nothing more is sent to {problems.length === 1 ? 'it' : 'them'} until it is marked signed in
      </div>
      {problems.map((p) => {
        const device = fleet.get(p.deviceId)
        const key = `acct:${p.deviceId}:${p.platform}`
        return (
          <div key={key} className="flex flex-wrap items-center gap-2 text-[12px]">
            <Badge variant="outline">{device ? deviceName(device) : p.deviceId.slice(0, 8)}</Badge>
            <span className="text-dim">{accountProblemText(p)}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending(key)}
              onClick={() =>
                void run(key, () => clearAccountProblem(p.deviceId, p.platform), {
                  success: 'Marked signed in — the router sends to it again',
                  failure: 'Could not clear it',
                  onSuccess: () => setReload((n) => n + 1),
                })
              }
            >
              Signed in
            </Button>
          </div>
        )
      })}
    </div>
  )
}
