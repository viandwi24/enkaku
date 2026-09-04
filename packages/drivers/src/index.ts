export { AdbUsbTransport, AdbTcpTransport, type AdbTransportOpts } from './transport/adb-transport'
export { ScreencapLoop, type ScreencapLoopConfig } from './display/screencap-loop'
export { isPng, parsePngSize } from './display/png'
export { AdbInput } from './input/adb-input'
export { withAdbKeyFallback } from './input/adb-key-fallback'
export { buildGesturePath, type GesturePathOpts } from './input/gesture'
export { escapeInputText, InputTextError } from './input/escape'
export { engineDescriptors } from './descriptors'
export { UiautomatorDumpInspector, InspectorError } from './inspector/uiautomator-dump'
export { parseUiDump, parseBounds } from './inspector/xml-parser'
export {
  UiServerInspector,
  supportsElementActions,
  createUiServerLauncher,
  isImplausibleMatch,
  IMPLAUSIBLE_AREA_RATIO,
  toUiSelector,
  UI_SERVER_PACKAGE,
  UI_SERVER_TEST_PACKAGE,
  UI_SERVER_DEVICE_PORT,
  UI_SERVER_STUB_CLASS,
  verifyDeviceArtifact,
  type InspectorElementActions,
  type UiServerInspectorOptions,
  type UiServerLauncher,
  type UiServerLauncherDeps,
  type UiServerExpectedArtifact,
  type UiServerArtifactMismatch,
  type UiServerStatus,
  type DeviceArtifactExpectation,
  type VerifyResult,
  type UiServerStartHooks,
  ConfiguratorInfoSchema,
  DEFAULT_CONFIGURATOR,
  type ConfiguratorInfo,
  createUiServerLifecycle,
  classifyInstrumentationLine,
  createInstrumentationParser,
  INSTRUMENTATION_FATAL_PATTERNS,
  INSTRUMENTATION_START_SILENCE_MS,
  type UiServerLifecycle,
  type UiServerLifecycleOptions,
  type UiServerLifecycleState,
} from './inspector/ui-server/index'
export { ScrcpyDisplay } from './display/scrcpy'
export { ScrcpySdkInput, ScrcpyUhidInput, type ScrcpyInputDeps } from './input/scrcpy-input'
export {
  selectInputEngine,
  type InputModePreference,
  type ResolvedInputEngine,
  type InputSelectionResult,
} from './input/select'
export { AppiumInspector, type AppiumInspectorOptions } from './inspector/appium'
export {
  grantRuntimePermissions,
  installWithGrantFallback,
  isGrantAllPermissionsRejection,
  readRuntimePermissions,
  type GrantExec,
  type GrantRuntimePermissionsDeps,
  type InstallWithGrantFallbackDeps,
} from './install/grant-fallback'
export {
  GuestAgentClientError,
  createGuestAgentClient,
  createGuestAgentLauncher,
  createGuestAgentWatch,
  createVpnHelperRoute,
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_RUNTIME_PERMISSIONS,
  GUEST_AGENT_SOCKET,
  GUEST_AGENT_UI_TREE_SERVICE,
  GUEST_AGENT_REPAIRABLE_ERROR_CODES,
  type CreateVpnHelperRouteOptions,
  type GuestAgentClient,
  type GuestAgentClientErrorCode,
  type GuestAgentClientFactory,
  type GuestAgentClientOptions,
  type GuestAgentConnect,
  type GuestAgentLauncher,
  type GuestAgentLauncherDeps,
  type GuestAgentArtifactMismatch,
  type GuestAgentVpnConsent,
  type GuestAgentAccessibility,
  type GuestAgentSocketHandle,
  type GuestAgentSocketHandlers,
  type GuestAgentWatch,
  type GuestAgentWatchOptions,
  type NetworkRoute,
} from './network/guest-agent/index'
export {
  HTTP_PROXY_EXCLUSION_LIST_KEY,
  HTTP_PROXY_HOST_KEY,
  HTTP_PROXY_KEY,
  HTTP_PROXY_PORT_KEY,
  HTTP_PROXY_RESET_VALUE,
  HttpProxyError,
  REVERSE_PROXY_DEVICE_HOST,
  createHttpProxyRoute,
  createReverseProxyRoute,
  httpProxyExclusionList,
  httpProxyValue,
  readHttpProxySettings,
  reverseProxyValue,
  type CapturedHttpProxySettings,
  type CreateHttpProxyRouteOptions,
  type CreateReverseProxyRouteOptions,
  type HttpProxyCaptureStore,
  type HttpProxyErrorCode,
  type HttpProxySettings,
  type ReverseAllocation,
  type ReverseAllocationStore,
  type ReverseBinding,
  type ReversePort,
} from './network/adb-proxy/index'
export {
  createMockLocationDriver,
  type GuestAgentClientRunner,
  type MockLocationDriver,
} from './identity/mock-location'
