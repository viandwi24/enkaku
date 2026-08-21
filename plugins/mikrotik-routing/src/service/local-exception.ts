import { buildLocalExceptionFixCommands } from '../shared'
import type { CoreAddressResult } from './core-address'
import { RFC1918_BLOCKS, ipToInt, rfc1918BlockContaining, smallestCoveringCidr, specContains, specCoversBlock } from './cidr'
import { parseMarker } from './marker'
import type { RouterRule } from './schemas'

/**
 * The corrected local-exception check — plan 122 §5 step 122.12, found
 * against the owner's own live router (2026-08-21). §3.2 calls this "the
 * most important paragraph in this plan": without a rule that lets a
 * device's own traffic back to the controller skip the modem tables, an
 * apply that steers that device loses ADB to it. The ORIGINAL stage-1 check
 * (`router-driver.ts`'s old `doctor()`) matched the rule by an exact comment
 * string, which is why it reported "MISSING" on the owner's router while a
 * real (if incomplete) exception sat at the top of the rule list.
 *
 * ## The four defects, and how this module answers each
 *
 * - **(A) comment text.** This module never reads `comment` to decide
 *   whether a rule protects anything — only `action`/`table`/`disabled`/
 *   `inactive`/`src-address`/`dst-address`, i.e. what the rule actually DOES.
 * - **(B) existence vs. coverage — the dangerous one.** A rule passing (A)'s
 *   fix alone is not enough: it has to be checked per DEVICE, because a rule
 *   can be a structurally perfect local exception and still protect none of
 *   the devices this plugin is about to route (exactly the owner's own
 *   router: `src-address=192.168.50.0/24` protects the SERVER, not their
 *   `192.168.10.x` farm). `classifyLocalException` below never reports `ok`
 *   unless every device it was given is individually covered.
 * - **(C) position.** Rules evaluate top-down and REST cannot reorder (§3.2,
 *   §2). A rule can satisfy (A) and (B) and still be inert if a device's own
 *   managed rule sits ABOVE it. This is checked per device: a candidate rule
 *   protects a device only if its own index precedes the FIRST managed rule
 *   (`marker.ts`'s `parseMarker`, `kind: 'ok'`) whose `endpointKey` is that
 *   device's address. `RouterRuleSchema` is `.passthrough()` and `listRules`
 *   returns the array in the router's own order (§4.1's evidence: `GET`
 *   returns rules in evaluation order, matching RouterOS's own `.nextid`
 *   chain) — so array index IS evaluation order, and nothing here needs to
 *   walk `.nextid` itself to get that.
 * - **(D) `disabled`/`inactive`.** Both are read straight off `RouterRule`
 *   (already parsed, `boolish`-defaulted in `schemas.ts`) and a rule failing
 *   either is never a candidate, full stop.
 *
 * ## Why this needs `CoreAddressResult` from a different module
 *
 * Checking a candidate's `dst-address` needs to know the address the CORE
 * itself is reached at — not templated, derived (`core-address.ts`, fix 2).
 * That derivation is real I/O (a TCP connect); this module stays pure by
 * taking the ALREADY-derived result as a plain value, the same seam
 * `identity-bridge.ts` draws between "resolve a LAN address" (I/O, a later
 * step) and "use one" (this file, pure).
 */

/** One device this plugin can currently check coverage for — already resolved to a LAN address by the identity bridge (`identity-bridge.ts`, tier 1/2/3, §3.4). A device with no derivable address (`needs-address`) is not something this check can evaluate at all, and callers must filter those out before calling in — there is no address to test `src-address` against. */
export interface ProtectedDevice {
  id: string
  label: string
  address: string
}

export type LocalExceptionStatus = 'missing' | 'partial' | 'ok'

export interface LocalExceptionReport {
  status: LocalExceptionStatus
  /** Human-readable, and different per status (§5 step 122.12 fix 3) — never the same sentence with a badge colour doing all the work. */
  message: string
  /** Populated only when `status === 'partial'` — every device the exception rule does not (yet) protect, so the Settings tab can name them rather than say "some devices." */
  uncoveredDevices: readonly ProtectedDevice[]
  /** Derived from what this plugin actually knows (device addresses, the observed core address) — never a hardcoded subnet (§5 step 122.12 fix 4). Always populated, even when `status === 'ok'`, so a caller never has to branch on whether to show it. */
  suggestedFixCommands: readonly string[]
  /** Echoed through so the Settings tab can say which path derived the core's own address, and why, when it fell back (§5 step 122.12 fix 2). */
  coreAddress: CoreAddressResult
}

/** `action`/`table`/`disabled`/`inactive` alone — defects (A) and (D). Does not yet check address coverage; that is per-device (B). */
function isCandidateShape(rule: RouterRule): boolean {
  return rule.action === 'lookup' && rule.table === 'main' && !rule.disabled && !rule.inactive
}

/** Whether `rule`'s `dst-address` actually covers the core's own observed (or, on fallback, assumed-unknown) address — the rest of (B), on the DESTINATION side. */
function dstCoversCore(rule: RouterRule, coreAddress: CoreAddressResult): boolean {
  const dst = rule['dst-address']
  if (dst === undefined) return false
  if (coreAddress.kind === 'derived') {
    const coreInt = ipToInt(coreAddress.address)
    if (coreInt === null) return false
    return specContains(dst, coreInt)
  }
  // Fallback: the core's own address could not be observed, so this cannot
  // check ONE address — it requires the rule to cover every RFC1918 block,
  // since any of them might be where the core actually lives (fix 2's own
  // "say which fallback was used" — the caller reads `coreAddress.kind`).
  return RFC1918_BLOCKS.every((block) => specCoversBlock(dst, block))
}

/** The index of the FIRST managed rule (this plugin's own marker, `marker.ts`) whose `endpointKey` is `device.address` — what a candidate rule's position is checked against for (C). `null` when no such rule exists yet (nothing to be below). */
function firstManagedRuleIndexFor(rules: readonly RouterRule[], device: ProtectedDevice): number | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (rule === undefined) continue
    const parsed = parseMarker(rule.comment)
    if (parsed.kind === 'ok' && parsed.endpointKey === device.address) return i
  }
  return null
}

/** Whether ANY correctly-positioned candidate rule protects `device`'s own traffic to the core — (B)'s src-side and (C) combined. */
function deviceIsCovered(rules: readonly RouterRule[], device: ProtectedDevice, coreAddress: CoreAddressResult, candidateIndexes: readonly number[]): boolean {
  const deviceInt = ipToInt(device.address)
  if (deviceInt === null) return false
  const managedIndex = firstManagedRuleIndexFor(rules, device)

  for (const i of candidateIndexes) {
    if (managedIndex !== null && i >= managedIndex) continue // (C): at or below the device's own managed rule — inert for this device
    const rule = rules[i]
    if (rule === undefined) continue
    const src = rule['src-address']
    if (src === undefined) continue
    if (specContains(src, deviceInt)) return true
  }
  return false
}

function buildSuggestedFixCommands(devices: readonly ProtectedDevice[], coreAddress: CoreAddressResult): readonly string[] {
  const srcAddress = smallestCoveringCidr(devices.map((d) => d.address)) ?? '<farm-subnet>'
  if (coreAddress.kind === 'derived') {
    const block = rfc1918BlockContaining(coreAddress.address)
    return buildLocalExceptionFixCommands(srcAddress, [block ?? `${coreAddress.address}/32`])
  }
  return buildLocalExceptionFixCommands(srcAddress, RFC1918_BLOCKS)
}

function describeUncovered(devices: readonly ProtectedDevice[]): string {
  return devices.map((d) => d.label).join(', ')
}

/**
 * Classifies §3.2's precondition against the router's actual rules and the
 * devices this plugin can currently check — behaviour-based, per device,
 * position-aware, never a comment-text match (fixes A/B/C/D together).
 *
 * `devices` should already be filtered to ones with a known address
 * (`identity-bridge.ts`'s `state: 'resolved'` — there is no `src-address` to
 * test coverage against for a device this plugin cannot yet place).
 */
export function classifyLocalException(rules: readonly RouterRule[], devices: readonly ProtectedDevice[], coreAddress: CoreAddressResult): LocalExceptionReport {
  const suggestedFixCommands = buildSuggestedFixCommands(devices, coreAddress)

  const candidateIndexes: number[] = []
  rules.forEach((rule, i) => {
    if (isCandidateShape(rule) && dstCoversCore(rule, coreAddress)) candidateIndexes.push(i)
  })

  if (candidateIndexes.length === 0) {
    return {
      status: 'missing',
      message:
        'No rule on the router protects any device\'s traffic back to the controller (§3.2) — every apply is refused until one exists. A qualifying rule must be enabled and active, action "lookup" on table "main", and its dst-address must cover the controller\'s own address.',
      uncoveredDevices: devices,
      suggestedFixCommands,
      coreAddress,
    }
  }

  const uncoveredDevices = devices.filter((device) => !deviceIsCovered(rules, device, coreAddress, candidateIndexes))

  if (uncoveredDevices.length > 0) {
    return {
      status: 'partial',
      message: `A candidate local-exception rule exists, but it does not protect every device: ${describeUncovered(uncoveredDevices)} would lose ADB the moment they are routed (§3.2). This is refused, not merely warned about, because a rule that looks safe and is not is worse than one that is plainly missing.`,
      uncoveredDevices,
      suggestedFixCommands,
      coreAddress,
    }
  }

  return {
    status: 'ok',
    message: 'Every device this plugin can currently check is protected by a rule positioned above where a device rule would apply (§3.2).',
    uncoveredDevices: [],
    suggestedFixCommands,
    coreAddress,
  }
}
