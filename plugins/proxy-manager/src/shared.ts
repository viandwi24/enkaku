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
 * **Nothing writes this key yet, and that is not an oversight.** A KV secret
 * still carries a `hint` derived from its plaintext (plan 112 F12), and the
 * option that turns it off (`hint: false`) is step 112.2, which is not built.
 * `secretHintLeak()` below measures exactly what would leak today, and
 * `index.test.ts` fails the moment 112.2 lands so this comment cannot outlive
 * the gap it describes.
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

/**
 * The transports a record can name. Nothing reads this yet — it is stored,
 * shown, and that is all — but it is a closed list rather than free text
 * because the day something does read it, an operator who typed "socks 5"
 * would be the one holding the bug.
 */
export const PROXY_KINDS = ['http', 'https', 'socks5'] as const

export type ProxyKind = (typeof PROXY_KINDS)[number]

/** How each transport is written for a person. `socks5` is spelled SOCKS5, never "Socks5". */
export const PROXY_KIND_LABELS: Record<ProxyKind, string> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
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
 * The only addresses a bridge may bind in v1 (plan 112 §3.9).
 *
 * An HTTP or SOCKS5 proxy with no authentication of its own, reachable
 * off-host, is an **open relay**: anyone who can route a packet to it spends
 * the operator's upstream account. Listener-side authentication and an
 * off-host bind ship together or not at all, and neither is built — so the
 * bind is refused by name rather than left to an operator's judgement.
 */
export const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1'] as const

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
  host: string
  port: number
  /**
   * In the clear, deliberately, and questioned in plan 112 §9 Q1: a catalogue
   * that cannot say which account a proxy authenticates as is a list of
   * hostnames. The PASSWORD is never here.
   */
  username: string
}

/** One proxy, as this plugin stores it. Field order is the storage order — `index.test.ts` holds it to `ProxyRecordSchema`'s. */
export interface ProxyRecord {
  label: string
  listen: ProxyListen
  upstream: ProxyUpstream
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
  notes: string
}

/** What the `logDestinations` switch means, in the plain words the form shows beside it. */
export const LOG_DESTINATIONS_HINT =
  'Records which hosts the traffic through this proxy reaches, for as long as it stays on. Off by default: destination ports and outcomes are always logged, hostnames only when you ask for them.'

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
    return {
      label: str(source, 'label'),
      listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: null },
      upstream: {
        proto: oneOf(PROXY_KINDS, source.kind, 'socks5'),
        host: str(source, 'host'),
        port: port(source.port) ?? 0,
        username: '',
      },
      enabled: false,
      logDestinations: false,
      maxConnections: DEFAULT_MAX_CONNECTIONS,
      drainMs: DEFAULT_DRAIN_MS,
      notes: str(source, 'notes'),
    }
  }

  const listen = asObject(source.listen)
  const upstream = asObject(source.upstream)
  return {
    label: str(source, 'label'),
    listen: {
      proto: oneOf(LISTEN_PROTOS, listen.proto, 'http'),
      bindHost: str(listen, 'bindHost', DEFAULT_BIND_HOST) || DEFAULT_BIND_HOST,
      port: port(listen.port),
    },
    upstream: {
      proto: oneOf(PROXY_KINDS, upstream.proto, 'socks5'),
      host: str(upstream, 'host'),
      port: port(upstream.port) ?? 0,
      username: str(upstream, 'username'),
    },
    enabled: bool(source, 'enabled', false),
    logDestinations: bool(source, 'logDestinations', false),
    maxConnections: bounded(source.maxConnections, 1, 10_000, DEFAULT_MAX_CONNECTIONS),
    drainMs: bounded(source.drainMs, 0, 120_000, DEFAULT_DRAIN_MS),
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
 * both and checks the result against `ProxyRecordSchema`.
 */
export function writeProxyRecord(record: ProxyRecord): Record<string, unknown> {
  return {
    label: record.label,
    listen: { proto: record.listen.proto, bindHost: record.listen.bindHost, port: record.listen.port },
    upstream: { proto: record.upstream.proto, host: record.upstream.host, port: record.upstream.port, username: record.upstream.username },
    enabled: record.enabled,
    logDestinations: record.logDestinations,
    maxConnections: record.maxConnections,
    drainMs: record.drainMs,
    notes: record.notes,
  }
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

/** Everything `validateProxyRecord` can say, as a closed list, so a screen can switch on it. */
export const PROXY_PROBLEM_CODES = [
  'E_PROXY_LISTEN_UNSUPPORTED',
  'E_PROXY_UPSTREAM_UNSUPPORTED',
  'E_PROXY_BIND_NOT_LOOPBACK',
  'E_PROXY_PORT_CONFLICT',
  'E_PROXY_PORT_UNASSIGNED',
] as const
export type ProxyProblemCode = (typeof PROXY_PROBLEM_CODES)[number]

/** The other records `validateProxyRecord` needs to see to answer `E_PROXY_PORT_CONFLICT`. */
export interface ProxyCatalogueEntry {
  id: string
  record: ProxyRecord
}

/**
 * The one function that decides whether a record may run, called at **write**
 * time by the screen and again at **start** time by the supervisor — never
 * only at start, or a record edited around the UI would bind anyway.
 *
 * Returns every problem it finds rather than the first, because a form that
 * reports one error at a time makes an operator submit four times.
 */
export function validateProxyRecord(record: ProxyRecord, context: { id?: string; catalogue?: readonly ProxyCatalogueEntry[] } = {}): ProxyProblem[] {
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

  if (!LOOPBACK_BIND_HOSTS.some((h) => h === record.listen.bindHost)) {
    problems.push({
      code: 'E_PROXY_BIND_NOT_LOOPBACK',
      kind: 'refusal',
      message:
        `A bridge may only bind ${LOOPBACK_BIND_HOSTS.join(' or ')}. A proxy with no authentication of its own, reachable off-host, is an open relay: ` +
        'anyone who can route a packet to it spends your upstream account. A device does not need an off-host bind (it gets 127.0.0.1 on the device ' +
        'itself, over the adb connection that already exists); a remote person uses an SSH or WireGuard tunnel, as for any other loopback service.',
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
// The credential gap this pack must not forget (plan 112 F12, step 112.2)
// ---------------------------------------------------------------------------

/**
 * What the farm's KV store would put on a secret row's `hint` column today,
 * for a value this pack stores — reimplemented here, on purpose, as a
 * MEASUREMENT rather than a claim.
 *
 * The core's `secretHint(plaintext)` returns `` `${first 7}…${last 4}` `` for
 * anything longer than eight characters, it is stored on the row, `list()`
 * keeps it, and every HTTP path returns it. There is no way to turn it off
 * until step 112.2 adds `hint: false` — which is not built.
 *
 * The exact leak is smaller than plan 112 F12's "eleven characters", and the
 * reason is worth writing down because it is the only mitigation this pack
 * has: `store.ts` hints the JSON, not the value, for a non-string — so
 * `{"password":"correct horse"}` hints `{"passw…se"}`, i.e. the last two or
 * three characters of the password plus punctuation. Storing the password as
 * a BARE STRING would leak its first seven and last four. That is why
 * `ProxySecret` is an object with one field and must stay one.
 *
 * `index.test.ts` asserts against the core's own source that this is still
 * what happens, and fails the day 112.2 lands.
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
 * - the screen cannot start, stop or restart a bridge (steps 112.9, 112.10);
 * - there is no per-proxy log view (step 112.8);
 * - an upstream **password cannot be stored at all** (step 112.2 — see
 *   `CREDENTIAL_NOT_STORED`);
 * - no device's traffic is routed, and an assignment is still only a note
 *   (`ASSIGNMENT_NOTE`, unchanged word for word — §3.12 says it survives this
 *   plan verbatim);
 * - the `check` member still dials nothing (`CHECK_NOT_BUILT`).
 *
 * The constant NAMES keep their `_NOT_BUILT` suffix on purpose while the
 * screen still cannot drive any of this. Step 112.10 is where the screen and
 * these names are revisited together; renaming them here would touch four UI
 * files for no change in what an operator reads.
 */

/** The plugin's own description, shown wherever the farm names the pack. */
export const PLUGIN_NOT_BUILT =
  'Keeps a catalogue of proxies and runs a local bridge for each record you enable: an HTTP or SOCKS5 listener on loopback that tunnels through the upstream proxy the record names. It routes no device’s traffic, and starting or stopping a bridge from the screen is not built yet.'

/** The view's description, under the screen's title. */
export const VIEW_NOT_BUILT =
  'Proxy records saved in this plugin’s own storage. A record marked enabled is started by the farm when this plugin loads; this screen cannot start or stop one yet, and nothing here changes how a device’s traffic is carried.'

/** The banner that sits above the tabs, on every tab, for as long as this is true. */
export const BANNER_NOT_BUILT =
  'A bridge runs on the farm’s own machine, bound to loopback, and an app can be pointed at it. It is not a route: an app that is not configured to use a proxy will not use one, and no device’s traffic changes. Starting and stopping from this screen, per-proxy logs, and saving an upstream password are not built yet.'

/** The catalogue's empty state. */
export const CATALOGUE_EMPTY_HINT =
  'Add one to record its address here. A record listens only once it is enabled, and enabling one from this screen is not built yet — controls, per-proxy logs and a password field are still to come.'

/**
 * Why the Add/Edit dialog has no password field, in the words an operator
 * gets. This is the one caveat plan 112 GAINED rather than narrowed.
 *
 * Storing a credential today would put a fragment of it on the KV row's own
 * `hint`, which `list()` keeps and every HTTP path returns — readable by
 * anyone who can open this plugin's data (plan 112 F12). The fix is a farm
 * change, step 112.2, and it is not built. Refusing to offer the field is the
 * only honest option: an upstream that needs a password will fail to connect
 * and say so on its own row.
 */
export const CREDENTIAL_NOT_STORED =
  'An upstream password cannot be saved yet. Storing one today would leave a fragment of it on the record’s own storage hint, readable by anyone who can open this plugin’s data — the fix is a change to the farm’s key/value store (plan 112 step 112.2) and it is not built. Until then a bridge dials its upstream without a password, and an upstream that demands one fails to connect and says so.'

/** The assignments tab's standing note. It is the tab most likely to be mistaken for something that acts. */
export const ASSIGNMENT_NOTE =
  'An assignment is a note, not a route. It records which proxy a device is MEANT to use; nothing reads it, and the device’s traffic is unchanged. Routing belongs to the network driver layer (spec §7.9), which no plugin can reach today.'

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
