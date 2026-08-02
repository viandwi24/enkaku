/**
 * Interface 4 lapisan driver (spec §7) — lokasi kanonik shared types.
 * Engine implementations live in packages/drivers (from Plan 03 onward).
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
  /**
   * Whether this chunk can start a decode. Left undefined it means "PNG, so
   * yes"; H.264 sources must set it, because a decoder handed a delta frame
   * right after `configure()` fails outright instead of catching up.
   */
  keyframe?: boolean
}

export interface Transport {
  id: string
  /** The adb transport address — it can change (USB ↔ ip:port). */
  serial: string
  /** Identitas device stabil (spec §7.5). */
  stableId: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  exec(cmd: string): Promise<string>
  /** Binary stdout (screencap and friends) — an M2 extension to spec §7. */
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
