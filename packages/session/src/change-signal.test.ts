import { describe, expect, test } from 'bun:test'
import { createChangeSignal } from './change-signal'

describe('createChangeSignal (plan 222 §4.3)', () => {
  test('a fire before a wait is remembered and consumed once', async () => {
    const signal = createChangeSignal()
    signal.fire()
    const start = Date.now()
    await signal.wait(1_000)
    expect(Date.now() - start).toBeLessThan(50)
    // Consumed: a second wait with no further fire runs out its own timeout.
    const start2 = Date.now()
    await signal.wait(30)
    expect(Date.now() - start2).toBeGreaterThanOrEqual(25)
  })

  test('a fire during a wait resolves it and clears the timer', async () => {
    const signal = createChangeSignal()
    const start = Date.now()
    const waiting = signal.wait(5_000)
    queueMicrotask(() => signal.fire())
    await waiting
    expect(Date.now() - start).toBeLessThan(200)
  })

  test('a wait with no fire resolves after ms', async () => {
    const signal = createChangeSignal()
    const start = Date.now()
    await signal.wait(30)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })

  test('two waits in sequence each need their own fire', async () => {
    const signal = createChangeSignal()
    signal.fire()
    await signal.wait(1_000) // consumes the fire above
    const start = Date.now()
    let resolved = false
    const waiting = signal.wait(5_000).then(() => {
      resolved = true
    })
    await Bun.sleep(20)
    expect(resolved).toBe(false)
    signal.fire()
    await waiting
    expect(resolved).toBe(true)
    expect(Date.now() - start).toBeLessThan(500)
  })
})
