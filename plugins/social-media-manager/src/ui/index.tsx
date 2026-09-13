import { useCallback, useState } from 'react'
import type { PluginViewProps } from '@enkaku/ui'
import { ComposePanel } from './parts/compose'
import { SessionsPanel } from './parts/sessions'

/**
 * One screen for the whole job: upload the videos, say where they go, name the
 * batch, start it, watch it.
 *
 * ## Why one screen and not three
 *
 * This plugin used to declare three: a table of post rows, a table of upload
 * sessions, and a page listing which platforms can post. The owner's verdict
 * after using it, verbatim: *"saya minta menunya sama aja jadi satu dong
 * jangan dibedakan ada menu view page khusus untuk item post, untuk sesi dll
 * jadi bingung user"*. They were right, and the reason is not taste: the work
 * is ONE sequence — forty files out of a folder onto forty phones — and a
 * sequence split across three screens makes the operator hold the state in
 * their head and guess which screen owns the next step.
 *
 * So the page reads top to bottom in the order the work happens, and the only
 * split left is the honest one: what you are about to send (above) and what
 * you have already sent (below).
 *
 * ## Why this is React and not another declared table
 *
 * The declared surface (tier A) can render a stored row and fire an action per
 * row, which is exactly right for a list and cannot express this flow: files
 * being uploaded one after another with progress, a fleet count that answers
 * back as you pick labels ("goes to 38 phones"), a pacing sentence that
 * recomputes as you drag the numbers, captions generated from file names. All
 * of those are answers the screen has to compute WHILE the operator decides,
 * and that is what tier C is for.
 */
function SocialPostsView(_props: PluginViewProps): React.ReactElement {
  /*
    The one piece of state the two halves share: a counter the compose panel
    bumps when it writes a session, which the list below treats as "look
    again now". Deliberately a number rather than a callback registry — the
    list already polls while anything is moving, so this only has to cover the
    first moment, and a number cannot leak a stale closure.
  */
  const [refreshKey, setRefreshKey] = useState(0)
  const onCreated = useCallback(() => setRefreshKey((n) => n + 1), [])

  return (
    <div className="flex flex-col gap-6 py-4">
      <ComposePanel onCreated={onCreated} />
      <SessionsPanel refreshKey={refreshKey} />
    </div>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it,
 * under the same id the manifest gives the view.
 */
window.__enkaku__.register('posts', SocialPostsView)
