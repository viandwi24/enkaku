import net from 'node:net'
import { messageOf } from './errors'

/**
 * "The address the device reaches the core at" — plan 122 §5 step 122.12,
 * fix (2). The local-exception check (`local-exception.ts`) has to verify a
 * candidate rule's `dst-address` actually covers the controller, and the
 * controller's own address on the path toward the router is not something
 * this plugin can template (§5's whole complaint about the old
 * `<farm-subnet>` placeholder) — it has to be observed.
 *
 * ## How: `socket.localAddress`, read at `connect`, never later
 *
 * Plan 123 §0.3 (this workspace's own prior finding, re-used verbatim here)
 * established that `net.Socket#localAddress` is populated and accurate ONLY
 * while the socket is live — read after `close` it is empty. So this opens a
 * plain TCP connection to the router's own REST port (no HTTP sent, no auth
 * needed — a bare three-way handshake is enough to learn which local address
 * the OS routing table picked for that destination) and reads
 * `socket.localAddress` inside the `'connect'` handler, the earliest point it
 * is available, exactly like `plugins/proxy-manager/src/service/listener.ts`
 * reads `upstream.localAddress` at the moment its own dial resolves.
 *
 * ## When it cannot be determined
 *
 * A connect failure (unreachable router, wrong port, a firewall) or a
 * timeout both degrade to `{ kind: 'rfc1918-fallback' }` rather than
 * throwing — `doctor()` (`router-driver.ts`) never throws, and this feeds
 * into it. The fallback's `reason` says WHICH thing failed, so the Settings
 * tab can say so rather than silently assuming a subnet (§5's own
 * complaint). `local-exception.ts` is what actually degrades the *check*
 * once it sees this: it requires a candidate rule to cover all three RFC1918
 * ranges instead of the one address it could not observe.
 */

export interface CoreAddressConfig {
  /** Host, or host:port — no scheme, exactly `MikrotikRestConfig.baseUrl`'s own shape (`rest-client.ts`). */
  baseUrl: string
  tls: boolean
}

export type CoreAddressResult =
  /** The core's own address on the path to the router, observed live. */
  | { kind: 'derived'; address: string }
  /** Could not be observed — `reason` names why, never a silent guess. */
  | { kind: 'rfc1918-fallback'; reason: string }

const DEFAULT_TIMEOUT_MS = 3_000

/** The REST scheme's conventional default port — used only when `baseUrl` carries no explicit one, matching `rest-client.ts`'s own `http`/`https` choice from `tls`. */
function defaultPortFor(tls: boolean): number {
  return tls ? 443 : 80
}

/**
 * `baseUrl` → `{ host, port }`. `baseUrl` is `host` or `host:port` with no
 * scheme (`rest-client.ts`'s own contract) — a trailing `:<digits>` is taken
 * as the port; anything else (no colon, or a non-numeric tail) falls back to
 * the scheme's own default port with the whole string as the host. Exported
 * so the parsing itself is directly testable without opening a socket.
 */
export function parseHostPort(baseUrl: string, tls: boolean): { host: string; port: number } {
  const idx = baseUrl.lastIndexOf(':')
  if (idx === -1) return { host: baseUrl, port: defaultPortFor(tls) }
  const host = baseUrl.slice(0, idx)
  const portPart = baseUrl.slice(idx + 1)
  const port = Number(portPart)
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { host: baseUrl, port: defaultPortFor(tls) }
  }
  return { host, port }
}

/** Test-only seam: swap the real `net.connect` for a fake socket, and/or shorten the timeout. `undefined` fields keep the real implementation. */
export interface CoreAddressDeps {
  connect: (opts: { host: string; port: number }) => net.Socket
  timeoutMs: number
}

const defaultDeps: CoreAddressDeps = {
  connect: (opts) => net.connect(opts),
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

/**
 * Opens a bare TCP connection to the router's own REST endpoint and reads
 * the local address the OS chose for it. Never throws and never hangs past
 * `deps.timeoutMs` — every failure resolves the fallback branch.
 */
export async function deriveCoreAddress(config: CoreAddressConfig, deps: Partial<CoreAddressDeps> = {}): Promise<CoreAddressResult> {
  const { connect, timeoutMs } = { ...defaultDeps, ...deps }
  const { host, port } = parseHostPort(config.baseUrl, config.tls)

  return new Promise<CoreAddressResult>((resolve) => {
    let settled = false
    const socket = connect({ host, port })

    const timer = setTimeout(() => {
      finish({ kind: 'rfc1918-fallback', reason: `timed out connecting to ${host}:${port} within ${timeoutMs} ms while deriving the core's own address` })
    }, timeoutMs)

    function cleanup(): void {
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
    }

    function finish(result: CoreAddressResult): void {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      resolve(result)
    }

    function onConnect(): void {
      // Read HERE, not later (this file's own header, plan 123 §0.3):
      // `socket.localAddress` is live and accurate only while connected.
      const address = socket.localAddress
      if (!address) {
        finish({ kind: 'rfc1918-fallback', reason: 'connected to the router but the runtime reported no local address for the socket' })
        return
      }
      finish({ kind: 'derived', address })
    }

    function onError(err: unknown): void {
      finish({ kind: 'rfc1918-fallback', reason: `could not open a TCP connection to ${host}:${port} to derive the core's own address: ${messageOf(err)}` })
    }

    socket.on('connect', onConnect)
    socket.on('error', onError)
  })
}
