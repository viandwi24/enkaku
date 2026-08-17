import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { EnkakuError } from '../util/errors'
import { isUiAssetPath, type PluginPackageAsset } from './package'

/**
 * Where a `.enkaku` package's `ui/` payload LIVES (plan 108 §4.4, §5 step
 * 108.10).
 *
 * Until this step the payload was validated by `readPluginPackage` and then
 * dropped on the floor, because nothing served it. It is stored on disk rather
 * than in the database for the same reason a script bundle is
 * (`scripts/bundle-cache.ts`): up to 8 MiB of binary per plugin version
 * (`SURFACE_LIMITS.maxUiBytes`) has no business in a row that `SELECT *` reads
 * on every plugin list, and `db/schema.ts` is not touched by this step at all
 * — there is no new column, and none is needed.
 *
 * ## The layout, and why it is shaped like this
 *
 * ```
 * <dataDir>/plugins/assets/<sha256>          the bytes, content-addressed and shared
 * <dataDir>/plugins/index/<pluginId>.json    path -> { hash, bytes }, one per plugin ROW
 * ```
 *
 * **The blobs are content-addressed**, exactly as `materializeBundleText`
 * addresses a bundle: the same bytes are one file however many plugin versions
 * ship them, which matters because the common case for a `ui/` directory is a
 * version bump that changes one script and leaves the images alone.
 *
 * **The index is keyed by `plugins.id`** — the UUID `PluginRuntime.stage`
 * generates — and NOT by `<name>/<version>`. Three things fall out of that:
 * the filename is a value this process minted, never a string a caller chose;
 * two versions of one plugin whose script bundles happen to be identical do
 * not collide (they would if the directory were keyed on `bundleHash`, and a
 * rollback would then serve the wrong screen); and removal is exact — one row
 * removed is one index file removed.
 *
 * ## Why `read` cannot traverse
 *
 * A caller's path is **never joined onto a filesystem path**. It is looked up
 * in the index by exact match — `Object.hasOwn(index, path)` — and what
 * reaches `join` is the sha256 hex the index stored, re-checked against
 * `/^[0-9a-f]{64}$/` on the way out of Zod. `../`, a leading `/`, a
 * backslash, a percent-encoded `..` that Hono already decoded: all of them are
 * simply keys the index does not have, so they answer 404 for the same reason
 * `nonsense.html` does. There is no sanitiser here, because there is nothing
 * to sanitise.
 */

/** Concrete, `ArrayBuffer`-backed bytes — what `Bun.write`/`Bun.file` hand back and what a `Response` body takes. */
type Bytes = Uint8Array<ArrayBuffer>

const AssetRefSchema = z
  .object({
    /** sha256 of the bytes, lowercase hex. The ONLY value this module ever joins onto a path. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict()

/**
 * The index, re-validated on every read. It is a file on disk: whatever wrote
 * it was some version of this code, and "we wrote it once" is not the same
 * guarantee as "it is shaped the way today's reader expects" — the same
 * discipline `runtime.ts` applies to the `plugins.manifest` JSON column.
 *
 * The KEY is checked too, against `isUiAssetPath` — the archive reader's own
 * grammar. A hand-edited index naming `../../etc/passwd` therefore fails to
 * parse rather than becoming a lookup that succeeds.
 */
const AssetIndexSchema = z.record(
  z.string().refine(isUiAssetPath, { error: 'not a legal ui/ asset path' }),
  AssetRefSchema,
)
export type PluginAssetIndex = z.infer<typeof AssetIndexSchema>

/** The UUID shape `crypto.randomUUID()` produces, and the only thing this module will use as a filename. */
const PLUGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * `content-type` by extension, from a CLOSED list. An extension that is not
 * here is served as `application/octet-stream` and never guessed: sniffing is
 * how a `.txt` an author uploaded becomes a script the browser executes, and
 * every response also carries `X-Content-Type-Options: nosniff` so the browser
 * does not guess either.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** The extension's content type, or `application/octet-stream`. A path with no dot in its last segment has no extension and takes the default. */
export function contentTypeFor(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return DEFAULT_CONTENT_TYPE
  return CONTENT_TYPES[last.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
}

/**
 * The response policy for **every** `GET /api/plugins/:name/ui/*` response
 * (plan 108 §4.4: "a strict CSP … no external hosts, no `allow-same-origin`").
 * One constant, applied uniformly, because a header that is right on the
 * document and missing on the script it loads is not a policy.
 *
 * Directive by directive, and why:
 *
 * - `default-src 'none'` — nothing is reachable unless a directive below says so.
 * - `script-src 'self'` — the plugin's OWN files, served by this route, and
 *   nothing else. Deliberately without `'unsafe-inline'`: that keyword would
 *   also re-enable inline event handlers (`onclick="…"`), which this policy is
 *   required to forbid. A tier-B plugin ships `app.js`, not `<script>…</script>`.
 * - `style-src 'self' 'unsafe-inline'` — inline CSS is not a script vector under
 *   `script-src` above, and the host's design-token block is injected by the
 *   frame's own bootstrap as a `<style>` element (§4.4, "design tokens … as CSS
 *   custom properties"), which counts as inline style.
 * - `connect-src 'none'` — **the load-bearing one.** No `fetch`, no `XMLHttpRequest`,
 *   no `WebSocket`, no `EventSource`, no `sendBeacon`, to ANY host including this
 *   one. A tier-B frame therefore cannot call the farm's API even if it somehow
 *   held a credential, which is what makes criterion 16 structural rather than
 *   a promise: its only channel to the host is the `postMessage` RPC, and that
 *   maps onto declared actions and data sources only.
 * - `form-action 'none'`, `base-uri 'none'`, `object-src 'none'` — the three
 *   classic ways a document exfiltrates or re-points itself without `connect-src`.
 * - `frame-ancestors` — Studio, and Studio's dev server. `'self'` alone would
 *   break `bun run dev:studio`, where Studio is on :3001 and the core on :7700
 *   (two origins to a browser); the loopback entries mirror the CORS grant
 *   `server/http.ts` already makes for exactly that setup, and admit only a page
 *   already running on the operator's own machine.
 * - `sandbox allow-scripts` — the same sandbox `FrameView`'s `<iframe>`
 *   attribute applies, re-applied by the SERVER so it holds even when the URL is
 *   opened directly in a tab rather than through Studio. `allow-same-origin` is
 *   absent, so the document has an opaque origin and can read no cookie, no
 *   storage, and nothing of the operator's session.
 */
export const PLUGIN_UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  'sandbox allow-scripts',
].join('; ')

/** One asset, ready to be a response body. */
export interface StoredAsset {
  path: string
  data: Bytes
  bytes: number
  contentType: string
}

export interface PluginAssetStore {
  /** Materialises one plugin row's `ui/` payload. Idempotent for identical bytes; replaces the row's index wholesale. */
  put(pluginId: string, assets: readonly PluginPackageAsset[]): Promise<void>
  /** The stored path → ref map for one plugin row, or `null` when that row stored nothing (or stored something unreadable). */
  index(pluginId: string): PluginAssetIndex | null
  /** One asset by its EXACT stored path. `null` for anything the index does not hold. */
  read(pluginId: string, path: string): Promise<StoredAsset | null>
  /** Drops one plugin row's index, then sweeps every blob no surviving index still references. */
  remove(pluginId: string): void
}

export function createPluginAssetStore(dataDir: string): PluginAssetStore {
  const root = join(dataDir, 'plugins')
  const blobsDir = join(root, 'assets')
  const indexDir = join(root, 'index')

  /** The one place a plugin id becomes a path, and it refuses anything that is not a UUID this process could have minted. */
  const indexPathFor = (pluginId: string): string => {
    if (!PLUGIN_ID.test(pluginId)) {
      throw new EnkakuError('E_BAD_REQUEST', `"${pluginId}" is not a plugin id — a plugin's stored assets are keyed by its row id`)
    }
    return join(indexDir, `${pluginId}.json`)
  }

  return {
    async put(pluginId, assets) {
      const file = indexPathFor(pluginId)
      if (assets.length === 0) return
      mkdirSync(blobsDir, { recursive: true })
      mkdirSync(indexDir, { recursive: true })

      const index: PluginAssetIndex = {}
      for (const asset of assets) {
        if (!isUiAssetPath(asset.path)) {
          throw new EnkakuError('E_PLUGIN_PACKAGE_INVALID', `package entry "ui/${asset.path}" is not a usable asset path`)
        }
        const hasher = new Bun.CryptoHasher('sha256')
        hasher.update(asset.data)
        const hash = hasher.digest('hex')
        const blob = join(blobsDir, hash)
        // Content-addressed: identical bytes are written once, whoever ships
        // them — the same "if it exists it is already right" the bundle cache
        // relies on, and true for the same reason.
        if (!(await Bun.file(blob).exists())) await Bun.write(blob, asset.data)
        index[asset.path] = { hash, bytes: asset.data.length }
      }
      await Bun.write(file, JSON.stringify(index))
    },

    index(pluginId) {
      const file = indexPathFor(pluginId)
      return readIndex(file)
    },

    async read(pluginId, path) {
      const index = readIndex(indexPathFor(pluginId))
      if (!index) return null
      // EXACT match against the archive's own already-validated entry list.
      // Nothing is normalised, resolved, or stripped: a path the package did
      // not declare is simply absent.
      if (!Object.hasOwn(index, path)) return null
      const ref = index[path]
      if (!ref) return null
      const file = Bun.file(join(blobsDir, ref.hash))
      if (!(await file.exists())) return null
      const data = new Uint8Array(await file.arrayBuffer())
      return { path, data, bytes: data.length, contentType: contentTypeFor(path) }
    },

    remove(pluginId) {
      const file = indexPathFor(pluginId)
      if (!existsSync(file)) return
      rmSync(file, { force: true })

      // Blobs are shared, so one of them may still belong to another version
      // of this plugin or to a different plugin entirely. Sweep by reachability
      // rather than by bookkeeping: the surviving indexes ARE the reference
      // count, and re-deriving it cannot drift the way a stored count can.
      const keep = new Set<string>()
      if (existsSync(indexDir)) {
        for (const entry of readdirSync(indexDir)) {
          const surviving = readIndex(join(indexDir, entry))
          if (surviving) for (const ref of Object.values(surviving)) keep.add(ref.hash)
        }
      }
      if (existsSync(blobsDir)) {
        for (const blob of readdirSync(blobsDir)) {
          if (!keep.has(blob)) rmSync(join(blobsDir, blob), { force: true })
        }
      }
    },
  }
}

/**
 * Reads and re-validates one index file. `null` — never a throw — for a
 * missing, unparseable, or unrecognised file: this runs on the way to serving
 * a screen, and a corrupt index must degrade to "this plugin has no assets"
 * (a 404 the page can explain) rather than to a 500 on a route that has
 * nothing to do with whatever damaged it.
 */
function readIndex(file: string): PluginAssetIndex | null {
  if (!existsSync(file)) return null
  let raw: unknown
  try {
    // Read synchronously: the index is a few hundred bytes on a request path,
    // so a promise here would buy nothing and cost a tick.
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const parsed = AssetIndexSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
