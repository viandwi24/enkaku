import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'bun'

/**
 * Plan 82 §5 step 12 — `enkaku publish` detecting a plugin entry and
 * `--stage-only`, plus `enkaku dev`. Both exercised by spawning the REAL
 * CLI entry (`index.ts`) as a genuine child process against a REAL
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
const FIXTURE_ROOT = join(import.meta.dir, '.test-fixtures')
mkdirSync(FIXTURE_ROOT, { recursive: true })

const dirs: string[] = []
function writeFixture(content: string): string {
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'fx-'))
  dirs.push(dir)
  const path = join(dir, 'entry.ts')
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

const SCRIPT_ENTRY = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({}),
  run: async () => 'ok',
})
`

// Plan 95 §5 step 95.6 (fixes F2) — a defaulted parameter, published.
const SCRIPT_WITH_DEFAULT_ENTRY = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({ videos: z.number().int().max(2000).default(30) }),
  run: async () => 'ok',
})
`

// Plan 95 §3.6 — a top-level .refine() the run form cannot evaluate.
const SCRIPT_WITH_REFINE_ENTRY = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({ a: z.number(), b: z.number() }).refine((v) => v.a <= v.b, { message: 'a<=b' }),
  run: async () => 'ok',
})
`

// A refine on a nested field, plus one with no refinement at all — proves
// the warning names paths (not just a count) and stays silent when clean.
const SCRIPT_WITH_FIELD_REFINE_ENTRY = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({ retry: z.object({ n: z.number().refine((v) => v > 0, 'positive') }) }),
  run: async () => 'ok',
})
`

// Plan 95 §4.9, §5 step 95.5 — publish path 3 of 3: a hostile params schema
// (a non-identifier field name) must be refused LOCALLY, before any request
// reaches the fake farm.
const SCRIPT_WITH_HOSTILE_PARAMS_ENTRY = `
import { defineScript } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({ 'bad name': z.string() }),
  run: async () => 'ok',
})
`

// A group used non-consecutively — a WARNING, not a rejection.
const SCRIPT_WITH_NONCONSECUTIVE_GROUP_ENTRY = `
import { defineScript, ui } from '@enkaku/sdk'
import { z } from 'zod'

export default defineScript({
  id: 'checkout',
  version: '1.0.0',
  params: z.object({
    a1: z.string().meta(ui({ title: 'A1', group: 'A' })),
    b1: z.string().meta(ui({ title: 'B1', group: 'B' })),
    a2: z.string().meta(ui({ title: 'A2', group: 'A' })),
  }),
  run: async () => 'ok',
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
async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('enkaku publish — detects a plugin entry and posts to /api/plugins, not /api/scripts (plan 82 §5 step 12)', () => {
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

  test('a defineScript() entry still publishes through POST /api/scripts, unchanged', async () => {
    const entry = writeFixture(SCRIPT_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.path).toBe('/api/scripts')
      const body = requests[0]?.body as { name: string; paramsSchema: unknown }
      expect(body.name).toBe('checkout')
      expect(body.paramsSchema).toBeTruthy()
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a defaulted parameter is published with io: "input" — NOT marked required (plan 95 §5 step 95.6, fixes F2)', async () => {
    const entry = writeFixture(SCRIPT_WITH_DEFAULT_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      const body = requests[0]?.body as { paramsSchema: { required?: string[] } }
      // io: 'output' (the old default) would put `videos` in `required`
      // because it has a `.default()` — io: 'input' does not.
      expect(body.paramsSchema.required ?? []).not.toContain('videos')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a top-level .refine() prints a publish-time warning naming it, and still publishes (exit 0)', async () => {
    const entry = writeFixture(SCRIPT_WITH_REFINE_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('warning: params carries 1 refinement that the run form cannot evaluate')
      expect(result.stdout).toContain('(top level)')
      expect(result.stdout).toContain('Operators will see it as a job failure, not a form error')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a field-level .refine() names the dotted path, not just a count', async () => {
    const entry = writeFixture(SCRIPT_WITH_FIELD_REFINE_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('warning: params carries 1 refinement')
      expect(result.stdout).toContain('retry.n')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a schema with no refinement at all prints no warning', async () => {
    const entry = writeFixture(SCRIPT_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('refinement')
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a hostile params schema is refused LOCALLY — exit 1, no request ever reaches the farm (plan 95 §4.9, §5 step 95.5)', async () => {
    const entry = writeFixture(SCRIPT_WITH_HOSTILE_PARAMS_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
    try {
      const result = await runCli(['publish', entry, '--farm', url])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('bad name')
      expect(requests).toHaveLength(0)
    } finally {
      server.stop(true)
    }
  }, 30000)

  test('a non-consecutive group prints a warning and still publishes — warnings do not block (plan 95 §3.5)', async () => {
    const entry = writeFixture(SCRIPT_WITH_NONCONSECUTIVE_GROUP_ENTRY)
    const { url, server, requests } = fakeFarm(() => ({ status: 201, body: { script: { id: 's1' } } }))
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

  test('a standalone (defineScript) entry is refused with a named error, pointing at `enkaku publish` instead', async () => {
    const entry = writeFixture(SCRIPT_ENTRY)
    const { url, server } = fakeFarm(() => ({ status: 200, body: {} }))
    try {
      const result = await runCli(['dev', entry, '--farm', url, '--no-watch'])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('enkaku publish')
    } finally {
      server.stop(true)
    }
  }, 30000)
})
