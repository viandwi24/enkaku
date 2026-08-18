import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Label,
  LoadingRows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  api,
  cn,
} from '@enkaku/ui'
import { LOGS_CONTENT_NOTE, LOGS_SHARED_RING_NOTE, PROXY_KEY_PREFIX, PROXY_LOGS_DEFAULT_LIMIT, proxyIdFromKey } from '../../shared'
import { KvPageSchema, LogPageSchema, PLUGIN_API, logsPath, readProxy, type LogLine } from './api'
import { useLoader, usePoll } from './bits'

/**
 * Logs — the owner's own ask, in their own words: *"ada logsnya juga, logs all
 * atau logs per proxy"*.
 *
 * ## One stream, filtered — never one stream per proxy
 *
 * The farm keeps **one bounded ring per plugin** (plan 109 step 109.8), every
 * line optionally tagged with a `subject`, and a per-proxy view is a predicate
 * over it — served by the farm, not by this component. N rings for N proxies
 * would be core memory that scales with a list an operator edits, and a deleted
 * proxy would take its own history with it at exactly the moment somebody
 * wanted to know why it was deleted (plan 112 §3.8).
 *
 * The cost of that choice is real and is stated on the screen rather than
 * discovered: **a busy proxy evicts a quiet one's lines.** `truncated` is what
 * keeps that honest — it means lines this reader will never see were dropped,
 * not "there is more to fetch" (`nextSeq` is that) and not "this proxy did
 * nothing". Without it a quiet proxy in a busy farm reads as a proxy that never
 * ran.
 *
 * ## Why the filter is not applied here
 *
 * A client-side filter over a fetched page looks identical and is wrong: the
 * page it filters has already had the quiet proxy's lines evicted by the busy
 * one, so it would show fewer lines and no `truncated` reason for it. The
 * filter goes to the farm, and this component checks the `subject` the farm
 * echoes back rather than assuming it was honoured.
 *
 * ## What is deliberately not in a line
 *
 * Never a host (unless the record's own `logDestinations` switch is on), never
 * a path, a query string, a header, a byte of payload, or an upstream password.
 * That is `service/logbook.ts`'s decision and this screen only draws what
 * arrives — but it is the reason a line here is short, and the reason a
 * destination **port** is present in a refusal when the host is not.
 */

/**
 * How many lines this view keeps while following. The farm's ring is the real
 * bound; this one only stops a tab left open all afternoon from growing without
 * limit. Older lines are dropped from the TOP, so the newest are always the
 * ones on screen.
 */
const MAX_LINES = 2000

const POLL_MS = 3000

/** How many lines a page asks for — the pack's own constant, so the note about a truncated page can name the same number the request used. */
const PAGE_LIMIT = PROXY_LOGS_DEFAULT_LIMIT

/** The `<Select>` value meaning "every proxy" — Radix refuses an empty string as an item value. */
const ALL = ' all'

export function LogsTab({ proxy, onProxyChange }: { proxy: string | null; onProxyChange: (next: string | null) => void }) {
  /**
   * The catalogue, for the picker. Its own load, so a log view still works when
   * the catalogue read fails — an operator debugging a proxy that will not
   * start needs the lines more than they need the dropdown.
   */
  const loadCatalogue = useCallback(async (): Promise<{ id: string; label: string }[]> => {
    const page = await api(`${PLUGIN_API}/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}&limit=200`, KvPageSchema)
    return page.items.map((entry) => {
      const id = proxyIdFromKey(entry.key) ?? entry.key
      return { id, label: readProxy(entry.value).label || id }
    })
  }, [])
  const { data: catalogue } = useLoader(loadCatalogue, [])

  const [lines, setLines] = useState<LogLine[]>([])
  const [truncated, setTruncated] = useState(false)
  /** What the farm says it filtered by — checked, never assumed. `null` is a page of every line. */
  const [serverSubject, setServerSubject] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [follow, setFollow] = useState(true)

  /** The highest `seq` already held. `null` asks for the oldest the farm still keeps. */
  const cursor = useRef<number | null>(null)
  const alive = useRef(true)

  const fetchPage = useCallback(
    async (reset: boolean): Promise<void> => {
      if (reset) {
        cursor.current = null
        setLines([])
        setTruncated(false)
        setLoading(true)
      }
      try {
        const page = await api(logsPath({ proxy, cursor: cursor.current, limit: PAGE_LIMIT }), LogPageSchema)
        if (!alive.current) return
        cursor.current = page.nextSeq
        setServerSubject(page.subject)
        // Newest at the bottom, oldest dropped first — the shape a log is read
        // in. The overlap is dropped against what is ALREADY HELD rather than
        // against the cursor this request carried: `seq` is the key React
        // renders these by, and two polls that raced (or a farm that answered
        // its cursor inclusively) would otherwise show every line twice under
        // duplicate keys. This is the same fetch-then-subscribe join every live
        // surface in this farm does, `/ws` having no snapshot replay.
        setLines((prev) => {
          const held = prev.at(-1)?.seq ?? null
          const fresh = held === null ? page.lines : page.lines.filter((line) => line.seq > held)
          return fresh.length === 0 ? prev : [...prev, ...fresh].slice(-MAX_LINES)
        })
        // Sticky: once lines have been evicted they are gone, and a later page
        // that happens not to have lost any does not make that untrue.
        if (page.truncated) setTruncated(true)
        setError(null)
      } catch (e: unknown) {
        if (!alive.current) return
        // Fail CLOSED. An empty list here would read as "this plugin has logged
        // nothing", which is the one thing a failed read cannot tell you.
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive.current) setLoading(false)
      }
    },
    [proxy],
  )

  useEffect(() => {
    alive.current = true
    void fetchPage(true)
    return () => {
      alive.current = false
    }
  }, [fetchPage])

  // Following stops on an error rather than hammering a route that is refusing:
  // the retry is the operator's, and it says so on the button.
  usePoll(() => void fetchPage(false), follow && error === null ? POLL_MS : null)

  const label = useMemo(() => {
    if (proxy === null) return null
    return catalogue?.find((row) => row.id === proxy)?.label ?? proxy
  }, [catalogue, proxy])

  /**
   * The filter was asked for and the farm answered with an unfiltered page.
   *
   * The farm echoes the tag it filtered on, and this checks it rather than
   * assuming the request was honoured — because the failure it catches is the
   * one that matters: a page of EVERY proxy's lines under a heading that names
   * one. Say it; do not quietly filter the page here to make the heading true.
   * (The tag is derived server-side from `?proxy=`, so this fires when the tag
   * this pack writes and the tag it filters by have drifted apart — which is
   * exactly the silent, permanent emptiness the 64-character clamp can cause.)
   */
  const filterNotHonoured = proxy !== null && lines.length > 0 && serverSubject === null

  return (
    <div className="@container space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={proxy ?? ALL} onValueChange={(v) => onProxyChange(v === ALL ? null : v)}>
          <SelectTrigger className="w-full @md:w-64" aria-label="Which proxy's lines to show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All proxies</SelectItem>
            {(catalogue ?? []).map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {row.label}
              </SelectItem>
            ))}
            {/* A deep link can name a proxy that is no longer in the catalogue.
                Its lines may well still be in the ring, and dropping the
                selection would silently show every proxy's instead. */}
            {proxy !== null && !(catalogue ?? []).some((row) => row.id === proxy) ? <SelectItem value={proxy}>{proxy} (not in the catalogue)</SelectItem> : null}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch id="pm-follow" checked={follow} onCheckedChange={setFollow} />
          <Label htmlFor="pm-follow" className="text-[12px] font-normal text-fg-muted">
            Follow
          </Label>
        </div>

        <span className="readout text-[11.5px] text-fg-muted">{lines.length} lines</span>

        <div className="grow" />
        <Button variant="outline" size="sm" onClick={() => void fetchPage(true)}>
          Reload
        </Button>
      </div>

      {/*
        Both notes are declared in `shared.ts` rather than written here: one
        says what a line records and what it never does, and it is a promise
        about `logbook.ts`'s own field allowlist — a screen that paraphrased it
        could promise something the code does not do.
      */}
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">
        {proxy === null
          ? `Every line this plugin’s service has written and the farm still keeps, refreshed every ${POLL_MS / 1000} seconds while Follow is on. Lines that belong to no single proxy — the supervisor’s own — appear only here.`
          : `Only the lines tagged “${label}”. Lines that belong to no single proxy — the supervisor’s own — are under All proxies.`}{' '}
        {LOGS_SHARED_RING_NOTE}
      </p>
      <p className="max-w-prose text-[12px] leading-relaxed text-fg-muted">{LOGS_CONTENT_NOTE}</p>

      {truncated ? (
        <p className="rounded-lg border border-led-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
          Lines were dropped before this view could read them — either older ones the farm no longer keeps, or more than one page’s worth
          ({PROXY_LOGS_DEFAULT_LIMIT}) arriving at once. What is missing here is not a proxy that did nothing; press Reload for the most recent page.
        </p>
      ) : null}

      {filterNotHonoured ? (
        <p className="rounded-lg border border-led-warn/35 px-3 py-2 text-[11.5px] leading-relaxed text-fg-muted">
          The farm answered without applying the filter, so these are lines from every proxy rather than only “{label}”. They are shown as they came
          back rather than trimmed here, because a page this view filtered itself would be missing whatever the ring had already evicted — and would say
          nothing about it.
        </p>
      ) : null}

      {error ? (
        /*
          Fail closed, and say which failure this is. The farm answers 503
          `E_PLUGIN_LOGS_UNAVAILABLE` with no `lines` key at all rather than an
          empty page, deliberately — an empty list here would read as "this
          plugin has logged nothing", which is the one thing a failed read
          cannot tell you. The note under it says the same in words, because the
          message a 503 carries is not always the message an operator needs.
        */
        <div className="space-y-2">
          <ErrorState message={error} onRetry={() => void fetchPage(true)} />
          <p className="text-[11.5px] leading-relaxed text-fg-muted">
            No lines are shown because none could be read — not because none were written. Following is paused until this succeeds.
          </p>
        </div>
      ) : loading ? (
        <LoadingRows rows={4} />
      ) : lines.length === 0 ? (
        <EmptyState
          title={proxy === null ? 'No lines retained' : 'No lines for this proxy'}
          description={
            proxy === null
              ? 'This plugin’s service has written nothing the farm still holds. A bridge logs when it accepts, connects, closes or refuses a connection — a proxy nothing has dialled is silent by design.'
              : 'Nothing tagged with this record is in what the farm still keeps. That is not the same as “it did nothing”: one log is shared by every proxy in this plugin, so a busy neighbour can have pushed these lines out.'
          }
          action={
            proxy === null ? undefined : (
              <Button variant="outline" size="sm" onClick={() => onProxyChange(null)}>
                Show every proxy
              </Button>
            )
          }
        />
      ) : (
        <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-border">
          <ul className="divide-y divide-border">
            {lines.map((line) => (
              <LogRow key={line.seq} line={line} showSubject={proxy === null} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * One line.
 *
 * It wraps rather than scrolls sideways: a log is the surface most likely to be
 * read in a narrow panel, and a horizontal scrollbar in a list is a scrollbar
 * per line to a screen reader and a lost message to everyone else. `min-w-0` on
 * the flex child is what actually lets the text wrap instead of forcing the row
 * wider than its container.
 */
function LogRow({ line, showSubject }: { line: LogLine; showSubject: boolean }) {
  const tone =
    line.level === 'error' ? 'text-led-danger' : line.level === 'warn' ? 'text-led-warn' : line.level === 'debug' ? 'text-fg-muted' : 'text-fg'
  const fields = Object.entries(line.fields ?? {})
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-[12px]">
      <span className="readout shrink-0 text-[11px] text-fg-muted">{new Date(line.ts).toLocaleTimeString()}</span>
      <span className={cn('readout shrink-0 text-[11px] uppercase', tone)}>{line.level}</span>
      {showSubject && line.subject ? (
        <Badge variant="outline" className="shrink-0 text-[10.5px]">
          {line.subject}
        </Badge>
      ) : null}
      <span className="min-w-0 break-words">{line.msg}</span>
      {fields.length > 0 ? (
        /* `.readout` is `white-space: nowrap`, which is right for a duration in
           a table cell and wrong for a bag of fields that can name a code, a
           reason and three counters: under nowrap the list scrolls sideways
           inside its own box, which is a scrollbar per line. */
        <span className="readout min-w-0 break-words whitespace-normal text-[11px] text-fg-muted">
          {fields.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' ')}
        </span>
      ) : null}
    </li>
  )
}
