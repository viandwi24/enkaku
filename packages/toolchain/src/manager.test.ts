import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
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
