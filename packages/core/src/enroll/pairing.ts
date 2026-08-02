import type { AdbClient } from '@enkaku/adb'
import type { Logger } from '../util/logger'

export interface PairingSession {
  pairingId: string
  host: string
  port: number
  createdAt: number
}

export interface PairingService {
  /** Check host:port is reachable, then mint a pairingId. */
  request(host: string, port: number): Promise<{ pairingId: string }>
  /** `adb pair` plus an optional `adb connect`. */
  submitCode(
    pairingId: string,
    code: string,
    connectPort?: number,
  ): Promise<{ success: boolean; message: string }>
}

/**
 * Wireless ADB pairing for Android 11+ (spec §15.1). `adb pair` is not available
 * as a smartsocket host service → the one place we spawn the adb CLI
 * besides start/kill-server. The binary comes from the Toolchain, never the system PATH.
 */
export function createPairingService(deps: { client: AdbClient; log: Logger }): PairingService {
  const sessions = new Map<string, PairingSession>()

  return {
    async request(host, port) {
      // A short TCP dial: fails fast on a mistyped host or port.
      try {
        const socket = await Promise.race([
          Bun.connect({ hostname: host, port, socket: { data() {} } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ])
        socket.end()
      } catch (err) {
        throw new Error(`could not reach ${host}:${port} — make sure Wireless debugging is on (${String(err)})`)
      }
      const pairingId = crypto.randomUUID()
      sessions.set(pairingId, { pairingId, host, port, createdAt: Date.now() })
      return { pairingId }
    },

    async submitCode(pairingId, code, connectPort) {
      const session = sessions.get(pairingId)
      if (!session) return { success: false, message: 'the pairing session was not found or has expired' }

      const proc = Bun.spawn([deps.client.binaryPath, 'pair', `${session.host}:${session.port}`, code], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => proc.kill(), 20_000)
      const exit = await proc.exited
      clearTimeout(timer)
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const output = `${stdout}${stderr}`.trim()

      if (exit !== 0 || !output.includes('Successfully paired')) {
        deps.log.warn(`adb pair failed: ${output}`)
        // adb's message is passed through verbatim so the wizard can show it.
        return { success: false, message: output || `adb pair exit ${exit}` }
      }
      sessions.delete(pairingId)

      if (connectPort !== undefined) {
        const connectMsg = await deps.client.connectDevice(`${session.host}:${connectPort}`)
        deps.log.info(`adb connect ${session.host}:${connectPort} → ${connectMsg}`)
        const ok = /connected to/i.test(connectMsg)
        return { success: ok, message: `${output}\n${connectMsg}` }
      }
      return { success: true, message: output }
    },
  }
}
