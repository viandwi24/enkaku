import type { InstallResult, PushResult } from '@enkaku/protocol'
import { runTransfer, type TransferBroadcast } from '../../device/transfer-dispatch'
import type { TransferService } from '../../device/transfer'

export interface TransferDeps {
  transfer: TransferService
  broadcast: TransferBroadcast
  holdFor?: (deviceId: string) => Promise<{ release(): void }>
}

export async function installOnDevice(
  deps: TransferDeps,
  deviceId: string,
  transferId: string,
  opts: { artifactId: string; reinstall?: boolean; grantPermissions?: boolean; allowDowngrade?: boolean },
): Promise<InstallResult> {
  return runTransfer({
    transfer: deps.transfer,
    broadcast: deps.broadcast,
    deviceId,
    kind: 'install',
    transferId,
    holdFor: deps.holdFor,
    op: (id, onProgress) =>
      deps.transfer.install(deviceId, opts.artifactId, {
        transferId: id,
        onProgress,
        ...(opts.reinstall !== undefined ? { reinstall: opts.reinstall } : {}),
        ...(opts.grantPermissions !== undefined ? { grantPermissions: opts.grantPermissions } : {}),
        ...(opts.allowDowngrade !== undefined ? { allowDowngrade: opts.allowDowngrade } : {}),
      }),
  })
}

export async function pushToDevice(
  deps: TransferDeps,
  deviceId: string,
  transferId: string,
  opts: { artifactId: string; remotePath: string; mediaScan: 'auto' | 'always' | 'never' },
): Promise<PushResult> {
  return runTransfer({
    transfer: deps.transfer,
    broadcast: deps.broadcast,
    deviceId,
    kind: 'push',
    transferId,
    holdFor: deps.holdFor,
    op: (id, onProgress) => deps.transfer.push(deviceId, opts.artifactId, opts.remotePath, { transferId: id, onProgress, mediaScan: opts.mediaScan }),
  })
}

export async function pullFromDevice(
  deps: TransferDeps,
  deviceId: string,
  transferId: string,
  opts: { remotePath: string },
): Promise<{ artifactId: string; bytes: number }> {
  return runTransfer({
    transfer: deps.transfer,
    broadcast: deps.broadcast,
    deviceId,
    kind: 'pull',
    transferId,
    holdFor: deps.holdFor,
    op: (id, onProgress) => deps.transfer.pull(deviceId, opts.remotePath, { transferId: id, onProgress }),
  })
}
