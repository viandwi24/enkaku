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
export { ScrcpyAoaInput } from './input/scrcpy-aoa'
export {
  GuestAgentClientError,
  createGuestAgentClient,
  createGuestAgentLauncher,
  createVpnHelperRoute,
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_SOCKET,
  type CreateVpnHelperRouteOptions,
  type GuestAgentClient,
  type GuestAgentClientErrorCode,
  type GuestAgentClientFactory,
  type GuestAgentClientOptions,
  type GuestAgentConnect,
  type GuestAgentLauncher,
  type GuestAgentLauncherDeps,
  type GuestAgentSocketHandle,
  type GuestAgentSocketHandlers,
  type NetworkRoute,
} from './network/guest-agent/index'
export {
  createMockLocationDriver,
  type GuestAgentClientRunner,
  type MockLocationDriver,
} from './identity/mock-location'
