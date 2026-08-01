// M0 BRIDGE: diganti Toolchain Manager (Plan 02).
// Jangan tambah pembaca ENKAKU_ADB_PATH lain — file ini satu-satunya.
// Signature FINAL; Plan 02 hanya mengganti body (resolve dari
// <dataDir>/tools/<toolId>/active). Driver DILARANG resolve dari system
// PATH (spec §7.8).
import { EnkakuError } from './errors'

export async function resolveToolPath(toolId: 'adb'): Promise<string> {
  if (toolId !== 'adb') {
    throw new EnkakuError('E_TOOL_NOT_FOUND', `tool tidak dikenal: ${toolId}`)
  }
  const path = process.env.ENKAKU_ADB_PATH
  if (!path) {
    throw new EnkakuError(
      'E_TOOL_NOT_FOUND',
      'Set ENKAKU_ADB_PATH ke binary adb (sementara, sampai Toolchain Manager di M1)',
    )
  }
  const exists = await Bun.file(path).exists()
  if (!exists) {
    throw new EnkakuError('E_TOOL_NOT_FOUND', `ENKAKU_ADB_PATH menunjuk file yang tidak ada: ${path}`)
  }
  return path
}
