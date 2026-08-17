'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { DeviceInfo } from '@enkaku/protocol'
import { UsageSparkline } from './UsageSparkline'
import type { Agent, CapabilityInfo } from '@/lib/agents'
import { capabilityGroup } from '@/lib/agents'
import { fetchAgentUsage, type DailyUsage } from '@/lib/agent-usage'
import { formatUsd } from '@enkaku/ui'

/**
 * The right column (plan 69 §3.1, step 69.4) — what distinguishes a
 * workbench from a chat window: which phones this agent can touch, which
 * tools it has, what it may write, and what it has cost. Four questions
 * someone actually has while watching an agent work, each otherwise a trip
 * to a settings page and back.
 *
 * Collapses below `lg` (1024px, the same breakpoint `AppShell`'s own
 * sidebar collapses at) — the conversation column never does (§3.1).
 */
export function ContextPanel({ agent, devices, capabilities }: { agent: Agent; devices: DeviceInfo[]; capabilities: CapabilityInfo[] }) {
  const [usage, setUsage] = useState<{ days: DailyUsage[]; total: { costUsd: number | null }; truncated: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    setUsage(null)
    fetchAgentUsage(agent.id)
      .then((u) => {
        if (!cancelled) setUsage(u)
      })
      .catch(() => {
        if (!cancelled) setUsage(null)
      })
    return () => {
      cancelled = true
    }
  }, [agent.id])

  const grantedDevices = agent.deviceGrants.length === 0 ? devices : devices.filter((d) => agent.deviceGrants.includes(d.id))
  const toolsByGroup = new Map<string, number>()
  for (const id of agent.tools) {
    const g = capabilityGroup(id)
    toolsByGroup.set(g, (toolsByGroup.get(g) ?? 0) + 1)
  }

  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l p-4 lg:flex">
      <Section title="Devices" hint={agent.deviceGrants.length === 0 ? 'all devices — no restriction' : `${grantedDevices.length} granted`}>
        {grantedDevices.length === 0 ? (
          <p className="text-[11.5px] text-fg-subtle">No devices enrolled.</p>
        ) : (
          <ul className="space-y-1">
            {grantedDevices.slice(0, 12).map((d) => (
              <li key={d.id}>
                <Link href={`/device?id=${encodeURIComponent(d.id)}`} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-surface-2/60">
                  <span className="truncate">{d.label}</span>
                  <span className="readout shrink-0 text-[10.5px] text-fg-subtle">{d.status}</span>
                </Link>
              </li>
            ))}
            {grantedDevices.length > 12 && <li className="px-1.5 text-[11px] text-fg-subtle">+{grantedDevices.length - 12} more</li>}
          </ul>
        )}
      </Section>

      <Section title="Tools" hint={`${agent.tools.length} capabilit${agent.tools.length === 1 ? 'y' : 'ies'}`}>
        {agent.tools.length === 0 ? (
          <p className="text-[11.5px] text-fg-subtle">No tools granted.</p>
        ) : (
          <ul className="space-y-1">
            {[...toolsByGroup.entries()].map(([group, count]) => (
              <li key={group} className="flex items-center justify-between text-[12px]">
                <span className="capitalize">{group}</span>
                <span className="readout text-fg-subtle">{count}</span>
              </li>
            ))}
          </ul>
        )}
        {/* Every `effect: 'destructive'` capability already pauses for approval by construction
            (plan 66 §3.6) — `requiresApproval` is the operator's OWN added caution on top of that,
            so it is the one thing worth calling out here that is not visible from the group counts
            above. */}
        {agent.requiresApproval.length > 0 && (
          <p className="mt-1.5 text-[11px] text-fg-subtle">
            +{agent.requiresApproval.length} tool{agent.requiresApproval.length === 1 ? '' : 's'} set to pause for approval beyond the registry default.
          </p>
        )}
      </Section>

      <Section title="Workspace" hint={`/agents/${agent.slug}/`}>
        <div className="space-y-1.5 text-[11.5px]">
          <div>
            <p className="text-fg-subtle">read</p>
            {agent.workspaceScope.read.length === 0 ? <p className="text-fg-subtle">(none)</p> : agent.workspaceScope.read.map((p) => <p key={p} className="readout truncate">{p}</p>)}
          </div>
          <div>
            <p className="text-fg-subtle">write</p>
            {agent.workspaceScope.write.length === 0 ? <p className="text-fg-subtle">(none)</p> : agent.workspaceScope.write.map((p) => <p key={p} className="readout truncate">{p}</p>)}
          </div>
        </div>
        <Link href={`/workspace?path=${encodeURIComponent(`/agents/${agent.slug}/`)}`} className="mt-1.5 inline-block text-[11.5px] text-accent hover:underline">
          Open in Workspace
        </Link>
      </Section>

      <Section title="Usage" hint="last 14 days">
        {usage === null ? (
          <p className="text-[11.5px] text-fg-subtle">Loading…</p>
        ) : (
          <>
            <UsageSparkline days={usage.days} />
            <p className="readout mt-1.5 text-[13px] font-medium text-fg">{formatUsd(usage.total.costUsd)}</p>
            {usage.truncated && <p className="mt-1 text-[10.5px] text-fg-subtle">Computed from this agent's most recently active threads — not its full history.</p>}
          </>
        )}
      </Section>
    </aside>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between">
        <h2 className="rack-label">{title}</h2>
        {hint && <span className="text-[10.5px] text-fg-subtle">{hint}</span>}
      </div>
      {children}
    </section>
  )
}
