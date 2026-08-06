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

export type VerifyChildMessage =
  | {
      ok: true
      pluginId: string
      version: string
      title?: string
      description?: string
      scripts: { id: string; paramsSchema: unknown }[]
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
    const scripts = def.scripts.map((s) => ({ id: s.id, paramsSchema: z.toJSONSchema(s.params as z.ZodTypeAny) }))
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
