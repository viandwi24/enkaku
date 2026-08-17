import { hostname, tmpdir, userInfo } from 'node:os'
import { mkdtempSync, rmSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { isPlugin } from '../plugin'
import { buildEntry, NOT_A_PLUGIN_MESSAGE } from './publish'
import { PACKAGE_CONTENT_TYPE, writeEnkakuPackage } from './enkaku-package'

export interface DevOptions {
  entry: string
  farmUrl: string
  token?: string
  /** Overrides the plugin name the farm uses for this dev slot — defaults to the bundle's own `id`. */
  name?: string
  /** Rebuild and re-push on every source change. Defaults to true — the whole point of `enkaku dev` (plan 82 §3.5 front-end B). Set false for a single one-shot push. */
  watch?: boolean
}

/**
 * `enkaku dev <entry.ts>` (plan 82 §3.5 front-end B, §5 step 12; plan 111 §4.4,
 * step 111.6): builds locally with the SAME code `publish` uses — BOTH halves,
 * the script bundle and the React entries under `src/ui/` — pushes to
 * `POST /api/plugins/dev`, and re-pushes on every source change — a fast
 * feedback loop for a plugin author, never a trust boundary (the farm
 * verifies what it was given exactly as it does for a publish, §3.5's own
 * words). The session ends when this process exits or after the farm's own
 * idle TTL (default 30 min) — there is nothing for the CLI itself to clean
 * up, since a dev slot is never a database row (`plugins/dev-slots.ts`) — its
 * `ui/` assets are cleaned up by the farm when the slot is dropped or swept
 * (`plugins/runtime.ts`), not by this process.
 */
export async function devCommand(opts: DevOptions): Promise<void> {
  const owner = `${userInfo().username}@${hostname()}`
  const watchDir = dirname(opts.entry)
  let building = false
  let pending = false

  const pushOnce = async (): Promise<string | null> => {
    const tmp = mkdtempSync(join(tmpdir(), 'enkaku-dev-'))
    try {
      const built = await buildEntry(opts.entry, tmp)
      if (!isPlugin(built.default)) {
        throw new Error(NOT_A_PLUGIN_MESSAGE)
      }
      const def = built.default as { id: string; version: string; scripts: { id: string }[] }
      const name = opts.name ?? def.id
      // Plan 111 §4.4 — a dev slot carries `ui/` too, so a React view can be
      // iterated at all. The transport branches exactly the way `publish` does:
      // a project with built assets goes out as a raw `.enkaku` package, one
      // without keeps the original `{ name, bundle }` JSON body.
      //
      // The name override rides in the PACKAGE MANIFEST rather than as a query
      // parameter, so both transports name the slot in exactly one place and
      // the farm reads it from exactly one place.
      const hasUi = built.ui.length > 0
      const res = await fetch(`${opts.farmUrl.replace(/\/$/, '')}/api/plugins/dev`, {
        method: 'POST',
        headers: {
          'content-type': hasUi ? PACKAGE_CONTENT_TYPE : 'application/json',
          'x-enkaku-dev-owner': owner,
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: hasUi
          ? writeEnkakuPackage({ name, version: def.version, source: built.source, scripts: built.bundle, ui: built.ui })
          : JSON.stringify({ name, bundle: built.bundle }),
      })
      // `POST /api/plugins/dev`'s success body is a `VerifyReport` (never an
      // `{error}` envelope on a 200 — a build that fails verification still
      // answers 200 with `ok: false`, since it is a normal, expected outcome
      // of writing code, not a request error).
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null
        throw new Error(body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { ok: boolean; error?: string; errorCode?: string; scripts: { id: string }[] }
      if (!body.ok) {
        console.error(`✗ build rejected: ${body.errorCode ?? 'E_PLUGIN_VERIFY_FAILED'} — ${body.error ?? '(no message)'}`)
        return null
      }
      const uiNote = hasUi ? `, ${built.ui.length} ui file${built.ui.length === 1 ? '' : 's'}` : ''
      console.log(`✓ pushed ${name}@${def.version}+dev — ${def.scripts.length} script${def.scripts.length === 1 ? '' : 's'} (${(built.bundle.length / 1024).toFixed(1)} KB${uiNote})`)
      return name
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  // A watch-triggered rebuild is best-effort — a save that momentarily leaves
  // a file half-written must not crash the whole watch loop (§3.5's own
  // spirit: the CLI's local build is a fast feedback loop, not something
  // that punishes an in-progress edit). The VERY FIRST build is different:
  // an entry whose default export is not a `definePlugin()` result is a usage
  // error, not a transient one — it stops the command and exits non-zero
  // carrying the same wrapper `enkaku publish` shows
  // (`NOT_A_PLUGIN_MESSAGE`), rather than silently sitting there "watching"
  // something it can never push.
  const rebuildSoft = async () => {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      await pushOnce()
    } catch (err) {
      console.error(`✗ build failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      building = false
      if (pending) {
        pending = false
        void rebuildSoft()
      }
    }
  }

  await pushOnce()

  if (opts.watch === false) return

  console.log(`watching ${watchDir} for changes — Ctrl-C to stop`)
  let debounce: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(watchDir, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce)
    // A save often fires several fs events in quick succession (write, then a
    // metadata touch) — debounced so one edit is one rebuild, not three.
    debounce = setTimeout(() => void rebuildSoft(), 150)
  })
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      watcher.close()
      resolve()
    })
  })
}
