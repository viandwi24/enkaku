import type { PluginMemberScript } from '@enkaku/sdk'
import { z } from 'zod'
import { browseAndExtract } from './service/browser-probe'
import { decideVerifyOutcome, extractPublicIp } from './service/network-probe'
import { ASSIGNMENT_KEY, readAssignment, writeAssignment } from './shared'

/**
 * `verify-egress` — plan 122 §4.8, step 122.10. Runs on the device under a
 * lease. Reads the public IP this device is actually egressing through, from
 * the device's own side, and compares it with the last public IP THIS SAME
 * assignment observed — see `network-probe.ts`'s `decideVerifyOutcome` for
 * why "expected" has to mean that rather than a declared-up-front value (no
 * per-path public IP exists anywhere in this plugin's data model, and an LTE
 * modem's own address can rotate on its own). Designed to be scheduled
 * fleet-wide (`job.run`, already declared in `src/index.ts`'s manifest) — the
 * only check in this plugin that can catch a stale-IP mis-steer from the
 * device's own side (§3.4).
 *
 * A plain-text IP-echo page (`api.ipify.org`) rather than a full diagnostic
 * site: the whole page IS the answer, so there is no label to match and
 * nothing that asks for a device permission — see `browser-probe.ts`/
 * `network-probe.ts` for the mechanism and its honesty limits.
 *
 * Never talks to the router. This is a read from the device, compared and
 * recorded — the router side of "is this device actually where it should
 * be" is `apply.ts`'s job, not this script's.
 */

const PUBLIC_IP_URL = 'https://api.ipify.org'

const params = z.object({})

const result = z.object({
  publicIp: z.string().describe('The public IP this device observed for its own outbound traffic, read from a real page loaded in Chrome (§4.8) — never assumed from the router side.'),
  expectedPath: z
    .string()
    .describe("This device's own assigned path (§4.9 assignment.pathId) at the moment this check ran — '' when no path is assigned."),
  matches: z
    .boolean()
    .nullable()
    .describe(
      'true: the observed public IP matches the last one THIS SAME assignment observed. false: it differs — a real mismatch, the whole point of this check. null: nothing to compare against yet (no path assigned, or this is the first observation for this assignment) — never a fabricated pass.',
    ),
})

const verifyEgressScript: PluginMemberScript<typeof params, typeof result> = {
  id: 'verify-egress',
  title: 'Verify egress',
  description:
    'Reads the public IP this device is actually egressing through, from the device’s own side, and compares it against the last public IP this same assignment observed (§4.8). Designed to be scheduled fleet-wide — the only check that can catch a stale-IP mis-steer (§3.4). Never talks to the router.',
  params,
  result,
  // A budget for the browser probe (45s) plus launch/settle/dismiss headroom.
  timeout: 90_000,

  async run(ctx) {
    const publicIp = await browseAndExtract(ctx, PUBLIC_IP_URL, extractPublicIp, { budgetMs: 45_000 })
    if (publicIp === null) {
      throw Object.assign(new Error(`could not read a public IP address from ${PUBLIC_IP_URL} within this run's budget — never a guessed value`), { code: 'E_PUBLIC_IP_NOT_FOUND' })
    }

    const stored = readAssignment(await ctx.storage.device.getRaw(ASSIGNMENT_KEY))
    const { expectedPath, matches } = decideVerifyOutcome(stored, publicIp)

    if (matches === false) {
      ctx.log.warn('mikrotik-routing: verify-egress observed a public IP that disagrees with this assignment’s own last reading', {
        expectedPath,
        publicIp,
        lastPublicIp: stored.lastPublicIp,
      })
    } else if (matches === null) {
      ctx.log.info('mikrotik-routing: verify-egress has no prior reading to compare against yet', { expectedPath, publicIp })
    }

    // Always record the fresh reading, win or lose — the baseline this same
    // assignment compares against next time is what was just observed, not
    // what a prior mismatch happened to leave behind.
    await ctx.storage.device.set(ASSIGNMENT_KEY, writeAssignment({ ...stored, lastPublicIp: publicIp, lastVerifiedAt: Math.floor(Date.now() / 1000) }))

    return { publicIp, expectedPath, matches }
  },
}

export default verifyEgressScript
