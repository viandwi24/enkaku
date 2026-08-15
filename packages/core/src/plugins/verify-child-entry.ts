/**
 * The plugin verification child (plan 82 §3.7 step 2, §3.8) — imports a
 * STAGED bundle and reports its shape back over IPC, then exits. Never
 * anything more than an import: the same "a publish must not run code in
 * the core" boundary `scripts/build.ts` draws for a workspace-authored
 * script, applied here to a bundle that might declare twenty scripts at
 * once instead of one.
 *
 * Two launch shapes, exactly like `@enkaku/session`'s `child-entry.ts`:
 *   dev:      bun <verify-child-entry.ts> <bundlePath>
 *   compiled: <enkaku-binary> --plugin-verify <bundlePath>  (dispatched in
 *             `packages/core/src/index.ts`, mirroring `--job-child`)
 *
 * A bundle that never returns from module scope (an infinite loop, say)
 * blocks THIS process's event loop forever — there is no timer in here that
 * could ever fire. That is precisely why the bound lives in the PARENT
 * (`verify-child.ts`): it kills this process after its budget, and the kill
 * itself is what turns a hang into a `failed` plugin (criterion 21).
 */
import { isPlugin } from '@enkaku/sdk'
import { z } from 'zod'
import { checkDeclaredSchema, RuntimeEnvelopeSchema, type RuntimeEnvelope } from '@enkaku/protocol'

export type VerifyChildMessage =
  | {
      ok: true
      pluginId: string
      version: string
      title?: string
      description?: string
      scripts: { id: string; paramsSchema: unknown; resultSchema?: unknown; runtime: RuntimeEnvelope | null }[]
      resetPackages: string[]
    }
  | { ok: false; error: string }

function send(msg: VerifyChildMessage): void {
  process.send?.(msg)
}

function resolveBundlePath(): string | undefined {
  const flag = process.argv.indexOf('--plugin-verify')
  return flag >= 0 ? process.argv[flag + 1] : process.argv[2]
}

async function main(): Promise<void> {
  const bundlePath = resolveBundlePath()
  try {
    if (!bundlePath) throw new Error('no bundlePath was given to the verify child')
    const mod = (await import(bundlePath)) as { default?: unknown }
    const def = mod.default
    if (!isPlugin(def)) {
      throw new Error('the bundle has no default export produced by definePlugin() — expected a `scripts` array')
    }
    // Publish path 2 of 3 (plan 95 §4.9, §5 step 95.5) — the same
    // `checkDeclaredSchema` gate `POST /api/scripts` runs for a standalone
    // script, applied here to every member of a plugin bundle so a plugin
    // cannot take the path a standalone script cannot. A `'group'` finding
    // is the non-consecutive-group WARNING (plan 95 §3.5) and does not
    // fail verification on its own — every other finding does.
    const scripts = def.scripts.map((s) => {
      const paramsSchema = z.toJSONSchema(s.params as z.ZodTypeAny)
      const findings = checkDeclaredSchema(paramsSchema).filter((f) => f.limit !== 'group')
      if (findings.length > 0) {
        throw new Error(
          `E_PARAMS_SCHEMA_INVALID: script "${s.id}"'s params schema: ${findings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; ')}`,
        )
      }
      // Plan 97 §4.4, §4.7, §5 step 97.2 — publish path 2 of 3 for a
      // RESULT schema, mirroring `paramsSchema` immediately above:
      // OPTIONAL (a member declaring no `result` reports `null` and is
      // never checked), `io: 'output'` (F24 — a defaulted result field is
      // already applied by the time `run()` resolves, unlike a param).
      const memberResult = (s as { result?: unknown }).result
      let resultSchema: unknown = null
      if (memberResult !== undefined) {
        resultSchema = z.toJSONSchema(memberResult as z.ZodTypeAny, { io: 'output' })
        const resultFindings = checkDeclaredSchema(resultSchema).filter((f) => f.limit !== 'group')
        if (resultFindings.length > 0) {
          throw new Error(
            `E_RESULT_SCHEMA_INVALID: script "${s.id}"'s result schema: ${resultFindings.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; ')}`,
          )
        }
      }
      // Plan 98 §3.1, §4.5, §5 step 98.4 — a member's `runtime` was already
      // folded and shape-validated by `definePlugin` on the author's own
      // machine (plan 98 §4.2); re-validated here too, independently,
      // exactly matching this file's own doc comment on why params schemas
      // are re-checked here rather than trusted from the SDK alone — a
      // hand-crafted bundle can carry a `scripts` array that never went
      // through `definePlugin` at all.
      const runtimeParse = RuntimeEnvelopeSchema.nullable().safeParse((s as { runtime?: unknown }).runtime ?? null)
      if (!runtimeParse.success) {
        throw new Error(
          `E_RUNTIME_ENVELOPE_INVALID: script "${s.id}"'s runtime envelope: ${runtimeParse.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
        )
      }
      return { id: s.id, paramsSchema, resultSchema, runtime: runtimeParse.data }
    })
    send({
      ok: true,
      pluginId: def.id,
      version: def.version,
      ...(def.title ? { title: def.title } : {}),
      ...(def.description ? { description: def.description } : {}),
      scripts,
      resetPackages: def.reset?.packages ?? [],
    })
  } catch (err) {
    send({ ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
  } finally {
    // Give the IPC message time to flush before the process exits — the same pattern `child-entry.ts` uses.
    setTimeout(() => process.exit(0), 20)
  }
}

void main()
