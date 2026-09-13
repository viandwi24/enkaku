import { useCallback, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger, type PluginViewProps } from '@enkaku/ui'
import { ComposePanel } from './parts/compose'
import { SessionDetail, SessionsPanel } from './parts/sessions'

/**
 * One screen for the whole job: upload the videos, say where they go, name the
 * batch, start it, watch it.
 *
 * ## One MENU, three places to stand
 *
 * This plugin used to declare three views — a table of post rows, a table of
 * upload sessions, and a page listing which platforms can post. The owner's
 * verdict, verbatim: *"saya minta menunya sama aja jadi satu dong jangan
 * dibedakan ada menu view page khusus untuk item post, untuk sesi dll jadi
 * bingung user"*. What they were rejecting was three SIDEBAR entries for one
 * job — three names to choose between before knowing which one owns the next
 * step.
 *
 * The answer is not one flat page. Their next words were how it should be laid
 * out: *"ga bisa dibuat tabs aja kah biar rapih... dihalaman depan itu
 * nampilin semua sesi atau grup, baru kalau di-details masing-masing sesi baru
 * ada sub page nampilin list item dari sesi"* — one menu entry, two tabs, and
 * a session that opens onto its own page. So:
 *
 * - **Sessions** — every batch, newest first, with how far each has got.
 * - **New session** — the whole compose flow: files in, phones and pacing
 *   chosen, session created.
 * - **A session's own page** — reached by opening a card, and it replaces both
 *   tabs rather than expanding inside one, because forty videos with their
 *   phones and errors is a page's worth of reading, not a drawer.
 *
 * ## Where the page is, is in the URL
 *
 * `params`/`setParams` are the host's query passthrough (`PluginViewProps`),
 * so the tab and the open session live in the address bar: a reload lands
 * where the operator was, and a link to one session is a link somebody can
 * send. Holding either in `useState` would have cost both.
 *
 * What it does NOT buy is the browser's Back button: the host writes with
 * `history.replaceState` (deliberately — a `router.replace` under
 * `output: 'export'` re-resolves the route and could remount this component
 * mid-flow), so opening a session edits the URL rather than pushing an entry.
 * Hence the explicit **All sessions** button on the session page: it is the
 * way back, and it is on screen rather than assumed.
 */
function SocialPostsView({ params, setParams }: PluginViewProps): React.ReactElement {
  /*
    The one piece of state that is NOT in the URL: a counter the compose panel
    bumps when it writes a session, which the lists read as "look again now".
    It is about a moment rather than a place — reloading the page should not
    re-trigger a refresh — which is exactly what does not belong in a URL.
  */
  const [refreshKey, setRefreshKey] = useState(0)

  const openSessionId = params.session ?? null
  const tab = params.tab === 'new' ? 'new' : 'sessions'

  const openSession = useCallback((groupId: string) => setParams({ session: groupId }), [setParams])
  const backToList = useCallback(() => setParams({ session: null }), [setParams])

  /*
    A new session lands the operator ON it. They have just decided forty things
    about this batch; the next question is always "is it going out", and the
    page that answers it is the one they just created.
  */
  const onCreated = useCallback(
    (groupId: string | null) => {
      setRefreshKey((n) => n + 1)
      setParams(groupId === null ? { tab: null } : { tab: null, session: groupId })
    },
    [setParams],
  )

  if (openSessionId !== null) {
    return <SessionDetail groupId={openSessionId} refreshKey={refreshKey} onBack={backToList} />
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setParams({ tab: next === 'new' ? 'new' : null })}
      className="py-4"
    >
      <TabsList variant="line">
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="new">New session</TabsTrigger>
      </TabsList>

      <TabsContent value="sessions">
        <SessionsPanel refreshKey={refreshKey} onOpen={openSession} />
      </TabsContent>
      <TabsContent value="new">
        <ComposePanel onCreated={onCreated} />
      </TabsContent>
    </Tabs>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it,
 * under the same id the manifest gives the view.
 */
window.__enkaku__.register('posts', SocialPostsView)
