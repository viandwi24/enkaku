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
    default:
      throw new ToolchainError('E_TOOL_UNKNOWN_ENTRYPOINT', `unknown entrypoint for tool: ${toolId}`)
  }
}
