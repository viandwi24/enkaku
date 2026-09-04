import type { DeviceInfo } from '@enkaku/protocol'
import { dotTooltipOf } from '@/components/devices/device-state'

/**
 * README.md:157-160's wording, which is also the Screens card's, so the two
 * dots never disagree (plan 215 §3.2 D13). Rather than a second copy of the
 * same rule, this re-exports plan 214's own `dotTooltipOf` (which already
 * implements exactly this mapping) under the name this plan's file
 * structure names.
 */
export function stateTooltip(d: Pick<DeviceInfo, 'status' | 'activities' | 'lastSeen' | 'quarantineReason'>): string {
  return dotTooltipOf(d as DeviceInfo)
}
