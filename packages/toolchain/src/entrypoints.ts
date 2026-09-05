import { ToolchainError } from './errors'

/**
 * Path relatif binary per tool per platform — hardcoded (bukan di manifest)
 * so the spec §7.3 schema stays exact (plan 02 §4.4).
 */
export function entrypointRelPath(toolId: string, platform: string): string {
  switch (toolId) {
    case 'adb':
      return platform.startsWith('win32') ? 'platform-tools/adb.exe' : 'platform-tools/adb'
    case 'scrcpy-server':
      return 'scrcpy-server.jar'
    case 'ui-server':
      return 'ui-server.apk'
    case 'ui-server-test':
      return 'ui-server-test.apk'
    case 'guest-agent':
      return 'guest-agent.apk'
    /**
     * The archive unpacks to a single `cmdline-tools/` directory, so the
     * binary sits one level deeper than the tool directory — the same shape
     * `adb` has inside `platform-tools/`.
     *
     * `sdkmanager` and not `avdmanager`, though the pair always ship
     * together: `sdkmanager` is the one that makes the rest installable, so
     * it is the one whose absence means this tool is not usable.
     */
    case 'cmdline-tools':
      return platform.startsWith('win32') ? 'cmdline-tools/bin/sdkmanager.bat' : 'cmdline-tools/bin/sdkmanager'
    default:
      throw new ToolchainError('E_TOOL_UNKNOWN_ENTRYPOINT', `unknown entrypoint for tool: ${toolId}`)
  }
}
