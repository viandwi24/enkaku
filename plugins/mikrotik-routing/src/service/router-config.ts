import { isRouterConfigured, readRouterConfig, ROUTER_KEY, type RouterConfig } from '../shared'

/**
 * Read + validate the saved `router` KV row. Factored out of
 * `service/handlers.ts` at step 122.6 so the write path (`service/apply.ts`)
 * refuses with EXACTLY the same two messages the read routes already do —
 * "no connection saved" and "an incomplete connection" — rather than a second
 * copy of the same two sentences that could drift apart between the two
 * files.
 */
export type LoadedRouterConfig = { ok: true; config: RouterConfig } | { ok: false; message: string }

export async function loadRouterConfig(getRaw: (key: string) => Promise<unknown>): Promise<LoadedRouterConfig> {
  const raw = await getRaw(ROUTER_KEY)
  if (raw === null || raw === undefined) {
    return { ok: false, message: 'No router connection has been saved yet. Open the Settings tab and save one.' }
  }
  const config = readRouterConfig(raw)
  if (!isRouterConfigured(config)) {
    return { ok: false, message: 'The saved router connection is missing an address, a username, or a password. Open the Settings tab and save a complete connection.' }
  }
  return { ok: true, config }
}
