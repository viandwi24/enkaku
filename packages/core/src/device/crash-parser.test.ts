import { describe, expect, test } from 'bun:test'
import { createCrashParser, type CrashEvent } from './crash-parser'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A real `logcat -b crash,main -v threadtime` capture for a NullPointerException
 * crashing `com.example.app`'s launch activity — the full FATAL EXCEPTION shape
 * (plan 37 §7): the marker line, `Process:`, the exception's own line, and a
 * realistic Java stack down through the platform frames.
 */
const FATAL_EXCEPTION_LINES = [
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: Process: com.example.app, PID: 1234',
  "08-03 12:34:56.789  1234  1234 E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke virtual method 'void android.widget.TextView.setText(java.lang.CharSequence)' on a null object reference",
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.example.app.MainActivity.onCreate(MainActivity.java:42)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.Activity.performCreate(Activity.java:8000)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.Activity.performCreate(Activity.java:7984)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.Instrumentation.callActivityOnCreate(Instrumentation.java:1309)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.ActivityThread.performLaunchActivity(ActivityThread.java:3245)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.ActivityThread.handleLaunchActivity(ActivityThread.java:3400)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.servertransaction.LaunchActivityItem.execute(LaunchActivityItem.java:85)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.servertransaction.TransactionExecutor.execute(TransactionExecutor.java:95)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.ActivityThread$H.handleMessage(ActivityThread.java:2298)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.os.Handler.dispatchMessage(Handler.java:106)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.os.Looper.loopOnce(Looper.java:205)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.os.Looper.loop(Looper.java:294)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat android.app.ActivityThread.main(ActivityThread.java:8177)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat java.lang.reflect.Method.invoke(Native Method)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run(RuntimeInit.java:592)',
  '08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.android.internal.os.ZygoteInit.main(ZygoteInit.java:947)',
]

/** An unrelated main-buffer line — proves the crash,main mux is filtered correctly, and closes the block. */
const UNRELATED_LINE = '08-03 12:34:56.800  5678  5678 I ActivityManager: Process com.example.app (pid 1234) has died: fg  TRIM_MEMORY_UI_HIDDEN'

/** Closes an open ANR block — a different tag than `ActivityManager`, unlike `UNRELATED_LINE` above. */
const ANR_UNRELATED_LINE = '08-03 12:40:10.200  6789  6789 I WindowManager: setOrientation to 1'

/** A real ANR capture (plan 37 §4.2): reported by ActivityManager in the main buffer, not the crash buffer. */
const ANR_LINES = [
  '08-03 12:40:10.100  2345  2345 E ActivityManager: ANR in com.example.other (com.example.other/.MainActivity)',
  '08-03 12:40:10.100  2345  2345 E ActivityManager: PID: 5555',
  '08-03 12:40:10.100  2345  2345 E ActivityManager: Reason: Input dispatching timed out (com.example.other/com.example.other.MainActivity, Waiting to send key event because the touched window has not finished processing certain input events, appTimeIsFocused=true, waitDuration=5003ms, dispatchLatency=5003ms)',
  '08-03 12:40:10.100  2345  2345 E ActivityManager: Load: 2.5 / 2.1 / 1.9',
  '08-03 12:40:10.100  2345  2345 E ActivityManager: CPU usage from 0ms to 10000ms later:',
]

function collect(): { feed: (line: string) => void; events: CrashEvent[] } {
  const events: CrashEvent[] = []
  const feed = createCrashParser((e) => events.push(e))
  return { feed, events }
}

describe('createCrashParser — FATAL EXCEPTION (plan 37 §4.2, acceptance #1)', () => {
  test('a full Java stack is captured whole, closed by the first non-continuing line', () => {
    const { feed, events } = collect()
    for (const line of FATAL_EXCEPTION_LINES) feed(line)
    expect(events).toHaveLength(0) // still open — nothing has closed it yet
    feed(UNRELATED_LINE)
    expect(events).toHaveLength(1)

    const e = events[0]!
    expect(e.kind).toBe('crash')
    expect(e.package).toBe('com.example.app')
    expect(e.process).toBe('com.example.app')
    expect(e.exception).toBe('java.lang.NullPointerException')
    expect(e.message).toContain('TextView.setText')
    expect(e.trace.split('\n')).toHaveLength(FATAL_EXCEPTION_LINES.length)
    expect(e.trace).toContain('FATAL EXCEPTION: main')
    expect(e.trace).toContain('MainActivity.onCreate(MainActivity.java:42)')
    expect(e.system).toBe(false)
    expect(e.truncated).toBe(false)
  })

  test('a plain main-buffer line with no marker never produces an event', () => {
    const { feed, events } = collect()
    feed('08-03 12:00:00.000   111   111 I SomeTag: just a normal log line, nothing to see here')
    expect(events).toHaveLength(0)
  })

  test('a multi-process package (Process: pkg:remote) attributes to the base package', () => {
    const { feed, events } = collect()
    feed('08-03 09:00:00.000  9999  9999 E AndroidRuntime: FATAL EXCEPTION: RemoteService')
    feed('08-03 09:00:00.000  9999  9999 E AndroidRuntime: Process: com.example.app:remote, PID: 9999')
    feed('08-03 09:00:00.000  9999  9999 E AndroidRuntime: java.lang.IllegalStateException: boom')
    feed(UNRELATED_LINE)
    expect(events).toHaveLength(1)
    expect(events[0]!.package).toBe('com.example.app')
    expect(events[0]!.process).toBe('com.example.app:remote')
  })
})

describe('createCrashParser — ANR (plan 37 §4.2, acceptance #3)', () => {
  test('an ANR block is recognised with kind "anr" and the offending package', () => {
    const { feed, events } = collect()
    for (const line of ANR_LINES) feed(line)
    feed(ANR_UNRELATED_LINE)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.kind).toBe('anr')
    expect(e.package).toBe('com.example.other')
    expect(e.exception).toBe('ANR')
    expect(e.message).toContain('ANR in com.example.other')
    expect(e.trace.split('\n')).toHaveLength(ANR_LINES.length)
  })
})

describe('createCrashParser — a trace split across delivery chunks (plan 37 §4.2, acceptance #9)', () => {
  test('lines fed across separate batches (as MonitorHub delivers on its own flush cadence) still join into one event', () => {
    const { feed, events } = collect()
    // First "chunk": the marker plus a few frames.
    for (const line of FATAL_EXCEPTION_LINES.slice(0, 5)) feed(line)
    expect(events).toHaveLength(0)
    // A later "chunk" continues the SAME block — nothing must have closed it
    // just because it arrived in a separate delivery.
    for (const line of FATAL_EXCEPTION_LINES.slice(5)) feed(line)
    feed(UNRELATED_LINE)
    expect(events).toHaveLength(1)
    expect(events[0]!.trace.split('\n')).toHaveLength(FATAL_EXCEPTION_LINES.length)
  })
})

describe('createCrashParser — idle gap closes an open block (plan 37 §4.2)', () => {
  test('no more lines within idleMs closes the block on its own, without a terminating line', async () => {
    const { feed, events } = collect2({ idleMs: 30 })
    for (const line of FATAL_EXCEPTION_LINES) feed(line)
    expect(events).toHaveLength(0)
    await sleep(60)
    expect(events).toHaveLength(1)
    expect(events[0]!.package).toBe('com.example.app')
  })

  function collect2(opts: { idleMs: number }): { feed: (line: string) => void; events: CrashEvent[] } {
    const events: CrashEvent[] = []
    const feed = createCrashParser((e) => events.push(e), opts)
    return { feed, events }
  }
})

describe('createCrashParser — a runaway block is capped (plan 37 §4.2, acceptance #9)', () => {
  test('a block that never terminates is force-closed once it reaches maxLines', () => {
    const events: CrashEvent[] = []
    const feed = createCrashParser((e) => events.push(e), { maxLines: 5 })
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main')
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: Process: com.example.app, PID: 1234')
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: java.lang.RuntimeException: never stops')
    // Two more "at" lines reach the cap of 5 without ever seeing a
    // terminating line or an idle gap.
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.example.app.A.a(A.java:1)')
    expect(events).toHaveLength(0)
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.example.app.A.b(A.java:2)')
    expect(events).toHaveLength(1)
    expect(events[0]!.trace.split('\n')).toHaveLength(5)
    expect(events[0]!.truncated).toBe(true)

    // Further "at" lines belong to nothing now — the block already closed.
    feed('08-03 12:34:56.789  1234  1234 E AndroidRuntime: \tat com.example.app.A.c(A.java:3)')
    expect(events).toHaveLength(1)
  })
})

describe('createCrashParser — system package tagging (plan 37 §4.2)', () => {
  test('android and com.android.* packages are tagged system: true', () => {
    const { feed, events } = collect()
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: FATAL EXCEPTION: main')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: Process: com.android.systemui, PID: 500')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: java.lang.RuntimeException: system crash')
    feed(UNRELATED_LINE)
    expect(events).toHaveLength(1)
    expect(events[0]!.system).toBe(true)
  })

  test('android itself is tagged system: true', () => {
    const { feed, events } = collect()
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: FATAL EXCEPTION: main')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: Process: android, PID: 500')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: java.lang.RuntimeException: system crash')
    feed(UNRELATED_LINE)
    expect(events[0]!.system).toBe(true)
  })

  test('a launcher package is tagged system: true', () => {
    const { feed, events } = collect()
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: FATAL EXCEPTION: main')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: Process: com.google.android.apps.nexuslauncher, PID: 500')
    feed('08-03 10:00:00.000   500   500 E AndroidRuntime: java.lang.RuntimeException: launcher crash')
    feed(UNRELATED_LINE)
    expect(events[0]!.system).toBe(true)
  })

  test('an ordinary third-party package is tagged system: false', () => {
    const { feed, events } = collect()
    for (const line of FATAL_EXCEPTION_LINES) feed(line)
    feed(UNRELATED_LINE)
    expect(events[0]!.system).toBe(false)
  })
})

describe('createCrashParser — two independent crashes in sequence', () => {
  test('a second FATAL EXCEPTION after the first closes is reported separately', () => {
    const { feed, events } = collect()
    for (const line of FATAL_EXCEPTION_LINES) feed(line)
    feed('08-03 12:35:10.000  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main')
    feed('08-03 12:35:10.000  4321  4321 E AndroidRuntime: Process: com.example.other, PID: 4321')
    feed('08-03 12:35:10.000  4321  4321 E AndroidRuntime: java.lang.ArithmeticException: / by zero')
    feed(UNRELATED_LINE)
    expect(events).toHaveLength(2)
    expect(events[0]!.package).toBe('com.example.app')
    expect(events[1]!.package).toBe('com.example.other')
    expect(events[1]!.exception).toBe('java.lang.ArithmeticException')
  })
})
