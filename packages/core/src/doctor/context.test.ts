import { describe, expect, test } from 'bun:test'
import { countTasklistRows, findPortHolderWindows, parseNetstatPidForPort, parseTasklistImageName } from './context'

/**
 * Windows "who holds this port" (plan 85 §4.7, fixes F13) and the
 * `adb.exe` census it shares parsing with (plan 85 §5 85.6). This host is
 * macOS/Linux, so every test below exercises the PARSING against captured
 * real-shape `netstat -ano`/`tasklist` output — the command execution
 * itself is injected, never actually spawned (plan 85 §5 85.6: "structure
 * them so the command execution is injectable").
 */

// A representative `netstat -ano` capture: IPv4 and IPv6 LISTENING sockets
// on the same port (Bun/adb both bind dual-stack), an ESTABLISHED line that
// must NOT be mistaken for a listener, and a UDP line with no State column
// at all (only four fields, not five) that must not crash the parser.
const NETSTAT_FIXTURE = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    0.0.0.0:7700           0.0.0.0:0              LISTENING       21440
  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       9999
  TCP    127.0.0.1:5037         127.0.0.1:52731        ESTABLISHED     9999
  TCP    192.168.1.23:54321     93.184.216.34:443      ESTABLISHED     8888
  TCP    [::]:7700              [::]:0                 LISTENING       21440
  TCP    [::1]:5037             [::]:0                 LISTENING       9999
  UDP    0.0.0.0:5353           *:*                                    2200
`

const TASKLIST_ONE_ROW = `"adb.exe","21440","Console","1","12,345 K"`
const TASKLIST_TWO_ROWS = `"adb.exe","21440","Console","1","12,345 K"\r\n"adb.exe","21441","Console","1","10,000 K"`
const TASKLIST_NO_MATCH = 'INFO: No tasks are running which match the specified criteria.'

describe('parseNetstatPidForPort', () => {
  test('finds the pid of a LISTENING socket on the wanted port', () => {
    expect(parseNetstatPidForPort(NETSTAT_FIXTURE, 7700)).toBe(21440)
  })

  test('prefers a LISTENING line over an ESTABLISHED one on the same port', () => {
    expect(parseNetstatPidForPort(NETSTAT_FIXTURE, 5037)).toBe(9999)
  })

  test('returns null when nothing is listening on that port', () => {
    expect(parseNetstatPidForPort(NETSTAT_FIXTURE, 65535)).toBeNull()
  })

  test('ignores UDP lines, which have no State column, without throwing', () => {
    expect(parseNetstatPidForPort(NETSTAT_FIXTURE, 5353)).toBeNull()
  })

  test('matches an IPv6 bracketed local address the same way as IPv4', () => {
    // Both the IPv4 and IPv6 lines for :7700 belong to the same pid in the
    // fixture, so either being matched first still proves the bracket form
    // parses — this asserts it explicitly against IPv6-only input.
    const ipv6Only = '  TCP    [::]:9999              [::]:0                 LISTENING       555\n'
    expect(parseNetstatPidForPort(ipv6Only, 9999)).toBe(555)
  })

  test('returns null on empty input', () => {
    expect(parseNetstatPidForPort('', 7700)).toBeNull()
  })
})

describe('parseTasklistImageName', () => {
  test('reads the image name from a CSV row', () => {
    expect(parseTasklistImageName(TASKLIST_ONE_ROW)).toBe('adb.exe')
  })

  test('is not confused by the embedded comma in the memory-usage column', () => {
    expect(parseTasklistImageName(TASKLIST_TWO_ROWS)).toBe('adb.exe')
  })

  test('returns null for the "no tasks" INFO line tasklist prints instead of a row', () => {
    expect(parseTasklistImageName(TASKLIST_NO_MATCH)).toBeNull()
  })
})

describe('countTasklistRows', () => {
  test('counts one row', () => {
    expect(countTasklistRows(TASKLIST_ONE_ROW)).toBe(1)
  })

  test('counts multiple rows', () => {
    expect(countTasklistRows(TASKLIST_TWO_ROWS)).toBe(2)
  })

  test('counts zero rows for the "no tasks" INFO line', () => {
    expect(countTasklistRows(TASKLIST_NO_MATCH)).toBe(0)
  })
})

describe('findPortHolderWindows', () => {
  test('resolves pid and image name via netstat then tasklist, and never sends a signal', async () => {
    const calls: string[][] = []
    const runCommand = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'netstat') return NETSTAT_FIXTURE
      if (args[0] === 'tasklist') return TASKLIST_ONE_ROW
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }
    const holder = await findPortHolderWindows(7700, runCommand)
    expect(holder).toEqual({ pid: 21440, processName: 'adb.exe' })
    // Read-only, exactly like the lsof path: only two information-gathering
    // commands, and the tasklist filter names a PID, not a kill target.
    expect(calls).toEqual([
      ['netstat', '-ano'],
      ['tasklist', '/FI', 'PID eq 21440', '/FO', 'CSV', '/NH'],
    ])
    for (const call of calls) {
      expect(call).not.toContain('taskkill')
      expect(call.join(' ')).not.toMatch(/kill/i)
    }
  })

  test('returns null and never calls tasklist when nothing holds the port', async () => {
    const calls: string[][] = []
    const runCommand = async (args: string[]) => {
      calls.push(args)
      return NETSTAT_FIXTURE
    }
    const holder = await findPortHolderWindows(65535, runCommand)
    expect(holder).toBeNull()
    expect(calls).toEqual([['netstat', '-ano']])
  })

  test('falls back to "unknown" when tasklist cannot name the pid', async () => {
    const runCommand = async (args: string[]) => (args[0] === 'netstat' ? NETSTAT_FIXTURE : TASKLIST_NO_MATCH)
    const holder = await findPortHolderWindows(7700, runCommand)
    expect(holder).toEqual({ pid: 21440, processName: 'unknown' })
  })

  test('degrades to null, never throws, when the command runner itself fails (tool missing)', async () => {
    const runCommand = async (): Promise<string> => {
      throw new Error('ENOENT: netstat not found')
    }
    await expect(findPortHolderWindows(7700, runCommand)).resolves.toBeNull()
  })
})
