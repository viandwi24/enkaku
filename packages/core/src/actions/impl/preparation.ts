import type { AgentStatus, DevicePreparation, PreparationComponentStatus } from '@enkaku/protocol'
import { GUEST_AGENT_COMPONENT_ID } from '../../device/preparation/guest-agent-status'
import type { PreparationRunner } from '../../device/preparation/runner'
import { EnkakuError } from '../../util/errors'

export interface PreparationDeps {
  runner: PreparationRunner
  agentProvisioner?: {
    ensure: (deviceId: string, opts?: { force?: boolean; reinstall?: boolean }) => Promise<unknown>
    /** `AgentProvisioner.remove` — stop, uninstall, clear the row, record the transition. Already existed; this is the first caller an operator can reach. */
    remove?: (deviceId: string, actor: string | null) => Promise<AgentStatus>
  }
}

/** `prepare` (plan 207 §4.2) — one whole-device pass, exactly `device-preparation.ts`'s `POST /:id/preparation`. */
export async function prepareDevice(deps: PreparationDeps, deviceId: string, opts?: { force?: boolean }): Promise<DevicePreparation> {
  const [, preparation] = await Promise.all([
    deps.agentProvisioner?.ensure(deviceId, opts) ?? Promise.resolve(undefined),
    deps.runner.ensure(deviceId, opts),
  ])
  return deps.agentProvisioner ? deps.runner.status(deviceId) : preparation
}

/** `retry-prepare` (plan 207 §4.2) — one component, `force: true`, exactly `device-preparation.ts`'s `POST /:id/preparation/:componentId/retry`. */
export async function retryPrepareComponent(deps: PreparationDeps, deviceId: string, componentId: string): Promise<PreparationComponentStatus> {
  if (componentId === GUEST_AGENT_COMPONENT_ID && deps.agentProvisioner) {
    await deps.agentProvisioner.ensure(deviceId, { force: true })
    const preparation = await deps.runner.status(deviceId)
    const status = preparation[GUEST_AGENT_COMPONENT_ID]
    if (!status) throw new EnkakuError('preparation_component_not_found', `no such preparation component: ${componentId}`)
    return status
  }
  return deps.runner.ensureComponent(deviceId, componentId, { force: true })
}

/**
 * `install-agent` (CEO, 2026-09-04) — put the APK this core resolves onto
 * this phone, whatever is already there.
 *
 * The automatic path already reinstalls an agent it can SEE is outdated: a
 * `versionCode` or signature mismatch against the manifest pin triggers the
 * launcher's uninstall+reinstall+reverify once, with no operator involved.
 * This verb exists for the two cases that path cannot cover, both of which
 * cost the owner an afternoon:
 *
 *  - the APK came from a local Gradle build, which carries no manifest pin,
 *    so there is nothing to version-check against and the installer verifies
 *    PRESENCE only — an obsolete agent survives forever;
 *  - the install reported success and did not stick, which production does
 *    and a happy path does not.
 *
 * `reinstall` rather than `force`: `force` alone only bypasses the
 * provision-mode and backoff gates. See `AgentProvisioner.ensure`.
 */
export async function installGuestAgent(deps: PreparationDeps, deviceId: string): Promise<PreparationComponentStatus> {
  if (!deps.agentProvisioner) throw new EnkakuError('E_UNSUPPORTED', 'this core has no agent provisioner')
  await deps.agentProvisioner.ensure(deviceId, { force: true, reinstall: true })
  const status = (await deps.runner.status(deviceId))[GUEST_AGENT_COMPONENT_ID]
  if (!status) throw new EnkakuError('preparation_component_not_found', 'no guest agent component on this device')
  return status
}

/**
 * `uninstall-agent` — remove it, which is also how an operator turns the
 * agent off for one device without touching farm settings.
 *
 * Deliberately does NOT flip `guestAgent.provision`: that is a farm-wide
 * setting and this is one phone. A device whose provision mode is `auto`
 * will therefore reinstall on the next hook, which is the honest behaviour —
 * an operator who wants it gone for good turns provisioning off, and the
 * Settings page is where that lives.
 */
export async function uninstallGuestAgent(deps: PreparationDeps, deviceId: string, actor: string | null): Promise<AgentStatus> {
  if (!deps.agentProvisioner?.remove) throw new EnkakuError('E_UNSUPPORTED', 'this core cannot uninstall the guest agent')
  return deps.agentProvisioner.remove(deviceId, actor)
}
