import type { AdbClient } from '@enkaku/adb'
import type { Logger } from '../util/logger'

export interface PairingSession {
  pairingId: string
  host: string
  port: number
  createdAt: number
}

export interface PairingService {
  /** Validasi host:port reachable → buat pairingId. */
  request(host: string, port: number): Promise<{ pairingId: string }>
  /** `adb pair` + opsional `adb connect`. */
  submitCode(
    pairingId: string,
    code: string,
    connectPort?: number,
  ): Promise<{ success: boolean; message: string }>
}

/**
 * Pairing wireless ADB Android 11+ (spec §15.1). `adb pair` tidak tersedia
 * sebagai host service smartsocket → satu-satunya tempat kita spawn adb CLI
 * selain start/kill-server. Binary dari Toolchain (bukan PATH sistem).
 */
export function createPairingService(deps: { client: AdbClient; log: Logger }): PairingService {
  const sessions = new Map<string, PairingSession>()

  return {
    async request(host, port) {
      // Dial TCP singkat: gagal cepat kalau host/port salah ketik.
      try {
        const socket = await Promise.race([
          Bun.connect({ hostname: host, port, socket: { data() {} } }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ])
        socket.end()
      } catch (err) {
        throw new Error(`tidak bisa menghubungi ${host}:${port} — pastikan Wireless debugging aktif (${String(err)})`)
      }
      const pairingId = crypto.randomUUID()
      sessions.set(pairingId, { pairingId, host, port, createdAt: Date.now() })
      return { pairingId }
    },

    async submitCode(pairingId, code, connectPort) {
      const session = sessions.get(pairingId)
      if (!session) return { success: false, message: 'sesi pairing tidak ditemukan / kedaluwarsa' }

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
        deps.log.warn(`adb pair gagal: ${output}`)
        // Pesan adb diteruskan apa adanya supaya wizard bisa menampilkannya.
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
