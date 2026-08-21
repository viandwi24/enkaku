import type { PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { browseAndExtract } from './service/browser-probe'
import { extractLanIp } from './service/network-probe'
import { ASSIGNMENT_KEY, readAssignment, writeAssignment } from './shared'

/**
 * `discover-lan-ip` — plan 122 §4.8, step 122.10. Reads this device's own LAN
 * address from the device itself and stores it as `assignment.lanIp` with
 * `lanIpSource: 'probe'` (§3.4 tier 2). Only needed for USB-attached devices,
 * which the core otherwise knows no address for at all — §0.3 item 4's
 * repo-wide search found zero device-IP reads anywhere in this codebase, and
 * this is genuinely new work rather than a wrapper over something existing.
 *
 * **The command, and why.** There is no shell/exec primitive a plugin script
 * can reach (`network-probe.ts`'s own header names the exact search that
 * confirmed it — `DeviceApi` has no `shell`/`exec` verb, and the capability
 * registry has no `device.shell`/`device.exec` a script's `ctx.farm.call`
 * could invoke), so a real `adb shell ip route get 1`/`ip addr show wlan0` is
 * not something this script can run, however much more direct it would be.
 * The alternative the SDK genuinely offers is a browser: WebRTC ICE candidate
 * gathering is the one web-standard mechanism that reveals a device's own
 * LOCAL network address to a page, with no OS-level command at all, and it is
 * what `plugins/networking`'s own `browserleaks.com/webrtc` check already
 * relies on for exactly the same fact (hardware-verified there, on a real
 * moto g06 — see that plugin's `WEBRTC_LABELS`/`readWebrtc`). This script
 * drives the same public page for the same reason: it needs no server of its
 * own, needs no change to this plugin's declared capabilities, and works
 * however Android reaches the internet (WiFi, cellular, or a USB-attached
 * device that also has WiFi enabled for traffic — the identity bridge's own
 * §3.4 case for why `probe` exists at all).
 *
 * **Fails cleanly rather than guessing.** A device can show more than one
 * private-range candidate (a second adapter, a VPN/tunnel interface) — that
 * is reported as `ambiguous`, and nothing is written, rather than picking one
 * and being confidently wrong. See `network-probe.ts`'s `extractLanIp`.
 *
 * Never talks to the router.
 */

const LAN_IP_URL = 'https://browserleaks.com/webrtc'

const params = z.object({})

const result = z.object({
  resolved: z.boolean().describe('Whether a single, unambiguous private-range address was found and written to this device’s assignment (lanIpSource: probe).'),
  lanIp: z.string().nullable().describe('The address written, or null when nothing was written.'),
  reason: z.string().nullable().describe('Set when resolved is false — why nothing was written. Never a guess: a page showing more than one private-range candidate refuses rather than picking one.'),
})

const discoverLanIpScript: PluginMemberScript<typeof params, typeof result> = {
  id: 'discover-lan-ip',
  title: 'Discover LAN IP',
  description:
    'Reads this device’s own LAN address from the device itself and stores it (§3.4 tier 2, §4.8) — needed only for USB-attached devices, which the core otherwise knows no address for at all (§0.3 item 4). Fails cleanly, writing nothing, rather than guessing when the page shows more than one private-range candidate. Never talks to the router.',
  params,
  result,
  timeout: 90_000,

  async run(ctx) {
    const outcome = await browseAndExtract(
      ctx,
      LAN_IP_URL,
      (texts) => {
        const extraction = extractLanIp(texts)
        // Keep polling while the page has produced no candidate at all — this
        // early, `not-found` usually means the WebRTC probe has not answered
        // yet, not that this device genuinely has no LAN address. `found` and
        // `ambiguous` are both real answers worth stopping the poll for.
        return extraction.state === 'not-found' ? null : extraction
      },
      { budgetMs: 45_000 },
    )

    // `extract`'s own return already filters `not-found` down to `null` (see above) — `browseAndExtract`
    // can therefore only ever resolve `outcome` to `found`/`ambiguous` or `null` (budget exhausted).
    if (outcome === null) {
      return { resolved: false, lanIp: null, reason: `no private-range address appeared at ${LAN_IP_URL} within this run's budget` }
    }

    if (outcome.state === 'ambiguous') {
      const reason = `more than one private-range address was found (${outcome.candidates.join(', ')}) — refusing to guess which one is this device's real LAN address`
      ctx.log.warn('mikrotik-routing: discover-lan-ip found more than one candidate', { candidates: outcome.candidates })
      return { resolved: false, lanIp: null, reason }
    }

    const stored = readAssignment(await ctx.storage.device.getRaw(ASSIGNMENT_KEY))
    await ctx.storage.device.set(ASSIGNMENT_KEY, writeAssignment({ ...stored, lanIp: outcome.ip, lanIpSource: 'probe' }))

    return { resolved: true, lanIp: outcome.ip, reason: null }
  },
}

export default discoverLanIpScript
