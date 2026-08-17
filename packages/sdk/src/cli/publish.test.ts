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
  body: unknown
}

function fakeFarm(respond: (req: CapturedRequest) => { status: number; body: unknown }): { url: string; server: Server<undefined>; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? await req.json().catch(() => null) : null
      const captured = { method: req.method, path: url.pathname, body }
      requests.push(captured)
      const res = respond(captured)
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } })
    },
  })
  return { url: `http://localhost:${server.port}`, server, requests }
}

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
  symlinkSync(join(REPO_ROOT, 'packages/sdk'), join(nm, '@enkaku/sdk'), 'dir')
  symlinkSync(join(REPO_ROOT, 'packages/protocol'), join(nm, '@enkaku/protocol'), 'dir')
  symlinkSync(join(REPO_ROOT, 'packages/sdk/node_modules/zod'), join(nm, 'zod'), 'dir')
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

  test('the scaffolded project typechecks with its own tsconfig, with no edits', async () => {
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

  test('the scaffolded entry publishes as a plugin, with no edits (criterion 6)', async () => {
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
      const body = requests[0]?.body as { name: string; version: string }
      expect(body.name).toBe('my-pack')
      expect(body.version).toBe('1.0.0')
    } finally {
      server.stop(true)
    }
  }, 60000)

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
})
