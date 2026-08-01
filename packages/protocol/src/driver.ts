/**
 * Interface 4 lapisan driver (spec §7) — lokasi kanonik shared types.
 * Implementasi engine di packages/drivers (mulai Plan 03).
 */
import type { Selector, UiNode } from './ui-node'

export interface Point {
  x: number
  y: number
}

export interface FrameMeta {
  width: number
  height: number
  codec: 'png' | 'h264'
  seq: number
  capturedAt: number
}

export interface Transport {
  id: string
  /** Alamat transport adb — bisa berubah (USB ↔ ip:port). */
  serial: string
  /** Identitas device stabil (spec §7.5). */
  stableId: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  exec(cmd: string): Promise<string>
  /** Stdout binary (screencap dsb) — ekstensi M2 terhadap spec §7. */
  execOut(cmd: string): Promise<Uint8Array>
}

export interface DisplaySource {
  id: string
  start(): Promise<void>
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void
  stop(): Promise<void>
}

export interface InputSink {
  id: string
  mode: 'sdk' | 'uhid' | 'aoa'
  tap(p: Point): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  key(code: number): Promise<void>
  text(s: string): Promise<void>
}

/** Engine inspeksi UI (spec §7): `uiautomator-dump` (M4), `ui-server` (M4.5). */
export interface Inspector {
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
}
