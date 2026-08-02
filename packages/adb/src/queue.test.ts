import { describe, expect, test } from 'bun:test'
import { AdbError, type AdbErrorCode } from './errors'
import { PerDeviceQueue, Semaphore } from './queue'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// `pending()` bookkeeping updates one `.then()` tick after a task's outer
// promise settles (it lives on a derived `entry.tail` continuation). A
// macrotask boundary guarantees every pending microtask — including that
// continuation — has already run.
const flush = () => sleep(0)

async function expectAdbError(p: Promise<unknown>, code: AdbErrorCode): Promise<void> {
  try {
    await p
    throw new Error(`expected rejection with ${code}, but it resolved`)
  } catch (err) {
    expect(err).toBeInstanceOf(AdbError)
    expect((err as AdbError).code).toBe(code)
  }
}

describe('PerDeviceQueue', () => {
  test('runs tasks for the same serial strictly in order', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const order: number[] = []
    const p1 = queue.run('s1', async () => {
      await sleep(20)
      order.push(1)
    })
    const p2 = queue.run('s1', async () => {
      order.push(2)
    })
    const p3 = queue.run('s1', async () => {
      order.push(3)
    })
    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
    expect(queue.pending('s1')).toBe(0)
  })

  test('a failing task does not poison the next one on the same serial', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const first = queue.run('s1', async () => {
      throw new Error('boom')
    })
    const second = queue.run('s1', async () => 'ok')
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
    expect(queue.pending('s1')).toBe(0)
  })

  test('rejects E_ADB_BUSY beyond maxDepth, without ever opening a socket (task not called)', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const block = deferred<void>()
    const started: number[] = []
    const maxDepth = 2

    // Occupies the running slot; one more fills the depth-2 cap.
    const running = queue.run(
      's1',
      async () => {
        started.push(0)
        await block.promise
      },
      { maxDepth },
    )
    const queued1 = queue.run(
      's1',
      async () => {
        started.push(1)
      },
      { maxDepth },
    )

    let thirdCalled = false
    const rejected = queue.run(
      's1',
      async () => {
        thirdCalled = true
      },
      { maxDepth },
    )

    await expectAdbError(rejected, 'E_ADB_BUSY')
    expect(thirdCalled).toBe(false)
    // The rejected 3rd call never touched the chain — depth-cap rejections
    // happen before anything is enqueued.
    expect(queue.pending('s1')).toBe(2)

    block.resolve()
    await Promise.all([running, queued1])
    await flush()
    expect(started).toEqual([0, 1])
    expect(queue.pending('s1')).toBe(0)
  })

  test('E_ADB_BUSY after queueTimeoutMs elapses while waiting for a turn — task body never runs', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const block = deferred<void>()
    let secondCalled = false

    const running = queue.run('s1', async () => {
      await block.promise
    })
    const timedOut = queue.run(
      's1',
      async () => {
        secondCalled = true
      },
      { queueTimeoutMs: 30 },
    )

    await expectAdbError(timedOut, 'E_ADB_BUSY')
    expect(secondCalled).toBe(false)

    block.resolve()
    await running
    await flush()
    expect(queue.pending('s1')).toBe(0)
  })

  test('an AbortSignal fired while queued prevents execution and rejects E_ADB_ABORTED', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const block = deferred<void>()
    let secondCalled = false
    const controller = new AbortController()

    const running = queue.run('s1', async () => {
      await block.promise
    })
    const aborted = queue.run(
      's1',
      async () => {
        secondCalled = true
      },
      { signal: controller.signal },
    )

    controller.abort()
    await expectAdbError(aborted, 'E_ADB_ABORTED')
    expect(secondCalled).toBe(false)

    block.resolve()
    await running
    await flush()
    expect(queue.pending('s1')).toBe(0)
  })

  test('a signal already aborted before enqueue rejects immediately without running the task', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    const controller = new AbortController()
    controller.abort()
    let called = false
    const result = queue.run(
      's1',
      async () => {
        called = true
      },
      { signal: controller.signal },
    )
    await expectAdbError(result, 'E_ADB_ABORTED')
    expect(called).toBe(false)
    await flush()
    expect(queue.pending('s1')).toBe(0)
  })

  test('pending() returns to 0 after a mix of success, failure, busy, and abort on independent serials', async () => {
    const queue = new PerDeviceQueue(new Semaphore(4))
    const results = await Promise.allSettled([
      queue.run('a', async () => 'ok'),
      queue.run('b', async () => {
        throw new Error('boom')
      }),
      queue.run('c', async () => 'ok', { maxDepth: 0 }),
      (() => {
        const c = new AbortController()
        c.abort()
        return queue.run('d', async () => 'ok', { signal: c.signal })
      })(),
    ])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]?.status).toBe('rejected')
    expect(results[2]?.status).toBe('rejected')
    expect(results[3]?.status).toBe('rejected')
    await flush()
    for (const serial of ['a', 'b', 'c', 'd']) {
      expect(queue.pending(serial)).toBe(0)
    }
  })

  test('pause()/resume() still hold new tasks (Toolchain adb swap depends on this)', async () => {
    const queue = new PerDeviceQueue(new Semaphore(1))
    queue.pause()
    let ran = false
    const p = queue.run('s1', async () => {
      ran = true
    })
    await sleep(20)
    expect(ran).toBe(false)
    queue.resume()
    await p
    expect(ran).toBe(true)
  })
})

describe('Semaphore.resize (plan 23 §4.2)', () => {
  test('raising the cap wakes queued waiters immediately, up to the new capacity', async () => {
    const sem = new Semaphore(1)
    const started: number[] = []
    const releasers: Array<() => void> = []
    const acquireAndTrack = async (n: number) => {
      const release = await sem.acquire()
      started.push(n)
      releasers.push(release)
    }

    // Holds the only slot; the next two queue behind it.
    await acquireAndTrack(0)
    const p1 = acquireAndTrack(1)
    const p2 = acquireAndTrack(2)
    await flush()
    expect(started).toEqual([0])
    expect(sem.waiting).toBe(2)

    sem.resize(3)
    await Promise.all([p1, p2])
    expect(started).toEqual([0, 1, 2])
    expect(sem.inFlight).toBe(3)
    expect(sem.waiting).toBe(0)
    expect(sem.max).toBe(3)

    for (const release of releasers) release()
  })

  test('raising the cap only wakes as many waiters as the new capacity allows', async () => {
    const sem = new Semaphore(1)
    const started: number[] = []
    await sem.acquire() // holds the one slot, never released — capacity stays at 1 available after resize(2)
    const p1 = sem.acquire().then(() => started.push(1))
    const p2 = sem.acquire().then(() => started.push(2))
    await flush()

    sem.resize(2)
    await flush()
    expect(started).toEqual([1])
    expect(sem.inFlight).toBe(2)
    expect(sem.waiting).toBe(1)

    sem.resize(3)
    await p2
    expect(started).toEqual([1, 2])
    expect(sem.waiting).toBe(0)
  })

  test('lowering the cap never revokes a slot already held — holders keep running to completion', async () => {
    const sem = new Semaphore(3)
    const release1 = await sem.acquire()
    const release2 = await sem.acquire()
    const release3 = await sem.acquire()
    expect(sem.inFlight).toBe(3)

    sem.resize(1)
    expect(sem.max).toBe(1)
    expect(sem.inFlight).toBe(3) // unaffected — nothing is forcibly revoked

    let fourthStarted = false
    const p4 = sem.acquire().then((release) => {
      fourthStarted = true
      release()
    })
    await flush()
    expect(fourthStarted).toBe(false) // the smaller cap only constrains what comes next

    release1()
    release2()
    release3()
    await p4
    expect(fourthStarted).toBe(true)
    expect(sem.inFlight).toBe(0)
  })
})
