import { describe, expect, test } from 'bun:test'
import { createHostAdb, HostAdbError } from './host-adb'

/**
 * `process.execPath` (the bun binary itself) stands in for `adb` here — the
 * same portable "fake external binary" trick `child-entry.test.ts` uses,
 * rather than assuming `/bin/sh` exists on every CI runner (Windows
 * included, which is the whole point of plan 85). `run(['-e', script])`
 * spawns `bun -e '<script>'`, giving each test full control over stdout,
 * stderr, exit code and timing without touching a real adb binary.
 */
const BUN = process.execPath

function hostAdb(
  overrides?: Partial<{ maxHostConcurrent: number; maxInstallConcurrent: number }>,
  // Defaults to one root PER SERIAL — every pre-existing test in this file
  // that does not care about USB roots keeps behaving as it did before plan
  // 223's per-root gate landed; a test that wants two devices to SHARE a
  // root passes its own `usbRootOf`.
  usbRootOf: (serial: string) => Promise<string> = async (serial) => serial,
) {
  const settings = { maxHostConcurrent: 4, maxInstallConcurrent: 2, ...overrides }
  return createHostAdb({
    binaryPath: () => BUN,
    settings: () => settings,
    usbRootOf,
  })
}

function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

describe('createHostAdb — run()', () => {
  test('resolves with stdout on a clean exit', async () => {
    const adb = hostAdb()
    const out = await adb.run(['-e', `process.stdout.write('device attached\\n')`])
    expect(out.trim()).toBe('device attached')
  })

  test('drains stderr concurrently with stdout and surfaces it in the thrown error (regression: the original hostAdb piped stderr and never read it — F11)', async () => {
    const adb = hostAdb()
    // Recreates the field defect exactly: `Performing Streamed Install` on
    // stdout (the useless line the old error carried), the REAL
    // `INSTALL_FAILED_*` reason on stderr, exit code 1.
    const script = `
      process.stdout.write('Performing Streamed Install\\n')
      process.stderr.write('adb: failed to install /tmp/x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: apk sig mismatch]\\n')
      process.exit(1)
    `
    let caught: unknown
    try {
      await adb.run(['-e', script])
      throw new Error('expected run() to reject')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HostAdbError)
    const err = caught as HostAdbError
    expect(err.code).toBe('E_ADB_CLI_FAIL')
    expect(err.exitCode).toBe(1)
    // The old implementation's error carried stdout only — this is the part
    // a happy-path-only test would never have caught.
    expect(err.stderrTail).toContain('INSTALL_FAILED_UPDATE_INCOMPATIBLE')
    expect(err.stdoutTail).toContain('Performing Streamed Install')
    expect(err.message).toContain('INSTALL_FAILED_UPDATE_INCOMPATIBLE')
  })

  test('a deadline kills the child instead of waiting for it to exit on its own', async () => {
    const adb = hostAdb()
    const script = `await Bun.sleep(5000); process.exit(0)`
    const startedAt = Date.now()
    let caught: unknown
    try {
      await adb.run(['-e', script], { timeoutMs: 200 })
      throw new Error('expected run() to reject')
    } catch (err) {
      caught = err
    }
    const elapsed = Date.now() - startedAt
    expect(caught).toBeInstanceOf(HostAdbError)
    expect((caught as HostAdbError).code).toBe('E_ADB_CLI_TIMEOUT')
    // Proves the child was actually killed rather than left to finish its
    // 5s sleep: `run()` only resolves/rejects once `proc.exited` settles, so
    // finishing well under that budget IS the proof the kill worked.
    expect(elapsed).toBeLessThan(4000)
    expect(adb.stats().running).toBe(0)
  })

  test("lane 'install' requires a serial", async () => {
    const adb = hostAdb()
    await expect(adb.run(['install', '-r', 'x.apk'], { lane: 'install' })).rejects.toThrow(/serial/)
  })

  test('adb.maxHostConcurrent serialises run() calls past its cap', async () => {
    const adb = hostAdb({ maxHostConcurrent: 1 })
    const sleepMs = 150
    // Each child reports its own high-resolution start time on stdout, then
    // holds itself open for `sleepMs`. If the farm-wide semaphore is doing
    // its job, no two children's [start, start+sleepMs) windows overlap.
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    const results = await Promise.all([
      adb.run(['-e', script]),
      adb.run(['-e', script]),
      adb.run(['-e', script]),
    ])
    const starts = results.map((s) => Number.parseInt(s.trim(), 10)).sort((a, b) => a - b)
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!
      expect(gap).toBeGreaterThanOrEqual(sleepMs - 40) // small slack for scheduler jitter
    }
  })

  test('install lane serialises per device even when adb.maxInstallConcurrent allows more (H5)', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 2 })
    const sleepMs = 150
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    // Two installs for the SAME serial must never overlap, even though the
    // farm-wide install budget (2) would otherwise allow it.
    const [a, b] = await Promise.all([
      adb.run(['-e', script], { lane: 'install', serial: 'same-device' }),
      adb.run(['-e', script], { lane: 'install', serial: 'same-device' }),
    ])
    const starts = [a, b].map((s) => Number.parseInt(s.trim(), 10)).sort((x, y) => x - y)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(sleepMs - 40)
  })

  test('install lane allows different devices to run concurrently, up to adb.maxInstallConcurrent', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 2 })
    const sleepMs = 200
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    const startedAt = Date.now()
    await Promise.all([
      adb.run(['-e', script], { lane: 'install', serial: 'device-a' }),
      adb.run(['-e', script], { lane: 'install', serial: 'device-b' }),
    ])
    // Two DIFFERENT devices installing concurrently should finish in roughly
    // one sleep's worth of time, not two — proving the per-device chain
    // does not accidentally serialise the whole farm.
    expect(Date.now() - startedAt).toBeLessThan(sleepMs * 2)
  })

  test('install lane: two installs on the same USB root never overlap even when maxInstallConcurrent allows it (plan 223 §4.6, MVP 09 §2 H5)', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 4 }, async () => 'root-1')
    const sleepMs = 150
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    const [a, b] = await Promise.all([
      adb.run(['-e', script], { lane: 'install', serial: 'device-a' }),
      adb.run(['-e', script], { lane: 'install', serial: 'device-b' }),
    ])
    const starts = [a, b].map((s) => Number.parseInt(s.trim(), 10)).sort((x, y) => x - y)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(sleepMs - 40)
  })

  test('install lane: two installs on DIFFERENT USB roots may run concurrently', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 4 }, async (serial) => (serial === 'device-a' ? 'root-1' : 'root-2'))
    const sleepMs = 200
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    const startedAt = Date.now()
    await Promise.all([
      adb.run(['-e', script], { lane: 'install', serial: 'device-a' }),
      adb.run(['-e', script], { lane: 'install', serial: 'device-b' }),
    ])
    expect(Date.now() - startedAt).toBeLessThan(sleepMs * 2)
  })

  test('install lane: a serial that resolves to unknown is still gated by its own root\'s semaphore', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 4 }, async () => 'unknown')
    const sleepMs = 150
    const script = `process.stdout.write(String(Date.now())); await Bun.sleep(${sleepMs})`
    const [a, b] = await Promise.all([
      adb.run(['-e', script], { lane: 'install', serial: 'device-a' }),
      adb.run(['-e', script], { lane: 'install', serial: 'device-b' }),
    ])
    const starts = [a, b].map((s) => Number.parseInt(s.trim(), 10)).sort((x, y) => x - y)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(sleepMs - 40)
  })
})

describe('createHostAdb — spawnLongLived()', () => {
  test('returns a handle whose tail() reports bounded, drained output', async () => {
    const adb = hostAdb()
    const script = `
      process.stdout.write('scrcpy server started\\n')
      process.stderr.write('[server] INFO: some diagnostic\\n')
      await Bun.sleep(50)
      process.exit(7)
    `
    const child = adb.spawnLongLived(['-e', script])
    expect(adb.stats().longLived).toBe(1)
    const code = await child.exited
    expect(code).toBe(7)
    expect(child.tail()).toContain('scrcpy server started')
    expect(child.tail()).toContain('some diagnostic')
    expect(adb.stats().longLived).toBe(0)
  })

  test('onExit fires with the exit code and the bounded tail', async () => {
    const adb = hostAdb()
    const script = `process.stderr.write('the server died\\n'); process.exit(9)`
    const seen: { code: number; tail: string }[] = []
    const child = adb.spawnLongLived(['-e', script], { onExit: (code, tail) => seen.push({ code, tail }) })
    await child.exited
    expect(seen).toHaveLength(1)
    expect(seen[0]!.code).toBe(9)
    expect(seen[0]!.tail).toContain('the server died')
  })
})

describe('createHostAdb — killAll()', () => {
  test('kills a long-lived child (F12: nothing held a handle to the scrcpy server, so nothing killed it at core exit)', async () => {
    const adb = hostAdb()
    const script = `await Bun.sleep(30000); process.exit(0)`
    const child = adb.spawnLongLived(['-e', script])
    expect(adb.stats().longLived).toBe(1)
    adb.killAll()
    const code = await Promise.race([child.exited, timeoutAfter(5000, 'killAll() did not stop the child in time')])
    expect(typeof code).toBe('number')
    expect(adb.stats().longLived).toBe(0)
  })

  test('never touches a process it did not spawn', async () => {
    const adb = hostAdb()
    const bystander = Bun.spawn([BUN, '-e', 'await Bun.sleep(30000); process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      // Give hostAdb some of its OWN children to kill too, so `killAll` is
      // doing real work and not merely a no-op.
      const ours = adb.spawnLongLived(['-e', 'await Bun.sleep(30000); process.exit(0)'])
      adb.killAll()
      await ours.exited
      // The bystander — spawned directly via `Bun.spawn`, never registered
      // with `hostAdb` — must still be alive: `killAll` never enumerates
      // the system, it only iterates handles this module itself created.
      expect(bystander.killed).toBe(false)
    } finally {
      bystander.kill()
      await bystander.exited
    }
  })
})

describe('createHostAdb — stats()', () => {
  test('maxConcurrent reflects the configured farm-wide cap', () => {
    const adb = hostAdb({ maxHostConcurrent: 7 })
    expect(adb.stats().maxConcurrent).toBe(7)
  })

  test('running/installsRunning reflect in-flight work', async () => {
    const adb = hostAdb({ maxHostConcurrent: 4, maxInstallConcurrent: 4 })
    const gate = adb.run(['-e', `await Bun.sleep(150)`], { lane: 'install', serial: 'dev-1' })
    await Bun.sleep(30) // let it actually start
    expect(adb.stats().running).toBe(1)
    expect(adb.stats().installsRunning).toBe(1)
    await gate
    expect(adb.stats().running).toBe(0)
    expect(adb.stats().installsRunning).toBe(0)
  })

  test('installsByRoot reports running/queued per root (plan 223 §4.6)', async () => {
    const adb = hostAdb({ maxHostConcurrent: 8, maxInstallConcurrent: 4 }, async () => 'root-1')
    const gate = adb.run(['-e', `await Bun.sleep(150)`], { lane: 'install', serial: 'dev-1' })
    const queued = adb.run(['-e', `await Bun.sleep(10)`], { lane: 'install', serial: 'dev-2' })
    await Bun.sleep(30) // let the first actually start and the second queue behind its root's semaphore
    expect(adb.stats().installsByRoot['root-1']).toEqual({ running: 1, queued: 1 })
    await Promise.all([gate, queued])
    expect(adb.stats().installsByRoot['root-1']).toEqual({ running: 0, queued: 0 })
  })
})
