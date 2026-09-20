import { useCallback, useState } from 'react'
import { ArrowsClockwiseIcon, Button, CaretLeftIcon, PlusIcon, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, type PluginViewProps } from '@enkaku/ui'
import { AccountsPanel } from './parts/accounts'
import { ComposePanel } from './parts/compose'
import { SessionDetail, SessionsPanel } from './parts/sessions'
import { OpenSpeechContext, SpeechPanel } from './parts/speech'
import { DraftsPanel } from './parts/drafts'
import { NewWarmupForm, WarmupDetail, WarmupPanel } from './parts/warmup'
import { RecapPanel } from './parts/recap'

/**
 * One screen for the whole job: upload the videos, say where they go, name the
 * batch, start it, watch it.
 *
 * ## One MENU, four places to stand
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
 * ada sub page nampilin list item dari sesi"* — one menu entry, a row of tabs,
 * and a session that opens onto its own page. So:
 *
 * - **Sessions** — every batch, newest first, one table row each, with how far
 *   each has got. **New session** is a BUTTON here, not a fifth tab (0.37.0).
 * - **Recap** (0.60.0) — how each posted video is actually doing: one row per
 *   phone, the three platforms' view counts side by side, expandable to the
 *   videos themselves. It belongs here rather than beside the Jobs page for
 *   the same reason warm-up does — posting a video and asking how it did are
 *   one job to the person doing them.
 * - **Auto-Caption** — Whisper: the model, the doctor, the caption style. Named
 *   "Speech" until 0.37.0, which said what it ran rather than what it is for.
 * - **Cleanup** — each platform's drafts, and the videos the post scripts left
 *   on the phones.
 * - **Accounts** — which account each phone is signed in to on each platform.
 * - **A session's own page** — reached by opening a row, and it replaces the
 *   tabs rather than expanding inside one, because forty videos with their
 *   phones and errors is a page's worth of reading, not a drawer.
 *
 * ## Why composing is a page and not a tab
 *
 * The owner (2026-09-16): *"tabs dikompakkan lagi"*, and New session moved out
 * of the row. A tab is a PLACE the operator stands; composing is a task they
 * start and finish, after which they want the session they just made. It had
 * the same standing in the row as the four lists and it was never one of them —
 * so it is now a primary button on the Sessions tab, opening the compose flow
 * full-width with the same **All sessions** way back a session's page has.
 *
 * ## Where the page is, is in the URL
 *
 * `params`/`setParams` are the host's query passthrough (`PluginViewProps`),
 * so the tab, the compose flow and the open session all live in the address
 * bar: a reload lands where the operator was, and a link to one session is a
 * link somebody can send. Holding any of them in `useState` would have cost
 * both. Every URL that worked before still works: `tab=new` opens composing
 * (now as a page), and `tab=speech` opens Auto-Caption under its new name.
 *
 * What it does NOT buy is the browser's Back button: the host writes with
 * `history.replaceState` (deliberately — a `router.replace` under
 * `output: 'export'` re-resolves the route and could remount this component
 * mid-flow), so opening a session edits the URL rather than pushing an entry.
 * Hence the explicit **All sessions** button on both sub-pages: it is the way
 * back, and it is on screen rather than assumed.
 */

/**
 * The five places to stand. `new` is a PAGE reached from a list, never a tab.
 *
 * `warmup` joined them in 0.56.0, after briefly being a second SIDEBAR entry in
 * 0.53.0. The owner's verdict on that was the same one that produced this page
 * in the first place — *"saya mau anda jadikan satu, jadi Social Media Manager
 * page, ini isinya semuanya mencangkup warmup dan auto post"* — so warming up
 * is a TAB here, beside posting, and the sidebar is one entry again.
 *
 * What that settles, and it is worth writing down because it was argued both
 * ways: the rule is not "one entry per job". It is one entry per PRODUCT. A
 * farm's social work is one thing to the person doing it, whether this hour's
 * job is posting or warming up.
 */
type Tab = 'sessions' | 'warmup' | 'recap' | 'speech' | 'drafts' | 'accounts'
const TABS: readonly string[] = ['sessions', 'warmup', 'recap', 'speech', 'drafts', 'accounts']
const isTab = (value: unknown): value is Tab => typeof value === 'string' && TABS.includes(value)

function SocialPostsView({ params, setParams }: PluginViewProps): React.ReactElement {
  /*
    The one piece of state that is NOT in the URL: a counter the compose panel
    bumps when it writes a session, which the lists read as "look again now".
    It is about a moment rather than a place — reloading the page should not
    re-trigger a refresh — which is exactly what does not belong in a URL.
  */
  const [refreshKey, setRefreshKey] = useState(0)

  const openSessionId = params.session ?? null
  const openWarmupId = params.warmup ?? null
  /* `tab=new` is kept as the compose flow's address: every old link still lands on it. */
  const composing = params.tab === 'new'
  const tab: Tab = isTab(params.tab) ? params.tab : 'sessions'

  const openSession = useCallback((groupId: string) => setParams({ session: groupId, warmup: null }), [setParams])
  const backToSessions = useCallback(() => setParams({ session: null, warmup: null, tab: null }), [setParams])
  const openNew = useCallback(() => setParams({ session: null, warmup: null, tab: 'new' }), [setParams])
  /* The warm-up half of the same three moves. Its own query key, so a link to either kind still opens the right one. */
  const openWarmup = useCallback((groupId: string) => setParams({ warmup: groupId, session: null }), [setParams])
  const backToWarmups = useCallback(() => setParams({ warmup: null, session: null, tab: 'warmup' }), [setParams])
  const openNewWarmup = useCallback(() => setParams({ warmup: null, session: null, tab: 'new-warmup' }), [setParams])
  /*
    Auto-Caption (0.20.0 as "Speech") is a tab, not a second sidebar entry, for the reason this whole page is one entry:
    Whisper exists here for auto captions, and the operator reaches it from the note beside those buttons. That note
    switches the tab in place through this context, from the compose flow or a session's own page alike. The `speech`
    query value is unchanged — only what the tab is CALLED changed — so every link already written still opens it.
  */
  const openSpeech = useCallback(() => setParams({ session: null, tab: 'speech' }), [setParams])

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

  /*
    Refresh sits on the tab row rather than on a row of its own inside the
    panel. It asks for the same "look again now" a new session does — a bump of
    `refreshKey` — so the list keeps its one loader; the list reports back only
    whether a refresh is out, for the spinner beside the button.
  */
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), [])

  if (openWarmupId !== null) {
    return <WarmupDetail groupId={openWarmupId} refreshKey={refreshKey} onBack={backToWarmups} />
  }

  if (params.tab === 'new-warmup') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={backToWarmups}>
            <CaretLeftIcon aria-hidden />
            All warm-ups
          </Button>
          <span className="text-[12px] text-dim">New warm-up</span>
        </div>
        <NewWarmupForm
          onCreated={(groupId) => {
            setRefreshKey((n) => n + 1)
            setParams(groupId === null ? { tab: 'warmup' } : { tab: null, warmup: groupId })
          }}
        />
      </div>
    )
  }

  if (openSessionId !== null) {
    return (
      <OpenSpeechContext.Provider value={openSpeech}>
        <SessionDetail groupId={openSessionId} refreshKey={refreshKey} onBack={backToSessions} />
      </OpenSpeechContext.Provider>
    )
  }

  if (composing) {
    return (
      <OpenSpeechContext.Provider value={openSpeech}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={backToSessions}>
              <CaretLeftIcon aria-hidden />
              All sessions
            </Button>
            <span className="text-[12px] text-dim">New session</span>
          </div>
          <ComposePanel onCreated={onCreated} />
        </div>
      </OpenSpeechContext.Provider>
    )
  }

  /*
    No vertical padding of its own: the host already pads the view and draws
    the page header above it, so a `py-*` here is a second gap nobody asked for.
  */
  return (
    <OpenSpeechContext.Provider value={openSpeech}>
      <Tabs value={tab} onValueChange={(next) => setParams({ tab: next === 'sessions' ? null : next })} className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* `compact` (0.37.0): the owner asked for a tighter row, and four names in chips read as one row on a narrow window. */}
          <TabsList variant="compact">
            <TabsTrigger value="sessions">Posts</TabsTrigger>
            <TabsTrigger value="warmup">Warm-up</TabsTrigger>
            {/* Recap (0.60.0): how each posted video is actually doing, on all three platforms at once. */}
            <TabsTrigger value="recap">Recap</TabsTrigger>
            <TabsTrigger value="speech">Auto-Caption</TabsTrigger>
            <TabsTrigger value="drafts">Cleanup</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
          </TabsList>
          <div className="grow" />
          {tab === 'sessions' || tab === 'warmup' || tab === 'speech' ? (
            <>
              {refreshing ? <Spinner className="size-3.5 text-faint" /> : null}
              <Button variant="outline" size="sm" onClick={refresh}>
                <ArrowsClockwiseIcon aria-hidden />
                Refresh
              </Button>
            </>
          ) : null}
          {tab === 'sessions' ? (
            <Button size="sm" onClick={openNew}>
              <PlusIcon aria-hidden />
              New post session
            </Button>
          ) : null}
          {tab === 'warmup' ? (
            <Button size="sm" onClick={openNewWarmup}>
              <PlusIcon aria-hidden />
              New warm-up
            </Button>
          ) : null}
        </div>

        <TabsContent value="sessions">
          <SessionsPanel refreshKey={refreshKey} onOpen={openSession} onRefreshingChange={setRefreshing} onNew={openNew} />
        </TabsContent>
        <TabsContent value="warmup">
          <WarmupPanel refreshKey={refreshKey} onOpen={openWarmup} onNew={openNewWarmup} />
        </TabsContent>
        {/*
          Recap has no Refresh button on the tab row and wants none: its own
          "Refresh recap" queues reads on the phones, and the table under it
          re-reads itself while any are out. A second button meaning "look
          again" beside one meaning "go and ask the phones" is two words for
          two different things, one letter apart.
        */}
        <TabsContent value="recap">
          <RecapPanel />
        </TabsContent>
        <TabsContent value="speech">
          <SpeechPanel refreshKey={refreshKey} onRefreshingChange={setRefreshing} />
        </TabsContent>
        {/* Cleanup (0.32.0 as Drafts): each platform pack's clear-drafts member, sent to the phones picked here. */}
        <TabsContent value="drafts">
          <DraftsPanel />
        </TabsContent>
        {/* Accounts (0.37.0): who each phone is signed in as, read by `smm/sync-accounts` and stored under `account:`. */}
        <TabsContent value="accounts">
          <AccountsPanel />
        </TabsContent>
      </Tabs>
    </OpenSpeechContext.Provider>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it,
 * under the same id the manifest gives the view.
 */
window.__enkaku__.register('posts', SocialPostsView)
