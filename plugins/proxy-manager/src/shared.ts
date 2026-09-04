/**
 * The facts BOTH halves of this pack need, in a file that imports nothing.
 *
 * This pack now has THREE halves that are compiled separately: `src/index.ts`
 * (the manifest, the script members and — since plan 112 — the service,
 * bundled by `enkaku publish` for the core's runtime), `src/ui/index.tsx` (the
 * screen, bundled by `bun build --production` for the browser, plan 111 §4.4),
 * and `src/service/**` (loaded into the core's own process). A constant any of
 * them might get wrong therefore has to live somewhere all three can import —
 * and `record.ts` is not that place, because it pulls in `zod` and
 * `@enkaku/sdk`, and importing it from the UI entry would inline a schema
 * library and a server SDK into a module the browser downloads.
 *
 * So: no imports, no types beyond the values themselves, and nothing here that
 * would be wrong to ship to a browser.
 *
 * **Plan 112 put the record's own LOGIC here too, and that is deliberate.**
 * `readProxyRecord` (the read-time migration, §4.3) and `validateProxyRecord`
 * (the four coded refusals, §4.2) are called from all three halves: the screen
 * refuses a bad record at write, the service refuses the same record again at
 * start, and `record.ts` re-exports both beside the Zod declaration they are
 * kept honest against. One implementation, three callers — the alternative is
 * a browser copy and a server copy that agree on the day they are written.
 */

/**
 * Every key this plugin writes into its own GLOBAL KV namespace starts with
 * this, and the catalogue lists exactly this prefix.
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
 * The OTHER key per proxy — the upstream password, and nothing else (plan 112
 * §3.6). Written with `secret: true`, read only in-process by the service.
 *
 * It deliberately does not start with `PROXY_KEY_PREFIX`, so the catalogue's
 * existing `list({ prefix: 'proxy:' })` picks up records and never credentials.
 * That is a property of the two strings — asserted in `index.test.ts` — rather
 * than of a filter somebody has to remember to write. Both match KV's key
 * charset (`/^[A-Za-z0-9._:-]+$/`).
 *
 * **This key is now written, and step 112.2 is why it may be.** A KV secret
 * used to carry a `hint` derived from its plaintext with no way to decline it
 * (plan 112 F12); `KvSetOptions.hint` (default `true`) landed, and every write
 * of this key passes `secret: true, hint: false` together. The option is **per
 * write, not per key** — a later write that omits it re-derives the hint — so
 * `hint: false` is passed on the same line as `secret: true`, every time,
 * and `index.test.ts` asserts that they travel together rather than that one of
 * them exists. `secretHintLeak()` below still measures what an omitted flag
 * would cost, which is why the value stays an object with one field.
 */
export const PROXY_SECRET_KEY_PREFIX = 'proxy-secret:'

/** `proxy:office-uk` → `office-uk`; `null` for a key that is not a catalogue row. */
export function proxyIdFromKey(key: string): string | null {
  if (!key.startsWith(PROXY_KEY_PREFIX)) return null
  const id = key.slice(PROXY_KEY_PREFIX.length)
  return id.length > 0 ? id : null
}

/** `office-uk` → `proxy:office-uk`. */
export function proxyKeyFor(id: string): string {
  return `${PROXY_KEY_PREFIX}${id}`
}

/** `office-uk` → `proxy-secret:office-uk` — the credential half of the same record. */
export function proxySecretKeyFor(id: string): string {
  return `${PROXY_SECRET_KEY_PREFIX}${id}`
}

/**
 * `office-uk`, slot 2 → `proxy-secret:office-uk:2` — the credential half of
 * ONE UPSTREAM SLOT (plan 121 §4.1, widened by step 121.4). Slot `0` is the
 * record's own primary `upstream`; `1..n` is `fallbackUpstreams[slot - 1]` —
 * mirroring `readFallbackUpstreams`' own index-based addressing below.
 *
 * Widened from one password per RECORD to one per upstream SLOT because
 * `ProxyUpstream` itself has no password field of its own: a fallback naming
 * a different account (another local egress, a third-party rotating proxy
 * like SOAX) needs its own credential, and reusing the primary's for every
 * slot — the gap step 121.3 named rather than silently got wrong — is
 * exactly what this key scheme closes.
 *
 * **`proxySecretKeyFor(id)` (the bare, pre-121.4 key) is unchanged and stays
 * the read-time fallback for slot 0** — the same "read-time default for a
 * pre-existing shape" discipline this file already applies to
 * `fallbackUpstreams`/`failover` themselves (`readProxyRecord`'s own comment):
 * a record written before this step has no `:0`/`:1`/… key at all, so reading
 * slot 0 falls through to the legacy bare key rather than reading as "no
 * password saved". Fallback slots (`1..n`) have no legacy key to fall back
 * to — no secret written for a slot is a real absence, not a fault, for a
 * freshly-added fallback nobody has entered credentials for yet.
 */
export function proxySecretSlotKeyFor(id: string, slot: number): string {
  return `${proxySecretKeyFor(id)}:${slot}`
}

/**
 * The INBOUND credential — `{ username, password }` for whoever is allowed to
 * dial IN to this bridge, never confused with `proxySecretKeyFor`'s outbound
 * one, which is who this bridge dials OUT as (plan 117 §3.5, §4.5).
 *
 * Moved here from `service/supervisor.ts`, where step 117.6 first needed it
 * and built it locally because `shared.ts` was not yet that step's to own — its
 * own comment flagged the move as owed. It belongs beside `proxySecretKeyFor`
 * by the pack's one-key-builder-per-credential-kind pattern, and `record.ts`'s
 * comment on `listenerAuth` already fixes the string this must match:
 * `proxy-auth:<id>`.
 *
 * Same disjointness property as `proxy-secret:`, and for the same reason:
 * `proxy-auth:`'s sixth character is `-`, not `:`, so it never starts with
 * `PROXY_KEY_PREFIX` and the catalogue's `list({ prefix: 'proxy:' })` keeps
 * returning records and only records — a property of the strings, asserted in
 * `index.test.ts` beside the existing assertion for `proxy-secret:`.
 */
export const PROXY_AUTH_KEY_PREFIX = 'proxy-auth:'

/** `office-uk` → `proxy-auth:office-uk` — the listener credential half of the same record. */
export function proxyAuthKeyFor(id: string): string {
  return `${PROXY_AUTH_KEY_PREFIX}${id}`
}

/**
 * The observed-egress half of the same record — what the probe last saw
 * dialling THROUGH this record's own upstream (plan 117 §3.7, §4.5,
 * `service/probe.ts`). Not secret: a public address and a latency are not a
 * credential, and hiding them would take the one thing this row exists to show
 * off the screen it is drawn on.
 *
 * Same disjointness property as `proxy-auth:` and `proxy-secret:`, and for the
 * same reason: `proxy-probe:`'s sixth character is `-`, not `:`, so it never
 * starts with `PROXY_KEY_PREFIX` and the catalogue's `list({ prefix: 'proxy:' })`
 * keeps returning records and only records — a property of the strings,
 * asserted in `index.test.ts` beside the existing assertions for
 * `proxy-secret:` and `proxy-auth:`.
 */
export const PROXY_PROBE_KEY_PREFIX = 'proxy-probe:'

/** `office-uk` → `proxy-probe:office-uk` — the observed-egress half of the same record. */
export function proxyProbeKeyFor(id: string): string {
  return `${PROXY_PROBE_KEY_PREFIX}${id}`
}

/**
 * The one DEVICE-scoped key this pack writes, and the reason the Assignments
 * tab can exist at all: `GET /api/plugins/:name/data/scan?key=assigned`
 * answers with every device in the farm and whether it holds this key, in one
 * statement (plan 108 §4.5). Device-scoped by the same rule the catalogue is
 * global by — forgetting a phone SHOULD forget which proxy someone noted
 * against it.
 */
export const ASSIGNMENT_KEY = 'assigned'

/**
 * What the Add dialog says about the storage key, and why the rule is stated
 * rather than enforced.
 *
 * A key saved without the prefix IS saved — it simply will not appear in a
 * list that filters on `proxy:`. Refusing it would be a stronger claim than
 * the storage makes, so the dialog says exactly what happens instead. The key
 * is also fixed for the life of the row: a write upserts and cannot MOVE an
 * entry, so offering a rename would silently create a second row and leave the
 * first one behind.
 */
export const PROXY_KEY_HINT = `Keep the "${PROXY_KEY_PREFIX}" prefix — a key without it is still saved, but will not appear in this list. Saving over an existing key replaces that row.`

// ---------------------------------------------------------------------------
// The storage key is DERIVED, not typed (the owner's first complaint)
// ---------------------------------------------------------------------------

/**
 * The owner's own words: *"bentar ini kenapa ada storage key? … kenapa musti
 * manual gini setiap proxy?"* — and they are right. A KV key is where the row
 * lives, which is an implementation detail of the storage, and asking an
 * operator to invent one for every proxy is asking them to do the machine's
 * filing.
 *
 * So the key comes from the NAME. `SOAX Japan` → `proxy:soax-japan`. The field
 * survives only as an override behind a disclosure, prefilled with what would
 * be derived anyway, because two facts make it something an operator sometimes
 * genuinely needs:
 *
 * 1. a name in a script that is not Latin slugs to nothing (see
 *    `UNTITLED_PROXY_SLUG`), and
 * 2. the key is the record's IDENTITY — the service's start/stop routes, the
 *    log tag and the credential key are all derived from it — so somebody
 *    migrating rows by hand has to be able to say which one this is.
 *
 * **And it is editable at creation only.** `PUT …/data/entry` upserts: it
 * cannot MOVE an entry. Changing the key on an existing row does not rename it,
 * it writes a second row and abandons the first — with the first row's
 * `proxy-secret:` credential still attached to a record nothing points at. A
 * silent orphan is worse than the typing this whole section removes, so the
 * field is locked after creation and `PROXY_KEY_LOCKED_HINT` says why.
 */

/** How long a derived slug may get before it is cut. The store's own ceiling is 256 for the WHOLE key. */
export const PROXY_SLUG_MAX = 64

/**
 * What a name with no Latin letters or digits in it derives to.
 *
 * `東京 SOCKS` has exactly one sluggable character run and `プロキシ` has none,
 * so a transliteration this file cannot do (it imports nothing, deliberately)
 * would be the only alternative to a fallback. `untitled` plus the collision
 * suffix below gives `proxy:untitled`, `proxy:untitled-2`, … — which is ugly
 * and honest, and the override field is right there for anyone who minds.
 */
export const UNTITLED_PROXY_SLUG = 'untitled'

/**
 * A name → the slug half of its storage key.
 *
 * The output charset is `[a-z0-9-]`, a strict subset of the KV key charset
 * (`/^[A-Za-z0-9._:-]+$/`), so a derived key can never be refused by the store
 * for its shape. Accents are folded rather than dropped — `Köln` is `koln`, not
 * `k-ln` — which is the one thing NFKD normalisation buys here.
 */
export function slugifyProxyName(name: string): string {
  return name
    .normalize('NFKD')
    // The combining-marks block U+0300–U+036F, which NFKD has just split the
    // accents out into. The two characters in the class are invisible in an
    // editor, which is why the range is named here in prose as well.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROXY_SLUG_MAX)
    .replace(/-+$/g, '')
}

/**
 * A name → a storage key nothing else in the catalogue already holds.
 *
 * **The collision rule, stated because two proxies called "SOAX Japan" is not a
 * hypothetical:** the derived key gets a numeric suffix — `proxy:soax-japan`,
 * then `proxy:soax-japan-2`, then `-3` — and the dialog SHOWS the suffixed key
 * before anything is saved. It is deliberately not a refusal: two proxies may
 * legitimately share a name (the same provider, two exit countries, one label
 * an operator is about to fix), and refusing a save over a filing detail they
 * did not choose would be the storage key demanding attention all over again.
 *
 * What is refused is the other direction: a key TYPED into the override field
 * that already exists. That one is a clobber — `PUT` upserts, so it would
 * replace a row the operator cannot see from the dialog — and the screen blocks
 * Save with `PROXY_KEY_TAKEN_HINT` rather than suffixing something the operator
 * spelled out on purpose.
 */
export function deriveProxyKey(name: string, taken: Iterable<string>): string {
  const base = slugifyProxyName(name) || UNTITLED_PROXY_SLUG
  const used = new Set(taken)
  let candidate = proxyKeyFor(base)
  for (let n = 2; used.has(candidate) && n < 10_000; n += 1) candidate = proxyKeyFor(`${base}-${n}`)
  return candidate
}

/** What the dialog says beside the key it worked out for you. */
export const PROXY_KEY_DERIVED_HINT =
  'Where this record is filed. It is made from the name, so there is nothing to type — open “Storage key” below only if you want a different one. It is fixed once the record exists.'

/** What it says when the derived key had to be suffixed, so the operator sees the collision rather than discovering it later. */
export const PROXY_KEY_COLLISION_HINT =
  'Another record is already filed under the plain form of this name, so a number was added. Both records are kept and neither is overwritten — rename this one, or open “Storage key” and choose the filing yourself.'

/** What it says when the operator typed a key that already exists. This one blocks Save. */
export const PROXY_KEY_TAKEN_HINT =
  'A record is already filed under that key. Saving would replace it, and its saved password would stay attached to whatever you write here — so this is refused rather than done quietly. Choose another key, or close this and edit that record instead.'

/** Why the key cannot be changed on a record that exists — the sentence that replaces an offer of a rename. */
export const PROXY_KEY_LOCKED_HINT =
  'A record cannot be refiled. Saving writes to a key, it cannot move a row from one to another — a new key here would create a second record and abandon this one, with its saved password still attached to the row nothing points at. Delete and re-add if the filing is genuinely wrong.'

/**
 * The transports a record's UPSTREAM can name. `createUpstream()`
 * (`service/upstream.ts`) switches on this value to build the dialler, so it
 * is a closed list rather than free text: an operator who typed "socks 5"
 * would be the one holding the bug the day something reads it wrong.
 *
 * **`direct` (plan 117 §3.1) names no remote proxy at all** — it is the
 * generic statement of "dial the destination yourself", optionally bound to
 * one of this host's own addresses. It is listed here, alongside the three
 * transports that DO name a remote party, because it is still a choice of
 * upstream: a record has exactly one, and this is the fourth kind it can be.
 * See `ProxyUpstream.bindAddress` for what it means instead of host/port/
 * username, all three of which it ignores.
 */
export const PROXY_KINDS = ['http', 'https', 'socks5', 'direct'] as const

export type ProxyKind = (typeof PROXY_KINDS)[number]

/** How each transport is written for a person. `socks5` is spelled SOCKS5, never "Socks5". */
export const PROXY_KIND_LABELS: Record<ProxyKind, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
  direct: 'Direct',
}

/**
 * The `direct` upstream's own description (plan 117 §4.3 point 3) — none of
 * `describeUpstream`'s `scheme://user@host:port` shape applies, because a
 * `direct` upstream names no remote party at all. What matters instead is
 * which local address it binds and whether name resolution follows it, and
 * both are safe to say in full: neither is a credential.
 *
 * Lives HERE rather than in `service/upstream.ts`, where step 117.3 first
 * wrote it: this is the one place both halves can read the same words from —
 * `service/upstream.ts` (the dial, and `startLocked`'s `reportListener`
 * description) and `ui/parts/catalogue.tsx` (the catalogue's Upstream column,
 * 117.5's own bug — that column rendered `PROXY_KIND_LABELS[proto]` followed
 * by `upstream.host`, which reads `Direct —` for a record with no host).
 * `catalogue.tsx` cannot import `service/upstream.ts` — that module pulls in
 * `node:net` and `node:dns/promises`, which the browser bundle cannot
 * follow — so the words move to the file that imports nothing, the same
 * one-implementation-two-callers discipline `readProxyRecord` already follows.
 */
export function describeDirectUpstream(bindAddress: string, resolveThroughEgress: boolean): string {
  if (!bindAddress) return 'direct (this host’s default route)'
  return `direct via ${bindAddress}${resolveThroughEgress ? ', DNS through the same address' : ', DNS through the host’s default resolver'}`
}

/**
 * The five states a bridge can be in, and the one word each is written as.
 *
 * Here rather than in `service/supervisor.ts` (steps 112.7/112.10) because the
 * supervisor imports `node:net` through its listener, so the browser half
 * could not import from it without dragging the whole bridge into a module
 * Studio downloads — and so it declared the same five words a second time.
 * Two copies of a vocabulary that must agree is exactly the drift this file
 * exists to prevent; it imports nothing, which is why both halves can share it.
 *
 * The screen adds a **sixth** word of its own, `unknown`, and that is correct
 * rather than an omission here: it means "the runtime read failed", which is a
 * fact about the farm's answer and not a state any supervisor was ever in.
 * Folding it into `stopped` would be a claim nobody made.
 *
 * `starting` is its own word and is never rendered as `running`; `stopping` is
 * never rendered as `stopped`. A bridge mid-drain has released its port and is
 * refusing new connections while the tunnels already open are given until the
 * drain runs out — an operator reading "stopped" there would reasonably start
 * something else on that port.
 */
export const PROXY_STATES = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const
export type ProxyState = (typeof PROXY_STATES)[number]

export const PROXY_STATE_LABELS: Record<ProxyState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  failed: 'Failed',
}

// ---------------------------------------------------------------------------
// The record, v2 (plan 112 §3.6, §4.2)
// ---------------------------------------------------------------------------

/**
 * What a bridge SPEAKS to whatever dials it.
 *
 * `https` is in the vocabulary and refused by `validateProxyRecord` — see
 * `PROXY_PROBLEMS.E_PROXY_LISTEN_UNSUPPORTED`. Accepting the word and refusing
 * the value is deliberate: an operator who picks it is told why, once, at
 * write time, instead of discovering it as a mysterious failure at start.
 */
export const LISTEN_PROTOS = ['http', 'socks5', 'https'] as const
export type ListenProto = (typeof LISTEN_PROTOS)[number]

/** The listen side written for a person, same spelling rule as `PROXY_KIND_LABELS`. */
export const LISTEN_PROTO_LABELS: Record<ListenProto, string> = {
  http: 'HTTP',
  socks5: 'SOCKS5',
  https: 'HTTPS',
}

/**
 * Loopback needs no listener credential (plan 112 §3.9, made conditional by
 * plan 117 §3.5).
 *
 * An HTTP or SOCKS5 proxy with no authentication of its own, reachable
 * off-host, is an **open relay**: anyone who can route a packet to it spends
 * the operator's upstream account. v1 shipped no listener-side authentication
 * at all, so an off-host bind was refused unconditionally. Plan 117 builds
 * that authentication (`service/auth.ts`) and reopens the gate on its own
 * premise instead: `validateProxyRecord` still refuses a bind outside this
 * list, but only for a record that cannot prove who is dialling it
 * (`E_PROXY_LISTENER_AUTH_REQUIRED`, `E_PROXY_LISTENER_AUTH_MISSING`). A
 * record with listener credentials saved may bind anywhere.
 */
export const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1'] as const

/**
 * The two spellings of "every address", refused for a VPN route regardless of
 * whether the bind is otherwise permitted (plan 117 §3.5, §4.2,
 * `E_PROXY_VPN_BIND_UNSPECIFIED`). The route handed to a phone has to name an
 * address the phone can actually dial; a wildcard bind names none. It is also,
 * independently, the smaller exposure: one concrete address rather than every
 * address this host holds.
 */
export const WILDCARD_BIND_HOSTS = ['0.0.0.0', '::'] as const

/** The bind a new record gets, and the only one most records will ever have. */
export const DEFAULT_BIND_HOST = '127.0.0.1'

/**
 * The per-proxy concurrent-connection ceiling a new record gets.
 *
 * **Derived from H2's measurement, not from taste** (plan 112 §3.7,
 * criterion 20). The numbers are recorded in plan 112 §0.3 beside the
 * hypothesis; the short version is that the farm's own `/api/health` p99 is
 * unmoved at 200 concurrent tunnels and the event loop only starts to show at
 * a level no single upstream account would sustain, so the cap exists to bound
 * a runaway client rather than to protect a measured cliff. It is per record
 * and an operator can raise it.
 */
export const DEFAULT_MAX_CONNECTIONS = 256

/** How long a stop lets live tunnels finish before it destroys them (plan 112 §3.7 phase 2). */
export const DEFAULT_DRAIN_MS = 10_000

/** Where a bridge listens. `port: null` means one was never assigned — see `readProxyRecord`. */
export interface ProxyListen {
  proto: ListenProto
  bindHost: string
  /**
   * `null` is a real, storable state and not a missing field: a record
   * migrated from the shipped `{ label, kind, host, port, notes }` shape named
   * an UPSTREAM port and no local one, and there is no correct guess (plan 112
   * §4.3 property 3). The row says "needs a local port" and cannot start.
   */
  port: number | null
}

/** The proxy this bridge tunnels THROUGH. The password is not here — it is the other key (§3.6). */
export interface ProxyUpstream {
  proto: ProxyKind
  /** Ignored when `proto === 'direct'` — a direct upstream names no remote party. */
  host: string
  /** Ignored when `proto === 'direct'`. */
  port: number
  /**
   * In the clear, deliberately, and questioned in plan 112 §9 Q1: a catalogue
   * that cannot say which account a proxy authenticates as is a list of
   * hostnames. The PASSWORD is never here.
   *
   * Ignored when `proto === 'direct'` — there is no account to authenticate.
   */
  username: string
  /**
   * The local source address to bind outgoing connections to —
   * `net.connect`'s own `localAddress` option, and nothing more (plan 117
   * §3.1). Meaningful only for `proto: 'direct'`, the same way `host`, `port`
   * and `username` are meaningful only for the other three.
   *
   * **Empty means "dial out however this host normally would."** That is not
   * a placeholder for an unfinished record — it is the point: a `direct`
   * record with no `bindAddress` is a plain local bridge, useful to an
   * operator with no proxy account at all (plan 117 §3.1 point 1).
   */
  bindAddress: string
  /**
   * Whether name resolution for a `direct` record follows `bindAddress`
   * rather than the host's default route (plan 117 §3.4). Default **on**,
   * because the mismatch it prevents — a lookup leaving through a different
   * link than the connection that follows it — produces no error and is
   * invisible until an operator goes looking for it.
   *
   * Meaningless with an empty `bindAddress`, and meaningless for every proto
   * other than `direct`: an upstream proxy resolves nothing itself, the
   * bridge only ever hands it a hostname.
   */
  resolveThroughEgress: boolean
}

/**
 * The failover behaviour a record declares for itself (plan 121 §4.1).
 *
 * No separate "enabled" flag: failover logic (`service/failover.ts`) is
 * simply inert when `fallbackUpstreams` is empty, matching the same rule
 * `ProxyRecord.listenerAuth` already follows for its own credential — 00-
 * overview §4.3's "don't add fields beyond what's needed." Both fields
 * therefore always have a value, even on a record with no backups
 * configured at all.
 */
/**
 * The `fields.event` marker a `service/failover.ts` switch's log line carries
 * (plan 121 §4.5, step 121.6) — `service/logbook.ts`'s `LogSink` is the only
 * log channel a plugin service has (the per-plugin ring served by
 * `GET /api/plugins/:name/runtime/logs`); there is no separate, plugin-specific
 * WS message type, because the core's protocol package must not carry one
 * entry per optional plugin (00-overview §4.3's "no second, weaker way",
 * applied to the wire rather than to storage). A switch's `warn`/`info` line
 * therefore carries this marker plus `recordId`/`from`/`to`/`reason`/`at` in
 * its `fields` bag, so a reader of the plugin's log (the Logs tab) can tell a
 * failover event from an ordinary line without parsing prose.
 * `ui/parts/catalogue.tsx`'s own
 * failover chip does NOT read this — see that file's own note on why it polls
 * the ordinary `GET …/http/proxies` row instead.
 */
export const PROXY_FAILOVER_EVENT = 'proxy.failover'

export interface ProxyFailoverConfig {
  /**
   * Consecutive dial failures against the currently active upstream before a
   * confirmation probe runs and, if it also fails, a switch happens (plan
   * 121 §3.2, §4.2). Counted per-(record, active upstream) — switching
   * upstream always resets the count to zero.
   */
  failureThreshold: number
  /**
   * Whether a healthy PRIMARY, confirmed by a background re-probe reaching
   * the anti-flap recovery streak, is switched back to automatically (plan
   * 121 §4.4). Default on. When off, the background probe still runs so
   * Studio can show "primary looks healthy again," but only the manual
   * "reset to primary" action switches back.
   */
  autoFailback: boolean
}

/** One proxy, as this plugin stores it. Field order is the storage order; `index.test.ts` holds `writeProxy` to it. */
export interface ProxyRecord {
  label: string
  listen: ProxyListen
  upstream: ProxyUpstream
  /**
   * Backup upstreams this record fails over to, in order, when the primary
   * proves unreachable — confirmed by a generic probe through the SAME
   * upstream first, so a flaky target site never burns through backups
   * (plan 121 §1, §4.2). Any existing `ProxyUpstream` shape: another local
   * egress via `direct`, or a third-party rotating proxy (e.g. SOAX) via
   * `http`/`socks5` — nothing new to build for either case (plan 121 §0.2).
   *
   * Empty is the ordinary case, and leaves failover provably inert — see
   * `ProxyFailoverConfig`'s own comment for why there is no separate on/off
   * switch.
   */
  fallbackUpstreams: ProxyUpstream[]
  /**
   * How aggressively this record fails over, and whether it fails back on
   * its own. Always present, even with `fallbackUpstreams` empty.
   */
  failover: ProxyFailoverConfig
  /**
   * INTENT, never observation (plan 112 §3.5). The supervisor starts every
   * enabled record when the plugin loads. A running proxy's state, uptime,
   * connection count and last error are in memory and are never written here:
   * a persisted `running` that survived a crash would be a lie the moment it
   * was read.
   */
  enabled: boolean
  /**
   * Whether a log line may name the HOST a connection was for. Off by default,
   * because a proxy that logs every destination quietly becomes a browsing
   * record of every device that used it (plan 112 §3.8).
   */
  logDestinations: boolean
  maxConnections: number
  drainMs: number
  /**
   * How many devices may hold this record at once through the device-scoped
   * `assigned` key. `0` means unlimited (plan 117 §3.8) — generic on purpose:
   * a vendor plan with a concurrent-session limit needs this as much as a
   * single physical link that can only carry so many devices convincingly.
   *
   * **Enforced in `apply.ts`, not by this declaration** (step 117.10): Apply
   * counts the devices already holding the record through the device-scoped
   * `assigned` key and refuses with `E_PROXY_CAPACITY_FULL`, naming the count
   * and the holders. A device re-applying to a record it already holds is not
   * a new occupant and is not counted, or a full record could never be
   * re-applied to the very devices on it.
   *
   * For the HTTP rung this counts INTENT rather than traffic — an app can
   * ignore an advisory proxy — and the refusal says so rather than implying it
   * measured anything (§9 Q1).
   */
  capacity: number
  /**
   * Whether this record refuses a second concurrent assignment outright, the
   * stricter sibling of `capacity` for a record that should carry exactly one
   * device at a time (plan 117 §3.8).
   *
   * Enforced the same way `capacity` is, in `apply.ts` rather than here.
   */
  exclusive: boolean
  /**
   * INTENT that a listener credential exists for this record, the same
   * discipline `enabled` already uses for "should a bridge be running" (§3.5
   * above, and plan 117 §3.5). The credential itself is never here — it is
   * the `proxy-auth:<id>` KV row (plan 117 §4.5).
   *
   * A record with `listenerAuth: true` and no such row is
   * `E_PROXY_LISTENER_AUTH_MISSING`; a non-loopback bind requires this to be
   * true at all (`E_PROXY_LISTENER_AUTH_REQUIRED`) — both enforced by
   * `validateProxyRecord` below, step 117.7.
   */
  listenerAuth: boolean
  notes: string
}

/** What the `logDestinations` switch means, in the plain words the form shows beside it. */
export const LOG_DESTINATIONS_HINT =
  'Records which hosts the traffic through this proxy reaches, for as long as it stays on. Off by default: destination ports and outcomes are always logged, hostnames only when you ask for them.'

/**
 * How many log lines a page asks for when the screen names no limit.
 *
 * The farm's own ring holds 2 000 lines per plugin, which is the ceiling this
 * can ever reach; 200 is what a first paint should carry, and `?cursor=` is how
 * a reader gets the rest.
 */
export const PROXY_LOGS_DEFAULT_LIMIT = 200

/**
 * What the Logs tab says about the stream, above the lines.
 *
 * **One ring, tagged per proxy — not one ring per proxy** (plan 112 §3.8, and
 * the substrate plan 109 step 109.8 built). N rings for N proxies would be core
 * memory that scales with a list an operator edits, and a deleted proxy would
 * take its own history away at exactly the moment somebody wanted to know why
 * it was deleted. The cost of the choice is stated rather than hidden: a busy
 * proxy evicts a quiet one's lines, and the page's own `truncated` flag is what
 * stops that reading as "this proxy did nothing".
 */
export const LOGS_SHARED_RING_NOTE =
  'One stream for every bridge this plugin runs, filtered to one proxy by the farm rather than by this screen. The farm keeps the most recent lines across all of them, so a busy proxy can push a quiet one’s lines out — when that has happened the page says so rather than showing a short list as if nothing had been logged.'

/**
 * What a log line records, and what it deliberately does not — the sentence an
 * operator reads before deciding whether this log is a surveillance record.
 *
 * It is a promise about the code, so it is declared here beside the switch it
 * describes and asserted against `logbook.ts`'s field allowlist in
 * `logbook.test.ts`, not merely written on a screen.
 */
export const LOGS_CONTENT_NOTE =
  'A line records the proxy, a connection number, what happened, how long it lasted, how many bytes each way and the destination port. It never records a hostname unless that record’s “log destinations” switch is on, and never a path, a query string, a header, a byte of payload, or the upstream’s username or password.'

/** The credential half of a record. One field, so the value is an object rather than a bare string — see `secretHintLeak`. */
export interface ProxySecret {
  password: string
}

// ---------------------------------------------------------------------------
// Reading a stored value — the read-time migration (plan 112 §4.3)
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function bool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

function port(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return value < min || value > max ? fallback : value
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((v) => v === value) ?? fallback
}

/**
 * A positive integer, or `fallback` — for `failover.failureThreshold` (plan
 * 121 §4.1), which has no upper bound: the owner runs a large, varied fleet
 * and a blanket ceiling would be guessing at a number nobody asked for (plan
 * 121 §9 Q2).
 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback
}

/**
 * A single upstream object from storage → `ProxyUpstream`, the same per-field
 * discipline `readProxyRecord`'s v2 branch already applied to the primary
 * `upstream` inline. Factored out (plan 121 §4.1) so `fallbackUpstreams` can
 * read every entry through the identical defaults, rather than a second copy
 * of this shape that could drift from the primary's.
 */
function readUpstream(value: unknown): ProxyUpstream {
  const upstream = asObject(value)
  return {
    proto: oneOf(PROXY_KINDS, upstream.proto, 'socks5'),
    host: str(upstream, 'host'),
    port: port(upstream.port) ?? 0,
    username: str(upstream, 'username'),
    bindAddress: str(upstream, 'bindAddress'),
    resolveThroughEgress: bool(upstream, 'resolveThroughEgress', true),
  }
}

/**
 * A stored value → the ordered backup-upstream list (plan 121 §4.1). Not an
 * array at all (absent, `null`, junk) reads as empty rather than throwing —
 * the same defensive-reader discipline `asObject` already applies to the
 * record as a whole, so a malformed `fallbackUpstreams` renders as "no
 * backups configured" instead of taking the row down.
 */
function readFallbackUpstreams(value: unknown): ProxyUpstream[] {
  return Array.isArray(value) ? value.map(readUpstream) : []
}

/** A stored value → `ProxyFailoverConfig`, defaulted the same defensive way (plan 121 §4.1). */
function readFailover(value: unknown): ProxyFailoverConfig {
  const source = asObject(value)
  return {
    failureThreshold: positiveInt(source.failureThreshold, 3),
    autoFailback: bool(source, 'autoFailback', true),
  }
}

/**
 * A stored value → a `ProxyRecord`, upgrading the shipped shape on the way.
 *
 * Three properties this has to have, and each one is a decision (plan 112 §4.3):
 *
 * 1. **A read-time upgrade, not a rewrite pass.** An old-shaped value is
 *    upgraded when it is read and written back only when the operator next
 *    saves that row. No boot-time loop over the namespace, so no partial-write
 *    hazard and nothing to resume after a crash halfway through.
 * 2. **`enabled: false` always, on the migration path.** A migration must never
 *    start a listener nobody asked to start.
 * 3. **`listen.port` is genuinely absent.** The shipped record described an
 *    upstream and named no local port; a guess would be a port the operator did
 *    not choose, bound on their machine, by an upgrade.
 *
 * It is also the defensive reader it always was: a KV namespace is the
 * plugin's own scratch space and an operator with `kv.manage` can put anything
 * under `proxy:`, so a junk value renders as blanks rather than throwing
 * inside a table row and taking the tab down through the error boundary.
 */
export function readProxyRecord(value: unknown): ProxyRecord {
  const source = asObject(value)
  const legacy = source.listen === undefined && source.upstream === undefined

  if (legacy) {
    // The shipped shape: `{ label, kind, host, port, notes }`, where `kind`
    // described the UPSTREAM ("the transport this proxy speaks"). It maps
    // without interpretation, which is why `PROXY_KINDS` is reused unchanged
    // as the upstream vocabulary rather than renamed.
    //
    // `bindAddress`, `resolveThroughEgress`, `capacity`, `exclusive` and
    // `listenerAuth` are plan 117 additions with no shipped-shape equivalent
    // at all — a row this old never named any of them — so they get their
    // plain defaults rather than anything read off `source`. `fallbackUpstreams`
    // and `failover` are plan 121's own additions, defaulted the same way.
    return {
      label: str(source, 'label'),
      listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: null },
      upstream: {
        proto: oneOf(PROXY_KINDS, source.kind, 'socks5'),
        host: str(source, 'host'),
        port: port(source.port) ?? 0,
        username: '',
        bindAddress: '',
        resolveThroughEgress: true,
      },
      fallbackUpstreams: [],
      failover: { failureThreshold: 3, autoFailback: true },
      enabled: false,
      logDestinations: false,
      maxConnections: DEFAULT_MAX_CONNECTIONS,
      drainMs: DEFAULT_DRAIN_MS,
      capacity: 0,
      exclusive: false,
      listenerAuth: false,
      notes: str(source, 'notes'),
    }
  }

  const listen = asObject(source.listen)
  return {
    label: str(source, 'label'),
    listen: {
      proto: oneOf(LISTEN_PROTOS, listen.proto, 'http'),
      bindHost: str(listen, 'bindHost', DEFAULT_BIND_HOST) || DEFAULT_BIND_HOST,
      port: port(listen.port),
    },
    upstream: readUpstream(source.upstream),
    // Plan 121 additions. A record written before this plan has neither key
    // at all, so `readFallbackUpstreams`/`readFailover` fall through to the
    // same defaults a brand-new record gets — the identical discipline the
    // plan 117 additions just below already established for this record.
    fallbackUpstreams: readFallbackUpstreams(source.fallbackUpstreams),
    failover: readFailover(source.failover),
    enabled: bool(source, 'enabled', false),
    logDestinations: bool(source, 'logDestinations', false),
    maxConnections: bounded(source.maxConnections, 1, 10_000, DEFAULT_MAX_CONNECTIONS),
    drainMs: bounded(source.drainMs, 0, 120_000, DEFAULT_DRAIN_MS),
    // Plan 117 additions, defaulted the same way for a pre-plan row and a
    // freshly read one — `bounded`/`bool` already treat an absent key as
    // "use the fallback", so there is no separate migration branch needed.
    capacity: bounded(source.capacity, 0, 1000, 0),
    exclusive: bool(source, 'exclusive', false),
    listenerAuth: bool(source, 'listenerAuth', false),
    notes: str(source, 'notes'),
  }
}

/**
 * The exact object a record is STORED as — the write half of `readProxyRecord`.
 *
 * One function rather than an object literal at the call site, so the two
 * halves cannot disagree: a screen that writes `{ hostname }` into a reader
 * that looks for `{ host }` renders blank cells forever, the write succeeds,
 * and nothing anywhere reports a fault. `index.test.ts` runs a value through
 * both and checks the round trip.
 */
/** One upstream → the exact object it is stored as — the write half of `readUpstream`, shared by the primary `upstream` and every entry of `fallbackUpstreams` (plan 121 §4.1). */
function writeUpstream(upstream: ProxyUpstream): Record<string, unknown> {
  return {
    proto: upstream.proto,
    host: upstream.host,
    port: upstream.port,
    username: upstream.username,
    bindAddress: upstream.bindAddress,
    resolveThroughEgress: upstream.resolveThroughEgress,
  }
}

export function writeProxyRecord(record: ProxyRecord): Record<string, unknown> {
  return {
    label: record.label,
    listen: { proto: record.listen.proto, bindHost: record.listen.bindHost, port: record.listen.port },
    upstream: writeUpstream(record.upstream),
    fallbackUpstreams: record.fallbackUpstreams.map(writeUpstream),
    failover: { failureThreshold: record.failover.failureThreshold, autoFailback: record.failover.autoFailback },
    enabled: record.enabled,
    logDestinations: record.logDestinations,
    maxConnections: record.maxConnections,
    drainMs: record.drainMs,
    capacity: record.capacity,
    exclusive: record.exclusive,
    listenerAuth: record.listenerAuth,
    notes: record.notes,
  }
}

// ---------------------------------------------------------------------------
// The probe — the observed public address, and the vocabulary for saying so
// honestly (plan 117 §3.7, §4.2, §4.5)
// ---------------------------------------------------------------------------

/**
 * What `service/probe.ts` records, per record, on an interval — dialling
 * `ENKAKU_NETWORK_PROBE_URL` through the record's own `Upstream`, the same
 * object its listener holds, so the probe exercises the bind and the resolver
 * rather than the listener socket the supervisor already reports on.
 *
 * `at` is unix SECONDS, the same unit `packages/probe-server`'s own `/probe`
 * response already uses for its `at` field — a plugin KV row rather than a DB
 * column, so 00-overview §4.2's second-vs-millisecond rule does not bind it,
 * but matching the endpoint it is measuring keeps one fewer unit conversion in
 * a place nothing checks it.
 */
export interface ProxyProbeResult {
  at: number
  ok: boolean
  publicAddress?: string
  latencyMs?: number
  error?: string
}

/**
 * The fixed reason recorded when `ENKAKU_NETWORK_PROBE_URL` is unset —
 * word-for-word the sentence `packages/core/src/network/route-checks.ts`
 * already uses for the identical fact about the identical env var, so an
 * operator reading either screen is not asked to notice that two sentences
 * mean the same thing.
 */
export const PROXY_PROBE_SKIP_REASON = 'no probe endpoint is configured (ENKAKU_NETWORK_PROBE_URL)'

/**
 * The three words a row's probe status can be, imported from plan 51 rather
 * than reinvented (§3.7): a record that has not passed a probe is
 * `unverified`, unconditionally — that covers both "never probed" and "the
 * last probe failed", because neither is a claim the public address is what
 * the operator thinks it is. `skip` is the other honest answer, for when there
 * is nothing to check at all. Only a passed probe is `confirmed`, and nothing
 * else on this list may be worded as one.
 */
export const PROXY_PROBE_STATES = ['unverified', 'skip', 'confirmed'] as const
export type ProxyProbeState = (typeof PROXY_PROBE_STATES)[number]

/** The plain word each state is written as — `confirmed` rather than `verified`/`ok`/`success`, so criterion 10's grep has nothing to catch even by substring. */
export const PROXY_PROBE_STATE_LABELS: Record<ProxyProbeState, string> = {
  unverified: 'Unverified',
  skip: 'Not checked',
  confirmed: 'Confirmed',
}

/**
 * A stored (or absent) probe result → the state a row reads. `null` — no
 * `proxy-probe:<id>` row has ever been written for this record — reads
 * `unverified` for the same reason a failed probe does: neither is evidence
 * the public address is what it should be.
 */
export function proxyProbeState(probe: ProxyProbeResult | null): ProxyProbeState {
  if (probe === null) return 'unverified'
  if (probe.ok) return 'confirmed'
  return probe.error === PROXY_PROBE_SKIP_REASON ? 'skip' : 'unverified'
}

/**
 * A stored KV value → a `ProxyProbeResult`, defensively — the same discipline
 * `readProxyRecord` above uses: this namespace is the plugin's own scratch
 * space, and a junk value under `proxy-probe:` must render as "nothing known"
 * rather than throw inside the row it would otherwise sit on.
 */
export function readProxyProbe(value: unknown): ProxyProbeResult | null {
  const source = asObject(value)
  if (typeof source.at !== 'number' || typeof source.ok !== 'boolean') return null
  const result: ProxyProbeResult = { at: source.at, ok: source.ok }
  if (typeof source.publicAddress === 'string') result.publicAddress = source.publicAddress
  if (typeof source.latencyMs === 'number') result.latencyMs = source.latencyMs
  if (typeof source.error === 'string') result.error = source.error
  return result
}

// ---------------------------------------------------------------------------
// Validation — the coded refusals (plan 112 §4.2)
// ---------------------------------------------------------------------------

/**
 * A refusal is a **choice the product will not honour** — it is reported at
 * write, before a record is stored, so an operator learns about it in a form
 * and not as a 502 inside an app on a phone.
 *
 * A precondition is a **fact that is not true yet** — the record is perfectly
 * storable, it simply cannot start. Plan 59's rule: a precondition disables
 * the control and says what is missing; it is never rendered as an error.
 */
export type ProxyProblemKind = 'refusal' | 'precondition'

export interface ProxyProblem {
  code: string
  kind: ProxyProblemKind
  /** Operator-facing, and it names what to do instead — never only what went wrong. */
  message: string
}

/**
 * Everything this pack can say about a record, as a closed list, so a screen
 * can switch on it. Most come from `validateProxyRecord` (may this record be
 * stored, and may it be started); two from `routeForRecord` in HTTP mode (may
 * this record be applied to a device — plan 114 step 114.9); the rest from its
 * VPN mode and from `vpnAgentProblem`. One list rather than four, because a
 * screen showing "why can I not press this" does not care which function
 * decided — not a fixed count per source, because a source gaining a code
 * (plan 117 §4.2 added four) must not force this comment to be recounted
 * correctly by hand.
 *
 * **Every VPN code names the thing that is actually wrong.** A single
 * `E_PROXY_VPN_NOT_APPLICABLE` covering all four would send an operator whose
 * phone has no guest agent to go and edit the record's upstream.
 */
export const PROXY_PROBLEM_CODES = [
  'E_PROXY_LISTEN_UNSUPPORTED',
  'E_PROXY_UPSTREAM_UNSUPPORTED',
  'E_PROXY_PORT_CONFLICT',
  'E_PROXY_PORT_UNASSIGNED',
  'E_PROXY_NOT_APPLICABLE',
  'E_PROXY_NOT_RUNNING',
  'E_PROXY_VPN_UPSTREAM_NOT_SOCKS5',
  'E_PROXY_VPN_UPSTREAM_INCOMPLETE',
  'E_PROXY_VPN_NO_PASSWORD',
  'E_PROXY_AGENT_NOT_READY',
  'E_PROXY_AGENT_UNSUPPORTED',
  // Plan 117 §4.2, step 117.4.
  'E_PROXY_BIND_ADDRESS_INVALID',
  'E_PROXY_BIND_ADDRESS_UNAVAILABLE',
  // Plan 117 §4.2, step 117.7. `E_PROXY_BIND_NOT_LOOPBACK` is RETIRED, not kept
  // alongside these (00-overview §4.3: replace, never version) — its premise
  // ("no listener authentication exists") stopped being true the moment
  // `service/auth.ts` shipped, so the code that named it would now be lying.
  // `E_PROXY_LISTENER_AUTH_REQUIRED` is the same rule, conditional on its own
  // premise; `E_PROXY_LISTENER_AUTH_MISSING` is the precondition beside it.
  'E_PROXY_LISTENER_AUTH_REQUIRED',
  'E_PROXY_LISTENER_AUTH_MISSING',
  // Plan 117 §4.2, step 117.8. The two below the first were found by 117.8's own
  // worker and added rather than left as notes: each names a record that VPN
  // mode would accept and the GUEST AGENT would then fail on, with nothing on
  // any screen saying why. A refusal an operator can read beats a dial that
  // dies somewhere they cannot see.
  'E_PROXY_VPN_BIND_UNSPECIFIED',
  'E_PROXY_VPN_LISTEN_NOT_SOCKS5',
  'E_PROXY_VPN_BIND_LOOPBACK',
  // Plan 117 §4.2, step 117.10. It waited until this line for the reason the
  // comment it replaces gave — a code with no producer is a promise the row
  // cannot keep — and `apply.ts`'s capacity guard is now that producer.
  'E_PROXY_CAPACITY_FULL',
  // Plan 118 §4.2, step 118.2. The confirmed gap: a record's `listen.port` is
  // edited while its bridge is `Running`, and a running bridge does not
  // restart itself to pick up the new port — only Stop→Start (or Restart)
  // does. `applyAssignment`'s HTTP-mode guard is this code's producer,
  // comparing `record.listen.port` against the supervisor's own live
  // listener port (`ApplyHost.bridgePort`) before naming a port to
  // `device.network.set`, the same "producer lives in `apply.ts`, not in the
  // three pure functions" shape `E_PROXY_CAPACITY_FULL` above already
  // established — see that entry's own comment.
  'E_PROXY_PORT_MISMATCH',
  // Plan 123 §4.3, step 123.3. `bindIsEffective()` (`service/bind-probe.ts`)
  // measured that this runtime silently drops `direct`'s `bindAddress`, and
  // the local `gost` workaround (`service/gost-runtime.ts`) is not reachable
  // either — both facts only an actual probe and an actual attempt can
  // answer, which is why this is a PRECONDITION rather than a REFUSAL (§3.3):
  // nothing about the record is wrong, and the fact can change (a runtime
  // upgrade, or a provisioned `gost`). `service/upstream.ts`'s own header
  // names the producer: `createUpstream` throwing this code, caught by
  // `service/supervisor.ts`'s `startLocked`, which re-validates with
  // `bindWorkaroundUnavailable: true` so the record is refused through this
  // SAME `problems` mechanism rather than the generic dial-failure catch.
  'E_PROXY_BIND_INEFFECTIVE',
] as const
export type ProxyProblemCode = (typeof PROXY_PROBLEM_CODES)[number]

/** The other records `validateProxyRecord` needs to see to answer `E_PROXY_PORT_CONFLICT`. */
export interface ProxyCatalogueEntry {
  id: string
  record: ProxyRecord
}

/**
 * Whether `text` is a literal IPv4 or IPv6 address — hand-rolled rather than
 * `node:net`'s `net.isIP()`, because this file imports nothing (its own
 * header explains why: the browser half loads it too). `service/dial-direct.ts`
 * asks the SAME question with the real `net.isIP()` at connect time, once a
 * record has already passed this check; the two are not one function calling
 * the other, they are two implementations of one rule that has to hold in
 * both places, the same discipline `PROXY_STATES`' own doc comment names for
 * the five-word vocabulary above.
 *
 * Not a full RFC 5952 parser — a string that passes this and is not really
 * routable fails loudly at `net.connect` (or at the resolver, for `service/
 * dial-direct.ts`'s bound lookup) rather than being silently accepted as a
 * hostname to look up instead.
 */
const IPV4_LITERAL = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6_LITERAL =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/

function isIpLiteral(text: string): boolean {
  return IPV4_LITERAL.test(text) || IPV6_LITERAL.test(text)
}

/**
 * The one function that decides whether a record may run, called at **write**
 * time by the screen and again at **start** time by the supervisor — never
 * only at start, or a record edited around the UI would bind anyway.
 *
 * Returns every problem it finds rather than the first, because a form that
 * reports one error at a time makes an operator submit four times.
 */
export function validateProxyRecord(
  record: ProxyRecord,
  context: {
    id?: string
    catalogue?: readonly ProxyCatalogueEntry[]
    /**
     * Every address this HOST currently holds — `Object.values(os.networkInterfaces())`,
     * flattened to the address strings. **Deliberately not read by this
     * function**: `os.networkInterfaces()` is a Node call and this file
     * imports nothing, so the lookup happens wherever the caller can perform
     * it (the service, at start time) and is handed in rather than reached
     * for. Three-valued the same way `hasPassword` already is on
     * `ProxyRouteContext` (§4.5 above): `undefined` means "nobody looked" —
     * the browser half genuinely cannot call `os.networkInterfaces()` — and
     * must never be read as "this host holds nothing".
     */
    hostAddresses?: readonly string[]
    /**
     * Whether a `proxy-auth:<id>` row actually exists for this record, for
     * `E_PROXY_LISTENER_AUTH_MISSING` (plan 117 §3.5, §4.2). Three-valued for
     * the same reason `hostAddresses` and `hasPassword` (on `ProxyRouteContext`)
     * already are: reading a secret row is a KV call this file cannot make —
     * it imports nothing — so `undefined` means *nobody looked*, which is the
     * browser half's honest answer, and must never be turned into a refusal it
     * cannot justify. `false` means *looked, and there is none*.
     */
    hasListenerAuth?: boolean
    /**
     * Whether THIS host's runtime can actually honour `direct`'s
     * `bindAddress` — plan 123 §4.3. Answering it needs an actual socket
     * probe (`bindIsEffective()`, `service/bind-probe.ts`) and, only if that
     * probe finds the bind broken, an actual attempt at the local `gost`
     * workaround (`service/upstream.ts`) — both are Node-only, real I/O this
     * file cannot perform (it imports nothing) and the browser half
     * structurally cannot perform either. Three-valued for the same reason
     * `hostAddresses` and `hasListenerAuth` already are: `undefined` means
     * *nobody looked*, and must never be turned into a refusal it cannot
     * justify. Only `true` — bind measurably broken AND no `gost` workaround
     * reachable on this host — blocks a start; `false` and `undefined` both
     * raise nothing.
     */
    bindWorkaroundUnavailable?: boolean
  } = {},
): ProxyProblem[] {
  const problems: ProxyProblem[] = []

  if (record.listen.proto === 'https') {
    problems.push({
      code: 'E_PROXY_LISTEN_UNSUPPORTED',
      kind: 'refusal',
      message:
        'An HTTPS listener would have to terminate TLS, which needs a certificate this farm has no way to issue, install, or rotate for a plugin. ' +
        `A bridge binds ${DEFAULT_BIND_HOST} and has no network segment to be eavesdropped on, so this is not the gap it sounds like. Use HTTP or SOCKS5.`,
    })
  }

  if (record.upstream.proto === 'https') {
    problems.push({
      code: 'E_PROXY_UPSTREAM_UNSUPPORTED',
      kind: 'refusal',
      message:
        'An HTTPS upstream — an HTTP proxy reached over TLS — is not implemented. It is one `tls.connect` away from working and is refused only because ' +
        'no case for it has been named, and an untested path that carries a password is worse than an honest refusal. Use SOCKS5 or HTTP.',
    })
  }

  /**
   * `direct`'s own two checks (plan 117 §3.1, §3.4, §4.2). `bindAddress` may
   * be empty — that is the "dial out however this host normally would" case
   * (§3.1 point 1) and there is nothing to validate about it. Once it is
   * non-empty, two different questions apply, and they are two different
   * KINDS of problem for the same reason `E_PROXY_PORT_UNASSIGNED` is a
   * precondition next to `E_PROXY_LISTENER_AUTH_REQUIRED`'s refusal a few
   * lines down: a malformed address is never storable — no fact about this
   * host or
   * any other could make `"not-an-ip"` valid — but an address this host
   * merely does not hold RIGHT NOW could exist a minute from now (a NIC
   * plugged in, a route added), so it blocks a start and not a save.
   */
  if (record.upstream.proto === 'direct' && record.upstream.bindAddress.length > 0) {
    if (!isIpLiteral(record.upstream.bindAddress)) {
      problems.push({
        code: 'E_PROXY_BIND_ADDRESS_INVALID',
        kind: 'refusal',
        message: `"${record.upstream.bindAddress}" is not an IPv4 or IPv6 address. A bind address names one of this host's own addresses literally — net.connect's localAddress takes no hostname and no interface name — so write the address itself, for example 192.168.100.11 or 2001:db8::11.`,
      })
    } else if (context.hostAddresses !== undefined && !context.hostAddresses.some((addr) => addr === record.upstream.bindAddress)) {
      problems.push({
        code: 'E_PROXY_BIND_ADDRESS_UNAVAILABLE',
        kind: 'precondition',
        message: `This host does not currently hold the address ${record.upstream.bindAddress}. The record is stored exactly as written — nothing here changes what you typed — but it cannot start until this machine has that address, whether that means plugging in a link, bringing up an interface, or fixing a typo.`,
      })
    }

    /**
     * Plan 123 §3.3/§4.3. Deliberately a SEPARATE check from the two above,
     * not an `else if` on them: this is a different axis (does the RUNTIME
     * honour a bind this host genuinely holds), decided by an actual probe
     * rather than by anything readable off the record. `bindWorkaroundUnavailable`
     * is `true` only once BOTH facts are measured — bind broken, no `gost`
     * reachable — so this never fires ahead of the cheaper, sync checks
     * above finding a more basic problem first (`service/supervisor.ts`'s
     * `startLocked` does not even attempt the probe until those pass).
     */
    if (context.bindWorkaroundUnavailable === true) {
      problems.push({
        code: 'E_PROXY_BIND_INEFFECTIVE',
        kind: 'precondition',
        message: `This host does hold ${record.upstream.bindAddress} — that part is fine. The runtime this build is running on silently ignores the bind when it dials out (a known upstream limitation, not a bug in this record), so a "direct" upstream would egress from this machine's default address instead, without saying so. No local gost workaround is available to cover that on this platform yet. Until a runtime upgrade fixes this, point this record's upstream at a local SOCKS5 or HTTP proxy that IS known to honour the bind — for example gost or 3proxy, bound to ${record.upstream.bindAddress} on a loopback port — instead of "direct".`,
      })
    }
  }

  /**
   * The loopback rule, made conditional on its own premise (plan 117 §3.5).
   * It is not relaxed: a proxy with no authentication of its own, reachable
   * off-host, is still an open relay — anyone who can route a packet to it
   * spends the operator's upstream account. What changed is that an
   * authenticated bridge is no longer the same proxy that premise describes,
   * so the refusal is now conditional on whether one exists, rather than
   * unconditional.
   *
   * Two separate facts, two separate codes:
   *
   * - `E_PROXY_LISTENER_AUTH_REQUIRED` — a refusal, decidable from the record
   *   alone (`listenerAuth` is a plain field, not a secret, so both halves
   *   always know it): a non-loopback bind with no intent to authenticate at
   *   all is the open relay the premise names, and is never storable.
   * - `E_PROXY_LISTENER_AUTH_MISSING` — a precondition, decidable only with
   *   `context.hasListenerAuth`: `listenerAuth` says a credential should
   *   exist, but the `proxy-auth:<id>` row it names does not (yet, or any
   *   more). The record IS storable — turning the intent on and saving the
   *   credential are two separate acts, same as `hasPassword`'s VPN
   *   equivalent — but it cannot start until both are true, wherever the bind
   *   host ends up: a record that means to authenticate and cannot is not a
   *   fact this pack may pretend not to notice just because the bind happens
   *   to be loopback today.
   */
  if (!LOOPBACK_BIND_HOSTS.some((h) => h === record.listen.bindHost) && !record.listenerAuth) {
    problems.push({
      code: 'E_PROXY_LISTENER_AUTH_REQUIRED',
      kind: 'refusal',
      message:
        `A bridge may only bind ${LOOPBACK_BIND_HOSTS.join(' or ')} unless it has a listener credential saved. A proxy with no authentication of its own, reachable off-host, is an open relay: ` +
        'anyone who can route a packet to it spends your upstream account. Turn on listener authentication and save a username and password for this record first, or bind loopback instead — ' +
        'a device does not need an off-host bind (it gets 127.0.0.1 on the device itself, over the adb connection that already exists); a remote person uses an SSH or WireGuard tunnel, as for any other loopback service.',
    })
  }

  if (record.listenerAuth && context.hasListenerAuth === false) {
    problems.push({
      code: 'E_PROXY_LISTENER_AUTH_MISSING',
      kind: 'precondition',
      message:
        'Listener authentication is turned on for this record, but no username and password are saved for it yet. The record is stored exactly as written — nothing here changes what you typed — ' +
        'but it cannot start until a credential is saved: an "authenticate" switch with nothing behind it would either refuse every client or, worse, accept anyone, and neither is what turning it on asked for.',
    })
  }

  if (record.listen.port === null) {
    problems.push({
      code: 'E_PROXY_PORT_UNASSIGNED',
      kind: 'precondition',
      message: 'This record needs a local port to listen on. It was migrated from a shape that named only the upstream, and guessing a port to open on your machine would be worse than asking.',
    })
  } else {
    const clash = (context.catalogue ?? []).find((other) => other.id !== context.id && other.record.enabled && other.record.listen.port === record.listen.port)
    if (clash) {
      problems.push({
        code: 'E_PROXY_PORT_CONFLICT',
        kind: 'refusal',
        message: `Port ${record.listen.port} is already claimed by the enabled record “${clash.record.label || clash.id}”. Two bridges cannot bind the same port; give this one another, or disable that one.`,
      })
    }
  }

  return problems
}

/** Whether every refusal is clear — a record that may be STORED. Preconditions do not block a write. */
export function isStorableRecord(problems: readonly ProxyProblem[]): boolean {
  return !problems.some((p) => p.kind === 'refusal')
}

/** Whether a record may be STARTED. Both kinds block a start. */
export function isStartableRecord(problems: readonly ProxyProblem[]): boolean {
  return problems.length === 0
}

// ---------------------------------------------------------------------------
// Reading a proxy the way a vendor handed it over (the owner's second complaint)
// ---------------------------------------------------------------------------

/**
 * The owner's own words: *"terus ga ada opsi pattern url proxy kah biar ga
 * input manual satu persatu … tapi opsi input satu persatu juga tetap ada
 * gitu"* — a paste box **beside** the field-by-field inputs, not instead of
 * them.
 *
 * ## Why this is hand-written and not `new URL()`
 *
 * Studio's own `parseSocks5Url` and `parseHttpProxyUrl`
 * (`packages/studio/src/components/guest-agent/`) use `new URL()`, and this
 * pack borrows their vocabulary — `host`, `port`, `username`, `password`, a
 * refusal that carries its reason rather than a bare `null` — without borrowing
 * their implementation, for two reasons that are not stylistic:
 *
 * 1. **`new URL()` needs a scheme**, and three of the four shapes below have
 *    none. It is also the wrong splitter for a raw credential: it splits
 *    userinfo at the FIRST `:` and the LAST `@` of its own accord, but a
 *    password holding an unencoded `@` or `:` — which is what a provider's
 *    generated password routinely holds — goes through the URL parser as part
 *    of a hostname and comes out as a different proxy rather than as an error.
 * 2. **The pack is bundled separately** (`enkaku publish` inlines everything it
 *    imports), so importing from Studio is not available even where it would be
 *    right.
 *
 * ## The four shapes, and the rule that makes the ambiguous one predictable
 *
 * `a:b:c:d` genuinely is ambiguous — `host:port:user:pass`, or a password with
 * colons in it? — and the answer here is a rule stated on screen rather than a
 * guess: **the second field must be a port number.** A numeric second field is
 * the strong signal the ambiguity note asks for; a non-numeric one is refused
 * by name instead of being read as something else. Everything after the fourth
 * field belongs to the password, so a password with colons still works in the
 * colon form as long as it is last. Three fields are refused outright rather
 * than guessed.
 *
 * And nothing here is trusted to be right: `parseProxyList` is a preview, and
 * the screen shows every line as it was read — with the password masked — for
 * the operator to correct before anything is written. A parse somebody can see
 * beats a cleverer one they cannot.
 */

/** The four shapes, in the order the paste box lists them. */
export const PROXY_PASTE_FORMATS = ['scheme://username:password@host:port', 'username:password@host:port', 'host:port:username:password', 'host:port'] as const

/** The schemes a pasted line may name, and what each is read as. */
export const PROXY_PASTE_SCHEMES: Record<string, ProxyKind> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
}

/** The ambiguity rule, in the words the operator reads directly above the box. */
export const PROXY_PASTE_RULE =
  'Everything after the LAST “@” is the address; in front of it, everything after the FIRST “:” is the password. So a password may contain “:” and “@”, and a username may contain neither. ' +
  'With no “@”, the line is split on “:” and the second field must be a port number: two fields are host and port, four are host, port, username and password, and anything after the fourth “:” is still password. ' +
  'Three fields are refused rather than guessed. Wrap an IPv6 address in brackets — [2001:db8::1]:1080. A line starting with “#” is skipped, and so is a blank one.'

/** What the preview promises about itself, above the parsed rows. */
export const PROXY_PASTE_PREVIEW_NOTE =
  'Nothing is saved until you press the button below. Every line is shown as it was read, and a password is never shown — only whether one was found. A line that named no scheme is read as the upstream type you chose; each record gets a name and a free local port you can change here before it is created.'

/** The one-line version, for the paste field inside the Add dialog. */
export const PROXY_PASTE_SINGLE_HINT = 'Paste a proxy the way your provider wrote it and these fields fill themselves. Nothing is saved until you press Save, and the fields stay editable by hand.'

/** What a masked password reads as, everywhere in this pack's own UI. */
export const PASSWORD_MASK = '••••••'

/**
 * The local port a bulk paste starts looking from.
 *
 * 9902 is the owner's own — the port in `gost -L "http://:9902"` in plan 112
 * §0's evidence — so a first paste on a farm with nothing on it lands where
 * their muscle memory already is. Ports already claimed by a record, or by an
 * earlier line in the same paste, are skipped.
 */
export const DEFAULT_LOCAL_PORT_BASE = 9902

/** The first port at or above `from` that nothing in `taken` claims. */
export function nextFreeLocalPort(taken: Iterable<number>, from: number = DEFAULT_LOCAL_PORT_BASE): number {
  const used = new Set(taken)
  let port = from < 1 ? DEFAULT_LOCAL_PORT_BASE : from
  while (port <= 65_535 && used.has(port)) port += 1
  return port > 65_535 ? 65_535 : port
}

/** One proxy, as a pasted line describes it. This is NOT a record: it names no local port, and the screen assigns that. */
export interface ParsedProxy {
  proto: ProxyKind
  host: string
  port: number
  username: string
  password: string
  /** Whether the line named a scheme. When it did not, `proto` is the caller's default and the preview says so. */
  schemeGiven: boolean
  /** Which shape matched, so the preview can say how the line was read rather than only what came out. */
  form: 'userinfo' | 'host-port' | 'host-port-user-pass'
}

/**
 * A refusal carries its reason, the way Studio's `HttpProxyPaste` does rather
 * than the way `parseSocks5Url`'s bare `null` does — an operator told only
 * "no" about a string they already have concludes the screen is broken.
 *
 * **No reason ever quotes any part of the line.** A password can be anywhere in
 * a malformed one, so a message that echoed "the offending field" would be the
 * one place in this pack a credential reached a screen, a toast, or somebody's
 * shoulder. The reasons name the RULE that was broken and the position it was
 * broken at, and nothing else.
 */
export type ProxyParseResult = { ok: true; proxy: ParsedProxy } | { ok: false; reason: string }

function parsePastedPort(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65_535 ? port : null
}

/**
 * `%40` → `@`, but only for a line that named a scheme.
 *
 * Percent-encoding is URL syntax, so decoding a schemeless `user:p%3Ass@host:1`
 * would silently change a password that legitimately contains a `%`. Studio's
 * `parseSocks5Url` decodes because everything it accepts is a URL; this
 * function is called on exactly the same condition.
 */
function decodeIfEncoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** `host:port`, or `[v6]:port`. Returns a reason rather than throwing, and quotes nothing. */
function splitAuthority(text: string): { host: string; port: number } | { reason: string } {
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close === -1) return { reason: 'an IPv6 address opened with “[” and never closed it' }
    const host = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (host.length === 0) return { reason: 'the brackets hold no address' }
    if (!rest.startsWith(':')) return { reason: 'no port after the bracketed address — write [address]:port' }
    const port = parsePastedPort(rest.slice(1))
    if (port === null) return { reason: 'what follows the bracketed address is not a port number between 1 and 65535' }
    return { host, port }
  }
  const cut = text.lastIndexOf(':')
  if (cut <= 0) return { reason: 'no port — an address is host:port' }
  const host = text.slice(0, cut)
  if (host.includes(':')) return { reason: 'this looks like an IPv6 address; wrap it in brackets — [2001:db8::1]:1080' }
  if (/\s/.test(host)) return { reason: 'the host has a space in it' }
  const port = parsePastedPort(text.slice(cut + 1))
  if (port === null) return { reason: 'what follows the last “:” is not a port number between 1 and 65535' }
  return { host, port }
}

/** The colon form, once a bracketed host (if any) has been lifted out. `fields[0]` is the host. */
function fromColonFields(fields: readonly string[], proto: ProxyKind, schemeGiven: boolean): ProxyParseResult {
  const host = fields[0] ?? ''
  if (host.length === 0) return { ok: false, reason: 'the line starts with “:” — there is no host' }
  if (/\s/.test(host)) return { ok: false, reason: 'the host has a space in it' }
  if (fields.length === 1) return { ok: false, reason: 'no port — write host:port, or host:port:username:password' }
  const port = parsePastedPort(fields[1] ?? '')
  if (port === null) {
    return {
      ok: false,
      reason: 'the second field is not a port number between 1 and 65535. With no “@” in the line, the second field is always the port — write user:pass@host:port instead if the account comes first',
    }
  }
  if (fields.length === 2) return { ok: true, proxy: { proto, host, port, username: '', password: '', schemeGiven, form: 'host-port' } }
  if (fields.length === 3) {
    return {
      ok: false,
      reason: 'three colon-separated fields could be host:port:username with no password, or a password with a “:” in it and no username, and guessing between them would be worse than asking. Write host:port:username:password, or username:password@host:port',
    }
  }
  return { ok: true, proxy: { proto, host, port, username: fields[2] ?? '', password: fields.slice(3).join(':'), schemeGiven, form: 'host-port-user-pass' } }
}

/**
 * One line → one proxy, or one reason it is not one.
 *
 * `defaultProto` is what a line with no scheme is read as. It is the caller's,
 * not a constant here, because the paste box sits beside an "Upstream type"
 * selector and the operator's choice there is the honest default — and the
 * preview says which lines used it.
 */
export function parseProxyLine(line: string, opts: { defaultProto?: ProxyKind } = {}): ProxyParseResult {
  const text = line.trim()
  if (text.length === 0) return { ok: false, reason: 'the line is empty' }

  let rest = text
  let proto: ProxyKind = opts.defaultProto ?? 'socks5'
  let schemeGiven = false

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest)
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase()
    const mapped = PROXY_PASTE_SCHEMES[name]
    if (mapped === undefined) {
      return { ok: false, reason: `that scheme is not a transport this pack speaks. Use ${Object.keys(PROXY_PASTE_SCHEMES).join('://, ')}://, or leave the scheme off` }
    }
    proto = mapped
    schemeGiven = true
    rest = rest.slice(scheme[0].length)
  }

  // A proxy address is an authority and nothing else. A trailing `/` is
  // tolerated because a browser's address bar adds one; a path, a query or a
  // fragment is refused, because it means the operator pasted something else.
  const stop = rest.search(/[/?#]/)
  if (stop !== -1) {
    if (rest.slice(stop).replace(/[/?#]/g, '').length > 0) return { ok: false, reason: 'a proxy address is a host and a port — this line carries a path, a query or a fragment as well' }
    rest = rest.slice(0, stop)
  }
  if (rest.length === 0) return { ok: false, reason: 'the line names a scheme and no address' }

  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    const creds = rest.slice(0, at)
    const cut = creds.indexOf(':')
    const username = cut === -1 ? creds : creds.slice(0, cut)
    const password = cut === -1 ? '' : creds.slice(cut + 1)
    if (username.length === 0 && password.length === 0) return { ok: false, reason: 'there is an “@” with no account in front of it' }
    if (/\s/.test(creds)) return { ok: false, reason: 'the account has a space in it' }
    const addr = splitAuthority(rest.slice(at + 1))
    if ('reason' in addr) return { ok: false, reason: addr.reason }
    return {
      ok: true,
      proxy: {
        proto,
        host: addr.host,
        port: addr.port,
        username: schemeGiven ? decodeIfEncoded(username) : username,
        password: schemeGiven ? decodeIfEncoded(password) : password,
        schemeGiven,
        form: 'userinfo',
      },
    }
  }

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) return { ok: false, reason: 'an IPv6 address opened with “[” and never closed it' }
    const host = rest.slice(1, close)
    const tail = rest.slice(close + 1)
    if (host.length === 0) return { ok: false, reason: 'the brackets hold no address' }
    if (!tail.startsWith(':')) return { ok: false, reason: 'no port after the bracketed address — write [address]:port' }
    return fromColonFields([host, ...tail.slice(1).split(':')], proto, schemeGiven)
  }

  return fromColonFields(rest.split(':'), proto, schemeGiven)
}

/** One line of a paste, as the preview lists it. `line` is 1-based, the way an operator counts them in the box. */
export interface ProxyPasteLine {
  line: number
  /** The line, ALREADY MASKED (`maskProxyLine`) — a preview must be safe to render, not safe only if the renderer remembers. */
  masked: string
  result: ProxyParseResult
}

/**
 * A password, hidden, in a string the operator still has to be able to fix.
 *
 * A line that failed to parse has to be shown back or it cannot be corrected,
 * and a line that failed to parse may still hold a credential — the two are not
 * exclusive, and the failing case (`user:pass@host` with no port) is exactly the
 * case that does. So the masking is structural rather than a judgement about
 * whether this particular line looks dangerous: whatever sits where a password
 * sits is replaced, in both credential-carrying shapes, before the string
 * reaches a caller at all.
 */
export function maskProxyLine(text: string): string {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(text)
  const prefix = scheme ? scheme[0] : ''
  const rest = text.slice(prefix.length)
  const at = rest.lastIndexOf('@')
  if (at !== -1) {
    const creds = rest.slice(0, at)
    const cut = creds.indexOf(':')
    if (cut === -1) return text
    return `${prefix}${creds.slice(0, cut)}:${PASSWORD_MASK}@${rest.slice(at + 1)}`
  }
  const fields = rest.split(':')
  if (fields.length >= 4) return `${prefix}${fields.slice(0, 3).join(':')}:${PASSWORD_MASK}`
  return text
}

/**
 * A whole paste → one entry per line that was not blank and not a comment.
 *
 * Blank lines and `#` comments are dropped rather than reported: a list copied
 * out of a provider's mail has both, and reporting them as failures would bury
 * the line that genuinely did not parse.
 */
export function parseProxyList(text: string, opts: { defaultProto?: ProxyKind } = {}): ProxyPasteLine[] {
  const out: ProxyPasteLine[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim()
    if (raw.length === 0 || raw.startsWith('#')) continue
    out.push({ line: i + 1, masked: maskProxyLine(raw), result: parseProxyLine(raw, opts) })
  }
  return out
}

/**
 * What a parsed line is called, when the operator has not renamed it.
 *
 * The account, when there is one, and the host when there is not — because a
 * provider's list is usually one host and many accounts (the owner's own
 * `country-id-rxxxxxxx` encodes the exit country and the session), so naming
 * every row after the host would produce twenty records called the same thing
 * and twenty suffixed keys. The name is editable in the preview either way.
 */
export function suggestProxyName(proxy: ParsedProxy): string {
  return proxy.username || proxy.host
}

// ---------------------------------------------------------------------------
// Applying a record to a device (plan 114 §3.3, step 114.9)
// ---------------------------------------------------------------------------

/**
 * The two modes Apply offers, from ONE catalogue entry (the owner's own ask:
 * *"apply di setting proxy manager juga harusnya ada 2 pilihan dong, apply
 * sebagai vpn mode atau sebagai http proxy mode"*).
 *
 * They are not two names for one thing, and `PROXY_APPLY_MODE_DESCRIPTIONS`
 * below is what says so at the point of choice — plan 114 §3.1 rule 1.
 */
export const PROXY_APPLY_MODES = ['http', 'vpn'] as const
export type ProxyApplyMode = (typeof PROXY_APPLY_MODES)[number]

/** What each mode is called, in the device's own vocabulary rather than an engine id. */
export const PROXY_APPLY_MODE_LABELS: Record<ProxyApplyMode, string> = {
  http: 'HTTP proxy',
  vpn: 'VPN',
}

/**
 * The two route shapes this pack can ask the built-in for — one per mode — and
 * why the second one is reachable at all.
 *
 * **HTTP proxy — the bridge, over `adb reverse`.** A bridge binds **loopback on
 * the farm's own machine** (`LOOPBACK_BIND_HOSTS`, and plan 112 §3.9 refuses
 * anything else by name). A phone cannot dial the farm's loopback — so pointing
 * a device at a *bridge* means plan 114's **rung 2**: `adb reverse` carries the
 * phone's own `127.0.0.1:<devicePort>` back to this machine, and the phone's own
 * system proxy setting is pointed at that. That is `adb-reverse-proxy`, and
 * `hostPort` is the record's own `listen.port`. The account never leaves the
 * farm, and an app with its own networking can ignore the whole arrangement.
 *
 * **VPN — the thing that actually performs the egress, with no bridge dial
 * involved for a vendor record.** This doc block used to argue that this pack
 * could never apply the enforcing rung, on the grounds that *"`vpn-helper`
 * needs a SOCKS5 upstream the guest agent dials from the device; a loopback
 * bridge is not one"*. **That reasoning is right about the bridge and wrong
 * about the record**, and it is corrected here rather than left asserting
 * something the code no longer does. A record holds two addresses, not one:
 * the bridge it *listens* on, and the upstream it *tunnels through*. For a
 * vendor record the second one is a real, routable SOCKS5 endpoint with a
 * host, a port, a username and (since 0.5.1) a stored password — which is
 * exactly what the guest agent needs to dial. So VPN mode hands the built-in
 * `{ engine: 'vpn-helper', host, port, username, password }` built from
 * `record.upstream`, the bridge is bypassed entirely, and the record does not
 * even have to be enabled.
 *
 * **A `direct` record has no such upstream — plan 117 §3.6 — because THIS
 * FARM is the egress**, not something reached through it. There is nothing
 * for the phone to dial except the record's own bridge, so for `direct` the
 * route names *that* instead: `{ engine: 'vpn-helper', host: listen.bindHost,
 * port: listen.port, username, password }`, built by `directVpnRouteForRecord`
 * below. This is not a special case bolted on; it is the same rule the vendor
 * branch already follows — *the route names whatever performs the egress* —
 * applied to a record where that happens to be here rather than somewhere
 * else. Because the phone now dials THIS bridge, the bridge has to be one it
 * can actually reach: `validateProxyRecord`'s bind gate (§3.5,
 * `E_PROXY_LISTENER_AUTH_REQUIRED`/`_MISSING`) is what makes a non-loopback
 * bind on this pack possible at all, and a wildcard bind is refused here too
 * (`E_PROXY_VPN_BIND_UNSPECIFIED`) because it names no address the phone could
 * dial.
 *
 * Nothing about that widens what the HTTP mode does. The two modes carry
 * different traffic through different paths and are described to the operator
 * separately (`APPLY_RUNG_SENTENCE` and `APPLY_VPN_SENTENCE`), because the trade
 * runs in both directions: VPN cannot be opted out of, and VPN is the only one
 * of the two that sends a credential to the phone. For a `direct` record that
 * credential is now the record's own **listener** credential rather than an
 * upstream account — which does not soften the cost, it changes what one
 * recovered credential is worth: a listener credential is per record (§3.5),
 * so one recovered from a phone opens the one egress behind that bridge, and
 * rotating it is a single row.
 *
 * `password` (and, for `direct`, `username`) are on the type but are **never
 * populated here**. `routeForRecord` runs in the browser as well as in the
 * core, and both credentials live on `secret: true` KV rows the browser
 * structurally cannot read; `service/apply.ts` is the only file that fills
 * them in, in the core's own process, on the way to `device.network.set`.
 *
 * The shell string that writes the HTTP setting is deliberately not spelled
 * anywhere in this pack, not even in a comment: `index.test.ts` greps for it,
 * and a grep that has to distinguish a comment from a call is a grep that will
 * eventually get it wrong.
 */
export type ProxyRouteConfig =
  | { engine: 'adb-reverse-proxy'; hostPort: number }
  | { engine: 'vpn-helper'; host: string; port: number; username?: string; password?: string }

/** What `routeForRecord` needs to know beyond the record itself. */
export interface ProxyRouteContext {
  id?: string
  catalogue?: readonly ProxyCatalogueEntry[]
  /** Which of the two modes Apply was pressed for. Absent means `http` — the only mode that existed before 0.6.0. */
  mode?: ProxyApplyMode
  /**
   * Whether a `proxy-secret:<id>` row exists for this record.
   *
   * Three-valued on purpose: `false` is *"we looked and there is none"* and
   * refuses an authenticated VPN route by name; `undefined` is *"nobody
   * looked"*, which the browser half genuinely cannot do for a secret row it
   * may only list, and must never be turned into a refusal it cannot justify.
   *
   * Read only by the VENDOR branch of `vpnRouteForRecord`
   * (`E_PROXY_VPN_NO_PASSWORD`) — a `direct` record has no outbound account
   * for this to be about, so `directVpnRouteForRecord` never consults it.
   */
  hasPassword?: boolean
}

/**
 * A record → the route to ask the built-in for, or the reason it cannot be one.
 *
 * Lives here rather than in the service because all three halves need the same
 * answer: the screen disables Apply and shows why, the service refuses the same
 * record again when the request arrives, and neither may be the only place the
 * rule exists. Same reasoning as `validateProxyRecord`, whose problems this
 * returns rather than inventing a second vocabulary — an unassigned port is
 * already `E_PROXY_PORT_UNASSIGNED` and does not need a second name.
 *
 * **The two modes ask different questions of the same record, so they run
 * different checks.** `validateProxyRecord` answers *may this bridge run*: the
 * listener's protocol, its bind host, its port, the clash with another record's
 * port. Every one of those is a fact about the BRIDGE — and VPN mode does not
 * use the bridge **for a vendor record**. Running them there would refuse a
 * perfectly applicable VPN route because a listener nobody is going to bind
 * has no port yet, which is a refusal with no true reason behind it. So VPN
 * mode skips them for a vendor upstream and applies its own checks, named
 * after what they are actually about: the upstream. A `direct` record is the
 * one exception, and it is `directVpnRouteForRecord`'s own two checks that
 * apply, not `validateProxyRecord`'s — because a `direct` record's VPN route
 * IS the bridge, and it needs an address the phone can dial and a port to
 * dial it on, not the port-clash or listen-protocol facts that only matter to
 * a *second* bridge trying to bind the same machine.
 */
export function routeForRecord(record: ProxyRecord, context: ProxyRouteContext = {}): { route: ProxyRouteConfig } | { problem: ProxyProblem } {
  if ((context.mode ?? 'http') === 'vpn') return vpnRouteForRecord(record, context)

  const problems = validateProxyRecord(record, context)
  const blocking = problems[0]
  if (blocking) return { problem: blocking }

  if (record.listen.proto !== 'http') {
    return {
      problem: {
        code: 'E_PROXY_NOT_APPLICABLE',
        kind: 'refusal',
        message:
          `Android's system proxy setting names an HTTP proxy and nothing else — there is no field for a ${LISTEN_PROTO_LABELS[record.listen.proto]} one, so a device cannot be pointed at this bridge. ` +
          'Give this record an HTTP listener, or point an app at it by hand.',
      },
    }
  }
  if (!record.enabled) {
    return {
      problem: {
        code: 'E_PROXY_NOT_RUNNING',
        kind: 'precondition',
        message: 'This record is not enabled, so no bridge is listening for the phone to reach. Enable it first — applying it now would point the phone at a port that answers nothing.',
      },
    }
  }
  // `listen.port` is non-null here: `E_PROXY_PORT_UNASSIGNED` above is a
  // problem, and a problem returns before this line.
  return { route: { engine: 'adb-reverse-proxy', hostPort: record.listen.port as number } }
}

/**
 * VPN mode's own refusals, each named after the upstream fact it is about
 * rather than reported as one generic "cannot apply".
 *
 * `direct` branches off first, to a function of its own (§3.6): the questions
 * below this point are all about an UPSTREAM, and a `direct` record names
 * none by design (plan 117 §3.1). Asking them of it anyway would refuse a
 * perfectly applicable route for a reason that is not true of it —
 * `E_PROXY_VPN_UPSTREAM_NOT_SOCKS5` and `E_PROXY_VPN_UPSTREAM_INCOMPLETE` stay
 * exactly what they were, unreachable for `direct`, rather than relaxed to
 * make room for it.
 */
function vpnRouteForRecord(record: ProxyRecord, context: ProxyRouteContext): { route: ProxyRouteConfig } | { problem: ProxyProblem } {
  if (record.upstream.proto === 'direct') return directVpnRouteForRecord(record)

  if (record.upstream.proto !== 'socks5') {
    return {
      problem: {
        code: 'E_PROXY_VPN_UPSTREAM_NOT_SOCKS5',
        kind: 'refusal',
        message:
          `VPN mode hands this record's upstream to the guest agent, which speaks SOCKS5 and nothing else — this record's upstream is ${PROXY_KIND_LABELS[record.upstream.proto]}. ` +
          'Apply it as an HTTP proxy instead (the bridge on this machine is what speaks to an HTTP upstream), or point this record at a SOCKS5 upstream.',
      },
    }
  }
  if (record.upstream.host.length === 0 || record.upstream.port < 1) {
    return {
      problem: {
        code: 'E_PROXY_VPN_UPSTREAM_INCOMPLETE',
        kind: 'precondition',
        message:
          'This record does not name a complete upstream address yet, and VPN mode is nothing but that address handed to the phone. Fill in the upstream host and port on the Catalogue tab first — ' +
          'a record migrated from the older shape can be missing both.',
      },
    }
  }
  /**
   * A username with no saved password is refused; a record with NEITHER is
   * applied as an anonymous upstream.
   *
   * The distinction is the honest one available here. This pack cannot ask an
   * upstream whether it demands authentication, so it reads the record: an
   * account named with no secret behind it is a half credential, and a provider
   * that also accepts IP-whitelist auth answers a half credential by serving a
   * DEFAULT pool exit rather than by failing — the silent wrong answer plan 52
   * §4.1 already records. Measured on this farm on 2026-08-17: the SOAX session
   * genuinely requires one, and a bridge dialling it without produced
   * `E_PROXY_UPSTREAM_PROTOCOL` from the upstream itself.
   */
  if (record.upstream.username.length > 0 && context.hasPassword === false) {
    return {
      problem: {
        code: 'E_PROXY_VPN_NO_PASSWORD',
        kind: 'precondition',
        message:
          `This record names the account “${record.upstream.username}” and no password is saved for it. VPN mode has nowhere to get one from: the phone dials the upstream itself, so the credential has to travel with the route. ` +
          'Save the password on this record first — an upstream that also accepts IP-whitelist authentication would not fail, it would quietly serve a different exit than the account you chose.',
      },
    }
  }
  return {
    route: {
      engine: 'vpn-helper',
      host: record.upstream.host,
      port: record.upstream.port,
      ...(record.upstream.username.length > 0 ? { username: record.upstream.username } : {}),
    },
  }
}

/**
 * VPN mode for a `direct` record (plan 117 §3.6). The vendor branch above
 * hands the phone the record's UPSTREAM, because the vendor performs the
 * egress; a `direct` record has no upstream address to hand over, because
 * **this farm** performs the egress. So the route names the thing that
 * actually does — this record's own bridge, `record.listen.bindHost` and
 * `record.listen.port` — and the phone dials in rather than through.
 *
 * `username`/`password` are deliberately absent from the route built here,
 * for the same reason the vendor branch never populates `password`: both live
 * on a `secret: true` KV row (`proxy-auth:<id>`) this file cannot read — it
 * imports nothing. `service/apply.ts` is the only file that fills them in, in
 * the core's own process, reading that row instead of `proxy-secret:<id>`
 * (which is the OUTBOUND credential this kind of record does not have either).
 */
function directVpnRouteForRecord(record: ProxyRecord): { route: ProxyRouteConfig } | { problem: ProxyProblem } {
  /**
   * The guest agent speaks SOCKS5 and nothing else.
   *
   * The vendor branch already refuses a non-SOCKS5 **upstream** by name; this
   * is the same refusal one layer in, because for a `direct` record the thing
   * the phone dials is this record's own LISTENER. An HTTP-listening record
   * handed to VPN mode produces a route that looks entirely well-formed and
   * dies inside the guest agent's dial, where no screen in this farm reports
   * it — the silent failure the whole plan is written against.
   */
  if (record.listen.proto !== 'socks5') {
    return {
      problem: {
        code: 'E_PROXY_VPN_LISTEN_NOT_SOCKS5',
        kind: 'refusal',
        message:
          `VPN mode points the phone at this record's own bridge, and the guest agent dials it over SOCKS5 — this bridge speaks ${LISTEN_PROTO_LABELS[record.listen.proto]}. ` +
          'Give this record a SOCKS5 listener, or apply it as an HTTP proxy instead, where the bridge is reached over adb and the protocol is the right one.',
      },
    }
  }
  /**
   * A loopback bind is the phone dialling ITSELF.
   *
   * `127.0.0.1` means "this machine" on whichever machine resolves it, and the
   * machine resolving this address is the handset. There is no adb reverse on
   * the vpn-helper path (`packages/drivers/src/network/guest-agent/vpn-helper.ts`
   * has none), so nothing makes the farm's loopback reachable from the phone.
   * This is refused separately from the wildcard case because the fix is a
   * different one: a wildcard bind names too many addresses, a loopback bind
   * names the wrong machine.
   */
  if (LOOPBACK_BIND_HOSTS.some((h) => h === record.listen.bindHost)) {
    return {
      problem: {
        code: 'E_PROXY_VPN_BIND_LOOPBACK',
        kind: 'refusal',
        message:
          `This record's bridge binds ${record.listen.bindHost}, which means "this machine" to whoever dials it — and in VPN mode that is the phone, so it would dial itself. ` +
          "Bind the bridge to an address on this host's LAN that the phone can reach. HTTP mode has no such requirement: it reaches the bridge over adb, which is why a loopback bind is right for that mode and wrong for this one.",
      },
    }
  }
  if (WILDCARD_BIND_HOSTS.some((h) => h === record.listen.bindHost)) {
    return {
      problem: {
        code: 'E_PROXY_VPN_BIND_UNSPECIFIED',
        kind: 'refusal',
        message: `This record's bridge binds ${record.listen.bindHost}, which names every address rather than one. VPN mode hands the phone an address to dial, and a wildcard bind names none it could reach — give the bridge one concrete address on this host's LAN, the same one this record's egress is meant to be reached through.`,
      },
    }
  }
  if (record.listen.port === null) {
    return {
      problem: {
        code: 'E_PROXY_PORT_UNASSIGNED',
        kind: 'precondition',
        message: 'This record needs a local port for its bridge to listen on before VPN mode can point a phone at it — for a direct record the route names the bridge itself, and there is no port to hand over yet.',
      },
    }
  }
  return {
    route: {
      engine: 'vpn-helper',
      host: record.listen.bindHost,
      port: record.listen.port,
    },
  }
}

/**
 * VPN mode's fourth refusal — the one that is a fact about the DEVICE rather
 * than about the record, so it is a function of its own rather than a branch of
 * `routeForRecord`.
 *
 * Plan 114 step 114.7 built the five-state precondition panel for the device
 * page (`absent`/`provisioning`/`outdated`/`failed`/`unsupported`, each with its
 * own action). **This pack cannot render that panel** — it has no Install
 * button, no preparation endpoint in its manifest, and no business growing one:
 * installing the agent is the device's own screen's act. What it must not do
 * instead is fail silently, or worse, apply an HTTP proxy to a phone somebody
 * asked to put on a VPN (plan 114 §3.4 rule 4, and §3.9's own bulk repeat of
 * it). So it refuses by name, says the agent is why, and says where the button
 * is.
 *
 * The state comes from `DeviceInfo.agent`, which is derived from
 * `devices.preparation['guest-agent']` (plan 106 step 106.5) — the same record
 * the built-in's own `vpnPrecondition` reads, not a second vocabulary. A word
 * this build does not recognise returns `null`: the farm's own door checks the
 * agent again, and inventing a refusal from a value we cannot interpret would
 * block a device the farm would have accepted.
 */
export function vpnAgentProblem(agent: string): ProxyProblem | null {
  switch (agent) {
    case 'ready':
      return null
    case 'absent':
      return {
        code: 'E_PROXY_AGENT_NOT_READY',
        kind: 'precondition',
        message:
          'VPN mode runs through the Enkaku guest agent, and this phone does not have it installed. Install it from the device’s own screen (Settings → Preparation), then press Apply again. ' +
          'Nothing was changed on the phone — a VPN that cannot be applied is never quietly replaced with an HTTP proxy.',
      }
    case 'provisioning':
      return {
        code: 'E_PROXY_AGENT_NOT_READY',
        kind: 'precondition',
        message: 'The Enkaku guest agent is still installing on this phone. VPN mode needs it, so this is a “not yet” rather than a failure — press Apply again once the device’s Preparation section reports it ready.',
      }
    case 'outdated':
      return {
        code: 'E_PROXY_AGENT_NOT_READY',
        kind: 'precondition',
        message: 'The Enkaku guest agent installed on this phone is older than this farm’s, and VPN mode needs the current one. Update it from the device’s own screen (Settings → Preparation), then press Apply again.',
      }
    case 'failed':
      return {
        code: 'E_PROXY_AGENT_NOT_READY',
        kind: 'precondition',
        message: 'The Enkaku guest agent could not be prepared on this phone, and VPN mode needs it. The device’s own Preparation section carries the reason and a Retry that clears it; this screen cannot, and does not guess at one.',
      }
    case 'unsupported':
      return {
        code: 'E_PROXY_AGENT_UNSUPPORTED',
        kind: 'refusal',
        message:
          'This phone cannot run the Enkaku guest agent — its Android version is below what the agent needs — so VPN mode is not available on it at all. ' +
          'An old phone is not a broken one: there is nothing to retry here. Apply this record as an HTTP proxy instead, knowing an app can ignore that.',
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The credential gap this pack must not forget (plan 112 F12, step 112.2)
// ---------------------------------------------------------------------------

/**
 * What the farm's KV store would put on a secret row's `hint` column today,
 * for a value this pack stores — reimplemented here, on purpose, as a
 * MEASUREMENT rather than a claim.
 *
 * The core's `secretHint(plaintext)` returns `` `${first 7}…${last 4}` `` for
 * anything longer than eight characters, it is stored on the row, `list()`
 * keeps it, and every HTTP path returns it. **Step 112.2 landed, so a write can
 * now decline it** (`hint: false`) and this pack's credential writes do — but
 * the flag is per write, so what this function measures is exactly what a
 * single write that forgot it would cost.
 *
 * The exact leak is smaller than plan 112 F12's "eleven characters", and the
 * reason is worth writing down because it is the only mitigation this pack
 * has: `store.ts` hints the JSON, not the value, for a non-string — so
 * `{"password":"correct horse"}` hints `{"passw…se"}`, i.e. the last two or
 * three characters of the password plus punctuation. Storing the password as
 * a BARE STRING would leak its first seven and last four. That is why
 * `ProxySecret` is an object with one field and must stay one.
 *
 * `index.test.ts` asserts against the core's own source that `secretHint` is
 * unchanged — the fix was never to weaken the hint, which an API key with a
 * public prefix still wants, but to let a caller storing a credential decline
 * one.
 */
export function secretHintLeak(value: unknown): string {
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value)
  if (plaintext.length <= 8) return '••••'
  return `${plaintext.slice(0, 7)}…${plaintext.slice(-4)}`
}

/**
 * ## The honesty copy, declared once and asserted in `index.test.ts`
 *
 * `docs/design.md`'s writing rule, which is what every sentence below is
 * written against: *a degraded or partial state is never worded as the full
 * one.* A screen that looks finished and does nothing is worse than an
 * obviously unfinished one — and a screen that grows Start and Stop buttons is
 * exactly the moment it starts looking finished (plan 112 §3.12).
 *
 * The strings live here rather than inline in either half so that the manifest
 * an operator reads in the plugin list and the banner they read on the screen
 * are the SAME sentence — not two sentences that agreed on the day they were
 * written. `index.test.ts` asserts both halves reference these names.
 *
 * ### What changed in plan 112 steps 112.1–112.7, and what did not
 *
 * These sentences used to say *no proxy on this screen is ever contacted* and
 * *it never opens a socket*. Both stopped being true the moment the supervisor
 * landed: a record marked `enabled` is started when the plugin loads, and it
 * binds a real listener on loopback and dials a real upstream.
 *
 * So each one is **narrowed to exactly what stopped being true, and no
 * further** — never deleted, and never quietly widened into a claim the code
 * does not back. Everything still unbuilt is still named:
 *
 * - the `check` member still dials nothing (`CHECK_NOT_BUILT`).
 *
 * ### What changed when step 112.2 landed, and what did NOT
 *
 * *"An upstream password cannot be saved yet"* was the one caveat plan 112
 * ADDED rather than narrowed, and it is the clause that fell here: the store
 * grew `KvSetOptions.hint`, this pack writes its credential with
 * `secret: true, hint: false`, and no fragment of it reaches any read path.
 *
 * Two things that sentence also implied are still true and are still said, in
 * `CREDENTIAL_NOT_STORED`, which is narrowed rather than deleted:
 *
 * - **a saved password cannot be shown back.** The built-in device route grew
 *   an audited reveal; this pack has not. Leaving the field empty keeps what is
 *   stored, typing in it replaces it, and there is no third thing it can do.
 * - **the farm's secret box is not a key manager** (plan 112 F10 quotes the
 *   store's own source). The key file sits beside the database, so the honest
 *   claim is "not readable by grepping the database" and this pack does not
 *   upgrade it.
 *
 * ### What changed in plan 112 steps 112.8 and 112.9
 *
 * Two more clauses fell, and only those two. *"The screen cannot start, stop or
 * restart a bridge"* and *"there is no per-proxy log view"* stopped being true
 * the moment the service registered its own HTTP routes: `start`, `stop`
 * (with `force`), `restart` and a `logs` page the farm filters by subject, each
 * behind the core's own auth, TLS, CORS, rate limiting and audit, driving the
 * supervisor that already owned every bridge's state.
 *
 * What did **not** change, and is still said in the same words:
 *
 * - **a bridge is still only advisory** where a device is concerned
 *   (`APPLY_RUNG_SENTENCE`) — being able to stop one from a screen says nothing
 *   about whether an app on a phone honoured it;
 * - **what a log line records is a decision, not a default** — see
 *   `LOGS_CONTENT_NOTE` and `LOG_DESTINATIONS_HINT`, and the field allowlist
 *   `logbook.test.ts` holds the code to.
 *
 * ### What changed again in plan 114 step 114.9
 *
 * The sentence *"no device's traffic is routed, and an assignment is still only
 * a note"* — which plan 112 §3.12 said would survive verbatim — **stopped being
 * true**, and is narrowed here rather than deleted. Plan 114 built the device's
 * own Network → Proxy, and this pack can now ask the built-in to apply a
 * record to a device through `device.network.set`: the same
 * `PUT /api/devices/:id/network` an operator's own click goes through, under a
 * `plugin:proxy-manager` principal, audited, with the device's panel reporting
 * *set by proxy-manager*.
 *
 * Three things that were true stay true and are still said:
 *
 * - **An assignment is still a note until somebody presses Apply.** Plan 114 §9
 *   Q6 asked whether assigning should apply, and the answer taken here is
 *   *explicit Apply, never implicit*: an assignment that silently changed forty
 *   phones' networking on save is the wrong default, and 112 §3.5's own
 *   intent-versus-state discipline points the same way.
 * - **Which rung gets applied is now the operator's own choice, and the two are
 *   never worded as equals** (0.6.0, and the correction to the bullet that
 *   stood here). Applying the BRIDGE is still the advisory rung and always will
 *   be, because a bridge binds loopback. Applying the record's own SOCKS5
 *   UPSTREAM is the enforcing one, because the guest agent dials it from the
 *   phone — a different route entirely, not a stronger claim about the same
 *   one. `APPLY_RUNG_SENTENCE` and `APPLY_VPN_SENTENCE` say each of them, and
 *   the second one also says the price: in VPN mode the upstream password goes
 *   to the phone.
 * - **This pack still contacts no device itself.** It has no adb, no shell and
 *   no settings write; it asks the farm, and the farm refuses it if its manifest
 *   did not declare the capability.
 *
 * `APPLY_INTENT_SENTENCE` is plan 114 §3.3's own replacement wording, declared
 * once here so the manifest an operator reads in the plugin list and the banner
 * they read on the screen cannot drift into two different claims.
 *
 * The constant NAMES keep their `_NOT_BUILT` suffix on purpose while the
 * screen still cannot drive any of this. Step 112.10 is where the screen and
 * these names are revisited together; renaming them here would touch four UI
 * files for no change in what an operator reads.
 */

/**
 * Plan 114 §3.3's replacement for plan 112 §3.12's standing sentence, verbatim,
 * and the one place it is written.
 *
 * It describes the DEVICE's Network → Proxy — both of its modes — because that
 * is what an assignment ends up in, and because the operator has to be told
 * that the two are not equals wherever the choice is visible.
 *
 * **As of 0.6.0 this pack's own Apply reaches both halves**, which is why the
 * sentence is followed by `APPLY_RUNG_SENTENCE` *and* `APPLY_VPN_SENTENCE`
 * rather than by one narrowing caveat. It used to reach only the weaker one, and
 * the caveat was there to stop the wider sentence being read as a promise; the
 * fix for two modes is to describe both, never to let one sentence stand for
 * whichever the operator happens to press.
 */
export const APPLY_INTENT_SENTENCE =
  'Assigning a proxy here records intent. Applying it to a device is the device’s own Network → Proxy setting, which either asks the device to use this proxy (apps may ignore it) or routes it through the VPN (apps cannot).'

/**
 * The first of the two modes, and what it costs.
 *
 * *"Apply here always uses the asking kind"* was the opening clause and it
 * stopped being true in 0.6.0 — narrowed to name the mode it is about rather
 * than deleted, because everything after that clause is still exactly as true
 * and is the half an operator most needs. `index.test.ts` holds the old clause
 * gone and this one present, the paired discipline this whole block runs on.
 */
export const APPLY_RUNG_SENTENCE =
  'The HTTP proxy mode is the asking kind. A bridge listens on this machine’s loopback, so the phone reaches it over the adb connection and is told to use it as its system proxy — an app with its own networking can ignore that, and nothing here can tell you which did. The upstream account stays on this machine.'

/**
 * The second mode, in the same place, because a mode described alone reads as
 * the only one there is.
 *
 * Both halves of the trade, deliberately in this order: the reason to choose it
 * (an app cannot opt out) and the price of choosing it (the credential goes to
 * the phone). Stating only the first would sell it; stating only the second
 * would make it look like a mistake to ever pick.
 */
export const APPLY_VPN_SENTENCE =
  'The VPN mode uses the record’s own SOCKS5 upstream instead, and the bridge is not involved at all: the Enkaku guest agent on the phone dials that upstream itself, so an app cannot opt out of it. The price is that the upstream password is sent to the phone to make that dial — the one thing the HTTP mode never does — and only a SOCKS5 upstream can be used this way.'

/**
 * The two mode descriptions shown beside the choice itself, one line each.
 *
 * **Copied deliberately from Studio's own `proxy-copy.ts`** — the built-in
 * device panel's `HTTP_MODE_DESCRIPTION` and `VPN_MODE_DESCRIPTION`
 * (`packages/studio/src/components/guest-agent/proxy-copy.ts`, plan 114 §3.1
 * rule 1). This pack is bundled separately by `enkaku publish`, which inlines
 * everything it imports, so it CANNOT import from Studio however right that
 * would be — the same constraint `parseProxyLine` already records about
 * `parseSocks5Url`.
 *
 * **These two strings must stay word for word identical to Studio's.** They are
 * the sentence that stops an operator believing an HTTP proxy captures their
 * traffic, and plan 114's own risk 1 names three copies of that wording as the
 * failure mode rather than the mitigation. A copy that cannot be prevented is at
 * least a copy that says so, out loud, next to itself.
 */
export const HTTP_MODE_DESCRIPTION =
  'Apps can ignore this. WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone stops it.'

/** Studio's `VPN_MODE_DESCRIPTION`, verbatim — see the note above. */
export const VPN_MODE_DESCRIPTION = 'Apps cannot opt out of this. Needs the Enkaku guest agent installed on the phone.'

/**
 * The one sentence this pack adds to Studio's pair, because this pack's VPN
 * mode does something the device panel's does not: it spends a credential the
 * PLUGIN is holding.
 *
 * On the device panel an operator types the upstream password into the form
 * they are looking at. Here they press a button on a row and a password saved
 * weeks ago, on a different tab, is sent to a phone. That is the same act with
 * far less of it visible, so it is said at the point of choice rather than left
 * to be inferred from `APPLY_VPN_SENTENCE`'s longer paragraph.
 */
export const VPN_CREDENTIAL_WARNING =
  'This record’s saved upstream password is sent to the phone, because the phone is what dials the upstream. The HTTP proxy mode keeps it on this machine.'

/** What the two descriptions are keyed by, so a screen renders the one for the selected mode without a second table. */
export const PROXY_APPLY_MODE_DESCRIPTIONS: Record<ProxyApplyMode, string> = {
  http: HTTP_MODE_DESCRIPTION,
  vpn: VPN_MODE_DESCRIPTION,
}

/**
 * The plugin's own description, shown wherever the farm names the pack.
 *
 * *"It routes no device's traffic"* was the half that stopped being true in
 * step 114.9 and is narrowed to what still is: this pack does not carry a
 * device's traffic itself and never touches a phone — it asks the built-in to,
 * one device at a time, when somebody presses Apply.
 */
export const PLUGIN_NOT_BUILT =
  'Keeps a catalogue of proxies and runs a local bridge for each record you enable: an HTTP or SOCKS5 listener on loopback that tunnels through the upstream proxy the record names. Each one can be started, stopped and restarted on its own, and every bridge writes to one log you can filter to a single proxy. It contacts no phone itself — pointing a device at a record is the farm’s own Network → Proxy, asked for one device at a time from the Assignments tab, either as an HTTP proxy apps can ignore or as a VPN they cannot, which sends the record’s upstream password to the phone. An upstream password is saved encrypted on a row of its own and is never shown again.'

/**
 * The view's description, under the screen's title.
 *
 * *"nothing here changes how a device's traffic is carried"* was the clause that
 * fell in step 114.9. *"changes that device's system proxy setting"* is the one
 * that fell in 0.6.0, because that is now only one of the two things Apply can
 * do — and describing a two-mode action as if it had one mode is the same class
 * of drift, one release later.
 *
 * **The schema caps this at 300 characters** (`validatePluginSurface`), which is
 * why the opening sentence is four words rather than a longer one: naming the
 * second mode is worth more than the prose it displaced.
 */
export const PROXIES_VIEW_DESCRIPTION =
  'Proxy records this plugin keeps. A record marked enabled is started by the farm when this plugin loads, and each bridge can be started, stopped or restarted on its own from here. Applying one to a device sets a system proxy, or a VPN through the record’s own upstream, only when you press Apply.'

/**
 * The banner that sits above the tabs, on every tab, for as long as this is
 * true.
 *
 * *"It is not a route ... and no device's traffic changes"* was two claims in a
 * row and only the second one fell. The first — an app that is not configured
 * to use a proxy will not use one — is now MORE important, not less, because a
 * device can be pointed at a bridge and still ignore it, so it stays and
 * `APPLY_RUNG_SENTENCE` carries it.
 *
 * The password clause is narrowed rather than dropped: *"saving one is not
 * built yet"* stopped being true when step 112.2 landed, and what replaces it
 * is the half that is still true — it is stored, and it is never shown back.
 */
export const BANNER_NOT_BUILT =
  `A bridge runs on the farm’s own machine for every record you enable, and an app can be pointed at it. ${APPLY_RUNG_SENTENCE} ${APPLY_VPN_SENTENCE} An upstream password is stored encrypted on a row of its own, with no fragment of it on any read path, and nothing here can show a saved one back to you.`

/** The catalogue's empty state. */
export const CATALOGUE_EMPTY_HINT =
  'Add one to record its address here, or paste a list your provider gave you. A record listens only once you start it, and starting one binds a port on this machine.'

/**
 * What an operator is told about the password field — narrowed by step 112.2,
 * never deleted, because two of the three things it said are still true.
 *
 * **What fell.** Storing a credential used to put a fragment of it on the KV
 * row's own `hint`, which `list()` keeps and every HTTP path returns (plan 112
 * F12), with no way to decline it. `KvSetOptions.hint` landed; this pack writes
 * `secret: true, hint: false` on every write of `proxy-secret:<id>`, and the
 * hint column is `null` on the store read, the `/api/kv` read and the
 * `/api/plugins/:name/data` read.
 *
 * **What still holds, and is still said.**
 *
 * 1. **There is no reveal.** The built-in device route grew an audited one;
 *    this pack has not. A saved password can be replaced or removed from here
 *    and read from here never — which is also why the field is empty on edit
 *    rather than prefilled with something that would have to be a lie.
 * 2. **The box is not a key manager.** Plan 112 F10 quotes the store's own
 *    source: no KDF, no passphrase, no keychain, and the key file next to the
 *    database. "Not readable by grepping the database" is the whole claim, and
 *    a screen that implied more would be the failure `docs/design.md`'s writing
 *    rule exists to prevent.
 *
 * The constant keeps its name. It is no longer literally accurate — the
 * credential IS stored — and renaming it would touch the UI files and the
 * assertions that hold this text in place for no change in what an operator
 * reads; it is revisited when the pack's copy is next renamed as a set.
 */
export const CREDENTIAL_NOT_STORED =
  'An upstream password is saved on its own encrypted row, written with the storage hint switched off, so no fragment of it comes back from any list or any read of this plugin’s data. It cannot be shown back to you: this pack has no reveal, so leaving this field empty keeps the saved password and typing in it replaces one. And the farm’s secret box is not a key manager — its key file sits beside the database, so anyone who can read the farm’s data directory can read both.'

/**
 * What the dialog says when a credential row already exists for this record.
 *
 * The screen can know this much and no more, and the distinction is the point:
 * `list({ prefix: 'proxy-secret:' })` answers with the KEY and never the value
 * (`list()` does not decrypt — plan 112 F11), so "a password is saved" is a
 * fact the browser can honestly state while its contents structurally cannot
 * reach it. Saying nothing would leave an operator unable to tell an empty
 * field that means *unchanged* from one that means *there is none*.
 */
export const PASSWORD_SAVED_HINT = 'A password is saved for this record. Leave this empty to keep it, type to replace it, or remove it below.'

/** And when there is not one — said in the same place, so the empty field never has to be interpreted. */
export const PASSWORD_ABSENT_HINT = 'No password is saved for this record. A bridge dials its upstream without one, and an upstream that demands one fails to connect and says so on its row.'

/**
 * The assignments tab's standing note — the tab most likely to be mistaken for
 * something that acts, which is now half right and has to say which half.
 *
 * Plan 112 §3.12 said this sentence would survive plan 114 verbatim. It did
 * not, and pretending otherwise would be the drift these constants exist to
 * prevent: *"nothing reads it"*, *"the device's traffic is unchanged"* and
 * *"which no plugin can reach today"* are all false as of step 114.9 — Apply
 * reads the assignment, the farm applies it, and this pack reaches the network
 * layer through `device.network.set` and nothing else.
 *
 * What survives, and is the load-bearing half: **saving an assignment still
 * changes nothing on any phone.** Apply is a separate, deliberate press (plan
 * 114 §9 Q6).
 */
export const ASSIGNMENT_NOTE = `${APPLY_INTENT_SENTENCE} Saving one here changes nothing on the phone until you press Apply on that row, and Apply asks which of the two modes to use. ${APPLY_RUNG_SENTENCE} ${APPLY_VPN_SENTENCE}`

/** The runs tab's standing note. */
export const RUNS_NOTE =
  'Runs of this pack’s own scripts. “Check a proxy” does nothing yet: it logs the key it was given and returns “not reachable”, because nothing was dialled — a run that reported nothing at all would read like a pass.'

/**
 * The `check` member's description, shown in the run dialog and the jobs list.
 *
 * Still "does nothing", and plan 112 §9 Q5 is why it will probably never do
 * anything: a job child under container isolation runs with `--network=none`,
 * so a `check` script that dialled a proxy would fail on network-less grounds
 * and report it as a dead upstream. A real health check belongs in the
 * service, beside the bridges. The second sentence is narrowed only because
 * "this pack has no networking behaviour at all" stopped being true.
 */
export const CHECK_NOT_BUILT =
  'Does nothing yet. It logs the proxy key it was given and returns "not reachable" — this member dials nothing. The bridges this pack runs live in its service, not in a job, because a job child can be started with no network of its own.'
