import type { StoredAssignment } from '../shared'
import { ipToInt, rfc1918BlockContaining } from './cidr'

/**
 * Extracting IPv4 addresses from an on-device browser page's rendered text,
 * and deciding what a fresh `verify-egress` reading means — plan 122 §4.8,
 * step 122.10.
 *
 * **Why a browser page at all, rather than a shell command.** §0.3 item 4's
 * repo-wide search found zero device-IP reads anywhere in this codebase;
 * re-confirmed for this step by reading `packages/sdk/src/types.ts`'s
 * `DeviceApi` in full (no `shell`/`exec` verb exists on `ScriptContext.device`)
 * and `packages/core/src/capability/*.ts`'s whole capability registry (no
 * `device.shell`/`device.exec` capability a plugin script could reach through
 * `ctx.farm` either — `device.shell` exists ONLY as an ACL permission gating
 * the interactive terminal, plan 26, a WS-driven surface no script can call).
 * So there is no typed way for a script to run `ip route get 1` or any other
 * shell command, and inventing a call the SDK does not declare is exactly the
 * fabrication this repo's own conventions forbid. `plugins/networking`
 * already solved the adjacent problem — reading network facts off a real
 * page rendered in Chrome, hardware-verified against a real device — so this
 * module follows that PATTERN (not its code; that pack's package.json
 * declares no `exports`/`main`, so it was never meant to be imported by
 * another package) for the pure, testable half: given a page's own rendered
 * text, find the address that answers the question, or say plainly that none
 * was found. `browser-probe.ts` is the async half that drives the browser.
 */

/** Every distinct, valid dotted-quad IPv4 token anywhere in `text` — validated through `cidr.ts`'s own strict `ipToInt` (rejects leading zeros, out-of-range octets, and non-address punctuation), so a version number or a resource id can never masquerade as an address. */
export function ipv4TokensIn(text: string): string[] {
  const out: string[] = []
  const matches = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []
  for (const candidate of matches) {
    if (ipToInt(candidate) !== null) out.push(candidate)
  }
  return out
}

/** Never a real address on either page this module reads — a browser chrome placeholder or a loopback probe, not a fact about the device's own network. */
const NON_ADDRESSES = new Set(['0.0.0.0', '127.0.0.1'])

/**
 * The first plausible PUBLIC address anywhere in the page's rendered text —
 * `verify-egress`'s vehicle, read off a plain-text IP-echo page. "Plausible"
 * means not RFC1918, not loopback, not `0.0.0.0` — reusing `cidr.ts`'s own
 * `rfc1918BlockContaining` (the same module `local-exception.ts`'s §3.2 check
 * already relies on for the identical "is this address private" question),
 * rather than a second, untested classifier. `null` when nothing on the page
 * qualifies yet — the caller's honest signal to keep polling or, at the
 * deadline, to report a clean failure rather than a guess.
 */
export function extractPublicIp(texts: readonly string[]): string | null {
  for (const text of texts) {
    for (const token of ipv4TokensIn(text)) {
      if (NON_ADDRESSES.has(token)) continue
      if (rfc1918BlockContaining(token) === null) return token
    }
  }
  return null
}

/**
 * `discover-lan-ip`'s reading of a page's rendered text: `found` (exactly one
 * distinct private-range candidate — safe to write), `not-found` (nothing
 * private-range on the page yet — the caller's cue to keep polling, since a
 * WebRTC-style probe fills in after the page itself has painted), or
 * `ambiguous` (more than one distinct candidate — a second network adapter or
 * a VPN/tunnel interface can each produce a private address, and there is no
 * way from the page alone to tell which one is THIS device's real LAN
 * address). `ambiguous` is reported, never guessed past — exactly the
 * "plausible-looking wrong answer" this plugin's whole design (§3.4) exists
 * to avoid.
 */
export type LanIpExtraction = { state: 'found'; ip: string } | { state: 'not-found' } | { state: 'ambiguous'; candidates: string[] }

/** Every distinct PRIVATE (RFC1918) address anywhere in the page's rendered text — `discover-lan-ip`'s vehicle. */
export function extractLanIp(texts: readonly string[]): LanIpExtraction {
  const found = new Set<string>()
  for (const text of texts) {
    for (const token of ipv4TokensIn(text)) {
      if (NON_ADDRESSES.has(token)) continue
      if (rfc1918BlockContaining(token) !== null) found.add(token)
    }
  }
  const candidates = [...found].sort()
  if (candidates.length === 0) return { state: 'not-found' }
  if (candidates.length > 1) return { state: 'ambiguous', candidates }
  return { state: 'found', ip: candidates[0] as string }
}

/** What `verify-egress`'s `matches` field means for one freshly observed public IP, and the assigned path it is being checked against. */
export interface VerifyEgressOutcome {
  expectedPath: string
  matches: boolean | null
}

/**
 * Decides `verify-egress`'s `matches` field for one observed public IP
 * against the device's CURRENT stored assignment (§4.8, §4.9).
 *
 * There is no per-path "known good" public IP anywhere in this plugin's data
 * model: a path is a routing-table name (`via-modem7-p12`), not an address,
 * and an LTE modem's own public IP can rotate on its own. So "expected" can
 * only ever mean "the last public IP THIS SAME assignment observed for
 * itself" — learned empirically, one run at a time, never declared up front.
 * This is the plan's own explicit instruction ("think carefully about what
 * 'expected' means when the plugin has never observed that path's public
 * address before, and make the honest answer... rather than a fabricated
 * pass"), implemented as a real, testable rule rather than left to the
 * script's own `run()` to reason about ad hoc:
 *
 * - No path assigned at all (`pathId === ''`) — nothing to verify against: `null`.
 * - A path IS assigned but this is the FIRST observation for it
 *   (`lastPublicIp === ''`) — again `null`, the honest "unknown" this plan's
 *   own task calls for.
 * - Otherwise, a real comparison against the stored baseline: `true` on a
 *   match, `false` on a genuine mismatch — the whole point of this check.
 */
export function decideVerifyOutcome(stored: StoredAssignment, observedPublicIp: string): VerifyEgressOutcome {
  const expectedPath = stored.pathId
  if (expectedPath === '' || !stored.lastPublicIp) {
    return { expectedPath, matches: null }
  }
  return { expectedPath, matches: stored.lastPublicIp === observedPublicIp }
}
