import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { ToolchainManager, type ToolInstallRecord, type ToolInstallStore } from './manager'

/** A minimal in-memory install store — good enough for `deviceArtifactExpectation`, which never touches it. */
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

/**
 * Writes tools/<toolId>/<version>/<entrypoint> plus active.json by hand —
 * avoids driving a real download through `activate()`. Must run BEFORE
 * `manager.init()`: `reconcile()` clears any pointer whose version folder
 * does not exist on disk (plan 02 §3.3), so the file has to be there first.
 */
function pinActivePointer(dataDir: string, toolId: string, version: string, entrypoint: string): void {
  const versionDir = join(dataDir, 'tools', toolId, version)
  const entrypointPath = join(versionDir, entrypoint)
  mkdirSync(dirname(entrypointPath), { recursive: true })
  writeFileSync(entrypointPath, 'fake')
  writeFileSync(
    join(dataDir, 'tools', toolId, 'active.json'),
    JSON.stringify({ version, sha256: 'a'.repeat(64), activatedAt: Math.floor(Date.now() / 1000) }),
  )
}

const sha256 = (data: Uint8Array): string => new Bun.CryptoHasher('sha256').update(data).digest('hex')

/**
 * Overrides the bundled manifest for one tool so the install can be driven
 * against a local server instead of the network.
 */
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

describe('ToolchainManager.install (plan 02 §4.10)', () => {
  test('a raw artifact lands in its final folder without a directory rename', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    const apk = new TextEncoder().encode('fake-apk-payload')
    const server = Bun.serve({ port: 0, fetch: () => new Response(apk) })
    try {
      mkdirSync(dataDir, { recursive: true })
      writeManifestCache(dataDir, [
        {
          id: 'ui-server',
          displayName: 'ui-server',
          swappable: false,
          format: 'raw',
          url: `http://127.0.0.1:${server.port}/app.apk`,
          artifact: apk,
        },
      ])
      const store = fakeStore()
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store })
      await manager.init()
      // A single-file tool must never build a staging DIRECTORY — moving a
      // directory is the operation Windows fails under an AV scanner. Parking a
      // file on that path makes any attempt to create it blow up loudly.
      writeFileSync(join(dataDir, 'tools', '.staging', 'ui-server-9.9.9'), 'tripwire')

      // ensureRequiredTools drives install + activate the way the boot does.
      await manager.ensureRequiredTools(['ui-server'])

      const entry = join(dataDir, 'tools', 'ui-server', '9.9.9', 'ui-server.apk')
      expect(readFileSync(entry, 'utf8')).toBe('fake-apk-payload')
      expect(await manager.activeVersion('ui-server')).toBe('9.9.9')
    } finally {
      server.stop(true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a failed install leaves no half-populated version folder behind', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    const apk = new TextEncoder().encode('fake-apk-payload')
    // Serve something else → the sha256 check fails mid-install.
    const server = Bun.serve({ port: 0, fetch: () => new Response('tampered') })
    try {
      writeManifestCache(dataDir, [
        {
          id: 'ui-server',
          displayName: 'ui-server',
          swappable: false,
          format: 'raw',
          url: `http://127.0.0.1:${server.port}/app.apk`,
          artifact: apk,
        },
      ])
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      await expect(manager.ensureRequiredTools(['ui-server'])).rejects.toThrow(/sha256 mismatch/)
      expect(existsSync(join(dataDir, 'tools', 'ui-server', '9.9.9'))).toBe(false)
      expect(readdirSync(join(dataDir, 'tools', '.staging'))).toEqual([])
    } finally {
      server.stop(true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('a zip artifact is extracted in staging and moved into place as one tree', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    const zip = zipSync({ 'platform-tools/adb': new TextEncoder().encode('fake-adb') })
    const server = Bun.serve({ port: 0, fetch: () => new Response(zip) })
    try {
      writeManifestCache(dataDir, [
        {
          id: 'adb',
          displayName: 'adb',
          swappable: true,
          format: 'zip',
          url: `http://127.0.0.1:${server.port}/platform-tools.zip`,
          artifact: zip,
        },
      ])
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      // install only — activating adb would spawn the (fake) binary.
      await manager.install('adb', '9.9.9')

      expect(readFileSync(join(dataDir, 'tools', 'adb', '9.9.9', 'platform-tools', 'adb'), 'utf8')).toBe('fake-adb')
      expect(readdirSync(join(dataDir, 'tools', '.staging'))).toEqual([])
    } finally {
      server.stop(true)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('ToolchainManager.deviceArtifactExpectation (plan 41 §3.2, §4.1)', () => {
  test('returns the bundled manifest deviceArtifact for the active ui-server version', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    try {
      pinActivePointer(dataDir, 'ui-server', '2.3.3', 'ui-server.apk')
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      const expectation = await manager.deviceArtifactExpectation('ui-server')
      expect(expectation).toEqual({ packageName: 'com.github.uiautomator', versionCode: 2003003 })
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('returns null when the tool has no deviceArtifact recorded (older-manifest shape, §3.2)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    try {
      pinActivePointer(dataDir, 'adb', '36.0.0', 'platform-tools/adb')
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      expect(await manager.deviceArtifactExpectation('adb')).toBeNull()
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('returns null for an unknown tool id and for a tool with no active pointer', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-toolchain-'))
    try {
      const manager = new ToolchainManager({ dataDir, coreVersion: '0.0.0-test', store: fakeStore() })
      await manager.init()

      expect(await manager.deviceArtifactExpectation('not-a-real-tool')).toBeNull()
      expect(await manager.deviceArtifactExpectation('ui-server')).toBeNull() // no active.json written
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
