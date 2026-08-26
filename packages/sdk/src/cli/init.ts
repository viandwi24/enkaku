import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { UI_EXTERNALS } from './build-ui'

/**
 * `enkaku init <name>` (plan 110 §4.2, §5 step 110.4, criterion 6; extended by
 * plan 111 §5 step 111.6) — the command that pays for removing `defineScript`.
 *
 * The whole argument against the "Hard" reading of decision A was ceremony:
 * a twenty-line script now has to be wrapped in a plugin. This answers that
 * with a command rather than with a second authoring shape kept alive
 * forever. What it writes must therefore publish with ZERO edits — not
 * "publish once you fill in the TODOs" — because a scaffold an author has to
 * repair is not an answer to the ceremony argument, it is more of it.
 *
 * ## Two shapes, and why the React one is the default
 *
 * ```
 *   enkaku init <name>                 a plugin with a script AND a React screen
 *   enkaku init <name> --script-only   a plugin with a script and nothing else
 * ```
 *
 * The React shape is the default because plan 111's goal is that an author
 * writes ordinary React with no ceiling — and the single most expensive thing
 * they can get wrong is invisible until an operator opens the screen (see
 * `build-ui.ts` on the `jsxDEV` trap). A scaffold whose build flags are
 * already right is the only place that cost can be paid once instead of by
 * every author. `--script-only` survives for the case tier A was kept for: a
 * pack that draws nothing, or draws a declared table, and has no reason to own
 * a frontend project.
 *
 * ## The React scaffold, file by file
 *
 * ```
 *   package.json           @enkaku/sdk + zod; react/@types/react for the UI half
 *   tsconfig.json          standalone, strict, jsx: react-jsx
 *   src/index.ts           definePlugin — one script member AND a surface whose
 *                          view is `react: { entry: 'index.js', apiVersion }`
 *   src/ui/index.tsx       the component, registered on the host
 *   src/ui/index.css       the screen's own Tailwind classes (delete it if you
 *                          only use `@enkaku/ui` — see below)
 *   src/enkaku-host.d.ts   the one ambient declaration `window.__enkaku__` needs
 * ```
 *
 * ## When the stylesheet is needed, and when it is dead weight
 *
 * A plugin renders inside Studio's own document, so it inherits every Tailwind
 * class Studio compiled — which is every class `@enkaku/ui`'s components use.
 * **A screen built only from those components needs no stylesheet at all**, and
 * deleting `src/ui/index.css` (and the two Tailwind devDependencies with it) is
 * the right move for such a plugin: nothing breaks, nothing is emitted.
 *
 * The moment the author writes a class of their OWN — `grid-cols-[200px_1fr]`,
 * `rotate-3`, anything Studio never happened to use — that class was never
 * generated and the markup renders unstyled with no error anywhere. That is
 * what `src/ui/index.css` is for, and why the scaffold ships it: an author who
 * discovers the need later has to be told about a file that does not exist,
 * whereas one who does not need it deletes three lines.
 *
 * `src/ui/` is a convention `enkaku publish` and `enkaku dev` both read
 * (`build-ui.ts`): every top-level source file there becomes `ui/<name>.js`
 * inside the `.enkaku` package, which is exactly what `react.entry` names.
 *
 * The member carries `title` and `description` because the farm surfaces both
 * (plan 108 §0.2 P8) — a scaffold that omitted them would teach every new
 * author to publish a script that shows up as a bare id.
 */

const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/

/**
 * The `@enkaku/ui` major the scaffold declares (plan 111 §3.5). Verify refuses
 * a mismatch by name, so this is a checked incompatibility rather than a
 * runtime explosion in an operator's face.
 *
 * Read from `@enkaku/protocol` rather than written here (step 111.4): the farm
 * compares a plugin's declared `apiVersion` against the very same constant, and
 * a second copy in the scaffold is precisely how a fresh `enkaku init` would
 * come to emit a number its own farm refuses.
 */
const UI_API_VERSION = PLUGIN_UI_API_VERSION

export interface InitOptions {
  /** The plugin id, and the directory name it is scaffolded into. */
  name: string
  /** Where `<name>/` is created. Defaults to the current working directory. */
  cwd?: string
  /** Scaffold the pre-plan-111 three-file project — a script member and no screen. */
  scriptOnly?: boolean
}

export interface InitResult {
  dir: string
  files: string[]
  react: boolean
}

function packageJson(name: string, react: boolean): string {
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
        // `react` is a devDependency on purpose: the UI build marks it
        // EXTERNAL and Studio hands the plugin its own live instance through
        // an import map (plan 111 §3.2). Two Reacts in one page throw
        // `Invalid hook call`, so this copy exists for `tsc` and for an
        // editor, and never ships inside the package.
        //
        // The same is true of `@enkaku/ui`: external at runtime, needed here
        // for its types AND for `src/ui/index.css`'s
        // `@import '@enkaku/ui/theme.css'` — the ONE definition of the farm's
        // design tokens, which both Studio and this project compile against
        // (plan 111 §9 Q1, step 111.9).
        //
        // Tailwind belongs to the PROJECT, never to `@enkaku/sdk`: the SDK is
        // bundled into every plugin, and a CSS compiler has no business in
        // that bundle. `enkaku publish` spawns this project's own
        // `node_modules/.bin/tailwindcss`.
        ...(react ? { '@enkaku/ui': '*', '@tailwindcss/cli': '^4.3.0', '@types/react': '^19', react: '^19.0.0', tailwindcss: '^4.3.0' } : {}),
        typescript: '^5.6.0',
      },
    },
    null,
    2,
  )}\n`
}

function tsconfigJson(react: boolean): string {
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
        // The AUTOMATIC runtime, so a `.tsx` file needs no `import React`.
        // Note this setting governs `tsc` only — Bun's bundler ignores a
        // tsconfig here entirely, which is why `enkaku publish` passes the
        // production transform on the command line instead (see
        // `build-ui.ts`). Both halves have to be right; neither implies the
        // other.
        ...(react ? { jsx: 'react-jsx' } : {}),
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`
}

function scriptMember(): string {
  return `    {
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
    },`
}

function entrySource(name: string, react: boolean): string {
  const member = scriptMember()
  if (!react) {
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
${member}
  ],
})
`
  }

  return `import { definePlugin } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * A plugin is the unit the farm publishes, installs, versions, and rolls back
 * — there is no such thing as a script on its own. Add members to \`scripts\`
 * as the pack grows; they all share this one bundle, this one version, and
 * one KV namespace ('${name}').
 *
 * \`version\` here MUST stay in step with what you publish: the farm compares
 * the two and refuses a mismatch at verify, so a bumped release with a stale
 * number here fails to activate rather than shipping the wrong build.
 */
export default definePlugin({
  id: '${name}',
  version: '1.0.0',
  title: '${name}',
  description: 'A new Enkaku plugin. Replace this with what the pack is for.',

  /**
   * The screen. \`react.entry\` names a file inside the package's \`ui/\`
   * directory, and \`enkaku publish\` builds \`src/ui/index.tsx\` into exactly
   * that — rename one and you must rename the other.
   *
   * \`apiVersion\` is the \`@enkaku/ui\` major this was written against. Studio
   * refuses a mismatch at verify, naming both versions, rather than letting a
   * component built against an older component library break at render.
   */
  surface: {
    nav: [{ id: '${name}', label: '${name}', icon: 'puzzle', view: 'main' }],
    views: {
      main: {
        title: '${name}',
        description: 'Replace this with what the screen is for.',
        react: { entry: 'index.js', apiVersion: ${UI_API_VERSION} },
      },
    },
  },

  scripts: [
${member}
  ],
})
`
}

function uiSource(name: string): string {
  return `import { useEffect, useState } from 'react'
import { Button, EmptyState, ErrorState, LoadingRows, api, z } from '@enkaku/ui'

/**
 * Ordinary React. Hooks work, your own components work, your own layout
 * works — this component renders inside Studio's own tree, with Studio's own
 * React instance, so there is no ceiling and no vocabulary to learn.
 *
 * Three things are worth knowing, and nothing else is:
 *
 * 1. **Studio's components are importable.** \`import { Tabs, Table, Button }
 *    from '@enkaku/ui'\` gives you the same components every built-in screen
 *    is drawn with, so a plugin screen can be indistinguishable from a native
 *    one. They are marked external by the build and resolved to Studio's live
 *    instance at load — never bundle your own copy.
 * 2. **The same package carries the behaviour layer**, so a plugin screen can
 *    BEHAVE like a Studio screen and not merely look like one: \`api()\`,
 *    \`useAction()\`, \`EmptyState\`/\`ErrorState\`/\`LoadingRows\`,
 *    \`relativeTime()\`, and \`z\` (the host's Zod, so a schema costs your
 *    bundle nothing).
 * 3. **You do not have to find the core yourself.** \`api()\` resolves the
 *    path against \`coreBase()\`, which is right whether Studio is served BY
 *    the core (the normal deployment) or on a separate origin
 *    (\`bun run dev:studio\`, page on :3001, core on :7700). Plain
 *    \`fetch('/api/…')\` is only correct in the first case. If you ever want
 *    the origin without \`@enkaku/ui\`, it is
 *    \`new URL(import.meta.url).origin\` — this module was served by the core,
 *    so its own URL is the core's.
 */

/** Whatever you read, validated rather than cast. \`api()\` requires a schema on purpose. */
const EntriesSchema = z.looseObject({ items: z.array(z.looseObject({ key: z.string(), updatedAt: z.number() })) })

function View() {
  const [entries, setEntries] = useState<z.infer<typeof EntriesSchema>['items'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setError(null)
    setEntries(null)
    api('/api/plugins/${name}/data?scope=global', EntriesSchema)
      .then((page) => alive && setEntries(page.items))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [nonce])

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">${name}</h1>
      <p className="text-sm text-fg-muted">
        This screen is a React component shipped by the plugin. Edit
        <code className="mx-1">src/ui/index.tsx</code>, save, and reload.
      </p>

      {error ? (
        <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : entries === null ? (
        <LoadingRows rows={3} />
      ) : entries.length === 0 ? (
        <EmptyState
          title="Nothing stored yet"
          description="This plugin's KV namespace is empty. Write to it from a script, or from this screen."
          action={
            <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
              Reload
            </Button>
          }
        />
      ) : (
        <ul className="space-y-1 text-sm">
          {entries.map((entry) => (
            <li key={entry.key} className="readout">
              {entry.key}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * A module served to Studio does not EXPORT its component — it REGISTERS it.
 * A \`<script type="module">\` has no return value, so the host waits on a
 * promise keyed by (plugin, view) that this call resolves. The id must match
 * the key under \`surface.views\` in \`src/index.ts\`.
 */
window.__enkaku__.register('main', View)
`
}

/**
 * `src/ui/index.css` — the stylesheet for the entry it is named after
 * (`index.tsx` → `index.css` → `ui/index.css` in the package → a `<link>`
 * Studio injects beside the script). Plan 111 §9 Q1, step 111.9.
 *
 * Three imports, and each of the three is load-bearing — the comments in the
 * emitted file say why to the author who opens it.
 */
function uiStyles(name: string): string {
  return `/*
 * ${name}'s own Tailwind classes.
 *
 * Studio renders this plugin inside its own page, so every class Studio itself
 * uses is already available — including everything \`@enkaku/ui\`'s components
 * are built from. **If your screen only uses \`@enkaku/ui\`, delete this file**
 * (and \`@tailwindcss/cli\`/\`tailwindcss\` from package.json): nothing here is
 * needed and nothing is emitted for it.
 *
 * Keep it the moment you write a class of your own. A class Studio never used
 * was never generated, so it renders as nothing at all, with no error anywhere
 * — this file is what compiles yours.
 *
 * \`enkaku publish\` and \`enkaku dev\` run your project's own Tailwind over it.
 * Do NOT import this file from index.tsx: it is compiled and linked for you,
 * and importing it would hand the raw source to a bundler that does not know
 * what Tailwind is.
 */

/*
 * Utilities only, and a theme that RESOLVES but does not emit.
 *
 * Never \`@import 'tailwindcss'\` here. That pulls in preflight — a GLOBAL reset
 * — and Studio's document already has one, so a second copy would restyle
 * every other screen in the farm rather than this view. Publishing refuses a
 * stylesheet that contains it.
 *
 * \`theme(reference)\` is the other half: it registers the tokens so
 * \`bg-surface\` compiles, without writing a \`:root\` block. Studio's live
 * values keep winning, and this plugin can never repaint the farm with a
 * palette frozen on the day it was built.
 *
 * \`layer(plugin)\`, NOT \`layer(utilities)\`, and the difference is not
 * cosmetic. Studio declares the order \`theme, base, components, plugin,
 * utilities\`, so anything here loses a tie against Studio's own utilities.
 * Sharing the \`utilities\` layer instead put this sheet in the SAME layer as
 * the host's, and within a layer the later sheet wins — yours is injected
 * after Studio's. One utility you happen to share is enough: a plugin that
 * merely used \`flex\` emitted \`.flex{display:flex}\`, which outranked
 * Studio's \`.lg\\:hidden\` and un-hid Studio's mobile header on every desktop
 * screen. Your own classes are unaffected either way; they collide with nothing.
 */
@import 'tailwindcss/theme.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(plugin);

/* The farm's design tokens — bg-surface, text-fg-muted, text-led-ok, rounded-card. One definition, shared with Studio. */
@import '@enkaku/ui/theme.css' theme(reference);

/*
 * Hand-written CSS is allowed and is entirely your own risk: this file becomes
 * a stylesheet in Studio's document, so a bare \`button { ... }\` here restyles
 * Studio's buttons too. Scope anything you add.
 */
`
}

function hostTypes(): string {
  return `/**
 * Ambient declarations for the two things Studio puts in the page for a
 * plugin: the view registry on \`window\`, and the \`@enkaku/host\` module.
 *
 * **This file must contain NO top-level \`import\` or \`export\`.** That is not
 * a style preference — it is load-bearing, and getting it wrong fails in a
 * way that points somewhere else entirely (found while wiring plan 129 step
 * 129.7, after the previous version of this template shipped with the bug).
 *
 * The moment a \`.d.ts\` has a top-level \`import\` or \`export\`, TypeScript
 * treats the whole file as a MODULE. A \`declare module '@enkaku/host'\` inside
 * a module file is module AUGMENTATION rather than a new ambient module: it
 * quietly requires \`'@enkaku/host'\` to already resolve some other way, which
 * it never can, because Studio serves it through an import map and it is
 * never published to disk. The symptom is \`Cannot find module
 * '@enkaku/host'\` reported against every file that imports it — never
 * against this one.
 *
 * So every type here is written as an inline \`import('pkg').X\`, which does
 * NOT make the file a module, and \`Window\` is augmented directly instead of
 * through \`declare global\` (that construct requires the file to already be a
 * module — TS2669 otherwise).
 */

interface Window {
  /**
   * NOT optional, deliberately: Studio always installs this before it
   * imports your module, so the scaffold's own \`window.__enkaku__.register(...)\`
   * call needs no guard. Marking it \`?\` makes every plugin's entry file fail
   * with TS18048.
   */
  __enkaku__: {
    /** Registers the component that renders one view id, as declared under \`surface.views\`. */
    register(viewId: string, component: import('react').ComponentType<import('@enkaku/ui').PluginViewProps>): void
  }
}

/**
 * \`@enkaku/host\` — Studio's OWN components, offered through the same
 * host-module table \`@enkaku/ui\` is (plan 129 §3.4, step 129.5). Unlike
 * \`@enkaku/ui\` this is never a published package: Studio hands your module
 * its own live namespace through an import map, so there is nothing on disk
 * for \`tsc\` to resolve without this block.
 *
 * Nothing checks this declaration against Studio's real barrel
 * (\`packages/studio/src/components/host/index.ts\`) — there is no shared
 * package both sides import from, so a drift here cannot fail a build and can
 * only be noticed. If that barrel gains an export, update this by hand.
 */
declare module '@enkaku/host' {
  /**
   * Pick devices from a wall of LIVE tiles — the same tiles the Devices page
   * renders, in a dialog. Choose by looking at the screen rather than by
   * reading a name off a list; each tile shows the device's number, name,
   * stableId and its live picture.
   *
   * It fetches the device list itself, so pass none. \`filter\` narrows what is
   * offered (for example, devices not already in the group you are editing).
   */
  export function DeviceWallWithPicker(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Ids already chosen — shown selected, and returned unchanged unless deselected. */
    value: string[]
    onConfirm: (ids: string[]) => void
    filter?: (device: import('@enkaku/protocol').DeviceInfo) => boolean
    title?: string
  }): import('react').ReactElement | null
}
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
  const react = opts.scriptOnly !== true
  const dir = resolve(opts.cwd ?? process.cwd(), name)
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and is not empty — nothing was written`)
  }

  mkdirSync(join(dir, 'src'), { recursive: true })
  if (react) mkdirSync(join(dir, 'src', 'ui'), { recursive: true })

  const files: Array<[string, string]> = [
    ['package.json', packageJson(name, react)],
    ['tsconfig.json', tsconfigJson(react)],
    [join('src', 'index.ts'), entrySource(name, react)],
    ...(react
      ? ([
          [join('src', 'ui', 'index.tsx'), uiSource(name)],
          [join('src', 'ui', 'index.css'), uiStyles(name)],
          [join('src', 'enkaku-host.d.ts'), hostTypes()],
        ] as Array<[string, string]>)
      : []),
  ]
  for (const [rel, content] of files) writeFileSync(join(dir, rel), content)

  return { dir, files: files.map(([rel]) => rel), react }
}

/** The CLI half: `init()` plus the "what do I do now" the author needs. */
export function initCommand(opts: InitOptions): void {
  const result = init(opts)
  console.log(`✓ created ${basename(result.dir)}/`)
  for (const file of result.files) console.log(`  ${file}`)
  console.log('')
  if (result.react) {
    console.log(`  src/ui/index.tsx is built to ui/index.js and shipped inside the .enkaku package.`)
    console.log(`  src/ui/index.css is compiled to ui/index.css and linked beside it — delete it if you only use @enkaku/ui.`)
    console.log(`  react and ${UI_EXTERNALS.filter((e) => e !== 'react').join(', ')} are resolved by Studio at runtime, never bundled.`)
    console.log('')
  }
  console.log('  next:')
  console.log(`    cd ${basename(result.dir)} && bun install`)
  console.log('    enkaku publish src/index.ts')
  if (result.react) console.log('    enkaku dev src/index.ts    # rebuilds both halves on save')
}
