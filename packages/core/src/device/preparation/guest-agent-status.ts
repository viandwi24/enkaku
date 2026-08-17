import {
  AgentStatusSchema,
  DEFAULT_GUEST_AGENT_IDENTITY,
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  DevicePreparationSchema,
  GuestAgentIdentitySchema,
  type GuestAgentIdentity,
  type PreparationComponentStatus,
} from '@enkaku/protocol'
import type { DeviceRow } from '../../db/schema'
import type { Logger } from '../../util/logger'

/**
 * Plan 106 §5 step 106.5: the guest agent migrates onto the preparation
 * registry as its authoritative state store. `devices.preparation['guest-agent']`
 * (this key) becomes THE fact of record for `state`/`reason`/`checkedAt`/
 * `attempts`/`nextAttemptAt` — `devices.agent` stops carrying any of them
 * (see `GuestAgentIdentitySchema`'s own doc comment in `@enkaku/protocol`).
 * Both `agent-provisioner.ts` (the specialised engine that actually RUNS a
 * pass) and `registry/device-registry.ts` (the read-only `DeviceInfo.agent`
 * chip) go through the two functions below rather than reading either
 * column directly, so there is exactly one place that knows how to combine
 * — or fall back for — them.
 */
export const GUEST_AGENT_COMPONENT_ID = 'guest-agent'

/**
 * The authoritative preparation record for the guest agent, with ONE
 * deliberate exception: a pre-106.5 row that was written before this
 * migration ever ran has no `preparation['guest-agent']` entry at all yet
 * (106.1's own decision — no `guest-agent` key was ever written there before
 * this step), but DOES carry a real, meaningful `devices.agent` value from
 * the old `AgentStatusSchema`-shaped column. Silently reading that row as
 * `absent` would turn a known-`failed` phone into an apparently-healthy one
 * (exactly the regression this plan's own brief warns against) — so this
 * function falls back to parsing the LEGACY full shape from `devices.agent`
 * ONLY when `devices.preparation['guest-agent']` is genuinely absent. The
 * fallback is self-eliminating: the moment any real pass runs for this
 * device (admission, reconnect, on-demand, or the boot sweep — all of which
 * already call `agentProvisioner.ensure()` unconditionally), `writeCached`
 * below writes a real `preparation['guest-agent']` entry and every
 * subsequent read takes the primary branch, never touching `devices.agent`
 * for this purpose again.
 */
export function deriveGuestAgentPreparation(row: Pick<DeviceRow, 'preparation' | 'agent'>, log?: Logger): PreparationComponentStatus {
  if (row.preparation !== null && row.preparation !== undefined) {
    const parsed = DevicePreparationSchema.safeParse(row.preparation)
    if (parsed.success) {
      const entry = parsed.data[GUEST_AGENT_COMPONENT_ID]
      if (entry) return entry
    } else {
      log?.warn(`device preparation record failed validation, falling through to the legacy devices.agent column: ${parsed.error.message}`)
    }
  }
  // No preparation entry yet — a pre-106.5 row, or one that has never been
  // provisioned at all. Try the legacy column before giving up to `absent`.
  if (row.agent === null || row.agent === undefined) return DEFAULT_PREPARATION_COMPONENT_STATUS
  const legacy = AgentStatusSchema.safeParse(row.agent)
  if (!legacy.success) return DEFAULT_PREPARATION_COMPONENT_STATUS
  return {
    state: legacy.data.state,
    version: legacy.data.appVersion,
    reason: legacy.data.reason,
    checkedAt: legacy.data.checkedAt,
    attempts: legacy.data.attempts,
    nextAttemptAt: legacy.data.nextAttemptAt,
  }
}

/**
 * The identity facts (`appVersion`/`versionCode`/`androidSdkInt`/
 * `capabilities`) `devices.agent` carries going forward — narrower than the
 * legacy full shape, but a legacy row parses just as well here: Zod strips
 * the extra `state`/`reason`/etc. keys rather than rejecting them, so a
 * pre-106.5 row's identity facts survive with no separate fallback needed
 * (unlike `deriveGuestAgentPreparation` above, which genuinely needs one).
 */
export function deriveGuestAgentIdentity(row: Pick<DeviceRow, 'agent'>, log?: Logger): GuestAgentIdentity {
  if (row.agent === null || row.agent === undefined) return DEFAULT_GUEST_AGENT_IDENTITY
  const parsed = GuestAgentIdentitySchema.safeParse(row.agent)
  if (!parsed.success) {
    log?.warn(`device agent identity failed validation, treating as never-provisioned: ${parsed.error.message}`)
    return DEFAULT_GUEST_AGENT_IDENTITY
  }
  return parsed.data
}
