import { z } from 'zod'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.2 — what a plugin declares
 * about its **service**: the long-lived half that keeps running for as long
 * as the plugin is enabled, as opposed to a script, which exists only inside
 * a job.
 *
 * **On the name.** Plan 109 §4.1 called this block `runtime` and step 109.1
 * flagged the collision it would create (§9 Q7): a plugin MEMBER already has
 * a `runtime` — plan 98's `RuntimeEnvelope`, i.e. `timeoutMs`/`retries`/
 * `maxRssBytes`/`maxConcurrent`, a restriction a script places on its own
 * execution. Two `runtime` keys nested one level apart, meaning two unrelated
 * things, in a PUBLISHED authoring type, is a permanent ambiguity; the owner
 * settled it as `service`. The internal file names (`runtime-host.ts`) and the
 * operator-facing words ("runtime status") keep the old word, because there is
 * no second meaning of it there to confuse.
 *
 * This schema is the WIRE/manifest shape — what the verify child reports, what
 * the parent re-validates, and what is persisted into `plugins.manifest`. The
 * author-facing types live in `@enkaku/sdk` (`defineService`) and re-export the
 * type inferred here rather than restating it, so the two cannot drift.
 */

/**
 * Every isolation mode the manifest **accepts**. Exactly one of them is
 * implemented, and that asymmetry is the point (plan 109 §3.2, criterion 7):
 * reserving the field now means adding a process host later is not a rewrite
 * of every plugin's manifest, and refusing the unimplemented value at verify
 * means an author is told so before their plugin can activate — rather than
 * discovering it as silence.
 */
export const PLUGIN_SERVICE_ISOLATIONS = ['in-process', 'process'] as const
export type PluginServiceIsolation = (typeof PLUGIN_SERVICE_ISOLATIONS)[number]

/** A cap on the declared permission list, for the same reason every other declared list here has one: it is operator-facing text shown at install. */
export const PLUGIN_SERVICE_MAX_PERMISSIONS = 64
/** The same cap, for the same reason, on the declared listener list (plan 109 §3.3, step 109.4). */
export const PLUGIN_SERVICE_MAX_LISTENERS = 16
/** And on the declared farm-event list (plan 109 §3.5, step 109.5). */
export const PLUGIN_SERVICE_MAX_EVENTS = 64

/**
 * A listener's transport. `udp` is accepted and is host-local: **nothing on a
 * device can reach it** (plan 109 §3.4 limit 1) — see `listenerReachabilityMessage`.
 */
export const PLUGIN_LISTENER_PROTOS = ['tcp', 'udp'] as const
export type PluginListenerProto = (typeof PLUGIN_LISTENER_PROTOS)[number]

/**
 * Criterion 17, and the one thing about a listener the farm refuses outright.
 *
 * `adb reverse` — the only mechanism that makes a host port dialable from a
 * device (plan 109 §3.4, H1) — supports `tcp:`, `localabstract:` and
 * `localfilesystem:`. It has no UDP form, on any Android version, over USB or
 * wireless. So `{ proto: 'udp', deviceReachable: true }` is not a feature
 * waiting to be built like `isolation: 'process'` is; it is a promise the
 * mechanism can never keep, and accepting it would let a plugin author ship a
 * manifest whose central claim is false.
 *
 * Returns the refusal message, or `null` when the pair is coherent.
 */
export function listenerReachabilityMessage(listener: { proto: PluginListenerProto; deviceReachable: boolean }): string | null {
  if (listener.proto !== 'udp' || !listener.deviceReachable) return null
  return (
    '`deviceReachable: true` is not possible on a UDP listener — `adb reverse`, the only way a process on a device can dial a port ' +
    'on its host, supports tcp:, localabstract: and localfilesystem: and has no UDP form (docs/plans/109-m74-plugin-runtime.md §3.4). ' +
    'A UDP listener is accepted and is host-local: nothing on a device reaches it. Use proto: "tcp" if a device has to dial it.'
  )
}

/**
 * One listener, as a plugin **declares** it in its manifest (shown at install,
 * plan 109 criterion 20) and as it **reports** it at run time through
 * `ctx.reportListener` (plan 109 §3.3 — pure observability).
 *
 * ONE schema for both boundaries, deliberately: the install consent step and
 * the Plugins page are showing the operator the same fact, and a declared
 * listener the runtime then contradicts is exactly the drift a second schema
 * would let through.
 *
 * **`port` is optional here, and that is the design, not an omission.** §3.3 is
 * the owner's ruling: *the plugin owns its socket, picks its own port, and
 * collisions are the plugin's problem.* The port a plugin actually binds comes
 * from its own settings at run time; the manifest declares the SHAPE the
 * operator is consenting to ("this plugin opens a TCP port devices can dial"),
 * with an advisory default at most. The core does not allocate, reserve, or
 * arbitrate — it lends `ctx.isPortFree` and records what comes back.
 */
export const PluginListenerSchema = z
  .object({
    /** The plugin's own name for it. Unique within the plugin; a second report under the same id REPLACES the first. */
    id: z.string().min(1).max(64),
    /**
     * Advisory in a declaration (the real one is an operator setting);
     * REQUIRED on a runtime report, because a report with no port says
     * nothing the Plugins page can show and nothing the unload backstop can
     * bind-test.
     */
    port: z.number().int().min(1).max(65_535).optional(),
    proto: z.enum(PLUGIN_LISTENER_PROTOS).default('tcp'),
    /**
     * Whether a process ON A DEVICE is meant to dial this. Advertising it is
     * not the same as having it: the chain that delivers it is plan 109
     * §3.4's, built in steps 109.9–109.11. Until then this flag is a
     * declaration of intent, validated but not yet fulfilled.
     */
    deviceReachable: z.boolean().default(false),
    /** Operator-facing, shown at install beside the port. */
    description: z.string().max(200).optional(),
  })
  .superRefine((listener, ctx) => {
    const bad = listenerReachabilityMessage(listener)
    if (bad) ctx.addIssue({ code: 'custom', path: ['deviceReachable'], message: bad })
  })
export type PluginListener = z.infer<typeof PluginListenerSchema>

/** A runtime report (`ctx.reportListener`). The declaration's shape with `port` made mandatory — see `PluginListenerSchema`. */
export const ReportedListenerSchema = z
  .object({
    id: z.string().min(1).max(64),
    port: z.number().int().min(1).max(65_535),
    proto: z.enum(PLUGIN_LISTENER_PROTOS).default('tcp'),
    deviceReachable: z.boolean().default(false),
    description: z.string().max(200).optional(),
  })
  .superRefine((listener, ctx) => {
    const bad = listenerReachabilityMessage(listener)
    if (bad) ctx.addIssue({ code: 'custom', path: ['deviceReachable'], message: bad })
  })
export type ReportedListener = z.infer<typeof ReportedListenerSchema>

/**
 * A farm event type a plugin subscribes to (plan 109 §3.5, step 109.5).
 *
 * Shape only, here: this schema knows a dotted lowercase token when it sees
 * one, and nothing more. Whether the token names a message the core actually
 * broadcasts is checked by the FARM, at verify, against `SERVER_MESSAGE_TYPES`
 * — the same split `isolation` already uses, and for the same reason: the
 * manifest vocabulary must not be pinned to one core build's message list, or
 * a plugin published against a newer core becomes unparseable rather than
 * merely unsatisfiable.
 */
export const PluginEventTypeSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/, 'a farm event type is a dotted lowercase message type, e.g. "device.status" or "job.status"')

/**
 * A cap on the declared webhook list (plan 109 §3.7, step 109.7), for the same
 * reason every other declared list here has one: it is operator-facing text
 * shown at install, and each entry costs a row and a generated secret.
 */
export const PLUGIN_SERVICE_MAX_WEBHOOKS = 8

/** The largest body an inbound webhook may carry, whatever a plugin asks for. Signed material is buffered in memory before it can be verified, so this is a memory bound, not a preference. */
export const PLUGIN_WEBHOOK_MAX_BODY_BYTES = 1_048_576
/** The default body cap when a webhook declares none. */
export const PLUGIN_WEBHOOK_DEFAULT_BODY_BYTES = 65_536
/** The default requests-per-minute a single webhook accepts, refusals included. */
export const PLUGIN_WEBHOOK_DEFAULT_RATE_PER_MIN = 60
/** The default signature freshness window, in seconds — the same 300 s `verifyWebhookSignature` defaults a receiver to. */
export const PLUGIN_WEBHOOK_DEFAULT_TOLERANCE_SEC = 300

/**
 * The header an inbound webhook carries its signature in — `t=<unix
 * seconds>,v1=<hex hmac>`, byte-for-byte the shape this farm's OUTBOUND
 * deliveries already use (`packages/core/src/notify/webhook.ts`,
 * `webhookSignatureHeader`).
 *
 * One scheme, one helper, both directions (plan 109 R4). A second inbound
 * format would mean a second HMAC implementation, and the two would agree
 * until the day one of them was fixed.
 */
export const PLUGIN_WEBHOOK_SIGNATURE_HEADER = 'x-enkaku-signature'

/**
 * One inbound webhook, as a plugin **declares** it (plan 109 §3.7 row 2,
 * §4.6, step 109.7).
 *
 * **Declared, not merely registered — and that asymmetry is deliberate**, in
 * the other direction from `PLUGIN_HANDLER_KINDS`' note below. A webhook owns
 * a *farm-held secret* that has to exist, be rotatable, and keep verifying
 * while the plugin's service is stopped, reloading, or `failed`; a thing that
 * only exists while `setup` has run cannot do any of that. It is also the one
 * plugin-facing door that is reachable by someone with **no farm session at
 * all**, so an operator must be shown it at install rather than discovering it
 * from an access log.
 *
 * The handler is still registered (`ctx.onWebhook`), and — exactly as
 * `ctx.onEvent` is checked against `events` — registering an id absent from
 * this list is refused, because the list is what the operator consented to.
 */
export const PluginWebhookSchema = z.object({
  /** The last path segment of `/api/plugins/<plugin>/webhook/<id>`. */
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  /** Operator-facing, shown at install beside the URL. */
  description: z.string().max(200).optional(),
  /**
   * A JSON Schema the parsed body is validated against **by the core**, before
   * plugin code is entered. Optional: a webhook that declares none accepts any
   * JSON body and validates it itself.
   *
   * Held as `unknown` here for the same reason every other declared schema in
   * this package is: it is author-supplied JSON, and `checkDeclaredSchema`
   * (`./schema/limits.ts`) is what refuses a hostile or oversized one at
   * verify. `validateAgainstSchema` is what evaluates it at request time — the
   * one validator, never a second.
   */
  body: z.unknown().optional(),
  /** Bodies larger than this are refused before they are read into memory or hashed. */
  maxBodyBytes: z.number().int().min(1).max(PLUGIN_WEBHOOK_MAX_BODY_BYTES).default(PLUGIN_WEBHOOK_DEFAULT_BODY_BYTES),
  /**
   * Requests per minute this webhook accepts — **counted before the signature
   * is checked, so a refused request costs the same budget as an accepted
   * one.** That is the point: the limiter is what bounds an unauthenticated
   * stranger's ability to make the core do HMAC work, write audit rows, or
   * probe for a valid signature.
   */
  rateLimitPerMin: z.number().int().min(1).max(6_000).default(PLUGIN_WEBHOOK_DEFAULT_RATE_PER_MIN),
  /**
   * How far the signed timestamp may be from now, in seconds. Bounded on both
   * sides — a replayed delivery from an hour ago is refused, and so is one
   * from an hour in the future.
   */
  toleranceSec: z.number().int().min(5).max(3_600).default(PLUGIN_WEBHOOK_DEFAULT_TOLERANCE_SEC),
})
export type PluginWebhook = z.infer<typeof PluginWebhookSchema>

/** The address of one inbound webhook. A wire string, so it comes from this package and nowhere else (CLAUDE.md). */
export function pluginWebhookPath(plugin: string, webhookId: string): string {
  return `/api/plugins/${encodeURIComponent(plugin)}/webhook/${encodeURIComponent(webhookId)}`
}

/**
 * The inverse of `pluginWebhookPath`. `null` when `pathname` is not a plugin
 * webhook at all.
 *
 * The core's auth middleware calls this to decide that a request needs no
 * session (`auth/middleware.ts`): an inbound webhook's caller is a third-party
 * system that has none, so **the signature is the authorisation**, exactly the
 * way `/api/nodes/enroll`'s single-use token in the body is its own.
 */
export function parsePluginWebhookPath(pathname: string): { plugin: string; webhookId: string } | null {
  const m = /^\/api\/plugins\/([^/]+)\/webhook\/([^/]+)$/.exec(pathname)
  if (!m) return null
  try {
    return { plugin: decodeURIComponent(m[1]!), webhookId: decodeURIComponent(m[2]!) }
  } catch {
    return null
  }
}

/**
 * What the farm knows about one webhook's secret, as the plugin and (later)
 * the Plugins page read it.
 *
 * **There is no `hint`, and its absence is the design** (plan 109 step 109.7,
 * coordinated with plan 112 step 112.2). `secretHint` puts
 * `${first 7}…${last 4}` of a plaintext on a KV row and hands it to anyone who
 * can read that row — right for an API key with a public prefix the operator
 * pasted in, and wrong for 32 random bytes the farm generated, where eleven
 * characters is eleven characters of the only thing standing between a
 * stranger and this handler. A farm-generated secret is write-only: it is
 * returned in full exactly once, by the call that generated it, and never
 * again by any read path.
 */
export const PluginWebhookInfoSchema = z.object({
  id: z.string(),
  /** The path a sender posts to. */
  path: z.string(),
  /** Whether a secret exists. Always true once the webhook has been reached for; there is no unsigned mode. */
  configured: z.boolean(),
  createdAt: z.number().int(),
  rotatedAt: z.number().int().nullable(),
  /**
   * When the PREVIOUS secret stops being accepted, or `null` when there is no
   * overlap in flight. A rotation is not instantaneous for the third party
   * that has to be told about it, so the old secret keeps verifying until this
   * moment — see `plugins/webhook-secrets.ts` for why that is the safer
   * default and how to ask for a revocation instead.
   */
  previousValidUntil: z.number().int().nullable(),
  /** Deliveries whose signature verified. */
  deliveries: z.number().int(),
  /** Requests refused for any reason — bad signature, stale timestamp, oversized body, rate limit. */
  refusals: z.number().int(),
  lastDeliveryAt: z.number().int().nullable(),
  /**
   * Which secret the last accepted delivery was signed with. `'previous'` is
   * the operationally interesting value: it says the sender has not been
   * updated yet, and the overlap window is the only reason it still works.
   */
  lastAcceptedKey: z.enum(['current', 'previous']).nullable(),
})
export type PluginWebhookInfo = z.infer<typeof PluginWebhookInfoSchema>

/**
 * A cap on the extra capabilities a reset pass may borrow. Smaller than
 * `PLUGIN_SERVICE_MAX_PERMISSIONS` on purpose: this list is authority a plugin
 * does NOT hold while it is merely running, and a list of sixty-four of those
 * is not a scoped grant, it is a second manifest.
 */
export const PLUGIN_SERVICE_MAX_RESET_PERMISSIONS = 8

/**
 * What a plugin declares about **Reset data** — the operator action that
 * deletes everything the plugin stored and, first, gives the plugin one run to
 * undo what it did to the outside world.
 *
 * `resetData` is non-null **exactly when the bundle exports a reset handler**
 * (`defineService({ onResetData })` sets it, and refuses a `resetData` block
 * with no handler behind it). So "does this plugin have anything to undo" is
 * answerable from the persisted manifest, without importing the bundle — the
 * same property `service` itself has, and for the same reason: the decision has
 * to be makeable before any plugin code is loaded.
 *
 * **`resetData`, not `reset`** — the same collision rule this file's header
 * records for `runtime`. `definePlugin({ reset: { packages } })` already exists
 * one level up and means something entirely unrelated (npm packages a job
 * reinstalls, plan 82 §3.10). Two `reset` keys nested one level apart in a
 * published authoring type is a permanent ambiguity, and the operator-facing
 * name for this one is "Reset data" anyway.
 *
 * ## `permissions` here is not `permissions` up there
 *
 * The list on the declaration is what the service may call **at any moment, for
 * its whole lifetime**. This one is what the reset handler may call **during one
 * operator-initiated pass, through the context object handed to that handler,
 * and not one call later**. Both halves are enforced (`farm-broker.ts` unions
 * the two lists only while the host says a pass is open, and only for the
 * elevated context it built for that pass), and both are shown at install.
 *
 * The distinction exists because of a real case. `proxy-manager` deliberately
 * withheld `device.network.clear` — *"a plugin that could silently un-route
 * forty phones is a bigger authority than anything on this screen asks for"* —
 * and reset is the one moment it genuinely needs it, because its stored
 * assignments are the only record of which phones it pointed at a proxy.
 * Granting the capability outright to satisfy that moment would hand the
 * running service the standing authority the comment refused. This is the
 * narrower grant that satisfies the case without conceding the argument.
 */
export const PluginServiceResetDataSchema = z.object({
  /**
   * Capabilities the reset handler may call **only** during a reset pass, on
   * top of `permissions`. Everything else about a farm call is unchanged: the
   * real ACL still runs under `plugin:<name>`, the activity policy still
   * applies, and every call is still audited.
   */
  permissions: z.array(z.string().min(1).max(120)).max(PLUGIN_SERVICE_MAX_RESET_PERMISSIONS).default([]),
  /**
   * One sentence, in the plugin author's own words, naming what the handler
   * undoes. It is rendered **inside the confirm dialog**, which is why it is
   * declared rather than left to the plugin's description: the operator is
   * about to authorise an irreversible act plus a pass over their devices, and
   * "what will this touch" must be answerable on that screen.
   */
  description: z.string().max(400).optional(),
})
export type PluginServiceResetData = z.infer<typeof PluginServiceResetDataSchema>

/**
 * What one thing a reset handler cleaned up ended as.
 *
 * Four values, and the split between the last two is the one that decides
 * whether the plugin's data is deleted at all:
 *
 * | outcome | meaning | is the data safe to delete? |
 * |---|---|---|
 * | `cleared` | the undo happened, and the plugin saw it happen | yes |
 * | `unchanged` | there was nothing to undo here | yes |
 * | `pending` | the undo could not complete, **and the farm has recorded the debt somewhere that outlives this plugin's data** (a device row's `pendingClear`, say) | yes — the record has moved, it has not vanished |
 * | `failed` | the undo did not happen and nothing recorded that it is still owed | **no** |
 *
 * A handler must not report `pending` on a hope. It means "somebody other than
 * me is now holding this obligation, and can settle it without me" — if that is
 * not true, the honest value is `failed`.
 */
export const PLUGIN_RESET_OUTCOMES = ['cleared', 'unchanged', 'pending', 'failed'] as const
export type PluginResetOutcome = (typeof PLUGIN_RESET_OUTCOMES)[number]

/** Whether an item names a device or something else the plugin owns (a listener, a bridge, a remote booking). */
export const PLUGIN_RESET_ITEM_KINDS = ['device', 'resource'] as const
export type PluginResetItemKind = (typeof PLUGIN_RESET_ITEM_KINDS)[number]

/** One thing a reset handler tried to clean up. */
export const PluginResetItemSchema = z.object({
  kind: z.enum(PLUGIN_RESET_ITEM_KINDS).default('resource'),
  /** A device's `stableId` for `kind: 'device'`; whatever the plugin calls the thing otherwise. */
  id: z.string().min(1).max(200),
  /** What to show a person instead of `id`, when the plugin knows a better name. */
  label: z.string().max(200).optional(),
  outcome: z.enum(PLUGIN_RESET_OUTCOMES),
  /** One sentence an operator reads. Required even on `cleared` — "what did it actually do to my phone" has to be answerable per row. */
  message: z.string().max(600),
})
export type PluginResetItem = z.infer<typeof PluginResetItemSchema>

/** The cap on a handler's report. A farm with more than this many devices is real; a handler reporting more rows than this is not reporting, it is dumping. */
export const PLUGIN_RESET_MAX_ITEMS = 1000

/**
 * What a reset handler returns. Parsed by the host before anything is deleted
 * — it is plugin output crossing into the core, so it goes through Zod like any
 * other external input, and a handler that returns nothing at all is a valid
 * empty report (it had nothing to undo).
 */
export const PluginResetReportSchema = z.object({
  items: z.array(PluginResetItemSchema).max(PLUGIN_RESET_MAX_ITEMS).default([]),
  /** Anything that is true of the whole pass rather than of one item. Rendered above the list. */
  note: z.string().max(600).optional(),
})
export type PluginResetReport = z.infer<typeof PluginResetReportSchema>

export const PluginServiceDeclarationSchema = z.object({
  /**
   * Exhaustive. `ctx.farm` refuses any capability absent from this list
   * BEFORE `invoke()` is reached (plan 109 criterion 10, step 109.3), and the
   * list is shown to the operator at install. Plain strings, because
   * capability ids are dotted (`device.list`, `job.run`) and there is no
   * `CapabilityId` union in the workspace to narrow against (§9 Q6).
   */
  permissions: z.array(z.string().min(1).max(120)).max(PLUGIN_SERVICE_MAX_PERMISSIONS).default([]),
  /** Reserved (plan 109 §2, §3.2). Accepted here, refused at verify — see `unsupportedIsolationMessage`. */
  isolation: z.enum(PLUGIN_SERVICE_ISOLATIONS).default('in-process'),
  /**
   * The ports this plugin intends to open (plan 109 §3.3, step 109.4). Shown
   * at install, so the operator learns about an open socket on their machine
   * from the consent step rather than from `lsof`.
   *
   * **Declaring one grants nothing and reserves nothing.** The plugin calls
   * `Bun.listen` itself, on a port of its own choosing, and is responsible for
   * its own collisions — the owner's ruling, §3.3. What the core does with
   * this list is show it and, at unload, bind-test whatever was actually
   * reported (advisory; it never force-closes a socket it does not own).
   */
  listeners: z.array(PluginListenerSchema).max(PLUGIN_SERVICE_MAX_LISTENERS).default([]),
  /**
   * The farm events this plugin's service wants to hear (plan 109 §3.5, step
   * 109.5). Exhaustive: `ctx.onEvent` refuses a type absent from this list,
   * the same discipline `ctx.farm` applies to `permissions`, and for the same
   * reason — the list is what the operator was shown at install.
   *
   * **Observation only.** A handler cannot veto, delay, or rewrite an event
   * (§2, §3.5, criterion 12). Delivery is best-effort: no replay, no queue, no
   * ordering guarantee across types. A plugin that needs durable state
   * reconciles from `ctx.storage` on start.
   */
  events: z.array(PluginEventTypeSchema).max(PLUGIN_SERVICE_MAX_EVENTS).default([]),
  /**
   * The inbound webhooks this plugin can be poked through (plan 109 §3.7,
   * step 109.7). See `PluginWebhookSchema` for why these are DECLARED where a
   * handler is only registered.
   *
   * Declaring one is what causes a secret to exist. It grants the plugin
   * nothing else: a request still has to carry a valid HMAC over the body it
   * sent, and `ctx.onWebhook` still has to be called for anything to answer.
   */
  webhooks: z.array(PluginWebhookSchema).max(PLUGIN_SERVICE_MAX_WEBHOOKS).default([]),
  /**
   * The **Reset data** hook and the authority it borrows for one pass — see
   * `PluginServiceResetDataSchema`.
   *
   * `null` (the default, and what every manifest written before this field
   * existed reads back as) means the plugin has nothing to undo. Reset still
   * works on such a plugin: it deletes the data and says the handler did not
   * run because there is none, which is a complete answer rather than a
   * degraded one.
   */
  resetData: PluginServiceResetDataSchema.nullable().default(null),
})
export type PluginServiceDeclaration = z.infer<typeof PluginServiceDeclarationSchema>

/**
 * Duplicate webhook ids in one declaration (plan 109 step 109.7).
 *
 * Refused rather than last-wins, because two entries with one id means two
 * different declared body schemas, caps and windows for one secret and one
 * URL — and whichever the farm picked would be a coin toss the author never
 * saw. Returns the refusal message, or `null`.
 */
export function duplicateWebhookIdsMessage(webhooks: readonly { id: string }[]): string | null {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const w of webhooks) {
    if (seen.has(w.id)) dupes.add(w.id)
    seen.add(w.id)
  }
  if (dupes.size === 0) return null
  return (
    `\`service.webhooks\` declares ${[...dupes].map((id) => `"${id}"`).join(', ')} more than once. One id is one URL and one secret, ` +
    `so a second entry would silently replace the first one's body schema, size cap and freshness window.`
  )
}

/**
 * Criterion 7's other half. The schema above ACCEPTS `'process'`; this is what
 * refuses it, and it lives beside the schema rather than inside it so the
 * distinction stays legible: the manifest vocabulary is forward-compatible,
 * the FARM is honest about what it can actually run today.
 *
 * Returns the refusal message, or `null` when the mode is implemented.
 */
export function unsupportedIsolationMessage(isolation: PluginServiceIsolation): string | null {
  if (isolation === 'in-process') return null
  return (
    `\`service.isolation: "${isolation}"\` is reserved but not implemented — this farm can only run a plugin service in-process, ` +
    `inside the core's own process (docs/plans/109-m74-plugin-runtime.md §3.2). Remove the field, or set it to "in-process", ` +
    `and read what in-process costs before you do: a synchronous infinite loop, an out-of-memory, a \`process.exit()\`, or a native ` +
    `crash in your code takes the whole core down with it.`
  )
}

/**
 * The operator-facing lifecycle of a plugin's service (plan 109 §4.2).
 *
 * **`starting` is not `running`, and the two are never worded as one**
 * (§3.2/§4.2, and `docs/design.md`'s own rule about degraded states). A
 * service is `running` only once its `setup` has RESOLVED; between the module
 * import and that resolution it is `starting`, it serves nothing, and every
 * call into it is refused with a coded error rather than queued. An operator
 * who reads `running` will act on it — will assume the port is bound and the
 * subscriptions are live — so a status that says `running` early is not an
 * optimism, it is a lie with consequences.
 *
 * `stopping` is the same discipline applied to the other end: the disposers
 * have been asked to run and have not all finished (or a reported port is
 * still bound, §3.3).
 */
export const PLUGIN_SERVICE_STATUSES = ['stopped', 'starting', 'running', 'failed', 'stopping'] as const
export type PluginServiceStatus = (typeof PLUGIN_SERVICE_STATUSES)[number]
export const PluginServiceStatusSchema = z.enum(PLUGIN_SERVICE_STATUSES)

// ---------------------------------------------------------------------------
// Step 109.6 — the three handler families
// ---------------------------------------------------------------------------

/**
 * The three kinds of handler a service registers at run time (plan 109 §3.1's
 * table, §4.6, step 109.6): an HTTP handler (`ctx.onRequest`), a WebSocket
 * handler (`ctx.onSocket`), and a query handler (`ctx.onQuery` — what plan
 * 108's `{ kind: 'handler' }` data source calls).
 *
 * **Registered, never declared.** Unlike `permissions`, `listeners` and
 * `events`, a handler is not in the manifest: it comes into existence when
 * `setup` calls `ctx.onRequest`, and it stops existing the moment the service
 * unloads. That asymmetry is deliberate and it has one consequence worth
 * stating, because it is the difference between an honest error and a
 * misleading one: **a stopped service has no handlers at all**, so "no such
 * handler" and "the service is not running" are answers to different
 * questions, and the route must ask them in that order (`service-routes.ts`).
 *
 * `webhook` (step 109.7) is the one member whose *declaration* also exists —
 * see `PluginWebhookSchema`. Its handler is still registered like the other
 * three and still disappears with the service; what outlives the service is
 * the secret, not the code.
 */
export const PLUGIN_HANDLER_KINDS = ['http', 'socket', 'query', 'webhook'] as const
export type PluginHandlerKind = (typeof PLUGIN_HANDLER_KINDS)[number]

/** The HTTP methods a plugin handler may be reached with. There is no `HEAD`/`OPTIONS`: those are the server's own, and a plugin answering them would shadow CORS. */
export const PLUGIN_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type PluginHttpMethod = (typeof PLUGIN_HTTP_METHODS)[number]

/**
 * A handler's id — the first path segment under `/http/`, `/socket/` or
 * `/query/`. Identifier-shaped for the same reason `SurfaceIdSchema` is, minus
 * that schema's `Object.prototype` guard: a handler id is a `Map` key here,
 * never an object key, so `constructor` cannot answer with a function. The
 * shape is kept identical anyway so an author does not have to learn two
 * naming rules for the same plugin.
 */
export const PluginHandlerIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)

/**
 * The permission a handler is reached behind when it declares none.
 *
 * `script.view` — the same gate that opens a plugin's SCREEN
 * (`GET /:name/view/:viewId`, `GET /:name/ui/*`). A plugin's HTTP handler is
 * overwhelmingly the back end of its own screen, so the default is the
 * permission that already had to be true for the operator to be looking at it.
 *
 * **There is deliberately no way to say "no authentication".** Plan 109 §9 Q2
 * asked whether a handler should be able to opt out for a health endpoint or a
 * metrics scrape; the recommendation was no for v1, and this is where that is
 * enforced — structurally, by there being no value to write. An unauthenticated
 * route on a farm whose bind address implies TLS-and-auth is a hole the
 * operator cannot see, and the legitimate case is a webhook with its own secret
 * (§3.7, step 109.7). It is easier to allow this later than to withdraw it.
 */
export const PLUGIN_HANDLER_DEFAULT_PERMISSION = 'script.view'

/**
 * Who is asking, as a handler sees them.
 *
 * **This is identity, never a credential.** A handler is told the caller's id
 * and role so its own logic can branch on them; it is never handed the session
 * cookie, the `Authorization` header, or a WS ticket — see
 * `PLUGIN_REQUEST_HEADER_ALLOWLIST`. The distinction is not that a plugin could
 * not otherwise reach the farm (it runs in the core's process and can reach
 * further than any header would take it) but that a bearer token is the one
 * thing that can LEAVE the process: logged, stored, forwarded to a webhook,
 * replayed later as that user from somewhere else.
 *
 * It is also not a principal. Anything the handler then does through
 * `ctx.farm` is audited as `plugin:<name>` under the plugin publisher's role
 * (plan 109 §4.3, §9 Q14) — invoking a handler never lends a plugin the
 * caller's authority, and the caller's own row is the `plugin.http` /
 * `plugin.socket` audit entry the route writes.
 *
 * The role vocabulary is `UserSchema`'s (`api/auth.ts`), restated here because
 * that schema declares it inline and this file must not import the API layer.
 */
export const PluginCallerSchema = z.object({
  id: z.string(),
  role: z.enum(['admin', 'operator']),
})
export type PluginCaller = z.infer<typeof PluginCallerSchema>

/**
 * The request headers a plugin HTTP handler may see. Everything else — the
 * session cookie, `authorization`, a WS ticket, `x-forwarded-*` — is dropped
 * before the handler is entered.
 *
 * An allowlist and not a denylist, on the usual reasoning: a denylist is a
 * promise about every header that will ever exist, and the first proxy header
 * nobody thought of is the one carrying the credential.
 */
export const PLUGIN_REQUEST_HEADER_ALLOWLIST: readonly string[] = ['content-type', 'accept', 'accept-language', 'user-agent']

/**
 * The response headers a plugin HTTP handler may set. `content-type` is the
 * one that matters; the rest are caching hints.
 *
 * `set-cookie` is absent and that is the point: a plugin able to set a cookie
 * on the farm's own origin could mint or overwrite the session cookie the core
 * authenticates with. `access-control-*` is absent for the same reason applied
 * to CORS — the core decides who may call it, not a plugin.
 */
export const PLUGIN_RESPONSE_HEADER_ALLOWLIST: readonly string[] = ['content-type', 'cache-control', 'etag', 'last-modified']

/**
 * One registered handler, as the Plugins page and `GET /:name/runtime` report
 * it (plan 109 §4.6's `handlers`). A view of run-time state, never a
 * declaration — see `PLUGIN_HANDLER_KINDS`.
 */
export const PluginHandlerViewSchema = z.object({
  kind: z.enum(PLUGIN_HANDLER_KINDS),
  id: PluginHandlerIdSchema,
  /**
   * The ACL permission a caller must hold. Always a real one — the host
   * refuses an unknown name at registration.
   *
   * **`null` for a `webhook` handler, and that is not "unprotected".** An
   * inbound webhook's caller is a third-party system with no farm session and
   * therefore no role, so there is no ACL question to ask of it: its own
   * per-webhook secret is the whole authorisation, verified before the handler
   * is reached. Writing `script.view` here instead would be a false statement
   * about what gates the route, in the one place an operator reads to find out.
   */
  permission: z.string().min(1).max(64).nullable(),
  /** `http` only: the methods this handler answers. */
  methods: z.array(z.enum(PLUGIN_HTTP_METHODS)).optional(),
  description: z.string().max(200).optional(),
})
export type PluginHandlerView = z.infer<typeof PluginHandlerViewSchema>

/**
 * The WebSocket address of one `ctx.onSocket` handler (plan 109 §4.6).
 *
 * It lives in the protocol package because a WS path is a wire string and
 * CLAUDE.md's rule is that those come from here and nowhere else — the core's
 * upgrade branch (`daemon.ts`) and any client must agree on it by importing the
 * same function, not by two people typing the same literal.
 *
 * **A plugin socket is not the farm's `/ws`.** It carries whatever bytes the
 * plugin's own code writes, has no `ServerMessage` envelope, no `WsHub`, and no
 * broadcast: it is a private connection between a browser and one plugin
 * handler. A plugin that wants to HEAR the farm's broadcasts uses `ctx.onEvent`
 * (step 109.5), which is a different mechanism with a different guarantee.
 */
export function pluginSocketPath(plugin: string, socketId: string): string {
  return `/api/plugins/${encodeURIComponent(plugin)}/socket/${encodeURIComponent(socketId)}`
}

/** The inverse of `pluginSocketPath`, for the core's upgrade branch. `null` when `pathname` is not a plugin socket at all. */
export function parsePluginSocketPath(pathname: string): { plugin: string; socketId: string } | null {
  const m = /^\/api\/plugins\/([^/]+)\/socket\/([^/]+)$/.exec(pathname)
  if (!m) return null
  try {
    return { plugin: decodeURIComponent(m[1]!), socketId: decodeURIComponent(m[2]!) }
  } catch {
    // A malformed percent-escape. Not a plugin socket, rather than a 500.
    return null
  }
}
