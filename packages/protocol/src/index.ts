import { z } from 'zod'
import { DeviceAddedMessage, DeviceRemovedMessage, DeviceStatusMessage } from './device'
import {
  DevicePairingCodeMessage,
  DevicePairingCodeResultMessage,
  DevicePairingRequestMessage,
  DevicePairingRequestResultMessage,
  DeviceUnauthorizedMessage,
} from './messages/enroll'
import { InputKeyMessage, InputSwipeMessage, InputTapMessage, InputTextMessage } from './messages/input'
import { StreamMetaMessage, StreamStartedMessage, StreamStartMessage, StreamStopMessage } from './messages/stream'
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
export type { Transport, DisplaySource, InputSink, Inspector, Point, FrameMeta } from './driver'
export { EngineDescriptorSchema, RegistryResponseSchema, type EngineDescriptor, type RegistryResponse } from './registry'
export {
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  type ToolInstallProgress,
  type ToolProvisionProgress,
  type ToolChanged,
} from './messages/tool'
export { NormPointSchema, InputTapMessage, InputSwipeMessage, InputKeyMessage, InputTextMessage, type NormPoint } from './messages/input'
export { StreamStartMessage, StreamStartedMessage, StreamStopMessage, StreamMetaMessage } from './messages/stream'
export {
  DeviceUnauthorizedMessage,
  DevicePairingRequestMessage,
  DevicePairingRequestResultMessage,
  DevicePairingCodeMessage,
  DevicePairingCodeResultMessage,
} from './messages/enroll'
export { CHANNEL, VIDEO_CODEC, encodeVideoFrame, decodeVideoFrame, type DecodedVideoFrame } from './binary'

/** Error generik server→client (reply gagal, message invalid). */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  payload: z.object({ code: z.string(), message: z.string() }),
})

/** Semua message server→client. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceStatusMessage,
  DeviceUnauthorizedMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  StreamStartedMessage,
  StreamMetaMessage,
  DevicePairingRequestResultMessage,
  DevicePairingCodeResultMessage,
  ErrorMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

/** Semua message client→server (M2: input, stream, pairing). */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputTapMessage,
  InputSwipeMessage,
  InputKeyMessage,
  InputTextMessage,
  StreamStartMessage,
  StreamStopMessage,
  DevicePairingRequestMessage,
  DevicePairingCodeMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>
