import { z } from 'zod'
import { DeviceAddedMessage, DeviceRemovedMessage, DeviceStatusMessage } from './device'
import {
  DevicePairingCodeMessage,
  DevicePairingCodeResultMessage,
  DevicePairingRequestMessage,
  DevicePairingRequestResultMessage,
  DeviceUnauthorizedMessage,
  DeviceInspectorStatusMessage,
  DeviceInspectorFallbackMessage,
  DeviceBatteryMessage,
} from './messages/enroll'
import { InputKeyMessage, InputSwipeMessage, InputTapMessage, InputTextMessage } from './messages/input'
import {
  JobArtifactMessage,
  JobCancelMessage,
  JobEnqueueMessage,
  JobLogMessage,
  JobStatusEventMessage,
  LeaseAcquiredMessage,
  LeaseAcquireMessage,
  LeaseReleasedMessage,
  LeaseReleaseMessage,
  LeaseChangedMessage,
  LeaseRevokedMessage,
} from './messages/job'
import { StreamEndedMessage, StreamMetaMessage, StreamStartedMessage, StreamStartMessage, StreamStopMessage } from './messages/stream'
import {
  WebRtcAnswerMessage,
  WebRtcFailedMessage,
  WebRtcIceMessage,
  WebRtcOfferMessage,
  WebRtcRequestMessage,
  WebRtcStopMessage,
} from './tunnel'
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
export {
  EngineDescriptorSchema,
  RegistryResponseSchema,
  validateEngineSelection,
  type EngineDescriptor,
  type RegistryResponse,
  type EngineSelection,
  type EngineSelectionResult,
} from './registry'
export {
  BatteryStateSchema,
  TimingSettingsSchema,
  DeviceSettingsSchema,
  FarmSettingsSchema,
  defaultFarmSettings,
  defaultDeviceSettings,
  type BatteryState,
  type DeviceSettings,
  type FarmSettings,
} from './settings'
export {
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  type ToolInstallProgress,
  type ToolProvisionProgress,
  type ToolChanged,
} from './messages/tool'
export { NormPointSchema, InputTapMessage, InputSwipeMessage, InputKeyMessage, InputTextMessage, type NormPoint } from './messages/input'
export { StreamStartMessage, StreamStartedMessage, StreamStopMessage, StreamMetaMessage, StreamEndedMessage } from './messages/stream'
export {
  DeviceUnauthorizedMessage,
  DevicePairingRequestMessage,
  DevicePairingRequestResultMessage,
  DevicePairingCodeMessage,
  DevicePairingCodeResultMessage,
  DeviceInspectorStatusMessage,
  DeviceInspectorFallbackMessage,
  DeviceBatteryMessage,
} from './messages/enroll'
export {
  CHANNEL,
  VIDEO_CODEC,
  VIDEO_FLAG_KEYFRAME,
  encodeVideoFrame,
  decodeVideoFrame,
  isH264Keyframe,
  type DecodedVideoFrame,
} from './binary'
export {
  JobStatusSchema,
  SleepJobParamsSchema,
  JobInfoSchema,
  ArtifactInfoSchema,
  JobLogMessage,
  JobArtifactMessage,
  JobEnqueueMessage,
  JobCancelMessage,
  JobStatusEventMessage,
  LeaseAcquireMessage,
  LeaseReleaseMessage,
  LeaseAcquiredMessage,
  LeaseReleasedMessage,
  LeaseChangedMessage,
  LeaseRevokedMessage,
  type JobStatus,
  type JobInfo,
  type ArtifactInfo,
  type SleepJobParams,
} from './messages/job'
export {
  PointSchema,
  SelectorSchema,
  KeyCodeSchema,
  KEYCODES,
  resolveKeyCode,
  type Selector,
  type UiNode,
  type Bounds,
  type KeyCode,
  type KeyName,
} from './ui-node'

export {
  RoutedEnvelopeSchema,
  AgentToControlSchema,
  ControlToAgentSchema,
  AgentHelloMessage,
  AgentHelloAckMessage,
  AgentDevicesMessage,
  SessionStartMessage,
  SessionStopMessage,
  JobDispatchMessage,
  TunnelPingMessage,
  TunnelPongMessage,
  TunnelChannelOpenMessage,
  TunnelChannelCloseMessage,
  TUNNEL_FRAME_MARKER,
  encodeTunnelFrame,
  decodeTunnelFrame,
  InputForwardMessage,
  JobCancelForwardMessage,
  SessionStartedMessage,
  SessionFailedMessage,
  JobProgressMessage,
  WebRtcRequestMessage,
  WebRtcOfferMessage,
  WebRtcAnswerMessage,
  WebRtcIceMessage,
  WebRtcFailedMessage,
  WebRtcStopMessage,
  type RoutedEnvelope,
  type AgentToControl,
  type ControlToAgent,
} from './tunnel'

/** Generic server→client error (a failed reply, an invalid message). */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  payload: z.object({ code: z.string(), message: z.string() }),
})

/** Every server→client message. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceStatusMessage,
  DeviceUnauthorizedMessage,
  DeviceInspectorStatusMessage,
  DeviceInspectorFallbackMessage,
  DeviceBatteryMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  StreamStartedMessage,
  StreamMetaMessage,
  StreamEndedMessage,
  DevicePairingRequestResultMessage,
  DevicePairingCodeResultMessage,
  JobStatusEventMessage,
  JobLogMessage,
  JobArtifactMessage,
  LeaseAcquiredMessage,
  LeaseReleasedMessage,
  LeaseChangedMessage,
  LeaseRevokedMessage,
  WebRtcOfferMessage,
  WebRtcFailedMessage,
  WebRtcIceMessage,
  ErrorMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

/** Every client→server message (M2: input, stream, pairing). */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputTapMessage,
  InputSwipeMessage,
  InputKeyMessage,
  InputTextMessage,
  StreamStartMessage,
  StreamStopMessage,
  DevicePairingRequestMessage,
  DevicePairingCodeMessage,
  JobEnqueueMessage,
  JobCancelMessage,
  LeaseAcquireMessage,
  LeaseReleaseMessage,
  WebRtcRequestMessage,
  WebRtcAnswerMessage,
  WebRtcStopMessage,
  // ICE is bidirectional: the browser sends its candidates too.
  WebRtcIceMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>
