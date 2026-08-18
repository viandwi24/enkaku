/**
 * The `plugin:<name>` principal, and its inverse — in a file that imports
 * nothing.
 *
 * These three declarations were `farm-broker.ts`'s (plan 109 §4.3, step
 * 109.3) and are still re-exported from there, so nothing that already
 * imported them had to change. They moved because plan 114 step 114.9 gave
 * them a second reader that must not drag the broker in behind them:
 * `packages/core/src/network/route-service.ts` stamps `setBy.kind` by asking
 * whether the actor string it was handed is a plugin principal, and importing
 * `farm-broker.ts` for that answer would pull the capability registry, the
 * capability context and the plugin runtime into the network layer for one
 * `startsWith`.
 *
 * The alternative — spelling `'plugin:'` a second time in the route service —
 * is the drift this file exists to prevent. The prefix is a wire-visible fact
 * (it appears in `audit_log.user_id` and in a device event's `actor`), and two
 * copies of it agree only until one of them is edited.
 */

/**
 * The principal a plugin's capability calls are made and audited under (plan
 * 109 §4.3). Deliberately prefixed rather than bare: `audit_log.user_id` also
 * carries human user ids and agent ids, and `plugin:` is what makes "every row
 * this plugin is responsible for" a single, unambiguous query.
 *
 * It is also what lets a downstream reader tell a person from a plugin without
 * being told separately — see `pluginNameFromPrincipal`.
 */
export const PLUGIN_PRINCIPAL_PREFIX = 'plugin:'

export function pluginPrincipalId(pluginName: string): string {
  return `${PLUGIN_PRINCIPAL_PREFIX}${pluginName}`
}

/** The inverse, for a reader of the audit log — or of a device event's actor. `null` for any other principal. */
export function pluginNameFromPrincipal(principal: string): string | null {
  return principal.startsWith(PLUGIN_PRINCIPAL_PREFIX) ? principal.slice(PLUGIN_PRINCIPAL_PREFIX.length) : null
}
