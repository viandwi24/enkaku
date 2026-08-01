import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { Logger } from '../util/logger'

const PLACEHOLDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Enkaku</title>
<style>body{font-family:system-ui;margin:3rem auto;max-width:40rem;line-height:1.6;color:#222}code{background:#f4f4f5;padding:.15em .4em;border-radius:4px}</style>
</head><body>
<h1>Enkaku core berjalan</h1>
<p>Build Studio belum ditemukan. Pilih salah satu:</p>
<ul>
  <li><b>Mode dev:</b> <code>bun run --cwd packages/studio dev</code> lalu buka <code>http://localhost:3001</code></li>
  <li><b>Mode prod:</b> <code>bun run --cwd packages/studio build</code> lalu muat ulang halaman ini</li>
</ul>
<p>API tetap aktif: <code>/api/health</code>, <code>/api/devices</code>, <code>/api/tools</code>, <code>/api/registry</code>, WS <code>/ws</code>.</p>
</body></html>`

/**
 * Serve Studio static export (mode prod, satu origin — jalur single-binary
 * Plan 09). `/api/*` dan `/ws` tetap diprioritaskan oleh caller.
 */
export function createStudioServer(log: Logger) {
  const distDir = process.env.ENKAKU_STUDIO_DIST ?? join(process.cwd(), 'packages', 'studio', 'out')
  const available = existsSync(join(distDir, 'index.html'))
  if (!available) {
    log.warn(`Studio build tidak ditemukan di ${distDir} — menyajikan halaman petunjuk`)
  } else {
    log.info(`Studio dilayani dari ${distDir}`)
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
