import type { DeviceMetrics } from '@enkaku/protocol'

/**
 * One shell round trip per device per poll (plan 214 §3.7). Deliberately four
 * `/proc` reads and one `df` in a single `exec` rather than four execs: the
 * poller runs on every online device every `battery.pollIntervalSec`, and on a
 * 100 device farm the difference is 100 adb round trips per minute against
 * 400. `top` is not used at all: it costs a sampling delay on the phone, and
 * two `/proc/stat` reads a minute apart answer the same question for free.
 */
export const METRICS_PROBE =
  "echo __UP; cat /proc/uptime; echo __MEM; grep -E '^Mem(Total|Available):' /proc/meminfo; echo __CPU; grep -E '^cpu ' /proc/stat; echo __DF; df /data"

/** The `/proc/stat` counters one sample carries, kept per device so the next sample can difference them. */
export interface CpuSample {
  idle: number
  total: number
}

export interface ParsedMetrics {
  metrics: DeviceMetrics
  /** Carry into the next call for this device; `null` when `/proc/stat` was unreadable. */
  cpu: CpuSample | null
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Extracts the text between marker `name` and the next `__` marker (or the end of the string), trimmed. Empty when the marker is missing. */
function section(raw: string, name: string): string {
  const markerIdx = raw.indexOf(`__${name}`)
  if (markerIdx === -1) return ''
  const afterMarker = raw.slice(markerIdx + name.length + 2)
  const nextMarkerIdx = afterMarker.indexOf('__')
  return (nextMarkerIdx === -1 ? afterMarker : afterMarker.slice(0, nextMarkerIdx)).trim()
}

/**
 * Pure, so it is provable without a phone. `prev` is the previous call's
 * `cpu`; with no previous sample `cpuPercent` is `null` rather than a guess.
 * Every field independently degrades to `null` when its source line is
 * missing, which is what an OEM that refuses one of these reads produces.
 */
export function parseDeviceMetrics(raw: string, prev: CpuSample | null, nowSec: number): ParsedMetrics {
  let uptimeSec: number | null = null
  try {
    const upSection = section(raw, 'UP')
    const firstToken = upSection.split(/\s+/)[0]
    const n = firstToken ? Number.parseFloat(firstToken) : Number.NaN
    uptimeSec = Number.isFinite(n) ? Math.floor(n) : null
  } catch {
    uptimeSec = null
  }

  let memPercent: number | null = null
  try {
    const memSection = section(raw, 'MEM')
    const totalMatch = /^MemTotal:\s*(\d+)/m.exec(memSection)
    const availMatch = /^MemAvailable:\s*(\d+)/m.exec(memSection)
    if (totalMatch?.[1] && availMatch?.[1]) {
      const total = Number.parseInt(totalMatch[1], 10)
      const available = Number.parseInt(availMatch[1], 10)
      if (total > 0) memPercent = clamp(round1(((total - available) / total) * 100))
    }
  } catch {
    memPercent = null
  }

  let cpu: CpuSample | null = null
  let cpuPercent: number | null = null
  try {
    const cpuSection = section(raw, 'CPU')
    const cpuLine = /^cpu\s+(.*)$/m.exec(cpuSection)
    if (cpuLine?.[1]) {
      const fields = cpuLine[1].trim().split(/\s+/).map((f) => Number.parseInt(f, 10))
      // user nice system idle iowait irq softirq steal guest guest_nice
      const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0, guest = 0, guestNice = 0] = fields
      const total = user + nice + system + idle + iowait + irq + softirq + steal + guest + guestNice
      cpu = { idle: idle + iowait, total }
      if (prev && total - prev.total > 0) {
        cpuPercent = clamp(round1(100 * (1 - (cpu.idle - prev.idle) / (total - prev.total))))
      }
    }
  } catch {
    cpu = null
    cpuPercent = null
  }

  let diskPercent: number | null = null
  try {
    const dfSection = section(raw, 'DF')
    const lines = dfSection.split('\n').filter((l) => l.trim().length > 0)
    const lastLine = lines[lines.length - 1]
    const pctMatch = lastLine ? /(\d+)%/.exec(lastLine) : null
    diskPercent = pctMatch?.[1] ? Number.parseInt(pctMatch[1], 10) : null
  } catch {
    diskPercent = null
  }

  return {
    metrics: { cpuPercent, memPercent, diskPercent, uptimeSec, updatedAt: nowSec },
    cpu,
  }
}
