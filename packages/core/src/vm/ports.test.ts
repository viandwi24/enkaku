import { describe, expect, test } from 'bun:test'
import { EnkakuError } from '../util/errors'
import { VM_PORT_MAX, VM_PORT_MIN, nextFreeConsolePort } from './ports'

function neverBusy(): Promise<boolean> {
  return Promise.resolve(false)
}

function alwaysBusy(): Promise<boolean> {
  return Promise.resolve(true)
}

function busyOn(...ports: number[]): (port: number) => Promise<boolean> {
  const set = new Set(ports)
  return (port: number) => Promise.resolve(set.has(port))
}

describe('nextFreeConsolePort', () => {
  test('an empty farm gets 5554', async () => {
    const port = await nextFreeConsolePort({ taken: new Set(), probe: neverBusy })
    expect(port).toBe(5554)
  })

  test('a taken 5554 gets 5556', async () => {
    const port = await nextFreeConsolePort({ taken: new Set([5554]), probe: neverBusy })
    expect(port).toBe(5556)
  })

  test('a probe-busy 5554 gets 5556', async () => {
    const port = await nextFreeConsolePort({ taken: new Set(), probe: busyOn(5554) })
    expect(port).toBe(5556)
  })

  test('both taken and busy skip correctly', async () => {
    const port = await nextFreeConsolePort({ taken: new Set([5554]), probe: busyOn(5556) })
    expect(port).toBe(5558)
  })

  test('only even ports are ever returned', async () => {
    const calledPorts: number[] = []
    const probe = async (port: number) => {
      calledPorts.push(port)
      return false
    }
    await nextFreeConsolePort({ taken: new Set(), probe })
    for (const port of calledPorts) {
      expect(port % 2).toBe(0)
    }
  })

  test('an exhausted range throws E_VM_NO_PORT', async () => {
    let caught: unknown
    try {
      await nextFreeConsolePort({ taken: new Set(), probe: alwaysBusy })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EnkakuError)
    expect((caught as EnkakuError).code).toBe('E_VM_NO_PORT')
  })

  test('the range boundaries are 5554 and 5682', () => {
    expect(VM_PORT_MIN).toBe(5554)
    expect(VM_PORT_MAX).toBe(5682)
  })
})
