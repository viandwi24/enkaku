import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * `enkaku init <name>` (plan 110 §4.2, §5 step 110.4, criterion 6) — the
 * command that pays for removing `defineScript`.
 *
 * The whole argument against the "Hard" reading of decision A was ceremony:
 * a twenty-line script now has to be wrapped in a plugin. This answers that
 * with a command rather than with a second authoring shape kept alive
 * forever. What it writes must therefore publish with ZERO edits — not
 * "publish once you fill in the TODOs" — because a scaffold an author has to
 * repair is not an answer to the ceremony argument, it is more of it.
 *
 * Three files, nothing else:
 *
 *   <name>/package.json    deps on `@enkaku/sdk` + `zod`, a `publish:farm` script
 *   <name>/tsconfig.json   standalone (an author's project does not extend
 *                          this repo's base config), strict, `noEmit`
 *   <name>/src/index.ts    `definePlugin` with ONE member
 *
 * The member carries `title` and `description` because the farm surfaces both
 * (plan 108 §0.2 P8) — a scaffold that omitted them would teach every new
 * author to publish a script that shows up as a bare id.
 */

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

export interface InitOptions {
  /** The plugin id, and the directory name it is scaffolded into. */
  name: string
  /** Where `<name>/` is created. Defaults to the current working directory. */
  cwd?: string
}

export interface InitResult {
  dir: string
  files: string[]
}

function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        // Not named `publish`: that is npm/bun's own lifecycle verb, and a
        // project script sharing the name is a trap the first time someone
        // types `bun publish` meaning the farm.
        'publish:farm': 'enkaku publish src/index.ts',
        dev: 'enkaku dev src/index.ts',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        '@enkaku/sdk': '*',
        zod: '^4.0.0',
      },
      devDependencies: {
        typescript: '^5.6.0',
      },
    },
    null,
    2,
  )}\n`
}

function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        // `@enkaku/sdk` ships raw TypeScript rather than `.d.ts`, so the
        // libs here have to cover the ambient globals its own sources use
        // (`setTimeout`, `URL`, `TextEncoder`, `AbortSignal`) — DOM is the
        // dependency-free way to get them without pulling in `@types/node`
        // or `@types/bun`.
        lib: ['ES2023', 'DOM'],
        module: 'preserve',
        moduleResolution: 'bundler',
        moduleDetection: 'force',
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`
}

function entrySource(name: string): string {
  return `import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * A plugin is the unit the farm publishes, installs, versions, and rolls back
 * — there is no such thing as a script on its own. Add members to \`scripts\`
 * as the pack grows; they all share this one bundle, this one version, and
 * one KV namespace ('${name}').
 */
export default definePlugin({
  id: '${name}',
  version: '1.0.0',
  title: '${name}',
  description: 'A new Enkaku plugin. Replace this with what the pack is for.',
  scripts: [
    {
      id: 'main',
      // Both are shown by the farm wherever this script is named — a bare id
      // tells an operator nothing.
      title: 'Main',
      description: 'Opens an app, waits for it to draw, and takes a screenshot.',
      params: z.object({
        package: z.string().default('com.android.settings'),
        waitText: z.string().default('Settings'),
      }),
      timeout: 60_000,

      async run(ctx) {
        await ctx.device.app.launch(ctx.params.package)
        const node = await ctx.device.waitFor({ text: ctx.params.waitText }, { timeout: 15_000 })
        await ctx.artifact.screenshot('opened')
        ctx.log.info(\`found "\${ctx.params.waitText}"\`, { bounds: node.bounds })
        return { ok: true }
      },

      // finish() MUST be stateless and idempotent: after a timeout kill the
      // core runs it again, in a fresh process, with nothing but ctx.
      async finish(ctx) {
        await ctx.device.app.forceStop(ctx.params.package)
      },
    },
  ],
})
`
}

/**
 * Refuses an existing non-empty directory rather than overwriting it — a
 * scaffold that can eat an author's work is worse than no scaffold. An empty
 * directory that already exists is fine (`mkdir foo && cd foo` is a normal
 * way to start).
 */
export function init(opts: InitOptions): InitResult {
  const name = opts.name.trim()
  if (!ID_SHAPE.test(name)) {
    throw new Error(`"${name}" is not a usable plugin id — it must match ${ID_SHAPE.source} (lowercase letters, digits and dashes)`)
  }
  const dir = resolve(opts.cwd ?? process.cwd(), name)
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and is not empty — nothing was written`)
  }

  mkdirSync(join(dir, 'src'), { recursive: true })
  const files: Array<[string, string]> = [
    ['package.json', packageJson(name)],
    ['tsconfig.json', tsconfigJson()],
    [join('src', 'index.ts'), entrySource(name)],
  ]
  for (const [rel, content] of files) writeFileSync(join(dir, rel), content)

  return { dir, files: files.map(([rel]) => rel) }
}

/** The CLI half: `init()` plus the "what do I do now" the author needs. */
export function initCommand(opts: InitOptions): void {
  const result = init(opts)
  console.log(`✓ created ${basename(result.dir)}/`)
  for (const file of result.files) console.log(`  ${file}`)
  console.log('')
  console.log('  next:')
  console.log(`    cd ${basename(result.dir)} && bun install`)
  console.log('    enkaku publish src/index.ts')
}
