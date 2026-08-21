import { useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger, type PluginViewProps } from '@enkaku/ui'
import { AssignmentsTab } from './parts/assignments'
import { PathsTab } from './parts/paths'
import { RulesTab } from './parts/rules'
import { SettingsTab } from './parts/settings'

/**
 * MikroTik routing, on tier C (plan 122 step 122.3) — modelled closely on
 * `plugins/proxy-manager/src/ui/index.tsx`, this repo's most complete
 * tier-C plugin: the same `PluginViewProps`/`window.__enkaku__.register`
 * shape, the same host-React-through-the-import-map dependency (§3.2, T4 —
 * a second React copy would throw `Invalid hook call` at the first hook
 * below), and the same tab-lives-in-the-URL pattern so a reload lands where
 * the operator was.
 *
 * Four tabs: Paths, Settings, Rules (read-only, stage 1) and Assignments
 * (stage 2, step 122.6) — the one tab that can change what is on the router,
 * and only through a reviewed plan the operator confirms (§4.4).
 */

const TABS = [
  { id: 'paths', label: 'Paths' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'settings', label: 'Settings' },
  { id: 'rules', label: 'Rules' },
] as const

type TabId = (typeof TABS)[number]['id']

const DEFAULT_TAB: TabId = 'paths'

function isTab(value: string | undefined): value is TabId {
  return TABS.some((tab) => tab.id === value)
}

function MikrotikRoutingView({ params, setParams }: PluginViewProps) {
  /**
   * The URL is the state, not a copy of it (mirrors `proxy-manager`'s own
   * `index.tsx`) — `params.tab` is read straight from the query and
   * `setParams` writes it back, so a reload, a Back, and a link somebody
   * pasted all land on the same tab.
   */
  const tab: TabId = isTab(params.tab) ? params.tab : DEFAULT_TAB
  const setTab = useCallback((next: string) => setParams({ tab: next === DEFAULT_TAB ? null : next }), [setParams])

  return (
    <div className="@container space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/*
          `forceMount` deliberately unused, same reasoning `proxy-manager`'s
          own comment gives: an unmounted tab stops fetching, and every tab
          here talks to the router live. Reload on return is the right trade.
        */}
        <TabsContent value="paths" className="pt-2">
          <PathsTab />
        </TabsContent>
        <TabsContent value="assignments" className="pt-2">
          <AssignmentsTab />
        </TabsContent>
        <TabsContent value="settings" className="pt-2">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="rules" className="pt-2">
          <RulesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it.
 * The id must match the key under `surface.views` in `../index.ts`.
 */
window.__enkaku__.register('routing', MikrotikRoutingView)
