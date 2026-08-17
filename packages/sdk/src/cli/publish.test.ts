import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'bun'

/**
 * Plan 82 §5 step 12 — `enkaku publish` detecting a plugin entry and
 * `--stage-only`, plus `enkaku dev`; plan 110 §5 step 110.4 — the refusal of
 * anything that is NOT a plugin, and `enkaku init`. All exercised by spawning
 * the REAL CLI entry (`index.ts`) as a genuine child process against a REAL
 * fake-farm HTTP server (`Bun.serve`) — the same "spawn the real thing"
 * approach `child-entry.test.ts` already uses for the plugin-bundle
 * selection mechanism, and NOT calling `publish()`/`devCommand()` in
 * process: `Bun.build` bundling a fixture that imports `@enkaku/sdk`
 * (self-referencing the very package under test) from INSIDE the `bun
 * test` process that is simultaneously running this file hits a real Bun
 * quirk ("Unseekable reading file" on `zod`'s own module) that a genuine
 * subprocess — a completely separate Bun process, exactly how a user
 * actually runs `enkaku publish` — does not.
 */

const CLI_ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const FIXTURE_ROOT = join(import.meta.dir, '.test-fixtures')
mkdirSync(FIXTURE_ROOT, { recursive: true })

const dirs: string[] = []
function fixtureDir(): string {
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'fx-'))
  dirs.push(dir)
  return dir
}

function writeFixture(content: string): string {
  const path = join(fixtureDir(), 'entry.ts')
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true })
})

const PLUGIN_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'tiktok',
  version: '1.0.0',
  scripts: [
    { id: 'login', params: z.object({}), run: async () => 'login-ok' },
    { id: 'warmup', params: z.object({}), run: async () => 'warmup-ok' },
  ],
})
`

/**
 * Plan 110 §3.1 (Hard), §4.2, criterion 6 — exactly what an author used to
 * write with `defineScript`, minus the function that no longer exists: a lone
 * script object as the default export. There is no `defineScript` to import
 * any more, so this fixture writes the object literal directly, which is the
 * closest a plugin-less script can now get to existing at all.
 */
const NOT_A_PLUGIN_ENTRY = `
import { z } from 'zod'

export default {
  id: 'checkout',
  version: '1.0.0',
  params: z.object({}),
  run: async () => 'ok',
}
`

// Plan 95 §5 step 95.6 (fixes F2) — a defaulted parameter, published.
const PLUGIN_WITH_DEFAULT_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [{ id: 'checkout', params: z.object({ videos: z.number().int().max(2000).default(30) }), run: async () => 'ok' }],
})
`

// Plan 95 §3.6 — a top-level .refine() the run form cannot evaluate.
const PLUGIN_WITH_REFINE_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [
    {
      id: 'checkout',
      params: z.object({ a: z.number(), b: z.number() }).refine((v) => v.a <= v.b, { message: 'a<=b' }),
      run: async () => 'ok',
    },
  ],
})
`

// A refine on a nested field, plus one with no refinement at all — proves
// the warning names paths (not just a count) and stays silent when clean.
const PLUGIN_WITH_FIELD_REFINE_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [
    { id: 'checkout', params: z.object({ retry: z.object({ n: z.number().refine((v) => v > 0, 'positive') }) }), run: async () => 'ok' },
  ],
})
`

// Plan 95 §4.9, §5 step 95.5 — publish path 3 of 3: a hostile params schema
// (a non-identifier field name) must be refused LOCALLY, before any request
// reaches the fake farm. Plan 110 §4.2 moved that gate from the deleted
// single-script publish path onto every MEMBER of the plugin.
const PLUGIN_WITH_HOSTILE_PARAMS_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [
    { id: 'browse', params: z.object({ fine: z.string() }), run: async () => 'ok' },
    { id: 'checkout', params: z.object({ 'bad name': z.string() }), run: async () => 'ok' },
  ],
})
`

// Plan 97 §4.4 — the RESULT half of the same local gate, per member.
const PLUGIN_WITH_HOSTILE_RESULT_ENTRY = `
import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [
    { id: 'checkout', params: z.object({}), result: z.object({ 'bad name': z.string() }), run: async () => ({ 'bad name': 'x' }) },
  ],
})
`

// A group used non-consecutively — a WARNING, not a rejection.
const PLUGIN_WITH_NONCONSECUTIVE_GROUP_ENTRY = `
import { definePlugin, ui } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'shop',
  version: '1.0.0',
  scripts: [
    {
      id: 'checkout',
      params: z.object({
        a1: z.string().meta(ui({ title: 'A1', group: 'A' })),
        b1: z.string().meta(ui({ title: 'B1', group: 'B' })),
        a2: z.string().meta(ui({ title: 'A2', group: 'A' })),
      }),
      run: async () => 'ok',
    },
  ],
})
`

interface CapturedRequest {
  method: string
  path: string
  query: string
  contentType: string
  body: unknown
  /** The raw bytes, always — the only way to see a `.enkaku` package (plan 111 §5 step 111.6), which is posted as `application/octet-stream` and never parses as JSON. */
  raw: Uint8Array
}

function fakeFarm(respond: (req: CapturedRequest) => { status: number; body: unknown }): { url: string; server: Server<undefined>; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const raw = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0)
      let body: unknown = null
      try {
        body = JSON.parse(new TextDecoder().decode(raw)) as unknown
      } catch {
        body = null
      }
      const captured = { method: req.method, path: url.pathname, query: url.search, contentType: req.headers.get('content-type') ?? '', body, raw }
      requests.push(captured)
      const res = respond(captured)
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } })
    },
  })
  return { url: `http://localhost:${server.port}`, server, requests }
}

/**
 * Reads back a `.enkaku` archive — gzip over the USTAR subset
 * `enkaku-package.ts` writes. Hand-rolled here rather than imported from the
 * core's `backup/tar.ts` because `enkaku-core` depends on `@enkaku/sdk` and
 * this package must not import it back; the FORMAT's real compatibility is
 * asserted the other way round, in `packages/core/src/plugins/package.test.ts`,
 * where the farm's own reader consumes this writer's output.
 */
function readArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  const tar = Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>)
  const dec = new TextDecoder()
  const out: Record<string, Uint8Array> = {}
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = dec.decode(header.subarray(0, 100)).replace(/\0[\s\S]*$/, '')
    const size = Number.parseInt(dec.decode(header.subarray(124, 136)).replace(/\0[\s\S]*$/, '').trim() || '0', 8)
    offset += 512
    out[name] = tar.slice(offset, offset + size)
    offset += size + ((512 - (size % 512)) % 512)
  }
  return out
}

function textOf(archive: Record<string, Uint8Array>, entry: string): string {
  const bytes = archive[entry]
  if (!bytes) throw new Error(`the archive has no "${entry}" — it holds ${Object.keys(archive).join(', ')}`)
  return new TextDecoder().decode(bytes)
}

/**
 * A plugin project with a React half but NO declared surface, written by hand.
 *
 * The surface is the one thing it cannot declare yet: `react` as a view
 * renderer is step 111.4's change to `packages/protocol/src/plugin-surface.ts`,
 * and `definePlugin` validates the surface at import time through the very
 * same `validatePluginSurface` the farm runs — so a fixture declaring one
 * would fail to build for a reason that has nothing to do with what these
 * tests are about (the transport, the build flags, and the JSX transform).
 * `REACT_SURFACE_SUPPORTED` below guards the tests that DO need it.
 */
function uiProject(entryBody?: string): string {
  const dir = fixtureDir()
  mkdirSync(join(dir, 'src', 'ui'), { recursive: true })
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

export default definePlugin({
  id: 'tiktok',
  version: '1.0.0',
  scripts: [{ id: 'login', params: z.object({}), run: async () => 'ok' }],
})
`,
  )
  writeFileSync(
    join(dir, 'src', 'ui', 'index.tsx'),
    entryBody ??
      `import { useState } from 'react'

function View() {
  const [n, setN] = useState(0)
  return <button type="button" onClick={() => setN(n + 1)}>ORIGINAL {n}</button>
}

;(window as unknown as { __enkaku__: { register(id: string, c: unknown): void } }).__enkaku__.register('main', View)
`,
  )
  return join(dir, 'src', 'index.ts')
}

/**
 * Is `react` a legal view renderer yet? That is step 111.4's change to the
 * protocol, and this step (111.6) is deliberately allowed to land beside it:
 * the scaffold is written for the finished vocabulary, and the two tests that
 * need `definePlugin` to ACCEPT it are skipped until it does, rather than
 * being written against a shape that will be wrong next week.
 */
const REACT_SURFACE_SUPPORTED = await (async () => {
  const { validatePluginSurface } = (await import('@enkaku/protocol')) as { validatePluginSurface: (v: unknown) => { ok: boolean } }
  return validatePluginSurface({
    nav: [{ id: 'x', label: 'X', icon: 'puzzle', view: 'main' }],
    views: { main: { title: 'X', react: { entry: 'index.js', apiVersion: 1 } } },
  }).ok
})()

/** Spawns the real CLI as a child process and waits for it to exit. */
async function runCli(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}) })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

/**
 * What `bun install` would do inside a freshly scaffolded project, done by
 * hand: the scaffold DECLARES `@enkaku/sdk` and `zod` in its own
 * `package.json`, and this satisfies those two declarations from the
 * workspace. Without it neither `tsc` nor `Bun.build` can resolve them — the
 * scaffold sits inside `packages/sdk`, and its own `package.json` stops
 * Node's self-reference resolution from reaching the SDK the way a bare
 * fixture file does.
 */
function installWorkspaceDeps(dir: string): void {
  const nm = join(dir, 'node_modules')
  mkdirSync(join(nm, '@enkaku'), { recursive: true })
  mkdirSync(join(nm, '@types'), { recursive: true })
  symlinkSync(join(REPO_ROOT, 'packages/sdk'), join(nm, '@enkaku/sdk'), 'dir')
  symlinkSync(join(REPO_ROOT, 'packages/protocol'), join(nm, '@enkaku/protocol'), 'dir')
  symlinkSync(join(REPO_ROOT, 'packages/sdk/node_modules/zod'), join(nm, 'zod'), 'dir')
  // The React half's two devDependencies (plan 111 §5 step 111.6). They are
  // needed by `tsc` only — the UI build marks `react` external and Studio
  // supplies its own instance at runtime — and they come from Studio's
  // node_modules because that is where this workspace's React 19 lives.
  symlinkSync(join(REPO_ROOT, 'packages/studio/node_modules/react'), join(nm, 'react'), 'dir')
  symlinkSync(join(REPO_ROOT, 'packages/studio/node_modules/@types/react'), join(nm, '@types/react'), 'dir')
  // `@enkaku/ui` is external at runtime too, but the scaffold's
  // `src/ui/index.css` imports `@enkaku/ui/theme.css` (plan 111 step 111.9) —
  // so without this the scaffolded project no longer compiles its stylesheet.
  // `@tailwindcss/cli` and `tailwindcss` are ROOT devDependencies and resolve
  // by walking up from a fixture that lives inside this repo.
  symlinkSync(join(REPO_ROOT, 'packages/ui'), join(nm, '@enkaku/ui'), 'dir')
}

describe('enkaku publish — a plugin is the only thing that publishes (plan 82 §5 step 12, plan 110 §5 step 110.4)', () => {
  test('a definePlugin() entry publishes through POST /api/plugins with {name, version, bundle}', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({
      status: 201,
      body: { plugin: { id: 'p1', status: 'active' }, verify: { ok: true, scripts: [{ id: 'login' }, { id: 'warmup' }], resetPackages: [] } },
    }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/plugins')
      const body = requests[0]?.body as { name: string; version: string; bundle: string; stageOnly?: boolean }
      expect(body.name).toBe('tiktok')
      expect(body.version).toBe('1.0.0')
      expect(body.bundle.length).toBeGreaterThan(0)
      expect(body.stageOnly).toBeUndefined()
      expect(result.stdout).toContain('staged plugin tiktok@1.0.0')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('--stage-only sets stageOnly: true on the request body', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url, '--stage-only'])
      expect(result.exitCode).toBe(0)
      const body = requests[0]?.body as { stageOnly?: boolean }
      expect(body.stageOnly).toBe(true)
      expect(result.stdout).toContain('--stage-only')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('an entry that is NOT a plugin is refused — exit 1, nothing sent, and the message carries the wrapper itself (plan 110 criterion 6)', async () => {
    const entry = writeFixture(NOT_A_PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: {} }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(requests).toHaveLength(0)
      // The refusal has to be fixable from the error text alone.
      expect(result.stderr).toContain('a script cannot be published on its own')
      expect(result.stderr).toContain("import { definePlugin } from '@enkaku/sdk'")
      expect(result.stderr).toContain('export default definePlugin({')
      expect(result.stderr).toContain("id: 'my-plugin'")
      expect(result.stderr).toContain("version: '1.0.0'")
      expect(result.stderr).toContain('scripts: [{')
      expect(result.stderr).toContain('enkaku init my-plugin')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a defaulted parameter publishes cleanly — the local gate does not mistake a `.default()` for a defect', async () => {
    const entry = writeFixture(PLUGIN_WITH_DEFAULT_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/plugins')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a top-level .refine() prints a publish-time warning naming the script and the path, and still publishes (exit 0)', async () => {
    const entry = writeFixture(PLUGIN_WITH_REFINE_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('warning: script "checkout": params carries 1 refinement that the run form cannot evaluate')
      expect(result.stdout).toContain('(top level)')
      expect(result.stdout).toContain('Operators will see it as a job failure, not a form error')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a field-level .refine() names the dotted path, not just a count', async () => {
    const entry = writeFixture(PLUGIN_WITH_FIELD_REFINE_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('params carries 1 refinement')
      expect(result.stdout).toContain('retry.n')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a schema with no refinement at all prints no warning', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('refinement')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a hostile params schema on ONE member is refused LOCALLY — exit 1, naming the member, no request ever reaches the farm (plan 95 §4.9)', async () => {
    const entry = writeFixture(PLUGIN_WITH_HOSTILE_PARAMS_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('bad name')
      expect(result.stderr).toContain('script "checkout"')
      expect(requests).toHaveLength(0)
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a hostile RESULT schema is refused locally too, named as the result (plan 97 §4.4)', async () => {
    const entry = writeFixture(PLUGIN_WITH_HOSTILE_RESULT_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('result schema violates the published limits')
      expect(requests).toHaveLength(0)
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a non-consecutive group prints a warning and still publishes — warnings do not block (plan 95 §3.5)', async () => {
    const entry = writeFixture(PLUGIN_WITH_NONCONSECUTIVE_GROUP_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('warning:')
      expect(result.stdout).toContain('not consecutive')
      expect(requests).toHaveLength(1)
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a failed verify on a plugin publish reports the error and exits non-zero', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server } = fakeFarm(() => ({
      status: 201,
      body: { plugin: { id: 'p1', status: 'failed' }, verify: { ok: false, scripts: [], resetPackages: [], error: 'boom', errorCode: 'E_X' } },
    }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('E_X')
      expect(result.stdout).toContain('boom')
    } finally {
      server.stop(true)
    }
  }, 30000)
})

describe('enkaku publish — a project with a ui/ directory ships a .enkaku package (plan 111 §5 step 111.6)', () => {
  test('posts a raw archive as application/octet-stream, carrying plugin.json, scripts.mjs and ui/index.js', async () => {
    const entry = uiProject()
    const { url, server, requests } = fakeFarm(() => ({
      status: 201,
      body: { plugin: { id: 'p1', status: 'active' }, verify: { ok: true, scripts: [{ id: 'login' }], resetPackages: [] } },
    }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/plugins')
      expect(requests[0]?.contentType).toBe('application/octet-stream')
      // Not JSON at all — the point of the archive is that 8 MiB of assets
      // never pay base64's +33%.
      expect(requests[0]?.body).toBeNull()

      const archive = readArchive(requests[0]?.raw as Uint8Array)
      expect(Object.keys(archive).sort()).toEqual(['plugin.json', 'scripts.mjs', 'ui/index.js'])
      const manifest = JSON.parse(textOf(archive, 'plugin.json')) as { name: string; version: string; source?: string }
      expect(manifest.name).toBe('tiktok')
      expect(manifest.version).toBe('1.0.0')
      expect(textOf(archive, 'scripts.mjs').length).toBeGreaterThan(0)
      expect(textOf(archive, 'ui/index.js')).toContain('ORIGINAL')
      expect(result.stdout).toContain('sent as a .enkaku package')
    } finally {
      server.stop(true)
    }
  }, 60000)

  test('--stage-only moves onto the query string, since an archive has no room for a body flag', async () => {
    const entry = uiProject()
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url, '--stage-only'])
      expect(result.exitCode).toBe(0)
      expect(requests[0]?.query).toBe('?stageOnly=1')
    } finally {
      server.stop(true)
    }
  }, 60000)

  test('a project with NO ui/ directory keeps the JSON transport untouched', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests[0]?.contentType).toBe('application/json')
      expect((requests[0]?.body as { bundle: string }).bundle.length).toBeGreaterThan(0)
      expect(result.stdout).not.toContain('.enkaku package')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('static files under ui/ ride along verbatim, and nested .tsx sources do NOT (the bundler already inlined them)', async () => {
    const entry = uiProject()
    const uiDir = join(entry, '..', 'ui')
    mkdirSync(join(uiDir, 'parts'), { recursive: true })
    writeFileSync(join(uiDir, 'styles.css'), '.plugin { color: red }')
    writeFileSync(join(uiDir, 'parts', 'Badge.tsx'), 'export function Badge() { return null }\n')
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      const archive = readArchive(requests[0]?.raw as Uint8Array)
      expect(Object.keys(archive).sort()).toEqual(['plugin.json', 'scripts.mjs', 'ui/index.js', 'ui/styles.css'])
      expect(textOf(archive, 'ui/styles.css')).toBe('.plugin { color: red }')
    } finally {
      server.stop(true)
    }
  }, 60000)
})

describe('defineScript is gone from the public surface (plan 110 §4.2, criterion 6)', () => {
  test('`@enkaku/sdk` exports definePlugin but no defineScript', async () => {
    const sdk = (await import('../index')) as Record<string, unknown>
    expect(typeof sdk.definePlugin).toBe('function')
    expect(sdk.defineScript).toBeUndefined()
    expect(Object.keys(sdk)).not.toContain('defineScript')
  })

  test('importing `defineScript` from the package fails to resolve at all', async () => {
    const entry = writeFixture(`
import { defineScript } from '@enkaku/sdk'
export default defineScript
`)
    const { url, server } = fakeFarm(() => ({ status: 201, body: {} }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(`${result.stdout}${result.stderr}`).toContain('defineScript')
    } finally {
      server.stop(true)
    }
  }, 30000)
})

describe('enkaku init — scaffolds a plugin project that publishes with no edits (plan 110 §4.2, §5 step 110.4)', () => {
  test('writes package.json, tsconfig.json and src/index.ts, and says what to do next', async () => {
    const cwd = fixtureDir()
    const result = await runCli(['init', 'my-pack'], cwd)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(cwd, 'my-pack/package.json'))).toBe(true)
    expect(existsSync(join(cwd, 'my-pack/tsconfig.json'))).toBe(true)
    expect(existsSync(join(cwd, 'my-pack/src/index.ts'))).toBe(true)
    expect(result.stdout).toContain('enkaku publish src/index.ts')

    const pkg = JSON.parse(readFileSync(join(cwd, 'my-pack/package.json'), 'utf8')) as {
      name: string
      dependencies: Record<string, string>
    }
    expect(pkg.name).toBe('my-pack')
    expect(pkg.dependencies['@enkaku/sdk']).toBeDefined()
    expect(pkg.dependencies['zod']).toBeDefined()
  }, 30000)

  test("the scaffolded entry's member carries a title and a description — the farm surfaces both", async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack'], cwd)
    const src = readFileSync(join(cwd, 'my-pack/src/index.ts'), 'utf8')
    expect(src).toContain("id: 'my-pack'")
    expect(src).toContain('title:')
    expect(src).toContain('description:')
    expect(src).toContain('definePlugin({')
  }, 30000)

  test.skipIf(!REACT_SURFACE_SUPPORTED)('the scaffolded project typechecks with its own tsconfig, with no edits', async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack'], cwd)
    const dir = join(cwd, 'my-pack')
    installWorkspaceDeps(dir)
    const tsc = join(REPO_ROOT, 'node_modules/.bin/tsc')
    const proc = Bun.spawn([tsc, '--noEmit', '-p', dir], { stdout: 'pipe', stderr: 'pipe' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out).toBe('')
    expect(exitCode).toBe(0)
  }, 120000)

  test.skipIf(!REACT_SURFACE_SUPPORTED)('the scaffolded entry publishes as a plugin, with no edits (criterion 6)', async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack'], cwd)
    const dir = join(cwd, 'my-pack')
    installWorkspaceDeps(dir)
    const { url, server, requests } = fakeFarm(() => ({
      status: 201,
      body: { plugin: { id: 'p1', status: 'active' }, verify: { ok: true, scripts: [{ id: 'main' }], resetPackages: [] } },
    }))
    try {
      const result = await runCli(['publish', join(dir, 'src/index.ts'), '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests[0]?.path).toBe('/api/plugins')
      // The React scaffold ships assets, so it goes out as a package — its
      // `name`/`version` are in `plugin.json`, not in a JSON body.
      const archive = readArchive(requests[0]?.raw as Uint8Array)
      const manifest = JSON.parse(textOf(archive, 'plugin.json')) as { name: string; version: string }
      expect(manifest.name).toBe('my-pack')
      expect(manifest.version).toBe('1.0.0')
      expect(textOf(archive, 'ui/index.js')).not.toContain('jsx-dev-runtime')
      // The scaffold's stylesheet compiles and ships beside the module (plan
      // 111 step 111.9), carrying the classes its own component uses and
      // NOT Tailwind's global reset — `build-ui.test.ts` is where that
      // contract is pinned down in detail.
      const css = textOf(archive, 'ui/index.css')
      expect(css).toContain('.text-fg-muted')
      expect(css).not.toContain('-webkit-text-size-adjust')
    } finally {
      server.stop(true)
    }
  }, 60000)

  test('--script-only still writes the three-file project, with no ui/ and no react dependency', async () => {
    const cwd = fixtureDir()
    const result = await runCli(['init', 'my-pack', '--script-only'], cwd)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(cwd, 'my-pack/src/index.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'my-pack/src/ui/index.tsx'))).toBe(false)
    const pkg = JSON.parse(readFileSync(join(cwd, 'my-pack/package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies['react']).toBeUndefined()
    expect(readFileSync(join(cwd, 'my-pack/src/index.ts'), 'utf8')).not.toContain('surface:')
  }, 30000)

  test('a --script-only project publishes through the JSON transport, exactly as before this step', async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack', '--script-only'], cwd)
    const dir = join(cwd, 'my-pack')
    installWorkspaceDeps(dir)
    const { url, server, requests } = fakeFarm(() => ({
      status: 201,
      body: { plugin: { id: 'p1', status: 'active' }, verify: { ok: true, scripts: [{ id: 'main' }], resetPackages: [] } },
    }))
    try {
      const result = await runCli(['publish', join(dir, 'src/index.ts'), '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests[0]?.contentType).toBe('application/json')
      const body = requests[0]?.body as { name: string; version: string; bundle: string }
      expect(body.name).toBe('my-pack')
      expect(body.bundle.length).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  }, 60000)

  /**
   * The scaffold's OWN React component and its OWN build config, exercised
   * today: the surface is the only thing 111.4 still owes, so this test keeps
   * the scaffolded `src/ui/index.tsx` verbatim and swaps only `src/index.ts`
   * for a surface-less plugin. If the scaffold's JSX, its import of `react`,
   * or the CLI's build flags were wrong, this fails — and it fails on the
   * exact bytes an author would ship.
   */
  test("the scaffold's React entry builds with the PRODUCTION JSX transform — no react/jsx-dev-runtime anywhere in the output", async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack'], cwd)
    const dir = join(cwd, 'my-pack')
    installWorkspaceDeps(dir)
    writeFileSync(
      join(dir, 'src/index.ts'),
      `import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'
export default definePlugin({ id: 'my-pack', version: '1.0.0', scripts: [{ id: 'main', params: z.object({}), run: async () => 'ok' }] })
`,
    )
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { plugin: { id: 'p1', status: 'staged' } } }))
    try {
      const result = await runCli(['publish', join(dir, 'src/index.ts'), '--farm', url])
      expect(result.exitCode).toBe(0)
      const archive = readArchive(requests[0]?.raw as Uint8Array)
      const built = textOf(archive, 'ui/index.js')
      expect(built).not.toContain('jsx-dev-runtime')
      expect(built).toContain('react/jsx-runtime')
      // React is the HOST's instance — it must be left as a bare specifier,
      // never inlined (two Reacts in one page throw `Invalid hook call`).
      expect(built).toContain('"react"')
      expect(built).toContain('useState')
    } finally {
      server.stop(true)
    }
  }, 60000)

  /**
   * The scaffold's tsconfig and its `src/enkaku-host.d.ts`, checked today —
   * same swap as the test above, for the same reason. `jsx: 'react-jsx'` in
   * the tsconfig governs `tsc` ONLY (Bun's bundler ignores it entirely, which
   * is the whole reason `build-ui.ts` passes `--production` on the command
   * line); both halves have to be right and neither implies the other, so
   * both are tested.
   */
  test("the scaffold's tsconfig typechecks its React half, with no edits beyond the pending 111.4 surface", async () => {
    const cwd = fixtureDir()
    await runCli(['init', 'my-pack'], cwd)
    const dir = join(cwd, 'my-pack')
    installWorkspaceDeps(dir)
    writeFileSync(
      join(dir, 'src/index.ts'),
      `import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'
export default definePlugin({ id: 'my-pack', version: '1.0.0', scripts: [{ id: 'main', params: z.object({}), run: async () => 'ok' }] })
`,
    )
    const tsc = join(REPO_ROOT, 'node_modules/.bin/tsc')
    const proc = Bun.spawn([tsc, '--noEmit', '-p', dir], { stdout: 'pipe', stderr: 'pipe' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(out).toBe('')
    expect(exitCode).toBe(0)
  }, 120000)

  test('refuses an existing NON-EMPTY directory rather than overwriting it', async () => {
    const cwd = fixtureDir()
    mkdirSync(join(cwd, 'my-pack'), { recursive: true })
    writeFileSync(join(cwd, 'my-pack/keep.txt'), 'precious')
    const result = await runCli(['init', 'my-pack'], cwd)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('already exists and is not empty')
    expect(readFileSync(join(cwd, 'my-pack/keep.txt'), 'utf8')).toBe('precious')
    expect(existsSync(join(cwd, 'my-pack/package.json'))).toBe(false)
  }, 30000)

  test('an existing EMPTY directory is fine — `mkdir foo && cd foo` is a normal way to start', async () => {
    const cwd = fixtureDir()
    mkdirSync(join(cwd, 'my-pack'), { recursive: true })
    const result = await runCli(['init', 'my-pack'], cwd)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(cwd, 'my-pack/package.json'))).toBe(true)
  }, 30000)

  test('refuses a name that is not a usable plugin id', async () => {
    const cwd = fixtureDir()
    const result = await runCli(['init', 'My Pack'], cwd)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not a usable plugin id')
  }, 30000)

  test('with no name at all it prints the usage and exits non-zero', async () => {
    const result = await runCli(['init'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('a plugin name is required')
    expect(result.stdout).toContain('enkaku init <name>')
  }, 30000)
})

describe('enkaku dev — pushes a plugin bundle to POST /api/plugins/dev (plan 82 §5 step 12)', () => {
  test('a one-shot push (--no-watch) posts {name, bundle} with the dev-owner header set', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 200, body: { ok: true, scripts: [{ id: 'login' }, { id: 'warmup' }], resetPackages: [] } }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch'])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/plugins/dev')
      const body = requests[0]?.body as { name: string; bundle: string }
      expect(body.name).toBe('tiktok')
      expect(body.bundle.length).toBeGreaterThan(0)
      expect(result.stdout).toContain('pushed tiktok@1.0.0+dev')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('an entry that is not a plugin is refused with the SAME wrapper `enkaku publish` shows', async () => {
    const entry = writeFixture(NOT_A_PLUGIN_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 200, body: {} }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('a script cannot be published on its own')
      expect(result.stderr).toContain('export default definePlugin({')
      expect(result.stderr).toContain('enkaku init my-plugin')
    } finally {
      server.stop(true)
    }
  }, 30000)

  /**
   * Plan 111 §4.4 — the gap plan 108 §9 Q3 named. A dev slot used to be built
   * from a bare bundle, so a React view could not be iterated at all.
   */
  test('a project with a ui/ directory posts a PACKAGE to /api/plugins/dev, with the dev-owner header still set', async () => {
    const entry = uiProject()
    const { url, server, requests } = fakeFarm(() => ({ status: 200, body: { ok: true, scripts: [{ id: 'login' }], resetPackages: [] } }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch'])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/plugins/dev')
      expect(requests[0]?.contentType).toBe('application/octet-stream')
      const archive = readArchive(requests[0]?.raw as Uint8Array)
      expect(Object.keys(archive).sort()).toEqual(['plugin.json', 'scripts.mjs', 'ui/index.js'])
      // The slot is named by the manifest, not by a query parameter — one
      // place for both transports.
      expect((JSON.parse(textOf(archive, 'plugin.json')) as { name: string }).name).toBe('tiktok')
      expect(result.stdout).toContain('1 ui file')
    } finally {
      server.stop(true)
    }
  }, 60000)

  test('--name renames the slot through the package manifest', async () => {
    const entry = uiProject()
    const { url, server, requests } = fakeFarm(() => ({ status: 200, body: { ok: true, scripts: [{ id: 'login' }], resetPackages: [] } }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch', '--name', 'scratch'])
      expect(result.exitCode).toBe(0)
      const archive = readArchive(requests[0]?.raw as Uint8Array)
      expect((JSON.parse(textOf(archive, 'plugin.json')) as { name: string }).name).toBe('scratch')
    } finally {
      server.stop(true)
    }
  }, 60000)

  test('a rebuild after editing the React source pushes the NEW assets — the whole point of the loop', async () => {
    const entry = uiProject()
    const { url, server, requests } = fakeFarm(() => ({ status: 200, body: { ok: true, scripts: [{ id: 'login' }], resetPackages: [] } }))
    try {
      expect((await runCli(['dev', entry, '--farm', url, '--no-watch'])).exitCode).toBe(0)
      writeFileSync(
        join(entry, '..', 'ui', 'index.tsx'),
        `import { useState } from 'react'

function View() {
  const [n, setN] = useState(0)
  return <button type="button" onClick={() => setN(n + 1)}>REBUILT {n}</button>
}

;(window as unknown as { __enkaku__: { register(id: string, c: unknown): void } }).__enkaku__.register('main', View)
`,
      )
      expect((await runCli(['dev', entry, '--farm', url, '--no-watch'])).exitCode).toBe(0)

      expect(requests).toHaveLength(2)
      const first = textOf(readArchive(requests[0]?.raw as Uint8Array), 'ui/index.js')
      const second = textOf(readArchive(requests[1]?.raw as Uint8Array), 'ui/index.js')
      expect(first).toContain('ORIGINAL')
      expect(second).toContain('REBUILT')
      expect(second).not.toContain('ORIGINAL')
      expect(second).not.toContain('jsx-dev-runtime')
    } finally {
      server.stop(true)
    }
  }, 90000)

  test('a project with no ui/ still posts { name, bundle } as JSON — the bundle transport is untouched', async () => {
    const entry = writeFixture(PLUGIN_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 200, body: { ok: true, scripts: [{ id: 'login' }], resetPackages: [] } }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch'])
      expect(result.exitCode).toBe(0)
      expect(requests[0]?.contentType).toBe('application/json')
      expect((requests[0]?.body as { name: string }).name).toBe('tiktok')
    } finally {
      server.stop(true)
    }
  }, 30000)
})
