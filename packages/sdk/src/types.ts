import type { z } from 'zod'
import type { KeyCode, Point, Selector, UiNode } from '@enkaku/protocol'

export interface WaitForOptions {
  /** Default 10_000 ms. */
  timeout?: number
  /** Default 1_000 ms — realistis untuk uiautomator-dump; ui-server (Plan 06) bisa jauh lebih pendek. */
  intervalMs?: number
}

export interface DeviceApi {
  /** Selector → find → tap titik tengah; { point } → tap langsung. */
  tap(target: Selector): Promise<void>
  swipe(from: Point, to: Point, ms?: number): Promise<void>
  /** M4: `input text` (ASCII-safe); set_text per-elemen = Plan 06. */
  type(text: string): Promise<void>
  key(code: KeyCode): Promise<void>
  find(sel: Selector): Promise<UiNode | null>
  /** Polling inspector — reject ScriptError('WAITFOR_TIMEOUT') bila habis waktu. */
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>
  /** PNG mentah (tanpa menyimpan artifact). */
  screenshot(): Promise<Uint8Array>
  app: {
    launch(pkg: string, opts?: { activity?: string }): Promise<void>
    forceStop(pkg: string): Promise<void>
  }
}

export interface ArtifactApi {
  /** Screenshot diambil DI CORE, disimpan sebagai artifact job. */
  screenshot(label: string): Promise<void>
  file(label: string, data: Uint8Array | string, opts?: { ext?: string }): Promise<void>
}

export interface ScriptLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface ScriptError {
  code: string
  message: string
  phase: 'prepare' | 'run' | 'finish' | 'timeout'
}

export interface ScriptContext<P = unknown> {
  device: DeviceApi
  /** Sudah lolos params.parse(). */
  params: P
  artifact: ArtifactApi
  log: ScriptLogger
  job: { id: string; attempt: number; deviceId: string }
  /** HANYA terisi saat finish dipanggil setelah kegagalan. */
  error?: ScriptError
}

export interface ScriptDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string
  /** Semver. */
  version: string
  params: S
  /** ms per attempt; default 300_000. */
  timeout?: number
  /** Attempt tambahan setelah gagal; default 0. */
  retries?: number
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  /** Return value → jobs.result. */
  run(ctx: ScriptContext<z.infer<S>>): Promise<unknown>
  /** SELALU dijalankan — harus stateless & idempotent (lihat README). */
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<void>
}
