import { definePlugin, ui, type PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { AddFormSchema, EditFormSchema, PROXY_KEY_PREFIX, ProxyRecordSchema } from './record'

/**
 * Proxy manager — a plugin that owns a screen and, deliberately, nothing else.
 *
 * ## What this is
 *
 * A catalogue. It stores proxy records in its own global KV namespace and
 * gives an operator a table, an Add form, an Edit form and a Delete button
 * over them. All four work today, with no plugin runtime of any kind: plan
 * 108's surface vocabulary dispatches `kv.set`/`kv.delete` through the farm's
 * own `KvStore`, so CRUD over a plugin's own storage is free.
 *
 * ## What this is NOT
 *
 * It does not start a proxy, stop one, test one, or route a device through
 * one. It never opens a socket. Every word an operator can read on the screen
 * says so — the plugin's description, the view's description, the empty state,
 * and the one member script's description — because a screen that looks
 * finished and does nothing is worse than an obviously unfinished one
 * (`docs/design.md`'s writing rules: a degraded or partial state is never
 * worded as the full one).
 *
 * Routing a device's traffic already has an owner elsewhere in the product and
 * is not a thing a plugin can do today: the `network` driver layer is where a
 * tunnel lives (spec §7.9), and the only engine an app under test cannot
 * bypass is `vpn-helper`. Nothing in a declarative surface reaches it. When
 * that changes, the actions that appear here will be `job` actions naming a
 * member of this pack — which is exactly why `check` below exists as a real,
 * publishable member rather than as a promise.
 *
 * ## Storage scope
 *
 * Global, never device. Plan 108 §3.1's rule reads: *if forgetting the device
 * should forget the fact, it is device-scoped.* Forgetting one phone must not
 * take the proxy catalogue with it, so `kv.list` with `scope: 'global'` and a
 * `proxy:` prefix is the right source, and every write is `scope: 'global'`
 * to match. The namespace itself is never spelled anywhere below — a data
 * source can only ever read the owning plugin's own, taken server-side from
 * the URL path (§3.7).
 */

const checkParams = z.object({
  proxy: z
    .string()
    .max(200)
    .default(PROXY_KEY_PREFIX)
    .describe('The storage key of a saved proxy, e.g. "proxy:office-uk". It is written to the log and read by nothing — no connection is attempted.')
    .meta(ui({ title: 'Proxy key' })),
})

const checkResult = z.object({
  proxy: z.string().describe('The proxy key this run was given, echoed back.').meta(ui({ title: 'Proxy key', summary: true })),
  reachable: z
    .boolean()
    .describe('Always false — nothing was contacted. Reported so a run that did nothing can never be mistaken for a proxy that passed a check.')
    .meta(ui({ title: 'Proxy reachable' })),
})

/**
 * The pack's one member, and it is honest about being empty.
 *
 * It is a real script, not a stub that throws: it publishes, verifies,
 * enqueues, runs to `success`, and returns a declared result. That matters for
 * two reasons. A plugin must have at least one member to exist at all
 * (`definePlugin` refuses an empty `scripts`), and a member that threw would
 * make every install of this pack look broken on the jobs list — a red row is
 * a claim that something went wrong, and nothing did.
 *
 * `reachable: false` is the load-bearing part of the result. A run that
 * reports nothing at all reads like a pass; a run that reports "not reachable,
 * because nothing was contacted" cannot.
 *
 * Declared as a named `const` with both generics (the pattern the TikTok pack
 * uses) so `run`'s return is checked against `checkResult` at author time —
 * `definePlugin`'s array-position inference cannot carry a member's `result`
 * type, so the check has to happen here, at the declaration.
 */
export const checkScript: PluginMemberScript<typeof checkParams, typeof checkResult> = {
  id: 'check',
  title: 'Check a proxy',
  description:
    'Does nothing yet. It logs the proxy key it was given and returns "not reachable" — this pack stores proxy records and has no networking behaviour at all.',
  params: checkParams,
  result: checkResult,
  timeout: 30_000,

  async run(ctx) {
    // `warn`, not `info`: an operator who ran this expecting a check should
    // see the line that tells them it was not one, without unfolding a log.
    ctx.log.warn('proxy-manager has no behaviour yet — no connection was attempted and nothing on the device was changed', {
      proxy: ctx.params.proxy,
    })
    return { proxy: ctx.params.proxy, reachable: false }
  },
}

/**
 * The Add and Edit forms, as JSON Schema.
 *
 * `z.toJSONSchema` is the same call the verify child makes on a member's
 * `params` (`packages/core/src/plugins/verify-child-entry.ts`), so these two
 * forms are the same kind of document a run dialog renders and go through the
 * same `SchemaForm`/`planField` resolver — plan 108 §3.3's one-resolver rule,
 * kept by construction rather than by care. Deriving them from `record.ts`
 * rather than hand-writing two JSON literals is what makes the form's shape
 * and the table's columns provably the same shape.
 */
const addFormSchema = z.toJSONSchema(AddFormSchema)
const editFormSchema = z.toJSONSchema(EditFormSchema)

export default definePlugin({
  id: 'proxy-manager',
  version: '0.1.0',
  title: 'Proxy manager',
  description:
    'Keeps a catalogue of proxies and a screen to edit it. Nothing here starts, stops, tests, or routes traffic through a proxy — the records are stored and shown, and that is all.',
  scripts: [checkScript],

  surface: {
    nav: [{ id: 'proxies', label: 'Proxy manager', icon: 'network', view: 'proxies' }],
    views: {
      proxies: {
        title: 'Proxy manager',
        description: 'Proxy records saved in this plugin’s own storage. Adding a row records an address; it does not connect to anything.',
        // Global, prefixed, and with the namespace deliberately unspelled —
        // see this file's header and `PROXY_KEY_PREFIX`.
        data: { kind: 'kv.list', scope: 'global', prefix: PROXY_KEY_PREFIX },
        table: {
          // What a row is CALLED. `ActionRunner` reads this to name the row in
          // a confirmation, which is why it is the human label and not the key.
          rowKey: 'label',
          columns: [
            // Every field below is a real property of `ProxyRecordSchema`,
            // asserted in `index.test.ts` — a column naming something the form
            // does not write would render an empty cell forever.
            { field: 'label', header: 'Name' },
            { field: 'kind', header: 'Type', width: 'narrow' },
            { field: 'host', header: 'Host' },
            { field: 'port', header: 'Port', width: 'narrow' },
            { field: 'notes', header: 'Notes', width: 'wide' },
            // Entry METADATA, not a record field — `$entry.*` is the closed
            // three-field allowlist a row carries beside its value. Unix
            // seconds, drawn through the shared formatter's `timestamp` kind.
            { field: '$entry.updatedAt', header: 'Updated', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          ],
        },
        toolbar: ['add'],
        rowActions: ['edit', 'remove'],
        empty: {
          title: 'No proxies saved yet',
          hint: 'Add one to record its address here. This screen is a catalogue and nothing more — starting, stopping, or routing a device through a proxy is not built yet.',
        },
      },
    },
    actions: {
      // Add — a form whose `then` is a plain `kv.set`. No runtime, no handler,
      // no endpoint of this plugin's own: the farm evaluates the two bindings
      // and calls `KvStore.set` on this plugin's namespace.
      add: {
        kind: 'form',
        label: 'Add proxy',
        schema: addFormSchema,
        submitLabel: 'Save proxy',
        then: {
          kind: 'kv.set',
          label: 'Save proxy',
          scope: 'global',
          key: { $form: 'key' },
          // Written out field by field rather than generated, because a
          // manifest is meant to be readable as data (plan 108 §3.4). The test
          // asserts these keys are exactly `ProxyRecordSchema`'s, so the
          // readability costs nothing in safety.
          value: {
            label: { $form: 'label' },
            kind: { $form: 'kind' },
            host: { $form: 'host' },
            port: { $form: 'port' },
            notes: { $form: 'notes' },
          },
          // Not a secret. A proxy's host and port are not credentials, and
          // marking them secret would redact the very columns the table draws.
          secret: false,
        },
      },

      // Edit — the same write, keyed on the row's OWN entry key so a rename is
      // impossible (`kv.set` upserts; it cannot move an entry, so a key field
      // here would quietly leave the old row behind).
      edit: {
        kind: 'form',
        label: 'Edit',
        schema: editFormSchema,
        prefill: {
          label: { $row: 'label' },
          kind: { $row: 'kind' },
          host: { $row: 'host' },
          port: { $row: 'port' },
          notes: { $row: 'notes' },
        },
        submitLabel: 'Save changes',
        then: {
          kind: 'kv.set',
          label: 'Save changes',
          scope: 'global',
          key: { $entry: 'key' },
          value: {
            label: { $form: 'label' },
            kind: { $form: 'kind' },
            host: { $form: 'host' },
            port: { $form: 'port' },
            notes: { $form: 'notes' },
          },
          secret: false,
        },
      },

      // Delete — the row's own key, with a confirmation. A plain sentence,
      // never a template: bindings are the only way a declared value reaches
      // an action, and the dialog names the row itself from the view's
      // `rowKey` (plan 108 §3.4).
      remove: {
        kind: 'kv.delete',
        label: 'Delete',
        scope: 'global',
        key: { $entry: 'key' },
        confirm: 'Delete this proxy record? It is removed from the catalogue; nothing else changes.',
      },
    },
  },
})
