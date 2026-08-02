import { existsSync } from 'node:fs'
import { join, normalize, posix } from 'node:path'
import { embeddedAssets } from '../embedded'
import type { Logger } from '../util/logger'

const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Enkaku</title>
<style>body{font-family:system-ui;margin:3rem auto;max-width:40rem;line-height:1.6;color:#222}code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}</style>
</head><body>
<h1>Enkaku core is running</h1>
<p>No Studio build found. Pick one of these:</p>
<ul>
  <li><b>Dev mode:</b> <code>bun run --cwd packages/studio dev</code>, then open <code>http://localhost:3001</code></li>
  <li><b>Prod mode:</b> <code>bun run --cwd packages/studio build</code>, then reload this page</li>
</ul>
<p>The API is still up: <code>/api/health</code>, <code>/api/devices</code>, <code>/api/tools</code>, <code>/api/registry</code>, and WS <code>/ws</code>.</p>
</body></html>`

/**
 * Serve the Studio static export (prod mode, single origin — the single-binary path
 * Plan 09). The caller still gives `/api/*` and `/ws` priority.
 */
export function createStudioServer(log: Logger) {
  // A compiled binary carries the Studio export inside itself.
  const embedded = embeddedAssets()?.studio
  if (embedded && embedded['index.html']) {
    log.info(`serving Studio from the embedded build (${Object.keys(embedded).length} files)`)
    return async function serveEmbeddedStudio(pathname: string): Promise<Response> {
      // URL paths are always forward-slash — posix semantics even on Windows.
      const rel = posix.normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')).replace(/^(\.\.\/)+/, '')
      for (const candidate of [rel, `${rel}.html`, `${rel}/index.html`]) {
        const path = embedded[candidate]
        if (path) return new Response(Bun.file(path))
      }
      // Fallback SPA: client-side routing.
      return new Response(Bun.file(embedded['index.html'] as string), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
  }

  const distDir = process.env.ENKAKU_STUDIO_DIST ?? join(process.cwd(), 'packages', 'studio', 'out')
  const available = existsSync(join(distDir, 'index.html'))
  if (!available) {
    log.warn(`no Studio build at ${distDir} — serving the instructions page`)
  } else {
    log.info(`serving Studio from ${distDir}`)
  }

  return async function serveStudio(pathname: string): Promise<Response> {
    if (!available) {
      return new Response(PLACEHOLDER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '')
    const candidates = [join(distDir, rel), join(distDir, `${rel}.html`), join(distDir, rel, 'index.html')]
    for (const candidate of candidates) {
      if (!candidate.startsWith(distDir)) break // path traversal
      const file = Bun.file(candidate)
      if (await file.exists()) return new Response(file)
    }
    // Fallback SPA: client-side routing.
    return new Response(Bun.file(join(distDir, 'index.html')), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
}
