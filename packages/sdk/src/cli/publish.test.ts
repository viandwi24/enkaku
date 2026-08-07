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
