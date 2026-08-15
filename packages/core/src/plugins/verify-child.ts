import { fileURLToPath } from 'node:url'
import type { RuntimeEnvelope } from '@enkaku/protocol'
import type { VerifyChildMessage } from './verify-child-entry'

/**
 * Stages → verifies → activates (plan 82 §3.7). This is step 2: a
 * throwaway child process — the same isolation a job uses — imports a
 * staged bundle and reports what it declares. The import happens in a
 * CHILD, never in the core's own process, for the same reason
 * `scripts/build.ts` refuses to execute what it bundles: a publish must
 * not be able to run code in the core.
 *
 * Bounded at 15s (§3.7) — a bundle that never returns from module scope is
 * killed, not waited on, and reported as a verification failure rather than
 * hanging the whole stage/verify/activate pipeline (criterion 21).
 */

export interface VerifiedScript {
  id: string
  paramsSchema: unknown
  /**
   * Plan 97 §4.4, §4.7, §5 step 97.2 — already `checkDeclaredSchema`-gated by
   * the child (`verify-child-entry.ts`), mirroring `paramsSchema` above
   * exactly. `null` for a member that declares no `result`. OPTIONAL here
   * (unlike `paramsSchema`) purely so a hand-built `VerifiedScript` fixture
   * written before this field existed — several live outside this file's
   * own ownership list — keeps compiling with no edit of its own; every
   * REAL verify-child report always sets it, never omits it.
   */
  resultSchema?: unknown
  /** Plan 98 §3.1, §5 step 98.4 — already validated by the child (`verify-child-entry.ts`'s own `RuntimeEnvelopeSchema.safeParse`), so this is trusted as typed rather than re-checked here, matching how `paramsSchema` above is trusted once the child's own `checkDeclaredSchema` gate passes. */
  runtime: RuntimeEnvelope | null
}

export interface VerifyReport {
  ok: boolean
  pluginId?: string
  version?: string
  title?: string
  description?: string
  scripts: VerifiedScript[]
  resetPackages: string[]
  error?: string
  errorCode?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/** True inside a `bun build --compile` executable — mirrors `@enkaku/session`'s `isolation.ts#isCompiledBinary` (kept as a local copy rather than a cross-package import: that helper is not part of `@enkaku/session`'s public export list, and duplicating two lines is cheaper and safer than widening that package's surface for one caller). */
function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs') || Bun.main.includes('~BUN')
}

function failure(error: string, errorCode: string): VerifyReport {
  return { ok: false, error, errorCode, scripts: [], resetPackages: [] }
}

/** Independent re-validation of what the child reported (§3.7 step 2) — never trusts the SDK's own `definePlugin()` checks alone, since a hand-crafted bundle could bypass them. */
function finalizeReport(msg: VerifyChildMessage, expectedVersion?: string): VerifyReport {
  if (!msg.ok) return failure(msg.error, 'E_PLUGIN_VERIFY_FAILED')

  const seen = new Set<string>()
  for (const s of msg.scripts) {
    if (!ID_SHAPE.test(s.id)) {
      return failure(`script id "${s.id}" does not match ${ID_SHAPE}`, 'E_PLUGIN_BAD_SCRIPT_ID')
    }
    if (seen.has(s.id)) {
      return failure(`duplicate script id "${s.id}" (criterion 22)`, 'E_PLUGIN_DUPLICATE_SCRIPT_ID')
    }
    seen.add(s.id)
  }
  if (expectedVersion !== undefined && msg.version !== expectedVersion) {
    return failure(
      `the bundle declares version "${msg.version}", which does not match the staged version "${expectedVersion}"`,
      'E_PLUGIN_VERSION_MISMATCH',
    )
  }
  return {
    ok: true,
    pluginId: msg.pluginId,
    version: msg.version,
    title: msg.title,
    description: msg.description,
    scripts: msg.scripts,
    resetPackages: msg.resetPackages,
  }
}

export interface VerifyPluginBundleOptions {
  timeoutMs?: number
  /** The staged row's own `version` column — the child's reported version must match it (§3.7 step 2). Omit to skip that check (used by tests that only care about shape). */
  expectedVersion?: string
  /** Override for tests — defaults to `verify-child-entry.ts` next to this file. */
  entryPath?: string
}

/** Spawns the bounded verification child and returns its (re-validated) report — never throws; a failure of any kind (bad bundle, timeout, crash) comes back as `{ ok: false, error, errorCode }`, matching §3.8's "assembling the script registry never throws" one level down. */
export async function verifyPluginBundle(bundlePath: string, opts?: VerifyPluginBundleOptions): Promise<VerifyReport> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const entryPath = opts?.entryPath ?? fileURLToPath(new URL('./verify-child-entry.ts', import.meta.url))
  const cmd = isCompiledBinary() ? [process.execPath, '--plugin-verify', bundlePath] : [process.execPath, entryPath, bundlePath]

  return await new Promise<VerifyReport>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const proc = Bun.spawn(cmd, {
      ipc(message) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(finalizeReport(message as VerifyChildMessage, opts?.expectedVersion))
        proc.kill()
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGKILL')
      resolve(failure(`plugin verification exceeded its ${timeoutMs}ms budget`, 'E_PLUGIN_VERIFY_TIMEOUT'))
    }, timeoutMs)

    void proc.exited.then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(failure('the verification child exited without reporting anything', 'E_PLUGIN_VERIFY_CRASHED'))
    })
  })
}
