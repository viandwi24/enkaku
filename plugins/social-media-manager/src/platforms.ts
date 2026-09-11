import { z } from 'zod'

/**
 * The platforms this manager can route a video to, and — the only part that
 * actually matters — WHICH of them can currently post one.
 *
 * ## Why this table exists rather than a hardcoded `if (platform === 'tiktok')`
 *
 * The manager's whole job is fan-out: one uploaded video, N phones, M
 * platforms. Everything about that is generic except one thing — the script
 * that drives a particular app's upload flow — so that one thing is the only
 * thing this table holds. Adding a platform is adding a row here plus the pack
 * it names; nothing in the router, the service, or the surface changes.
 *
 * ## `script: null` is a fact, not a placeholder
 *
 * Instagram has a pack in this repo and no post flow (YouTube's arrived on
 * 2026-09-11, from a hardware walk). That is not an oversight to be filled in with plausible selectors: every
 * anchor in `tiktok-automation-pack/post-video` traces to a real accessibility
 * dump taken on real hardware (see its `__fixtures__/`), and the pack's own
 * comments are explicit that a selector nobody has observed is a selector that
 * fails silently on the one run that mattered. Writing `instagram/post-video`
 * from memory would produce a script that typechecks, tests green against
 * fixtures invented to match it, and does the wrong thing on a phone.
 *
 * So a platform with no verified flow says so, in the product, by name. The
 * router skips it and RECORDS why; the Posts table shows the reason in the row.
 * An operator learns "Instagram posting needs a hardware walk" from the farm
 * instead of from a run that quietly did nothing.
 *
 * The day someone captures those dumps and writes the member, this becomes a
 * one-line change and every post already stored starts routing to it.
 */

export const PLATFORM_IDS = ['tiktok', 'instagram', 'youtube'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

export const PlatformIdSchema = z.enum(PLATFORM_IDS)

export interface Platform {
  id: PlatformId
  /** What an operator reads on a chip and in the Posts table. */
  title: string
  /**
   * The device label that means "this phone posts to this platform" — matched
   * case-insensitively against `DeviceInfo.labels[].name`.
   *
   * A LABEL, deliberately, and not a new concept: labels are already the
   * farm's many-to-many "this phone is one of these" (spec §4.2a), an operator
   * already creates and colours them on the Devices screen, and one phone
   * carrying both `tiktok` and `instagram` is exactly the many-to-many a group
   * could not express. Inventing a `platform` field on a device would have
   * meant a core table for something the farm already models.
   */
  label: string
  /**
   * The member that drives this app's upload flow, or `null` when no verified
   * flow exists yet. `null` is honest: see this module's own comment.
   */
  script: string | null
  /**
   * Why `script` is null, shown verbatim to the operator. Non-null exactly
   * when `script` is null — the two are kept in step by `PLATFORMS` below and
   * asserted by this module's test, so the surface can render one or the other
   * without ever having to guess.
   */
  unsupportedReason: string | null
}

const HARDWARE_WALK_NEEDED =
  'No verified upload flow yet. The selectors for this app have never been captured on hardware, and inventing them would produce a run that reports success without posting.'

export const PLATFORMS: readonly Platform[] = [
  {
    id: 'tiktok',
    title: 'TikTok',
    label: 'tiktok',
    // `source: 'direct'` is the member's own parameter for "post exactly this
    // artifact" — the branch plan 113 added for a caller that already knows
    // which video it wants, which is precisely this manager.
    script: 'tiktok/post-video@latest',
    unsupportedReason: null,
  },
  {
    id: 'instagram',
    title: 'Instagram',
    label: 'instagram',
    script: null,
    unsupportedReason: HARDWARE_WALK_NEEDED,
  },
  {
    id: 'youtube',
    title: 'YouTube',
    label: 'youtube',
    // Walked by hand on the owner's moto on 2026-09-11, every screen in the
    // youtube pack's `__fixtures__/`. It posts a Short with the caption as its
    // title and confirms it on the channel page before saying `posted`.
    script: 'youtube/post-video@latest',
    unsupportedReason: null,
  },
]

export function platformById(id: string): Platform | null {
  return PLATFORMS.find((p) => p.id === id) ?? null
}

/** The platforms that can actually post today — what the router iterates. */
export function postablePlatforms(): Platform[] {
  return PLATFORMS.filter((p) => p.script !== null)
}

/**
 * Does this device carry the platform's label?
 *
 * Case- and space-insensitive, because a label is typed by a human on a chip:
 * `TikTok`, `tiktok` and `Tik Tok` are the same intent, and a router that
 * matched only the exact lowercase string would silently skip a fleet an
 * operator believed they had labelled. `normaliseLabelName` already collapsed
 * inner whitespace on write; this strips it entirely so the spaced spelling
 * matches too.
 */
export function deviceCarriesPlatform(labels: readonly { name: string }[], platform: Platform): boolean {
  const want = platform.label.toLowerCase().replace(/\s+/g, '')
  return labels.some((l) => l.name.toLowerCase().replace(/\s+/g, '') === want)
}
