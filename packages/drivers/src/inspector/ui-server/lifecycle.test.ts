import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIGURATOR, type ConfiguratorInfo, type UiServerClient } from './client'
import {
  classifyInstrumentationLine,
  createInstrumentationParser,
  createUiServerLifecycle,
  INSTRUMENTATION_FATAL_PATTERNS,
  INSTRUMENTATION_LINE_BUFFER_MAX,
  INSTRUMENTATION_START_SILENCE_MS,
} from './lifecycle'
import type { UiServerLauncher, UiServerStartHooks } from './launcher'

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await Bun.sleep(2)
  }
  throw new Error('condition was not met in time')
}

describe('classifyInstrumentationLine — the fatal-pattern table (plan 208 §4.2)', () => {
  test('every pattern in INSTRUMENTATION_FATAL_PATTERNS classifies fatal', () => {
    const samples: Record<string, string> = {
      '^INSTRUMENTATION_STATUS: stack=': 'INSTRUMENTATION_STATUS: stack=java.lang.ClassNotFoundException: x',
      ClassNotFoundException: 'some other line mentioning ClassNotFoundException',
      '^INSTRUMENTATION_STATUS: Error=': 'INSTRUMENTATION_STATUS: Error=something broke',
      '^INSTRUMENTATION_RESULT: shortMsg=': 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.',
      'Process crashed': 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.',
      '^INSTRUMENTATION_FAILED:': 'INSTRUMENTATION_FAILED: com.github.uiautomator.test/androidx.test.runner.AndroidJUnitRunner',
    }
    for (const { pattern } of INSTRUMENTATION_FATAL_PATTERNS) {
      const sample = samples[pattern.source]
      expect(sample, `no sample line for pattern ${pattern}`).toBeDefined()
      expect(classifyInstrumentationLine(sample!).kind).toBe('fatal')
    }
  })

  test('INSTRUMENTATION_STATUS_CODE: 1 classifies started', () => {
    expect(classifyInstrumentationLine('INSTRUMENTATION_STATUS_CODE: 1')).toEqual({ kind: 'started' })
  })

  test('ordinary status lines and an empty line classify noise', () => {
    expect(classifyInstrumentationLine('INSTRUMENTATION_STATUS: class=com.github.uiautomator.stub.Stub').kind).toBe('noise')
    expect(classifyInstrumentationLine('INSTRUMENTATION_STATUS: numtests=1').kind).toBe('noise')
    expect(classifyInstrumentationLine('').kind).toBe('noise')
  })
})

describe('createInstrumentationParser — line splitting and the first-fatal-only report (plan 208 §4.2)', () => {
  test('reports the first fatal line once when bytes arrive split mid-line across three chunks', () => {
    const fatal: Array<{ reason: string; line: string }> = []
    const lines: string[] = []
    const parser = createInstrumentationParser({
      onFatal: (reason, line) => fatal.push({ reason, line }),
      onLine: (line) => lines.push(line),
    })
    const full = 'INSTRUMENTATION_STATUS: stack=java.lang.ClassNotFoundException: com.github.uiautomator.test.Stub\n'
    const enc = new TextEncoder()
    const bytes = enc.encode(full)
    const a = bytes.slice(0, 10)
    const b = bytes.slice(10, 40)
    const c = bytes.slice(40)
    parser.feed(a)
    parser.feed(b)
    parser.feed(c)
    expect(fatal).toHaveLength(1)
    expect(fatal[0]?.line).toBe(full.trimEnd())
    expect(lines).toEqual([full.trimEnd()])
  })

  test('end() flushes a final unterminated line', () => {
    const lines: string[] = []
    const parser = createInstrumentationParser({ onFatal: () => {}, onLine: (line) => lines.push(line) })
    parser.feed(new TextEncoder().encode('INSTRUMENTATION_STATUS_CODE: 1'))
    expect(lines).toEqual([])
    parser.end()
    expect(lines).toEqual(['INSTRUMENTATION_STATUS_CODE: 1'])
  })

  test('a 70 KB chunk without a newline does not grow the buffer past INSTRUMENTATION_LINE_BUFFER_MAX', () => {
    const lines: string[] = []
    const parser = createInstrumentationParser({ onFatal: () => {}, onLine: (line) => lines.push(line) })
    const huge = 'x'.repeat(70 * 1024)
    parser.feed(new TextEncoder().encode(huge))
    parser.end()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.length).toBeLessThanOrEqual(INSTRUMENTATION_LINE_BUFFER_MAX)
  })

  test('a second fatal line is never reported', () => {
    const fatal: string[] = []
    const parser = createInstrumentationParser({ onFatal: (reason) => fatal.push(reason) })
    parser.feed(new TextEncoder().encode('INSTRUMENTATION_STATUS: Error=one\nINSTRUMENTATION_STATUS: Error=two\n'))
    expect(fatal).toHaveLength(1)
  })
})

/** A client whose `ping`/`setConfigurator`/`getConfigurator` are scripted and recorded. */
function fakeClient(opts?: {
  ping?: () => Promise<boolean>
  setConfigurator?: (info: ConfiguratorInfo) => Promise<void>
}): { client: UiServerClient; setConfiguratorCalls: ConfiguratorInfo[]; getConfiguratorCalls: number } {
  const setConfiguratorCalls: ConfiguratorInfo[] = []
  let getConfiguratorCalls = 0
  const client = {
    ping: opts?.ping ?? (async () => true),
    setConfigurator: async (info: ConfiguratorInfo) => {
      setConfiguratorCalls.push(info)
      await opts?.setConfigurator?.(info)
    },
    getConfigurator: async () => {
      getConfiguratorCalls++
      return { ...DEFAULT_CONFIGURATOR }
    },
  } as unknown as UiServerClient
  return { client, setConfiguratorCalls, getConfiguratorCalls: getConfiguratorCalls }
}

/** A launcher whose `start()` can be told to invoke the fatal/exit hooks, and whose calls are counted. */
function fakeLauncher(opts?: { onStartHooks?: (hooks?: UiServerStartHooks) => void }): {
  launcher: UiServerLauncher
  startCalls: () => number
  stopCalls: () => number
} {
  let starts = 0
  let stops = 0
  const launcher = {
    start: async (_localPort: number, hooks?: UiServerStartHooks) => {
      starts += 1
      opts?.onStartHooks?.(hooks)
    },
    stop: async () => {
      stops += 1
    },
  } as unknown as UiServerLauncher
  return { launcher, startCalls: () => starts, stopCalls: () => stops }
}

describe('createUiServerLifecycle (plan 208 §4.2)', () => {
  test('a fatal line 300 ms into the stream rejects start() in under 2 s', async () => {
    const { launcher } = fakeLauncher({
      onStartHooks: (hooks) => {
        setTimeout(() => hooks?.onFatal?.('the stub class was not found: ...'), 300)
      },
    })
    const { client } = fakeClient({ ping: async () => false })
    const lifecycle = createUiServerLifecycle({ serial: 's1', client, launcher, localPort: 1 })

    const startedAt = Date.now()
    await expect(lifecycle.start()).rejects.toThrow('the stub class was not found')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(lifecycle.state()).toBe('failed')
  })

  test('silence pays the ceiling and nothing less', async () => {
    const { launcher } = fakeLauncher()
    const { client } = fakeClient({ ping: async () => false })
    const lifecycle = createUiServerLifecycle({ serial: 's1', client, launcher, localPort: 1, watchdog: { startTimeoutMs: 50 } })

    const startedAt = Date.now()
    await expect(lifecycle.start()).rejects.toThrow()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45)
    expect(lifecycle.state()).toBe('failed')
  })

  test('the configurator is applied after start and after every restart', async () => {
    const { launcher } = fakeLauncher()
    const { client, setConfiguratorCalls } = fakeClient()
    const lifecycle = createUiServerLifecycle({
      serial: 's1',
      client,
      launcher,
      localPort: 1,
      watchdog: { maxRestartsPerWindow: 2, restartWindowMs: 60_000, restartBackoffMs: [1, 1], idlePingMs: 100_000 },
    })

    await lifecycle.start()
    expect(setConfiguratorCalls).toEqual([DEFAULT_CONFIGURATOR])
    expect(lifecycle.state()).toBe('ready')

    lifecycle.reportFailure('degraded')
    await waitUntil(() => setConfiguratorCalls.length === 2)
    expect(setConfiguratorCalls).toEqual([DEFAULT_CONFIGURATOR, DEFAULT_CONFIGURATOR])
  })

  test('a configurator failure is logged and the engine is still ready', async () => {
    const { launcher } = fakeLauncher()
    const { client } = fakeClient({
      setConfigurator: async () => {
        throw new Error('setConfigurator: rpc error')
      },
    })
    const logs: Array<{ level: string; msg: string }> = []
    const lifecycle = createUiServerLifecycle({
      serial: 's1',
      client,
      launcher,
      localPort: 1,
      onLog: (level, msg) => logs.push({ level, msg }),
    })

    await expect(lifecycle.start()).resolves.toBeUndefined()
    expect(lifecycle.state()).toBe('ready')
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('could not set the ui-server configurator'))).toBe(true)
  })

  test('state() walks idle, starting, ready, closed', async () => {
    const { launcher } = fakeLauncher()
    const { client } = fakeClient()
    const lifecycle = createUiServerLifecycle({ serial: 's1', client, launcher, localPort: 1 })

    expect(lifecycle.state()).toBe('idle')
    const startPromise = lifecycle.start()
    expect(lifecycle.state()).toBe('starting')
    await startPromise
    expect(lifecycle.state()).toBe('ready')
    await lifecycle.close()
    expect(lifecycle.state()).toBe('closed')
  })

  test('start() after close() rejects', async () => {
    const { launcher } = fakeLauncher()
    const { client } = fakeClient()
    const lifecycle = createUiServerLifecycle({ serial: 's1', client, launcher, localPort: 1 })
    await lifecycle.start()
    await lifecycle.close()
    await expect(lifecycle.start()).rejects.toThrow('the ui-server lifecycle is closed')
  })

  test('startedInMs is set on ready', async () => {
    const { launcher } = fakeLauncher()
    const { client } = fakeClient()
    const lifecycle = createUiServerLifecycle({ serial: 's1', client, launcher, localPort: 1 })
    expect(lifecycle.startedInMs()).toBeNull()
    await lifecycle.start()
    expect(lifecycle.startedInMs()).not.toBeNull()
    expect(lifecycle.startedInMs()!).toBeGreaterThanOrEqual(0)
  })
})

test('INSTRUMENTATION_START_SILENCE_MS is 15 seconds', () => {
  expect(INSTRUMENTATION_START_SILENCE_MS).toBe(15_000)
})
