import type { DeviceInfo } from '@enkaku/protocol'
import { coreBase } from './ws'

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const res = await fetch(`${coreBase()}/api/devices`)
  if (!res.ok) throw new Error(`GET /api/devices → ${res.status}`)
  const body = (await res.json()) as { devices: DeviceInfo[] }
  return body.devices
}

export interface HealthResponse {
  ok: boolean
  version: string
  adb: { state: string; serverVersion: string | null }
  deviceCount: number
  uptimeMs: number
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${coreBase()}/api/health`)
  return (await res.json()) as HealthResponse
}
