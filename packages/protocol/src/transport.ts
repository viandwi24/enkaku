/**
 * Interface Transport (spec §7) — kontrak tipe untuk lapisan "cara nyambung".
 * M0 hanya mendeklarasikan; implementasi engine pluggable mulai Plan 03
 * (packages/drivers). `serial` = alamat transport (bisa berubah!),
 * `stableId` = identitas device stabil (spec §7.5).
 */
export interface Transport {
  id: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  serial: string
  stableId: string
  exec(cmd: string): Promise<string>
}
