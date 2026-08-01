'use client'

import type { BatteryState, DeviceInfo } from '@enkaku/protocol'

export function DeviceCard({ device, battery }: { device: DeviceInfo; battery?: BatteryState | null }) {
  const clickable = device.status !== 'offline'
  const body = (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="card-title">{device.label}</span>
        <span className={`badge ${device.status}`}>{device.status}</span>
      </div>
      <div className="meta">{device.serial}</div>
      <div className="meta">
        {device.androidVersion ? `Android ${device.androidVersion}` : 'Android ?'}
        {device.apiLevel ? ` (API ${device.apiLevel})` : ''}
        {device.screenW && device.screenH ? ` · ${device.screenW}×${device.screenH}` : ''}
      </div>
      {battery && (
        <div className="row" style={{ marginTop: '0.4rem', gap: '0.4rem' }}>
          <span className={`badge ${battery.level < 20 ? 'quarantined' : 'idle'}`}>🔋 {battery.level}%</span>
          <span className={`badge ${battery.temperatureC >= 45 ? 'quarantined' : ''}`}>
            🌡 {battery.temperatureC.toFixed(1)}°C
          </span>
          {battery.status === 'charging' && <span className="hint">charging</span>}
        </div>
      )}
    </>
  )
  return clickable ? (
    <a className="card" href={`/device?id=${encodeURIComponent(device.id)}`}>
      {body}
    </a>
  ) : (
    <div className="card" style={{ opacity: 0.65 }}>
      {body}
    </div>
  )
}
