import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { checkDeclaredSchema } from '@enkaku/protocol'
import { isPlugin } from '@enkaku/sdk'
import debugNode from './debug-node'
import helloNoDevice from './hello-no-device'
import openSettings from './open-settings'
import scrollFlingDemo from './scroll-fling-demo'

/**
 * Plan 110 §5 step 110.5, acceptance criterion 7 — "every file in
 * `examples/` publishes under the new rule". These four files are the
 * reference material an author copies, so the thing worth asserting is not
 * that they run (they need a device for that) but that they are shaped like
 * something the farm would actually accept: a plugin, with members that
 * pass the same gates `enkaku publish` and the verify child run.
 *
 * Written as a table rather than four near-identical tests so adding a fifth
 * example is one line and cannot be forgotten halfway.
 */

const EXAMPLES: Array<{ file: string; plugin: unknown }> = [
  { file: 'debug-node.ts', plugin: debugNode },
  { file: 'hello-no-device.ts', plugin: helloNoDevice },
  { file: 'open-settings.ts', plugin: openSettings },
  { file: 'scroll-fling-demo.ts', plugin: scrollFlingDemo },
]

interface Member {
  id: string
  title?: string
  description?: string
  params: unknown
  result?: unknown
  run: unknown
}

interface Plugin {
  id: string
  version: string
  scripts: Member[]
}

describe('examples/ — every default export is a publishable plugin (plan 110 criterion 7)', () => {
  for (const { file, plugin } of EXAMPLES) {
    describe(file, () => {
      test('the default export is a definePlugin() result, not a bare script', () => {
        // `isPlugin` is the SAME structural check `enkaku publish` refuses on
        // and the runner's loader makes — not a re-implementation of it.
        expect(isPlugin(plugin)).toBe(true)
      })

      test('the plugin id matches the file name, so `<id>/<member>` reads like the path it came from', () => {
        const def = plugin as Plugin
        expect(def.id).toBe(file.replace(/\.ts$/, ''))
      })

      test('every member has a unique id, a title, a description, a Zod `params` and a `run`', () => {
        const def = plugin as Plugin
        expect(def.scripts.length).toBeGreaterThan(0)
        const ids = new Set<string>()
        for (const member of def.scripts) {
          expect(ids.has(member.id)).toBe(false)
          ids.add(member.id)
          // The farm surfaces both wherever a script is named (plan 108
          // §0.2 P8) — an example that skipped them would teach every reader
          // to publish a script that shows up as a bare id.
          expect(member.title).toBeTruthy()
          expect(member.description).toBeTruthy()
          expect(typeof member.run).toBe('function')
          expect(typeof (member.params as { safeParse?: unknown }).safeParse).toBe('function')
        }
      })

      test('every member is stamped with the plugin version, and declares none of its own', () => {
        const def = plugin as Plugin
        for (const member of def.scripts) {
          expect((member as { version?: string }).version).toBe(def.version)
        }
      })

      test('every declared schema passes the published limits — the gate `enkaku publish` applies locally', () => {
        const def = plugin as Plugin
        for (const member of def.scripts) {
          const params = z.toJSONSchema(member.params as z.ZodTypeAny, { io: 'input' })
          const blocking = checkDeclaredSchema(params).filter((f) => f.limit !== 'group')
          expect(blocking).toEqual([])
          if (member.result !== undefined) {
            const result = z.toJSONSchema(member.result as z.ZodTypeAny, { io: 'output' })
            expect(checkDeclaredSchema(result).filter((f) => f.limit !== 'group')).toEqual([])
          }
        }
      })
    })
  }
})
