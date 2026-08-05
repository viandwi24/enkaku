import type { GuestAgentClient } from '../network/guest-agent/client'

/**
 * The one piece of `GuestAgentSession` (`packages/drivers/src/network/guest-agent/vpn-helper.ts`)
 * this driver actually needs. Accepting the whole session (plan 58 §4.5's sketch) would force
 * every caller to also fabricate `active`/`close` — meaningless here, since this driver never
 * holds a connection of its own between calls; the host wires the SAME per-device session a
 * network route already owns (`packages/core/src/api/guest-agent.ts`'s `withEphemeralSession`),
 * one `withClient` call at a time.
 */
export type GuestAgentClientRunner = <T>(
  fn: (client: GuestAgentClient) => Promise<T>,
  opts?: { handshakeRetries?: number },
) => Promise<T>

/**
 * Plan 58 §4.4, §4.5, §5.5 — the host-side half of GPS identity spoofing: installs or removes a
 * mock fix via the guest agent's `location.set`/`location.clear` control-channel methods
 * (`MockLocation.kt` on the device side). Deliberately thin — this driver does NOT check
 * `hello().capabilities` for `mock-location` itself; that gate belongs to the caller
 * (`packages/core/src/api/device-identity.ts`), the same split `vpn-helper.ts`'s `NetworkRoute`
 * uses for `probe`/`hold`: "whether the installed build actually understands this is discovered
 * from `hello().capabilities`, not assumed here."
 */
export interface MockLocationDriver {
  set(gps: { lat: number; lng: number; accuracy?: number }): Promise<void>
  clear(): Promise<void>
}

export function createMockLocationDriver(deps: { withClient: GuestAgentClientRunner }): MockLocationDriver {
  return {
    async set(gps) {
      await deps.withClient((client) => client.locationSet(gps.lat, gps.lng, gps.accuracy))
    },
    async clear() {
      await deps.withClient((client) => client.locationClear())
    },
  }
}
