import type { Logger } from '../util/logger'
import type { WorkspaceStore } from '../workspace/store'
import type { DevSlotStore } from './dev-slots'
import type { PluginRuntime } from './runtime'

/**
 * Wraps a `WorkspaceStore` so a write/move/delete under a workspace-owned
 * dev slot's own directory triggers a rebuild of that slot automatically
 * (plan 82 §3.5, §5 step 10: "there is no file watcher... every workspace
 * write goes through the store, so the store itself signals the change").
 * This was the plan's own status header's remaining gap for dev loading:
 * `POST /api/plugins/dev` with `entryPath` already builds ONE TIME on
 * demand (tested end-to-end against a real `WorkspaceStore`), but nothing
 * called it again on a SUBSEQUENT edit — this is that missing call.
 *
 * The trigger boundary is the directory CONTAINING the dev slot's own
 * `entryPath` (`/scripts/tiktok/index.ts` → `/scripts/tiktok/`) — a write
 * anywhere under it (the entry itself, or a shared helper like
 * `lib/omnibox.ts`) rebuilds; a write elsewhere in the workspace does not.
 *
 * Best-effort and asynchronous: the write/move/delete itself has ALREADY
 * succeeded by the time this runs (it wraps the return, never gates it), and
 * a rebuild failure is recorded on the slot itself (`devSlots.putFailed`,
 * `PluginRuntime.putDevSlot`'s own existing behaviour — the last good build
 * stays runnable, §3.8's guarantee applied to dev too) rather than thrown
 * back at whoever happened to trigger it — a typo in a helper file must not
 * make an unrelated workspace write appear to fail.
 */
export function withAutoRebuild(
  store: WorkspaceStore,
  deps: { devSlots: DevSlotStore; runtime: PluginRuntime; log: Logger },
): WorkspaceStore {
  function dirOf(entryPath: string): string {
    const i = entryPath.lastIndexOf('/')
    return i <= 0 ? '/' : entryPath.slice(0, i + 1)
  }

  function triggerFor(path: string): void {
    for (const slot of deps.devSlots.list()) {
      if (slot.owner.kind !== 'workspace') continue
      const dir = dirOf(slot.owner.label)
      if (!path.startsWith(dir)) continue
      // Reads through the UNWRAPPED `store` (never `this`/the returned
      // object) — `buildScriptFromWorkspace` only ever calls `read`/`list`,
      // neither of which is intercepted here, so there is no risk of a
      // rebuild's own reads re-triggering itself.
      void deps.runtime
        .putDevSlot({ name: slot.pluginName, owner: slot.owner, source: { kind: 'workspace', entryPath: slot.owner.label, workspace: store } })
        .catch((err) => deps.log.warn(`auto-rebuild of dev plugin "${slot.pluginName}" failed: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  return {
    list: (prefix) => store.list(prefix),
    read: (path) => store.read(path),
    grep: (prefix, pattern) => store.grep(prefix, pattern),
    write(path, input) {
      const meta = store.write(path, input)
      triggerFor(path)
      return meta
    },
    delete(path, input) {
      store.delete(path, input)
      triggerFor(path)
    },
    move(from, to, input) {
      const meta = store.move(from, to, input)
      triggerFor(from)
      triggerFor(to)
      return meta
    },
  }
}
