import { EnkakuError } from '../util/errors'
import { normaliseWorkspacePath } from '../workspace/path'
import type { WorkspaceStore } from '../workspace/store'

/**
 * Server-side bundling of a workspace-authored script (plan 64 §3.5, §4.4,
 * step 64.5) — `script.publish`'s `{ path }` input form. This is the
 * security boundary the plan names explicitly, not an optimisation:
 *
 *   - **Import allowlist.** `@enkaku/sdk` and `zod` (its one runtime
 *     dependency a script ever imports directly) — everything else bare
 *     is a build failure naming the specifier, INCLUDING every `node:*`
 *     builtin.
 *   - **No filesystem resolution.** Every relative/absolute import inside
 *     the graph resolves against `workspace`, through a Bun plugin, and
 *     NEVER against `node:fs`/real disk.
 *   - **Bounded.** 30s wall clock, 20 MiB of output.
 *   - **Never executed.** `Bun.build` parses and bundles; it does not run
 *     the entry. If a script needs to run to be validated, it runs as a
 *     JOB, on a device, under Plan 63's checks — never on the core's own
 *     process during a publish.
 *
 * The allowlist and "no filesystem resolution" rules are enforced by a
 * static walk of the import graph BEFORE `Bun.build` is ever called
 * (`walkWorkspaceGraph` below) — not by `Bun.build`'s own plugin hooks
 * alone. Bun's bundler auto-externalises recognised `node:*` builtins under
 * `target: 'bun'` WITHOUT ever invoking a plugin's `onResolve`, so a plugin
 * that only rejects imports it is asked to resolve would silently let
 * `node:fs` through. Pre-validating the whole graph ourselves closes that
 * gap regardless of which build target is used underneath.
 */

const ALLOWED_BARE_SPECIFIERS = new Set(['@enkaku/sdk', 'zod'])
const WORKSPACE_NAMESPACE = 'enkaku-workspace'
const ENTRY_SPECIFIER = 'enkaku-workspace-entry'

export interface BuiltScript {
  bundle: string
  source: string
}

export interface BuildOptions {
  /** Wall-clock budget for the whole build (default 30s, plan 64 §4.4). */
  timeoutMs?: number
  /** Output size cap (default 20 MiB, plan 64 §4.4). */
  maxOutputBytes?: number
  /** Import-graph size cap — not named by the plan, but "bounded" applies here too. */
  maxFiles?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_FILES = 500

function isRelativeOrAbsolute(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/')
}

/** Resolves `spec` (relative or workspace-absolute) against `importer`'s own
 * directory, clamped at the workspace root — this is plain string
 * arithmetic, no `node:path`, and never touches disk. */
function resolveWithinWorkspace(importer: string, spec: string): string {
  const stack = importer.split('/').slice(0, -1) // drop the importer's own filename
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 1) stack.pop() // never pop past the root sentinel
      continue
    }
    stack.push(part)
  }
  return stack.join('/') || '/'
}

function assertAllowedBareSpecifier(spec: string): void {
  if (spec.startsWith('node:') || !ALLOWED_BARE_SPECIFIERS.has(spec)) {
    throw new EnkakuError(
      'E_BUILD_FAILED',
      `import not allowed: "${spec}" — only @enkaku/sdk and zod may be imported directly; everything else must be another workspace path`,
    )
  }
}

/**
 * Walks the import graph starting at `entry`, following only relative and
 * workspace-absolute imports, and validating EVERY bare specifier — before
 * any `Bun.build` call is made. Returns every workspace file the entry
 * actually reaches, source text included, so the subsequent build never
 * needs to touch the store again.
 */
function walkWorkspaceGraph(workspace: WorkspaceStore, entry: string, maxFiles: number): Map<string, string> {
  const files = new Map<string, string>()
  const queue = [entry]
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })

  while (queue.length > 0) {
    const path = queue.pop() as string
    if (files.has(path)) continue
    if (files.size >= maxFiles) {
      throw new EnkakuError('E_BUILD_FAILED', `this script's import graph exceeds the ${maxFiles}-file limit`)
    }

    let text: string
    try {
      const file = workspace.read(path)
      text = new TextDecoder().decode(file.content)
    } catch {
      throw new EnkakuError('E_BUILD_FAILED', `cannot resolve "${path}" — no such workspace file`)
    }
    files.set(path, text)

    let imports: { path: string }[]
    try {
      imports = transpiler.scanImports(text)
    } catch (err) {
      throw new EnkakuError('E_BUILD_FAILED', `could not parse "${path}": ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const imp of imports) {
      if (isRelativeOrAbsolute(imp.path)) {
        queue.push(resolveWithinWorkspace(path, imp.path))
      } else {
        assertAllowedBareSpecifier(imp.path)
      }
    }
  }
  return files
}

/** The plugin the real `Bun.build` call runs under — resolution is
 * restricted to the ALREADY-VALIDATED `files` map for anything reached from
 * inside it; an allowlisted bare specifier is handed to Bun's normal
 * (real-disk) resolution, since `@enkaku/sdk`/`zod` are fixed, vetted code
 * the core itself ships with, not attacker-controlled content. */
function workspacePlugin(files: ReadonlyMap<string, string>, entry: string): import('bun').BunPlugin {
  return {
    name: 'enkaku-workspace',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point-build') {
          return { path: entry, namespace: WORKSPACE_NAMESPACE }
        }
        if (!files.has(args.importer)) {
          // The importer is a real disk file (inside an allowlisted
          // package's own internals, e.g. `@enkaku/sdk` resolving its own
          // `@enkaku/protocol` dependency) — resolve it explicitly rather
          // than returning `undefined` and hoping Bun's implicit default
          // resolution reaches the same node_modules Bun itself is running
          // from; under some hosts (notably `bun test`'s execution context)
          // that implicit path does not reliably find a workspace package's
          // OWN workspace dependencies, even though `import.meta.resolveSync`
          // from the importer's own location always does.
          return { path: import.meta.resolveSync(args.path, args.importer) }
        }
        if (isRelativeOrAbsolute(args.path)) {
          const resolved = resolveWithinWorkspace(args.importer, args.path)
          if (!files.has(resolved)) {
            throw new Error(`internal: "${resolved}" was not part of the pre-validated import graph`)
          }
          return { path: resolved, namespace: WORKSPACE_NAMESPACE }
        }
        // Already validated by `walkWorkspaceGraph` — resolve for real.
        return { path: import.meta.resolveSync(args.path, import.meta.url) }
      })
      build.onLoad({ filter: /.*/, namespace: WORKSPACE_NAMESPACE }, (args) => {
        const contents = files.get(args.path)
        if (contents === undefined) throw new Error(`internal: "${args.path}" was not part of the pre-validated import graph`)
        return { contents, loader: 'tsx' }
      })
    },
  }
}

/** A generic "run this, but refuse after `ms`" wrapper — exported for direct testing (`build.test.ts`'s acceptance #10 case), the same pattern `capability/invoke.ts`'s own deadline enforcement uses. */
export function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnkakuError('E_BUILD_TIMEOUT', `build exceeded its ${ms}ms budget`)), ms)
    run().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Bundles a workspace-authored script for `script.publish`'s `{ path }`
 * input form (plan 64 §3.5, §4.4). Never executes `entryPathRaw` or
 * anything it imports — see the module doc above.
 */
export async function buildScriptFromWorkspace(workspace: WorkspaceStore, entryPathRaw: string, opts?: BuildOptions): Promise<BuiltScript> {
  const entry = normaliseWorkspacePath(entryPathRaw)
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES
  const maxOutputBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const run = async (): Promise<BuiltScript> => {
    const entryFile = workspace.read(entry) // E_NOT_FOUND if it does not exist — thrown before the walk repeats the read
    const source = new TextDecoder().decode(entryFile.content)
    const files = walkWorkspaceGraph(workspace, entry, maxFiles)

    const result = await Bun.build({
      entrypoints: [ENTRY_SPECIFIER],
      target: 'bun',
      format: 'esm',
      plugins: [workspacePlugin(files, entry)],
    })
    if (!result.success) {
      throw new EnkakuError('E_BUILD_FAILED', result.logs.map((l) => String(l)).join('\n') || 'the build failed for an unknown reason')
    }
    const output = result.outputs[0]
    if (!output) throw new EnkakuError('E_BUILD_FAILED', 'the build produced no output')
    const bundle = await output.text()
    const bytes = new TextEncoder().encode(bundle).length
    if (bytes > maxOutputBytes) {
      throw new EnkakuError('E_BUILD_FAILED', `the bundle is ${bytes} bytes, over the ${maxOutputBytes}-byte limit`)
    }
    return { bundle, source }
  }

  return withTimeout(run, timeoutMs)
}
