#!/usr/bin/env bun
/**
 * Device smoke test for the guest agent — plan 50 (M24a) §4.2.
 *
 * Drives one real phone through the guest agent's whole lifecycle over adb and asserts on what
 * the DEVICE reports, not on what the host believes. Every stage below maps to a defect the
 * proxy bring-up session found only on hardware (plan 50 §0); the comment on each stage names
 * the one it exists for. Reverting any one of those six fixes must make exactly one stage fail.
 *
 *   ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>
 *
 * Optional:
 *   ENKAKU_SMOKE_PROXY=socks5://user:pass@host:port   # enables stages 7-10; skipped without it
 *   ENKAKU_GUEST_AGENT_PATH=/path/to/app-debug.apk    # overrides the built-APK autodetect
 *   ADB=/path/to/adb | ANDROID_HOME=...               # adb location (see --help)
 *
 * Two devices are typically attached during development: ZP2222RMBS and ZP2222T7K5. ZP2222RMBS
 * may be carrying a live route — --serial is mandatory precisely so this script never guesses
 * which phone to drive, and every adb call below is scoped to the one serial given.
 *
 * This is a script, not a `bun test` file: the stages are ordered (a later one assumes an
 * earlier one succeeded), they need a real device, and a failure part-way must still leave the
 * device clean — `bun test` gives none of that for free.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// Relative imports across a package boundary are normally forbidden (CLAUDE.md) — every other
// caller reaches these through the `@enkaku/*` package name. This script is deliberately the one
// exception: it is root-level tooling, not a workspace package, so it has no `package.json`
// dependency on `@enkaku/protocol` and adding one would touch `bun.lock`, outside this change's
// scope. Importing the schema file directly (rather than redeclaring its shape here) is what
// makes stage 9 a real check against the wire contract instead of a copy that could quietly drift
// from it — which is exactly how the `lastError` defect went unnoticed in the first place.
import { GUEST_AGENT_SOCKET, GUEST_AGENT_PROTOCOL, GuestAgentResponseSchema, RouteStatusResultSchema } from '../packages/protocol/src/guest-agent'
import { Socks5RouteConfigSchema, type Socks5RouteConfig } from '../packages/protocol/src/network'

const PKG = 'dev.enkaku.guestagent'
const BOOTSTRAP_ACTIVITY = `${PKG}/.BootstrapActivity`
const ROOT = join(import.meta.dir, '..')
const ADB = process.env.ADB || (process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb'))

class SkipStage extends Error {}

function usage(): string {
  return `usage: ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL> [--port <N>]

  --serial <S>   required — the device to drive. Never guessed: with more than one phone
                 attached, an implicit default risks disturbing a device with a live route.
  --port <N>     local host port for the control-socket forward (default 27401)
  --help         print this and exit, without touching adb or any device

Env:
  ENKAKU_TEST_DEVICE=1     required gate — this script drives real hardware
  ENKAKU_SMOKE_PROXY       socks5://[user:pass@]host:port — enables stages 7-10 (egress);
                           without it those stages print a skip line rather than failing
  ENKAKU_GUEST_AGENT_PATH  overrides the auto-detected debug/release APK
  ADB, ANDROID_HOME        adb location; falls back to ~/Library/Android/sdk/platform-tools/adb
`
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

function resolveApkPath(): string {
  const override = process.env.ENKAKU_GUEST_AGENT_PATH
  if (override) return override
  const debug = join(ROOT, 'apps/guest-agent/app/build/outputs/apk/debug/app-debug.apk')
  const release = join(ROOT, 'apps/guest-agent/app/build/outputs/apk/release/app-release.apk')
  if (existsSync(debug)) return debug
  if (existsSync(release)) return release
  throw new Error(
    'no guest agent APK found — set ENKAKU_GUEST_AGENT_PATH, or build one first: ' +
      'bun run --cwd apps/guest-agent build:debug',
  )
}

/**
 * Parses ENKAKU_SMOKE_PROXY through the exact schema the wire protocol uses for `route.start`'s
 * `config`, so a shape mismatch here is caught the same way a device-side one is — never a
 * hand-rolled shape that could drift from the real contract.
 */
function parseProxyConfig(raw: string): Socks5RouteConfig {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    // Never echo `raw` back — it may carry the password.
    throw new Error('ENKAKU_SMOKE_PROXY is not a valid URL')
  }
  if (u.protocol !== 'socks5:') throw new Error('ENKAKU_SMOKE_PROXY must be a socks5:// URL')
  return Socks5RouteConfigSchema.parse({
    host: u.hostname,
    port: Number(u.port),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    udpMode: 'udp' as const,
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }

  const serial = flag(args, 'serial')
  if (!serial) {
    console.error(usage())
    console.error('✗ --serial is required')
    process.exit(1)
  }
  if (process.env.ENKAKU_TEST_DEVICE !== '1') {
    console.error('✗ set ENKAKU_TEST_DEVICE=1 to run this against real hardware (repo convention, 00-overview.md §4.4)')
    process.exit(1)
  }
  const port = Number(flag(args, 'port') ?? 27401)

  // ---- adb helpers -------------------------------------------------------

  /**
   * Raised when the device itself has gone — unplugged, powered off, or debugging revoked. It is
   * fatal and must abort the run: every later poll would otherwise burn its full deadline against
   * a device that is not there, so a disconnect turns a fast failure into a ten-minute crawl
   * through twelve stages that cannot possibly pass. Seen exactly that way.
   */
  class DeviceGoneError extends Error {}

  function looksGone(text: string): boolean {
    return /device .*not found|device offline|no devices\/emulators found|device unauthorized/i.test(text)
  }

  async function adb(...a: string[]): Promise<string> {
    const proc = Bun.spawn([ADB, '-s', serial as string, ...a], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    const combined = (out + err).trim()
    if (looksGone(combined)) throw new DeviceGoneError(`device ${serial} is no longer reachable: ${combined}`)
    if (code !== 0) {
      throw new Error(`adb ${a.join(' ')} failed (${code}): ${(err || out).trim()}`)
    }
    return combined
  }

  /** Fail before touching anything if the serial is not actually attached. */
  async function requireDeviceAttached(): Promise<void> {
    const proc = Bun.spawn([ADB, 'devices'], { stdout: 'pipe', stderr: 'pipe' })
    const listed = await new Response(proc.stdout).text()
    await proc.exited
    const attached = listed
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .some(([s, state]) => s === serial && state === 'device')
    if (!attached) {
      throw new DeviceGoneError(
        `device ${serial} is not attached (adb devices does not list it as "device") — plug it in, or pass a --serial that is`,
      )
    }
  }

  async function packagePath(): Promise<string | undefined> {
    const out = await adb('shell', 'cmd', 'package', 'path', PKG).catch(() => '')
    return out.startsWith('package:') ? out : undefined
  }

  async function agentPid(): Promise<string | undefined> {
    const out = await adb('shell', 'pidof', PKG).catch(() => '')
    return out.trim().split(/\s+/)[0] || undefined
  }

  /** The diagnostic that eventually found the missing-INTERNET defect after hours of guessing. */
  async function logcatTail(): Promise<string> {
    const pid = await agentPid()
    if (pid) return await adb('logcat', `--pid=${pid}`, '-t', '80').catch(() => '(logcat unavailable)')
    return await adb('logcat', '-t', '80').catch(() => '(logcat unavailable — agent process not found)')
  }

  async function hasTunInterface(): Promise<boolean> {
    const out = await adb('shell', 'ip', 'link', 'show', 'tun0').catch(() => '')
    return /state (UP|UNKNOWN)/.test(out)
  }

  async function hasWorkingInternet(): Promise<boolean> {
    const out = await adb('shell', 'ping', '-c', '2', '-W', '3', '1.1.1.1').catch(() => '')
    return out.includes('bytes from')
  }

  function vpnValidated(dump: string): boolean {
    const idx = dump.indexOf(`VPN:${PKG}`)
    if (idx === -1) return false
    // The capability list sits in the same NetworkAgentInfo block, which can wrap onto a
    // neighbouring line — scan a window around the match rather than assume one line has it all.
    const window = dump.slice(Math.max(0, idx - 300), idx + 600)
    return window.includes('VALIDATED') && !window.includes('PARTIAL_CONNECTIVITY')
  }

  async function pollUntil<T>(check: () => Promise<T | undefined>, opts: { timeoutMs: number; intervalMs: number; label: string }): Promise<T> {
    const deadline = Date.now() + opts.timeoutMs
    let lastErr: unknown
    while (Date.now() < deadline) {
      try {
        const v = await check()
        if (v !== undefined) return v
      } catch (e) {
        lastErr = e
      }
      await Bun.sleep(opts.intervalMs)
    }
    const suffix = lastErr instanceof Error ? ` (last error: ${lastErr.message})` : ''
    throw new Error(`timed out waiting for ${opts.label}${suffix}`)
  }

  /** Stage 11's dwell: checks a condition holds for the whole window, not just once at the end. */
  async function staysTrueFor(check: () => Promise<boolean>, opts: { durationMs: number; intervalMs: number; label: string }): Promise<void> {
    const deadline = Date.now() + opts.durationMs
    while (Date.now() < deadline) {
      if (!(await check())) throw new Error(`${opts.label} stopped holding during the dwell window`)
      await Bun.sleep(opts.intervalMs)
    }
  }

  // ---- control-socket protocol --------------------------------------------

  let reqCounter = 0
  function call(method: string, token: string, extra: Record<string, unknown> = {}) {
    return new Promise<import('../packages/protocol/src/guest-agent').GuestAgentResponse>((resolve, reject) => {
      const id = `s${++reqCounter}`
      const chunks: string[] = []
      const timer = setTimeout(() => reject(new Error(`${method} timed out after 10s — is the agent still running?`)), 10_000)
      Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          data(sock, data) {
            chunks.push(data.toString())
            const joined = chunks.join('')
            if (!joined.includes('\n')) return
            clearTimeout(timer)
            sock.end()
            let raw: unknown
            try {
              raw = JSON.parse(joined.split('\n')[0] as string)
            } catch (e) {
              reject(e)
              return
            }
            const parsed = GuestAgentResponseSchema.safeParse(raw)
            if (!parsed.success) {
              // This is the exact failure mode of the lastError defect (plan §0.5): a frame the
              // device actually sent that our own schema refuses to accept.
              reject(new Error(`response did not match the @enkaku/protocol guest-agent schema: ${parsed.error.message}`))
              return
            }
            resolve(parsed.data)
          },
          error(_sock, err) {
            clearTimeout(timer)
            reject(err)
          },
        },
      })
        .then((sock) => sock.write(`${JSON.stringify({ id, method, token, ...extra })}\n`))
        .catch((e) => {
          clearTimeout(timer)
          reject(e)
        })
    })
  }

  function mintToken(): string {
    return `smoke-${crypto.randomUUID()}`
  }

  // ---- teardown -----------------------------------------------------------

  let liveToken = ''

  /**
   * Runs from `finally` no matter which stage failed, plus once more as stage 12's own assertion
   * when everything else passed. Every step is best-effort — the agent may already be
   * uninstalled, crashed, or never got far enough to be reachable — so nothing here may throw.
   */
  async function teardown(): Promise<void> {
    if (liveToken) await call('route.stop', liveToken).catch(() => undefined)
    await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined)
    // The tunnel interface comes down asynchronously after route.stop / uninstall — poll for it
    // rather than assuming any fixed delay was long enough.
    await pollUntil(async () => ((await hasTunInterface()) ? undefined : true), { timeoutMs: 10_000, intervalMs: 1_000, label: 'tun0 to go away' }).catch(() => undefined)
  }

  // ---- stages ---------------------------------------------------------------

  const proxyRaw = process.env.ENKAKU_SMOKE_PROXY
  let proxyCfg: Socks5RouteConfig | undefined
  let token1 = ''
  let token2 = ''

  async function stage1Install(): Promise<string> {
    const apk = resolveApkPath()
    await adb('install', '-r', '-g', apk)
    const path = await packagePath()
    if (!path) throw new Error('cmd package path returned nothing after install')
    return path
  }

  /** Catches: missing INTERNET permission (plan §0.1) — the agent could not open a socket at all. */
  async function stage2Permissions(): Promise<string> {
    const dump = await adb('shell', 'dumpsys', 'package', PKG)
    if (!/android\.permission\.INTERNET\b/.test(dump)) {
      throw new Error('INTERNET is not declared — dumpsys package has no android.permission.INTERNET line at all')
    }
    if (!/android\.permission\.INTERNET:\s*granted=true/.test(dump)) {
      throw new Error('INTERNET is declared but not granted per dumpsys package')
    }
    return 'INTERNET declared and granted'
  }

  async function stage3PreGrant(): Promise<string> {
    await adb('shell', 'appops', 'set', PKG, 'ACTIVATE_VPN', 'allow')
    const readback = await adb('shell', 'appops', 'get', PKG, 'ACTIVATE_VPN')
    if (!readback.includes('allow')) throw new Error(`ACTIVATE_VPN was not granted (readback: ${JSON.stringify(readback)})`)
    return readback
  }

  async function stage4Bootstrap(): Promise<string> {
    token1 = mintToken()
    await adb('shell', 'am', 'start', '-n', BOOTSTRAP_ACTIVITY, '--es', 'token', token1)
    liveToken = token1

    const before = await adb('forward', '--list').catch(() => '')
    const stolen = before
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, local]) => local === `tcp:${port}`)
    if (stolen && stolen[0] !== serial) {
      throw new Error(`tcp:${port} is already forwarded to ${stolen[0]}, not ${serial} — refusing to steal it; pick a different --port`)
    }
    await adb('forward', `tcp:${port}`, `localabstract:${GUEST_AGENT_SOCKET}`)
    const list = await adb('forward', '--list')
    const owner = list
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, local]) => local === `tcp:${port}`)
    if (!owner || owner[0] !== serial) throw new Error(`tcp:${port} is not forwarded to ${serial} after forwarding it`)

    // A cold start after install (or a force-stop) binds the control socket a moment after the
    // process starts — poll the handshake instead of guessing at a fixed delay.
    const res = await pollUntil(
      async () => {
        const r = await call('hello', token1)
        return r.ok ? r : undefined
      },
      { timeoutMs: 15_000, intervalMs: 500, label: 'the control socket to answer hello' },
    )
    if (!res.ok) throw new Error('unreachable') // narrows for TS; pollUntil only resolves on r.ok
    // Safe: we called 'hello', so this branch of the result union is HelloResult.
    const result = res.result as { protocol: number; appVersion: string; androidSdkInt: number }
    if (result.protocol !== GUEST_AGENT_PROTOCOL) {
      throw new Error(`agent speaks protocol ${result.protocol}, host expects ${GUEST_AGENT_PROTOCOL}`)
    }
    return `protocol ${result.protocol}, sdk ${result.androidSdkInt}, app ${result.appVersion}`
  }

  /**
   * Catches: launchMode dropping every token after the first (plan §0.3). The host re-bootstraps
   * with a fresh token on every operation; under the default `standard` launch mode, `am start`
   * at an already-top activity runs neither `onCreate` nor `onNewIntent`, so the first token
   * sticks forever and the second is silently ignored. `singleTop` + `onNewIntent` fixes it.
   */
  async function stage5TokenRotation(): Promise<string> {
    token2 = mintToken()
    await adb('shell', 'am', 'start', '-n', BOOTSTRAP_ACTIVITY, '--es', 'token', token2)

    const withNewToken = await pollUntil(
      async () => {
        const r = await call('ping', token2)
        return r.ok ? r : undefined
      },
      { timeoutMs: 10_000, intervalMs: 500, label: 'the new token to be accepted' },
    )
    if (!withNewToken.ok) throw new Error('unreachable')
    liveToken = token2

    const withOldToken = await call('ping', token1)
    if (withOldToken.ok) throw new Error('the FIRST token still works after rotation — onNewIntent is not swapping it out')
    if (withOldToken.error.code !== 'E_UNAUTHORISED') {
      throw new Error(`old token was rejected with ${withOldToken.error.code}, expected E_UNAUTHORISED`)
    }
    return 'second token accepted, first token refused with E_UNAUTHORISED'
  }

  /**
   * Catches: the ANR from blocking the main thread (plan §0.2) — `onStartCommand` used to run a
   * native stop call plus a 3s thread join inline. A rapid start/stop/start cycle is what
   * originally froze the process; this stage reproduces that shape without needing a real proxy.
   */
  async function stage6Responsiveness(): Promise<string> {
    await adb('logcat', '-c')
    // TEST-NET-1 (RFC 5737): guaranteed non-routable, so this never depends on ENKAKU_SMOKE_PROXY.
    const dummyCfg = Socks5RouteConfigSchema.parse({ host: '192.0.2.1', port: 1080, udpMode: 'udp' as const })
    const start1 = await call('route.start', liveToken, { config: dummyCfg })
    if (!start1.ok) throw new Error(`route.start failed: ${start1.error.code} ${start1.error.message}`)
    const stop1 = await call('route.stop', liveToken)
    if (!stop1.ok) throw new Error(`route.stop failed: ${stop1.error.code} ${stop1.error.message}`)
    const start2 = await call('route.start', liveToken, { config: dummyCfg })
    if (!start2.ok) throw new Error(`second route.start failed: ${start2.error.code} ${start2.error.message}`)

    const t0 = Date.now()
    const pong = await call('ping', liveToken)
    const elapsed = Date.now() - t0
    if (!pong.ok) throw new Error(`ping failed right after the cycle: ${pong.error.code} ${pong.error.message}`)

    await call('route.stop', liveToken).catch(() => undefined)

    const log = await adb('logcat', '-d')
    if (log.includes(`ANR in ${PKG}`)) throw new Error(`ANR in ${PKG} found in logcat after the on/off/on cycle`)
    return `responded to ping in ${elapsed}ms after the cycle, no ANR in logcat`
  }

  /** Catches: nothing new by itself — establishes the up route stage 8-10 build on. */
  async function stage7RouteUp(): Promise<string> {
    if (!proxyRaw) throw new SkipStage('ENKAKU_SMOKE_PROXY is not set')
    proxyCfg = parseProxyConfig(proxyRaw)
    const started = await call('route.start', liveToken, { config: proxyCfg })
    if (!started.ok) throw new Error(`route.start failed: ${started.error.code} ${started.error.message}`)
    const status = await pollUntil(
      async () => {
        const r = await call('route.status', liveToken)
        if (!r.ok) throw new Error(`route.status failed: ${r.error.code} ${r.error.message}`)
        const result = RouteStatusResultSchema.parse(r.result)
        return result.up ? result : undefined
      },
      { timeoutMs: 20_000, intervalMs: 1_000, label: 'route.status to report up: true' },
    )
    return `up via ${status.upstream ?? `${proxyCfg.host}:${proxyCfg.port}`}`
  }

  async function stage8Egress(): Promise<string> {
    if (!proxyRaw) throw new SkipStage('ENKAKU_SMOKE_PROXY is not set')
    const dump = await pollUntil(
      async () => {
        const d = await adb('shell', 'dumpsys', 'connectivity')
        return vpnValidated(d) ? d : undefined
      },
      { timeoutMs: 30_000, intervalMs: 2_000, label: `dumpsys connectivity to show VPN:${PKG} VALIDATED` },
    )
    return dump.includes(`VPN:${PKG}`) ? 'VPN network reports VALIDATED' : 'VALIDATED'
  }

  /**
   * Catches: the lastError wire-shape mismatch (plan §0.5) — the device sends a plain string, an
   * earlier schema expected `{code, message}` and rejected every status frame carrying an error.
   * Forces a real error by pointing at a port nothing is listening on, then re-parses the result
   * through the actual `@enkaku/protocol` schema (not a copy of it).
   */
  async function stage9ErrorFrame(): Promise<string> {
    if (!proxyRaw || !proxyCfg) throw new SkipStage('ENKAKU_SMOKE_PROXY is not set')
    const badPort = proxyCfg.port === 65535 ? 65534 : 65535
    const badCfg = { ...proxyCfg, port: badPort }
    const started = await call('route.start', liveToken, { config: badCfg })
    if (!started.ok) throw new Error(`route.start (bad upstream) failed: ${started.error.code} ${started.error.message}`)

    const withError = await pollUntil(
      async () => {
        const r = await call('route.status', liveToken)
        if (!r.ok) throw new Error(`route.status failed: ${r.error.code} ${r.error.message}`)
        const result = RouteStatusResultSchema.parse(r.result)
        return result.lastError ? result : undefined
      },
      { timeoutMs: 45_000, intervalMs: 2_000, label: 'route.status to report a lastError for the bad upstream' },
    )
    if (typeof withError.lastError !== 'string') throw new Error(`lastError parsed but is not a plain string: ${JSON.stringify(withError.lastError)}`)

    // Restore the working route for stage 10.
    const restarted = await call('route.start', liveToken, { config: proxyCfg })
    if (!restarted.ok) throw new Error(`could not restore the good route: ${restarted.error.code} ${restarted.error.message}`)
    await pollUntil(
      async () => {
        const r = await call('route.status', liveToken)
        if (!r.ok) return undefined
        const result = RouteStatusResultSchema.parse(r.result)
        return result.up ? true : undefined
      },
      { timeoutMs: 20_000, intervalMs: 1_000, label: 'route.status to report up: true again after restoring the good config' },
    )
    return `lastError parsed as a plain string: ${JSON.stringify(withError.lastError.slice(0, 80))}`
  }

  /**
   * Catches: interleaving (plan §0.6) — a status poll re-bootstrapping and rotating the token out
   * from under a live route. Simulates a poller hammering route.status (concurrently and in a
   * burst) against the currently-live token while the route is up, and asserts none of it ever
   * comes back E_UNAUTHORISED.
   */
  async function stage10Interleaving(): Promise<string> {
    if (!proxyRaw) throw new SkipStage('ENKAKU_SMOKE_PROXY is not set')
    const burst = await Promise.all(Array.from({ length: 5 }, () => call('route.status', liveToken)))
    for (const r of burst) {
      if (!r.ok && r.error.code === 'E_UNAUTHORISED') throw new Error('a status poll against the live token came back E_UNAUTHORISED')
    }
    const after = await call('ping', liveToken)
    if (!after.ok) throw new Error(`ping with the same token failed after the status burst: ${after.error.code} ${after.error.message}`)
    const status = await call('route.status', liveToken)
    if (!status.ok) throw new Error(`route.status failed after the burst: ${status.error.code} ${status.error.message}`)
    const result = RouteStatusResultSchema.parse(status.result)
    if (!result.up) throw new Error('the route stopped being up after a burst of status polls')
    return '5 concurrent status polls, none rejected the live token; route still up'
  }

  /**
   * Catches: the self-undoing uninstall (plan §0.4) — the reconcile loop saw `enabled: true` in
   * the DB and reinstalled the app seconds later. An immediate check after uninstall would have
   * passed; the dwell is the point.
   */
  async function stage11Uninstall(): Promise<string> {
    await call('route.stop', liveToken).catch(() => undefined)
    await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined)
    await adb('uninstall', PKG)
    if (await packagePath()) throw new Error('package still resolves a path immediately after uninstall')

    await staysTrueFor(async () => (await packagePath()) === undefined, { durationMs: 30_000, intervalMs: 3_000, label: `${PKG} staying uninstalled` })
    return 'package gone immediately, and stayed gone for 30s (nothing reinstalled it)'
  }

  async function stage12Teardown(): Promise<string> {
    await teardown()
    if (await hasTunInterface()) throw new Error('tun0 is still up')
    const dump = await adb('shell', 'dumpsys', 'connectivity').catch(() => '')
    if (dump.includes(`VPN:${PKG}`)) throw new Error(`dumpsys connectivity still shows a VPN network for ${PKG}`)
    const internetOk = await pollUntil(async () => ((await hasWorkingInternet()) ? true : undefined), { timeoutMs: 15_000, intervalMs: 2_000, label: 'the device to have working internet again' }).catch(() => false)
    if (!internetOk) throw new Error('device does not have working internet after teardown')
    return 'no tun0, no VPN network, device has working internet'
  }

  // ---- harness --------------------------------------------------------------

  type StageOutcome = 'pass' | 'fail' | 'skip'
  const results: { n: number; name: string; outcome: StageOutcome }[] = []

  async function runStage(n: number, name: string, fn: () => Promise<string>): Promise<StageOutcome> {
    const label = `${String(n).padStart(2, ' ')}  ${name}`
    try {
      const detail = await fn()
      console.log(`✓ ${label} — ${detail}`)
      results.push({ n, name, outcome: 'pass' })
      return 'pass'
    } catch (e) {
      if (e instanceof SkipStage) {
        console.log(`⚠ ${label} — skipped: ${e.message}`)
        results.push({ n, name, outcome: 'skip' })
        return 'skip'
      }
      const message = e instanceof Error ? e.message : String(e)
      console.log(`✗ ${label} — ${message}`)
      const tail = await logcatTail()
      console.log(`  --- adb logcat --pid=<agent> tail (${PKG}) ---`)
      console.log(
        tail
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      )
      results.push({ n, name, outcome: 'fail' })
      return 'fail'
    }
  }

  const stages: [number, string, () => Promise<string>][] = [
    [1, 'install', stage1Install],
    [2, 'permissions', stage2Permissions],
    [3, 'pre-grant', stage3PreGrant],
    [4, 'bootstrap', stage4Bootstrap],
    [5, 'token rotation', stage5TokenRotation],
    [6, 'responsiveness', stage6Responsiveness],
    [7, 'route up', stage7RouteUp],
    [8, 'egress', stage8Egress],
    [9, 'error frame', stage9ErrorFrame],
    [10, 'interleaving', stage10Interleaving],
    [11, 'uninstall', stage11Uninstall],
    [12, 'teardown', stage12Teardown],
  ]

  let failed = false
  let deviceGone = false
  try {
    // Before anything else: if the serial is not attached, say so now. Discovering it stage by
    // stage means twelve deadlines expiring in a row against a device that was never there.
    await requireDeviceAttached()
    for (const [n, name, fn] of stages) {
      const outcome = await runStage(n, name, fn)
      if (outcome === 'fail') {
        failed = true
        break
      }
    }
  } catch (err) {
    failed = true
    deviceGone = err instanceof DeviceGoneError
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // Teardown needs the device; attempting it against a vanished one only stacks up more
    // failures and hides the real message.
    if (!deviceGone) await teardown()
    else console.error('  (skipping teardown — the device is gone; re-run once it is back to clean it up)')
  }

  const failedStage = results.find((r) => r.outcome === 'fail')
  console.log('')
  console.log(
    !failed
      ? `✓ all stages passed (${results.filter((r) => r.outcome === 'skip').length} skipped)`
      : failedStage
        ? `✗ FAILED at stage ${failedStage.n} (${failedStage.name})`
        // No stage failed, so the run never got that far — a preflight or device-gone failure,
        // already printed above with its own message.
        : '✗ FAILED before any stage ran',
  )
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('✗ unexpected error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
