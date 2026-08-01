import { z } from 'zod'
import { DeviceAddedMessage, DeviceRemovedMessage, DeviceStatusMessage } from './device'
import {
  ToolChangedMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
} from './messages/tool'

export { EnvelopeSchema, type Envelope } from './envelope'
export {
  DeviceStatusSchema,
  DeviceInfoSchema,
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceStatusMessage,
  type DeviceStatus,
  type DeviceInfo,
  type DeviceAdded,
  type DeviceRemoved,
  type DeviceStatusEvent,
} from './device'
export type { Transport } from './transport'
export {
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  type ToolInstallProgress,
  type ToolProvisionProgress,
  type ToolChanged,
} from './messages/tool'

/** Semua message server→client (bertambah tiap plan). */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceStatusMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
