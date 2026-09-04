import { describe, expect, test } from 'bun:test'
import { browserOpenCommand, buildStudioUrl, maybeOpenBrowser, shouldOpenBrowser } from './open-browser'
import type { Logger } from './logger'

/** A `Logger` that records every call instead of printing — assertions read `calls`. */
function fakeLogger(): Logger & { calls: { level: string; msg: string }[] } {
  const calls: { level: string; msg: string }[] = []
  const record = (level: string) => (msg: string) => {
    calls.push({ level, msg })
  }
  const logger: Logger & { calls: typeof calls } = {
    calls,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => fakeLogger(),
  }
  return logger
}

describe('browserOpenCommand', () => {
  test('macOS: `open <url>`', () => {
    expect(browserOpenCommand('http://127.0.0.1:7700/', 'darwin')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:7700/'],
    })
  })

  test('Linux: `xdg-open <url>`', () => {
    expect(browserOpenCommand('http://127.0.0.1:7700/', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://127.0.0.1:7700/'],
    })
  })

  test('Windows: `cmd /c start "" <url>` — the empty quoted title avoids the "first quoted argument becomes the window title" pitfall', () => {
    expect(browserOpenCommand('http://127.0.0.1:7700/?a=b&c=d', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://127.0.0.1:7700/?a=b&c=d'],
    })
  })
})

describe('buildStudioUrl', () => {
  test('http by default', () => {
    expect(buildStudioUrl({ host: '127.0.0.1', port: 7700, tls: { mode: 'off' } })).toBe('http://127.0.0.1:7700/')
  })

  test('https when tls.mode is self', () => {
    expect(buildStudioUrl({ host: '127.0.0.1', port: 7700, tls: { mode: 'self' } })).toBe('https://127.0.0.1:7700/')
  })

  test('external TLS still reports the core\'s own http listener, matching daemon.ts\'s own scheme rule', () => {
    expect(buildStudioUrl({ host: '0.0.0.0', port: 7700, tls: { mode: 'external' } })).toBe('http://0.0.0.0:7700/')
  })

  test('brackets an IPv6 host so the URL is valid', () => {
    expect(buildStudioUrl({ host: '::1', port: 7700, tls: { mode: 'off' } })).toBe('http://[::1]:7700/')
  })
})

describe('shouldOpenBrowser — opening is opt-in (CEO, 2026-09-04)', () => {
  const loopback = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '::1'
  /** Everything a spawned browser needs EXCEPT the opt-in itself. */
  const eligible = { mode: undefined, host: '127.0.0.1', isTTY: true, open: '1', isLoopbackHost: loopback }

  test('the default is NO — a plain local run with a TTY opens nothing', () => {
    expect(shouldOpenBrowser({ ...eligible, open: undefined })).toBe(false)
  })

  test('ENKAKU_OPEN=1 opts in, on a local loopback run with a real TTY', () => {
    expect(shouldOpenBrowser(eligible)).toBe(true)
  })

  test('the opt-in does NOT override orchestrator mode (the cloud control plane, spec §5.3)', () => {
    expect(shouldOpenBrowser({ ...eligible, mode: 'orchestrator' })).toBe(false)
  })

  test('the opt-in does NOT override a non-loopback bind — the signal docker-compose.yml and deploy/enkaku.service both set (ENKAKU_BIND=0.0.0.0)', () => {
    expect(shouldOpenBrowser({ ...eligible, host: '0.0.0.0' })).toBe(false)
  })

  test('the opt-in does NOT override a missing TTY — a systemd unit, a Docker container with no `-t`, or a CI job', () => {
    expect(shouldOpenBrowser({ ...eligible, isTTY: false })).toBe(false)
  })

  for (const value of ['1', 'true', 'YES', 'on']) {
    test(`ENKAKU_OPEN=${value} counts as opting in`, () => {
      expect(shouldOpenBrowser({ ...eligible, open: value })).toBe(true)
    })
  }

  for (const value of ['0', 'false', '', undefined]) {
    test(`ENKAKU_OPEN=${JSON.stringify(value)} is not an opt-in`, () => {
      expect(shouldOpenBrowser({ ...eligible, open: value })).toBe(false)
    })
  }
})

/** A fake `BrowserSpawner` that never spawns a real process — records the call and resolves/rejects on demand. */
function fakeSpawn(result: { exitCode?: number; syncThrow?: Error; rejects?: Error }) {
  const calls: { command: string; args: string[] }[] = []
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args })
    if (result.syncThrow) throw result.syncThrow
    return { exited: result.rejects ? Promise.reject(result.rejects) : Promise.resolve(result.exitCode ?? 0) }
  }
  return { spawn, calls }
}

describe('maybeOpenBrowser', () => {
  const base = {
    url: 'http://127.0.0.1:7700/',
    mode: undefined,
    host: '127.0.0.1',
    isTTY: true,
    open: '1',
    isLoopbackHost: (h: string) => h === '127.0.0.1',
  }

  test('always prints the URL — the fallback that works even when nothing else does', () => {
    const log = fakeLogger()
    const { spawn } = fakeSpawn({ exitCode: 0 })
    maybeOpenBrowser({ ...base, isTTY: false, log, spawn })
    expect(log.calls.some((c) => c.level === 'info' && c.msg.includes(base.url))).toBe(true)
  })

  test('does not spawn anything when shouldOpenBrowser says no (headless case)', () => {
    const log = fakeLogger()
    const { spawn, calls } = fakeSpawn({ exitCode: 0 })
    maybeOpenBrowser({ ...base, host: '0.0.0.0', log, spawn })
    expect(calls).toEqual([])
  })

  test('spawns the platform command only once the interactive-desktop decision says yes', () => {
    const log = fakeLogger()
    const { spawn, calls } = fakeSpawn({ exitCode: 0 })
    maybeOpenBrowser({ ...base, platform: 'darwin', log, spawn })
    expect(calls).toEqual([{ command: 'open', args: [base.url] }])
  })

  test('a synchronous spawn failure (launcher missing from PATH) is caught, logged at warn with the URL, and never thrown — the core must stay up', () => {
    const log = fakeLogger()
    const { spawn } = fakeSpawn({ syncThrow: new Error('Executable not found in $PATH: "open"') })
    expect(() => maybeOpenBrowser({ ...base, platform: 'darwin', log, spawn })).not.toThrow()
    expect(log.calls.some((c) => c.level === 'warn' && c.msg.includes(base.url))).toBe(true)
  })

  test('a non-zero exit from the launcher is logged at warn, not silently dropped', async () => {
    const log = fakeLogger()
    const { spawn } = fakeSpawn({ exitCode: 1 })
    maybeOpenBrowser({ ...base, platform: 'darwin', log, spawn })
    // The warn comes from an unawaited `.then` on `exited` — give the microtask queue a turn.
    await Promise.resolve()
    await Promise.resolve()
    expect(log.calls.some((c) => c.level === 'warn' && c.msg.includes('exited with code 1'))).toBe(true)
  })

  test('an async rejection from the launcher is logged at warn too, never crashes', async () => {
    const log = fakeLogger()
    const { spawn } = fakeSpawn({ rejects: new Error('boom') })
    expect(() => maybeOpenBrowser({ ...base, platform: 'darwin', log, spawn })).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(log.calls.some((c) => c.level === 'warn' && c.msg.includes(base.url))).toBe(true)
  })
})
