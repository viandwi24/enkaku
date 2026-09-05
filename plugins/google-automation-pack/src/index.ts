import { definePlugin } from '@enkaku/sdk'
import snapshotAccounts from './snapshot-accounts'
import openRegister from './open-register'

/**
 * Google automation pack.
 *
 * ## Status: early, still measuring
 *
 * Two members: `snapshot-accounts` (read-only) and `open-register` (the
 * navigation walk to Google's account-creation page, which stops there and
 * never fills a field). The pack still exists to turn inference into measured
 * facts one member at a time — see `snapshot-accounts.ts` for why that
 * ordering is the point rather than caution.
 *
 * What has been measured on hardware: the Google app package and the home
 * screen's account-disc resource id (see `open-register.ts`). Everything else
 * is inference and is labelled as such in place: the settings-activity ladder,
 * the address parse, and the two text hops past the account sheet.
 * `plugins/mikrotik-routing/src/service/schemas.ts`'s header records what this
 * repo already paid for an inferred shape that was presented as a fact — 46
 * rows of `invalid_type` on the owner's real router, for a field nothing read.
 * The convention that came out of it is followed here: infer if you must, but
 * report which it was.
 *
 * ## Versioning — read this before editing anything under `src/`
 *
 * The bundled packs in `packages/core/packs/` are seeded ONCE, keyed on
 * `${name}@${version}` (`packages/core/src/plugins/seed-embedded.ts`). A
 * rebuilt bundle at an unchanged version is skipped on every later boot, so the
 * change sits in the repo, fully tested, and never reaches a browser. Editing
 * this pack means bumping all three sites together — `package.json`,
 * `version:` below, and `index.test.ts`'s assertion — then
 * `bun run build:packs`. And note a seeded version is STAGED, not activated:
 * the operator activates it on the Plugins page.
 *
 * ## Scope
 *
 * This pack automates Google apps and account state on a device the operator
 * already controls: reading which account a device is signed in as, moving
 * between accounts the operator owns, and device preparation around them.
 *
 * It does not create accounts. Google's signup flow is built to establish that
 * a human is present — CAPTCHA, phone verification, device signals — and a
 * member that drove it would be defeating that check, not automating a task.
 * `open-register` walks only as far as the creation PAGE and stops; no member
 * fills the form or submits it. Farms that need many accounts for testing get
 * them from the Google Workspace Admin SDK, which issues them through a
 * supported API instead.
 */
export default definePlugin({
  id: 'google',
  version: '0.3.0',
  /** Plan 310 §3.3 — shown wherever this plugin is offered as a choice (the script palette's plugin page, the Plugins rail). */
  icon: 'users',
  title: 'Google automation pack',
  description: 'Account and device automation for the Google apps on a farm device.',
  scripts: [snapshotAccounts, openRegister],

  /**
   * ## Changelog
   *
   * **0.3.0 — a plugin icon (plan 310 §3.3).** The pack declares `icon:
   * 'users'`, shown wherever it is offered as a choice (the script palette's
   * plugin page, the Plugins rail entry). No member declares its own icon
   * yet — both default to `play`. Cosmetic; nothing about how either member
   * runs changed.
   *
   * **0.2.0 — `open-register`, the first navigating member.** Opens the Google
   * app, walks the account sheet ("Login" or "add another account"), the
   * "create account" row, and the audience chooser's personal-use row, and
   * stops on Google's account-creation page. It never fills a field and never
   * submits anything — it exists to MEASURE the text hops between the sheet
   * and the signup form on the farm's real hardware, so the member that fills
   * the form is written against a measured tree rather than a guess. The
   * account disc selector and the Google app package are the only measured
   * facts so far; every hop after the first tap is a text walk whose outcome
   * is reported per hop, and each hop's tree is saved as an artifact.
   *
   * **0.1.0 — scaffold.** The pack container, `tree.ts`'s dump-and-walk
   * primitives, and one read-only member (`snapshot-accounts`) whose real
   * output is a measured UI tree for the next member to be built from. No
   * service, no Studio screen, and no `permissions` — a member reaching the
   * device needs neither, and an undeclared permission is refused at the point
   * of use (`E_FARM_UNDECLARED`, plan 113 finding C3) rather than granted
   * quietly. Both are added when a member actually needs them, so the install
   * consent screen never lists more than this pack uses.
   */
})
