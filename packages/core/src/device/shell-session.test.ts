import { describe, expect, test } from 'bun:test'
import { createShellSessionStore } from './shell-session'
import { shellQuote } from './monitors'

describe('ShellSessionStore (plan 26 §3.7, §4.4, §7)', () => {
  test('defaults to / for a device that has never run a command', () => {
    const store = createShellSessionStore()
    expect(store.getCwd('dev1')).toBe('/')
  })

  test('parseCd recognises a bare `cd <target>` and nothing else', () => {
    const store = createShellSessionStore()
    expect(store.parseCd('cd /data/local/tmp')).toEqual({ target: '/data/local/tmp' })
    expect(store.parseCd('  cd   /data/local/tmp  ')).toEqual({ target: '/data/local/tmp' })
    expect(store.parseCd('cd')).toEqual({ target: null })
  })

  test('parseCd does NOT intercept a compound command that merely contains cd', () => {
    const store = createShellSessionStore()
    expect(store.parseCd('cd /foo && ls')).toBeNull()
    expect(store.parseCd('echo cd')).toBeNull()
    expect(store.parseCd('cdfoo bar')).toBeNull()
  })

  test('withCwd prefixes an ordinary command with the current cwd, quoted', () => {
    const store = createShellSessionStore()
    expect(store.withCwd('dev1', 'ls -la')).toBe("cd '/' && ls -la")
    store.commitCwd('dev1', '/data/local/tmp')
    expect(store.withCwd('dev1', 'ls -la')).toBe("cd '/data/local/tmp' && ls -la")
  })

  test('withCwd delegates quoting to shellQuote (the plan 24 injection-safety guarantee) rather than concatenating raw', () => {
    const store = createShellSessionStore()
    const dangerousCwd = `/tmp/a'; rm -rf /; echo '`
    store.commitCwd('dev1', dangerousCwd)
    // The dangerous substring is expected to still be PRESENT — quoting does
    // not remove it, it neutralises it by keeping it inside a single
    // shell-quoted token. What matters is that `withCwd` is built from
    // `shellQuote(cwd)` exactly, not a hand-rolled concatenation that might
    // forget to escape an embedded quote (`shellQuote` itself is unit-tested
    // for injection in `monitors.test.ts`).
    expect(store.withCwd('dev1', 'ls')).toBe(`cd ${shellQuote(dangerousCwd)} && ls`)
  })

  test('cdProbeCommand chains from the current cwd and asks the device to resolve the target', () => {
    const store = createShellSessionStore()
    expect(store.cdProbeCommand('dev1', '/data/local/tmp')).toBe("cd '/' && cd '/data/local/tmp' && pwd")
    store.commitCwd('dev1', '/data/local/tmp')
    expect(store.cdProbeCommand('dev1', '..')).toBe("cd '/data/local/tmp' && cd '..' && pwd")
  })

  test('cdProbeCommand for a bare `cd` (no target) uses a plain `cd`, not a quoted empty string', () => {
    const store = createShellSessionStore()
    expect(store.cdProbeCommand('dev1', null)).toBe("cd '/' && cd && pwd")
  })

  test('commitCwd updates getCwd for that device only', () => {
    const store = createShellSessionStore()
    store.commitCwd('dev1', '/data/local/tmp')
    expect(store.getCwd('dev1')).toBe('/data/local/tmp')
    expect(store.getCwd('dev2')).toBe('/')
  })

  test('a failed cd (the caller never calls commitCwd) leaves the cwd unchanged', () => {
    const store = createShellSessionStore()
    store.commitCwd('dev1', '/data/local/tmp')
    // Simulates the handler's behaviour on a failed probe: it simply does
    // not call commitCwd.
    expect(store.getCwd('dev1')).toBe('/data/local/tmp')
  })

  test('release resets the cwd — the next controller starts at / (acceptance #11)', () => {
    const store = createShellSessionStore()
    store.commitCwd('dev1', '/data/local/tmp')
    store.release('dev1')
    expect(store.getCwd('dev1')).toBe('/')
  })

  test('release only affects the given device', () => {
    const store = createShellSessionStore()
    store.commitCwd('dev1', '/a')
    store.commitCwd('dev2', '/b')
    store.release('dev1')
    expect(store.getCwd('dev1')).toBe('/')
    expect(store.getCwd('dev2')).toBe('/b')
  })
})
