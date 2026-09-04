import type { DevicePreparation, PreparationComponentStatus } from '@enkaku/protocol'
import { GUEST_AGENT_COMPONENT_ID } from '../../device/preparation/guest-agent-status'
import type { PreparationRunner } from '../../device/preparation/runner'
import { EnkakuError } from '../../util/errors'

export interface PreparationDeps {
  runner: PreparationRunner
  agentProvisioner?: { ensure: (deviceId: string, opts?: { force?: boolean }) => Promise<unknown> }
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
