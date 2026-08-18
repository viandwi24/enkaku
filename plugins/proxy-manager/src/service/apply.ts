import { z } from 'zod'
import {
  ASSIGNMENT_KEY,
  PROXY_APPLY_MODES,
  proxyAuthKeyFor,
  proxyIdFromKey,
  proxySecretKeyFor,
  readProxyRecord,
  routeForRecord,
  vpnAgentProblem,
  type ProxyApplyMode,
  type ProxyProblem,
  type ProxyProblemCode,
} from '../shared'
import { messageOf, scrubSecrets } from './errors'
import type { ListenerCredential } from './auth'

/**
 * Apply — the one place this pack asks the farm to change a phone (plan 114
 * §3.3, step 114.9; two modes as of 0.6.0).
 *
 * ## The boundary, and why it is a capability call rather than a `fetch`
 *
 * The owner's model is that the built-in owns the mechanism and this plugin
 * owns management at scale: *"proxy manager plugin nantinya itu meng extend
 * proxy bawaan ini, jadi proxy manager bisa override setting network proxy
 * bawaan."* Overriding what the built-in set is allowed. Writing a device
 * setting is not.
 *
 * So the route goes out through `ctx.farm.call('device.network.set', …)`, which
 * lands in the very handler `PUT /api/devices/:id/network` lands in:
 *
 * - the plugin's **manifest** is checked before the capability runs at all
 *   (plan 109 §4.3) — a pack that did not declare `device.network.set` cannot
 *   change a phone's networking and then be told it was refused;
 * - the farm's real ACL runs under a `plugin:proxy-manager` principal, so
 *   `device.network` is required of the plugin, not merely of whoever pressed
 *   the button;
 * - the call is audited under that principal, so *what has this plugin done to
 *   my farm* stays one query;
 * - the device's own lease admission applies — a phone somebody is actively
 *   driving is refused, naming them, never taken over;
 * - and the route is stamped `set by proxy-manager`, which the device's Network
 *   panel renders.
 *
 * A `fetch` to the same URL from this pack's screen would do none of that: it
 * would run as the OPERATOR, and the device would report that a person set the
 * route when a plugin did. That is not a smaller version of the same thing — it
 * is the attribution being wrong, which is exactly what makes an operator's
 * *"who put this proxy on my phone"* unanswerable.
 *
 * ## Two modes, one catalogue entry (0.6.0)
 *
 * The owner's own ask: *"apply di setting proxy manager juga harusnya ada 2
 * pilihan dong, apply sebagai vpn mode atau sebagai http proxy mode."*
 *
 * | mode | route | what carries the traffic | the credential |
 * |---|---|---|---|
 * | `http` | `{ engine: 'adb-reverse-proxy', hostPort }` | the bridge on this machine, over `adb reverse` | never leaves the farm |
 * | `vpn`, vendor upstream | `{ engine: 'vpn-helper', host, port, username, password }` | the guest agent, dialling the record's **upstream** directly | **sent to the phone** |
 * | `vpn`, `direct` upstream (plan 117 §3.6) | `{ engine: 'vpn-helper', host, port, username, password }` | the guest agent, dialling **this record's own bridge** | **sent to the phone** |
 *
 * The two `vpn` rows carry the same shape because `routeForRecord` (`shared.ts`)
 * always names *whatever performs the egress* — the vendor's own address for
 * a vendor record, this record's `listen.bindHost`/`.port` for a `direct` one,
 * where there is no vendor to name. Which credential travels differs the same
 * way: a vendor's is the record's outbound account, a `direct` record's is its
 * own **listener** credential — the one a client on the LAN would also have to
 * present — so one recovered from a phone opens the one egress behind that
 * bridge rather than an upstream account shared by every record that uses it.
 *
 * `routeForRecord` decides which shape a record can produce and refuses by name
 * when it cannot (`shared.ts` — one implementation, so the screen and this
 * handler cannot disagree). What is added HERE, because it needs the device and
 * the credential rather than only the record:
 *
 * - **the guest agent precondition** (`vpnAgentProblem`), read off
 *   `DeviceInfo.agent` from the very `device.list` call this file already makes;
 * - **the credential**: for a vendor record, the password read from
 *   `proxy-secret:<id>` (username is already public, on `record.upstream`); for
 *   a `direct` record, **both** username and password, read from
 *   `proxy-auth:<id>` instead — the INBOUND row, not the outbound one, because a
 *   `direct` record has no outbound account to read. Both land on the wire
 *   object the capability carries the same way — see "Where the plaintext
 *   lives" below.
 *
 * **Nothing is ever downgraded.** A VPN apply that cannot happen returns a
 * refusal naming its cause; it never silently becomes an HTTP proxy (plan 114
 * §3.4 rule 4, and §3.9's own repeat of the rule for the bulk path). The two
 * modes route different traffic through different paths, and a phone whose
 * operator asked for the one an app cannot escape must never quietly get the one
 * it can.
 *
 * ## Where the plaintext lives, and how it reaches the route
 *
 * The route carries `username`/`password` **inline** rather than a
 * `credentialRef`, and that is the path that keeps the plaintext out of
 * everything logged or echoed — deliberately, not by default:
 *
 * - `credentialRef` names a row in the farm's own `network_credentials` table.
 *   Creating one is `POST /api/devices/network-credentials`, an HTTP endpoint
 *   with no capability behind it, so a plugin cannot mint one at all. Passing a
 *   name this pack did not create earns `E_CREDENTIAL_NOT_FOUND`.
 * - Inline is the shape the built-in already normalises: `normalizeDeclaredConfig`
 *   (`packages/core/src/network/route-service.ts`) mints a `network_credentials`
 *   row from the pair, encrypted, and persists only a `credentialRef` on
 *   `devices.network_route`. The raw pair is never written to disk.
 * - Nothing on the way records it. `invoke()` audits `{ outcome, code, deviceId,
 *   durationMs }` and never the input; the farm broker's own rule is the same
 *   ("the input is never recorded — a capability input can carry a secret"); the
 *   `network.applied` device event runs its config through
 *   `redactRouteConfig()`; and this file's own log line names the proxy key and
 *   the engine, never the config.
 *
 * So the plaintext exists in exactly two places, both in memory and both in the
 * core's own process (a service runs in-process, plan 109 §3.1): the
 * credential local in `applyAssignment` below (`password`, and for a `direct`
 * record also `username` — read together off one `proxy-auth:<id>` row, since
 * a listener credential is a pair and there is no public field to source the
 * username from as there is for a vendor record), and whatever the built-in
 * holds between receiving it and encrypting it. It is never interpolated into
 * a string here. The `catch` below runs `scrubSecrets` over any message that
 * comes back anyway — the same defence-in-depth `supervisor.ts` applies to a
 * dialler's error, because a library on the far side is the one place a
 * credential leaks into something a person reads (`errors.ts`: `socks` puts
 * the whole config, password included, on `err.options`).
 *
 * ## Explicit, one device at a time (plan 114 §9 Q6)
 *
 * Saving an assignment applies nothing. This runs only when somebody presses
 * Apply on one row, having chosen a mode on that row. An assignment that
 * silently changed forty phones' networking on save is the wrong default, and
 * plan 112 §3.5's own intent-versus-state discipline points the same way.
 */

/** What `apply` needs from a `PluginServiceContext`, structurally — so a test supplies three functions, not a runtime. */
export interface ApplyHost {
  storage: {
    global: { getRaw(key: string): Promise<unknown> }
    forDevice(deviceId: string): { getRaw(key: string): Promise<unknown> }
  }
  farm: {
    call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T>
  }
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }
}

/**
 * The three fields of `DeviceInfo` this pack needs, and no more.
 *
 * `z.looseObject` on the items rather than a strict shape: the farm's own
 * output schema can change under a pack published months ago (plan 109 §4.3's
 * own reason for the `call`/`callRaw` split), and a strict object would turn
 * every future field the farm adds into this pack refusing to work.
 *
 * `agent` is the guest agent's provisioning state, derived by the farm from
 * `devices.preparation['guest-agent']` (plan 106 step 106.5). It is `.optional()`
 * and typed as a plain string on purpose: this pack must keep working against a
 * farm whose `AgentState` gained a seventh word, and `vpnAgentProblem` answers
 * `null` for anything it does not recognise rather than inventing a refusal.
 */
const DeviceListSchema = z.object({
  items: z.array(z.looseObject({ id: z.string(), stableId: z.string(), agent: z.string().optional(), label: z.string().optional() })),
})

/** The half of `GET/PUT /api/devices/:id/network` this pack shows back to the operator. */
const NetworkStatusSchema = z.looseObject({
  engine: z.string(),
  enabled: z.boolean(),
  health: z.string(),
  setBy: z.object({ kind: z.string(), id: z.string(), at: z.number() }).nullable().optional(),
})

/** The assignment row, read defensively for the same reason `readProxyRecord` is: this is the plugin's own scratch space and an operator with `kv.manage` can put anything in it. */
function assignedKeyOf(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const proxy = (value as { proxy?: unknown }).proxy
  return typeof proxy === 'string' ? proxy : ''
}

export type ApplyOutcome =
  | {
      ok: true
      deviceId: string
      proxy: string
      /** Which mode was applied, echoed so the screen words the outcome for the route that actually landed rather than for the one selected in a dropdown that may since have moved. */
      mode: ProxyApplyMode
      engine: string
      health: string
      setBy: { kind: string; id: string; at: number } | null
    }
  /**
   * A refusal — the record cannot be applied in this mode, or the farm declined
   * it. `kind` is `validateProxyRecord`'s own refusal/precondition split, so the
   * screen renders a precondition as "not yet" rather than as an error (plan 59).
   */
  | { ok: false; mode: ProxyApplyMode; code: string; kind: ProxyProblem['kind']; message: string }

/**
 * Refusals this file raises itself, rather than passing one of
 * `validateProxyRecord`/`routeForRecord`/`vpnAgentProblem`'s through. Each is a
 * fact about the ASSIGNMENT or about the farm's answer, rather than about the
 * record.
 */
const E_NO_ASSIGNMENT = 'E_PROXY_NO_ASSIGNMENT'
const E_ASSIGNMENT_DANGLING = 'E_PROXY_ASSIGNMENT_DANGLING'
const E_DEVICE_UNKNOWN = 'E_PROXY_DEVICE_UNKNOWN'
const E_BAD_MODE = 'E_PROXY_BAD_MODE'
const E_APPLY_REFUSED = 'E_PROXY_APPLY_REFUSED'
/**
 * Plan 117 §3.8, §4.2, step 117.10. **Not yet in `shared.ts`'s
 * `PROXY_PROBLEM_CODES`** — that file's own comment beside the retired codes
 * said why: a code with no producer is a promise the row cannot keep, and
 * until this line existed nothing produced it. This is that producer, and the
 * literal has since been registered in `PROXY_PROBLEM_CODES` beside the rest,
 * so the local constant below is now only a spelling guard rather than a
 * stand-in for a code the shared list did not yet admit to.
 */
const E_PROXY_CAPACITY_FULL: ProxyProblemCode = 'E_PROXY_CAPACITY_FULL'

/**
 * The saved credential for a record, or `null` when there is none.
 *
 * `getRaw` rather than `get(key, schema)`, and a `catch` around it, for the same
 * reason `supervisor.ts`'s own `readPassword` has both: an unreadable secret row
 * must not throw out of Apply as a storage error that reads like a bug in the
 * farm. It is the difference between "no password is saved" and "something is
 * wrong with the row", and the caller words the first case itself.
 */
async function readPassword(host: ApplyHost, proxyId: string): Promise<string | null> {
  try {
    const raw = await host.storage.global.getRaw(proxySecretKeyFor(proxyId))
    const value = typeof raw === 'object' && raw !== null ? (raw as { password?: unknown }).password : undefined
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * The saved LISTENER credential for a record — `proxy-auth:<id>`, the pair
 * `readAuth` in `supervisor.ts` reads to configure the bridge itself — or
 * `null` when there is none. A `direct` record's VPN route (plan 117 §3.6)
 * has no outbound account for `readPassword` above to find, so this is what
 * supplies both halves of the credential the route carries: the phone dials
 * the bridge, so the bridge's own credential is what it has to present.
 *
 * Same defensive shape as `readPassword`: an unreadable or malformed row
 * means "no credential to hand over", not a thrown storage error out of
 * Apply.
 */
async function readListenerAuth(host: ApplyHost, proxyId: string): Promise<ListenerCredential | null> {
  try {
    const raw = await host.storage.global.getRaw(proxyAuthKeyFor(proxyId))
    if (typeof raw !== 'object' || raw === null) return null
    const username = (raw as { username?: unknown }).username
    const password = (raw as { password?: unknown }).password
    if (typeof username !== 'string' || typeof password !== 'string' || password.length === 0) return null
    return { username, password }
  } catch {
    return null
  }
}

/** One device noted against a record, for the capacity refusal's own message — never more than a name, never a credential. */
interface Holder {
  stableId: string
  label: string
}

/**
 * Every device whose OWN `assigned` note names `proxyKey` — the same fact
 * `GET …/data/scan?key=assigned` joins in one statement for the Assignments
 * tab (plan 108 §4.5), computed here by reading each device's per-device row
 * directly instead. That route is `plugin.data`-gated and reached with the
 * OPERATOR's browser session; this runs inside the service, under
 * `plugin:proxy-manager`, with no session to present to it. `devices` is the
 * same farm-wide list `applyAssignment` already fetched for its own stableId
 * lookup, so this costs one KV read per device and no second capability call
 * — the N+1 the scan route's own SQL exists to avoid is unavoidable here
 * without a capability this plan does not add, and it is bounded by the same
 * fleet size every other per-device loop in this pack already is.
 *
 * Called only when the record actually asks for a limit (`capacity > 0` or
 * `exclusive`) — the common, unlimited record pays nothing for this.
 */
async function currentHolders(host: ApplyHost, devices: { id: string; stableId: string; label?: string }[], proxyKey: string): Promise<Holder[]> {
  const holders: Holder[] = []
  for (const device of devices) {
    const raw = await host.storage.forDevice(device.id).getRaw(ASSIGNMENT_KEY)
    if (assignedKeyOf(raw) === proxyKey) holders.push({ stableId: device.stableId, label: device.label && device.label.length > 0 ? device.label : device.stableId })
  }
  return holders
}

/** `office-uk (a1b2c3), studio-3 (d4e5f6)` — used only inside a refusal message, never logged raw. */
function nameHolders(holders: Holder[]): string {
  return holders.map((h) => (h.label === h.stableId ? h.stableId : `${h.label} (${h.stableId})`)).join(', ')
}

export async function applyAssignment(host: ApplyHost, input: { stableId: string; mode?: ProxyApplyMode }): Promise<ApplyOutcome> {
  /**
   * An absent mode is `http`, which is the only mode that existed before 0.6.0
   * and is therefore the only reading that cannot change what an existing
   * caller's request does. An unrecognised one is refused rather than defaulted
   * — defaulting a misspelled `"vpn "` to the advisory rung would be the silent
   * downgrade this whole file refuses to do, arriving through a typo.
   */
  const mode: ProxyApplyMode = input.mode ?? 'http'
  if (!PROXY_APPLY_MODES.some((m) => m === mode)) {
    return {
      ok: false,
      mode: 'http',
      code: E_BAD_MODE,
      kind: 'refusal',
      message: `“${String(input.mode)}” is not a mode this plugin knows. Apply either as an HTTP proxy or as a VPN — and nothing was changed on the phone, because guessing which one was meant is how a device ends up with a proxy an app can ignore when somebody asked for one it cannot.`,
    }
  }

  // The farm's own device list is what maps a stable id to the row id every
  // device API is keyed by. It is also the only way this pack learns a device
  // exists at all — it has no database and no adb — and, since 0.6.0, where the
  // guest agent's state comes from for VPN mode's precondition.
  const devices = await host.farm.call('device.list', {}, DeviceListSchema)
  const device = devices.items.find((d) => d.stableId === input.stableId)
  if (!device) {
    return {
      ok: false,
      mode,
      code: E_DEVICE_UNKNOWN,
      kind: 'refusal',
      message: `The farm has no device with the stable id ${input.stableId}. It was probably forgotten between this screen loading and Apply being pressed — reload the tab.`,
    }
  }

  const assigned = assignedKeyOf(await host.storage.forDevice(device.id).getRaw(ASSIGNMENT_KEY))
  if (!assigned) {
    return {
      ok: false,
      mode,
      code: E_NO_ASSIGNMENT,
      kind: 'precondition',
      message: 'No proxy is noted against this device yet. Choose one on this row first — Apply asks the farm for exactly what the note says, and nothing else.',
    }
  }

  const proxyId = proxyIdFromKey(assigned)
  const stored = proxyId === null ? null : await host.storage.global.getRaw(assigned)
  if (proxyId === null || stored === null || stored === undefined) {
    return {
      ok: false,
      mode,
      code: E_ASSIGNMENT_DANGLING,
      kind: 'refusal',
      message: `This device is noted against “${assigned}”, and there is no such record in the catalogue any more. Pick another proxy, or add that record back — applying a note that points at nothing would leave the phone pointed at a port nobody owns.`,
    }
  }

  const record = readProxyRecord(stored)

  /**
   * Capacity (plan 117 §3.8, §9 Q1) — checked BEFORE the VPN precondition
   * below, and for BOTH modes identically. It is a property of the RECORD
   * ("how many devices should this carry"), not of the rung a particular
   * Apply happens to use, and the owner's own answer to §9 Q1 is explicit:
   * the HTTP rung is advisory — an app can ignore a proxy it was merely told
   * about — so a count over it is a count of what the operator asked this
   * record to carry, never a claim about traffic actually observed. Saying
   * that plainly in the refusal is what keeps this from reading as a traffic
   * limiter it is not.
   *
   * Skipped entirely for the ordinary record (`capacity: 0`, `exclusive:
   * false`) — the common case pays no extra KV reads for a limit it never
   * asked for.
   *
   * Re-applying a record to a device that already holds it is not a NEW
   * occupant: `alreadyHolds` keeps a second press of the same button from
   * refusing itself out of a slot it already has.
   */
  if (record.capacity > 0 || record.exclusive) {
    const holders = await currentHolders(host, devices.items, assigned)
    const alreadyHolds = holders.some((h) => h.stableId === input.stableId)
    const others = holders.filter((h) => h.stableId !== input.stableId)

    if (record.exclusive && others.length > 0) {
      return {
        ok: false,
        mode,
        code: E_PROXY_CAPACITY_FULL,
        kind: 'refusal',
        message: `“${assigned}” is exclusive — noted against one device at a time — and ${nameHolders(others)} already ${others.length === 1 ? 'holds' : 'hold'} it. This counts the assignment note, not traffic through it, so it applies the same way in HTTP mode even though an app there could ignore the proxy anyway. Clear the note on ${others.length === 1 ? 'that device' : 'those devices'} first, or turn “Exclusive” off if this record is meant to be shared.`,
      }
    }

    if (record.capacity > 0) {
      const projected = alreadyHolds ? holders.length : holders.length + 1
      if (projected > record.capacity) {
        return {
          ok: false,
          mode,
          code: E_PROXY_CAPACITY_FULL,
          kind: 'refusal',
          message: `“${assigned}” allows ${record.capacity} device${record.capacity === 1 ? '' : 's'} at once and is already noted against ${holders.length}: ${nameHolders(holders)}. This counts the assignment note, not traffic through it, so it applies the same way in HTTP mode even though an app there could ignore the proxy anyway. Raise the capacity, or clear the note on one of the others first.`,
        }
      }
    }
  }

  /**
   * VPN mode's device-side precondition, asked before anything else about the
   * RECORD is considered (capacity above is a fact about the assignment, not
   * about the record's own upstream/listener shape, which is why it is
   * checked ahead of this rather than after it).
   *
   * Asked this early because it is the one an operator is most likely to hit
   * and the one whose fix is furthest from this screen: a phone with no guest
   * agent cannot take a VPN route however perfect the record is, and telling
   * them to go and fix an upstream first would be advice that does not help.
   */
  if (mode === 'vpn') {
    const blocked = vpnAgentProblem(device.agent ?? '')
    if (blocked) return { ok: false, mode, code: blocked.code, kind: blocked.kind, message: blocked.message }
  }

  // Read only for the mode that spends it. The HTTP rung has no use for a
  // credential — the bridge holds it — and reading one anyway would put a
  // plaintext into this process for a call that will never carry it.
  //
  // Which row depends on which credential the record's VPN route actually
  // needs (plan 117 §3.6): a vendor record's is its outbound account
  // (`proxy-secret:<id>`; its username is already public, on
  // `record.upstream`, so only the password needs reading). A `direct`
  // record has no outbound account — this farm IS the egress — so its VPN
  // route carries its own LISTENER credential instead, both fields secret,
  // read together off `proxy-auth:<id>`.
  const isDirectUpstream = record.upstream.proto === 'direct'
  const listenerAuth = mode === 'vpn' && isDirectUpstream ? await readListenerAuth(host, proxyId) : null
  const password = mode === 'vpn' ? (isDirectUpstream ? (listenerAuth?.password ?? null) : await readPassword(host, proxyId)) : null

  const resolved = routeForRecord(record, { id: proxyId, mode, ...(mode === 'vpn' ? { hasPassword: password !== null } : {}) })
  if ('problem' in resolved) {
    return { ok: false, mode, code: resolved.problem.code, kind: resolved.problem.kind, message: resolved.problem.message }
  }

  /**
   * The credential joins the route here and nowhere else — the last statement
   * before the door, so there is no intermediate object holding it that
   * something else could reach or log. For a `direct` record this adds
   * `username` too: `directVpnRouteForRecord` (`shared.ts`) cannot populate
   * it any more than it can populate `password` — both live on the same
   * secret row that file cannot read.
   */
  const route: Record<string, unknown> =
    resolved.route.engine === 'vpn-helper'
      ? {
          ...resolved.route,
          ...(password !== null ? { password } : {}),
          ...(isDirectUpstream && listenerAuth ? { username: listenerAuth.username } : {}),
        }
      : { ...resolved.route }

  // The one door. Everything below this line belongs to the farm: the lease
  // admission, the `network-route` lock, the capture of whatever proxy the
  // phone already had, the credential's encryption into `network_credentials`,
  // the read-back, and the attribution.
  let status: z.infer<typeof NetworkStatusSchema>
  try {
    status = await host.farm.call('device.network.set', { deviceId: device.id, route }, NetworkStatusSchema)
  } catch (err: unknown) {
    /**
     * A refusal from the farm is a product outcome, not a fault in this plugin.
     *
     * Left to throw, it became the host's `502` naming this pack as broken —
     * which is wrong for every case that actually happens here: somebody else is
     * driving the phone (`admitMember`, working exactly as designed), the phone
     * is offline, an incumbent route holds the `network-route` lock, the guest
     * agent could not be reached. The operator needs to read which of those it
     * was, and "Request failed (HTTP 502)" tells them none of it.
     *
     * The farm's own code travels with the message, so a lease refusal stays
     * distinguishable from a lock refusal. `scrubSecrets` runs over the message
     * because this is the one place a string from code this pack does not own
     * becomes something a person reads.
     */
    const code = (err as { code?: unknown } | null)?.code
    const message = scrubSecrets(messageOf(err), password === null ? [] : [password])
    host.log.warn('the farm refused to apply a proxy to a device', { deviceId: device.id, proxy: assigned, mode, code: typeof code === 'string' ? code : null })
    return {
      ok: false,
      mode,
      code: typeof code === 'string' && code.length > 0 ? code : E_APPLY_REFUSED,
      kind: 'refusal',
      message,
    }
  }

  host.log.info('applied a proxy to a device through the farm’s own network layer', {
    deviceId: device.id,
    proxy: assigned,
    mode,
    engine: status.engine,
    health: status.health,
  })

  return {
    ok: true,
    deviceId: device.id,
    proxy: assigned,
    mode,
    engine: status.engine,
    health: status.health,
    setBy: status.setBy ?? null,
  }
}
