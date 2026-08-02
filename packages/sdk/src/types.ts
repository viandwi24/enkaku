import type { z } from 'zod'
import type { KeyCode, Point, Selector, UiNode } from '@enkaku/protocol'

export interface WaitForOptions {
  /** Default 10_000 ms. */
  timeout?: number
  /** Defaults to 1_000 ms — realistic for uiautomator-dump; ui-server (Plan 06) can be far shorter. */
  intervalMs?: number
}

export interface DeviceApi {
  /** Selector → find → tap its centre point; { point } → tap directly. */
  tap(target: Selector): Promise<void>
  swipe(from: Point, to: Point, ms?: number): Promise<void>
  /** M4: `input text` (ASCII-safe); set_text per-elemen = Plan 06. */
  type(text: string): Promise<void>
  key(code: KeyCode): Promise<void>
  find(sel: Selector): Promise<UiNode | null>
  /** Polls the inspector — rejects with ScriptError('WAITFOR_TIMEOUT') when time runs out. */
  waitFor(sel: Selector, opts?: WaitForOptions): Promise<UiNode>
  /** Raw PNG (without saving an artifact). */
  screenshot(): Promise<Uint8Array>
  app: {
    launch(pkg: string, opts?: { activity?: string }): Promise<void>
    forceStop(pkg: string): Promise<void>
  }
}

export interface ArtifactApi {
  /** The screenshot is taken IN THE CORE and stored as a job artifact. */
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
  /** Already through params.parse(). */
  params: P
  artifact: ArtifactApi
  log: ScriptLogger
  job: { id: string; attempt: number; deviceId: string }
  /** Only set when finish runs after a failure. */
  error?: ScriptError
}

export interface ScriptDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string
  /** Semver. */
  version: string
  params: S
  /** ms per attempt; default 300_000. */
  timeout?: number
  /** Extra attempts after a failure; defaults to 0. */
  retries?: number
  prepare?(ctx: ScriptContext<z.infer<S>>): Promise<void>
  /** Return value → jobs.result. */
  run(ctx: ScriptContext<z.infer<S>>): Promise<unknown>
  /** ALWAYS runs — must be stateless and idempotent (see the README). */
  finish?(ctx: ScriptContext<z.infer<S>>): Promise<void>
}
