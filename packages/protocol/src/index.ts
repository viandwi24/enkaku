import { z } from 'zod'
import { DeviceAddedMessage, DeviceRemovedMessage, DeviceStatusMessage } from './device'

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

/** Semua message server→client yang ada di M0 (bertambah tiap plan). */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceStatusMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
