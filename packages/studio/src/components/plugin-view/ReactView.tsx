'use client'

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button, LoadingRows } from '@enkaku/ui'
import {
  pluginHost,
  type PluginHost,
  type PluginViewComponent,
  type PluginViewFailure,
  type PluginViewFailureKind,
  type PluginViewParams,
  type SetPluginViewParams,
} from '@/lib/plugin-host'

/**
 * Tier C (plan 111 §3.1, §5 step 111.3) — the component that turns a plugin's
 * ES module into a mounted React component on a Studio page.
 *
 * It owns exactly the three states criterion 6 names, and nothing else:
 *
 * | state | what the operator sees |
 * |---|---|
 * | loading | the skeleton every Studio screen loads behind, captioned with the plugin and version whose code is being fetched |
 * | failed | the named failure `plugin-host.ts` produced — one of three kinds, never "something went wrong" — plus Retry |
 * | registered | the plugin's own component, inside an error boundary |
 *
 * **All the loading machinery lives in `plugin-host.ts`, on purpose.** The
 * import map, the script injection, the registry and the load-once rule are
 * that module's; this one calls `loadView` and renders what comes back.
 * `loadView` never rejects, so there is no `catch` here inventing copy for a
 * case the host already worded.
 *
 * **Two different moments a plugin can throw, and both are covered.** A module
 * that throws *while evaluating* never registers, and the host reports that as
 * `module-threw` before this component ever mounts anything. A component that
 * throws *while rendering* has already been handed over, and only an error
 * boundary can catch it — `PluginRenderBoundary` below. The two say different
 * things ("failed while starting" vs "crashed while rendering") because they
 * are different failures with different fixes.
 *
 * **The boundary contains a mistake, not a plugin** (§2, §8, `docs/design.md`'s
 * "Tier A or tier C", spec §11.3). A plugin's module runs in Studio's document
 * with the operator's session and reaches the farm exactly as Studio's own
 * code does; nothing here isolates it, and the copy says so rather than
 * implying a sandbox that does not exist. What the boundary buys is that one
 * plugin's bug costs its own panel instead of the whole page.
 *
 * **The gutter.** The plugin's component is rendered inside the same
 * `px-5 py-4` every other Studio screen uses, so a plugin that draws ordinary
 * content lines up with the rest of the app for free. A plugin that wants the
 * full bleed takes it back with `-mx-5 -my-4` — a ceiling would be against the
 * whole point of the tier (§2), so this is a default, not a frame.
 */

export interface ReactViewProps {
  plugin: string
  /** The activated version, or a dev slot's `buildVersion`. Part of the script URL — see `ReactView`'s note on criterion 8 below. */
  version: string
  viewId: string
  /** `ViewSpec.react.entry` — a path relative to the package's `ui/`. */
  entry: string
  /** The unclaimed query parameters, handed to the plugin uninterpreted (§9 Q2). */
  params: PluginViewParams
  /** Writes them back without navigating (§9 Q2). */
  setParams: SetPluginViewParams
  /**
   * The host to load through. Defaults to the page's one singleton; a test
   * passes its own, because nothing `plugin-host.ts` does — a module script
   * executing, an import map being honoured — happens under `happy-dom`.
   */
  host?: PluginHost
}

/** What to do next, per failure kind. The host words what HAPPENED; this words the fix. */
const NEXT_STEP: Record<PluginViewFailureKind, string> = {
  'module-load-failed':
    'Check that the plugin package really carries this file under its ui/ directory, and that the core is still reachable. Rebuild and push the plugin, then try again.',
  'module-threw':
    'The plugin’s own code threw before it could register anything, so this is a fix for its author. The browser’s developer tools have the stack.',
  'view-not-registered':
    'The plugin’s module has to call window.__enkaku__.register() with this exact view id, at the top level of the module.',
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; component: PluginViewComponent }
  | { status: 'failed'; failure: PluginViewFailure }

export function ReactView({ plugin, version, viewId, entry, params, setParams, host }: ReactViewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  /**
   * Bumped by Retry, and passed straight through to the host. It has to reach
   * the URL: a module map records a failed fetch as well as a successful one,
   * so re-injecting the identical URL is answered from that cached failure
   * without a request. `PluginViewRequest.attempt` carries the full reasoning.
   */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const active = host ?? pluginHost()
    let alive = true
    setState({ status: 'loading' })
    // `loadView` resolves to a named failure rather than rejecting, so there
    // is deliberately no `.catch` — one would only ever fire on a bug in the
    // host itself, and swallowing it into generic copy would hide that.
    void active.loadView({ pluginName: plugin, version, viewId, entry, attempt }).then((result) => {
      if (!alive) return
      setState(result.ok ? { status: 'ready', component: result.component } : { status: 'failed', failure: result.failure })
    })
    return () => {
      alive = false
    }
  }, [host, plugin, version, viewId, entry, attempt])

  if (state.status === 'loading') {
    return (
      <div className="space-y-2 px-5 py-4">
        <p className="readout text-[11.5px] text-fg-muted">
          Loading this screen’s code from “{plugin}” {version}…
        </p>
        <LoadingRows rows={4} />
      </div>
    )
  }

  if (state.status === 'failed') {
    const { failure } = state
    return (
      <div className="px-5 py-4">
        <FailurePanel
          title={failure.title}
          message={failure.message}
          detail={failure.detail}
          hint={NEXT_STEP[failure.kind]}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </div>
    )
  }

  const Mounted = state.component
  return (
    <div className="px-5 py-4">
      <PluginRenderBoundary
        // A fresh boundary per load: a Retry, a rebuild (`version` moves) or a
        // move to another view of the same plugin must not inherit the
        // previous component's crash.
        key={`${plugin}@${version}/${viewId}#${attempt}`}
        plugin={plugin}
        viewId={viewId}
      >
        <Mounted plugin={plugin} version={version} viewId={viewId} params={params} setParams={setParams} />
      </PluginRenderBoundary>
    </div>
  )
}

/**
 * One panel for both failure moments, so the load failure and the render crash
 * cannot drift apart visually. Not `ErrorState`: that component hardcodes
 * "Could not load" as its heading and takes a single string, and the whole
 * point of criterion 6 is that these three (four, with the crash) are told
 * apart by their heading.
 */
function FailurePanel({
  title,
  message,
  detail,
  hint,
  onRetry,
}: {
  title: string
  message: string
  detail: string
  hint: string
  onRetry: () => void
}) {
  return (
    <div className="rounded-lg border border-led-danger/40 bg-led-danger/5 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-led-danger" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[13px] font-medium">{title}</p>
          <p className="break-words text-[12px] text-fg-muted">{message}</p>
          <p className="readout break-all text-[11.5px] text-fg-muted">{detail}</p>
          <p className="text-[11.5px] leading-relaxed text-fg-muted">{hint}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

interface BoundaryProps {
  plugin: string
  viewId: string
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

/**
 * The error boundary of §8 — a class component because React has no hook
 * equivalent, and this is the one place in Studio that needs one.
 *
 * `Try again` clears the error and re-renders the children. React unmounted
 * them when it rendered this fallback, so that is a genuinely fresh mount of
 * the plugin's component: a crash that depended on state it had accumulated
 * goes away, and a crash that is unconditional comes straight back — which is
 * the honest answer to "is this broken or was that a one-off?".
 */
class PluginRenderBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The panel shows one line; the stack and the component trace only exist
    // here, and an author debugging their own plugin needs both.
    console.error(`[enkaku] the plugin “${this.props.plugin}” crashed while rendering its “${this.props.viewId}” view`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <FailurePanel
        title="This view crashed while rendering"
        message={`The plugin “${this.props.plugin}” threw an error while drawing its “${this.props.viewId}” view, so this panel is showing instead. The rest of Studio kept running.`}
        detail={error.message || String(error)}
        hint="Studio caught the crash, not the plugin: its code runs in this page with your session and reaches the farm exactly as Studio does, and nothing here isolates it. This only keeps one plugin’s mistake off the rest of the page."
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}
