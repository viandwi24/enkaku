import type { Role } from './service'

/**
 * Matrix ACL (plan 09 §4.4). `admin` boleh semua; `operator` dibatasi pada
 * operasi harian. Server-authoritative — UI hanya menyembunyikan tombol.
 */
export type Permission =
  | 'device.view'
  | 'device.control'
  | 'device.settings'
  | 'device.enroll'
  | 'device.quarantine'
  | 'script.view'
  | 'script.publish'
  | 'script.delete'
  | 'job.view'
  | 'job.run'
  | 'job.cancel.any'
  | 'tool.view'
  | 'tool.manage'
  | 'settings.view'
  | 'settings.manage'
  | 'user.manage'
  | 'audit.view'

const OPERATOR: ReadonlySet<Permission> = new Set<Permission>([
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'script.view',
  'script.publish',
  'job.view',
  'job.run',
  'tool.view',
  'settings.view',
])

export function can(role: Role, permission: Permission): boolean {
  return role === 'admin' ? true : OPERATOR.has(permission)
}

/**
 * Kepemilikan device (spec §12 `ownerId`): device tanpa owner bebas dipakai
 * semua operator; device ber-owner hanya owner + admin.
 * (Kebijakan default — lihat Open questions plan 09.)
 */
export function canUseDevice(user: { id: string; role: Role }, device: { ownerId: string | null }): boolean {
  if (user.role === 'admin') return true
  return device.ownerId === null || device.ownerId === user.id
}
