import { z } from 'zod'
import type { RecordingDoc, RecordingStep, RecordingTarget } from '@enkaku/protocol'

/**
 * The compiler (plan 94 §4.7, §5 step 94.5) — turns a reviewed
 * `RecordingDoc` into the TWO kinds of generated source this plan's whole
 * design hangs on (§3.1's diagram): the THIN `defineRecording({...})` entry
 * that gets regenerated on every publish (wrapped, since plan 110 §3.4, in the
 * one-member `recordings` plugin that owns it), and the EXPANDED plain
 * `defineScript({...})` entry `POST /api/recordings/:slug/detach` writes
 * once and never touches again. Both are pure functions of `doc` — no I/O,
 * no randomness, no wall clock — so publishing twice with no edit in
 * between writes byte-identical bytes (§4.7's own "a recompile that changes
 * nothing writes nothing").
 *
 * Neither function here executes anything (F18, F11): they produce TEXT,
 * which `packages/core/src/api/recordings.ts` then writes into the
 * workspace and hands to the SAME `buildScriptFromWorkspace` /
 * `ctx.scripts.publish` path an operator's own hand-authored script already
 * goes through.
 */

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
}

/**
 * A small, deliberately naive JS-literal printer — NOT a general serialiser.
 * Every value this file ever hands it comes straight off `RecordingDocSchema`
 * (already Zod-validated numbers/strings/booleans/plain objects/arrays), so
 * the only escaping that matters is a quote or backslash inside a recorded
 * string (a tapped button's text, a typed literal). Object keys print
 * unquoted when they are already valid identifiers (`x`, `y`, `atMs`, `id`,
 * …) to match this repo's own code style (00-overview §4: "no semicolons,
 * single quotes, two-space indent") — quoted otherwise.
 */
function jsLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
  }
  if (Array.isArray(value)) return `[${value.map(jsLiteral).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  return `{ ${entries.map(([k, v]) => `${isIdentifier(k) ? k : jsLiteral(k)}: ${jsLiteral(v)}`).join(', ')} }`
}

/** §3.6's own composition rule, applied literally: the same clamp `defineRecording`'s interpreter (`@enkaku/sdk`) runs at replay. */
function effectiveGapMs(step: RecordingStep, doc: RecordingDoc): number {
  return Math.min(Math.round(step.gapMs * doc.speed), doc.maxGapMs)
}

/** Every distinct `{ param }` name referenced by a `text` step (§4.2) — mirrors `define-recording.ts`'s own `collectParamNames`, duplicated rather than imported because that function is not exported from the SDK's public surface (it is this file's own compiled OUTPUT that needs to agree with it, not a shared dependency). */
export function collectParamNames(doc: RecordingDoc): string[] {
  const names = new Set<string>()
  for (const step of doc.steps) {
    if (step.kind === 'text' && typeof step.value === 'object') names.add(step.value.param)
  }
  return [...names].sort()
}

/**
 * The compiled script's own declared parameter schema (plan 94 §4.2) — every
 * `{ param }` reference becomes one REQUIRED `z.string()` field, exactly as
 * `defineRecording` builds it at runtime. Returned as a real Zod schema so
 * both `emitRecordingEntry`'s reader (a human) and `POST
 * /:slug/publish` (which needs a JSON Schema for the `scripts.paramsSchema`
 * column, never executing the bundle to discover it — F11) can use it.
 */
export function paramsSchemaFor(doc: RecordingDoc): z.ZodTypeAny {
  const names = collectParamNames(doc)
  return z.object(Object.fromEntries(names.map((name) => [name, z.string()])))
}

/** The JSON Schema `publishScript`'s `paramsSchema` column stores — derived the same way `compileWorkflowParams` derives one for a workflow, without ever importing or executing the compiled bundle (F11). */
export function paramsJsonSchemaFor(doc: RecordingDoc): unknown {
  return z.toJSONSchema(paramsSchemaFor(doc))
}

/**
 * Emits the generated entry from a recording document (plan 94 §3.1, §4.7).
 * Deterministic: the same document always produces byte-identical output, so a
 * "recompile" that changes nothing writes nothing — `recordings.test.ts`'s own
 * idempotency test relies on this.
 *
 * Since plan 110 §3.4 the entry's default export is a one-member PLUGIN rather
 * than a bare `defineRecording` result. Three things depend on it being a real
 * plugin bundle rather than a row that merely claims to be one:
 *
 * 1. `child-entry.ts` selects a member out of a plugin bundle by
 *    `ENKAKU_SCRIPT_EXPORT_ID`, which is the `scripts.export_id` this row now
 *    carries — a bundle with no `scripts` array would silently ignore it;
 * 2. `ctx.kv`'s namespace is the plugin id the CHILD reports
 *    (`job-runner.ts`: `meta.pluginId ?? meta.scriptId`), so this is what
 *    actually delivers §3.4's "one KV namespace for recordings" instead of one
 *    namespace per recording;
 * 3. the plugin's version is the RECORDING's version, and `definePlugin`
 *    refuses a member that disagrees with it — an assertion, for free, that
 *    the bundle and the row were published from the same document.
 */
export function emitRecordingEntry(doc: RecordingDoc): string {
  const json = JSON.stringify(doc, null, 2)
  return [
    `// GENERATED by Enkaku's recorder from /recordings/${doc.name}.recording.json.`,
    `// Edits here are overwritten on the next compile — use "Detach" to take ownership.`,
    `import { definePlugin, defineRecording } from '@enkaku/sdk'`,
    '',
    `// Published as "recordings/${doc.name}" (plan 110 §3.4): a script cannot exist`,
    `// outside a plugin, and every recording is a member of the farm's own one.`,
    `export default definePlugin({`,
    `  id: 'recordings',`,
    `  version: ${jsLiteral(doc.version)},`,
    `  scripts: [`,
    `    defineRecording(${json}),`,
    `  ],`,
    `})`,
    '',
  ].join('\n')
}

function dispatchLine(step: RecordingStep): string {
  switch (step.kind) {
    case 'tap': {
      const t: RecordingTarget = step.target
      if (t.kind === 'selector') return `await device.tap(${jsLiteral(t.selector)})`
      const opts = step.holdMs !== undefined ? `, { holdMs: ${step.holdMs} }` : ''
      return `await device.tapNorm(${jsLiteral(t.pos)}${opts})`
    }
    case 'longPress': {
      const t: RecordingTarget = step.target
      if (t.kind === 'selector') return `await device.longPress(${jsLiteral(t.selector)}, ${step.holdMs})`
      return `await device.tapNorm(${jsLiteral(t.pos)}, { holdMs: ${step.holdMs} })`
    }
    case 'gesture':
      return `await device.gesture(${jsLiteral(step.samples)})`
    case 'swipe':
      return `await device.swipeNorm(${jsLiteral(step.from)}, ${jsLiteral(step.to)}, ${step.durationMs})`
    case 'key':
      return `await device.key(${step.keycode})`
    case 'text':
      if (typeof step.value === 'string') return `await device.type(${jsLiteral(step.value)})`
      return `await device.type(ctx.params.${step.value.param})`
  }
}

/**
 * A recording's name may contain `.` and `_` (`RECORDING_NAME_RE`), a plugin
 * id may not (`definePlugin`'s own `[a-z0-9][a-z0-9-]*`). Detach is the one
 * place a recording's name has to BECOME a plugin id, so it is the one place
 * that gap is closed — by replacing the two extra characters with a dash, not
 * by widening either shape.
 */
function pluginIdFor(name: string): string {
  return name.replace(/[._]+/g, '-')
}

/**
 * The Detach emitter (plan 94 §4.7, criterion 4) — a ONE-MEMBER PLUGIN with
 * every step expanded as a literal SDK call, not an interpreter loop (F18: no
 * orchestration lives in the SDK's authoring layer, and a large generated file
 * nobody will read fails F12 as surely as wrong code would). Read top to
 * bottom, this is exactly what a human who recorded the macro by hand would
 * have written — one `await` per action, in order, each preceded by a comment
 * naming its position and the sleep the interpreter would have taken. The
 * result belongs to the operator from the moment it is written: nothing in
 * this codebase ever regenerates a file at `/scripts/<slug>.ts`.
 *
 * A plugin rather than the `defineScript` this emitted before plan 110: that
 * function no longer exists (§3.1's Hard reading, §4.2), and detach is a
 * ONE-WAY action — handing an operator a file that cannot compile and cannot
 * be published, with the compiled entry already deleted, would be the worst
 * possible moment to be wrong. The shape is deliberately the one `enkaku init`
 * scaffolds (`sdk/src/cli/init.ts`): plugin id from the recording's name,
 * ONE member `main`, so what an operator meets after Detach is the same file
 * shape as a new project, and it publishes as `<name>/main`.
 */
export function emitDetachedScript(doc: RecordingDoc): string {
  const paramNames = collectParamNames(doc)
  const hasParams = paramNames.length > 0
  const hasLiteralText = doc.steps.some((s) => s.kind === 'text' && typeof s.value === 'string')

  const lines: string[] = []
  lines.push(`// GENERATED by Enkaku's recorder from /recordings/${doc.name}.recording.json, then detached.`)
  lines.push('// This file is now yours — Enkaku will not regenerate it.')
  if (hasLiteralText) {
    lines.push('// Contains at least one literal typed string, stored verbatim at the moment this was detached.')
  }
  lines.push("import { definePlugin } from '@enkaku/sdk'")
  if (hasParams) lines.push("import { z } from 'zod'")
  lines.push('')
  lines.push('const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))')
  lines.push('')
  lines.push('// A plugin is the unit the farm publishes — a script cannot exist outside one')
  lines.push('// (plan 110 §3.2). This one has a single member; add more to `scripts` as it grows.')
  lines.push('export default definePlugin({')
  lines.push(`  id: ${jsLiteral(pluginIdFor(doc.name))},`)
  lines.push(`  version: ${jsLiteral(doc.version)},`)
  lines.push(`  title: ${jsLiteral(doc.name)},`)
  if (doc.description.length > 0) lines.push(`  description: ${jsLiteral(doc.description)},`)
  lines.push('  scripts: [')
  lines.push('    {')
  lines.push("      id: 'main',")
  lines.push(`      params: ${hasParams ? `z.object({ ${paramNames.map((n) => `${n}: z.string()`).join(', ')} })` : 'z.object({})'},`)
  lines.push(`      reset: { packages: ${jsLiteral(doc.packages)} },`)
  lines.push('      timing: { betweenActionMs: [0, 0] },')
  lines.push('      async run(ctx) {')
  lines.push('        const device = ctx.device')
  doc.steps.forEach((step, i) => {
    const gap = effectiveGapMs(step, doc)
    lines.push(`        // step ${i + 1}/${doc.steps.length}: ${step.kind}`)
    if (gap > 0) lines.push(`        await sleep(${gap})`)
    lines.push(`        ${dispatchLine(step)}`)
  })
  lines.push('      },')
  if (doc.cleanup === 'force-stop' && doc.packages.length > 0) {
    // finish() must stay stateless and idempotent — after a timeout kill the
    // core runs it again in a fresh process (CLAUDE.md, `enkaku init`'s own
    // scaffold says the same).
    lines.push('      async finish(ctx) {')
    for (const pkg of doc.packages) {
      lines.push(`        await ctx.device.app.forceStop(${jsLiteral(pkg)})`)
    }
    lines.push('      },')
  }
  lines.push('    },')
  lines.push('  ],')
  lines.push('})')
  lines.push('')
  return lines.join('\n')
}
