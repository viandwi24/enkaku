import net from 'node:net'
import os from 'node:os'
import { systemCodeOf } from './errors'

/**
 * Plan 123 §3.1/§3.2/§4.1 — "does this runtime actually honour
 * `net.connect({ localAddress })`", measured, never guessed from
 * `process.platform`.
 *
 * ## The trap this file exists to avoid
 *
 * The obvious probe — bind to the record's own `bindAddress` and connect to
 * a listener on that SAME address — false-passes on exactly the hosts it
 * exists to protect. If the bind is honoured, the source is `bindAddress`.
 * If it is ignored, the kernel still picks `bindAddress` anyway, because
 * that is the route a LOCAL destination on that same address naturally
 * takes. Both branches produce the same observed source, so that probe
 * cannot tell them apart.
 *
 * ## The discriminator that does work
 *
 * Bind to an address this host does NOT hold, and connect to a loopback
 * listener started here. Two runtime behaviours, two different outcomes:
 *
 * ```
 * honoured → bind() fails → EADDRNOTAVAIL (or EINVAL) → the connect never happens → probe returns true
 * ignored  → the option is dropped        → the connect succeeds normally     → probe returns false
 * ```
 *
 * **This reads backwards: the probe PASSES when the connection FAILS.**
 * `onError` below is where that inversion lives — read its comment before
 * touching it.
 *
 * The probe address comes from RFC 5737 TEST-NET-1 (`192.0.2.0/24`),
 * reserved for documentation and therefore never legitimately assigned to a
 * real interface — the same range plan 119's DNS tests and this pack's own
 * `dial-direct.test.ts` already rely on for "guaranteed unassigned
 * everywhere". `pickBindProbeAddress` still cross-checks it against
 * `os.networkInterfaces()` at probe time, so a host that somehow holds one
 * of those addresses gets a correct answer instead of a false pass.
 *
 * No internet, no privileges: the "remote" side of the probe is a loopback
 * listener this file starts and closes itself.
 */

/** The short window a probe attempt gets before it is treated as inconclusive (§9 Q1's proposed default — see `onErrorOutcome` below). */
const DEFAULT_TIMEOUT_MS = 500

export interface BindProbeDeps {
  /** Every address this host currently holds. Swappable in tests to simulate a host that holds a TEST-NET-1 candidate, without needing one for real. */
  hostAddresses(): string[]
  /** How long a single probe attempt waits before it is treated as inconclusive. */
  timeoutMs: number
  /**
   * Test-only escape hatch: dial this host:port instead of the loopback
   * listener this file would otherwise start and manage itself. Used to
   * force the timeout branch deterministically, with an address that is
   * silently dropped rather than promptly refused or accepted —
   * `dial-direct.test.ts`'s own header explains why `203.0.113.0/24`
   * (RFC 5737 TEST-NET-3) is that kind of address. Never set in production:
   * the real probe never leaves loopback.
   */
  target?: { host: string; port: number }
}

function defaultHostAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .map((addr) => addr.address)
}

const defaultDeps: BindProbeDeps = {
  hostAddresses: defaultHostAddresses,
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

/**
 * Pick a TEST-NET-1 (`192.0.2.0/24`) address this host does not currently
 * hold, per §3.1's "cross-checked against `os.networkInterfaces()` at probe
 * time" requirement. Exported mainly so the address-selection logic itself
 * can be tested directly, without a real network round trip.
 *
 * Starts at `.1` and walks forward rather than picking randomly, so the
 * choice is deterministic and easy to reason about in a test. Returns
 * `null` only if every one of the 254 usable addresses in the block is
 * reported held — not something real hardware does; reachable only through
 * a test double that hands back the whole range.
 */
export function pickBindProbeAddress(hostAddresses: () => string[]): string | null {
  const held = new Set(hostAddresses())
  for (let octet = 1; octet <= 254; octet++) {
    const candidate = `192.0.2.${octet}`
    if (!held.has(candidate)) return candidate
  }
  return null
}

function startLoopbackListener(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port })
    })
  })
}

async function probeOnce(deps: BindProbeDeps): Promise<boolean> {
  const probeAddr = pickBindProbeAddress(deps.hostAddresses)
  if (probeAddr === null) {
    // Every TEST-NET-1 address is reportedly held — see `pickBindProbeAddress`.
    // Inconclusive; the same "safe direction" default as the error/timeout
    // branches below applies (§9 Q1, §3.3: a loud refusal downstream is
    // recoverable, a silent wrong egress is not).
    return false
  }

  let server: net.Server | null = null
  let target = deps.target
  if (!target) {
    const listener = await startLoopbackListener()
    server = listener.server
    target = { host: '127.0.0.1', port: listener.port }
  }

  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const socket = net.connect({ host: target!.host, port: target!.port, localAddress: probeAddr })

      const timer = setTimeout(() => {
        // Neither a clean connect nor a clean address error inside the
        // deadline — inconclusive. §9 Q1's proposed default: resolve
        // `false` (bind not proven effective) rather than risk the silent
        // mis-egress this whole plan exists to kill.
        finish(false)
      }, deps.timeoutMs)

      function cleanup(): void {
        clearTimeout(timer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
      }

      function finish(result: boolean): void {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        resolve(result)
      }

      function onConnect(): void {
        // The connect SUCCEEDED from an address this host does not hold —
        // the only way that happens is if `localAddress` was silently
        // dropped and the kernel picked a source by route instead. This is
        // the "ignored" branch: the probe's answer is `false`.
        finish(false)
      }

      function onError(err: unknown): void {
        const code = systemCodeOf(err)
        // A real bind() to an address this host does not own always fails
        // this way — unconditionally, not a platform quirk. Reaching this
        // branch PROVES the bind was attempted and rejected before the
        // connect could even happen, which is why the probe's answer here
        // is `true`: the option was honoured. (This is the "reads
        // backwards" case named in this file's own header — the probe
        // passes because the connection failed.)
        if (code === 'EADDRNOTAVAIL' || code === 'EINVAL') {
          finish(true)
          return
        }
        // Any other error is inconclusive — same default as the timeout
        // branch above.
        finish(false)
      }

      socket.on('connect', onConnect)
      socket.on('error', onError)
    })
  } finally {
    server?.close()
  }
}

let deps: BindProbeDeps = defaultDeps
let cached: Promise<boolean> | null = null

/**
 * Is `net.connect({ localAddress })` actually honoured by this runtime?
 * Probed lazily, at most once per process (§3.2) — the answer is a property
 * of the Bun/Node build this process is running under, not of any one
 * record, and it cannot change without a restart. A farm with many `direct`
 * records asking for a bind pays for one probe, not one per record.
 */
export function bindIsEffective(): Promise<boolean> {
  if (!cached) cached = probeOnce(deps)
  return cached
}

/**
 * Test-only seam (§3.2, §4.1: "the cache injectable/resettable for tests").
 * Clears the per-process cache so the next `bindIsEffective()` call probes
 * again, and — when given — swaps in different dependencies for that next
 * probe (host address enumeration, timeout, or a fixed dial target). Called
 * with no argument, or `undefined` fields, restores the real ones.
 */
export function resetBindProbeCacheForTests(overrides?: Partial<BindProbeDeps>): void {
  cached = null
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps
}
