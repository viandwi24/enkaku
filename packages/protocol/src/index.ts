import { z } from 'zod'
import { DeviceAddedMessage, DeviceDiscoveredMessage, DeviceReadinessMessage, DeviceReadinessSetMessage, DeviceRemovedMessage, DeviceStatusMessage } from './device'
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
import { InputGestureMessage, InputKeyMessage, InputSwipeMessage, InputTapMessage, InputTextMessage, InputTextResultMessage } from './messages/input'
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
  JobWaitingMessage,
} from './messages/job'
import {
  QualitySchema,
  SessionProgressMessage,
  StreamEndedMessage,
  StreamKeyframeMessage,
  StreamMetaMessage,
  StreamStartedMessage,
  StreamStartMessage,
  StreamStopMessage,
} from './messages/stream'
import {
  ToolChangedMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
} from './messages/tool'
import { AdbHealthMessage } from './messages/adb-health'
import { AdbServerPhaseMessage } from './messages/adb-server-control'
import { DeviceCutoverMessage } from './messages/cutover'
import { BatchStatusMessage } from './messages/batch'
import { ScheduleFiredMessage } from './messages/schedule'
import { DeviceEventMessage, LogSubscribeMessage, LogUnsubscribeMessage } from './messages/device-event'
import { DeviceViewersMessage, HelloMessage, ViewerSchema } from './messages/presence'
import {
  MonitorStartMessage,
  MonitorStopMessage,
  MonitorOneshotMessage,
  MonitorStartedMessage,
  MonitorDataMessage,
  MonitorEndedMessage,
  MonitorResultMessage,
  MonitorSubscribersMessage,
  ShellExecMessage,
  ShellEchoMessage,
  ShellResultMessage,
} from './messages/shell'
import { ClipboardGetMessage, ClipboardOkMessage, ClipboardSetMessage, ClipboardValueMessage } from './messages/clipboard'
import { TransferCancelMessage, TransferDoneMessage, TransferProgressMessage } from './messages/transfer'
import {
  InspectAttachMessage,
  InspectDetachMessage,
  InspectDumpMessage,
  InspectFindMessage,
  InspectMatchMessage,
  InspectStatusMessage,
  InspectTreeMessage,
} from './messages/inspect'
import {
  AgentRunCancelMessage,
  AgentRunStartedMessage,
  AgentRunFinishedMessage,
  AgentDeltaMessage,
  AgentMessageAppendedMessage,
  AgentToolStartedMessage,
  AgentToolFinishedMessage,
  AgentApprovalRequestedMessage,
  AgentApprovalResolvedMessage,
  AgentChildStartedMessage,
  AgentChildFinishedMessage,
} from './messages/agent'
import { NotificationCreatedMessage } from './messages/notify'
// Plan 91 §4.4, §5 step 91.4 (Task B.2) — the twelve co-control messages
// (`assist.*`, `mirror.*`, `input.mirror*`) were declared and re-exported
// from `./messages/co-control` by step 91.3, but never imported for use in
// `ClientMessageSchema`/`ServerMessageSchema` below — so the WS router could
// not recognise a single one of them. Imported here, separately from the
// re-export block further down, purely so the two union arrays can reference
// them.
import {
  AssistStartMessage,
  AssistStopMessage,
  MirrorStartMessage,
  MirrorStopMessage,
  InputMirrorMessage,
  AssistStartedMessage,
  AssistStoppedMessage,
  AssistChangedMessage,
  MirrorStartedMessage,
  MirrorStoppedMessage,
  InputMirrorResultMessage,
  MirrorChangedMessage,
} from './messages/co-control'
// Plan 94 (M59 — the action recorder), step 94.3. The recorder's five WS
// messages (§4.9) — imported here, separately from the re-export block
// further down, purely so the two union arrays below can reference them (the
// same split `messages/co-control`'s own import block above already uses).
import {
  RecordingStartMessage,
  RecordingStopMessage,
  RecordingCancelMessage,
  RecordingStateMessage,
  RecordingStepMessage,
} from './messages/recording'
// Plan 93 (M58 — command console and bulk operations), step 93.4. The
// command console's five server→client events and two client→server
// subscription messages (§3.17, §4.3) — imported here, separately from the
// re-export block further down, purely so the two union arrays below can
// reference them (the same split `messages/co-control`'s and `messages/
// recording`'s own import blocks above already use).
import {
  CommandStartedMessage,
  CommandProgressMessage,
  CommandOutputMessage,
  CommandStageMessage,
  CommandFinishedMessage,
  CommandSubscribeMessage,
  CommandUnsubscribeMessage,
} from './messages/command'
// Plan 97 (M62 — the script output contract), step 97.7, §3.7, §4.6.
// `ctx.progress()`'s live push — imported here, separately from the
// re-export block further down, purely so `ServerMessageSchema` below can
// reference it (the same split `messages/co-control`'s/`messages/recording`'s/
// `messages/command`'s own import blocks above already use).
import { JobProgressEventMessage } from './messages/job'

// Plan 128 (M93 — the job trace timeline), step 128.1, §4.2. `job.trace` — the
// live tail of one job's event stream. Imported here, separately from the
// re-export block further down, for the same reason `JobProgressEventMessage`
// above is: `ServerMessageSchema` needs to reference it.
import { JobTraceMessage } from './messages/job'

export { EnvelopeSchema, type Envelope } from './envelope'
export * from './api'
export {
  PARAM_KINDS,
  DURATION_UNITS,
  PARAM_SOURCES,
  ENKAKU_META_KEY,
  ParamHintsSchema,
  readHints,
  ui,
  type ParamKind,
  type DurationUnit,
  type ParamSource,
  type ShowWhen,
  type ParamHints,
  type UiSpec,
} from './schema/vocabulary'
export { SCHEMA_LIMITS, checkDeclaredSchema, type SchemaCheckFinding } from './schema/limits'
export { validateAgainstSchema, type ParamIssue, type ValidateParamsResult } from './schema/validate'
export { clampSchema, summarizeClamp, type ClampedSchema } from './schema/clamp'
export { HOSTILE_PARAMS_FIXTURES, HOSTILE_BLOCKING, type HostileFixtureName } from './schema/hostile-fixtures'
// Plan 97 §4.1, step 97.1 — `formatValue` (moved here from
// `packages/studio/src/components/schema-form/controls/format.ts` because
// the core needs it too, to build `result_summary` at settle) and its
// `NumberKind` parameter type, moved with it for the same reason.
export { formatValue, type NumberKind } from './schema/format'
export { reconcileParams, summarizeApply, type FindingKind, type ReconcileFinding, type ReconcileResult } from './schema/reconcile'
export {
  EffortSchema,
  AgentDefaultsSchema,
  AgentSettingsSchema,
  ResolvedAgentConfigSchema,
  WorkspaceScopeSchema,
  AgentSlugSchema,
  AgentSchema,
  AgentWriteInputSchema,
  AgentUpdateInputSchema,
  resolveAgentConfig,
  ConnectorKindSchema,
  ConnectorStatusSchema,
  ConnectorSchema,
  ConnectorWriteInputSchema,
  ConnectorUpdateInputSchema,
  ModelInfoSchema,
  ModelListResponseSchema,
  ConnectorTestResultSchema,
  type Effort,
  type AgentDefaults,
  type AgentSettings,
  type ResolvedAgentConfig,
  type WorkspaceScope,
  type Agent,
  type AgentWriteInput,
  type AgentUpdateInput,
  type ConnectorKind,
  type ConnectorStatus,
  type Connector,
  type ConnectorWriteInput,
  type ConnectorUpdateInput,
  type ModelInfo,
  type ModelListResponse,
  type ConnectorTestResult,
} from './agent'
export { normaliseTag, TagSchema } from './tags'
export { ScriptRefSchema, parseScriptRef, compareSemver, isPrereleaseVersion, type ScriptRef } from './script-ref'
export {
  CAPABILITY_REFUSAL_CODES,
  CapabilityRefusalCodeSchema,
  CapabilityErrorSchema,
  toJsonSchema,
  GestureEasingSchema,
  ScrollDirectionSchema,
  PackageNameSchema,
  TapArgsSchema,
  SwipeArgsSchema,
  ScrollArgsSchema,
  FlingArgsSchema,
  TypeArgsSchema,
  KeyArgsSchema,
  FindArgsSchema,
  DumpArgsSchema,
  WaitForArgsSchema,
  ScreenshotArgsSchema,
  AppLaunchArgsSchema,
  AppForceStopArgsSchema,
  ClipboardGetArgsSchema,
  ClipboardSetArgsSchema,
  InstallArgsSchema,
  PushArgsSchema,
  PullArgsSchema,
  DEVICE_CALL_ARGS,
  type Capability,
  type AnyCapability,
  type CapabilityResult,
  type CapabilityEffect,
  type CapabilityLease,
  type CapabilityRefusalCode,
  type CapabilityError,
  type DeviceCallMethod,
} from './capability'
export {
  DeviceStatusSchema,
  DeviceInfoSchema,
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceDiscoveredMessage,
  DeviceStatusMessage,
  DeviceReadinessSetMessage,
  DeviceReadinessMessage,
  LeaseHolderSchema,
  ConnectionKindSchema,
  ConnectionMediumSchema,
  DeviceConnectionSchema,
  connectionBadge,
  AgentStateSchema,
  AgentStatusSchema,
  DEFAULT_AGENT_STATUS,
  GuestAgentIdentitySchema,
  DEFAULT_GUEST_AGENT_IDENTITY,
  type DeviceStatus,
  type DeviceInfo,
  type DeviceAdded,
  type DeviceRemoved,
  type DeviceDiscovered,
  type DeviceStatusEvent,
  type DeviceReadinessSet,
  type DeviceReadinessEvent,
  type LeaseHolder,
  type ConnectionKind,
  type ConnectionMedium,
  type DeviceConnection,
  type AgentState,
  type AgentStatus,
  type GuestAgentIdentity,
} from './device'
export {
  PreparationStateSchema,
  PreparationComponentStatusSchema,
  DEFAULT_PREPARATION_COMPONENT_STATUS,
  DevicePreparationSchema,
  DEFAULT_DEVICE_PREPARATION,
  type PreparationState,
  type PreparationComponentStatus,
  type DevicePreparation,
} from './device-preparation'
export {
  ReadinessSchema,
  ReadinessBlockedReasonSchema,
  DeviceReadinessSchema,
  type Readiness,
  type ReadinessBlockedReason,
  type DeviceReadiness,
} from './readiness'
export {
  AwakeApplyOutcomeSchema,
  CapturedPowerStateSchema,
  ObservedScreenSchema,
  AwakeApplyResultSchema,
  type AwakeApplyOutcome,
  type CapturedPowerState,
  type ObservedScreen,
  type AwakeApplyResult,
} from './power'
export type {
  Transport,
  TransportExecOptions,
  DisplaySource,
  InputSink,
  Inspector,
  Point,
  FrameMeta,
  GestureSample,
  ShellResult,
} from './driver'
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
  KeepAwakeModeSchema,
  ShellModeSchema,
  CoControlModeSchema,
  RotationModeSchema,
  TextInputModeSchema,
  DeviceGpsSchema,
  DeviceIdentitySchema,
  DeviceInstrumentationSchema,
  DeviceSettingsSchema,
  FarmSettingsSchema,
  JobSettingsSchema,
  CidrSchema,
  addressCount,
  defaultFarmSettings,
  defaultDeviceSettings,
  type BatteryState,
  type KeepAwakeMode,
  type ShellMode,
  type CoControlMode,
  type RotationMode,
  type TextInputMode,
  type TimingSettings,
  type DeviceGps,
  type DeviceIdentity,
  type DeviceInstrumentation,
  type DeviceSettings,
  type FarmSettings,
  type FarmDeviceDefaults,
  type JobSettings,
  type SessionSettings,
  type WallSettings,
  type ReadinessSettings,
  type WorkspaceSettings,
  type CoControlSettings,
  type MirrorSettings,
  type WorkflowJobSettings,
} from './settings'
export {
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  type ToolInstallProgress,
  type ToolProvisionProgress,
  type ToolChanged,
} from './messages/tool'
export {
  AdbHealthMessage,
  type AdbHealthEvent,
} from './messages/adb-health'
export {
  AdbServerPhaseSchema,
  AdbServerPhaseMessage,
  type AdbServerPhase,
  type AdbServerPhaseEvent,
} from './messages/adb-server-control'
export {
  NormPointSchema,
  INPUT_ACTION_BODIES,
  InputTapMessage,
  InputSwipeMessage,
  InputKeyMessage,
  InputTextMessage,
  InputTextResultMessage,
  NormGestureSampleSchema,
  InputGestureMessage,
  MirrorActionSchema,
  type NormPoint,
  type NormGestureSample,
  type MirrorAction,
} from './messages/input'
export {
  AssistEndReasonSchema,
  MirrorMemberSchema,
  MirrorResultSchema,
  AssistStartMessage,
  AssistStopMessage,
  MirrorStartMessage,
  MirrorStopMessage,
  InputMirrorMessage,
  AssistStartedMessage,
  AssistStoppedMessage,
  AssistChangedMessage,
  MirrorStartedMessage,
  MirrorStoppedMessage,
  InputMirrorResultMessage,
  MirrorChangedMessage,
  type AssistEndReason,
  type MirrorMember,
  type MirrorResult,
} from './messages/co-control'
export {
  StreamStartMessage,
  StreamStartedMessage,
  StreamStopMessage,
  StreamKeyframeMessage,
  StreamMetaMessage,
  StreamEndedMessage,
  SessionPhaseSchema,
  SessionProgressMessage,
  QualitySchema,
  type SessionPhase,
  type SessionProgress,
  type Quality,
} from './messages/stream'
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
  encodeSnapshot,
  decodeSnapshot,
  type DecodedVideoFrame,
  type DecodedSnapshot,
} from './binary'
export {
  JobStatusSchema,
  SleepJobParamsSchema,
  JobInfoSchema,
  JobDetailSchema,
  JobSummarySchema,
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
  JobWaitingMessage,
  /** Plan 99 §4.6, §4.9 — `job_nodes.status`'s domain, shared by `job.status`'s `node` block. */
  JobNodeStatusSchema,
  /** Plan 99 §3.5, §4.9, step 99.8 — resume. The node timeline's own schemas come from `./api/jobs` via `export * from './api'` above. */
  JobResumeRequestSchema,
  JobResumeResponseSchema,
  type JobStatus,
  type JobInfo,
  type JobDetail,
  type JobSummary,
  type ArtifactInfo,
  type SleepJobParams,
  type JobNodeStatus,
  type JobResumeRequest,
  type JobResumeResponse,
} from './messages/job'
export {
  BatchOrderSchema,
  BatchStatusSchema,
  BatchCountsSchema,
  ClusterInfoSchema,
  ResolvedTargetSchema,
  SkippedDeviceSchema,
  ClusterPreviewSchema,
  BatchInfoSchema,
  BatchStatusMessage,
  BatchPacingSchema,
  BatchDeviceRepeatSchema,
  type BatchOrder,
  type BatchStatusValue,
  type BatchCounts,
  type ClusterInfo,
  type ClusterPreview,
  type BatchInfo,
  type BatchStatusEvent,
  type BatchPacing,
  type BatchDeviceRepeat,
} from './messages/batch'
export {
  OnOverlapSchema,
  CatchUpSchema,
  ScheduleRunOutcomeSchema,
  ScheduleWorkTargetSchema,
  ScheduleThreadModeSchema,
  OnApprovalRequiredSchema,
  ScheduleInfoSchema,
  ScheduleRunInfoSchema,
  ScheduleFiredMessage,
  type OnOverlap,
  type CatchUp,
  type ScheduleRunOutcome,
  type ScheduleWorkTarget,
  type ScheduleThreadMode,
  type OnApprovalRequired,
  type ScheduleInfo,
  type ScheduleRunInfo,
  type ScheduleFiredEvent,
} from './messages/schedule'
export {
  NotificationLevelSchema,
  NotificationContextSchema,
  NotificationSchema,
  NotifySendInputSchema,
  NotifySendOutputSchema,
  WebhookDeliveryStatusSchema,
  WebhookEndpointSchema,
  WebhookEndpointWriteInputSchema,
  WebhookEndpointUpdateInputSchema,
  NotificationCreatedMessage,
  type NotificationLevel,
  type NotificationContext,
  type Notification,
  type NotifySendInput,
  type NotifySendOutput,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEndpointWriteInput,
  type WebhookEndpointUpdateInput,
  type NotificationCreatedEvent,
} from './messages/notify'
export {
  DeviceEventStreamSchema,
  MAIN_EVENT_KINDS,
  INPUT_EVENT_KINDS,
  DeviceEventSchema,
  LogSubscribeMessage,
  LogUnsubscribeMessage,
  DeviceEventMessage,
  type DeviceEventStream,
  type DeviceEvent,
} from './messages/device-event'
export {
  ViewerSchema,
  DeviceViewersMessage,
  HelloMessage,
  type Viewer,
  type DeviceViewersEvent,
  type HelloEvent,
} from './messages/presence'
export {
  MonitorKindSchema,
  LogcatOptionsSchema,
  EmptyMonitorOptionsSchema,
  MeminfoOptionsSchema,
  STREAMING_MONITOR_KINDS,
  ONE_SHOT_MONITOR_KINDS,
  optionsSchemaFor,
  type MonitorKind,
  type LogcatOptions,
  type MeminfoOptions,
} from './messages/monitor'
export {
  MonitorEndReasonSchema,
  MonitorStartMessage,
  MonitorStopMessage,
  MonitorOneshotMessage,
  MonitorStartedMessage,
  MonitorDataMessage,
  MonitorEndedMessage,
  MonitorResultMessage,
  MonitorSubscribersMessage,
  ShellExecMessage,
  ShellEchoMessage,
  ShellResultMessage,
  type MonitorEndReason,
} from './messages/shell'
export {
  ClipboardGetMessage,
  ClipboardSetMessage,
  ClipboardValueMessage,
  ClipboardOkMessage,
} from './messages/clipboard'
export {
  TransferKindSchema,
  TransferProgressMessage,
  TransferDoneMessage,
  TransferCancelMessage,
  InstallJobParamsSchema,
  InstallResultSchema,
  MediaScanModeSchema,
  MediaScanResultSchema,
  PushResultSchema,
  type TransferKind,
  type InstallJobParams,
  type InstallResult,
  type MediaScanMode,
  type MediaScanResult,
  type PushResult,
} from './messages/transfer'
export {
  PointSchema,
  SelectorSchema,
  UiNodeSchema,
  BoundsSchema,
  KeyCodeSchema,
  KEYCODES,
  resolveKeyCode,
  type Selector,
  type UiNode,
  type Bounds,
  type KeyCode,
  type KeyName,
} from './ui-node'
export { matchSelector, centerOf } from './selector-match'
export { FindOutcomeSchema, type FindOutcome } from './find-outcome'
export {
  countMatches,
  proposeSelectors,
  type SelectorCandidate,
  type SelectorCandidateKind,
} from './selector-analysis'
export {
  InspectRequestIdSchema,
  FrameSizeSchema,
  InspectAttachMessage,
  InspectDetachMessage,
  InspectDumpMessage,
  InspectFindMessage,
  InspectStateSchema,
  InspectStatusMessage,
  InspectTreeMessage,
  InspectMatchMessage,
  type InspectState,
} from './messages/inspect'
export {
  AgentMessageRoleSchema,
  AgentTextBlockSchema,
  AgentThinkingBlockSchema,
  AgentToolUseBlockSchema,
  AgentImageMediaTypeSchema,
  AgentImageRefSchema,
  ToolResultContentSchema,
  AgentToolResultBlockSchema,
  AgentContentBlockSchema,
  AgentMessageSchema,
  AgentBlobInfoSchema,
  AgentRunStatusSchema,
  AgentStopReasonSchema,
  AgentErrorClassSchema,
  AgentUsageSchema,
  AgentThreadOriginSchema,
  AgentThreadSchema,
  AgentRunSchema,
  AgentApprovalStatusSchema,
  AgentApprovalSchema,
  CreateThreadInputSchema,
  PostThreadMessageInputSchema,
  ApprovalDecisionInputSchema,
  AgentRunCancelMessage,
  AgentRunStartedMessage,
  AgentRunFinishedMessage,
  AgentDeltaMessage,
  AgentMessageAppendedMessage,
  AgentToolStartedMessage,
  AgentToolFinishedMessage,
  AgentApprovalRequestedMessage,
  AgentApprovalResolvedMessage,
  AgentTreeNodeSchema,
  AgentTreeResponseSchema,
  AgentChildStartedMessage,
  AgentChildFinishedMessage,
  type AgentMessageRole,
  type AgentImageMediaType,
  type AgentImageRef,
  type ToolResultContent,
  type AgentContentBlock,
  type AgentMessage,
  type AgentBlobInfo,
  type AgentRunStatus,
  type AgentStopReason,
  type AgentErrorClass,
  type AgentUsage,
  type AgentThreadOrigin,
  type AgentThread,
  type AgentRun,
  type AgentTreeNode,
  type AgentTreeResponse,
  type AgentApprovalStatus,
  type AgentApproval,
  type CreateThreadInput,
  type PostThreadMessageInput,
  type ApprovalDecisionInput,
} from './messages/agent'

export {
  RoutedEnvelopeSchema,
  NodeToControlSchema,
  ControlToNodeSchema,
  NodeHelloMessage,
  NodeHelloAckMessage,
  NodeDevicesMessage,
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
  ShellReplyErrorSchema,
  ShellExecRequestMessage,
  ShellExecReplyMessage,
  ShellStreamRequestMessage,
  ShellStreamReplyMessage,
  ShellStreamStopMessage,
  ShellStreamEndedMessage,
  ClipboardReplyErrorSchema,
  ClipboardGetRequestMessage,
  ClipboardGetReplyMessage,
  ClipboardSetRequestMessage,
  ClipboardSetReplyMessage,
  type TunnelChannelKind,
  type RoutedEnvelope,
  type NodeToControl,
  type ControlToNode,
} from './tunnel'

export {
  NetworkEngineIdSchema,
  NetworkCapabilitiesSchema,
  Socks5RouteConfigSchema,
  HttpProxyRouteConfigSchema,
  ReverseProxyRouteConfigSchema,
  NetworkRouteConfigSchema,
  StoredNetworkRouteConfigSchema,
  tagUntaggedRouteConfig,
  redactRouteConfig,
  renderStickyUsername,
  NetworkCredentialSchema,
  CreateNetworkCredentialRequestSchema,
  NetworkObservationSchema,
  NetworkStatusSchema,
  PersistedNetworkRouteSchema,
  RouteCheckIdSchema,
  RouteCheckSchema,
  deriveHealth,
  GeoExpectationSchema,
  GeoObservationSchema,
  GeoProviderResponseSchema,
  matchGeoExpectation,
  EXIT_HISTORY_LIMIT,
  pushExitHistory,
  type NetworkEngineId,
  type NetworkCapabilities,
  type Socks5RouteConfig,
  type HttpProxyRouteConfig,
  type ReverseProxyRouteConfig,
  type NetworkRouteConfig,
  type NetworkCredential,
  type CreateNetworkCredentialRequest,
  type NetworkObservation,
  type NetworkStatus,
  type PersistedNetworkRoute,
  type RouteCheckId,
  type RouteCheck,
  type GeoExpectation,
  type GeoObservation,
  type GeoProviderResponse,
  type GeoMatchResult,
} from './network'

export {
  GUEST_AGENT_SOCKET,
  GUEST_AGENT_PROTOCOL,
  GuestAgentCapabilitySchema,
  GuestAgentErrorCodeSchema,
  HelloRequestSchema,
  PingRequestSchema,
  RouteStartRequestSchema,
  RouteStopRequestSchema,
  RouteStatusRequestSchema,
  EgressProbeRequestSchema,
  RouteHoldRequestSchema,
  LocationSetRequestSchema,
  LocationClearRequestSchema,
  LabelApplyRequestSchema,
  LabelStatusRequestSchema,
  LabelClearRequestSchema,
  TextCommitRequestSchema,
  TextStatusRequestSchema,
  GuestAgentRequestSchema,
  HelloResultSchema,
  PingResultSchema,
  RouteStartResultSchema,
  RouteStopResultSchema,
  RouteStatusResultSchema,
  EgressProbeLegSchema,
  EgressProbeResultSchema,
  RouteHoldResultSchema,
  LocationSetResultSchema,
  LocationClearResultSchema,
  LabelApplyResultSchema,
  LabelStatusResultSchema,
  LabelClearResultSchema,
  TextCommitResultSchema,
  TextStatusResultSchema,
  GuestAgentOkResponseSchema,
  GuestAgentErrorResponseSchema,
  GuestAgentResponseSchema,
  type GuestAgentCapability,
  type GuestAgentErrorCode,
  type HelloRequest,
  type PingRequest,
  type RouteStartRequest,
  type RouteStopRequest,
  type RouteStatusRequest,
  type EgressProbeRequest,
  type RouteHoldRequest,
  type LocationSetRequest,
  type LocationClearRequest,
  type LabelApplyRequest,
  type LabelStatusRequest,
  type LabelClearRequest,
  type TextCommitRequest,
  type TextStatusRequest,
  type GuestAgentRequest,
  type HelloResult,
  type PingResult,
  type RouteStartResult,
  type RouteStopResult,
  type RouteStatusResult,
  type EgressProbeLeg,
  type EgressProbeResult,
  type RouteHoldResult,
  type LocationSetResult,
  type LocationClearResult,
  type LabelApplyResult,
  type LabelStatusResult,
  type LabelClearResult,
  type TextCommitResult,
  type TextStatusResult,
  type GuestAgentOkResponse,
  type GuestAgentErrorResponse,
  type GuestAgentResponse,
} from './guest-agent'

/**
 * Plan 99 (M64 — workflows): the document format and its pure evaluation
 * core. `workflow.ts` owns the document shape (`WorkflowDocSchema`) and the
 * closed value/predicate grammars (§3.6, §3.7); `workflow-params.ts` compiles
 * a workflow's own parameter declarations to the same JSON Schema shape a
 * hand-written script's `paramsSchema` already uses (§3.8); `workflow-resolve.ts`
 * is the total, never-throwing evaluator (`resolveValue`/`evaluatePredicate`)
 * both the (future) workflow executor and the editor's Validate button share.
 * No executor, no DB table, no route yet — those are later steps in plan 99 §5.
 */
export {
  WORKFLOW_LIMITS,
  WorkflowNodeIdSchema,
  WorkflowPathSchema,
  WorkflowNameSchema,
  WorkflowVersionSchema,
  ValueExprSchema,
  GATE_OPS,
  PredicateSchema,
  GateOutcomeSchema,
  WorkflowNodeSchema,
  WorkflowDocSchema,
  type WorkflowNodeId,
  type ValueExpr,
  type GateOp,
  type Predicate,
  type GateOutcome,
  type WorkflowNode,
  type WorkflowDoc,
} from './workflow'
export {
  WorkflowParamNameSchema,
  WORKFLOW_PARAM_TYPES,
  WorkflowParamSchema,
  compileWorkflowParams,
  type WorkflowParamName,
  type WorkflowParamType,
  type WorkflowParam,
} from './workflow-params'
export {
  resolveValue,
  evaluatePredicate,
  type RunSummaryEntry,
  type ResolveScope,
  type ResolveOutcome,
  type PredicateTrace,
} from './workflow-resolve'

/**
 * Generic server→client error (a failed reply, an invalid message).
 *
 * `action` (plan 90 §3.3, §5 step 90.5) is optional and additive — every existing caller keeps
 * sending a bare `{code, message}`. It names a next step a NAMED PRECONDITION (plan 59: a
 * precondition is not a failure) can offer — today only `resolveTextRoute`'s `unmet.action` sets
 * it, for `input.text`'s refusal when no rung can carry the requested string.
 */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  payload: z.object({
    code: z.string(),
    message: z.string(),
    action: z.enum(['install-agent', 'update-agent']).optional(),
  }),
})

/**
 * A one-way liveness beat, broadcast every 15s (plan 85 §3.6, §4.6, fixes
 * F16, tests H2) — the Studio client resets a 45s silence watchdog on ANY
 * inbound message, so this is what turns "the socket is open but nothing is
 * coming through it" from an undetectable state into one that self-heals.
 * Deliberately absent from `ClientMessage`: a browser cannot observe
 * protocol-level WebSocket pongs, and a client→server beat would only
 * duplicate what every other command already proves.
 */
export const HeartbeatMessage = z.object({
  type: z.literal('heartbeat'),
  payload: z.object({ t: z.number() }),
})

/** Every server→client message. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessage,
  HeartbeatMessage,
  DeviceViewersMessage,
  DeviceAddedMessage,
  DeviceRemovedMessage,
  DeviceDiscoveredMessage,
  DeviceStatusMessage,
  DeviceReadinessMessage,
  DeviceUnauthorizedMessage,
  DeviceInspectorStatusMessage,
  DeviceInspectorFallbackMessage,
  DeviceBatteryMessage,
  ToolInstallProgressMessage,
  ToolProvisionProgressMessage,
  ToolChangedMessage,
  AdbHealthMessage,
  AdbServerPhaseMessage,
  DeviceCutoverMessage,
  StreamStartedMessage,
  StreamMetaMessage,
  StreamEndedMessage,
  SessionProgressMessage,
  DevicePairingRequestResultMessage,
  DevicePairingCodeResultMessage,
  JobStatusEventMessage,
  JobLogMessage,
  JobArtifactMessage,
  LeaseAcquiredMessage,
  LeaseReleasedMessage,
  LeaseChangedMessage,
  LeaseRevokedMessage,
  JobWaitingMessage,
  BatchStatusMessage,
  ScheduleFiredMessage,
  DeviceEventMessage,
  MonitorStartedMessage,
  MonitorDataMessage,
  MonitorEndedMessage,
  MonitorResultMessage,
  MonitorSubscribersMessage,
  ShellEchoMessage,
  ShellResultMessage,
  ClipboardValueMessage,
  ClipboardOkMessage,
  InputTextResultMessage,
  TransferProgressMessage,
  TransferDoneMessage,
  InspectStatusMessage,
  InspectTreeMessage,
  InspectMatchMessage,
  AgentRunStartedMessage,
  AgentRunFinishedMessage,
  AgentDeltaMessage,
  AgentMessageAppendedMessage,
  AgentToolStartedMessage,
  AgentToolFinishedMessage,
  AgentApprovalRequestedMessage,
  AgentApprovalResolvedMessage,
  AgentChildStartedMessage,
  AgentChildFinishedMessage,
  NotificationCreatedMessage,
  // Plan 91 §4.4, §5 step 91.4 (Task B.2) — the seven server→client halves of
  // the twelve co-control messages (§4.4's table): `assist.started`,
  // `assist.stopped` (unicast replies), `assist.changed` (broadcast), and
  // the five `mirror.*`/`input.mirror.result` messages step 91.7 will start
  // sending.
  AssistStartedMessage,
  AssistStoppedMessage,
  AssistChangedMessage,
  MirrorStartedMessage,
  MirrorStoppedMessage,
  InputMirrorResultMessage,
  MirrorChangedMessage,
  ErrorMessage,
  // Plan 94 (M59 — the action recorder), step 94.3, §4.9 — appended after
  // `ErrorMessage` rather than interleaved among the entries above, so this
  // addition cannot conflict with a concurrent worker's own append to this
  // contested file.
  RecordingStateMessage,
  RecordingStepMessage,
  // Plan 93 (M58 — command console and bulk operations), step 93.4, §3.17,
  // §4.3 — appended last, for the same "never interleave, this file is
  // contested" reason noted on the Plan 94 entries immediately above.
  CommandStartedMessage,
  CommandProgressMessage,
  CommandOutputMessage,
  CommandStageMessage,
  CommandFinishedMessage,
  // Plan 97 (M62 — the script output contract), step 97.7, §3.7, §4.6 —
  // appended last, for the same "never interleave, this file is contested"
  // reason noted on the Plan 93/94 entries above.
  JobProgressEventMessage,
  // Plan 128 (M93 — the job trace timeline), step 128.1, §4.2 — the trace's
  // live tail, the sibling of `JobLogMessage` above. Appended last, for the
  // same "never interleave, this file is contested" reason noted on every
  // entry above it.
  JobTraceMessage,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

/**
 * Every `type` string `ServerMessageSchema` above can carry, **derived from
 * the union rather than restated beside it** (plan 109 §3.5, step 109.5).
 *
 * A hand-written second list would be wrong the first time anyone appends to
 * the union — and this file's own comments say it is appended to often, by
 * concurrent workers, precisely to avoid conflicts. So the list is read off
 * the schema, and it is read through Zod rather than through a cast: the probe
 * below is an ordinary `safeParse` against the union object's own shape, which
 * is exactly the discipline every other boundary in this package follows.
 *
 * If a future Zod changes that shape the probe fails closed and this is empty,
 * which is why `packages/core/src/plugins/runtime-service.test.ts` asserts it
 * is populated and contains known members — an empty list would otherwise turn
 * `unknownPluginEventTypesMessage` into a check that never fires, the exact
 * failure plan 109 §9 Q15 records.
 */
const ServerMessageOptionProbe = z.object({ shape: z.object({ type: z.object({ value: z.string() }) }) })
const ServerMessageUnionProbe = z.object({ options: z.array(ServerMessageOptionProbe) })
const serverMessageUnion = ServerMessageUnionProbe.safeParse(ServerMessageSchema)
export const SERVER_MESSAGE_TYPES: readonly string[] = serverMessageUnion.success
  ? serverMessageUnion.data.options.map((option) => option.shape.type.value)
  : []
const SERVER_MESSAGE_TYPE_SET = new Set(SERVER_MESSAGE_TYPES)

/** Whether `type` names a message the core can actually broadcast. */
export function isServerMessageType(type: string): boolean {
  return SERVER_MESSAGE_TYPE_SET.has(type)
}

/**
 * The farm's half of the plugin event vocabulary check (plan 109 §3.5, step
 * 109.5) — the same split `unsupportedIsolationMessage` uses: the manifest
 * SCHEMA accepts any dotted lowercase token, and the FARM, at verify, refuses
 * the ones this build cannot deliver.
 *
 * It lives here rather than in `plugin-service.ts` because the answer is
 * `ServerMessageSchema` itself, which is declared in this file; importing this
 * file from that one would be a cycle.
 *
 * **On `device.connected` / `device.disconnected`** — plan 109 §3.5's example
 * declares both, and step 109.5's own condition is that they be added *"if the
 * fan-out does not already carry them under another name"*. It does. A device
 * connecting or disconnecting reaches `hub.broadcast` as **`device.status`**
 * (`payload.status === 'offline'` is disconnected; anything else is connected)
 * from the device state machine's `DEVICE_CONNECTED`/`DEVICE_DISCONNECTED`
 * transitions, and a device entering or leaving the farm's registry reaches it
 * as `device.added` / `device.removed`. Adding a third pair of names for the
 * first of those would be inventing vocabulary for something real, which is
 * what plan 109 §9 Q1 says not to do.
 *
 * Returns the refusal message, or `null` when every type is deliverable.
 */
export function unknownPluginEventTypesMessage(events: readonly string[]): string | null {
  const unknown = events.filter((type) => !SERVER_MESSAGE_TYPE_SET.has(type))
  if (unknown.length === 0) return null
  const connectish = unknown.some((type) => type === 'device.connected' || type === 'device.disconnected')
  return (
    `this farm broadcasts no such event: ${unknown.join(', ')}. A plugin's \`events\` list names server→client message types ` +
    `(docs/plans/109-m74-plugin-runtime.md §3.5)` +
    (connectish
      ? ' — and there is no `device.connected`/`device.disconnected`: a device connecting or disconnecting arrives as `device.status`' +
        " (payload.status === 'offline' is disconnected), and joining or leaving the registry as `device.added`/`device.removed`."
      : '.')
  )
}

/** Every client→server message (M2: input, stream, pairing). */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputTapMessage,
  InputSwipeMessage,
  InputGestureMessage,
  InputKeyMessage,
  InputTextMessage,
  StreamStartMessage,
  StreamStopMessage,
  StreamKeyframeMessage,
  DeviceReadinessSetMessage,
  DevicePairingRequestMessage,
  DevicePairingCodeMessage,
  JobEnqueueMessage,
  JobCancelMessage,
  LeaseAcquireMessage,
  LeaseReleaseMessage,
  LogSubscribeMessage,
  LogUnsubscribeMessage,
  MonitorStartMessage,
  MonitorStopMessage,
  MonitorOneshotMessage,
  ShellExecMessage,
  ClipboardGetMessage,
  ClipboardSetMessage,
  TransferCancelMessage,
  InspectAttachMessage,
  InspectDetachMessage,
  InspectDumpMessage,
  InspectFindMessage,
  AgentRunCancelMessage,
  // Plan 91 §4.4, §5 step 91.4 (Task B.2) — the five client→server halves of
  // the twelve co-control messages (§4.4's table): `assist.start`/
  // `assist.stop` (step 91.4, wired below in `ws-handlers.ts`) and
  // `mirror.start`/`mirror.stop`/`input.mirror` (step 91.7 — declared here
  // now so the whole set is reachable together, per this step's brief;
  // their WS-handler cases do not exist yet).
  AssistStartMessage,
  AssistStopMessage,
  MirrorStartMessage,
  MirrorStopMessage,
  InputMirrorMessage,
  // Plan 94 (M59 — the action recorder), step 94.3, §4.9 — appended last,
  // for the same "never interleave, this file is contested" reason noted on
  // `ServerMessageSchema` above.
  RecordingStartMessage,
  RecordingStopMessage,
  RecordingCancelMessage,
  // Plan 93 (M58 — command console and bulk operations), step 93.4, §3.17,
  // §4.3 — subscription only; `POST /api/command-runs` is the only way to
  // START a run (§3.17).
  CommandSubscribeMessage,
  CommandUnsubscribeMessage,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

// Plan 98 (M63 — the script runtime envelope), step 98.1. `enforcement` is a
// new member of the existing `./schema/vocabulary` hint vocabulary — a
// second export statement from that same module, appended here rather than
// folded into the block above, since two other workers already appended to
// THIS file today and the brief for this step is additive-only, never a
// reorder or a tidy of an existing block.
export { ENFORCEMENT_LEVELS, type EnforcementLevel } from './schema/vocabulary'

export {
  SCRIPT_RUNTIME_MAJOR,
  SCRIPT_RUNTIME_MIN_MAJOR,
  RuntimeEnvelopeSchema,
  resolveRuntime,
  unknownRuntimeKeys,
  checkRuntimeMajor,
  type RuntimeEnvelope,
  type ResolvedRuntime,
  type RuntimeClamp,
} from './runtime-envelope'

// Plan 99 (M64 — workflows), step 99.6. `checkWorkflow` is the pure,
// database-free static checker (§4.3) both the editor's Validate button and
// the publish route call — declared in its own file (`workflow-check.ts`)
// rather than folded into `workflow.ts`/`workflow-resolve.ts`, matching how
// those two were already split by concern in steps 99.1/99.3.
export {
  checkWorkflow,
  type WorkflowFinding,
  type WorkflowFindingCode,
  type ResolvedNodeScript,
  type WorkflowBudget,
} from './workflow-check'

// Plan 92 (M57 — wall-first and video quality), step 92.1. `FarmSettingsSchema`/
// `DeviceSettingsSchema` already export their own `video` blocks through the
// existing `export {...} from './settings'` block above; these three names
// were added to `settings.ts` alongside those blocks and are appended here,
// as their own statement, rather than folded into that block — this file is
// contested (a concurrent worker is also appending today) and the rule is
// append-only, never reorder an existing block.
export {
  VideoNumbersSchema,
  ControlPresetSchema,
  WallPresetSchema,
  type VideoNumbers,
  type ControlPreset,
  type WallPreset,
  type VideoSettings,
} from './settings'

// Plan 100 §3.1, §4.1, step 100.3 — appended separately from the contested
// block above per its own "append-only, never reorder" rule.
export { WallTransportSchema, type WallTransport } from './settings'

// Plan 93 (M58 — command console and bulk operations), step 93.1. Moved out
// of `packages/studio/src/components/terminal/TerminalPane.tsx` verbatim
// (F24, §3.14) so Studio and, later, the core evaluate the identical list —
// see the doc comment on `high-consequence.ts` for what this guard is and is
// not.
export { HIGH_CONSEQUENCE_PATTERNS, isHighConsequence } from './command/high-consequence'

// Plan 94 (M59 — the action recorder), step 94.1. The recording document
// (§4.1) — "a recording is source, and a script is build output" (§3.1) —
// plus `hitTest` (§4.6), the candidate-proposal primitive the recorder's
// anchor dump is hit-tested against before `proposeSelectors` (F13) ranks
// candidates. Appended here, as its own statement, rather than folded into
// any block above — this file is contested (several concurrent workers are
// also appending today) and the rule is append-only, never reorder or tidy
// an existing block.
export {
  RecordingTargetSchema,
  RecordingCandidateSchema,
  RecordingStepSchema,
  RecordingDocSchema,
  type RecordingTarget,
  type RecordingCandidate,
  type RecordingStep,
  type RecordingStepKind,
  type RecordingDoc,
} from './recording'
export { hitTest } from './selector-match'

// Plan 94 (M59 — the action recorder), step 94.2. The four `DeviceCall` arg
// shapes the replay needs (§4.4, F6, F7) — `gesture`/`longPress`/`tapNorm`/
// `swipeNorm` — already folded into `DEVICE_CALL_ARGS` (exported above) and
// into `@enkaku/session`'s `DeviceCallSchema`; exported here individually too,
// the same way every other single-verb arg schema above already is. Appended
// here, as its own statement, rather than folded into the `./capability`
// block above — this file is contested (several concurrent workers are also
// appending today) and the rule is append-only, never reorder or tidy an
// existing block.
export { GestureCallArgsSchema, LongPressArgsSchema, TapNormArgsSchema, SwipeNormArgsSchema } from './capability'

// Plan 94 (M59 — the action recorder), step 94.3. The recorder's live WS
// surface (§4.9) — `recording.start`/`.stop`/`.cancel` (client→server) and
// `recording.state`/`recording.step` (server→client). Appended here, as its
// own statement, rather than folded into any block above — this file is
// contested (several concurrent workers are also appending today) and the
// rule is append-only, never reorder or tidy an existing block.
export {
  RecordingStartMessage,
  RecordingStopMessage,
  RecordingCancelMessage,
  RecordingStoppedReasonSchema,
  RecordingStateMessage,
  RecordingStepKindWireSchema,
  RecordingStepMessage,
  type RecordingStoppedReason,
} from './messages/recording'
// `FarmSettingsSchema.recording` (`./settings.ts`) — its own separate
// statement, matching the precedent plan 92's `VideoNumbers`/`ControlPreset`/
// `WallPreset` block above already set for adding a settings-derived type
// after `FarmSettingsSchema` was already exported wholesale, without
// reopening the existing `from './settings'` block further up this
// contested file.
export type { RecordingSettings } from './settings'

// Plan 93 (M58 — command console and bulk operations), step 93.4. The
// shared target/status/member/output shapes (§4.3) — the reconciliation
// `command-console/store.ts` (step 93.2) and `command-console/runner.ts`
// (step 93.3) each flagged in their own doc comments: both declared an
// identical shape LOCALLY because this directory was off limits to them at
// the time, on the explicit understanding that this step builds the real
// copy and both files import from it afterward. Appended here, as its own
// statement, rather than folded into any block above — this file is
// contested and the rule is append-only, never reorder or tidy an existing
// block.
export {
  CommandTargetSchema,
  COMMAND_MEMBER_STATUSES,
  CommandMemberStatusSchema,
  COMMAND_RUN_STATUSES,
  CommandRunStatusSchema,
  CommandMemberSchema,
  CommandOutputSchema,
  CommandCountsSchema,
  type CommandTarget,
  type CommandMemberStatus,
  type CommandRunStatus,
  type CommandMember,
  type CommandOutput,
  type CommandCounts,
} from './command/target'

// Plan 93 (M58), step 93.4, §3.17, §4.3. The command console's WS surface —
// re-exported here (the five server→client events and two client→server
// subscribe/unsubscribe messages are already imported, separately, for use
// in `ServerMessageSchema`/`ClientMessageSchema` above; this is the SAME
// split `messages/recording`'s own two blocks already use).
export {
  CommandStartedMessage,
  CommandProgressMessage,
  CommandOutputMessage,
  CommandStageMessage,
  CommandFinishedMessage,
  CommandSubscribeMessage,
  CommandUnsubscribeMessage,
} from './messages/command'

// Plan 93 (M58), step 93.4, §4.4. `packages/core/src/api/command-runs.ts`'s
// response envelopes.
export {
  CommandRunSummarySchema,
  CommandRunDetailSchema,
  CommandRunCreateResponseSchema,
  CommandRunDetailResponseSchema,
  CommandRunActionResponseSchema,
  CommandRunDeleteResponseSchema,
  CommandRunsPageResponseSchema,
  type CommandRunSummary,
  type CommandRunDetail,
} from './api/command-runs'

// Plan 97 (M62 — the script output contract), step 97.2, §3.3, §3.6, §4.1.
// `RESULT_STATUSES`/`ResultStatusSchema` — the five states a job's result
// settles into — plus `RESULT_LIMITS` (the same 64 KiB `kv.maxValueBytes`
// already uses) and `summaryFields`/`buildResultSummary`, the pure pair that
// turns a result schema's `summary: true` fields plus a job's actual value
// into one operator-legible line. Appended here, as its own statement,
// rather than folded into any block above — this file is contested (several
// concurrent workers are also appending today) and the rule is append-only,
// never reorder or tidy an existing block.
export {
  RESULT_STATUSES,
  ResultStatusSchema,
  RESULT_LIMITS,
  summaryFields,
  buildResultSummary,
  type ResultStatus,
  type SummaryField,
} from './schema/result'

// Plan 97 (M62), step 97.3, §3.4, §3.8, §4.3. `ResultOutcomeSchema` — the
// child's own verdict on one result (status, measured bytes, issues), the
// SAME shape carried across every boundary that touches it: the child⇄parent
// `result` IPC message, the node⇄control-plane tunnel, `AttemptOutcome` /
// `JobRunner.execute()` in `@enkaku/session`, and `result-store.ts`'s
// `recordResult` in `@enkaku/core`. Appended here, as its own statement,
// rather than folded into the 97.2 block above it — this file is contested
// and the rule is append-only, never reorder or tidy an existing block.
export { ResultOutcomeSchema, type ResultOutcome } from './schema/result'

// Plan 97 (M62), step 97.3, §3.3, §4.3, §4.6. `ParamIssueSchema` — the Zod
// counterpart of the `ParamIssue` interface already exported above (plan 95),
// needed wherever an issue list itself crosses a Zod boundary (the `result`
// message's `outcome.issues`, `jobs.result_issues`).
export { ParamIssueSchema } from './schema/validate'

// Plan 97 (M62), step 97.3, §3.8, V3. `DANGEROUS_FIELD_NAMES` — the same
// prototype-hijack field-name set `checkDeclaredSchema` already refuses at
// publish for a SCHEMA's own field names (plan 95), reused unchanged by
// `@enkaku/session`'s `child-entry.ts` to walk a result VALUE for the
// identical hazard one level down.
export { DANGEROUS_FIELD_NAMES } from './schema/limits'

// Plan 93 (M58 — command console and bulk operations), step 93.6, §3.10,
// §4.2, §4.4. Saved commands — the wire shape of a `saved_commands` row
// plus `packages/core/src/api/saved-commands.ts`'s CRUD response envelopes.
// Kept in `command/saved.ts` (this step's own directory) rather than beside
// `api/command-runs.ts` in `./api/`, which step 93.6 does not own. Appended
// here, as its own statement, rather than folded into the step 93.4 block
// above — this file is contested (several concurrent workers are also
// appending today) and the rule is append-only, never reorder or tidy an
// existing block.
export {
  SavedCommandSchema,
  SavedCommandListResponseSchema,
  SavedCommandResponseSchema,
  SavedCommandDeleteResponseSchema,
  type SavedCommand,
} from './command/saved'

// Plan 97 (M62 — the script output contract), step 97.7, §3.7, §4.6.
// `JobProgressEventMessage` — the server→client half of `ctx.progress()`
// (§3.7 in full: coalesced in the child, size-checked and warned-once-per-job
// in the core, never a DB write anywhere on the path). Appended here, as its
// own statement, rather than folded into the step 97.2/97.3 blocks above —
// this file is contested and the rule is append-only, never reorder or tidy
// an existing block.
export { JobProgressEventMessage } from './messages/job'

// Plan 93 (M58 — command console and bulk operations), step 93.9, §4.6.
// `PushJobParamsSchema`/`PullJobParamsSchema` — the `internal:push`/
// `internal:pull` batch executor param shapes, near-copies of
// `InstallJobParamsSchema` (exported from the same `./messages/transfer`
// module above, but appended here rather than folded into that block —
// this file is contested and the rule is append-only, never reorder or
// tidy an existing block).
export { PushJobParamsSchema, PullJobParamsSchema, type PushJobParams, type PullJobParams } from './messages/transfer'

// Plan 109 step 109.8: the shapes `GET /api/plugins/:name/runtime/logs` serves.
export { PluginLogLineSchema, PluginLogPageSchema, type PluginLogLine, type PluginLogPage } from './messages/plugin'

// Plan 89 (M54 — device identity and physical labelling), step 89.6. The
// labelling settings block (`DeviceLabelModeSchema`/`DeviceLabellingSchema`,
// §4.3) — added to `./settings.ts` alongside `DeviceInstrumentationSchema`,
// the closest existing precedent (F26), and appended here rather than
// reopening the main `from './settings'` block further up this contested
// file, matching the `RecordingSettings`/`VideoNumbers` precedent above.
export { DeviceLabelModeSchema, DeviceLabellingSchema, type DeviceLabelMode, type DeviceLabelling } from './settings'
// `DeviceLabelStateSchema` (§4.3, §4.6) lives in its own new file,
// `./api/device-label.ts`, rather than in the already-contested
// `./api/devices.ts` (owned by a concurrent worker for step 89.2's
// device-shape changes) — see that file's own doc comment.
export { DeviceLabelStateSchema, DEFAULT_DEVICE_LABEL_STATE, type DeviceLabelState } from './api/device-label'
// Step 89.4/89.9's own gap: the labelling HTTP endpoints' body/response
// shapes, added once `./api/devices.ts` was free again — see that file's
// own comment on why they live beside `DeviceLabelStateSchema` rather than
// in the already-contested `./api/devices.ts`.
export {
  DeviceLabelClearBodySchema,
  DeviceLabelsApplyBodySchema,
  DeviceLabelsApplyResultSchema,
  DeviceLabelsApplyResponseSchema,
  type DeviceLabelsApplyResult,
} from './api/device-label'

// Plan 107 (M72 — long-running operations), step 107.2, §3.1, §3.4, §4.
// `GET /api/transfers` — the in-memory transfer registry's response shape
// (see `./api/transfers.ts`'s own doc comment for the full reasoning: what
// an in-memory registry loses on restart, and why it is shaped to survive a
// later swap to a durable row unchanged). Its own new file, not folded into
// `./api/transfer.ts` (singular — `InstallResponseSchema`/`PushResponseSchema`/
// `PullResponseSchema`, the per-call responses) or `./messages/transfer.ts`
// (the WS wire messages) above, because this is a THIRD, distinct thing: a
// list snapshot, never a per-call response or a WS message.
export {
  TransferStateSchema,
  TransferOriginSchema,
  TransferRecordSchema,
  TransfersResponseSchema,
  type TransferState,
  type TransferOrigin,
  type TransferRecord,
} from './api/transfers'

// Plan 108 (M73 — plugin surface), step 108.1, §4.2.
// The declarative screen a plugin contributes to Studio: the LAYOUT
// vocabulary (nav entries, views, tables, actions) plus the closed,
// non-Turing `Binding` language an action reads a row or a form value with
// (§3.4). Its own new file, `./plugin-surface.ts`, rather than an addition
// to `./schema/vocabulary.ts` — that module is the FIELD vocabulary
// (`x-enkaku`, what a value MEANS) and this one names layout, which is a
// different thing with a different review discipline (§3.3). It reuses
// `JsonSchemaNodeSchema` and `ScriptRefSchema` rather than restating
// either, so a plugin's columns and forms go through the one resolver
// Studio already has and a plugin's script references through the one
// reference grammar the farm already resolves.
// Plan 111 (M76 — a plugin's UI is React), step 111.4 adds
// `PLUGIN_UI_API_VERSION` and `ViewSpec.react` here, and removes
// `ViewSpec.frame` (§3.6 — removed, not deprecated).
export {
  SURFACE_LIMITS,
  PLUGIN_UI_API_VERSION,
  ICON_NAMES,
  IconNameSchema,
  SurfaceIdSchema,
  DataSourceSchema,
  BINDING_DEVICE_FIELDS,
  BINDING_ENTRY_FIELDS,
  BindingSchema,
  ActionSpecSchema,
  ViewSpecSchema,
  NavEntrySchema,
  PluginSurfaceSchema,
  validatePluginSurface,
  // Plan 109 step 109.6 — a surface that names a `{ kind: 'handler' }` source
  // needs a service to answer it; verify refuses the pair rather than letting
  // it render as a runtime outage nobody can fix.
  handlerViewsWithoutServiceMessage,
  type IconName,
  type DataSource,
  type BindingDeviceField,
  type BindingEntryField,
  type Binding,
  type ActionSpec,
  type ActionSpecInput,
  type ViewSpec,
  type NavEntry,
  type PluginSurface,
  type PluginSurfaceInput,
  type PluginSurfaceValidation,
  // The props Studio hands a React view (§9 Q2). Types only, no React — see
  // `PluginViewProps`'s own note on why this package is their home and
  // `@enkaku/ui` only re-exports them.
  type PluginViewParams,
  type SetPluginViewParams,
  type PluginViewProps,
} from './plugin-surface'

// Plan 109 (M74 — the plugin runtime), step 109.2. A plugin's SERVICE — the
// long-lived half — and the lifecycle vocabulary the host reports it under.
// `service`, not `runtime`: a plugin MEMBER's `runtime` is plan 98's
// `RuntimeEnvelope` and means something entirely different (plan 109 §9 Q7,
// settled by the owner).
export {
  PLUGIN_SERVICE_ISOLATIONS,
  PLUGIN_SERVICE_MAX_PERMISSIONS,
  PLUGIN_SERVICE_MAX_LISTENERS,
  PLUGIN_SERVICE_MAX_EVENTS,
  PLUGIN_SERVICE_STATUSES,
  PLUGIN_LISTENER_PROTOS,
  PluginServiceDeclarationSchema,
  PluginServiceStatusSchema,
  PluginListenerSchema,
  ReportedListenerSchema,
  PluginEventTypeSchema,
  unsupportedIsolationMessage,
  listenerReachabilityMessage,
  type PluginServiceIsolation,
  type PluginServiceDeclaration,
  type PluginServiceStatus,
  type PluginListener,
  type PluginListenerProto,
  type ReportedListener,
  // Step 109.6 — the three handler families: what a handler is addressed by,
  // who it is told the caller is, and what a WS handler's path looks like.
  PLUGIN_HANDLER_KINDS,
  PLUGIN_HTTP_METHODS,
  PLUGIN_HANDLER_DEFAULT_PERMISSION,
  PLUGIN_REQUEST_HEADER_ALLOWLIST,
  PLUGIN_RESPONSE_HEADER_ALLOWLIST,
  PluginHandlerIdSchema,
  PluginHandlerViewSchema,
  PluginCallerSchema,
  pluginSocketPath,
  parsePluginSocketPath,
  type PluginHandlerKind,
  type PluginHttpMethod,
  type PluginHandlerView,
  type PluginCaller,
  // Step 109.7 — inbound webhooks: the declaration, the address, the signature
  // header, and what the farm reports about a secret it generated (never the
  // secret, and deliberately never a hint of one).
  PLUGIN_SERVICE_MAX_WEBHOOKS,
  PLUGIN_WEBHOOK_MAX_BODY_BYTES,
  PLUGIN_WEBHOOK_DEFAULT_BODY_BYTES,
  PLUGIN_WEBHOOK_DEFAULT_RATE_PER_MIN,
  PLUGIN_WEBHOOK_DEFAULT_TOLERANCE_SEC,
  PLUGIN_WEBHOOK_SIGNATURE_HEADER,
  PluginWebhookSchema,
  PluginWebhookInfoSchema,
  pluginWebhookPath,
  parsePluginWebhookPath,
  duplicateWebhookIdsMessage,
  type PluginWebhook,
  type PluginWebhookInfo,
  // Reset data — the declaration of a plugin's cleanup hook, the authority it
  // borrows for one operator-initiated pass, and the per-item report it
  // answers with.
  PLUGIN_SERVICE_MAX_RESET_PERMISSIONS,
  PLUGIN_RESET_OUTCOMES,
  PLUGIN_RESET_ITEM_KINDS,
  PLUGIN_RESET_MAX_ITEMS,
  PluginServiceResetDataSchema,
  PluginResetItemSchema,
  PluginResetReportSchema,
  type PluginServiceResetData,
  type PluginResetOutcome,
  type PluginResetItemKind,
  type PluginResetItem,
  type PluginResetReport,
} from './plugin-service'

// Plan 128 (M93 — the job trace timeline), step 128.1, §3.3, §4.2.
// `JobTraceEventSchema`/`JobTraceMessage` — one `job_events` row and its live
// tail. Appended as its own statement for the same append-only reason as
// above; `JobTraceMessage` is also registered in `ServerMessageSchema` (last
// entry in that union, same convention).
export { JobTraceEventSchema, JobTraceMessage, type JobTraceEvent } from './messages/job'
