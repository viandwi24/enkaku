import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginLogLine, PluginLogPage } from '@enkaku/protocol'
import { buildSecretRedactor, type KvStore } from '../kv/store'
import { createLogger, type Logger } from '../util/logger'

/**
 * Plan 109 (M74 — the plugin runtime), step 109.8 — **a plugin service's log.**
 *
 * R3's shape, followed rather than reinvented (`jobs/log-buffer.ts` is the
 * precedent and it is deliberately visible in this file): a bounded in-memory
 * ring, a rotated file on disk, a WS broadcast, and an honest `truncated` flag.
 * The three answer three different questions and none of them substitutes for
 * another — the ring is *what has happened recently*, the file is *the record*,
 * and the broadcast is *what is happening now*.
 *
 * ## `ctx.log` is one vocabulary with two subjects
 *
 * A script handler's `ctx.log.info(...)` joins its job's log; a service
 * handler's joins this. They are the same four methods with the same two
 * arguments, assembled by the same `buildPluginContext`, and they are redacted
 * by the same function (`buildSecretRedactor`). What differs is where the line
 * lands, which is the only thing that should.
 *
 * ## One ring, tagged — not one ring per subject
 *
 * A plugin that manages N things (plan 112's proxy manager is the first, and
 * wants "logs all, and logs per proxy") gets **one** ring with every line
 * optionally tagged, and a per-subject view is a predicate over it. N rings for
 * N subjects would be core memory that scales with a list an operator edits,
 * and a deleted subject would take its own history away at exactly the moment
 * someone wanted to know why it was deleted.
 *
 * The tag is `fields.subject`, lifted out of the ordinary fields bag onto the
 * line. That keeps `ctx.log`'s signature identical on both hosts instead of
 * giving a service a logger the job child cannot have — and it means the
 * server-side filter (`?subject=`) exists from day one, so plan 112 §3.8's
 * fallback of filtering client-side is not needed and no interface has to be
 * widened later.
 *
 * The cost is real and is stated where a reader will see it: **a busy subject
 * evicts a quiet one's lines**, because the budget is per plugin. `truncated`
 * is what stops that reading as "this subject did nothing".
 *
 * ## Redaction is a promise about an absence, so here is exactly what it is
 *
 * Every line — the message AND the serialised fields — passes through
 * `buildSecretRedactor`, the same value-based redactor the job logger uses
 * (`kv/runner-port.ts`), over:
 *
 * - every **secret KV entry in the plugin's own global namespace**, replaced
 *   with `«redacted:<key>»`;
 * - every **webhook secret the farm generated for this plugin** (step 109.7),
 *   replaced with `«redacted:webhook:<id>»` — those live outside KV, in
 *   `plugin_webhooks`, so the KV redactor cannot see them and they are supplied
 *   separately.
 *
 * **What it does not do, stated rather than implied**, because a redactor
 * oversold is worse than none:
 *
 * - it is a **substring replace**, so a secret the plugin split across two
 *   lines, base64'd, or interpolated into a URL-encoded string is not matched;
 * - `buildSecretRedactor` ignores anything shorter than 8 characters, on its
 *   own stated reasoning about false positives — a short secret is not
 *   redacted;
 * - it only sees values it can enumerate. A credential the plugin holds in a
 *   variable and never stored is invisible to it;
 * - **device-scoped** secrets are not scanned. A service has no ambient device,
 *   and scanning every device's scope per line is unbounded work; the farm
 *   scope is what a service's own configuration lives in.
 *
 * So this is defence in depth. The primary defence is not passing a credential
 * to a log call, and that is the plugin's job.
 */

/** Lines kept in memory per plugin. The same 2 000 `jobs/log-buffer.ts` keeps per job. */
export const PLUGIN_LOG_RING_LINES = 2_000
/** Plugins retained at once, so the whole structure is bounded at `PLUGIN_LOG_RING_LINES × this`. */
export const PLUGIN_LOG_MAX_PLUGINS = 100
/** Bytes before `runtime.log` is rotated. */
export const PLUGIN_LOG_ROTATE_BYTES = 5 * 1024 * 1024
/** How many rotated generations are kept — `runtime.log` plus this many `.N` files. */
export const PLUGIN_LOG_KEEP_FILES = 1
/** A tag longer than this is truncated. It is a filter key, not a message. */
export const PLUGIN_LOG_MAX_SUBJECT = 64
/**
 * How long a built redactor is reused before it is rebuilt.
 *
 * The job logger builds one per LINE, and this deliberately does not: a job
 * logs at human pace and a service can log per connection, so a `list()` plus
 * one AES-GCM decrypt per secret per line is the difference between free and a
 * measurable cost in the core's event loop. Same function, same output, same
 * secrets — memoised for a few seconds. The cost of the memo is stated too: a
 * secret written and then logged within the same window is not redacted in
 * those first lines.
 */
export const PLUGIN_LOG_REDACTOR_TTL_MS = 5_000

export type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface PluginLogStore {
  /** Record one line. Called by the runtime host's `emitLog` port for every `ctx.log.*` a service makes. */
  append(pluginId: string, level: PluginLogLevel, msg: string, fields?: Record<string, unknown>): void
  /**
   * A page of retained lines, oldest first.
   *
   * `cursor` is the last `seq` the caller already has; `null` means "from the
   * oldest retained". `subject` filters to lines carrying exactly that tag —
   * the server-side half plan 112 §3.8 leaves open, present from the start so a
   * per-subject view never needs a second stream.
   */
  page(pluginId: string, opts?: { cursor?: number | null; subject?: string | null; limit?: number }): PluginLogPage
  /**
   * Throw away the memoised redactor for one plugin, so the next line rebuilds
   * it.
   *
   * The TTL below is a performance memo and it has one honest cost: a secret
   * that comes into existence inside the window is not redacted until the
   * window closes. For KV that is unavoidable without a write hook on the
   * store, and the window is seconds. For a FARM-generated secret it is not:
   * the farm knows the exact moment it mints or rotates one, so `daemon.ts`
   * calls this there. The one secret the farm created itself is the one it has
   * no excuse for missing.
   */
  invalidateRedactor(pluginId: string): void
  /** Release one plugin's ring. Called when a plugin is removed — not when its service stops, which is a state the operator is most likely to be reading the log about. */
  release(pluginId: string): void
  /** Plugins currently retained. */
  size(): number
  /**
   * Drop every ring.
   *
   * There is deliberately nothing to close: the file is appended with
   * `appendFileSync` and no descriptor is held between lines, so a core that
   * dies without calling this loses no log and leaks no handle. This exists for
   * a test that wants a clean slate, not for shutdown correctness.
   */
  dispose(): void
}

export interface PluginLogStoreDeps {
  dataDir: string
  /**
   * The plugin's own KV namespace is scanned for secrets to redact. Absent ⇒
   * no KV redaction at all. Optional only so a test can say "this store has no
   * secrets to hide"; `daemon.ts` always wires it, and a host that forgot to
   * would be a farm whose plugin logs are unredacted, which is why the tests
   * assert on the redaction rather than on the wiring.
   */
  store?: KvStore
  /**
   * Farm-held secrets for one plugin that are NOT in KV — today, its webhook
   * secrets (step 109.7). A function rather than a store handle for the same
   * reason `resolveStableId` is one: this module must not be able to reach
   * anything wider than the strings it needs.
   */
  extraSecrets?: (pluginId: string) => Array<{ key: string; plaintext: string }>
  /** Called after a line is recorded and redacted. `daemon.ts` passes `hub.broadcast` of a `plugin.log`. */
  broadcast?: (pluginId: string, line: PluginLogLine) => void
  /** Set `false` to keep everything in memory (tests). */
  writeFiles?: boolean
  /**
   * Overrides for tests, and only for tests.
   *
   * Rotation and eviction are the two behaviours whose whole point is what
   * happens at the boundary, and a test that had to write 5 MiB to reach one of
   * them would be a test nobody runs. The production values are the constants
   * above; these exist so the boundary is reachable in milliseconds.
   */
  rotateBytes?: number
  ringLines?: number
  log?: Logger
  now?: () => number
}

interface Ring {
  lines: PluginLogLine[]
  truncated: boolean
  /** The next `seq` to hand out. Monotonic per plugin, from this process's boot. */
  nextSeq: number
  /** The lowest `seq` still retained, so a cursor older than it can be reported as a gap rather than silently satisfied. */
  oldestSeq: number
  file?: { path: string; bytes: number }
  redactor?: { fn: (text: string) => string; builtAt: number }
}

function clampSubject(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, PLUGIN_LOG_MAX_SUBJECT)
}

export function createPluginLogStore(deps: PluginLogStoreDeps): PluginLogStore {
  const log = deps.log ?? createLogger('plugin.logs')
  const now = deps.now ?? (() => Date.now())
  const writeFiles = deps.writeFiles !== false
  const rotateBytes = deps.rotateBytes ?? PLUGIN_LOG_ROTATE_BYTES
  const ringLines = deps.ringLines ?? PLUGIN_LOG_RING_LINES
  const rings = new Map<string, Ring>()

  function ringFor(pluginId: string): Ring {
    let ring = rings.get(pluginId)
    if (ring) return ring
    if (rings.size >= PLUGIN_LOG_MAX_PLUGINS) {
      // Insertion-ordered, so the oldest plugin to have logged anything is
      // `keys().next()`. A farm with more than 100 plugins logging at once is
      // not a shape this bounds well, and dropping the least recently STARTED
      // is the honest approximation — the alternative is unbounded core memory.
      const oldest = rings.keys().next()
      if (!oldest.done) rings.delete(oldest.value)
    }
    ring = { lines: [], truncated: false, nextSeq: 1, oldestSeq: 1 }
    rings.set(pluginId, ring)
    return ring
  }

  /**
   * The redactor for one plugin, rebuilt at most every
   * `PLUGIN_LOG_REDACTOR_TTL_MS`. Never throws: a redaction that failed and
   * took the log line with it would be the worst of both — no line, and no
   * redaction either. `buildSecretRedactor`'s own caller in
   * `kv/runner-port.ts` makes the same call.
   */
  function redactorFor(pluginId: string, ring: Ring): (text: string) => string {
    const at = now()
    if (ring.redactor && at - ring.redactor.builtAt < PLUGIN_LOG_REDACTOR_TTL_MS) return ring.redactor.fn
    let fn: (text: string) => string = (text) => text
    try {
      const kvRedact = deps.store ? buildSecretRedactor(deps.store, [{ kind: 'global' }], pluginId) : (text: string) => text
      const extra = (deps.extraSecrets?.(pluginId) ?? []).filter((s) => s.plaintext.length >= 8).sort((a, b) => b.plaintext.length - a.plaintext.length)
      fn =
        extra.length === 0
          ? kvRedact
          : (text) => kvRedact(extra.reduce((acc, s) => acc.split(s.plaintext).join(`«redacted:${s.key}»`), text))
    } catch (err) {
      log.warn(`plugin "${pluginId}": building the log redactor failed, so this window's lines are UNREDACTED — ${err instanceof Error ? err.message : String(err)}`)
    }
    ring.redactor = { fn, builtAt: at }
    return fn
  }

  function fileFor(pluginId: string, ring: Ring): { path: string; bytes: number } | null {
    if (!writeFiles) return null
    if (ring.file) return ring.file
    try {
      const dir = join(deps.dataDir, 'plugins', pluginId)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'runtime.log')
      let bytes = 0
      try {
        bytes = statSync(path).size
      } catch {
        // No file yet.
      }
      ring.file = { path, bytes }
      return ring.file
    } catch (err) {
      log.warn(`plugin "${pluginId}": its runtime log file could not be opened, so only the in-memory ring is kept — ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Rotate, and **say so in the log itself.**
   *
   * What is kept: the live `runtime.log`, plus `PLUGIN_LOG_KEEP_FILES` previous
   * generations — so 10 MiB per plugin with the defaults. What is dropped: the
   * oldest generation, deleted outright.
   *
   * How a reader learns: the banner this writes is a real log line. It goes
   * into the ring and onto the broadcast like any other, at `warn`, so a live
   * reader sees the gap happen and a reader of the file finds it at the head of
   * the new one. The alternative — rotating silently and relying on the ring's
   * `truncated` flag — only tells a reader that the MEMORY window dropped
   * something, which is a different and much smaller fact.
   */
  function rotate(pluginId: string, ring: Ring, file: { path: string; bytes: number }): void {
    try {
      const oldest = `${file.path}.${PLUGIN_LOG_KEEP_FILES}`
      rmSync(oldest, { force: true })
      for (let i = PLUGIN_LOG_KEEP_FILES; i > 1; i--) {
        try {
          renameSync(`${file.path}.${i - 1}`, `${file.path}.${i}`)
        } catch {
          // That generation does not exist yet.
        }
      }
      renameSync(file.path, `${file.path}.1`)
      file.bytes = 0
      record(
        pluginId,
        'warn',
        `-- log rotated: the previous ${PLUGIN_LOG_ROTATE_BYTES} bytes are now runtime.log.1, and anything older than that has been deleted. ` +
          `This farm keeps ${PLUGIN_LOG_KEEP_FILES + 1} generations per plugin. --`,
        undefined,
        { skipRedaction: true },
      )
    } catch (err) {
      log.warn(`plugin "${pluginId}": rotating its runtime log failed, so the file will keep growing — ${err instanceof Error ? err.message : String(err)}`)
      // Reset the counter anyway; otherwise a rotation that cannot succeed
      // retries on every single line.
      file.bytes = 0
    }
  }

  function record(pluginId: string, level: PluginLogLevel, msg: string, fields: Record<string, unknown> | undefined, opts?: { skipRedaction?: boolean }): void {
    const ring = ringFor(pluginId)
    const subject = clampSubject(fields?.subject)
    // `subject` is lifted, not copied: it is on the line, so leaving it in the
    // bag as well would render twice in every view that shows both.
    let rest: Record<string, unknown> | undefined
    if (fields) {
      const { subject: _lifted, ...others } = fields
      rest = Object.keys(others).length > 0 ? others : undefined
    }

    let text = msg
    let redactedFields = rest
    if (!opts?.skipRedaction) {
      const redact = redactorFor(pluginId, ring)
      text = redact(msg)
      if (rest) {
        // Fields go through the SAME redactor, via their JSON form: a secret
        // passed as `{ password }` is exactly as exposed as one interpolated
        // into the message, and a redactor that only looked at the message
        // would be a promise with a hole in the shape of the easier mistake.
        try {
          const serialised = redact(JSON.stringify(rest))
          const parsed: unknown = JSON.parse(serialised)
          redactedFields = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : rest
        } catch {
          // Unserialisable fields (a circular object, a BigInt). Dropped rather
          // than passed through unredacted — an unredactable field bag is the
          // one case where losing the data is the safe answer.
          redactedFields = { '(unserialisable fields dropped)': true }
        }
      }
    }

    const line: PluginLogLine = {
      seq: ring.nextSeq++,
      ts: now(),
      level,
      subject,
      msg: text,
      ...(redactedFields ? { fields: redactedFields } : {}),
    }

    ring.lines.push(line)
    if (ring.lines.length > ringLines) {
      const dropped = ring.lines.splice(0, ring.lines.length - ringLines)
      ring.truncated = true
      const first = ring.lines[0]
      ring.oldestSeq = first ? first.seq : ring.oldestSeq + dropped.length
    }

    const file = fileFor(pluginId, ring)
    if (file) {
      const text2 = `${new Date(line.ts).toISOString()} ${line.level.toUpperCase()}${line.subject ? ` [${line.subject}]` : ''} ${line.msg}${line.fields ? ` ${JSON.stringify(line.fields)}` : ''}\n`
      const bytes = Buffer.byteLength(text2, 'utf8')
      try {
        // Appended synchronously and unbuffered. A plugin's log is small
        // relative to everything else the core writes, and an async queue here
        // would mean a crash loses exactly the lines that explain it.
        //
        // `appendFileSync`, never `Bun.write`: that one TRUNCATES, which would
        // turn a log into a one-line file that always looks like the plugin
        // just started.
        appendFileSync(file.path, text2, 'utf8')
        file.bytes += bytes
      } catch (err) {
        log.warn(`plugin "${pluginId}": writing its runtime log failed — ${err instanceof Error ? err.message : String(err)}`)
      }
      if (file.bytes >= rotateBytes) rotate(pluginId, ring, file)
    }

    deps.broadcast?.(pluginId, line)
  }

  return {
    append(pluginId, level, msg, fields) {
      record(pluginId, level, msg, fields)
    },

    page(pluginId, opts) {
      const ring = rings.get(pluginId)
      const subject = opts?.subject ?? null
      if (!ring) return { plugin: pluginId, lines: [], truncated: false, nextSeq: 0, subject }
      const cursor = opts?.cursor ?? null
      const limit = Math.max(1, Math.min(opts?.limit ?? ringLines, ringLines))
      let lines = cursor === null ? ring.lines : ring.lines.filter((l) => l.seq > cursor)
      // The gap is reported per READER, not only per ring: a caller whose
      // cursor is older than the oldest retained line has missed something even
      // if the ring has not wrapped since it last asked.
      const missed = cursor !== null && cursor + 1 < ring.oldestSeq
      if (subject !== null) lines = lines.filter((l) => l.subject === subject)
      const page = lines.slice(-limit)
      const truncatedByLimit = lines.length > page.length
      const last = ring.lines[ring.lines.length - 1]
      return {
        plugin: pluginId,
        lines: page,
        truncated: ring.truncated || missed || truncatedByLimit,
        nextSeq: last ? last.seq : (cursor ?? 0),
        subject,
      }
    },

    invalidateRedactor(pluginId) {
      const ring = rings.get(pluginId)
      if (ring) delete ring.redactor
    },

    release(pluginId) {
      rings.delete(pluginId)
    },

    size: () => rings.size,

    dispose() {
      rings.clear()
    },
  }
}
