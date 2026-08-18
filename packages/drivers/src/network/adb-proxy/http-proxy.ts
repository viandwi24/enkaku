import { shellQuote } from '@enkaku/adb'
import type { HttpProxyRouteConfig, NetworkObservation, PersistedNetworkRoute, Transport } from '@enkaku/protocol'
import type { NetworkRoute } from '../guest-agent/index'

/**
 * The `adb-proxy` network engine (plan 114 §3.2, §3.6, §4.2; spec §7.9 rung 1)
 * — rung 1 of the network layer's three-rung ladder, and the only one that
 * needs nothing on the device at all: it writes Android's own system proxy
 * setting over plain adb, on a phone with no guest agent installed and no root.
 *
 * **What this engine can and cannot claim, stated once here because every
 * word downstream depends on it.** `settings global http_proxy` is ADVISORY.
 * WebView and the `HttpURLConnection` family honour it; an app using raw
 * sockets, its own resolver, or a pinned client ignores it completely and
 * nothing on the phone stops it. So this engine advertises every
 * `NetworkCapabilities` field as `false`, its `egress` check is permanently
 * `skip`, and `deriveHealth` therefore reports `unverified` for it forever
 * (plan 114 §3.5). That is the correct answer, not a gap to close later: a
 * probe run from the host proves the proxy works for the host, and a probe run
 * on the device through a client that honours the setting proves only that
 * such a client can reach it — never that any app under test used it.
 * `probe()` and `hold()` below are consequently NOT DEFINED, deliberately:
 * `NetworkRoute` makes them optional so a caller discovers what an engine can
 * do rather than assuming it, and defining a `probe` that could only ever
 * answer "a client which honours the setting reached the proxy" would promote
 * `health` to `ok` on a fact nobody asked about.
 *
 * **Capture-then-restore, not a blind reset.** Plan 33 §5's original
 * prescription was `settings put global http_proxy :0` on revert. Measured on
 * the reference device (Android 15 / API 35, shell uid 2000, no root): that
 * leaves the literal string `:0` where a pristine device had `null`, so a
 * phone that had never been proxied does not come back pristine, and a phone
 * where the operator had set their OWN proxy has it destroyed. Plan 114 §3.6
 * corrects that prescription, and this module implements the correction the
 * way `packages/session/src/screen-label.ts` already implements it for
 * `secure` keys: read the prior values first, normalise Android's literal
 * string `null` to `''`, write, READ BACK AND COMPARE, and on revert re-issue
 * exactly what was captured — with a separate, explicitly different path for
 * "nothing was ever captured".
 *
 * **Nothing here claims a success it did not read back.** `apply()` re-reads
 * the device and throws `E_SETTING_NOT_ACCEPTED` when the value disagrees;
 * `observe()` reports what the device says, never what we asked for.
 *
 * The engine holds no state of its own: the capture lives on
 * `devices.network_route.captured` (`PersistedNetworkRouteSchema`) and reaches
 * this file through `deps.capture`, exactly as `labelling.ts` persists
 * `screen-label.ts`'s captured value for it. Step 114.3 is what wires that
 * store to the DB; step 114.5 composes this settings writer with `adb reverse`
 * for the `adb-reverse-proxy` rung.
 */

/** The four `Settings.Global` keys this engine ever touches (plan 114 §3.6 rule 1). */
export const HTTP_PROXY_KEY = 'http_proxy'
export const HTTP_PROXY_HOST_KEY = 'global_http_proxy_host'
export const HTTP_PROXY_PORT_KEY = 'global_http_proxy_port'
export const HTTP_PROXY_EXCLUSION_LIST_KEY = 'global_http_proxy_exclusion_list'

/**
 * Android's own "no proxy" value, and the reason it is still written even
 * though this engine does not END on it: plan 33 §5 recorded that a bare
 * `settings delete` is not enough on many builds to make the framework stop
 * using a proxy it has already read, while `:0` reliably is. So the clear and
 * restore-to-unset paths below write `:0` FIRST — the value the framework
 * notices — and only then delete the row, so the key ends up genuinely unset
 * (`settings get` prints `null`) rather than holding the literal `:0` a
 * pristine device never had. Both writes converge on "no proxy"; the delete is
 * what makes the device look untouched afterwards.
 */
export const HTTP_PROXY_RESET_VALUE = ':0'

/** The four keys as the device reports them, already normalised — `''` means the key is unset. */
export interface HttpProxySettings {
  httpProxy: string
  host: string
  port: string
  exclusionList: string
}

/**
 * The persisted capture, typed from `PersistedNetworkRouteSchema.captured`
 * rather than re-declared, so the engine and the row it is stored on cannot
 * drift apart.
 */
export type CapturedHttpProxySettings = NonNullable<PersistedNetworkRoute['captured']>

/**
 * Where the pre-farm capture is read from and written to. Deliberately not
 * owned by the engine: a capture that only lived in this process would be gone
 * after a core restart, which is precisely when a revert needs it.
 *
 * `read()` returning `null` means **nothing was ever captured** — a route that
 * predates plan 114, or a capture that failed because the device was
 * unreachable. That is a different fact from an EMPTY capture (a device that
 * genuinely had no proxy set), and `revert()` below must not conflate them:
 * an empty capture is restored verbatim, a missing one falls back to clearing
 * the keys, which the UI is required to word differently (plan 114 §3.6 rule 4).
 *
 * Both methods may be synchronous or return a promise — the core's store is a
 * DB write, a test's is a variable.
 */
export interface HttpProxyCaptureStore {
  read(): CapturedHttpProxySettings | null | Promise<CapturedHttpProxySettings | null>
  write(captured: CapturedHttpProxySettings): void | Promise<void>
}

/** Coded failures — callers match on `.code`, never on `.message` (CLAUDE.md). */
export type HttpProxyErrorCode = 'E_SETTING_READ_FAILED' | 'E_SETTING_WRITE_FAILED' | 'E_SETTING_NOT_ACCEPTED'

export class HttpProxyError extends Error {
  constructor(
    public code: HttpProxyErrorCode,
    message: string,
    /** What this engine wrote — set only on `E_SETTING_NOT_ACCEPTED`, for the caller's `setting` check detail. */
    public expected?: string,
    /** What the device answered on the read-back — same. */
    public observed?: string,
  ) {
    super(message)
    this.name = 'HttpProxyError'
  }
}

export interface CreateHttpProxyRouteOptions {
  transport: Transport
  deviceId: string
  /** Reads/writes the persisted capture (plan 114 §4.2). The engine holds no state of its own. */
  capture: HttpProxyCaptureStore
  onLog?: (level: 'debug' | 'info' | 'warn', msg: string) => void
}

/**
 * `settings get` prints the literal string `null` for a key that was never set
 * — normalised to `''`, exactly as `screen-label.ts` does, so "unset" has one
 * representation everywhere instead of two that compare unequal.
 */
export function normaliseUnset(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === 'null' ? '' : trimmed
}

/**
 * The exact string this engine writes to `http_proxy` for a config. Exported
 * so the core's `setting` check (plan 114 §3.5, step 114.3) compares the
 * device's answer against ONE definition rather than re-deriving the format
 * and drifting from it.
 */
export function httpProxyValue(config: Pick<HttpProxyRouteConfig, 'host' | 'port'>): string {
  return `${config.host}:${config.port}`
}

/**
 * The exclusion list as Android stores it: a comma-separated string, `''` when
 * the operator declared none. Note what "declared none" means for `apply()`
 * below — the key is DELETED rather than left alone. Leaving it would keep a
 * stale exclusion list in force after the operator removed it from the config,
 * which is the silent-wrong-answer shape this layer exists to avoid.
 */
export function httpProxyExclusionList(config: Pick<HttpProxyRouteConfig, 'exclusions'>): string {
  return (config.exclusions ?? []).join(',')
}

/**
 * Read-only — never writes. Used for the pre-write capture, for the post-write
 * read-back, and for `observe()`, so all three see the device through the same
 * lens.
 *
 * Unlike `screen-label.ts`'s reader, a failed read is NOT swallowed into `''`:
 * that would let an unreachable device be captured as a pristine one, and the
 * captured value is what a revert restores months later. `E_SETTING_READ_FAILED`
 * is the honest answer, and `apply()` propagates it before writing anything.
 */
export async function readHttpProxySettings(transport: Transport): Promise<HttpProxySettings> {
  // Sequential, not `Promise.all`: every one of these goes through the same per-device adb queue
  // anyway (`packages/adb`'s command queue), so four parallel reads buy nothing and only make the
  // failure order non-deterministic.
  const httpProxy = await getSetting(transport, HTTP_PROXY_KEY)
  const host = await getSetting(transport, HTTP_PROXY_HOST_KEY)
  const port = await getSetting(transport, HTTP_PROXY_PORT_KEY)
  const exclusionList = await getSetting(transport, HTTP_PROXY_EXCLUSION_LIST_KEY)
  return { httpProxy, host, port, exclusionList }
}

async function getSetting(transport: Transport, key: string): Promise<string> {
  const result = await transport.exec(`settings get global ${key}`, { profile: 'probe' })
  // `exitCode: null` is the un-framed shell fallback (plan 53 §3.4) — it means the exit status is
  // genuinely unknown on this device, not that it was zero, so only a KNOWN non-zero is a failure.
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new HttpProxyError(
      'E_SETTING_READ_FAILED',
      `settings get global ${key} exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`,
    )
  }
  return normaliseUnset(result.stdout)
}

async function putSetting(transport: Transport, key: string, value: string): Promise<void> {
  const result = await transport.exec(`settings put global ${key} ${shellQuote(value)}`, { profile: 'probe' })
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new HttpProxyError(
      'E_SETTING_WRITE_FAILED',
      `settings put global ${key} exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`,
    )
  }
}

async function deleteSetting(transport: Transport, key: string): Promise<void> {
  const result = await transport.exec(`settings delete global ${key}`, { profile: 'probe' })
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new HttpProxyError(
      'E_SETTING_WRITE_FAILED',
      `settings delete global ${key} exited ${result.exitCode}: ${result.stderr.trim() || '(no stderr)'}`,
    )
  }
}

/**
 * The `adb-proxy` `NetworkRoute` — see this file's header for what it may and
 * may not claim. `NetworkRoute<HttpProxyRouteConfig>` rather than the bare
 * `NetworkRoute` (whose default config is `vpn-helper`'s SOCKS5 shape): the
 * interface gained its type parameter in plan 114 §4.2 precisely so a second
 * engine could join the layer without either engine widening its own `apply`
 * to a union it does not understand.
 */
export function createHttpProxyRoute(deps: CreateHttpProxyRouteOptions): NetworkRoute<HttpProxyRouteConfig> {
  const { transport, deviceId, capture } = deps
  const log = (level: 'debug' | 'info' | 'warn', msg: string) => deps.onLog?.(level, `adb-proxy[${deviceId}] ${msg}`)

  /**
   * Plan 114 §3.6 rule 1 — captured ONCE, before the first write, and never
   * overwritten by a later re-apply. Overwriting is the failure that matters
   * here: the second apply would record the FARM's own value as "the
   * original", and the device's real prior state would be gone for good.
   */
  async function captureOnce(): Promise<void> {
    if ((await capture.read()) !== null) return
    // Deliberately before any write and deliberately not caught: an unreachable device must leave
    // the phone untouched and the capture absent, rather than recording a pristine-looking capture
    // that a later revert would faithfully restore over the operator's real proxy.
    const before = await readHttpProxySettings(transport)
    await capture.write({ ...before, at: Math.floor(Date.now() / 1000) })
    log('debug', `captured prior proxy settings: ${JSON.stringify(before)}`)
  }

  /** Restores one key: a captured `''` means the key was UNSET, which is a delete, not a write of an empty string. */
  async function restoreKey(key: string, value: string): Promise<void> {
    if (value === '') {
      await deleteSetting(transport, key).catch((err) => log('warn', `restore: delete ${key} failed, tolerated: ${String(err)}`))
      return
    }
    await putSetting(transport, key, value).catch((err) => log('warn', `restore: put ${key} failed, tolerated: ${String(err)}`))
  }

  /**
   * The composite key, restored LAST in every path below — it is the one the
   * framework broadcasts on, so writing it after the derived keys and the
   * exclusion list means the device never sees a half-restored combination.
   * A captured `''` gets the `:0`-then-delete pair described on
   * `HTTP_PROXY_RESET_VALUE`.
   */
  async function restoreComposite(value: string): Promise<void> {
    if (value !== '') {
      await putSetting(transport, HTTP_PROXY_KEY, value).catch((err) =>
        log('warn', `restore: put ${HTTP_PROXY_KEY} failed, tolerated: ${String(err)}`),
      )
      return
    }
    await putSetting(transport, HTTP_PROXY_KEY, HTTP_PROXY_RESET_VALUE).catch((err) =>
      log('warn', `restore: put ${HTTP_PROXY_KEY}=${HTTP_PROXY_RESET_VALUE} failed, tolerated: ${String(err)}`),
    )
    await deleteSetting(transport, HTTP_PROXY_KEY).catch((err) =>
      log('warn', `restore: delete ${HTTP_PROXY_KEY} failed, tolerated: ${String(err)}`),
    )
  }

  /**
   * Idempotent by construction, and that is the whole point (plan 114 §3.6
   * rule 3, copying `restoreLockScreenLabel`'s own stated rule): it re-issues
   * the same four values every time and consults no "already reverted" flag,
   * so a teardown path that runs twice is a no-op the second time rather than
   * a second, different write. Every failure is logged and tolerated — a
   * device that cannot be reached to restore is not a reason to throw out of a
   * teardown the operator explicitly asked for.
   */
  async function restoreAll(values: HttpProxySettings): Promise<void> {
    await restoreKey(HTTP_PROXY_HOST_KEY, values.host)
    await restoreKey(HTTP_PROXY_PORT_KEY, values.port)
    await restoreKey(HTTP_PROXY_EXCLUSION_LIST_KEY, values.exclusionList)
    await restoreComposite(values.httpProxy)
  }

  return {
    id: 'adb-proxy',

    /**
     * Every field `false`, and every one of them is a fact worth publishing
     * rather than a gap to hide (plan 33 §5, plan 114 §3.2). `auth: false` is
     * not a limitation waiting to be lifted: Android's system proxy value is
     * `host:port` with nowhere to put a credential, and it is world-readable
     * by every app on the phone, so spec §7.9 forbids putting one there —
     * `adb-reverse-proxy` (step 114.5) is where an authenticated upstream is
     * possible at all, and even there the account stays on the farm.
     */
    capabilities: { auth: false, enforcing: false, udp: false, probe: false },

    /**
     * Capture (once) → write → read back → compare. Throws
     * `E_SETTING_NOT_ACCEPTED` when the device's own answer disagrees with what
     * was written, which is what step 114.3 classifies as a FAILED apply rather
     * than an applied-but-unverified one (plan 114 §3.9's table). It is never
     * reported as applied on a mismatch, and this function never reports
     * anything it did not read back.
     *
     * Idempotent: applying the same config twice writes the same values twice
     * and leaves the capture from the first call alone.
     */
    async apply(config) {
      await captureOnce()

      const value = httpProxyValue(config)
      const exclusions = httpProxyExclusionList(config)

      // Exclusion list first, composite last — same ordering reason as `restoreComposite`: the
      // framework reacts to `http_proxy`, so it should be the last thing that changes.
      if (exclusions === '') await deleteSetting(transport, HTTP_PROXY_EXCLUSION_LIST_KEY)
      else await putSetting(transport, HTTP_PROXY_EXCLUSION_LIST_KEY, exclusions)
      await putSetting(transport, HTTP_PROXY_KEY, value)

      const after = await readHttpProxySettings(transport)
      if (after.httpProxy !== value) {
        throw new HttpProxyError(
          'E_SETTING_NOT_ACCEPTED',
          `the device did not accept the proxy setting: wrote "${value}", it reports "${after.httpProxy || '(unset)'}"`,
          value,
          after.httpProxy,
        )
      }
      if (after.exclusionList !== exclusions) {
        throw new HttpProxyError(
          'E_SETTING_NOT_ACCEPTED',
          `the device did not accept the proxy exclusion list: wrote "${exclusions || '(none)'}", it reports "${after.exclusionList || '(none)'}"`,
          exclusions,
          after.exclusionList,
        )
      }
      // The two split keys are DERIVED by the framework from `http_proxy`; on the reference device
      // (Android 15) they follow immediately, but a build that populates them lazily — or not at
      // all — would make a correct apply look declined if they were part of the verdict. So a
      // disagreement is logged, never thrown: the composite key is the one this engine wrote and
      // the one it is entitled to be judged on.
      if (after.host !== config.host || after.port !== String(config.port)) {
        log(
          'debug',
          `apply(): derived keys disagree with the composite — ${HTTP_PROXY_HOST_KEY}="${after.host}", ${HTTP_PROXY_PORT_KEY}="${after.port}" after writing "${value}"`,
        )
      }
    },

    /**
     * Reports what the DEVICE says, which is a genuinely different fact from
     * what was declared (spec §7.9 rule 2) — the caller compares the two and
     * that comparison is the `setting` check and the `drift` flag, never
     * something this method assumes away. Takes no config on purpose: it is
     * called on a freshly constructed engine after a core restart, where there
     * is nothing in memory to compare against anyway.
     *
     * The mapping onto `NetworkObservation`, field by field, because three of
     * them were designed for a VPN and mean something narrower here:
     *
     * - `prepared: true` always — the field means "the device has granted VPN
     *   consent", and this engine needs no consent of any kind. It is not a
     *   claim that anything was verified.
     * - `up` means only that the device reports a non-empty system proxy —
     *   NEVER that traffic goes through it. Nothing on a phone can tell you
     *   that about an advisory setting, which is why `capabilities.enforcing`
     *   is `false` and `egress` is permanently `skip`.
     * - `:0` reads as DOWN. It is Android's "no proxy" value and, historically,
     *   the residue plan 33 §5's revert prescription left behind — a device
     *   sitting on it is not proxied and must not be reported as if it were.
     *
     * A read failure propagates (`E_SETTING_READ_FAILED`), mirroring
     * `vpn-helper.observe()`'s own division of responsibility: an observation
     * failure is the caller's to report, not something to paper over with a
     * confident `false`.
     */
    async observe(): Promise<NetworkObservation> {
      const settings = await readHttpProxySettings(transport)
      const up = settings.httpProxy !== '' && settings.httpProxy !== HTTP_PROXY_RESET_VALUE
      return {
        prepared: true,
        up,
        state: up ? 'up' : 'down',
        ...(up ? { upstream: settings.httpProxy } : {}),
      }
    },

    // `probe` and `hold` are deliberately NOT defined — see this file's header. `NetworkRoute`
    // makes both optional so a caller discovers an engine's reach instead of assuming it, and an
    // egress probe here could only ever prove that a client which honours the setting reached the
    // proxy, which is not the question anybody is asking (plan 114 §3.5).

    /**
     * Restores the four values captured before this farm ever wrote one (plan
     * 114 §3.6), or — when nothing was ever captured — clears them to Android's
     * default. Those two are different outcomes and the caller is required to
     * word them differently on screen: "restored what was here" versus "this
     * phone had no saved original proxy value, so it was cleared rather than
     * restored".
     *
     * Never throws and is safe to call twice, per `NetworkRoute.revert()`'s own
     * contract — every device write below is tolerated and logged, because this
     * runs from teardown paths that may run after a crash or run twice.
     *
     * Does NOT clear the capture. The route row's lifetime belongs to the
     * caller, and keeping the capture is what makes a second revert re-issue
     * the same values instead of silently falling into the "nothing was
     * captured" path and clearing a proxy it should have restored.
     */
    async revert() {
      let captured: CapturedHttpProxySettings | null = null
      try {
        captured = await capture.read()
      } catch (err) {
        // A capture we cannot read is not a capture. Falling back to the clear path leaves the
        // phone with no proxy rather than with the farm's, which is the safer of two bad options —
        // but it IS a lossy outcome, so it is logged at `warn` rather than swallowed.
        log('warn', `revert(): reading the capture failed, clearing to Android's default instead: ${String(err)}`)
      }

      if (captured === null) {
        log('debug', 'revert(): nothing was captured — clearing the four keys to Android’s default')
        await restoreAll({ httpProxy: '', host: '', port: '', exclusionList: '' })
      } else {
        await restoreAll(captured)
      }

      // Read back and report — the same rule `apply()` follows, minus the ability to act on it:
      // `revert()` may not throw, so a device that still reports a proxy is logged rather than
      // raised. The caller's own `observe()` on the next status read is what surfaces it.
      const after = await readHttpProxySettings(transport).catch((err) => {
        log('debug', `revert(): read-back failed, tolerated: ${String(err)}`)
        return null
      })
      if (after === null) return
      const expected = captured?.httpProxy ?? ''
      if (after.httpProxy !== expected && !(expected === '' && after.httpProxy === HTTP_PROXY_RESET_VALUE)) {
        log(
          'warn',
          `revert(): the device did not take the restore — wrote "${expected || '(unset)'}", it reports "${after.httpProxy || '(unset)'}"`,
        )
      }
    },
  }
}
