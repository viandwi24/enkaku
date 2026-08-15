import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from './manager'

/**
 * Spec §16's "First-run provisioning < 90 seconds" NFR (plan 84's audit:
 * nothing in the repo ever asserted any of the seven §16 numbers). The real
 * 90s budget is dominated by internet download speed, which is environment-
 * dependent and cannot be asserted in CI without either flaking on a slow
 * runner or becoming meaningless on a fast one — so this benchmark does NOT
 * attempt to reproduce that number.
 *
 * What it DOES assert is the part of the pipeline `ToolchainManager` actually
 * controls: streaming download+sha256, zip extraction, the atomic move into
 * place, and (for the raw/file-based tools) the activation health check —
 * every step AFTER the bytes leave the network, run here against a loopback
 * `Bun.serve` fixture so the number reflects our own code's overhead, not
 * GitHub's. A regression here (an accidental synchronous full-buffer copy, a
 * quadratic hash loop, extraction that blocks the event loop) would silently
 * eat into the 90s budget in production; this cannot catch a slow CDN, but it
 * can catch our own code getting an order of magnitude slower.
 *
 * Sizes below are chosen to resemble the real artifacts (`REQUIRED_TOOLS` in
 * `packages/core/src/tools/required.ts`): the adb platform-tools zip runs a
 * few MB, the ui-server/ui-server-test APKs and the scrcpy-server jar are
 * each under 2 MB.
 */

function fakeStore(): ToolInstallStore {
  const rows: ToolInstallRecord[] = []
  return {
    list: () => rows,
    listByTool: (toolId) => rows.filter((r) => r.toolId === toolId),
    insert: (rec) => rows.push(rec),
    delete: (toolId, version) => {
      const i = rows.findIndex((r) => r.toolId === toolId && r.version === version)
      if (i >= 0) rows.splice(i, 1)
    },
    setActive: (toolId, version) => {
      for (const r of rows) if (r.toolId === toolId) r.active = r.version === version
    },
  }
}

const sha256 = (data: Uint8Array): string => new Bun.CryptoHasher('sha256').update(data).digest('hex')

/** Deterministic filler — avoids paying `crypto.getRandomValues` cost for a few MB on every test run. */
function fixtureBytes(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 2654435761) & 0xff
  return out
}

function writeManifestCache(
  dataDir: string,
  entries: Array<{ id: string; displayName: string; swappable: boolean; format: 'zip' | 'raw'; url: string; artifact: Uint8Array }>,
): void {
  writeFileSync(
    join(dataDir, 'manifest.cache.json'),
    JSON.stringify({
      manifestVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      tools: entries.map((e) => ({
        id: e.id,
        displayName: e.displayName,
        swappable: e.swappable,
        format: e.format,
        versions: [
          {
            version: '9.9.9',
            releasedAt: 'unknown',
            knownGood: true,
            platforms: { '*': { url: e.url, sha256: sha256(e.artifact), sizeBytes: e.artifact.length } },
          },
        ],
      })),
    }),
  )
}

describe('ToolchainManager pipeline timing (spec §16 "first-run provisioning", plan 84 audit)', () => {
  test('the non-network install pipeline for a realistically-sized zip tool stays well under budget', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-bench-'))
    // ~3 MB, in the ballpark of the real platform-tools zip for one platform.
    const adbPayload = fixtureBytes(3 * 1024 * 1024)
    const zip = zipSync({ 'platform-tools/adb': adbPayload })
    const server = Bun.serve({ port: 0, fetch: () => new Response(zip) })
    try {
      writeManifestCache(dataDir, [
        { id: 'adb', displayName: 'adb', swappable: true, format: 'zip', url: `http://127.0.0.1:${server.port}/platform-tools.zip`, artifact: zip },
      ])
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      // `install()` only — NOT `ensureRequiredTools`/`activate()`: activating
      // adb spawns the binary and expects real `Android Debug Bridge` output
      // (`health.ts#checkAdbBinary`), which a fixture zip cannot provide. This
      // still exercises the exact download→verify→extract→move sequence a
      // real first-run pays for the zip-format tool.
      const t0 = performance.now()
      await manager.install('adb', '9.9.9')
      const elapsedMs = performance.now() - t0

      // Generous on purpose (repo convention, plan 85 §7.4-style thresholds):
      // this is loopback, so a healthy run finishes in well under a second —
      // 8s catches roughly a 10x regression without flaking on a loaded CI box.
      expect(elapsedMs).toBeLessThan(8_000)
    } finally {
      server.stop(true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('the full install+activate pipeline for the raw (apk/jar) required tools stays well under budget', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-bench-'))
    const fixtures = {
      'ui-server': fixtureBytes(1.5 * 1024 * 1024),
      'ui-server-test': fixtureBytes(0.8 * 1024 * 1024),
      'scrcpy-server': fixtureBytes(0.7 * 1024 * 1024),
    }
    const servers = Object.entries(fixtures).map(([id, payload]) => ({
      id,
      payload,
      server: Bun.serve({ port: 0, fetch: () => new Response(payload) }),
    }))
    try {
      writeManifestCache(
        dataDir,
        servers.map(({ id, payload, server }) => ({
          id,
          displayName: id,
          swappable: false,
          format: 'raw' as const,
          url: `http://127.0.0.1:${server.port}/artifact`,
          artifact: payload,
        })),
      )
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      // These three go through `ensureRequiredTools` — install AND activate
      // (`checkFileHash`, no spawn) — mirroring `provisionRequiredTools`'s
      // "optional" loop in `packages/core/src/tools/provision.ts` exactly.
      const t0 = performance.now()
      await manager.ensureRequiredTools(['ui-server', 'ui-server-test', 'scrcpy-server'])
      const elapsedMs = performance.now() - t0

      for (const { id } of servers) {
        expect(await manager.activeVersion(id)).toBe('9.9.9')
      }
      // Same generous, 10x-regression-catching bound as the zip case above.
      expect(elapsedMs).toBeLessThan(8_000)
    } finally {
      for (const { server } of servers) server.stop(true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
