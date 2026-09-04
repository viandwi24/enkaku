export {
  GUEST_AGENT_REPAIRABLE_ERROR_CODES,
  GuestAgentClientError,
  createGuestAgentClient,
  type GuestAgentClient,
  type GuestAgentClientErrorCode,
  type GuestAgentClientOptions,
  type GuestAgentConnect,
  type GuestAgentSocketHandle,
  type GuestAgentSocketHandlers,
} from './client'

export {
  createVpnHelperRoute,
  type CreateVpnHelperRouteOptions,
  type GuestAgentClientFactory,
  type NetworkRoute,
} from './vpn-helper'

export {
  GUEST_AGENT_PACKAGE,
  GUEST_AGENT_RUNTIME_PERMISSIONS,
  GUEST_AGENT_SOCKET,
  GUEST_AGENT_UI_TREE_SERVICE,
  createGuestAgentLauncher,
  type GuestAgentLauncher,
  type GuestAgentLauncherDeps,
  type GuestAgentArtifactMismatch,
  type GuestAgentVpnConsent,
  type GuestAgentAccessibility,
} from './launcher'

export {
  createGuestAgentWatch,
  type GuestAgentWatch,
  type GuestAgentWatchOptions,
} from './ui-watch'
