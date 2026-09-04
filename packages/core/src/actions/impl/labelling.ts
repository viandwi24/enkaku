import type { DeviceLabelState } from '@enkaku/protocol'
import type { LabellingService } from '../../device/labelling'

export async function setLabel(labelling: LabellingService, deviceId: string, actor: { userId: string | null }): Promise<DeviceLabelState> {
  return labelling.apply(deviceId, actor)
}

export async function clearLabel(
  labelling: LabellingService,
  deviceId: string,
  opts: { restoreOriginal: boolean; actor: { userId: string | null } },
): Promise<DeviceLabelState> {
  return labelling.clear(deviceId, opts)
}
