import { describe, expect, test } from 'bun:test'
import { createAppRestartControl, defaultPollHealth, RESTART_SENTINEL_EXIT_CODE, type AppRestartChildHandle, type AppRestartDeps } from './app-restart-control'
import type { Logger } from '../util/logger'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

function baseDeps(overrides: Partial<AppRestartDeps> = {}): AppRestartDeps {
  return {
    drain: async () => ({ sessionsClosed: 0, controlsEnded: 0, jobsFailed: [] }),
    stopDaemon: async () => {},
    closeHttpPort: () => {},
    reopenHttpPort: async () => {},
    port: 7700,
    host: '127.0.0.1',
    log: silentLogger,
    exit: () => {},
    ...overrides,
  }
}

describe('createAppRestartControl — docker mode', () => {
  test('drains, defers the stop-and-exit, and returns an "initiated" report immediately', async () => {
    const exits: number[] = []
    // A holder object, not a bare reassigned `let` — TypeScript's control
    // flow narrowing has a known sharp edge where a `let` of a nullable
    // function type, assigned only from inside a nested closure, narrows to
    // `never` at any later read in the outer scope. A property on an object
    // is not narrowed the same way, which is the whole reason for the extra
    // indirection here.
    const captured: { run: (() => Promise<void>) | null } = { run: null }
    let stopped = false
    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'docker',
        drain: async ({ force }) => ({ sessionsClosed: 3, controlsEnded: 1, jobsFailed: force ? ['job-1'] : [] }),
        stopDaemon: async () => {
          stopped = true
        },
        exit: (code) => {
          exits.push(code)
        },
        scheduleExit: (run) => {
          captured.run = run
        },
      }),
    )

    const report = await control.restart({})
    expect(report).toEqual({ mode: 'docker', outcome: 'initiated', durationMs: report.durationMs, sessionsClosed: 3, controlsEnded: 1, jobsFailed: [] })
    // The process has not been stopped or exited yet — that only happens once the deferred callback runs.
    expect(stopped).toBe(false)
    expect(exits).toEqual([])

    expect(captured.run).not.toBeNull()
    await captured.run?.()
    expect(stopped).toBe(true)
    expect(exits).toEqual([0])
  })
})

describe('createAppRestartControl — systemd mode', () => {
  test('exits with RESTART_SENTINEL_EXIT_CODE, deferred the same way docker mode is', async () => {
    const exits: number[] = []
    // See the docker-mode test above for why this is a holder object rather
    // than a bare reassigned `let`.
    const captured: { run: (() => Promise<void>) | null } = { run: null }
    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'systemd',
        exit: (code) => {
          exits.push(code)
        },
        scheduleExit: (run) => {
          captured.run = run
        },
      }),
    )

    const report = await control.restart({})
    expect(report.mode).toBe('systemd')
    expect(report.outcome).toBe('initiated')
    expect(exits).toEqual([])

    await captured.run?.()
    expect(exits).toEqual([RESTART_SENTINEL_EXIT_CODE])
  })
})

describe('createAppRestartControl — bare mode, the health-verified handoff', () => {
  test('success: port released, child spawned, health polls true, daemon stopped, exit(0) — the working parent is only ever traded for a PROVEN-healthy child', async () => {
    const events: string[] = []
    const killed: boolean[] = []
    const child: AppRestartChildHandle = { pid: 4242, kill: () => killed.push(true) }

    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'bare',
        closeHttpPort: () => {
          events.push('closeHttpPort')
        },
        reopenHttpPort: async () => {
          events.push('reopenHttpPort')
        },
        stopDaemon: async () => {
          events.push('stopDaemon')
        },
        spawnChild: () => {
          events.push('spawnChild')
          return child
        },
        pollHealth: async ({ host, port, timeoutMs }) => {
          events.push(`pollHealth:${host}:${port}:${timeoutMs}`)
          return true
        },
        exit: (code) => {
          events.push(`exit:${code}`)
        },
      }),
    )

    const report = await control.restart({})
    expect(report.mode).toBe('bare')
    expect(report.outcome).toBe('verified')
    expect(events).toEqual(['closeHttpPort', 'spawnChild', 'pollHealth:127.0.0.1:7700:15000', 'stopDaemon', 'exit:0'])
    expect(killed).toEqual([])
  })

  test('failure: health never comes back true — the child is killed, the port is reopened, the ORIGINAL process stays up, and the caller gets E_RESTART_FAILED', async () => {
    const events: string[] = []
    const killed: boolean[] = []
    const child: AppRestartChildHandle = { pid: 99, kill: () => killed.push(true) }
    let stoppedDaemon = false
    let exited = false

    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'bare',
        closeHttpPort: () => {
          events.push('closeHttpPort')
        },
        reopenHttpPort: async () => {
          events.push('reopenHttpPort')
        },
        stopDaemon: async () => {
          stoppedDaemon = true
        },
        spawnChild: () => {
          events.push('spawnChild')
          return child
        },
        pollHealth: async () => {
          events.push('pollHealth')
          return false
        },
        exit: () => {
          exited = true
        },
      }),
    )

    await expect(control.restart({})).rejects.toMatchObject({ code: 'E_RESTART_FAILED' })
    expect(events).toEqual(['closeHttpPort', 'spawnChild', 'pollHealth', 'reopenHttpPort'])
    expect(killed).toEqual([true])
    // Never traded a working process for a broken one: the daemon was never
    // torn down, and the process never exited.
    expect(stoppedDaemon).toBe(false)
    expect(exited).toBe(false)
  })

  test('failure, and the port cannot even be reopened — the one case with no safe next step, so it throws loudly rather than leaving no listener at all', async () => {
    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'bare',
        reopenHttpPort: async () => {
          throw new Error('EADDRINUSE')
        },
        spawnChild: () => ({ pid: 1, kill: () => {} }),
        pollHealth: async () => false,
      }),
    )

    await expect(control.restart({})).rejects.toMatchObject({ code: 'E_RESTART_FAILED' })
  })

  test('drain is always called before anything else, with force threaded through', async () => {
    const forceSeen: boolean[] = []
    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'bare',
        drain: async ({ force }) => {
          forceSeen.push(force)
          return { sessionsClosed: 0, controlsEnded: 0, jobsFailed: force ? ['job-a'] : [] }
        },
        spawnChild: () => ({ pid: 1, kill: () => {} }),
        pollHealth: async () => true,
      }),
    )

    const report = await control.restart({ force: true })
    expect(forceSeen).toEqual([true])
    expect(report.jobsFailed).toEqual(['job-a'])
  })
})

describe('createAppRestartControl — the mutex', () => {
  test('a second restart while one is in flight is refused with E_TOOL_IN_USE', async () => {
    // A holder object, not a bare reassigned `let` — see the docker-mode test's own comment for why.
    const captured: { resolve: ((v: boolean) => void) | null } = { resolve: null }
    const control = createAppRestartControl(
      baseDeps({
        detectMode: () => 'bare',
        spawnChild: () => ({ pid: 1, kill: () => {} }),
        pollHealth: () =>
          new Promise<boolean>((resolve) => {
            captured.resolve = resolve
          }),
      }),
    )

    const first = control.restart({})
    expect(control.busy()).toBe(true)
    await expect(control.restart({})).rejects.toMatchObject({ code: 'E_TOOL_IN_USE' })

    captured.resolve?.(true)
    await first
    expect(control.busy()).toBe(false)
  })
})

describe('defaultPollHealth (real fetch against a fake server)', () => {
  test('polls until the child answers ok:true, then stops', async () => {
    let requestCount = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        requestCount++
        const url = new URL(req.url)
        if (url.pathname !== '/api/health') return new Response('not found', { status: 404 })
        // Answers unhealthy for the first two requests, healthy after — proves the poll actually loops.
        if (requestCount < 3) return Response.json({ ok: false })
        return Response.json({ ok: true })
      },
    })
    try {
      // Bun's `Server.port` type is `number | undefined`; a live `Bun.serve()` always has one.
      const healthy = await defaultPollHealth({ host: '127.0.0.1', port: server.port!, timeoutMs: 5000 })
      expect(healthy).toBe(true)
      expect(requestCount).toBeGreaterThanOrEqual(3)
    } finally {
      server.stop(true)
    }
  })

  test('times out honestly when nothing ever answers', async () => {
    // A server that accepts the TCP connection but never responds within the
    // per-request budget — proves the timeout is honoured even when the
    // failure is a hang, not just a refused connection.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        await new Promise(() => {}) // never resolves
        return new Response('unreachable')
      },
    })
    try {
      const healthy = await defaultPollHealth({ host: '127.0.0.1', port: server.port!, timeoutMs: 700 })
      expect(healthy).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
