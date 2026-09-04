import type { Check } from '../types'

/**
 * Which APK an `installGuestAgent` would actually reach for, and whether one
 * exists at all.
 *
 * This check exists because of a whole afternoon lost to its absence
 * (2026-09-04). The owner's phone was running an August bootstrap build with
 * no `ui-tree` capability, so plans 221 and 222 — the entire inspector
 * rewrite — were dormant on the farm: every script kept paying `ui-server`'s
 * ~32 s attach and its dropped jsonrpc sockets, and nothing anywhere said
 * why. The engine ladder was behaving correctly and reporting honestly
 * (`liveInspection: 'ui-server'`), but nobody looks at a per-device field to
 * answer "is my build even live?".
 *
 * It mirrors `resolveGuestAgentApkPath`'s three tiers WITHOUT provisioning
 * anything: a doctor check must never trigger a download.
 */

/** Kept in step with `api/guest-agent.ts`'s `LOCAL_BUILD_PATHS`, deliberately by hand — a doctor check that imported the daemon would drag the whole core into the CLI. */
const LOCAL_BUILD_PATHS = [
  'apps/guest-agent/app/build/outputs/apk/release/app-release.apk',
  'apps/guest-agent/app/build/outputs/apk/debug/app-debug.apk',
]

/**
 * A local RELEASE build with no keystore lands here, and the resolver does not
 * look for it — `ENKAKU_GUEST_AGENT_KEYSTORE_PATH` is CI-only, so this is what
 * every `bun run build:guest-agent` on a developer's machine produces. It is
 * also unsigned, so `adb install` would refuse it even if the resolver did
 * look. Worth naming explicitly: "I just built it and nothing changed" is the
 * exact confusion this file is here to end.
 */
const UNSIGNED_RELEASE_PATH = 'apps/guest-agent/app/build/outputs/apk/release/app-release-unsigned.apk'

export const guestAgentCheck: Check = {
  id: 'guest-agent',
  title: 'Guest agent APK',
  async run(ctx) {
    const override = process.env.ENKAKU_GUEST_AGENT_PATH
    if (override) {
      const exists = await ctx.fs.exists(override)
      if (!exists) {
        return {
          status: 'fail',
          observed: `ENKAKU_GUEST_AGENT_PATH points at ${override}, which does not exist`,
          remedy: 'fix the path or unset ENKAKU_GUEST_AGENT_PATH to fall back to a local build or the pinned release',
        }
      }
      return { status: 'ok', observed: `explicit override: ${override}` }
    }

    for (const candidate of LOCAL_BUILD_PATHS) {
      if (await ctx.fs.exists(candidate)) {
        return { status: 'ok', observed: `local build: ${candidate} (a checkout only — a packaged core never sees this)` }
      }
    }

    if (await ctx.fs.exists(UNSIGNED_RELEASE_PATH)) {
      return {
        status: 'warn',
        observed: `a local release build exists at ${UNSIGNED_RELEASE_PATH}, but it is unsigned and the core does not look for that name`,
        remedy: 'build the debug variant instead — `bun run build:guest-agent --debug` produces app-debug.apk, signed with the debug key, which the core does resolve',
      }
    }

    const tools = await ctx.tools.status()
    const pinned = tools.find((t) => t.id === 'guest-agent')
    if (pinned?.provisioned) {
      return { status: 'ok', observed: `pinned release: guest-agent ${pinned.version ?? '(version unknown)'}, downloaded and sha256-verified` }
    }

    return {
      status: 'warn',
      observed: 'no APK is available locally; the first install will download the pinned release',
      remedy: 'that is fine for a server. In a checkout, `bun run build:guest-agent --debug` gives you the build you are working on instead of the last published one',
    }
  },
}
