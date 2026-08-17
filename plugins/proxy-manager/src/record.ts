import { ui } from '@enkaku/sdk'
import { z } from 'zod'

/**
 * What one proxy IS, as this plugin stores it — declared once, in Zod, and
 * then used three times over: as the JSON Schema the Add and Edit forms are
 * drawn from (`z.toJSONSchema`, exactly the call the farm makes on a script's
 * `params`), as the field list the table's columns read, and as the shape a
 * test parses a sample against.
 *
 * One declaration rather than three literals is the whole point. A form that
 * writes `{ host }` into a table that reads `{ hostname }` is a screen that
 * looks finished and shows empty cells forever, and the failure is invisible
 * until an operator has already saved a row. Deriving both halves from this
 * object makes that drift a compile-and-test error instead
 * (`index.test.ts` asserts the three sets are identical).
 */

/**
 * Every key this plugin writes into its own GLOBAL KV namespace starts with
 * this, and the view lists exactly this prefix (plan 108 §4.2's `kv.list`).
 *
 * Global, not device-scoped, on plan 108 §3.1's stated rule: *if forgetting
 * the device should forget the fact, it is device-scoped.* Forgetting a phone
 * must not delete the proxy catalogue — the proxy is a fact about the network,
 * not about any one handset, and the same record is meant to be usable from
 * every device in the farm.
 *
 * The prefix is not decoration: a plugin's namespace is shared by every member
 * (plan 108 §G2), so a later member storing something else of its own has a
 * key space that cannot collide with these rows by accident.
 */
export const PROXY_KEY_PREFIX = 'proxy:'

/**
 * The transports a record can name. Nothing reads this yet — it is stored,
 * shown in the table, and that is all — but it is an enum rather than free
 * text because the day something does read it, an operator who typed
 * "socks 5" would be the one holding the bug.
 */
export const PROXY_KINDS = ['http', 'https', 'socks5'] as const

export const ProxyRecordSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(80)
    .describe('What you call this proxy. Shown in the table and used to name the row in a confirmation.')
    .meta(ui({ title: 'Name' })),
  kind: z
    .enum(PROXY_KINDS)
    .default('socks5')
    .describe('The transport this proxy speaks. Recorded only — nothing in this plugin dials it.')
    .meta(ui({ title: 'Type', labels: { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' } })),
  host: z
    .string()
    .min(1)
    .max(200)
    .describe('Hostname or IP address, without a scheme and without a port.')
    .meta(ui({ title: 'Host' })),
  port: z.number().int().min(1).max(65535).default(1080).describe('TCP port, 1–65535.').meta(ui({ title: 'Port' })),
  notes: z
    .string()
    .max(300)
    .default('')
    .describe('Anything a person needs to know about this entry — who it belongs to, when it expires, where the credentials live.')
    .meta(ui({ title: 'Notes' })),
})

export type ProxyRecord = z.infer<typeof ProxyRecordSchema>

/**
 * The Add form: the storage key first, then the record's own fields.
 *
 * The key is typed by the operator because the binding language has no string
 * concatenation and never will (plan 108 §3.4 — closed and non-Turing), so
 * there is no way for the surface to build `proxy:` + a name. Its default is
 * the prefix itself, so the ordinary path is "append a name and save".
 *
 * The prefix rule is stated in words rather than enforced, and that is not
 * laziness — it is the only truthful option here. `pattern` is refused at
 * publish outright (`checkDeclaredSchema`: no author-supplied regular
 * expression is ever compiled, in the browser or the core), and the form
 * renderer plans a field from its `type`/`enum`/`x-enkaku`, not from
 * `minLength` — so a length bound would be a constraint the operator never
 * sees fire. The description therefore says what actually happens to a key
 * without the prefix, which is the honest version of a rule nothing can
 * currently enforce.
 */
export const AddFormSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(200)
    .default(PROXY_KEY_PREFIX)
    .describe('Where this record is stored. Keep the "proxy:" prefix — a key without it is still saved, but will not appear in this list. Saving over an existing key replaces that row.')
    .meta(ui({ title: 'Storage key' })),
  ...ProxyRecordSchema.shape,
})

/**
 * The Edit form: the record's fields and NOT the key.
 *
 * Editing writes back to the row's own `$entry.key`, so a rename is
 * structurally impossible here rather than merely discouraged — a key field
 * on this form would silently create a second row and leave the first one
 * behind, because `kv.set` upserts and cannot move an entry.
 */
export const EditFormSchema = ProxyRecordSchema
