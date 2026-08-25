import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  Combobox,
  DeviceName,
  EmptyState,
  ErrorState,
  Input,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  api,
  formatDeviceName,
  matchesDeviceQuery,
  relativeTime,
  type ComboboxOption,
} from '@enkaku/ui'
import {
  ASSIGNMENT_KEY,
  ASSIGNMENT_NOTE,
  PROXY_APPLY_MODES,
  PROXY_APPLY_MODE_DESCRIPTIONS,
  PROXY_APPLY_MODE_LABELS,
  PROXY_KEY_PREFIX,
  VPN_CREDENTIAL_WARNING,
  type ProxyApplyMode,
} from '../../shared'
import { ApplyResultSchema, IgnoredSchema, KvPageSchema, PLUGIN_API, ScanPageSchema, readAssignment, readProxy, type ApplyResult } from './api'
import { StatusDot, useLoader } from './bits'

/**
 * Assignments — every device in the farm, and which catalogue entry someone
 * has noted against it.
 *
 * **The data really does support this tab**, which is why it exists rather
 * than being a third heading over nothing: `GET
 * /api/plugins/:name/data/scan?key=assigned` answers with every device joined
 * to whether it holds that key, in ONE statement (plan 108 §4.5) — a device
 * with no note joins to nulls and reports `entry: null` instead of dropping
 * out. Listing devices and then reading a key each would be the N+1 that route
 * exists to prevent.
 *
 * **And it is the tab most likely to be misread**, so `ASSIGNMENT_NOTE` sits
 * above it permanently: an assignment is a NOTE. It records which proxy a
 * device is meant to use, and nothing on the phone changes until Apply is
 * pressed on that row.
 *
 * Device scope, deliberately, and by the same rule the catalogue is global by
 * (plan 108 §3.1): forgetting a phone SHOULD forget the note somebody made
 * about it, and must NOT take the catalogue with it.
 */

interface DeviceRow {
  stableId: string
  label: string | null
  /**
   * The short human-facing number, straight off the scan row (plan 124 §0.5 —
   * the join was always there, this tab just dropped the field on the floor).
   * `null` is ordinary and renders as the bare label, never as `#null`.
   */
  number: number | null
  /** Null for a device the farm has a row for but no status on — rendered as `unknown`, never as an empty cell. */
  status: string | null
  /** The catalogue key noted against this device, or `''` for none. */
  assigned: string
  updatedAt: number | null
}

interface Catalogue {
  /** Storage key → what to call it. */
  labels: Record<string, string>
  keys: string[]
  /**
   * Storage key → how many devices' own `assigned` note currently names it —
   * the same join `GET …/data/scan?key=assigned` already gives this tab
   * (plan 117 §3.8, step 117.10), grouped client-side rather than fetched a
   * second way. A key with no holder at all is simply absent, not `0`.
   */
  counts: Record<string, number>
  /** Storage key → that record's own `capacity` (`0` = unlimited). */
  capacities: Record<string, number>
  /** Storage key → that record's own `exclusive`. */
  exclusives: Record<string, boolean>
}

/**
 * What to say next to a catalogue entry about how full it already is, or
 * `null` for the ordinary unlimited, non-exclusive record — which is most of
 * them, and which has nothing to report.
 *
 * This is `apply.ts`'s own enforcement, read back onto the screen: the same
 * fields (`capacity`, `exclusive`) and the same notion of "holding" (the
 * device-scoped `assigned` note), so a number shown here can never disagree
 * with the refusal Apply would actually give.
 */
function capacityLabel(catalogue: Catalogue, key: string): string | null {
  const count = catalogue.counts[key] ?? 0
  if (catalogue.exclusives[key]) return `${count} noted — exclusive, one device at a time`
  const capacity = catalogue.capacities[key] ?? 0
  if (capacity > 0) return `${count} of ${capacity} noted`
  return null
}

/**
 * The picker value that means "no assignment".
 *
 * A sentinel rather than `''` for two reasons that outlived the Radix `<Select>`
 * this row used to be (plan 124 §4.5 made it a `<Combobox>`): an empty value
 * makes the trigger show its *placeholder*, which reads as "nothing chosen yet"
 * rather than as the deliberate state "this device is noted as using no proxy" —
 * and "no proxy noted" has to be a real, selectable row, because clearing an
 * assignment is a thing an operator does on purpose.
 *
 * The leading space is kept deliberately: a catalogue key is a storage key
 * (`proxy:<id>`) and cannot begin with one, so this sentinel can never collide
 * with a real record. `<Combobox>` hands `onValueChange` the exact string this
 * file put in (its own `onSelect` closes over `o.value` rather than trusting
 * cmdk's normalised copy), so the round trip is byte-exact.
 */
const NONE = ' none'

/**
 * The mode a row applies in, when nobody has chosen one.
 *
 * HTTP, for one reason and not for taste: it is the mode that keeps the
 * upstream account on this machine. A default that sent a saved password to a
 * phone the first time somebody pressed a button they had not read about would
 * be the credential decision made FOR the operator, and this whole pair of
 * modes exists so that it is made BY them.
 */
const DEFAULT_MODE: ProxyApplyMode = 'http'

/**
 * The mode picker, and the sentence that goes with whichever is selected.
 *
 * **The description is rendered under the picker, not inside the dropdown
 * items.** Plan 114 §3.1 rule 1 requires the difference to be stated *where the
 * choice is made*; a sentence that only appears while a dropdown is open is not
 * that, because the state an operator sits looking at before pressing Apply is
 * the closed one. `VPN_CREDENTIAL_WARNING` joins it for VPN only — it is this
 * pack's own addition to the pair Studio declares, because here the password
 * being spent was saved on another tab weeks ago rather than typed into the
 * form in front of them.
 */
function ModePicker({ mode, disabled, onChange }: { mode: ProxyApplyMode; disabled: boolean; onChange: (mode: ProxyApplyMode) => void }) {
  return (
    <div className="space-y-1">
      <Select value={mode} disabled={disabled} onValueChange={(v) => onChange(v as ProxyApplyMode)}>
        <SelectTrigger className="h-8 w-full text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROXY_APPLY_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {PROXY_APPLY_MODE_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="max-w-prose text-[11px] leading-relaxed text-fg-muted">{PROXY_APPLY_MODE_DESCRIPTIONS[mode]}</p>
      {mode === 'vpn' ? <p className="max-w-prose text-[11px] leading-relaxed text-led-warn">{VPN_CREDENTIAL_WARNING}</p> : null}
    </div>
  )
}

/**
 * What one Apply press produced, under the row it was pressed on.
 *
 * Three renderings, and the split matters (plan 59, and `docs/design.md`'s rule
 * that a degraded state is never worded as the full one):
 *
 * - **A refusal** — the record cannot be applied in this mode at all (it is not
 *   enabled, its listener speaks SOCKS5, its upstream is not SOCKS5, the note
 *   points at a deleted record, the farm declined it). Danger tone.
 * - **A precondition** — a fact that is not true *yet*: no saved password, a
 *   guest agent that is still installing. Muted, not red: nothing went wrong,
 *   something has not happened.
 * - **Applied** — and even this is worded carefully, per mode. For HTTP the
 *   device now carries the setting; it does not follow that any app on it used
 *   the proxy. For VPN an app cannot opt out, but the health the farm answered
 *   with is still shown verbatim rather than translated into a word like
 *   "active", and `unverified` is never worded as success.
 *
 * **The mode comes from the RESULT, never from the row's dropdown.** The
 * dropdown is live and can move while a request is in flight; a success line
 * that named the mode currently selected rather than the one that landed would
 * be a lie that costs exactly what these two modes are kept apart to protect.
 */
function ApplyOutcome({ result }: { result: ApplyResult | undefined }) {
  if (!result) return null
  if (!result.ok) {
    return <p className={`mt-1 max-w-prose text-left text-[11px] leading-relaxed ${result.kind === 'refusal' ? 'text-led-danger' : 'text-fg-muted'}`}>{result.message}</p>
  }
  return (
    <p className="mt-1 max-w-prose text-left text-[11px] leading-relaxed text-fg-muted">
      Applied as <span className="readout">{result.mode === 'vpn' ? PROXY_APPLY_MODE_LABELS.vpn : PROXY_APPLY_MODE_LABELS.http}</span> — engine <span className="readout">{result.engine}</span>, health{' '}
      <span className="readout">{result.health}</span>
      {result.setBy ? `, recorded as set by ${result.setBy.id}` : ''}.{' '}
      {result.mode === 'vpn'
        ? 'The phone’s own guest agent carries this traffic, so an app cannot opt out of it. The device’s own Network → Proxy screen is where the applied state lives.'
        : 'Apps that honour the system proxy will use it; one with its own networking can ignore it. The device’s own Network → Proxy screen is where the applied state lives.'}
    </p>
  )
}

export function AssignmentsTab() {
  const load = useCallback(async (): Promise<{ devices: DeviceRow[]; catalogue: Catalogue }> => {
    // Both at once: the tab is unusable without either, and two sequential
    // round trips would show the device list with an empty proxy dropdown for
    // as long as the second one took.
    const [scan, page] = await Promise.all([
      api(`${PLUGIN_API}/data/scan?key=${encodeURIComponent(ASSIGNMENT_KEY)}&limit=200`, ScanPageSchema),
      api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}&limit=200`, KvPageSchema),
    ])
    const labels: Record<string, string> = {}
    const capacities: Record<string, number> = {}
    const exclusives: Record<string, boolean> = {}
    for (const entry of page.items) {
      const record = readProxy(entry.value)
      labels[entry.key] = record.label || entry.key
      capacities[entry.key] = record.capacity
      exclusives[entry.key] = record.exclusive
    }
    // Grouped from the SAME scan the device rows below are built from —
    // one round trip already answers "who holds what", so this is a
    // client-side tally over it rather than a second fetch.
    const counts: Record<string, number> = {}
    for (const row of scan.items) {
      const assigned = row.entry ? readAssignment(row.entry.value) : ''
      if (assigned) counts[assigned] = (counts[assigned] ?? 0) + 1
    }
    return {
      devices: scan.items.map((row) => ({
        stableId: row.stableId,
        label: row.label,
        number: row.number,
        status: row.status,
        assigned: row.entry ? readAssignment(row.entry.value) : '',
        updatedAt: row.entry?.updatedAt ?? null,
      })),
      catalogue: { labels, keys: page.items.map((e) => e.key), counts, capacities, exclusives },
    }
  }, [])
  const { data, error, loading, reload } = useLoader(load, [])

  const [busy, setBusy] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  /**
   * The table filter (plan 124 §4.5). Client-side over the rows already loaded,
   * which is what §2 asks for — the scan is one page of 200 and there is no
   * server-side device search to reach for. Never persisted: it is a hunt, not
   * a setting.
   */
  const [query, setQuery] = useState('')
  /**
   * The last Apply outcome, per device. Kept in memory and never stored: it is
   * an observation of one press, and the durable answer to "what is this phone
   * set to" lives on the device's own Network → Proxy screen, which is where an
   * operator can also see who set it. Persisting a `applied` here would be
   * plan 112 §3.5's own hazard — a lie the moment it is read.
   */
  const [applied, setApplied] = useState<Record<string, ApplyResult>>({})
  /**
   * The mode chosen on each row, in memory and never stored either — and that
   * is a decision rather than an omission.
   *
   * A persisted per-device mode would be a second record of intent living
   * beside the assignment note, and the two would disagree the first time
   * somebody edited one: the note would say `proxy:soax-surabaya` and this would
   * say `vpn` about a record whose upstream had since become HTTP. The device's
   * own Network → Proxy already holds the durable answer — which engine is
   * applied, and who set it — so this is only ever the choice being made right
   * now, and it resets when the tab is reloaded.
   */
  const [modes, setModes] = useState<Record<string, ProxyApplyMode>>({})
  const modeFor = (stableId: string): ProxyApplyMode => modes[stableId] ?? DEFAULT_MODE

  /**
   * Apply — explicit, one device, one press, one mode (plan 114 §9 Q6).
   *
   * It posts to this pack's OWN service handler rather than to
   * `PUT /api/devices/:id/network` directly, and the difference is the whole
   * point of step 114.9: a browser call would run as the operator, and the
   * device would then report that a person set the route when a plugin did.
   * Through the service it runs as `plugin:proxy-manager`, is checked against
   * the manifest, is audited, and the device's panel says *set by
   * proxy-manager*.
   *
   * The mode travels with the request rather than being inferred server-side
   * from the record: a record that CAN be applied both ways is the normal case,
   * and the whole point of the pair is that the choice is the operator's.
   */
  async function apply(stableId: string): Promise<void> {
    setBusy(stableId)
    setWriteError(null)
    try {
      const result = await api(`${PLUGIN_API}/http/apply`, ApplyResultSchema, { method: 'POST', json: { stableId, mode: modeFor(stableId) } })
      setApplied((prev) => ({ ...prev, [stableId]: result }))
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Changing the mode drops the last outcome for that row, exactly as changing
   * the noted proxy does: an "applied as HTTP proxy" line sitting under a picker
   * that now reads VPN is a sentence about a different act than the one on
   * screen.
   */
  function chooseMode(stableId: string, mode: ProxyApplyMode): void {
    setModes((prev) => ({ ...prev, [stableId]: mode }))
    setApplied((prev) => {
      const next = { ...prev }
      delete next[stableId]
      return next
    })
  }

  async function assign(stableId: string, proxyKey: string): Promise<void> {
    setBusy(stableId)
    setWriteError(null)
    try {
      if (proxyKey === NONE) {
        await api(`${PLUGIN_API}/data/entry?scope=device&stableId=${encodeURIComponent(stableId)}&key=${encodeURIComponent(ASSIGNMENT_KEY)}`, IgnoredSchema, {
          method: 'DELETE',
        })
      } else {
        await api(`${PLUGIN_API}/data/entry`, IgnoredSchema, {
          method: 'PUT',
          json: { scope: 'device', stableId, key: ASSIGNMENT_KEY, value: { proxy: proxyKey }, secret: false },
        })
      }
      // The note just changed, so the last Apply outcome is about a different
      // proxy and would read as if this one had been applied. Dropped rather
      // than left to age — an out-of-date success is worse than none.
      setApplied((prev) => {
        const next = { ...prev }
        delete next[stableId]
        return next
      })
      reload()
    } catch (e: unknown) {
      setWriteError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const devices = data?.devices ?? []
  const catalogue = data?.catalogue ?? { labels: {}, keys: [], counts: {}, capacities: {}, exclusives: {} }

  /**
   * The four-way match every device list in the product now shares —
   * `@enkaku/ui`'s `matchesDeviceQuery` (plan 124 §4.1), not a predicate of
   * this pack's own. Typing `7` finds `#7` and not `#17`; the label and the
   * stableId match as substrings.
   *
   * The row is handed as a structural `{ number, label, stableId }` because
   * that is all this projection has — a scan row is not a `DeviceInfo`, and
   * §4.1's parameter types are structural precisely so it does not have to be.
   * `label` falls back to the stableId for the same reason the cell below
   * does: a device with no label is still findable by the string it displays.
   */
  const shown = useMemo(
    () => devices.filter((device) => matchesDeviceQuery({ number: device.number, label: device.label ?? device.stableId, stableId: device.stableId }, query)),
    [devices, query],
  )

  /**
   * The catalogue as picker rows, built once for the whole table rather than
   * once per device: the owner's farm has ~45 records and ~100 phones, and this
   * list is identical on every row.
   *
   * The capacity badge moves from an inline `<span>` inside the item to
   * `ComboboxOption.hint`, which renders it dimmed under the label — the same
   * sentence in the place the primitive keeps for exactly this.
   */
  const proxyOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: NONE, label: 'No proxy noted' },
      ...catalogue.keys.map((key) => ({
        value: key,
        label: catalogue.labels[key] ?? key,
        hint: capacityLabel(catalogue, key) ?? undefined,
        // The storage key itself is searchable even though the label is what
        // is drawn: an operator who knows a record as `proxy:soax-surabaya`
        // types that, and a filter that only matched the display name would
        // silently have no hit for a string they can read off the Catalogue tab.
        keywords: [key],
      })),
    ],
    [catalogue],
  )

  if (loading) return <LoadingRows />
  if (error) return <ErrorState message={error} onRetry={reload} />

  return (
    /*
      `@container` and container-conditional column widths, for the same reason
      the catalogue has them (step 112.10): a fixed `w-72` is a PREFERRED width
      an auto-layout table will not shrink below, so widths that are right on a
      wide page are what push this table past the edge of a narrow one. Measured
      at 360 px, where this table used to be 469 px wide inside a 340 px box.
    */
    <div className="@container space-y-3">
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">{ASSIGNMENT_NOTE}</p>

      {writeError ? <ErrorState message={writeError} onRetry={() => setWriteError(null)} /> : null}

      {devices.length === 0 ? (
        <EmptyState title="No devices are enrolled" description="A note can only be made against a device the farm knows about. Enroll one and it appears here." />
      ) : catalogue.keys.length === 0 ? (
        <EmptyState title="No proxies to assign yet" description="Add a record on the Catalogue tab first — an assignment points at a catalogue key, so there has to be one." />
      ) : (
        <>
          {/*
            The filter, and the count beside it (plan 124 §4.5) — the same shape
            `catalogue.tsx` already uses one tab over, deliberately, so the two
            tables of this pack are filtered the same way.

            **No `Search` icon**, unlike Studio's own `DevicePicker`: `lucide-react`
            is not in `UI_EXTERNALS` (`packages/sdk/src/cli/build-ui.ts`) and is not
            a dependency of this pack, so an icon here would mean bundling an icon
            library into `ui/index.js` for one glyph. `failover-chip.tsx` records
            the same constraint for the same reason. The `aria-label` is what
            actually names the control, and it is present.

            The count says `N of M devices` and it is live: it is what tells an
            operator that a filter is on at all when the box has scrolled out of
            view, and it counts DEVICES rather than rows because that is what one
            row is here.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by number, label or stable id"
              aria-label="Filter devices"
              className="h-8 max-w-xs text-[12.5px]"
            />
            <span className="readout text-[11.5px] text-fg-muted">
              {shown.length} of {devices.length} device{devices.length === 1 ? '' : 's'}
            </span>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title="No device matches this filter"
              description="Nothing in the list matches what you typed. The filter matches a device's number, its label and its stable id."
              action={
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear the filter
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead className="@2xl:w-32">Status</TableHead>
                    <TableHead className="@2xl:w-72">Noted proxy</TableHead>
                    <TableHead className="hidden @4xl:table-cell @4xl:w-40">Noted at</TableHead>
                    <TableHead className="@2xl:w-64">Apply as</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((device) => (
                    <TableRow key={device.stableId}>
                      <TableCell>
                        {/*
                          `<DeviceName>` rather than a hand-composed string (plan
                          124 §3.2, §4.2): the number is a quiet identifier beside
                          the name, in its own span so it can be dimmed, and a
                          device with `number === null` renders the bare label with
                          no `#` and no gap (criterion 7). The stableId stays
                          underneath exactly as it was — it is the identity an
                          operator matches to hardware, and the number does not
                          replace it.
                        */}
                        <DeviceName number={device.number} label={device.label || device.stableId} className="max-w-full font-medium" />
                        <div className="readout wrap-anywhere whitespace-normal text-[11px] text-fg-muted">{device.stableId}</div>
                      </TableCell>
                      <TableCell className="text-[12px] text-fg-muted">
                        <StatusDot status={device.status ?? 'unknown'} />
                      </TableCell>
                      <TableCell>
                        {/*
                          A `<Combobox>`, not a `<Select>` (plan 124 §0.2, §4.5).
                          This control is rendered ONCE PER DEVICE — a hundred
                          phones each carrying an unsearchable list of ~45 records
                          — and Radix `Select` has no type-ahead filtering, only a
                          single-keystroke jump. Everything the old markup did is
                          preserved: "No proxy noted" is still a real row, the
                          capacity badge is still shown (as the option's `hint`),
                          and a note pointing at a DELETED record is still listed
                          rather than silently reading as unassigned.
                        */}
                        <Combobox
                          value={device.assigned || NONE}
                          onValueChange={(v) => void assign(device.stableId, v)}
                          disabled={busy === device.stableId}
                          ariaLabel={`Noted proxy for ${formatDeviceName(device.number, device.label || device.stableId)}`}
                          searchPlaceholder="Filter proxies…"
                          emptyText="No proxy in the catalogue matches."
                          options={
                            device.assigned && !catalogue.keys.includes(device.assigned)
                              ? [
                                  ...proxyOptions,
                                  // Kept from the `<Select>` this replaced, and it
                                  // matters more here than it did there: `<Combobox>`
                                  // would otherwise synthesise a bare row labelled
                                  // with the raw key alone, and an operator would
                                  // have no way to tell "a record called this" from
                                  // "a record that no longer exists".
                                  { value: device.assigned, label: device.assigned, hint: 'No longer in the catalogue' },
                                ]
                              : proxyOptions
                          }
                        />
                        {device.assigned && capacityLabel(catalogue, device.assigned) ? (
                          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">{capacityLabel(catalogue, device.assigned)}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="readout hidden text-[11.5px] text-fg-muted @4xl:table-cell">{relativeTime(device.updatedAt)}</TableCell>
                      <TableCell className="space-y-2 text-left align-top">
                        {/*
                          Apply is a SEPARATE press from choosing a proxy (plan 114
                          §9 Q6), and now a separate press from choosing a MODE.
                          Choosing a proxy above writes a note and changes nothing on
                          the phone; the picker below says which of the two routes to
                          ask for; this asks the farm for it, through the farm's own
                          Network → Proxy and under this plugin's own principal.
                        */}
                        <ModePicker mode={modeFor(device.stableId)} disabled={!device.assigned || busy === device.stableId} onChange={(mode) => chooseMode(device.stableId, mode)} />
                        <div className="flex flex-wrap gap-1">
                          <Button variant="secondary" size="sm" disabled={!device.assigned || busy === device.stableId} onClick={() => void apply(device.stableId)}>
                            Apply
                          </Button>
                          <Button variant="ghost" size="sm" disabled={!device.assigned || busy === device.stableId} onClick={() => void assign(device.stableId, NONE)}>
                            Clear
                          </Button>
                        </div>
                        <ApplyOutcome result={applied[device.stableId]} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
