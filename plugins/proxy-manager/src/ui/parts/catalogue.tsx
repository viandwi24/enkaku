import { useCallback, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  api,
  duration,
  fileSize,
  relativeTime,
  useAction,
} from '@enkaku/ui'
import {
  CATALOGUE_EMPTY_HINT,
  DEFAULT_BIND_HOST,
  DEFAULT_DRAIN_MS,
  DEFAULT_LOCAL_PORT_BASE,
  DEFAULT_MAX_CONNECTIONS,
  LISTEN_PROTOS,
  LISTEN_PROTO_LABELS,
  LOG_DESTINATIONS_HINT,
  PASSWORD_MASK,
  PROXY_KEY_COLLISION_HINT,
  PROXY_KEY_DERIVED_HINT,
  PROXY_KEY_HINT,
  PROXY_KEY_LOCKED_HINT,
  PROXY_KEY_PREFIX,
  PROXY_KEY_TAKEN_HINT,
  PROXY_KIND_LABELS,
  PROXY_KINDS,
  PROXY_PASTE_FORMATS,
  PROXY_PASTE_PREVIEW_NOTE,
  PROXY_PASTE_RULE,
  PROXY_PASTE_SINGLE_HINT,
  PROXY_PROBE_KEY_PREFIX,
  PROXY_PROBE_STATE_LABELS,
  PROXY_SECRET_KEY_PREFIX,
  deriveProxyKey,
  describeDirectUpstream,
  isStartableRecord,
  isStorableRecord,
  nextFreeLocalPort,
  parseProxyLine,
  parseProxyList,
  proxyIdFromKey,
  proxyProbeState,
  proxySecretKeyFor,
  proxySecretSlotKeyFor,
  slugifyProxyName,
  suggestProxyName,
  validateProxyRecord,
  type ListenProto,
  type ParsedProxy,
  type ProxyKind,
  type ProxyPasteLine,
  type ProxyProblem,
} from '../../shared'
import { BackupUpstreamsEditor } from './backup-upstreams'
import { FailoverChip } from './failover-chip'
import { UpstreamFieldGroup } from './upstream-fields'
import {
  IgnoredSchema,
  KvPageSchema,
  PLUGIN_API,
  PROXY_HTTP_API,
  PROXY_STATE_LABELS,
  ProxyStatusPageSchema,
  proxyActionPath,
  readProxy,
  readProxyProbes,
  readProxyStatuses,
  writeProxy,
  type ProxyProbeResult,
  type ProxyRecord,
  type ProxyStatus,
} from './api'
import { ProxyStateBadge, useLoader, usePoll } from './bits'

/**
 * The catalogue — the tab that does what the tier-A version of this pack did,
 * so the two can be compared honestly (plan 111 §4.3, `docs/design.md`'s
 * "Tier A or tier C").
 *
 * Everything below is ordinary React over ordinary `fetch`. The write path is
 * `PUT /api/plugins/proxy-manager/data/entry`, the operator-facing
 * (`plugin.data`) door onto this plugin's own namespace: the namespace is
 * taken from the URL server-side and cannot be another plugin's, and every
 * write is audited as `plugin.data.set`.
 */

interface Row {
  key: string
  /** The token every service route takes — the storage key without its `proxy:` prefix. */
  id: string
  version: number
  updatedAt: number
  record: ProxyRecord
}

/**
 * What one load produced: the stored catalogue, and what the supervisor
 * observes about it.
 *
 * **They are two reads and they fail independently, on purpose.** The records
 * are storage and are always there; the runtime comes from this pack's own
 * service, which can be stopped, restarting, or disabled by the error budget.
 * A service that is down must leave the catalogue readable and editable, and it
 * must not turn into an empty state — plan 109's own rule for a view whose
 * handler is down is that Studio names the plugin and says which of "not
 * started", "starting", "failed" it is, never that the data is gone.
 */
interface Loaded {
  rows: Row[]
  /** Keyed by id AND by storage key, so a row matches whichever the farm answered with. Empty when it could not be asked. */
  statuses: Map<string, ProxyStatus>
  /** Why no runtime is being shown, when none is. A missing observation is rendered as `unknown`, never as `stopped`. */
  statusError: string | null
  /**
   * Which records have a credential row — the ids of `proxy-secret:<id>` keys,
   * and nothing else about them.
   *
   * This is the whole of what a browser may know about a stored password, and
   * it is a property of the store rather than of this code: `list()` never
   * decrypts, so `value` is `null` on every one of these rows, and a write with
   * `hint: false` leaves `hint` null too. So the screen can say *a password is
   * saved* without any path existing by which it could say more.
   */
  secrets: Set<string>
  /**
   * The last observed egress per record — `proxy-probe:<id>`, keyed by id
   * (plan 117 §3.7, §4.5). Not secret, so this is a plain KV read like the
   * records themselves rather than the credential-existence read `secrets`
   * is; a record absent from this map has never been probed and reads
   * `unverified` for exactly that reason (`proxyProbeState(null)`).
   */
  probes: Map<string, ProxyProbeResult>
}

/** A row being edited. `key` is empty for a row that does not exist yet. */
interface Draft extends ProxyRecord {
  key: string
  /** Whether the key field is editable — `kv.set` upserts and cannot MOVE an entry, so an edit must never offer a rename. */
  isNew: boolean
  /**
   * Whether the operator has taken the key over. Until they do, it is derived
   * from the name on every keystroke; once they do, it is theirs and this
   * screen stops rewriting it under them.
   */
  keyTouched: boolean
  /**
   * The password as typed, and only ever as typed — an edit opens with this
   * empty even when one is stored, because there is no read path that could
   * fill it (plan 112 F11) and a placeholder pretending otherwise would be the
   * lie `CREDENTIAL_NOT_STORED` exists to avoid. Empty means *leave the stored
   * one alone*; `clearPassword` is the separate, deliberate way to say *remove*.
   */
  password: string
  clearPassword: boolean
  /**
   * Per-backup-slot (1..n) passwords as typed (plan 121 §4.1/§4.5, step
   * 121.4/121.6) — mirrors `password`'s own "empty means leave the stored
   * one alone" rule, one entry per `fallbackUpstreams` index (slot = index +
   * 1, `proxySecretSlotKeyFor`'s own addressing).
   */
  fallbackPasswords: Record<number, string>
  /** Per-backup-slot "remove the saved password" flags — mirrors `clearPassword`. */
  clearFallbackPasswords: Record<number, boolean>
}

// ---------------------------------------------------------------------------
// The two writes, in one place each
// ---------------------------------------------------------------------------

/** The record half. `secret: false` — a host and a port are not credentials, and marking them secret would redact the columns this table draws. */
async function putRecord(key: string, record: ProxyRecord): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'global', key, value: writeProxy(record), secret: false },
  })
}

/**
 * The credential half — the ONE place this pack writes a password, so the two
 * flags that make it safe cannot be right on one path and forgotten on another.
 *
 * **The two flags travel together, and both are per write.**
 * `secret` encrypts the value; `hint` is what step 112.2 added, and without it
 * the store puts `secretHint(json)` on the row — which `list()` keeps and every
 * HTTP path returns to anyone holding `plugin.data` (plan 112 F12). Neither is
 * sticky: the store recomputes both from the options of the write in front of
 * it, so a later write that omitted `hint` would quietly restore the leak on a
 * key that had never had one. That is the whole reason this is a function and
 * not two lines at each call site.
 *
 * The value stays an OBJECT with one field even now the hint can be declined,
 * because the flag is per write and the object shape is what bounds the damage
 * of a write that forgets it — `{"passw…rd"}` rather than `Sup3rSe…word`. See
 * `secretHintLeak` in `shared.ts`, which measures both.
 */
async function putSecret(id: string, password: string): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'global', key: proxySecretKeyFor(id), value: { password }, secret: true, hint: false },
  })
}

/**
 * The credential half for ONE BACKUP SLOT (plan 121 §4.1, widened by step
 * 121.4; wired into this screen by step 121.6) — `putSecret`'s own twin,
 * against `proxySecretSlotKeyFor(id, slot)` (`<id>:<slot>`, `slot` 1..n)
 * rather than the bare, primary-only key. Same two flags, same reason: a
 * fallback's own account (another local egress, a third-party rotating
 * proxy like SOAX) must authenticate as ITSELF, not as whatever the primary
 * happens to use — the exact gap step 121.4 closed at the storage layer,
 * which this is the write side of.
 */
async function putSecretSlot(id: string, slot: number, password: string): Promise<void> {
  await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
    method: 'PUT',
    json: { scope: 'global', key: proxySecretSlotKeyFor(id, slot), value: { password }, secret: true, hint: false },
  })
}

/** Either half, gone. */
async function deleteEntry(key: string): Promise<void> {
  await api(`${PLUGIN_API}/data/entry?scope=global&key=${encodeURIComponent(key)}`, IgnoredSchema, { method: 'DELETE' })
}

/** One shared empty map, so a render with no runtime does not allocate a new one every pass. */
const EMPTY_STATUSES = new Map<string, ProxyStatus>()

/** The same, for the credential-key set. */
const EMPTY_SECRETS: ReadonlySet<string> = new Set<string>()

/** The same, for the probe-result map — an empty one reads every row as `unverified`, which is correct before the first load finishes. */
const EMPTY_PROBES = new Map<string, ProxyProbeResult>()

/**
 * `useAction`'s pending key. Per row AND per verb, because a farm with twenty
 * proxies has twenty Start buttons and only the one that was pressed may spin.
 * Force stop gets its own key so the confirmation's button can spin without
 * disabling the plain Stop on the row behind it.
 */
function actionKey(id: string, verb: 'start' | 'stop' | 'restart' | 'reset-failover', force?: boolean): string {
  return `${verb}${force ? ':force' : ''}:${id}`
}

/** A drain window for a person: the record stores milliseconds, and "10000 ms" is not how anyone reads ten seconds. */
function millis(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`
}

const BLANK: Draft = {
  // Empty, not `'proxy:'`: the key is derived from the name (`deriveProxyKey`)
  // and the operator never has to type one. This value is only what the
  // override field starts from before a name exists.
  key: '',
  isNew: true,
  keyTouched: false,
  password: '',
  clearPassword: false,
  fallbackPasswords: {},
  clearFallbackPasswords: {},
  label: '',
  listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: null },
  upstream: { proto: 'socks5', host: '', port: 1080, username: '', bindAddress: '', resolveThroughEgress: true },
  // Plan 121 §1 — a fresh record starts with no backups and the plain
  // failover defaults, same as `readProxyRecord`'s own defaulting for a
  // pre-plan-121 row (`shared.ts`). The backup-upstreams editor
  // (`BackupUpstreamsEditor` below) is what actually wires these into real
  // UI — see this step's own instruction not to stop at patching the type.
  fallbackUpstreams: [],
  failover: { failureThreshold: 3, autoFailback: true },
  enabled: false,
  logDestinations: false,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
  drainMs: DEFAULT_DRAIN_MS,
  capacity: 0,
  exclusive: false,
  listenerAuth: false,
  notes: '',
}

export function CatalogueTab({ query, onQueryChange, onShowLogs }: { query: string; onQueryChange: (next: string) => void; onShowLogs: (id: string) => void }) {
  const load = useCallback(async (): Promise<Loaded> => {
    const page = await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}&limit=200`, KvPageSchema)
    const rows: Row[] = page.items.map((entry) => ({
      key: entry.key,
      id: proxyIdFromKey(entry.key) ?? entry.key,
      version: entry.version,
      updatedAt: entry.updatedAt,
      record: readProxy(entry.value),
    }))

    /**
     * The second read, and it is deliberately allowed to fail on its own. This
     * pack's service is what answers it, and a service that is stopped, still
     * starting, or disabled by the error budget must not take the stored
     * catalogue down with it — the records are storage and are still perfectly
     * editable. What is lost is the observation, and the row says so in the one
     * word that is true (`unknown`) rather than borrowing one that is not.
     */
    let statuses = new Map<string, ProxyStatus>()
    let statusError: string | null = null
    try {
      statuses = readProxyStatuses(await api(`${PROXY_HTTP_API}/proxies`, ProxyStatusPageSchema))
    } catch (e: unknown) {
      statusError = e instanceof Error ? e.message : String(e)
    }

    /**
     * Which records have a credential — a third read, of the OTHER prefix.
     *
     * It exists because "leave this empty to keep the saved password" is
     * meaningless to someone who cannot tell whether one is saved. What comes
     * back is keys: `list()` never decrypts, so `value` is `null` on every one
     * of these rows and `hint` is null too because they were written with
     * `hint: false`. There is no shape of this request that could return more.
     *
     * A failure here is not worth a banner — the fallback is a dialog that says
     * nothing about a stored password instead of something wrong about one.
     */
    const secrets = new Set<string>()
    try {
      const page = await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_SECRET_KEY_PREFIX)}&limit=200`, KvPageSchema)
      for (const entry of page.items) {
        if (entry.key.startsWith(PROXY_SECRET_KEY_PREFIX)) secrets.add(entry.key.slice(PROXY_SECRET_KEY_PREFIX.length))
      }
    } catch {
      // Deliberately silent: see above.
    }

    /**
     * The fourth read, of the FOURTH prefix — what `service/probe.ts` last
     * observed dialling out through each record (plan 117 §3.7, §4.5). Not
     * secret, unlike the read above: a public address and a latency are not a
     * credential, so `value` here is the whole `ProxyProbeResult` rather than
     * `null`.
     *
     * Same failure discipline as every other read on this screen: a service
     * that has not run a probe sweep yet, or is stopped, must not take the
     * catalogue table down — a record simply reads `unverified`, which is the
     * honest answer for "nothing has confirmed this yet" either way.
     */
    let probes = new Map<string, ProxyProbeResult>()
    try {
      probes = readProxyProbes(await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_PROBE_KEY_PREFIX)}&limit=200`, KvPageSchema))
    } catch {
      // Deliberately silent: see above.
    }
    return { rows, statuses, statusError, secrets, probes }
  }, [])
  const { data, error, loading, reload } = useLoader(load, [])

  const [draft, setDraft] = useState<Draft | null>(null)
  const [pasting, setPasting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Row | null>(null)
  const [pendingForce, setPendingForce] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)

  /**
   * Start, stop, restart — one function, because they differ only in the word
   * in the URL and the sentence in the toast.
   *
   * `useAction` is `@enkaku/ui`'s (plan 111 §3.3): it owns the pending key and
   * the toast, which is why this pack does not import `toast` — the package
   * deliberately does not export one, and a per-action pending key is what lets
   * one row's Start spin without freezing every other row's.
   *
   * Every one of these lands on `POST …/http/<verb>/<id>` — one handler per
   * verb, behind the core's auth and audit — never on a KV write that the
   * service would have to poll for. That shortcut is refused in plan 112 §4.6
   * by name. Acting needs `plugin.runtime` where reading the list needs only
   * `script.view`, which is the reason the verbs are their own handlers at all.
   */
  const { run, isPending } = useAction()

  function control(row: Row, verb: 'start' | 'stop' | 'restart', body?: { force: boolean }): void {
    const name = row.record.label || row.key
    const success =
      verb === 'start'
        ? `Starting “${name}” — the row reports what the bridge is actually doing`
        : verb === 'restart'
          ? `Restarting “${name}”`
          : body?.force
            ? `Force-stopping “${name}” — connections still open were destroyed, not drained`
            : `Stopping “${name}” — the port is released now, live tunnels have until the drain runs out`
    void run(
      actionKey(row.id, verb, body?.force),
      () => api(proxyActionPath(verb, row.id), IgnoredSchema, { method: 'POST', json: body ?? {} }),
      {
        success,
        failure: `Could not ${verb} “${name}”`,
        onSuccess: () => {
          setPendingForce(null)
          reload()
        },
      },
    )
  }

  /**
   * The manual "Reset to primary" action (plan 121 §4.5, step 121.6) —
   * `FailoverChip`'s own button. Always available while a record is on a
   * backup, regardless of `autoFailback` (§4.5's own wording — an operator
   * may want to force it back sooner than the auto-recovery streak would),
   * so this is not gated on anything the row itself does not already gate:
   * the chip that calls it only renders when `activeIndex !== 0` in the
   * first place.
   */
  function resetFailover(row: Row): void {
    const name = row.record.label || row.key
    void run(actionKey(row.id, 'reset-failover'), () => api(proxyActionPath('reset-failover', row.id), IgnoredSchema, { method: 'POST' }), {
      success: `“${name}” reset to primary`,
      failure: `Could not reset “${name}” to primary`,
      onSuccess: () => reload(),
    })
  }

  /**
   * The filter is a plain client-side `includes` over the page already
   * fetched, and says so in its placeholder rather than implying a search of
   * the whole namespace: the list route is capped at 200 rows, so a farm with
   * more proxies than that would have this box quietly miss them.
   */
  const rows = useMemo(() => {
    const all = data?.rows ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((row) => `${row.key} ${row.record.label} ${row.record.upstream.host} ${row.record.notes}`.toLowerCase().includes(needle))
  }, [data, query])

  const statuses = data?.statuses ?? EMPTY_STATUSES
  const probes = data?.probes ?? EMPTY_PROBES

  /**
   * A bridge that is `starting` or `stopping` is on its way somewhere by
   * itself, so the screen goes and looks again. Without this a drain would sit
   * on the word `stopping` until an operator pressed something — which is
   * exactly the moment they are watching to see whether it finished.
   *
   * A record currently on a BACKUP upstream joins this same condition (plan
   * 121 §4.5, step 121.6) — it too is something that can change on its own
   * (a background primary-recovery probe, another operator's manual reset)
   * without anybody pressing anything here, and `FailoverChip` has no other
   * way to learn that: there is no WS surface this pack's UI can reach (see
   * `failover-chip.tsx`'s own header for the full account of why). Reusing
   * this existing poll rather than adding a second one keeps the "settled
   * catalogue is not polled" property true for the far more common case —
   * this only fires while a record's own failover state is genuinely
   * interesting.
   *
   * `null` when nothing is in flight: a settled catalogue is not polled.
   */
  const transitional = rows.some((row) => {
    const status = statuses.get(row.id)
    return status?.state === 'starting' || status?.state === 'stopping' || (status?.failover != null && status.failover.activeIndex !== 0)
  })
  usePoll(reload, transitional ? 1500 : null)

  /**
   * Every row, so `validateProxyRecord` can answer `E_PROXY_PORT_CONFLICT` —
   * which is the one refusal that cannot be decided from a record alone. The
   * supervisor asks the same question again at start, against the catalogue as
   * it is then, so a record edited around this screen still cannot bind.
   */
  const catalogue = useMemo(() => (data?.rows ?? []).map((row) => ({ id: row.id, record: row.record })), [data])

  /**
   * Two writes, in this order, and the order is a decision.
   *
   * The record goes first because it is the thing: a record whose credential
   * write then failed dials without a password and fails visibly on its own
   * row, which is a state this pack already words honestly. The other order
   * would leave `proxy-secret:<id>` attached to a record that does not exist —
   * invisible in a catalogue that lists only the `proxy:` prefix, and picked up
   * silently by the next record that happens to derive the same key.
   *
   * The credential write is reported separately when it is the half that
   * failed, because "could not save" over a record that WAS saved is the
   * message that makes an operator press Save again and change nothing.
   */
  async function save(next: Draft): Promise<void> {
    setBusy(true)
    setWriteError(null)
    try {
      await putRecord(next.key, next)
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
      setBusy(false)
      return
    }
    try {
      const id = proxyIdFromKey(next.key) ?? next.key
      if (next.password.length > 0) await putSecret(id, next.password)
      else if (next.clearPassword) await deleteEntry(proxySecretKeyFor(id))
      // Every configured backup's own credential, one slot at a time (plan
      // 121 §4.1/§4.5, step 121.4/121.6) — the same "type to replace, tick to
      // remove, empty means leave it alone" rule the primary's password
      // already follows, just addressed by slot instead of by the bare key.
      for (let index = 0; index < next.fallbackUpstreams.length; index += 1) {
        const slot = index + 1
        const password = next.fallbackPasswords[slot] ?? ''
        if (password.length > 0) await putSecretSlot(id, slot, password)
        else if (next.clearFallbackPasswords[slot]) await deleteEntry(proxySecretSlotKeyFor(id, slot))
      }
      setDraft(null)
      reload()
    } catch (e: unknown) {
      setWriteError(`The record was saved and its password was not: ${e instanceof Error ? e.message : String(e)}`)
      reload()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Both keys, because a record is two rows.
   *
   * A delete that took only `proxy:<id>` would leave the credential behind — a
   * row nothing lists, that the next record deriving the same key would inherit
   * without anyone choosing it. The credential delete is allowed to fail
   * quietly: there usually is not one, and `DELETE` on a key that does not
   * exist is not an event worth a banner.
   */
  async function remove(row: Row): Promise<void> {
    setBusy(true)
    setWriteError(null)
    try {
      await deleteEntry(row.key)
      await deleteEntry(proxySecretKeyFor(row.id)).catch(() => {})
      setPendingDelete(null)
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const forceState = pendingForce ? (statuses.get(pendingForce.id)?.state ?? 'unknown') : 'unknown'

  return (
    /**
     * `@container`, not a viewport breakpoint.
     *
     * Every width decision below is about the box this screen is in, and this
     * screen does not know how wide that box is: Studio's plugin view is a wide
     * page today, and the same component is one embed away from a narrow panel.
     * A `lg:` here would fire on the WINDOW and be a claim about something else
     * entirely — which is exactly how a panel written for a wide page ends up
     * broken inside a 672 px dialog.
     */
    <div className="@container space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter the rows below by name, host or note"
          className="h-8 max-w-xs text-[12.5px]"
          aria-label="Filter proxies"
        />
        <span className="readout text-[11.5px] text-fg-muted">
          {rows.length} of {data?.rows.length ?? 0}
        </span>
        <div className="grow" />
        <Button variant="outline" size="sm" onClick={reload}>
          Refresh
        </Button>
        {/*
          The owner's own ask — *"biar ga input manual satu persatu"* — and it
          sits BESIDE Add rather than replacing it, because the same message
          asked for both: *"tapi opsi input satu persatu juga tetap ada gitu"*.
          One line or forty go through the same door.
        */}
        <Button variant="outline" size="sm" onClick={() => setPasting(true)}>
          Paste list
        </Button>
        {/*
          §3.9's own ask — twenty rows from a stated pattern, not twenty
          presses of Add proxy — and it sits beside the other two doors for the
          same reason Paste list does: one line, forty lines, or a generated
          range all go through the same door and none replaces another.
        */}
        <Button variant="outline" size="sm" onClick={() => setGenerating(true)}>
          Generate range
        </Button>
        <Button size="sm" onClick={() => setDraft(BLANK)}>
          Add proxy
        </Button>
      </div>

      {writeError ? <ErrorState message={writeError} onRetry={() => setWriteError(null)} /> : null}

      {/*
        The runtime read failed and the stored one did not. This is a note, not
        an `ErrorState`: the catalogue below is complete and editable, and the
        one thing that is missing — what each bridge is doing — is named rather
        than filled in with a guess. Every state cell reads `Unknown` while this
        is up, which is the same fact said twice on purpose: once for the tab,
        once on the row an operator is looking at.
      */}
      {data?.statusError ? (
        <p className="rounded-lg border border-led-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
          The farm did not report what these bridges are doing, so every state below reads <span className="readout">unknown</span> rather than a
          guess. The records are stored and can still be edited. <span className="readout">{data.statusError}</span>
        </p>
      ) : null}

      {/*
        `loading && !data` — the skeleton is for the FIRST load only. A reload
        (a control, or the 1.5 s poll while a bridge is starting or draining)
        keeps the table on screen: replacing the rows an operator is watching
        with grey blocks twice a second is how a working screen looks broken.
      */}
      {loading && !data ? (
        <LoadingRows />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={data && data.rows.length > 0 ? 'No proxy matches that filter' : 'No proxies saved yet'}
          description={data && data.rows.length > 0 ? 'Clear the filter to see every saved record.' : CATALOGUE_EMPTY_HINT}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {/*
                  Column visibility by CONTAINER width. Name, State and the
                  controls are always present — they are what the screen is for
                  — and everything else appears as the box grows. Nothing is
                  merely pushed off the right-hand edge: at the narrowest width
                  the listen address moves under the name, so the row still says
                  where the bridge is.
                */}
                {/*
                  The widths are container-conditional too, and that is not
                  belt-and-braces. A `w-56` on a column is a PREFERRED width
                  that a browser will not shrink below in an auto-layout table,
                  so a fixed width that is fine at 900 px is what pushes the
                  table past the edge at 360 px — measured, not assumed. Below
                  the breakpoint the columns size themselves.
                */}
                <TableHead className="@2xl:w-56">State</TableHead>
                <TableHead className="hidden @3xl:table-cell @3xl:w-44">Listens on</TableHead>
                <TableHead className="hidden @4xl:table-cell @4xl:w-56">Upstream</TableHead>
                <TableHead className="hidden @5xl:table-cell @5xl:w-48">Egress</TableHead>
                <TableHead className="hidden @2xl:table-cell @2xl:w-24">Intent</TableHead>
                <TableHead className="hidden @6xl:table-cell">Notes</TableHead>
                <TableHead className="hidden @5xl:table-cell @5xl:w-32">Updated</TableHead>
                <TableHead className="text-right @2xl:w-52">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                // Both kinds, and they are drawn differently on purpose: a
                // refusal is a choice the product will not honour, a
                // precondition is a fact that is not true yet (plan 59). A
                // migrated row with no local port is the second, and rendering
                // it as an error would be a lie about whose fault it is.
                const problems = validateProxyRecord(row.record, { id: row.id, catalogue })
                const refusals = problems.filter((p) => p.kind === 'refusal')
                const preconditions = problems.filter((p) => p.kind === 'precondition')
                const status = statuses.get(row.id) ?? null
                const state = status?.state ?? 'unknown'
                const startable = isStartableRecord(problems)
                const settling = isPending(actionKey(row.id, 'start')) || isPending(actionKey(row.id, 'stop')) || isPending(actionKey(row.id, 'stop', true)) || isPending(actionKey(row.id, 'restart'))
                return (
                  <TableRow key={row.key}>
                    {/*
                      No `truncate` anywhere in a table cell. `TableCell` wraps
                      with `wrap-anywhere` on purpose (its own doc says why),
                      and a `truncate` inside one puts `white-space: nowrap`
                      back — which makes the column's min-content the whole
                      string and forces the table wider than its container. The
                      long values here are keys and hostnames, and they break.
                    */}
                    <TableCell className="min-w-0">
                      <div className="font-medium">{row.record.label || '—'}</div>
                      {/* `.readout` is `white-space: nowrap` by design — a
                          measurement belongs on one line — and a storage key is
                          not a measurement: it can be 256 characters, and under
                          nowrap that is the column's min-content width. */}
                      <div className="readout wrap-anywhere whitespace-normal text-[11px] text-fg-muted">{row.key}</div>
                      {/* At the narrowest width the "Listens on" column is gone, so the address comes here instead of disappearing. */}
                      <div className="readout text-[11px] text-fg-muted @3xl:hidden">
                        {row.record.listen.port === null ? 'no local port' : `${row.record.listen.bindHost}:${row.record.listen.port}`}
                      </div>
                    </TableCell>

                    <TableCell className="min-w-0 align-top">
                      <StateCell state={state} status={status} refusals={refusals} preconditions={preconditions} />
                      {/* Per-item, quiet-by-default (plan 121 §4.5, step 121.6) — renders nothing while this record is dialling its own primary. */}
                      <FailoverChip
                        label={row.record.label || row.key}
                        failover={status?.failover ?? null}
                        resetting={isPending(actionKey(row.id, 'reset-failover'))}
                        onReset={() => resetFailover(row)}
                      />
                    </TableCell>

                    <TableCell className="hidden @3xl:table-cell">
                      {row.record.listen.port === null ? (
                        <span className="text-[11.5px] text-fg-muted">Needs a local port</span>
                      ) : (
                        <span className="readout">
                          <Badge variant="outline">{LISTEN_PROTO_LABELS[row.record.listen.proto]}</Badge>{' '}
                          {row.record.listen.bindHost}:{row.record.listen.port}
                        </span>
                      )}
                    </TableCell>

                    {/* Same `.readout` trap: a hostname and a sticky-session
                        username are long, and on the cell itself they would set
                        this column's min-content to the whole string. */}
                    <TableCell className="readout wrap-anywhere hidden min-w-0 whitespace-normal @4xl:table-cell">
                      {row.record.upstream.proto === 'direct' ? (
                        // 117.5's own leftover bug (§3.1 point 2, step 117.9):
                        // this branch used to fall through to the one below,
                        // which reads `PROXY_KIND_LABELS[proto]` followed by
                        // `upstream.host` — "Direct —", because a `direct`
                        // record has no host. `describeDirectUpstream` is the
                        // one place these words are written (`shared.ts`),
                        // the same one `service/upstream.ts`'s own dial and
                        // `reportListener` description read them from.
                        describeDirectUpstream(row.record.upstream.bindAddress, row.record.upstream.resolveThroughEgress)
                      ) : (
                        <>
                          <Badge variant="outline">{PROXY_KIND_LABELS[row.record.upstream.proto]}</Badge> {row.record.upstream.host || '—'}
                          {row.record.upstream.port ? `:${row.record.upstream.port}` : ''}
                          {row.record.upstream.username ? <span className="ml-1 text-fg-muted">as {row.record.upstream.username}</span> : null}
                        </>
                      )}
                    </TableCell>

                    <TableCell className="hidden min-w-0 align-top @5xl:table-cell @5xl:w-48">
                      <ProbeCell probe={probes.get(row.id) ?? null} />
                    </TableCell>

                    <TableCell className="hidden @2xl:table-cell">
                      {/* INTENT, next to the state and never merged with it
                          (plan 112 §3.5). `Enabled` means "this should be
                          listening" and is what a restart restores; the State
                          cell says what is actually happening. A record that
                          says Enabled and reads Failed is the interesting row
                          on this screen, and it only exists because these are
                          two columns. */}
                      <Badge
                        variant={row.record.enabled ? 'default' : 'outline'}
                        title={row.record.enabled ? 'Stored intent: the farm starts this bridge when the plugin loads.' : 'Stored intent: the farm does not start this bridge on its own.'}
                      >
                        {row.record.enabled ? 'Enabled' : 'Off'}
                      </Badge>
                    </TableCell>

                    <TableCell className="hidden text-fg-muted @6xl:table-cell">
                      <span className="line-clamp-2" title={row.record.notes}>
                        {row.record.notes || '—'}
                      </span>
                    </TableCell>
                    <TableCell className="readout hidden text-[11.5px] whitespace-nowrap text-fg-muted @5xl:table-cell">{relativeTime(row.updatedAt)}</TableCell>

                    <TableCell className="align-top">
                      {/* Wraps to as many lines as the box needs at the
                          narrowest widths — three tiny buttons stacked is a
                          usable row, and a row that scrolls sideways is not.
                          One line as soon as there is room for one. */}
                      <div className="flex flex-wrap items-center justify-end gap-1 @2xl:flex-nowrap">
                        {/*
                          One primary control per row, and it says what it will
                          do to THIS bridge. Stop is the drain (the port frees
                          at once, live tunnels get `drainMs`); Force stop is a
                          separate, named action in the menu, because burying a
                          ten-second wait behind the same button is what makes
                          Stop feel broken — and because destroying somebody's
                          download deserves its own press (plan 112 §3.7).
                        */}
                        {state === 'running' || state === 'starting' || state === 'stopping' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={settling || state === 'stopping'}
                            title={state === 'stopping' ? 'Already draining. Force stop, in the menu, destroys what is left now.' : `Stop accepting, then close what is left after ${millis(row.record.drainMs)}`}
                            onClick={() => control(row, 'stop')}
                          >
                            Stop
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={settling || !startable || !!data?.statusError}
                            title={startable ? 'Bind the listener now' : (problems[0]?.message ?? '')}
                            onClick={() => control(row, 'start')}
                          >
                            Start
                          </Button>
                        )}

                        {/* The owner's own question — "kenapa ga ada tombol buat liat logs?" — answered on the row it is about, not only as a tab. */}
                        <Button variant="ghost" size="sm" onClick={() => onShowLogs(row.id)} title="This proxy's own lines, filtered out of the one log this plugin keeps">
                          Logs
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" aria-label={`More actions for ${row.record.label || row.key}`}>
                              More
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem disabled={settling || !startable} onSelect={() => control(row, 'restart')}>
                              Restart
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" disabled={settling || state === 'stopped' || state === 'failed'} onSelect={() => setPendingForce(row)}>
                              Force stop
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onSelect={() =>
                                setDraft({ ...row.record, key: row.key, isNew: false, keyTouched: true, password: '', clearPassword: false, fallbackPasswords: {}, clearFallbackPasswords: {} })
                              }
                            >
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(row)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ProxyDialog
        draft={draft}
        catalogue={catalogue}
        takenKeys={data?.rows.map((row) => row.key) ?? []}
        secrets={data?.secrets ?? EMPTY_SECRETS}
        busy={busy}
        onCancel={() => setDraft(null)}
        onSave={save}
      />

      <PasteDialog
        open={pasting}
        catalogue={catalogue}
        takenKeys={data?.rows.map((row) => row.key) ?? []}
        onCancel={() => setPasting(false)}
        onDone={(close) => {
          reload()
          if (close) setPasting(false)
        }}
      />

      <GenerateDialog
        open={generating}
        catalogue={catalogue}
        takenKeys={data?.rows.map((row) => row.key) ?? []}
        onCancel={() => setGenerating(false)}
        onDone={(close) => {
          reload()
          if (close) setGenerating(false)
        }}
      />

      {/*
        Force stop, confirmed — and the confirmation says what a client sees,
        because there is no in-band way for a proxy to tell one anything. An
        app inside a CONNECT tunnel gets a TCP reset mid-response; it does not
        get a message, and it does not get a retry.
      */}
      <Dialog open={pendingForce !== null} onOpenChange={(open) => !open && setPendingForce(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force stop “{pendingForce?.record.label || pendingForce?.key}”?</DialogTitle>
            <DialogDescription>
              Force stop skips the drain: every connection this bridge is carrying right now is destroyed immediately, and whatever is on the other end
              sees a dropped connection mid-response rather than an error it can explain.
              {forceState === 'stopping'
                ? ' This bridge is already draining — this ends the wait now.'
                : ` Plain Stop releases the port at once and gives live tunnels ${millis(pendingForce?.record.drainMs ?? DEFAULT_DRAIN_MS)} to finish.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingForce(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => pendingForce && control(pendingForce, 'stop', { force: true })} disabled={pendingForce ? isPending(actionKey(pendingForce.id, 'stop', true)) : false}>
              Force stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{pendingDelete?.record.label || pendingDelete?.key}”?</DialogTitle>
            <DialogDescription>
              It is removed from the catalogue. Stop it first if you want the port released and its tunnels closed at a moment you choose — deleting the
              row is a write to storage and is not a stop. No device is reconfigured: pointing one at a proxy is the Assignments tab’s Apply, and
              nothing here undoes it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => pendingDelete && void remove(pendingDelete)} disabled={busy}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * The state cell: one word for what the bridge is doing, and one line under it
 * for the thing that word does not say.
 *
 * The order below is the order an operator needs it in. A failure reason beats
 * a connection count; a refusal beats a failure, because a record that cannot
 * be started is not a bridge that failed to start; and a precondition is muted
 * rather than red, because nothing went wrong — something has not happened yet
 * (plan 59).
 */
function StateCell({
  state,
  status,
  refusals,
  preconditions,
}: {
  state: keyof typeof PROXY_STATE_LABELS
  status: ProxyStatus | null
  refusals: readonly ProxyProblem[]
  preconditions: readonly ProxyProblem[]
}) {
  const live = status?.liveConnections ?? 0
  /**
   * `uptimeMs` is the farm's own figure and is `null` for anything that is not
   * running — an uptime beside a bridge that is draining or failed is a number
   * that reads as a lie. `since` is the fallback for a farm that answered the
   * older flat shape, and it is in milliseconds while `duration` counts in
   * seconds.
   */
  const upSeconds = status?.uptimeMs != null ? Math.floor((Date.now() - status.uptimeMs) / 1000) : null
  /** How long the CURRENT state has lasted — which for a drain is the only number that means anything. */
  const sinceSeconds = status?.since ? Math.floor(status.since / 1000) : null
  const detail =
    state === 'running'
      ? `${live} live${upSeconds === null ? '' : ` · up ${duration(upSeconds, null)}`}`
      : state === 'stopping'
        ? `${live} live · draining${sinceSeconds === null ? '' : ` ${duration(sinceSeconds, null)}`}`
        : undefined
  const refusal = refusals[0]
  const precondition = preconditions[0]
  return (
    <div className="min-w-0 space-y-0.5">
      <ProxyStateBadge state={state} label={PROXY_STATE_LABELS[state]} detail={detail} />
      {/*
        `line-clamp-2`, never `truncate`: clamping needs text that is allowed to
        wrap, and wrapping is what keeps this column's min-content small enough
        that the table fits its container. The full sentence is on `title`.
      */}
      {refusal ? (
        <div className="line-clamp-2 text-[11px] text-destructive" title={refusal.message}>
          <span className="readout wrap-anywhere whitespace-normal">{refusal.code}</span> {refusal.message}
        </div>
      ) : status?.lastError ? (
        <div className="line-clamp-2 text-[11px] text-fg-muted" title={status.lastError.message}>
          <span className="readout wrap-anywhere whitespace-normal">{status.lastError.code}</span> {status.lastError.message}
        </div>
      ) : precondition ? (
        <div className="line-clamp-2 text-[11px] text-fg-muted" title={precondition.message}>
          {precondition.message}
        </div>
      ) : status && status.totalConnections > 0 ? (
        <div className="line-clamp-2 text-[11px] text-fg-muted">
          {status.totalConnections} total · {fileSize(status.bytesUp)} up · {fileSize(status.bytesDown)} down
        </div>
      ) : null}
    </div>
  )
}

/**
 * The Egress column — what `service/probe.ts` last observed dialling out
 * through this record's own upstream (plan 117 §3.7, step 117.9).
 *
 * **`proxyProbeState` is the one function that decides the word** (`shared.ts`,
 * imported from plan 51's own vocabulary), and this component only ever
 * renders its answer — never `probe.ok` directly, and never any word of its
 * own. That is what makes acceptance criterion 10 true structurally rather
 * than by care taken here: a record that has not passed a probe is
 * `unverified` regardless of whether it was never probed or the last probe
 * failed, `skip` reads as `skip` and nothing else, and only `confirmed` may
 * ever sit beside an address.
 */
function ProbeCell({ probe }: { probe: ProxyProbeResult | null }) {
  const state = proxyProbeState(probe)
  // `probe.at` is unix SECONDS (`shared.ts`'s own `ProxyProbeResult` doc) —
  // the same unit `relativeTime` already takes everywhere else on this
  // screen, so this is not a conversion, only a read.
  const checkedAt = probe ? relativeTime(probe.at) : null
  return (
    <div className="min-w-0 space-y-0.5">
      <Badge variant={state === 'confirmed' ? 'default' : 'outline'}>{PROXY_PROBE_STATE_LABELS[state]}</Badge>
      {state === 'confirmed' && probe?.publicAddress ? (
        <div className="readout wrap-anywhere text-[11px] text-fg-muted">
          {probe.publicAddress}
          {probe.latencyMs !== undefined ? ` · ${Math.round(probe.latencyMs)} ms` : ''}
        </div>
      ) : state === 'unverified' && probe?.error ? (
        // The reason a probe failed — never the reason it was never run at
        // all (that case has no `error` to show), and never worded as a
        // pass: `line-clamp-2`, not `truncate`, for the same reason every
        // other reason column on this screen uses it.
        <div className="line-clamp-2 text-[11px] text-fg-muted" title={probe.error}>
          {probe.error}
        </div>
      ) : null}
      {checkedAt ? <div className="text-[11px] text-fg-muted">Checked {checkedAt}</div> : null}
    </div>
  )
}

/**
 * One dialog for Add and Edit, because they write the same shape and differ in
 * exactly one thing: whether the storage key can be typed.
 *
 * This is the half plan 111 §4.3 called "a form that is more than a flat
 * schema" — tier A drew it from `z.toJSONSchema(AddFormSchema)` through the
 * shared resolver, which is genuinely good and genuinely fixed. Here the key
 * field carries its own live hint about the prefix, the port is bounded by the
 * input rather than by prose, and Add and Edit are one component instead of
 * two declarations that have to be kept in step.
 */
function ProxyDialog({
  draft,
  catalogue,
  takenKeys,
  secrets,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft | null
  catalogue: readonly { id: string; record: ProxyRecord }[]
  /** Every storage key already in the catalogue — what the derived key steps around and what a typed one is refused against. */
  takenKeys: readonly string[]
  /** Which record ids have a credential row. Keys only; see `Loaded.secrets`. */
  secrets: ReadonlySet<string>
  busy: boolean
  onCancel: () => void
  onSave: (draft: Draft) => Promise<void>
}) {
  const [local, setLocal] = useState<Draft>(BLANK)
  const [openedFor, setOpenedFor] = useState<Draft | null>(null)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  // Every local port the catalogue already claims — the input to the seeded
  // port below. Read from the records rather than from the supervisor, because
  // a record that is saved but stopped still owns its port: handing it to a new
  // record would produce an `EADDRINUSE` the moment the first one is started.
  const claimedPorts = useMemo(() => {
    const taken = new Set<number>()
    for (const entry of catalogue) if (entry.record.listen.port !== null) taken.add(entry.record.listen.port)
    return taken
  }, [catalogue])

  // Reset when a different row is opened, without a `useEffect`: React's own
  // "adjusting state when a prop changes" pattern, which renders once instead
  // of twice and never shows the previous row's values for a frame.
  if (draft !== openedFor) {
    setOpenedFor(draft)
    if (draft) {
      // A NEW record opens with a local port already chosen — the lowest free
      // one from `DEFAULT_LOCAL_PORT_BASE` up, skipping every port the
      // catalogue already claims. The field stays editable; this is a starting
      // value, not a decision taken away.
      //
      // It matters because the port is the one field a record cannot start
      // without (`E_PROXY_PORT_UNASSIGNED`), and it is also the one an operator
      // has no way to guess correctly: picking a free one means knowing what
      // every other record already took. The bulk paste has assigned ports this
      // way since it was built; leaving the single dialog to a placeholder made
      // the easy path the one that fails validation.
      //
      // An EDIT keeps whatever the record has, including `null` on a row
      // migrated from the pre-plan-112 shape — that row genuinely has no port
      // and inventing one here would hide the very thing the catalogue is
      // asking the operator to fix.
      const seeded =
        draft.isNew && draft.listen.port === null
          ? { ...draft, listen: { ...draft.listen, port: nextFreeLocalPort(claimedPorts) } }
          : draft
      setLocal(seeded)
      setPaste('')
      setPasteError(null)
    }
  }

  /**
   * The key, worked out rather than typed (the owner's first complaint).
   *
   * Derived on every render from the name while the operator has not taken it
   * over, so what the dialog shows is what will actually be written — including
   * the `-2` a collision earns, which is the point: a suffix an operator sees
   * before saving is a decision, and one they discover afterwards is a
   * surprise.
   *
   * `takenKeys` minus this row's own key, so re-deriving on an existing record
   * does not treat the record as its own collision.
   */
  const otherKeys = useMemo(() => takenKeys.filter((key) => key !== local.key), [takenKeys, local.key])
  const derivedKey = useMemo(() => (local.label.trim().length > 0 ? deriveProxyKey(local.label, otherKeys) : ''), [local.label, otherKeys])
  // Empty until there is a name to derive from: showing `proxy:untitled` over an
  // empty Name field would advertise the fallback as the plan rather than as
  // what happens to a name that slugs to nothing.
  const effectiveKey = local.isNew && !local.keyTouched ? derivedKey : local.key
  /** The plain form the name makes, so the dialog can tell "suffixed because taken" from "this is just the name". */
  const plainKey = local.label.trim().length > 0 ? `${PROXY_KEY_PREFIX}${slugifyProxyName(local.label)}` : ''
  const keyWasSuffixed = local.isNew && !local.keyTouched && plainKey.length > PROXY_KEY_PREFIX.length && effectiveKey !== plainKey
  /** A key the operator typed that already exists. Refused rather than allowed to replace a row they cannot see from here. */
  const keyIsTaken = local.isNew && local.keyTouched && otherKeys.includes(effectiveKey.trim())
  const keyLooksWrong = local.isNew && local.keyTouched && !effectiveKey.startsWith(PROXY_KEY_PREFIX)

  const editingId = local.isNew ? null : (proxyIdFromKey(local.key) ?? local.key)
  const hasStoredPassword = editingId !== null && secrets.has(editingId)

  /**
   * One line, into the fields below (`PROXY_PASTE_SINGLE_HINT`).
   *
   * It fills; it never saves. The same parser the bulk dialog uses, so the
   * grammar an operator learns in one place is the grammar that holds in the
   * other — and the refusal is the parser's own sentence, which names the rule
   * and quotes nothing.
   */
  function fillFromPaste(): void {
    const parsed = parseProxyLine(paste, { defaultProto: local.upstream.proto })
    if (!parsed.ok) {
      setPasteError(parsed.reason)
      return
    }
    const proxy = parsed.proxy
    setPasteError(null)
    setPaste('')
    setLocal((current) => ({
      ...current,
      label: current.label.trim().length > 0 ? current.label : suggestProxyName(proxy),
      // A pasted line describes a REMOTE proxy, so it carries no egress binding;
      // whatever the draft already had for those two is kept rather than reset.
      upstream: { proto: proxy.proto, host: proxy.host, port: proxy.port, username: proxy.username, bindAddress: current.upstream.bindAddress, resolveThroughEgress: current.upstream.resolveThroughEgress },
      // An empty password in a pasted line must not silently wipe a stored one:
      // it means the line carried none, which is not the same as *remove it*.
      password: proxy.password.length > 0 ? proxy.password : current.password,
    }))
  }

  // `direct` names no remote party (§3.1) — requiring a host for it would be
  // exactly the requirement plan 117.4's own correction found never existed in
  // `validateProxyRecord`, reintroduced here by a gate that had not caught up.
  // Every other upstream kind still needs a host to dial.
  const incomplete =
    effectiveKey.trim().length === 0 || local.label.trim().length === 0 || (local.upstream.proto !== 'direct' && local.upstream.host.trim().length === 0)

  /**
   * The same four coded refusals the supervisor applies at start, applied here
   * at write — never only at start, or a record saved through this dialog
   * would be refused later by something the operator cannot see (plan 112
   * §4.2). A refusal blocks Save and names itself; a precondition does not,
   * because a record with no local port is perfectly storable and simply
   * cannot listen yet.
   */
  const problems = validateProxyRecord(local, { id: proxyIdFromKey(effectiveKey) ?? effectiveKey, catalogue })
  const refusals = problems.filter((p) => p.kind === 'refusal')
  const preconditions = problems.filter((p) => p.kind === 'precondition')

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{local.isNew ? 'Add proxy' : `Edit ${local.label || local.key}`}</DialogTitle>
          <DialogDescription>
            Saving records a bridge. The farm starts every record marked enabled when this plugin loads; Start and Stop on the row drive one bridge now,
            without changing what is stored.
          </DialogDescription>
        </DialogHeader>

        <div className="@container space-y-3">
          {/*
            One line in, the fields below filled — the owner's format ask, in
            the dialog they were complaining about. It is deliberately ABOVE the
            fields and deliberately not the only way in: this fills, the fields
            below are still typed, and nothing is written either way until Save.
          */}
          {local.isNew ? (
            <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
              <Label htmlFor="pm-paste" className="text-[13px] font-normal">
                Paste a proxy
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="pm-paste"
                  value={paste}
                  onChange={(e) => {
                    setPaste(e.target.value)
                    setPasteError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      fillFromPaste()
                    }
                  }}
                  placeholder={PROXY_PASTE_FORMATS[0]}
                  className="readout min-w-0 grow"
                  // A pasted line carries a password, so the browser must not be
                  // invited to remember it or to offer it back on another form.
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button variant="outline" size="sm" disabled={paste.trim().length === 0} onClick={fillFromPaste}>
                  Fill fields
                </Button>
              </div>
              <p className="text-[11.5px] leading-relaxed text-fg-muted">
                {PROXY_PASTE_SINGLE_HINT} Accepted: <span className="readout wrap-anywhere whitespace-normal">{PROXY_PASTE_FORMATS.join('  ·  ')}</span>
              </p>
              {pasteError ? <p className="text-[11.5px] leading-relaxed text-destructive">Not read: {pasteError}.</p> : null}
            </div>
          ) : null}

          {/*
            The storage key, DERIVED (the owner's first complaint).

            It is a readout and a disclosure rather than a required field: the
            key is where the row lives, which is the storage's business, and the
            operator's business is the name. The override survives because the
            key is the record's identity — the start/stop routes, the log tag
            and the credential key are all derived from it — so somebody who
            needs to name it must be able to.
          */}
          {local.isNew ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[13px]">Filed as</span>
                <span className="readout wrap-anywhere min-w-0 whitespace-normal text-[12px]">{effectiveKey || `${PROXY_KEY_PREFIX}…`}</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-fg-muted">{keyWasSuffixed ? PROXY_KEY_COLLISION_HINT : PROXY_KEY_DERIVED_HINT}</p>
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 px-1 text-[11.5px] text-fg-muted">
                    Storage key
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1.5 pt-1.5">
                  <Input
                    id="pm-key"
                    value={effectiveKey}
                    onChange={(e) => setLocal({ ...local, key: e.target.value, keyTouched: true })}
                    className="readout"
                    aria-label="Storage key"
                  />
                  <p className="text-[11.5px] leading-relaxed text-fg-muted">{PROXY_KEY_HINT}</p>
                  {local.keyTouched ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1 text-[11.5px] text-fg-muted"
                      onClick={() => setLocal({ ...local, key: '', keyTouched: false })}
                    >
                      Go back to the key made from the name
                    </Button>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
              {keyIsTaken ? <p className="text-[11.5px] leading-relaxed text-destructive">{PROXY_KEY_TAKEN_HINT}</p> : null}
              {keyLooksWrong ? <p className="text-[11.5px] leading-relaxed text-fg-muted">{PROXY_KEY_HINT}</p> : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[13px]">Filed as</span>
                <span className="readout wrap-anywhere min-w-0 whitespace-normal text-[12px]">{local.key}</span>
              </div>
              {/* Locked, and it says why — a change here would not rename this
                  record, it would create a second one and abandon this one's
                  credential row. */}
              <p className="text-[11.5px] leading-relaxed text-fg-muted">{PROXY_KEY_LOCKED_HINT}</p>
            </div>
          )}

          {/* The plugin's OWN Tailwind class, and one Studio has never compiled:
              a two-column field grid sized to its labels. If `ui/index.css` did
              not reach the page these two fields would stack, which is exactly
              the silent failure step 111.9 exists to prevent. */}
          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-label" className="text-[13px] font-normal">
              Name
            </Label>
            <Input id="pm-label" value={local.label} onChange={(e) => setLocal({ ...local, label: e.target.value })} placeholder="Office UK" />

            <Label htmlFor="pm-listen-proto" className="text-[13px] font-normal">
              Listens as
            </Label>
            <Select value={local.listen.proto} onValueChange={(v) => setLocal({ ...local, listen: { ...local.listen, proto: v as ListenProto } })}>
              <SelectTrigger id="pm-listen-proto" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LISTEN_PROTOS.map((proto) => (
                  <SelectItem key={proto} value={proto}>
                    {LISTEN_PROTO_LABELS[proto]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="pm-listen-port" className="text-[13px] font-normal">
              Local port
            </Label>
            <Input
              id="pm-listen-port"
              type="number"
              min={1}
              max={65535}
              value={local.listen.port ?? ''}
              placeholder="9902"
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10)
                setLocal({ ...local, listen: { ...local.listen, port: Number.isInteger(next) ? next : null } })
              }}
              className="readout"
            />

          </div>

          {/*
            The primary upstream's own fields, drawn through the SAME shared
            component the backup-upstreams editor below draws each of ITS rows
            with (plan 121 §4.5, step 121.6's own instruction: extract the
            per-kind field switch rather than keep a second copy of it here).
            `idPrefix="pm"` keeps every input's `id` byte-for-byte what it was
            before this extraction (`pm-kind`, `pm-host`, `pm-password`, …), so
            nothing about this dialog's own DOM contract moved.
          */}
          <UpstreamFieldGroup
            idPrefix="pm"
            upstream={local.upstream}
            onChange={(next) => setLocal({ ...local, upstream: next })}
            password={local.password}
            onPasswordChange={(next) => setLocal({ ...local, password: next, clearPassword: false })}
            hasStoredPassword={hasStoredPassword}
            clearPassword={local.clearPassword}
            onClearPasswordChange={(next) => setLocal({ ...local, clearPassword: next, password: next ? '' : local.password })}
          />

          {/*
            Backup upstreams (plan 121 §1, §4.5, step 121.6) — an ordered list
            a record fails over to, plus the two failure-detection settings.
            Sits right below the primary's own fields, in the same form.
            `hasStoredPassword` checks the SLOTTED key (`<id>:<slot>`, step
            121.4's own addressing) for a record that already exists; a new,
            unsaved record has no id to check against yet, so every slot
            reads "nothing stored" — correct, since nothing could have been
            saved for a record that has never been written.
          */}
          <BackupUpstreamsEditor
            value={{ upstreams: local.fallbackUpstreams, passwords: local.fallbackPasswords, clearPasswords: local.clearFallbackPasswords }}
            onChange={(next) => setLocal({ ...local, fallbackUpstreams: next.upstreams, fallbackPasswords: next.passwords, clearFallbackPasswords: next.clearPasswords })}
            failover={local.failover}
            onFailoverChange={(next) => setLocal({ ...local, failover: next })}
            hasStoredPassword={(slot) => editingId !== null && secrets.has(`${editingId}:${slot}`)}
          />

          {/*
            Intent, and the two bounds that belong to the record rather than to
            the moment. `enabled` is the flag the farm reads at load — the only
            runtime fact that survives a restart, because it is the only one
            that is a decision rather than an observation (plan 112 §3.5).
          */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="pm-enabled" className="text-[13px] font-normal">
                Enabled
              </Label>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
                The farm starts this bridge when the plugin loads, and restores it after a core restart. Start and Stop on the row act now and leave
                this alone — a bridge you stopped by hand comes back the next time the plugin does.
              </p>
            </div>
            <Switch id="pm-enabled" checked={local.enabled} onCheckedChange={(next) => setLocal({ ...local, enabled: next })} />
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="pm-log-destinations" className="text-[13px] font-normal">
                Log destination hosts
              </Label>
              {/* Declared in `shared.ts` so the switch and anything else that
                  describes it cannot drift into two different promises about
                  what turning it on records. */}
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">{LOG_DESTINATIONS_HINT}</p>
            </div>
            <Switch id="pm-log-destinations" checked={local.logDestinations} onCheckedChange={(next) => setLocal({ ...local, logDestinations: next })} />
          </div>

          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-max-connections" className="text-[13px] font-normal">
              Max connections
            </Label>
            <Input
              id="pm-max-connections"
              type="number"
              min={1}
              max={10000}
              value={local.maxConnections}
              onChange={(e) => setLocal({ ...local, maxConnections: Number.parseInt(e.target.value, 10) || DEFAULT_MAX_CONNECTIONS })}
              className="readout"
            />

            <Label htmlFor="pm-drain-ms" className="text-[13px] font-normal">
              Drain (ms)
            </Label>
            <Input
              id="pm-drain-ms"
              type="number"
              min={0}
              max={120000}
              value={local.drainMs}
              onChange={(e) => setLocal({ ...local, drainMs: Number.parseInt(e.target.value, 10) || 0 })}
              className="readout"
            />
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            A bridge accepts at most this many connections at once ({DEFAULT_MAX_CONNECTIONS} by default — a bound on a runaway client, not a measured
            cliff), and a Stop gives whatever is still open this long before destroying it.
          </p>

          {/*
            Capacity and Exclusive (plan 117 §3.8, step 117.5's own fields).
            Both are enforced by `apply.ts` as of step 117.10 — the help text
            below used to say "stored, not yet enforced" and that sentence
            went stale the moment 117.10 landed while this file was owned by
            a different worker; 117.9's own status paragraph flagged it as
            owed, and this is that fix.
          */}
          <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-capacity" className="text-[13px] font-normal">
              Capacity
            </Label>
            <Input
              id="pm-capacity"
              type="number"
              min={0}
              max={1000}
              value={local.capacity}
              onChange={(e) => setLocal({ ...local, capacity: Number.parseInt(e.target.value, 10) || 0 })}
              className="readout"
            />
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            How many devices may hold this record at once through the Assignments tab. 0 means unlimited. Apply refuses over this number, naming the
            devices already holding it.
          </p>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <Label htmlFor="pm-exclusive" className="text-[13px] font-normal">
                Exclusive
              </Label>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
                Refuses a second device on this record at the same time — the stricter sibling of Capacity, for a record meant to carry exactly one device.
              </p>
            </div>
            <Switch id="pm-exclusive" checked={local.exclusive} onCheckedChange={(next) => setLocal({ ...local, exclusive: next })} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pm-notes" className="text-[13px] font-normal">
              Notes
            </Label>
            <Textarea
              id="pm-notes"
              value={local.notes}
              onChange={(e) => setLocal({ ...local, notes: e.target.value })}
              placeholder="Who it belongs to, when it expires, where the credentials live."
              rows={2}
            />
          </div>

          {refusals.map((problem) => (
            <p key={problem.code} className="text-[11.5px] leading-relaxed text-destructive">
              <span className="readout wrap-anywhere whitespace-normal">{problem.code}</span> — {problem.message}
            </p>
          ))}
          {preconditions.map((problem) => (
            <p key={problem.code} className="text-[11.5px] leading-relaxed text-fg-muted">
              {problem.message}
            </p>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          {/* `effectiveKey`, never `local.key`: what is saved is the key the
              dialog has been showing, so a derived one that was never typed
              into the state still ends up on the row. */}
          <Button onClick={() => void onSave({ ...local, key: effectiveKey })} disabled={busy || incomplete || keyIsTaken || !isStorableRecord(problems)}>
            {local.isNew ? 'Save proxy' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The bulk paste — the owner's actual ask: *"biar ga input manual satu
 * persatu"*.
 *
 * ## Why this is a preview and not an importer
 *
 * The colon form is genuinely ambiguous (`shared.ts`'s `PROXY_PASTE_RULE` is
 * the rule, stated on this screen rather than only in a comment), and a parser
 * that resolves ambiguity silently is a parser that creates forty records with
 * one of them subtly wrong. So every line is shown as it was READ — protocol,
 * host, port, account, and whether a password was found — beside the name, the
 * key and the local port each record will get, all before anything is written.
 * A line that could not be read is shown with the line number and the rule it
 * broke, so it can be fixed in the box and the preview re-reads it.
 *
 * ## Three things the preview decides, and each is visible and editable
 *
 * - **the name**: the account when there is one, the host when there is not
 *   (`suggestProxyName` — a provider's list is usually one host and many
 *   accounts, so naming every row after the host would give twenty records the
 *   same name);
 * - **the storage key**: derived from that name, suffixed past anything already
 *   in the catalogue AND anything earlier in this same paste;
 * - **the local port**: the field a record cannot start without, and the one
 *   thing a pasted line never carries. Assigned upward from
 *   `DEFAULT_LOCAL_PORT_BASE`, skipping every port a record already claims and
 *   every port an earlier line in this paste has taken.
 *
 * ## And what it never does
 *
 * **Nothing created here is enabled.** A paste of forty lines that bound forty
 * ports on the operator's machine, from one press, would be the same mistake
 * plan 112 §4.3 refuses for the migration: an import must never start a
 * listener nobody asked to start. Each row is started from the catalogue,
 * deliberately, one at a time.
 *
 * **A password is never rendered.** The parsed rows say *saved with the
 * record* or nothing at all; the failed rows are echoed through
 * `maskProxyLine`, which replaces whatever sits where a password sits before
 * the string reaches this component — a masking that is structural rather than
 * a promise this render has to keep.
 */
function PasteDialog({
  open,
  catalogue,
  takenKeys,
  onCancel,
  onDone,
}: {
  open: boolean
  catalogue: readonly { id: string; record: ProxyRecord }[]
  takenKeys: readonly string[]
  onCancel: () => void
  /** `close` is false for a partial failure: the catalogue behind is refreshed and the report stays up. */
  onDone: (close: boolean) => void
}) {
  const [text, setText] = useState('')
  const [listenProto, setListenProto] = useState<ListenProto>('http')
  const [upstreamProto, setUpstreamProto] = useState<ProxyKind>('socks5')
  /** Per line number, what the operator changed about what was suggested. Cleared whenever the text changes, because line numbers move. */
  const [edits, setEdits] = useState<Record<number, { name?: string; port?: number }>>({})
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ line: number; name: string; error: string | null }[] | null>(null)

  const [openedAt, setOpenedAt] = useState(false)
  if (open !== openedAt) {
    setOpenedAt(open)
    if (open) {
      setText('')
      setEdits({})
      setReport(null)
      setBusy(false)
    }
  }

  const parsed = useMemo(() => parseProxyList(text, { defaultProto: upstreamProto }), [text, upstreamProto])

  /**
   * The plan: one entry per non-blank, non-comment line, in the order they were
   * written.
   *
   * The key and port allocators walk the list in order and remember what they
   * have handed out, so two identical lines in one paste get two records rather
   * than one row written twice — which is what a naive per-line derivation
   * would do, silently, and only for the operator who actually has duplicates.
   */
  const plan = useMemo(() => {
    const keys = new Set(takenKeys)
    const claimed = new Set<number>()
    for (const entry of catalogue) if (entry.record.listen.port !== null) claimed.add(entry.record.listen.port)
    let from = DEFAULT_LOCAL_PORT_BASE
    return parsed.map((line) => {
      if (!line.result.ok) return { line, ok: false as const, reason: line.result.reason }
      const proxy: ParsedProxy = line.result.proxy
      const edit = edits[line.line]
      const name = edit?.name ?? suggestProxyName(proxy)
      const key = deriveProxyKey(name, keys)
      keys.add(key)
      const port = edit?.port ?? nextFreeLocalPort(claimed, from)
      const portClash = claimed.has(port)
      claimed.add(port)
      from = Math.max(from, port + 1)
      const record: ProxyRecord = {
        label: name,
        listen: { proto: listenProto, bindHost: DEFAULT_BIND_HOST, port },
        upstream: { proto: proxy.proto, host: proxy.host, port: proxy.port, username: proxy.username, bindAddress: '', resolveThroughEgress: true },
        // A bulk-created row starts with no backups and the plain failover
        // defaults — same as a fresh single record (`BLANK`) — an operator
        // configures failover per record afterwards, from the edit dialog.
        fallbackUpstreams: [],
        failover: { failureThreshold: 3, autoFailback: true },
        // Never enabled. See this component's own header.
        enabled: false,
        logDestinations: false,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
        drainMs: DEFAULT_DRAIN_MS,
        capacity: 0,
        exclusive: false,
        listenerAuth: false,
        notes: '',
      }
      const refusals = validateProxyRecord(record, { id: proxyIdFromKey(key) ?? key, catalogue }).filter((p) => p.kind === 'refusal')
      return { line, ok: true as const, proxy, name, key, port, portClash, record, refusals }
    })
  }, [parsed, edits, takenKeys, catalogue, listenProto])

  const creatable = plan.filter((row) => row.ok && row.refusals.length === 0)
  const unreadable = plan.filter((row) => !row.ok)
  const refused = plan.filter((row) => row.ok && row.refusals.length > 0)

  async function create(): Promise<void> {
    setBusy(true)
    const results: { line: number; name: string; error: string | null }[] = []
    for (const row of plan) {
      if (!row.ok || row.refusals.length > 0) continue
      try {
        await putRecord(row.key, row.record)
        // The password, if the line carried one — the same single write path
        // the dialog uses, so `secret: true, hint: false` cannot be right on one
        // and forgotten on the other.
        if (row.proxy.password.length > 0) await putSecret(proxyIdFromKey(row.key) ?? row.key, row.proxy.password)
        results.push({ line: row.line.line, name: row.name, error: null })
      } catch (e: unknown) {
        results.push({ line: row.line.line, name: row.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
    setReport(results)
    const failed = results.some((r) => r.error !== null)
    onDone(!failed)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      {/*
        Wider than the ordinary dialog because the preview is a list of rows,
        and `@container` inside it so those rows respond to THIS box rather than
        to the window — the dialog is 512 px on a 1440 px screen and full width
        on a phone, and a viewport breakpoint would get both wrong.
      */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste proxies</DialogTitle>
          <DialogDescription>
            One proxy per line, in whichever of these shapes your provider uses. Blank lines and lines starting with “#” are skipped, and everything is
            shown as it was read before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="@container space-y-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {PROXY_PASTE_FORMATS.map((format) => (
              <span key={format} className="readout wrap-anywhere min-w-0 whitespace-normal text-[11.5px] text-fg-muted">
                {format}
              </span>
            ))}
          </div>

          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              // Line numbers move when the text does, so an edit keyed by one
              // would attach itself to a different proxy. Dropped rather than
              // re-anchored: re-anchoring would be a guess about which line the
              // operator meant.
              setEdits({})
              setReport(null)
            }}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            className="readout wrap-anywhere min-w-0 whitespace-pre-wrap"
            placeholder={`${PROXY_PASTE_FORMATS[0]}\n${PROXY_PASTE_FORMATS[2]}\n# a comment, skipped`}
            aria-label="Proxies to create, one per line"
          />

          {/* The rule the colon form is read by, where it is read. */}
          <p className="text-[11.5px] leading-relaxed text-fg-muted">{PROXY_PASTE_RULE}</p>

          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-paste-listen" className="text-[13px] font-normal">
              Each listens as
            </Label>
            <Select value={listenProto} onValueChange={(v) => setListenProto(v as ListenProto)}>
              <SelectTrigger id="pm-paste-listen" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LISTEN_PROTOS.map((proto) => (
                  <SelectItem key={proto} value={proto}>
                    {LISTEN_PROTO_LABELS[proto]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="pm-paste-upstream" className="text-[13px] font-normal">
              Lines with no scheme
            </Label>
            <Select value={upstreamProto} onValueChange={(v) => setUpstreamProto(v as ProxyKind)}>
              <SelectTrigger id="pm-paste-upstream" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    Read as {PROXY_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {plan.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11.5px] leading-relaxed text-fg-muted">{PROXY_PASTE_PREVIEW_NOTE}</p>
              <ul className="space-y-2">
                {plan.map((row) => (
                  <li key={row.line.line} className="min-w-0 space-y-1.5 rounded-md border border-border px-3 py-2">
                    {row.ok ? (
                      <>
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <Badge variant="outline">{PROXY_KIND_LABELS[row.proxy.proto]}</Badge>
                          <span className="readout wrap-anywhere min-w-0 whitespace-normal text-[12px]">
                            {row.proxy.host}:{row.proxy.port}
                          </span>
                          {row.proxy.username ? (
                            <span className="readout wrap-anywhere min-w-0 whitespace-normal text-[11.5px] text-fg-muted">as {row.proxy.username}</span>
                          ) : (
                            <span className="text-[11.5px] text-fg-muted">no account</span>
                          )}
                          {/* Never the password. Whether there is one is a fact
                              worth showing; the characters are not, anywhere. */}
                          <span className="text-[11.5px] text-fg-muted">
                            {row.proxy.password.length > 0 ? (
                              <>
                                password <span className="readout">{PASSWORD_MASK}</span> saved with the record
                              </>
                            ) : (
                              'no password'
                            )}
                          </span>
                          {row.proxy.schemeGiven ? null : <span className="text-[11.5px] text-fg-muted">· no scheme on the line</span>}
                        </div>

                        <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
                          <Label htmlFor={`pm-paste-name-${row.line.line}`} className="text-[11.5px] font-normal text-fg-muted">
                            Name
                          </Label>
                          <Input
                            id={`pm-paste-name-${row.line.line}`}
                            value={row.name}
                            onChange={(e) => setEdits((current) => ({ ...current, [row.line.line]: { ...current[row.line.line], name: e.target.value } }))}
                            className="h-7 text-[12.5px]"
                          />
                          <Label htmlFor={`pm-paste-port-${row.line.line}`} className="text-[11.5px] font-normal text-fg-muted">
                            Local port
                          </Label>
                          <Input
                            id={`pm-paste-port-${row.line.line}`}
                            type="number"
                            min={1}
                            max={65535}
                            value={row.port}
                            onChange={(e) => {
                              const next = Number.parseInt(e.target.value, 10)
                              setEdits((current) => ({ ...current, [row.line.line]: { ...current[row.line.line], port: Number.isInteger(next) ? next : undefined } }))
                            }}
                            className="readout h-7 text-[12.5px]"
                          />
                        </div>

                        <div className="readout wrap-anywhere min-w-0 whitespace-normal text-[11px] text-fg-muted">{row.key}</div>
                        {row.portClash ? (
                          <p className="text-[11px] leading-relaxed text-fg-muted">
                            Another record — or another line above — already names this local port. Both are saved; only one of them can bind it, and the
                            second will fail to start with that reason on its own row.
                          </p>
                        ) : null}
                        {row.refusals.map((problem) => (
                          <p key={problem.code} className="text-[11px] leading-relaxed text-destructive">
                            <span className="readout wrap-anywhere whitespace-normal">{problem.code}</span> — {problem.message} This line is not created.
                          </p>
                        ))}
                      </>
                    ) : (
                      <>
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[11.5px] text-fg-muted">Line {row.line.line}</span>
                          {/* Masked before it reached this component — see
                              `maskProxyLine`. Shown at all because a line that
                              cannot be read has to be findable in the box. */}
                          <span className="readout wrap-anywhere min-w-0 whitespace-normal text-[12px]">{row.line.masked}</span>
                        </div>
                        <p className="text-[11px] leading-relaxed text-destructive">Not read: {row.reason}.</p>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report ? (
            <div className="space-y-1 rounded-md border border-border px-3 py-2">
              <p className="text-[11.5px] leading-relaxed">
                {report.filter((r) => r.error === null).length} of {report.length} created. Nothing is listening: each one is off until you start it.
              </p>
              {report
                .filter((r) => r.error !== null)
                .map((r) => (
                  <p key={r.line} className="text-[11px] leading-relaxed text-destructive">
                    Line {r.line} — <span className="readout wrap-anywhere whitespace-normal">{r.error}</span>
                  </p>
                ))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {report ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => void create()} disabled={busy || creatable.length === 0}>
            {creatable.length === 1 ? 'Create 1 proxy' : `Create ${creatable.length} proxies`}
            {unreadable.length + refused.length > 0 ? `, skip ${unreadable.length + refused.length}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// The range generator (plan 117 §3.9)
// ---------------------------------------------------------------------------

/**
 * A plain IPv4 literal, checked locally rather than imported.
 *
 * `shared.ts`'s own `isIpLiteral` answers exactly this question and is not
 * exported — that file's own header explains why (no imports, no types beyond
 * the values themselves, so both the browser and the service can share it
 * unmodified) — but nothing there says its *helpers* have to be public, and
 * making one public just for this dialog would be a wider surface for a
 * question this file can ask on its own. `service/dial-direct.ts` already
 * asks the same question again with `net.isIP()` at connect time for the same
 * reason: two implementations of one rule that has to hold in both places,
 * not one calling the other.
 */
function isIpv4Literal(text: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text)
}

/**
 * `base`'s last octet plus `delta`, or `null` when that octet would leave
 * 0..255 — the octet-boundary refusal §3.9 asks for. Stepping is ordinary
 * IPv4 increment of the LAST octet only: `192.168.100.11` then `.12`, `.13`,
 * … A count that would carry the last octet past 255 has no single correct
 * next move — the next /24? a wraparound to 0? — so this returns `null`
 * rather than picking one, and the caller refuses by name instead of guessing.
 *
 * Exported for `catalogue.test.ts` (plan 117 step 117.11): a pure function
 * with no hook and no render deserves a test that does not need a DOM, and
 * this is the one place criterion 11's octet-boundary refusal can be proved
 * directly rather than by reading the source as text.
 */
export function stepLastOctet(base: string, delta: number): string | null {
  const parts = base.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => Number(p))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const last = (octets[3] ?? 0) + delta
  if (last < 0 || last > 255) return null
  return `${octets[0]}.${octets[1]}.${octets[2]}.${last}`
}

/** One row of the generated preview — everything `create()` needs, plus what the table shows. */
interface GeneratedRow {
  /** 1-based, so the label pattern's `{n}` and the row's position on screen agree. */
  n: number
  label: string
  key: string
  port: number
  /** Another record, or an earlier row in this same range, already names this port — a warning, not a refusal (mirrors `PasteDialog`'s own `portClash`). */
  portClash: boolean
  bindAddress: string
  record: ProxyRecord
  refusals: ProxyProblem[]
}

/**
 * The range generator — the owner's ask for "twenty rows" answered
 * generically (§0.1, §3.9): a label pattern, a starting local port, a
 * starting bind address, and a count, with every row shown exactly as it
 * would be written before Generate is pressed. It writes ordinary `direct`
 * records and nothing about any particular network — there is no button
 * named after anyone's equipment (criterion 12).
 *
 * Modeled on `PasteDialog` immediately above, which already establishes the
 * discipline this reuses: nothing is written until the button is pressed,
 * every row is editable, a row that cannot be created says why instead of
 * being silently dropped, and nothing generated here is ever enabled — each
 * one is started from the catalogue, deliberately, same as a paste.
 */
function GenerateDialog({
  open,
  catalogue,
  takenKeys,
  onCancel,
  onDone,
}: {
  open: boolean
  catalogue: readonly { id: string; record: ProxyRecord }[]
  takenKeys: readonly string[]
  onCancel: () => void
  /** `close` is false for a partial failure: the catalogue behind is refreshed and the report stays up. */
  onDone: (close: boolean) => void
}) {
  const [labelTemplate, setLabelTemplate] = useState('Egress {n}')
  const [listenProto, setListenProto] = useState<ListenProto>('http')
  const [firstPort, setFirstPort] = useState<number | null>(null)
  const [firstBindAddress, setFirstBindAddress] = useState('')
  const [count, setCount] = useState(1)
  /** Per row number, what the operator corrected about what was generated — the "correctable before anything is saved" this step's item 3 asks for. */
  const [edits, setEdits] = useState<Record<number, { label?: string; port?: number; bindAddress?: string }>>({})
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ n: number; label: string; error: string | null }[] | null>(null)

  const claimedPorts = useMemo(() => {
    const taken = new Set<number>()
    for (const entry of catalogue) if (entry.record.listen.port !== null) taken.add(entry.record.listen.port)
    return taken
  }, [catalogue])

  // Reset on open, without a `useEffect` — the same "adjusting state when a
  // prop changes" pattern `ProxyDialog` and `PasteDialog` already use.
  const [openedAt, setOpenedAt] = useState(false)
  if (open !== openedAt) {
    setOpenedAt(open)
    if (open) {
      setLabelTemplate('Egress {n}')
      setListenProto('http')
      setFirstPort(nextFreeLocalPort(claimedPorts))
      setFirstBindAddress('')
      setCount(1)
      setEdits({})
      setReport(null)
      setBusy(false)
    }
  }

  /**
   * The plan, exactly like `PasteDialog`'s own `plan`: computed fresh from
   * the inputs and the edits, never written anywhere until Generate.
   *
   * The octet-boundary refusal is checked ONCE, against the last row the
   * count would need, before any row is built — a range that crosses is
   * refused as a whole (no preview, no partial row) rather than silently
   * generating fewer rows than asked for, which would be its own kind of
   * guess about what the operator meant.
   */
  const range = useMemo((): { rows: GeneratedRow[]; error: string | null } => {
    const address = firstBindAddress.trim()
    if (address.length === 0) return { rows: [], error: null }
    if (!isIpv4Literal(address)) {
      return {
        rows: [],
        error: `"${address}" is not an IPv4 address. The generator only steps the last octet of a plain IPv4 literal — write one starting address, for example 192.168.100.11.`,
      }
    }
    if (!Number.isInteger(count) || count < 1) return { rows: [], error: null }
    if (stepLastOctet(address, count - 1) === null) {
      const octets = address.split('.')
      const wouldBe = Number(octets[3] ?? 0) + count - 1
      return {
        rows: [],
        error: `${count} addresses from ${address} would need the last octet to reach ${wouldBe}, past 255 — into a different /24. This generator only steps the last octet, so it refuses rather than guess whether you meant the next subnet or a wraparound. Lower the count, start further from .255, or run the rest as a second range.`,
      }
    }

    const keys = new Set(takenKeys)
    const claimed = new Set(claimedPorts)
    const rows: GeneratedRow[] = []
    for (let i = 0; i < count; i += 1) {
      const n = i + 1
      const edit = edits[n]
      const label = edit?.label ?? (labelTemplate.includes('{n}') ? labelTemplate.replaceAll('{n}', String(n)) : `${labelTemplate} ${n}`.trim())
      const key = deriveProxyKey(label, keys)
      keys.add(key)
      const stepped = stepLastOctet(address, i)
      const bindAddress = edit?.bindAddress ?? stepped ?? address
      const port = edit?.port ?? (firstPort === null ? nextFreeLocalPort(claimed) : firstPort + i)
      const portClash = claimed.has(port)
      claimed.add(port)
      const record: ProxyRecord = {
        label,
        listen: { proto: listenProto, bindHost: DEFAULT_BIND_HOST, port },
        // Every generated row is `direct` by construction — the range steps a
        // BIND address, which is meaningless for the other three kinds.
        upstream: { proto: 'direct', host: '', port: 0, username: '', bindAddress, resolveThroughEgress: true },
        // Same rule as `PasteDialog`'s own literal above: no backups, plain
        // failover defaults, configured per record afterwards.
        fallbackUpstreams: [],
        failover: { failureThreshold: 3, autoFailback: true },
        // Never enabled. Same rule as `PasteDialog`'s own header states.
        enabled: false,
        logDestinations: false,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
        drainMs: DEFAULT_DRAIN_MS,
        capacity: 0,
        exclusive: false,
        listenerAuth: false,
        notes: '',
      }
      const refusals = validateProxyRecord(record, { id: proxyIdFromKey(key) ?? key, catalogue }).filter((p) => p.kind === 'refusal')
      rows.push({ n, label, key, port, portClash, bindAddress, record, refusals })
    }
    return { rows, error: null }
  }, [firstBindAddress, count, firstPort, labelTemplate, listenProto, takenKeys, claimedPorts, catalogue, edits])

  const creatable = range.rows.filter((row) => row.refusals.length === 0)

  async function create(): Promise<void> {
    setBusy(true)
    const results: { n: number; label: string; error: string | null }[] = []
    for (const row of range.rows) {
      if (row.refusals.length > 0) continue
      try {
        // Same single write path `save()` and `PasteDialog.create()` use.
        // There is no second write here: a `direct` row names no upstream
        // account, so there is no `proxy-secret:` half to write beside it.
        await putRecord(row.key, row.record)
        results.push({ n: row.n, label: row.label, error: null })
      } catch (e: unknown) {
        results.push({ n: row.n, label: row.label, error: e instanceof Error ? e.message : String(e) })
      }
    }
    setBusy(false)
    setReport(results)
    const failed = results.some((r) => r.error !== null)
    onDone(!failed)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate a range</DialogTitle>
          <DialogDescription>
            One “direct” bridge per way out of this host — a label pattern, a starting local port, a starting bind address, and how many. Nothing is
            written until Generate is pressed, and every row below is shown exactly as it will be saved.
          </DialogDescription>
        </DialogHeader>

        <div className="@container space-y-3">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <Label htmlFor="pm-gen-label" className="text-[13px] font-normal">
              Label pattern
            </Label>
            <Input id="pm-gen-label" value={labelTemplate} onChange={(e) => setLabelTemplate(e.target.value)} placeholder="Egress {n}" className="readout" />

            <Label htmlFor="pm-gen-listen" className="text-[13px] font-normal">
              Each listens as
            </Label>
            <Select value={listenProto} onValueChange={(v) => setListenProto(v as ListenProto)}>
              <SelectTrigger id="pm-gen-listen" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LISTEN_PROTOS.map((proto) => (
                  <SelectItem key={proto} value={proto}>
                    {LISTEN_PROTO_LABELS[proto]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="pm-gen-port" className="text-[13px] font-normal">
              First local port
            </Label>
            <Input
              id="pm-gen-port"
              type="number"
              min={1}
              max={65535}
              value={firstPort ?? ''}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10)
                setFirstPort(Number.isInteger(next) ? next : null)
              }}
              className="readout"
            />

            <Label htmlFor="pm-gen-address" className="text-[13px] font-normal">
              First bind address
            </Label>
            <Input
              id="pm-gen-address"
              value={firstBindAddress}
              onChange={(e) => setFirstBindAddress(e.target.value)}
              placeholder="192.168.100.11"
              className="readout"
            />

            <Label htmlFor="pm-gen-count" className="text-[13px] font-normal">
              Count
            </Label>
            <Input id="pm-gen-count" type="number" min={1} max={255} value={count} onChange={(e) => setCount(Number.parseInt(e.target.value, 10) || 1)} className="readout" />
          </div>

          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            “{'{n}'}” in the label pattern becomes 1, 2, 3, … for each row; the local port and the bind address's last octet count up the same way from what
            you typed above. Each row is a plain “direct” record — what its bind address maps to on this host (a NIC, a route, a link) is set up outside
            this screen, the same as for one typed by hand.
          </p>

          {range.error ? <p className="text-[11.5px] leading-relaxed text-destructive">{range.error}</p> : null}

          {range.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Local port</TableHead>
                    <TableHead>Bind address</TableHead>
                    <TableHead>&nbsp;</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {range.rows.map((row) => (
                    <TableRow key={row.n}>
                      <TableCell className="min-w-0">
                        <Input
                          value={row.label}
                          onChange={(e) => setEdits((current) => ({ ...current, [row.n]: { ...current[row.n], label: e.target.value } }))}
                          className="h-7 text-[12.5px]"
                          aria-label={`Name, row ${row.n}`}
                        />
                        <div className="readout wrap-anywhere whitespace-normal text-[11px] text-fg-muted">{row.key}</div>
                      </TableCell>
                      <TableCell className="min-w-0">
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          value={row.port}
                          onChange={(e) => {
                            const next = Number.parseInt(e.target.value, 10)
                            setEdits((current) => ({ ...current, [row.n]: { ...current[row.n], port: Number.isInteger(next) ? next : undefined } }))
                          }}
                          className="readout h-7 text-[12.5px]"
                          aria-label={`Local port, row ${row.n}`}
                        />
                        {row.portClash ? <p className="text-[11px] leading-relaxed text-fg-muted">Already claimed by another record or an earlier row.</p> : null}
                      </TableCell>
                      <TableCell className="min-w-0">
                        <Input
                          value={row.bindAddress}
                          onChange={(e) => setEdits((current) => ({ ...current, [row.n]: { ...current[row.n], bindAddress: e.target.value } }))}
                          className="readout h-7 text-[12.5px]"
                          aria-label={`Bind address, row ${row.n}`}
                        />
                      </TableCell>
                      <TableCell className="min-w-0 text-[11px] text-destructive">
                        {row.refusals.map((problem) => (
                          <p key={problem.code} className="leading-relaxed">
                            <span className="readout wrap-anywhere whitespace-normal">{problem.code}</span> — not created
                          </p>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {report ? (
            <div className="space-y-1 rounded-md border border-border px-3 py-2">
              <p className="text-[11.5px] leading-relaxed">
                {report.filter((r) => r.error === null).length} of {report.length} created. Nothing is listening: each one is off until you start it.
              </p>
              {report
                .filter((r) => r.error !== null)
                .map((r) => (
                  <p key={r.n} className="text-[11px] leading-relaxed text-destructive">
                    Row {r.n} — <span className="readout wrap-anywhere whitespace-normal">{r.error}</span>
                  </p>
                ))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {report ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => void create()} disabled={busy || creatable.length === 0}>
            {creatable.length === 1 ? 'Generate 1 proxy' : `Generate ${creatable.length} proxies`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
