import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginSurface, ViewSpec } from '@enkaku/protocol'
import { ICON_NAMES, PLUGIN_UI_API_VERSION, PluginSurfaceSchema, validatePluginSurface } from '@enkaku/protocol'
import plugin, { checkScript } from './index'
import { PROXY_KEY_HINT, PROXY_KEY_PREFIX, PROXY_KINDS, ProxyRecordSchema } from './record'
import { readProxy, writeProxy } from './ui/parts/api'
import {
  APPLY_INTENT_SENTENCE,
  APPLY_RUNG_SENTENCE,
  APPLY_VPN_SENTENCE,
  ASSIGNMENT_KEY,
  HTTP_MODE_DESCRIPTION,
  PROXY_APPLY_MODES,
  PROXY_APPLY_MODE_DESCRIPTIONS,
  PROXY_APPLY_MODE_LABELS,
  VPN_CREDENTIAL_WARNING,
  VPN_MODE_DESCRIPTION,
  vpnAgentProblem,
  ASSIGNMENT_NOTE,
  BANNER_NOT_BUILT,
  CATALOGUE_EMPTY_HINT,
  CHECK_NOT_BUILT,
  CREDENTIAL_NOT_STORED,
  DEFAULT_DRAIN_MS,
  DEFAULT_LOCAL_PORT_BASE,
  DEFAULT_MAX_CONNECTIONS,
  LOGS_CONTENT_NOTE,
  LOGS_SHARED_RING_NOTE,
  LOG_DESTINATIONS_HINT,
  PASSWORD_ABSENT_HINT,
  PASSWORD_MASK,
  PASSWORD_SAVED_HINT,
  PLUGIN_NOT_BUILT,
  PROXY_KEY_COLLISION_HINT,
  PROXY_KEY_LOCKED_HINT,
  PROXY_KEY_TAKEN_HINT,
  PROXY_KIND_LABELS,
  PROXY_PASTE_FORMATS,
  PROXY_PASTE_PREVIEW_NOTE,
  PROXY_PASTE_RULE,
  PROXY_SECRET_KEY_PREFIX,
  RUNS_NOTE,
  UNTITLED_PROXY_SLUG,
  VIEW_NOT_BUILT,
  DEFAULT_BIND_HOST,
  deriveProxyKey,
  maskProxyLine,
  nextFreeLocalPort,
  parseProxyLine,
  parseProxyList,
  proxySecretKeyFor,
  readProxyRecord,
  routeForRecord,
  secretHintLeak,
  slugifyProxyName,
  suggestProxyName,
} from './shared'

/**
 * The pack is deliberately blank, so almost everything worth testing is about
 * the SHAPE it declares rather than about behaviour it does not have.
 *
 * Two tests here are not about the schema, and both guard a failure nothing
 * else in the toolchain can see:
 *
 * - **The drift test** (`the form writes exactly the shape a record is`) — a
 *   form and a reader that disagree produce a screen that looks finished and
 *   shows empty cells. The surface is valid, the schemas are valid, the write
 *   succeeds, and the row is blank.
 * - **The honesty test** (plan 111 criterion 12) — the screen is React now, so
 *   there is no declared `empty.hint` for a test to read. What is asserted
 *   instead is stronger: the sentences live in `shared.ts`, the manifest uses
 *   those exact constants, and the React half's SOURCE names every one of
 *   them. Deleting a line of honesty copy from the screen therefore fails
 *   here, which is exactly what the old assertion bought.
 */

function surfaceOf(): PluginSurface {
  const surface = plugin.surface
  if (!surface) throw new Error('the pack declares no surface — the whole point of this plugin is the screen')
  return surface
}

function viewOf(id: string): ViewSpec {
  const view = surfaceOf().views[id]
  if (!view) throw new Error(`no such view: ${id}`)
  return view
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The React half, as text. Read rather than imported: `src/ui/index.tsx` calls
 * `window.__enkaku__.register` at the top level, so importing it would need a
 * DOM and a host global that only Studio provides. `src/ui/parts/api.ts` has
 * no such side effect and IS imported above — which is why the drift test
 * below can execute both halves rather than grep for them.
 */
async function readUi(file: string): Promise<string> {
  return await Bun.file(join(HERE, 'ui', file)).text()
}

/**
 * Every file the screen is made of, as one string.
 *
 * One list rather than three copies of it: the copy-drift tests below each read
 * "the React half", and a tab added to two of the three lists is a caveat that
 * silently stops being checked on the file most likely to have dropped it.
 * `parts/logs.tsx` is step 112.10's own.
 */
const UI_FILES = ['index.tsx', 'parts/catalogue.tsx', 'parts/assignments.tsx', 'parts/logs.tsx', 'parts/runs.tsx']

async function readAllUi(): Promise<string> {
  return (await Promise.all(UI_FILES.map(readUi))).join('\n')
}

const RECORD_FIELDS = Object.keys(ProxyRecordSchema.shape)

/** Every member the pack authors, as authored — see the title/description test for why this is not `plugin.scripts`. */
const MEMBERS = [checkScript]

describe('the plugin definition', () => {
  test('definePlugin accepted the whole thing at import time', () => {
    // `definePlugin` throws on the author's machine for an unknown icon, a nav
    // entry naming a missing view, an action reference naming a missing
    // action, a duplicate nav id, and every cap — so reaching this line at all
    // is the assertion. The identity checks below are what stops a rename from
    // silently changing the KV namespace, which is the plugin id.
    expect(plugin.id).toBe('proxy-manager')
    // 0.4.0 was step 114.9: `service.permissions` went from nothing to two
    // capabilities, and that list is what an operator consents to at install.
    // 0.5.0 is the password: the pack now stores a credential, and the
    // description in the plugin list says so. 0.6.0 is Apply's second mode: the
    // permission list is UNCHANGED, but the pack can now send that stored
    // password to a phone, which is not what 0.5.x's description described.
    // None of the three is a patch, because in every case what changed is what
    // the operator is agreeing to.
    expect(plugin.version).toBe('0.6.0')
    expect(plugin.scripts.length).toBe(1)
  })

  test('every member carries a title and a description', () => {
    // Read off the AUTHORED members, not `plugin.scripts`: `definePlugin`
    // returns `ScriptDefinition[]`, which does not carry `title`/`description`
    // in its type at all (they are `PluginMemberScript` fields, reported
    // separately by the verify child). The id equality below is what keeps
    // this honest — a member added to `definePlugin` and not to `MEMBERS`
    // fails here rather than skipping the check.
    expect(plugin.scripts.map((s) => s.id)).toEqual(MEMBERS.map((m) => m.id))
    for (const member of MEMBERS) {
      expect(member.title).toBeTruthy()
      expect(member.description).toBeTruthy()
    }
  })

  test('the member is a real, runnable script — not a stub that throws', () => {
    expect(checkScript.id).toBe('check')
    expect(typeof checkScript.run).toBe('function')
    expect(checkScript.params).toBeDefined()
  })

  test("the member's declared result accepts exactly what its run() returns", () => {
    expect(checkScript.result?.safeParse({ proxy: 'proxy:office-uk', reachable: false }).success).toBe(true)
  })

  test('the UI rewrite did not touch the scripts (step 111.7 changes the screen, not the members)', () => {
    expect(checkScript.result?.safeParse({ proxy: 'proxy:x', reachable: true }).success).toBe(true)
    // The one thing `run` may ever report, until something actually dials.
    expect(checkScript.description).toContain('not reachable')
  })
})

describe('the honesty copy is NARROWED by plan 112, never widened and never deleted (criteria 12 and 17)', () => {
  /**
   * These assertions were written when the pack did nothing at all and said
   * so. Plan 112 steps 112.1–112.7 made part of that untrue — a record marked
   * `enabled` now binds a real listener and dials a real upstream — so each
   * sentence is narrowed to exactly what stopped being true.
   *
   * The assertions below are **extended, not relaxed**. Each caveat that still
   * holds is still asserted, in its own expectation; the ones that changed are
   * asserted against the NEW claim, and paired with a `not.toMatch` for the
   * old one so a revert cannot pass silently.
   */

  test('the sentences say what is now true: a bridge runs, and a device can be pointed at one', () => {
    expect(PLUGIN_NOT_BUILT).toMatch(/runs a local bridge/)
    // Plan 112 steps 112.8 and 112.9 narrowed two more clauses: a bridge can be
    // started and stopped on its own, and there is one log with a per-proxy
    // filter. Each new claim is paired with a `not.toMatch` for the sentence it
    // replaced, in the test below.
    expect(PLUGIN_NOT_BUILT).toMatch(/started, stopped and restarted/)
    expect(PLUGIN_NOT_BUILT).toMatch(/one log you can filter to a single proxy/)
    expect(VIEW_NOT_BUILT).toMatch(/started, stopped or restarted on its own/)
    // Plan 114 step 114.9 narrowed this one: the pack still contacts no phone
    // itself, but it can ask the farm to.
    expect(PLUGIN_NOT_BUILT).toMatch(/contacts no phone itself/)
    expect(PLUGIN_NOT_BUILT).toMatch(/one device at a time/)
    expect(VIEW_NOT_BUILT).toMatch(/started by the farm when this plugin loads/)
    expect(VIEW_NOT_BUILT).toMatch(/only when you press Apply/)
    expect(BANNER_NOT_BUILT).toMatch(/an app can be pointed at it/)
    // And what 0.6.0 made true: Apply offers two modes, and the description an
    // operator reads in the plugin list names both of them AND the price of the
    // second, rather than describing the pack as if only one existed.
    expect(PLUGIN_NOT_BUILT).toMatch(/either as an HTTP proxy apps can ignore or as a VPN they cannot/)
    expect(PLUGIN_NOT_BUILT).toMatch(/sends the record’s upstream password to the phone/)
    expect(VIEW_NOT_BUILT).toMatch(/or a VPN through the record’s own upstream/)
  })

  test('the sentences that stopped being true are GONE, not merely softened', () => {
    // The exact claims plan 112 falsified. A revert that reinstated any of
    // them would put a lie back on the screen.
    expect(PLUGIN_NOT_BUILT).not.toMatch(/Nothing here starts/)
    expect(VIEW_NOT_BUILT).not.toMatch(/does not connect to anything/)
    expect(BANNER_NOT_BUILT).not.toMatch(/never contacted|is ever contacted/)
    for (const copy of [PLUGIN_NOT_BUILT, VIEW_NOT_BUILT, BANNER_NOT_BUILT, CATALOGUE_EMPTY_HINT]) {
      expect(copy).not.toMatch(/never opens a socket/)
    }
    /**
     * And the three plan 114 step 114.9 falsified. Each is paired with the
     * claim that replaced it above, so a revert cannot pass silently — the
     * discipline this whole block exists for.
     */
    expect(PLUGIN_NOT_BUILT).not.toMatch(/routes no device’s traffic/)
    expect(VIEW_NOT_BUILT).not.toMatch(/nothing here changes how a device’s traffic is carried/)
    expect(BANNER_NOT_BUILT).not.toMatch(/no device’s traffic changes/)

    /**
     * And the two plan 112 steps 112.8 and 112.9 falsified — the routes exist,
     * so a screen that says it cannot reach them is the lie now. Paired with
     * the claims that replaced them in the test above.
     */
    expect(VIEW_NOT_BUILT).not.toMatch(/cannot start or stop one yet/)
    expect(BANNER_NOT_BUILT).not.toMatch(/Starting and stopping from this screen/)
    expect(BANNER_NOT_BUILT).not.toMatch(/per-proxy logs.*not built/)
    expect(CATALOGUE_EMPTY_HINT).not.toMatch(/enabling one from this screen is not built/)

    /**
     * And the LAST one, which step 112.2 falsified: the pack's standing "an
     * upstream password cannot be saved" clause, in all four places it was
     * said. It is the one caveat plan 112 GAINED rather than narrowed, and it
     * is now the one it has given back — so every phrasing of it is asserted
     * gone, paired with the narrower claim that replaced it in the test below.
     *
     * Kept as four separate expectations rather than a loop over the four
     * constants, because they said it four different ways and a loop over one
     * regex would pass on a constant that still says it in a fifth.
     */
    expect(PLUGIN_NOT_BUILT).not.toMatch(/password still cannot be saved|cannot be saved/)
    expect(BANNER_NOT_BUILT).not.toMatch(/not built yet/)
    expect(BANNER_NOT_BUILT).not.toMatch(/dials its upstream without one/)
    expect(CATALOGUE_EMPTY_HINT).not.toMatch(/password field is still to come/)
    expect(CREDENTIAL_NOT_STORED).not.toMatch(/cannot be saved yet/)
    // The reason that expired with it: the fix is no longer pending, so a
    // sentence that still pointed at the step would be pointing at a step that
    // has landed.
    expect(CREDENTIAL_NOT_STORED).not.toMatch(/112\.2|is not built/)

    /**
     * And the two 0.6.0 falsified by giving Apply a second mode. Each is paired
     * with the claim that replaced it in the test above — the same discipline,
     * one release later.
     *
     * `APPLY_RUNG_SENTENCE`'s opening clause is the load-bearing one: while it
     * said Apply *always* used the asking kind, a screen that had just applied a
     * VPN would be flatly contradicting its own standing banner.
     */
    expect(APPLY_RUNG_SENTENCE).not.toMatch(/always uses the asking kind/)
    expect(VIEW_NOT_BUILT).not.toMatch(/changes that device’s system proxy setting/)
  })

  test('the password sentences say what step 112.2 made true, and no more than that', () => {
    // What IS now true, in each of the places that used to deny it.
    expect(PLUGIN_NOT_BUILT).toMatch(/saved encrypted on a row of its own/)
    expect(BANNER_NOT_BUILT).toMatch(/stored encrypted on a row of its own/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/saved on its own encrypted row/)
    // The mechanism that makes it safe, named rather than implied — this is the
    // claim `putSecret` has to keep, and the test below holds the code to it.
    expect(CREDENTIAL_NOT_STORED).toMatch(/storage hint switched off/)

    /**
     * And the two things that did NOT become true, which are the reason this
     * constant is narrowed rather than deleted:
     *
     * 1. this pack cannot show a stored password back — the built-in device
     *    route grew an audited reveal and this one has not;
     * 2. the farm's secret box is not a key manager (plan 112 F10 quotes its
     *    own source), and a screen that implied otherwise would be overstating
     *    what a key file sitting beside the database buys.
     */
    expect(CREDENTIAL_NOT_STORED).toMatch(/cannot be shown back to you/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/no reveal/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/not a key manager/)
    expect(CREDENTIAL_NOT_STORED).toMatch(/read the farm’s data directory can read both/)
    expect(BANNER_NOT_BUILT).toMatch(/nothing here can show a saved one back to you/)
    // The overstatements this sentence must never drift into.
    expect(CREDENTIAL_NOT_STORED).not.toMatch(/safely encrypted|securely|military|zero.knowledge/i)

    // And the empty field is explained rather than left to be interpreted —
    // "empty" means two opposite things and only the hint beside it says which.
    expect(PASSWORD_SAVED_HINT).toMatch(/Leave this empty to keep it/)
    expect(PASSWORD_ABSENT_HINT).toMatch(/No password is saved/)
    expect(PASSWORD_ABSENT_HINT).toMatch(/fails to connect and says so/)
  })

  test('every caveat that still holds is still stated', () => {
    // An assignment still applies nothing on its own — plan 114 §9 Q6's
    // answer, and the half of §3.12's sentence that survived step 114.9.
    expect(ASSIGNMENT_NOTE).toMatch(/changes nothing on the phone until you press Apply/)
    // The `check` member still dials nothing.
    expect(RUNS_NOTE).toMatch(/nothing was dialled/)
    expect(CHECK_NOT_BUILT).toMatch(/Does nothing yet/)
    expect(CHECK_NOT_BUILT).toMatch(/dials nothing/)
  })

  test('the Assignments note did NOT survive plan 114 verbatim, and the replacement is §3.3’s own sentence', () => {
    /**
     * Plan 112 §3.12 said this sentence would survive plan 114 word for word,
     * and the assertion here used to hold it to that. It stopped being true in
     * step 114.9 — the plan's own §3.3 replaced it — and this test is the
     * record of which claims fell rather than a softened version of the old
     * one.
     *
     * The three falsified claims, each with its own `not.toMatch`:
     */
    expect(ASSIGNMENT_NOTE).not.toMatch(/nothing reads it/)
    expect(ASSIGNMENT_NOTE).not.toMatch(/the device’s traffic is unchanged/)
    expect(ASSIGNMENT_NOTE).not.toMatch(/which no plugin can reach today/)

    // Declared ONCE (§3.3: "so the manifest and the screen cannot drift"), and
    // the note is built from it rather than paraphrasing it.
    expect(APPLY_INTENT_SENTENCE).toBe(
      'Assigning a proxy here records intent. Applying it to a device is the device’s own Network → Proxy setting, which either asks the device to use this proxy (apps may ignore it) or routes it through the VPN (apps cannot).',
    )
    expect(ASSIGNMENT_NOTE).toContain(APPLY_INTENT_SENTENCE)

    /**
     * And the narrower half is stated immediately, because §3.3's sentence
     * describes BOTH of the device's modes and this pack can only ever reach
     * the bypassable one. Leaving the wider sentence to stand alone would be
     * the "advisory worded as enforcing" failure plan 114 §3.1 exists to
     * prevent.
     */
    expect(ASSIGNMENT_NOTE).toContain(APPLY_RUNG_SENTENCE)
    expect(APPLY_RUNG_SENTENCE).toMatch(/can ignore that/)
    expect(APPLY_RUNG_SENTENCE).not.toMatch(/cannot escape|enforced|guaranteed/)
    // The banner carries the same sentence rather than a second copy of it.
    expect(BANNER_NOT_BUILT).toContain(APPLY_RUNG_SENTENCE)

    /**
     * And, since 0.6.0, the OTHER half is stated in the same three places — for
     * the mirror-image reason. One mode described alone reads as the only one
     * there is, and if that one is the enforcing mode the operator is being
     * promised something the HTTP rung will not deliver.
     */
    expect(ASSIGNMENT_NOTE).toContain(APPLY_VPN_SENTENCE)
    expect(BANNER_NOT_BUILT).toContain(APPLY_VPN_SENTENCE)
    // Both halves of the trade, in the sentence that offers the mode. Naming
    // only the reason to pick it would be selling it.
    expect(APPLY_VPN_SENTENCE).toMatch(/an app cannot opt out of it/)
    expect(APPLY_VPN_SENTENCE).toMatch(/the upstream password is sent to the phone/)
    // And it must never claim the farm can SEE that it worked — `health` is the
    // farm's word, not this pack's, and nothing here verifies a tunnel.
    expect(APPLY_VPN_SENTENCE).not.toMatch(/verified|guaranteed|proves/)
  })

  test('the two mode descriptions are Studio’s own, byte for byte (plan 114 §3.1 risk 1)', async () => {
    /**
     * The pack is bundled separately by `enkaku publish`, so it cannot import
     * `packages/studio/src/components/guest-agent/proxy-copy.ts` however right
     * that would be — the same constraint `parseProxyLine` already records. What
     * is available instead is this: read Studio's file and assert the copies are
     * identical.
     *
     * Plan 114's risk 1 names three independent copies of this wording as the
     * failure mode — one gets softened, the others do not, and an operator reads
     * whichever screen they happened to open. A comment saying "keep these in
     * sync" is not a defence; this is.
     */
    const studio = await Bun.file(join(HERE, '..', '..', '..', 'packages', 'studio', 'src', 'components', 'guest-agent', 'proxy-copy.ts')).text()
    expect(studio).toContain(`export const HTTP_MODE_DESCRIPTION =\n  '${HTTP_MODE_DESCRIPTION}'`)
    expect(studio).toContain(`export const VPN_MODE_DESCRIPTION = '${VPN_MODE_DESCRIPTION}'`)
    // The pair is what the picker renders, keyed by mode, so a third copy
    // cannot appear beside them.
    expect(PROXY_APPLY_MODE_DESCRIPTIONS).toEqual({ http: HTTP_MODE_DESCRIPTION, vpn: VPN_MODE_DESCRIPTION })
    // Never the word "advisory" — a word an operator has to already know
    // (§3.1 rule 1).
    expect(`${HTTP_MODE_DESCRIPTION} ${VPN_MODE_DESCRIPTION}`).not.toMatch(/advisory|enforcing/i)
  })

  test('the credential trade is said at the point of choice, not only in a paragraph', () => {
    // This pack's own addition to Studio's pair: on the device panel the
    // operator types the password into the form they are looking at; here a
    // password saved weeks ago on another tab is spent by a button press.
    expect(VPN_CREDENTIAL_WARNING).toMatch(/sent to the phone/)
    expect(VPN_CREDENTIAL_WARNING).toMatch(/HTTP proxy mode keeps it on this machine/)
  })

  test('the log copy says what a line records AND what it deliberately does not (step 112.8)', () => {
    // The switch's own wording has to say what turning it ON records — a
    // toggle labelled "log destinations" tells an operator nothing about the
    // browsing record it starts keeping.
    expect(LOG_DESTINATIONS_HINT).toMatch(/which hosts the traffic through this proxy reaches/)
    expect(LOG_DESTINATIONS_HINT).toMatch(/Off by default/)
    // And the omissions are stated positively, in the same place, rather than
    // being a property only the code knows.
    expect(LOGS_CONTENT_NOTE).toMatch(/never records a hostname unless/)
    expect(LOGS_CONTENT_NOTE).toMatch(/never a path, a query string, a header, a byte of payload/)
    expect(LOGS_CONTENT_NOTE).toMatch(/username or password/)
    // The cost of one shared ring is admitted rather than hidden — a busy
    // proxy evicting a quiet one's lines is the thing that would otherwise
    // read as "this proxy did nothing".
    expect(LOGS_SHARED_RING_NOTE).toMatch(/push a quiet one’s lines out/)
    expect(LOGS_SHARED_RING_NOTE).toMatch(/the page says so/)
    // One stream filtered by the FARM, not a second filter in this pack.
    expect(LOGS_SHARED_RING_NOTE).toMatch(/filtered to one proxy by the farm rather than by this screen/)
  })

  test('the manifest uses those exact sentences, not paraphrases of them', () => {
    expect(plugin.description).toBe(PLUGIN_NOT_BUILT)
    expect(viewOf('proxies').description).toBe(VIEW_NOT_BUILT)
    expect(checkScript.description).toBe(CHECK_NOT_BUILT)
  })

  test('the React half names every one of them, so a rewrite cannot quietly drop one', async () => {
    const sources = await readAllUi()
    for (const name of [
      'BANNER_NOT_BUILT',
      'CATALOGUE_EMPTY_HINT',
      'ASSIGNMENT_NOTE',
      'RUNS_NOTE',
      'CREDENTIAL_NOT_STORED',
      // Step 112.10's own two: the Logs tab says what a line records and what
      // it never does, and that one ring is shared by every bridge — both
      // declared in `shared.ts` because the first is a promise about
      // `logbook.ts`'s field allowlist and a paraphrase could promise more.
      'LOGS_CONTENT_NOTE',
      'LOGS_SHARED_RING_NOTE',
      // 0.6.0's two: the mode descriptions (Studio's own pair, keyed by mode)
      // and the credential warning this pack adds to them. Both are rendered at
      // the point of choice, which is the requirement — a mode picker with no
      // sentence under it is exactly what plan 114 §3.1 rule 1 refuses.
      'PROXY_APPLY_MODE_DESCRIPTIONS',
      'VPN_CREDENTIAL_WARNING',
    ]) {
      expect(sources).toContain(name)
    }
  })

  test('the screen never hard-codes a sentence the manifest also states', async () => {
    // A copy-pasted duplicate is how the plugin list and the screen start
    // disagreeing. Both halves import from `shared.ts`; neither inlines it.
    const sources = await readAllUi()
    expect(sources).not.toContain(BANNER_NOT_BUILT)
    expect(sources).not.toContain(ASSIGNMENT_NOTE)
    expect(sources).not.toContain(CREDENTIAL_NOT_STORED)
  })

  /**
   * The inverse of the assertion that stood here while 112.2 was unbuilt.
   *
   * It used to prove the ABSENCE of `type="password"` and of the credential
   * prefix anywhere in the screen. Deleting it once the field landed would have
   * left the pack with no assertion about its credential path at all, so it is
   * turned around instead: the same two anchors, now proving the field exists
   * AND that the only write it can reach carries both flags.
   */
  test('the screen has a password field, and the one write it reaches carries `secret: true, hint: false`', async () => {
    const catalogue = await readUi('parts/catalogue.tsx')
    expect(catalogue).toMatch(/type="password"/)
    expect(catalogue).toContain('proxySecretKeyFor')
    // Control — the search is looking at the real dialog, which has the other
    // upstream fields too.
    expect(catalogue).toContain('pm-username')
    expect(catalogue).toContain('Upstream host')

    /**
     * **Both flags, on one line, in ONE function.** `hint` is per write and not
     * sticky (`KvSetOptions.hint` — a later write that omits it re-derives the
     * hint from the new plaintext), exactly as `secret` is, so a second write
     * path that passed one and forgot the other would silently restore plan 112
     * F12's leak on a key that had never had it. `putSecret` is the only place
     * this pack writes a credential, and this is what holds it to that.
     */
    expect(catalogue).toContain('secret: true, hint: false')
    /**
     * **`secret: true` never appears without `hint: false` beside it**, in this
     * file, anywhere — including in a comment, so the prose cannot start
     * describing a shape the code stopped writing. This is the assertion that
     * matters: `toContain` above would still pass if a SECOND write elsewhere
     * passed only `secret: true`, which is exactly the mistake the per-write
     * (non-sticky) flag makes easy.
     */
    expect(catalogue.match(/secret: true(?!, hint: false)/g)).toBeNull()
    // And there is only one writer for a call site to get wrong.
    expect(catalogue.match(/async function putSecret\(/g)?.length).toBe(1)
    // And the record half is still NOT secret — marking a host and a port
    // secret would redact the columns the table draws.
    expect(catalogue).toContain('secret: false')
  })

  test('a password never reaches a preview, a name, or a parse failure', async () => {
    const catalogue = await readUi('parts/catalogue.tsx')
    // The bulk preview renders whether a password was found, never the value.
    expect(catalogue).toContain('PASSWORD_MASK')
    expect(catalogue).toContain('maskProxyLine')
    expect(catalogue).not.toMatch(/\{row\.proxy\.password\}/)
    // Masked BEFORE it reaches the component: `ProxyPasteLine.masked` is what
    // the parser hands over, so the render cannot forget.
    const line = maskProxyLine('country-id-r9931204:Sup3rSecret@10.4.0.9:1080')
    expect(line).not.toContain('Sup3rSecret')
    expect(line).toContain('country-id-r9931204')
    expect(maskProxyLine('10.4.0.9:1080:user:Sup3rSecret')).not.toContain('Sup3rSecret')
    // The scheme form too, and a line with no credential is left alone.
    expect(maskProxyLine('socks5://u:Sup3rSecret@h:1080')).toBe(`socks5://u:${PASSWORD_MASK}@h:1080`)
    expect(maskProxyLine('10.4.0.9:1080')).toBe('10.4.0.9:1080')
  })

  test('no parse refusal ever quotes the line it refused', () => {
    /**
     * A password can be anywhere in a malformed line, and the failing shapes
     * are exactly the ones that carry one — `user:pass@host` with no port is
     * the common paste. A reason that echoed "the offending field" would put a
     * credential on a screen, in a message the operator might well copy into a
     * bug report. So the reasons name the RULE and the position, never the
     * content, and this asserts it against the shapes that would leak.
     */
    const secret = 'Sup3rSecretUpstreamPassword'
    for (const line of [
      `user:${secret}@10.4.0.9`, // no port
      `10.4.0.9:notaport:user:${secret}`, // second field is not a port
      `10.4.0.9:1080:${secret}`, // three fields, refused rather than guessed
      `ftp://user:${secret}@10.4.0.9:1080`, // a scheme this pack does not speak
      `user:${secret}@[::1`, // an unclosed bracket
    ]) {
      const parsed = parseProxyLine(line)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.reason).not.toContain(secret)
      // Control: it is a real sentence that names what to do, not an empty
      // refusal — the failure `parseSocks5Url`'s bare `null` has.
      expect(parsed.reason.length).toBeGreaterThan(20)
    }
  })
})

describe('the storage key is derived, not typed (the owner’s first complaint)', () => {
  test('a name makes a key, and the charset is a subset of what KV accepts', () => {
    expect(slugifyProxyName('SOAX Japan')).toBe('soax-japan')
    expect(slugifyProxyName('  --Office UK!!  ')).toBe('office-uk')
    // Accents fold rather than becoming separators — `Köln` is `koln`.
    expect(slugifyProxyName('Köln DC')).toBe('koln-dc')
    // KV's own key charset is `/^[A-Za-z0-9._:-]+$/`; a derived key can never
    // be refused by the store for its shape.
    for (const name of ['SOAX Japan', 'a/b\\c', 'Zürich #2', 'x'.repeat(200)]) {
      const key = deriveProxyKey(name, [])
      expect(key).toMatch(/^[A-Za-z0-9._:-]+$/)
      expect(key.length).toBeLessThanOrEqual(256)
    }
  })

  test('a name that slugs to nothing still gets a key rather than an empty one', () => {
    // `プロキシ` has no Latin run at all, and this file imports nothing, so a
    // transliteration is not available. The fallback is ugly and honest, and
    // the override field is right beside it.
    expect(slugifyProxyName('プロキシ')).toBe('')
    expect(deriveProxyKey('プロキシ', [])).toBe(`${PROXY_KEY_PREFIX}${UNTITLED_PROXY_SLUG}`)
  })

  test('THE COLLISION — two proxies called “SOAX Japan” do not become one row', () => {
    /**
     * The failure this exists to prevent: `PUT …/data/entry` upserts, so a
     * second derivation landing on the same key would replace the first
     * record — silently, with the first record's `proxy-secret:` credential
     * still attached to whatever replaced it.
     *
     * The rule is a numeric suffix, and the dialog SHOWS the suffixed key
     * before saving, so it is a decision rather than a discovery.
     */
    expect(deriveProxyKey('SOAX Japan', [])).toBe('proxy:soax-japan')
    expect(deriveProxyKey('SOAX Japan', ['proxy:soax-japan'])).toBe('proxy:soax-japan-2')
    expect(deriveProxyKey('SOAX Japan', ['proxy:soax-japan', 'proxy:soax-japan-2'])).toBe('proxy:soax-japan-3')
    // …and a paste of the same line twice allocates two keys, because the
    // allocator is given what it has already handed out.
    const taken: string[] = []
    const first = deriveProxyKey('SOAX Japan', taken)
    taken.push(first)
    expect(deriveProxyKey('SOAX Japan', taken)).not.toBe(first)
  })

  test('the dialog derives the key and locks it after creation, and says why in both cases', async () => {
    const source = await readUi('parts/catalogue.tsx')
    // Derived on every render from the name, so what is shown is what is saved.
    expect(source).toContain('deriveProxyKey(local.label, otherKeys)')
    expect(source).toContain('onSave({ ...local, key: effectiveKey })')
    // The key field is no longer a required typed input: the dialog's
    // completeness check reads the DERIVED key, so an operator who types only
    // a name can save.
    //
    // Tolerant of the line break plan 117 step 117.4's own reformatting
    // introduced ahead of this check (relaxing "host required" for a
    // `direct` upstream pushed `const incomplete = …` onto two lines) — this
    // is about the CHECK existing, not about a formatter's line width.
    expect(source).toMatch(/const incomplete =\s*effectiveKey\.trim\(\)\.length === 0/)
    // Behind a disclosure, prefilled, and only while the record is new.
    expect(source).toContain('CollapsibleTrigger')
    expect(source).toContain('PROXY_KEY_DERIVED_HINT')
    expect(source).toContain('PROXY_KEY_COLLISION_HINT')
    expect(source).toContain('PROXY_KEY_LOCKED_HINT')
    expect(source).toContain('PROXY_KEY_TAKEN_HINT')
    // A typed key that already exists BLOCKS the save rather than replacing a
    // row the operator cannot see from the dialog.
    expect(source).toMatch(/disabled=\{busy \|\| incomplete \|\| keyIsTaken/)
  })

  test('the two key sentences say the two different things they have to', () => {
    // The lock is not "you may not", it is "this would not do what you think".
    expect(PROXY_KEY_LOCKED_HINT).toMatch(/cannot move a row/)
    expect(PROXY_KEY_LOCKED_HINT).toMatch(/saved password still attached/)
    // The collision is not a failure — both records are kept.
    expect(PROXY_KEY_COLLISION_HINT).toMatch(/neither is overwritten/)
    // The typed clobber is refused, and the reason names the credential.
    expect(PROXY_KEY_TAKEN_HINT).toMatch(/saved password would stay attached/)
  })
})

describe('a pasted proxy, in the shapes providers actually hand out', () => {
  const cases: [string, { proto: string; host: string; port: number; username: string; password: string }][] = [
    ['socks5://country-id-r9931204:s3cr3t@10.4.0.9:1080', { proto: 'socks5', host: '10.4.0.9', port: 1080, username: 'country-id-r9931204', password: 's3cr3t' }],
    ['http://user:pass@proxy.example.com:8080', { proto: 'http', host: 'proxy.example.com', port: 8080, username: 'user', password: 'pass' }],
    ['country-id-r9931204:s3cr3t@10.4.0.9:1080', { proto: 'socks5', host: '10.4.0.9', port: 1080, username: 'country-id-r9931204', password: 's3cr3t' }],
    ['10.4.0.9:1080:country-id-r9931204:s3cr3t', { proto: 'socks5', host: '10.4.0.9', port: 1080, username: 'country-id-r9931204', password: 's3cr3t' }],
    ['10.4.0.9:1080', { proto: 'socks5', host: '10.4.0.9', port: 1080, username: '', password: '' }],
  ]

  test('the four shapes named in the box are the four the parser reads', () => {
    for (const [line, expected] of cases) {
      const parsed = parseProxyLine(line)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      expect({ ...parsed.proxy, schemeGiven: undefined, form: undefined }).toMatchObject(expected)
    }
    // And the four are the four the screen advertises, in the same order.
    expect(PROXY_PASTE_FORMATS.length).toBe(4)
  })

  test('THE AMBIGUITY — the rule is “the second field is the port”, and it is stated on screen', () => {
    /**
     * `a:b:c:d` is `host:port:user:pass` when `b` is a port number, and refused
     * by name when it is not. Three fields are refused outright rather than
     * guessed between "host:port:user with no password" and "a password with a
     * colon in it".
     */
    const four = parseProxyLine('10.4.0.9:1080:user:pass')
    expect(four.ok).toBe(true)

    const notAPort = parseProxyLine('10.4.0.9:eu:user:pass')
    expect(notAPort).toMatchObject({ ok: false })
    if (!notAPort.ok) expect(notAPort.reason).toMatch(/second field is not a port number/)

    const three = parseProxyLine('10.4.0.9:1080:user')
    expect(three).toMatchObject({ ok: false })
    if (!three.ok) expect(three.reason).toMatch(/three colon-separated fields/)

    // A password holding colons survives the colon form, because everything
    // past the fourth field is still password.
    const colons = parseProxyLine('10.4.0.9:1080:user:a:b:c')
    expect(colons.ok).toBe(true)
    if (colons.ok) expect(colons.proxy.password).toBe('a:b:c')

    // The rule the operator reads is the rule the parser applies.
    expect(PROXY_PASTE_RULE).toMatch(/second field must be a port number/)
    expect(PROXY_PASTE_RULE).toMatch(/Three fields are refused/)
    expect(PROXY_PASTE_RULE).toMatch(/LAST “@”/)
    expect(PROXY_PASTE_RULE).toMatch(/FIRST “:”/)
    expect(PROXY_PASTE_RULE).toMatch(/brackets/)
  })

  test('a password may contain “:” and “@”; a username may contain neither', () => {
    // The `@` form splits at the LAST `@` and the FIRST `:`, which is what
    // makes both of these come out whole. `new URL()` gets the second one wrong,
    // which is why this parser is hand-written (see `shared.ts`'s header).
    const colon = parseProxyLine('user:pa:ss@10.4.0.9:1080')
    expect(colon.ok).toBe(true)
    if (colon.ok) expect(colon.proxy.password).toBe('pa:ss')

    const at = parseProxyLine('user:pa@ss@10.4.0.9:1080')
    expect(at.ok).toBe(true)
    if (at.ok) expect(at.proxy).toMatchObject({ username: 'user', password: 'pa@ss', host: '10.4.0.9' })
  })

  test('IPv6 is read when it is bracketed and refused with the fix when it is not', () => {
    const bracketed = parseProxyLine('[2001:db8::1]:1080')
    expect(bracketed.ok).toBe(true)
    if (bracketed.ok) expect(bracketed.proxy).toMatchObject({ host: '2001:db8::1', port: 1080 })

    const withAccount = parseProxyLine('user:pass@[2001:db8::1]:1080')
    expect(withAccount.ok).toBe(true)
    if (withAccount.ok) expect(withAccount.proxy).toMatchObject({ host: '2001:db8::1', port: 1080, username: 'user' })

    const bare = parseProxyLine('2001:db8::1')
    expect(bare).toMatchObject({ ok: false })
    if (!bare.ok) expect(bare.reason).toMatch(/second field is not a port number/)
  })

  test('a scheme sets the transport, an unknown one is refused, and percent-encoding is decoded only for a URL', () => {
    const socks = parseProxyLine('socks5h://h:1080')
    expect(socks.ok && socks.proxy).toMatchObject({ proto: 'socks5', schemeGiven: true })
    const plain = parseProxyLine('h:1080', { defaultProto: 'http' })
    expect(plain.ok && plain.proxy).toMatchObject({ proto: 'http', schemeGiven: false })
    const wrong = parseProxyLine('ftp://h:1080')
    expect(wrong).toMatchObject({ ok: false })

    // Studio's `parseSocks5Url` decodes because everything it takes is a URL;
    // this decodes on exactly the same condition, and NOT on a schemeless line
    // where a `%` is far likelier to be a character in the password itself.
    const encoded = parseProxyLine('socks5://us%40er:p%3Ass@h:1080')
    expect(encoded.ok && encoded.proxy).toMatchObject({ username: 'us@er', password: 'p:ss' })
    const raw = parseProxyLine('us%40er:p%3Ass@h:1080')
    expect(raw.ok && raw.proxy).toMatchObject({ username: 'us%40er', password: 'p%3Ass' })
  })

  test('a list skips blanks and comments, numbers the lines an operator can see, and reports each failure with its reason', () => {
    const list = parseProxyList(['# SOAX, expires in March', '', '10.4.0.9:1080:u:p', 'this is not a proxy', 'socks5://h2:1080'].join('\n'))
    // Three entries: the comment and the blank are dropped rather than reported
    // as failures, which is what stops a real failure being buried.
    expect(list.length).toBe(3)
    expect(list.map((l) => l.line)).toEqual([3, 4, 5])
    expect(list[0]?.result.ok).toBe(true)
    expect(list[1]?.result.ok).toBe(false)
    expect(list[2]?.result.ok).toBe(true)
  })

  test('a local port is assigned, skipping what is already claimed — the one field a pasted line never carries', () => {
    // The owner's own port, from plan 112 §0's `gost -L "http://:9902"`.
    expect(DEFAULT_LOCAL_PORT_BASE).toBe(9902)
    expect(nextFreeLocalPort([])).toBe(9902)
    expect(nextFreeLocalPort([9902, 9903])).toBe(9904)
    expect(nextFreeLocalPort([9902], 9910)).toBe(9910)
  })

  test('the paste preview promises only what it can keep', () => {
    expect(PROXY_PASTE_PREVIEW_NOTE).toMatch(/Nothing is saved until/)
    expect(PROXY_PASTE_PREVIEW_NOTE).toMatch(/a password is never shown/)
    // A name from the account, not the host, because a provider's list is one
    // host and many accounts.
    expect(suggestProxyName({ proto: 'socks5', host: 'h', port: 1, username: 'acct', password: '', schemeGiven: false, form: 'host-port' })).toBe('acct')
    expect(suggestProxyName({ proto: 'socks5', host: 'h', port: 1, username: '', password: '', schemeGiven: false, form: 'host-port' })).toBe('h')
  })

  test('a paste creates nothing that is listening', async () => {
    /**
     * The same rule plan 112 §4.3 property 2 sets for the migration: an import
     * must never start a listener nobody asked to start. Forty ports bound on
     * an operator's machine from one press is the failure, and it is asserted
     * on the source because the alternative is asserting it on a component that
     * needs a DOM.
     */
    const source = await readUi('parts/catalogue.tsx')
    const dialog = source.slice(source.indexOf('function PasteDialog('))
    expect(dialog).toContain('enabled: false')
    expect(dialog).not.toMatch(/enabled: true/)
    // Both halves of a record go through the same two writers the single
    // dialog uses, so a bulk write cannot be the path that forgets a flag.
    expect(dialog).toContain('putRecord(row.key, row.record)')
    expect(dialog).toContain('putSecret(')
  })

  test('the paste sits BESIDE the field-by-field form, not instead of it', async () => {
    // The owner asked for both, in the same message: *"tapi opsi input satu
    // persatu juga tetap ada gitu"*.
    const source = await readUi('parts/catalogue.tsx')
    expect(source).toContain('Paste list')
    expect(source).toContain('Add proxy')
    // And the single dialog has its own one-line paste, which FILLS the fields
    // and never saves on its own.
    expect(source).toContain('PROXY_PASTE_SINGLE_HINT')
    expect(source).toContain('Fill fields')
    expect(source).toContain('pm-host')
    expect(source).toContain('pm-username')
  })
})

describe('the plugin boundary — one door, declared, and never a settings write (plan 114 §3.3, step 114.9)', () => {
  /**
   * The property this block buys is not "the pack can set a proxy". It is that
   * there is exactly ONE way it can, that the way is declared in the manifest
   * an operator consented to, and that no second path exists to drift from it.
   */

  test('the manifest declares the capabilities it uses, and nothing wider', () => {
    const permissions = plugin.service?.permissions ?? []
    // The list is exhaustive on purpose (plan 109 §4.3): anything absent is
    // refused BEFORE the capability runs, so a manifest that is merely
    // approximately right is a plugin that fails at the moment it acts.
    expect([...permissions].sort()).toEqual(['device.list', 'device.network.set'])
    /**
     * `device.network.clear` is deliberately absent. Turning a device's proxy
     * off is the operator's own act on the device's own screen, where the
     * capture-and-restore is explained; a plugin able to silently un-route
     * forty phones is a wider authority than anything on this screen asks for.
     */
    expect(permissions).not.toContain('device.network.clear')
    expect(permissions).not.toContain('device.shell')
  })

  test('nothing anywhere in this pack writes a device setting (plan 114 criterion 11)', async () => {
    const files = ['index.ts', 'shared.ts', 'record.ts', 'service/apply.ts', 'service/supervisor.ts', 'ui/parts/assignments.tsx']
    const sources = (await Promise.all(files.map((f) => Bun.file(join(HERE, f)).text()))).join('\n')
    // The shapes of the second door this step exists to prevent. `settings put
    // global http_proxy` is the literal plan 114 criterion 11 names; the other
    // two are the ways a pack would have to reach a shell to run it.
    expect(sources).not.toMatch(/settings\s+put/)
    expect(sources).not.toMatch(/global_http_proxy/)
    expect(sources).not.toMatch(/Bun\.spawn|child_process|execFile/)
  })

  test('the route goes through the capability broker, not a fetch at the same URL', async () => {
    const apply = await Bun.file(join(HERE, 'service/apply.ts')).text()
    // `ctx.farm.call` is what runs the call under `plugin:proxy-manager` and
    // gets it audited. A `fetch` to `PUT /api/devices/:id/network` from the
    // screen would run as the OPERATOR — same endpoint, wrong actor, and the
    // device would report a person set a route a plugin set.
    expect(apply).toContain("farm.call('device.network.set'")
    expect(apply).not.toMatch(/fetch\(/)

    const ui = await readUi('parts/assignments.tsx')
    // The screen must not CALL the device API. Anchored to a quote, because the
    // file's own comment explains why it does not by naming the URL — and an
    // assertion that cannot tell an explanation from a call is one that fails
    // for the wrong reason and gets relaxed rather than fixed.
    expect(ui).not.toMatch(/['"`]\/api\/devices/)
    // The screen's only door is this pack's own handler.
    expect(ui).toContain('/http/apply')
  })

  test('applying is a separate, explicit press — saving an assignment applies nothing (plan 114 §9 Q6)', async () => {
    const ui = await readUi('parts/assignments.tsx')
    // `assign()` writes the note; `apply()` asks the farm. Two functions, two
    // buttons — an assignment that silently changed forty phones' networking on
    // save is the wrong default.
    expect(ui).toMatch(/async function assign\(/)
    expect(ui).toMatch(/async function apply\(/)
    expect(ui).toMatch(/onClick=\{\(\) => void apply\(device\.stableId\)\}/)
    // …and `assign` never calls `apply`.
    const assignBody = ui.slice(ui.indexOf('async function assign('), ui.indexOf('if (loading)'))
    expect(assignBody).not.toMatch(/\bapply\(/)
  })

  test('a record maps to the reverse rung, because a bridge binds loopback', () => {
    const record = readProxyRecord({
      label: 'office',
      listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: 9902 },
      upstream: { proto: 'socks5', host: 'up.example', port: 1080, username: 'u', bindAddress: '', resolveThroughEgress: true },
      enabled: true,
    })
    const resolved = routeForRecord(record)
    // Rung 2, and only ever rung 2: a phone cannot dial the farm's loopback, so
    // `adb reverse` is what carries it. `hostPort` is where the bridge listens
    // ON THIS MACHINE; the device-side port is the farm's to allocate.
    expect(resolved).toEqual({ route: { engine: 'adb-reverse-proxy', hostPort: 9902 } })
  })

  test('the refusals are named, and each says what to do instead', () => {
    const base = {
      label: 'office',
      listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: 9902 },
      upstream: { proto: 'socks5', host: 'up.example', port: 1080, username: 'u', bindAddress: '', resolveThroughEgress: true },
      enabled: true,
    }

    // A SOCKS5 bridge cannot be a system proxy: Android's setting names an HTTP
    // proxy and has no field for anything else.
    const socks = routeForRecord(readProxyRecord({ ...base, listen: { ...base.listen, proto: 'socks5' } }))
    expect(socks).toMatchObject({ problem: { code: 'E_PROXY_NOT_APPLICABLE', kind: 'refusal' } })

    // A record nobody enabled has no listener, so applying it would point the
    // phone at a port that answers nothing. A precondition, not an error — plan
    // 59: a fact that is not true YET is never rendered red.
    const off = routeForRecord(readProxyRecord({ ...base, enabled: false }))
    expect(off).toMatchObject({ problem: { code: 'E_PROXY_NOT_RUNNING', kind: 'precondition' } })

    // The record's own validation still runs first, and its codes are reused
    // rather than duplicated under new names.
    const unassigned = routeForRecord(readProxyRecord({ ...base, listen: { ...base.listen, port: null } }))
    expect(unassigned).toMatchObject({ problem: { code: 'E_PROXY_PORT_UNASSIGNED' } })
  })

  /**
   * The second mode (0.6.0), and the correction it required.
   *
   * `shared.ts` used to argue that the enforcing rung was structurally out of
   * reach for this pack, because a loopback bridge cannot be the SOCKS5 upstream
   * the guest agent dials. That is true of the BRIDGE and false of the RECORD: a
   * record holds an upstream too, and for a SOCKS5 one that is exactly what
   * `vpn-helper` wants. These tests hold the pack to applying the record's
   * upstream — never the bridge's address — in VPN mode.
   */
  const vpnBase = {
    label: 'soax',
    listen: { proto: 'http', bindHost: DEFAULT_BIND_HOST, port: 9905 },
    upstream: { proto: 'socks5', host: 'proxy.soax.com', port: 5000, username: 'package-123-country-id', bindAddress: '', resolveThroughEgress: true },
    enabled: true,
  }

  test('VPN mode applies the record’s UPSTREAM, and never the bridge’s port', () => {
    const record = readProxyRecord(vpnBase)
    const resolved = routeForRecord(record, { mode: 'vpn', hasPassword: true })
    expect(resolved).toEqual({ route: { engine: 'vpn-helper', host: 'proxy.soax.com', port: 5000, username: 'package-123-country-id' } })
    // The two modes produce genuinely different routes from the same record —
    // which is the whole feature. A VPN route that carried `hostPort` would be
    // pointing the guest agent at a loopback port on a machine it cannot reach.
    expect(routeForRecord(record, { mode: 'http' })).toEqual({ route: { engine: 'adb-reverse-proxy', hostPort: 9905 } })
    // And the credential is NOT here: `routeForRecord` runs in the browser too,
    // so the password is `service/apply.ts`'s to add, in the core's process.
    expect(JSON.stringify(resolved)).not.toContain('password')
  })

  test('VPN mode does not need the bridge to be running — it does not use the bridge', () => {
    // A disabled record with no local port at all: both are facts about a
    // listener VPN mode never binds. Refusing here would be a refusal with no
    // true reason behind it.
    const record = readProxyRecord({ ...vpnBase, enabled: false, listen: { ...vpnBase.listen, port: null } })
    expect(routeForRecord(record, { mode: 'vpn', hasPassword: true })).toMatchObject({ route: { engine: 'vpn-helper' } })
    // …while HTTP mode still refuses it, for exactly those reasons.
    expect(routeForRecord(record, { mode: 'http' })).toMatchObject({ problem: { code: 'E_PROXY_PORT_UNASSIGNED' } })
  })

  test('every VPN refusal is named after the thing that is actually wrong', () => {
    // An HTTP upstream cannot be a VPN route: the guest agent speaks SOCKS5.
    const http = routeForRecord(readProxyRecord({ ...vpnBase, upstream: { ...vpnBase.upstream, proto: 'http' } }), { mode: 'vpn', hasPassword: true })
    expect(http).toMatchObject({ problem: { code: 'E_PROXY_VPN_UPSTREAM_NOT_SOCKS5', kind: 'refusal' } })
    expect('problem' in http ? http.problem.message : '').toMatch(/Apply it as an HTTP proxy instead/)

    // An account with no saved password. A precondition, not an error — and the
    // message says why a half credential is worse than none: an upstream that
    // also takes IP-whitelist auth answers it with a different exit, silently.
    const noPassword = routeForRecord(readProxyRecord(vpnBase), { mode: 'vpn', hasPassword: false })
    expect(noPassword).toMatchObject({ problem: { code: 'E_PROXY_VPN_NO_PASSWORD', kind: 'precondition' } })

    // …but an upstream that names no account at all is anonymous, not broken.
    // Refusing it would be inventing a requirement the upstream never stated.
    const anonymous = routeForRecord(readProxyRecord({ ...vpnBase, upstream: { ...vpnBase.upstream, username: '' } }), { mode: 'vpn', hasPassword: false })
    expect(anonymous).toEqual({ route: { engine: 'vpn-helper', host: 'proxy.soax.com', port: 5000 } })

    // An upstream nobody has filled in yet — the migrated shape's own state.
    const incomplete = routeForRecord(readProxyRecord({ ...vpnBase, upstream: { ...vpnBase.upstream, host: '' } }), { mode: 'vpn', hasPassword: true })
    expect(incomplete).toMatchObject({ problem: { code: 'E_PROXY_VPN_UPSTREAM_INCOMPLETE', kind: 'precondition' } })

    // And `hasPassword` unstated is never turned into a refusal: the browser
    // half cannot read a secret row, and a screen must not refuse on a fact it
    // did not check.
    expect(routeForRecord(readProxyRecord(vpnBase), { mode: 'vpn' })).toMatchObject({ route: { engine: 'vpn-helper' } })
  })

  test('the guest agent is named as the cause when a device cannot take a VPN route', () => {
    // Plan 114 step 114.7's five states, in a pack that cannot render its panel.
    // What it CAN do is refuse by name and point at the screen that has the
    // button — never fail silently, and never quietly apply an HTTP proxy.
    expect(vpnAgentProblem('ready')).toBeNull()
    for (const state of ['absent', 'provisioning', 'outdated', 'failed']) {
      const problem = vpnAgentProblem(state)
      expect(problem?.code).toBe('E_PROXY_AGENT_NOT_READY')
      // A precondition, not an error: plan 59's rule, and plan 106's — the agent
      // is not ready YET.
      expect(problem?.kind).toBe('precondition')
      expect(problem?.message).toMatch(/guest agent/)
    }
    // `unsupported` is the one refusal, because an old phone is not a broken one
    // and offering a retry on it is how a device reports an error nobody can
    // ever clear (plan 106, and the built-in's own `vpnPrecondition`).
    expect(vpnAgentProblem('unsupported')).toMatchObject({ code: 'E_PROXY_AGENT_UNSUPPORTED', kind: 'refusal' })
    // It says so in words rather than merely omitting a button this pack could
    // not render anyway — "no retry offered" is invisible; "there is nothing to
    // retry here" is the fact.
    expect(vpnAgentProblem('unsupported')?.message).toMatch(/nothing to retry here/)
    // A word this build does not know is not a refusal it can justify — the
    // farm's own door checks the agent again anyway.
    expect(vpnAgentProblem('something-newer')).toBeNull()
    expect(vpnAgentProblem('')).toBeNull()
  })

  test('a VPN that cannot be applied is never downgraded to an HTTP proxy', async () => {
    /**
     * Plan 114 §3.4 rule 4, §3.9's bulk repeat of it, and the reason this pack
     * has two modes rather than one clever one: a silent downgrade is invisible
     * — the row would read "applied" either way — and it leaves an operator
     * believing traffic is captured when an app can walk straight past it.
     *
     * Asserted against the source as well as against the behaviour above,
     * because the failure this guards is a future edit adding a fallback that
     * every unit test would still pass.
     */
    const apply = await Bun.file(join(HERE, 'service/apply.ts')).text()
    // The mode travels to `routeForRecord` and is never reassigned on a failure
    // path. One assignment, from the input, and nothing writes to it after.
    expect(apply).toMatch(/const mode: ProxyApplyMode = input\.mode \?\? 'http'/)
    expect(apply).not.toMatch(/mode = 'http'|mode = 'vpn'/)
    // An unknown mode is refused rather than defaulted — a silent downgrade
    // arriving through a typo is still a silent downgrade.
    expect(apply).toContain('E_PROXY_BAD_MODE')
  })

  test('the credential reaches a VPN route inline, and nothing on the way records it', async () => {
    const apply = await Bun.file(join(HERE, 'service/apply.ts')).text()
    // `credentialRef` would name a row in the farm's `network_credentials`
    // table, and there is no capability that lets a plugin create one — so the
    // inline pair is the path, and the built-in's own `normalizeDeclaredConfig`
    // is what encrypts it and persists only a reference.
    expect(apply).toContain('proxySecretKeyFor')
    expect(apply).not.toMatch(/credentialRef:/)
    // The password is read ONLY for the mode that spends it: an HTTP apply must
    // not pull a plaintext into this process for a call that cannot carry one.
    //
    // Plan 117 §3.6 gave this a THIRD branch — a `direct` record's VPN route
    // reads its own listener credential instead of `readPassword` — so the
    // check below is loosened to the invariant that still has to hold: the
    // read is gated on `mode === 'vpn'`, never unconditional.
    expect(apply).toMatch(/const password = mode === 'vpn' \?/)
    expect(apply).toContain('await readPassword(host, proxyId)')
    // Nothing from the far side is re-thrown or serialised — `socks` puts the
    // whole config, password included, on `err.options` (`errors.ts`).
    expect(apply).toContain('scrubSecrets')
    expect(apply).not.toMatch(/JSON\.stringify\(err|String\(err\)/)
    // And the log line names the proxy and the engine, never the route object.
    expect(apply).not.toMatch(/log\.(info|warn)\([^)]*route/)
  })

  test('the screen offers exactly two modes, and says what each one is at the point of choice', async () => {
    expect(PROXY_APPLY_MODES).toEqual(['http', 'vpn'])
    expect(Object.keys(PROXY_APPLY_MODE_LABELS).sort()).toEqual([...PROXY_APPLY_MODES].sort())
    const ui = await readUi('parts/assignments.tsx')
    // The sentence is rendered under the closed picker, not inside the dropdown
    // items: the state an operator sits in before pressing Apply is the closed
    // one, and a description only visible while a menu is open is not "at the
    // point of choice" (plan 114 §3.1 rule 1).
    expect(ui).toContain('PROXY_APPLY_MODE_DESCRIPTIONS[mode]')
    expect(ui).toContain('VPN_CREDENTIAL_WARNING')
    // The mode goes out with the request rather than being inferred server-side
    // from the record — the choice is the operator's, and most records can be
    // applied both ways.
    expect(ui).toMatch(/json: \{ stableId, mode: modeFor\(stableId\) \}/)
    // The default is the mode that keeps the account on this machine. A default
    // that shipped a saved password to a phone on a first unread click would be
    // the credential decision made for the operator.
    expect(ui).toMatch(/const DEFAULT_MODE: ProxyApplyMode = 'http'/)
  })
})

describe('the surface', () => {
  test('parses through PluginSurfaceSchema', () => {
    const parsed = PluginSurfaceSchema.safeParse(surfaceOf())
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  test('passes the same validatePluginSurface the farm runs at verify', () => {
    const checked = validatePluginSurface(surfaceOf())
    expect(checked.ok ? [] : checked.errors).toEqual([])
  })

  test('every nav entry names a view this surface declares, with an allowlisted icon', () => {
    const surface = surfaceOf()
    expect(surface.nav.length).toBe(1)
    for (const entry of surface.nav) {
      expect(Object.keys(surface.views)).toContain(entry.view)
      expect(ICON_NAMES).toContain(entry.icon)
    }
  })

  test('the view is tier C — a React module, and no declared renderer beside it', () => {
    const view = viewOf('proxies')
    expect(view.react).toEqual({ entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION })
    // `table` and `react` are mutually exclusive at verify; asserting it here
    // as well is what catches a half-finished revert that leaves both.
    expect(view.table).toBeUndefined()
  })

  test('the tier-A vocabulary is gone rather than left beside the React view', () => {
    // 00-overview §4.3: no weaker parallel path kept "for one release". A
    // tier-C view calls `fetch` directly (plan 111 §3.4), so this pack
    // declares no data source and no actions at all.
    const surface = surfaceOf()
    expect(surface.actions).toEqual({})
    expect(viewOf('proxies').data).toBeUndefined()
    expect(viewOf('proxies').toolbar).toEqual([])
    expect(viewOf('proxies').rowActions).toEqual([])
  })

  test('the entry the manifest names is the file the build will produce', async () => {
    // `enkaku publish` builds every top-level source file in `src/ui/` into
    // `ui/<name>.js`, so `index.tsx` is what makes `entry: 'index.js'` true.
    // A rename of one without the other publishes a package whose view 404s.
    expect(await Bun.file(join(HERE, 'ui', 'index.tsx')).exists()).toBe(true)
    expect(viewOf('proxies').react?.entry).toBe('index.js')
  })

  test('the stylesheet is named after the entry, which is what makes Studio link it', async () => {
    // Convention, not a manifest field (plan 111 step 111.9): `index.tsx` →
    // `index.css` → `ui/index.css` → the `<link>` the host injects.
    expect(await Bun.file(join(HERE, 'ui', 'index.css')).exists()).toBe(true)
  })

  test('the stylesheet imports utilities only — a second preflight would restyle Studio', async () => {
    const css = await Bun.file(join(HERE, 'ui', 'index.css')).text()
    expect(css).toContain("@import 'tailwindcss/utilities.css' layer(plugin);")
    expect(css).toContain("@import 'tailwindcss/theme.css' theme(reference);")
    expect(css).toContain("@import '@enkaku/ui/theme.css' theme(reference);")
    // The one DIRECTIVE that must never appear: it pulls in the global reset.
    // Anchored to the start of a line, because the file's own comment warns
    // against it by name and that warning is not an import.
    expect(css).not.toMatch(/^\s*@import\s+['"]tailwindcss['"]/m)
  })

  /**
   * The layer name is load-bearing and this assertion exists because the wrong
   * one shipped and was caught in a browser, not by a test (plan 111 §5 111.9's
   * correction block).
   *
   * `layer(utilities)` puts this sheet in the SAME layer as Studio's own
   * utilities. Same-named layers merge, and inside a layer document order
   * breaks ties — the host injects this `<link>` AFTER its own stylesheet, so
   * every collision at equal specificity went to the plugin. The observed
   * result: this pack emitted `.flex{display:flex}` (its markup uses `flex`),
   * which outranked Studio's `.lg\:hidden{display:none}` and un-hid Studio's
   * mobile header on a 1426 px screen. This file never mentioned `lg:hidden`.
   *
   * Paired assertion, so reverting the fix fails rather than passing quietly.
   */
  test('the stylesheet lands in the plugin layer, which Studio orders BELOW its own utilities', async () => {
    const css = await Bun.file(join(HERE, 'ui', 'index.css')).text()
    expect(css).toContain('layer(plugin)')
    expect(css).not.toContain('layer(utilities)')

    // Control: the order this depends on is declared by the host, and declared
    // BEFORE `utilities`. Without that line `plugin` would be appended last and
    // win again — the same bug with a different name, so assert position, not
    // mere presence.
    const globals = await Bun.file(join(HERE, '..', '..', '..', 'packages', 'studio', 'src', 'app', 'globals.css')).text()
    const order = globals.match(/@layer\s+([a-z,\s]+);/)?.[1] ?? ''
    const names = order.split(',').map((s) => s.trim())
    expect(names).toContain('plugin')
    expect(names.indexOf('plugin')).toBeLessThan(names.indexOf('utilities'))
  })

  test('the screen writes classes Studio does not have, or the stylesheet would be pointless', async () => {
    const source = await readUi('index.tsx')
    expect(source).toContain('bg-[repeating-linear-gradient(')
    expect(await readUi('parts/catalogue.tsx')).toContain('grid-cols-[max-content_1fr]')
  })

  test('the module registers the view id the manifest declares', async () => {
    const source = await readUi('index.tsx')
    expect(source).toContain("window.__enkaku__.register('proxies'")
    expect(Object.keys(surfaceOf().views)).toEqual(['proxies'])
  })
})

describe('the shape the screen writes is the shape a record is', () => {
  /**
   * The drift guard, moved rather than dropped (see `record.ts`'s header).
   * Tier A got this for free by deriving its form and its columns from one Zod
   * object; a hand-written React dialog gets it by funnelling every write
   * through `writeProxy` and every read through `readProxy`, and by this test
   * actually RUNNING both against the schema.
   */
  test('what the screen writes round-trips through what it reads, and parses as a ProxyRecord', () => {
    const typed = {
      label: 'Office UK',
      listen: { proto: 'http' as const, bindHost: '127.0.0.1', port: 9902 },
      upstream: { proto: 'socks5' as const, host: '10.4.0.9', port: 1080, username: 'country-id-r9931204', bindAddress: '', resolveThroughEgress: true },
      enabled: false,
      logDestinations: false,
      maxConnections: DEFAULT_MAX_CONNECTIONS,
      drainMs: DEFAULT_DRAIN_MS,
      capacity: 0,
      exclusive: false,
      listenerAuth: false,
      notes: 'expires in March',
    }
    const stored = writeProxy(typed)
    expect(Object.keys(stored)).toEqual(RECORD_FIELDS)
    const parsed = ProxyRecordSchema.safeParse(stored)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(readProxy(stored)).toEqual(typed)
  })

  test('a stored row this pack never wrote renders as blanks instead of throwing inside a table', () => {
    // A KV namespace is the plugin's own scratch space and an admin with
    // `kv.manage` can put anything under `proxy:`. A row that threw while
    // rendering would take the whole tab down through the error boundary.
    const fallback = readProxy({ nonsense: true })
    expect(Object.keys(fallback)).toEqual(RECORD_FIELDS)
    expect(fallback.upstream.proto).toBe('socks5')
    expect(readProxy(null).upstream.host).toBe('')
  })

  test('the browser half and the service half read a record through the SAME function', async () => {
    // The drift this pack has always guarded against, now across three
    // compiled halves instead of two. `api.ts` must delegate rather than
    // re-implement, because a second reader in the browser would disagree
    // with the one the core opens sockets on the strength of.
    const api = await Bun.file(join(HERE, 'ui', 'parts', 'api.ts')).text()
    expect(api).toContain('readProxyRecord')
    expect(api).toContain('writeProxyRecord')
    // …and it does not carry its own copy of the field list any more.
    expect(api).not.toMatch(/kind:\s*PROXY_KINDS\.find/)
  })

  test('the catalogue is read from the plugin’s own GLOBAL storage, under the proxy: prefix', async () => {
    // Global because a proxy catalogue is not a fact about one phone — plan
    // 108 §3.1: if forgetting the device should forget the fact, it is
    // device-scoped. Forgetting a phone must not empty this table.
    const source = await readUi('parts/catalogue.tsx')
    expect(source).toContain('/data?scope=global&prefix=${encodeURIComponent(PROXY_KEY_PREFIX)}')
    expect(source).toContain("scope: 'global'")
    expect(PROXY_KEY_PREFIX).toBe('proxy:')
  })

  test('an assignment is device-scoped, because forgetting the phone SHOULD forget it', async () => {
    const source = await readUi('parts/assignments.tsx')
    expect(source).toContain("scope: 'device'")
    expect(source).toContain('key: ASSIGNMENT_KEY')
    expect(ASSIGNMENT_KEY).toBe('assigned')
  })

  test('the transport is a closed list, so no row can hold "socks 5"', () => {
    const proto = ProxyRecordSchema.shape.upstream.unwrap().shape.proto
    expect(proto.safeParse('socks 5').success).toBe(false)
    for (const kind of PROXY_KINDS) expect(proto.safeParse(kind).success).toBe(true)
    // And every one of them has a label the screen can show — a missing entry
    // here renders `undefined` in a badge.
    expect(Object.keys(PROXY_KIND_LABELS).sort()).toEqual([...PROXY_KINDS].sort())
  })

  test('the service is declared, with nothing it does not need', () => {
    const service = plugin.service
    if (!service) throw new Error('the pack declares no service — plan 112 step 112.7 is what makes this pack run anything')
    /**
     * Plan 112 §4.5 wrote `permissions: []` here, to keep plan 109 step 109.3's
     * capability broker off that plan's critical path. Step 114.9 changed it,
     * on purpose and with a version bump — the exhaustive list is asserted in
     * its own test above, which is the one place it belongs. What is left here
     * is everything else the service declares.
     */
    expect(service.events).toEqual([])
    expect(service.isolation).toBe('in-process')
    // The listener is DECLARED as a shape, not reserved — and it does not
    // claim device reachability, which is step 112.11 and plan 109 steps
    // 109.9–109.11.
    expect(service.listeners.length).toBe(1)
    expect(service.listeners[0]?.id).toBe('proxy-bridge')
    expect(service.listeners[0]?.proto).toBe('tcp')
    expect(service.listeners[0]?.deviceReachable).toBe(false)
    expect(service.listeners[0]?.port).toBeUndefined()
  })

  test('the screen’s door is `ctx.onRequest`, and the supervisor is the only owner of a bridge’s state (step 112.9)', async () => {
    const source = await Bun.file(join(HERE, 'index.ts')).text()
    // Registered from `setup`, so every route is dropped when the service
    // stops — which is what makes a request to a stopped service refuse as
    // *not running* rather than as *no such screen* (plan 109 step 109.6's
    // refusal order, inherited rather than re-derived).
    expect(source).toContain('registerProxyRoutes(ctx, supervisor)')
    /**
     * And the shortcut plan 112 §4.6 names is still refused rather than built:
     * the screen writing `enabled: true` into KV and the service polling its
     * own namespace on a timer. A `setInterval` in this file would be that
     * second lifecycle arriving by the back door.
     */
    expect(source).not.toMatch(/setInterval|setTimeout/)
  })

  test('the storage key is not one of the record’s fields, and the rule about it is still stated', () => {
    // A rename is structurally impossible: the write upserts and cannot move
    // an entry, so the Edit dialog disables the key rather than offering one.
    expect(RECORD_FIELDS).not.toContain('key')
    expect(PROXY_KEY_HINT).toContain(PROXY_KEY_PREFIX)
    expect(PROXY_KEY_HINT).toMatch(/still saved, but will not appear/)
  })
})

/**
 * ## The credential gap, closed on the store side by step 112.2
 *
 * This pack is the first thing in the repo that wants to put a real credential
 * in KV, and the store used to leak part of every secret onto the row's own
 * `hint` column — `list()` kept it, and every HTTP path returned it, to anyone
 * holding `plugin.data` (plan 112 F12), with no way to turn it off.
 *
 * **Step 112.2 landed** (`KvSetOptions.hint`, default `true`), and these tests
 * were the red ones that said so: they were written to fail the day it did.
 * They are not deleted, they are inverted — the same detector, now asserting
 * the presence of the opt-out instead of its absence, so a revert of the core
 * change lands here as a failure in the pack that depends on it rather than
 * silently restoring the leak.
 *
 * They assert against the CORE's own source rather than importing it, because
 * a plugin has no dependency on `enkaku-core` and should not grow one. The
 * behavioural proof — that a `hint: false` row answers `null` on every read
 * path — lives where it can actually run a store:
 * `packages/core/src/kv/store.test.ts` and `packages/core/src/api/plugins-data.test.ts`.
 *
 * Each claim keeps the two controls plan 109 step 109.5 requires: that the
 * thing being looked for is real, and that the detector would report the
 * opposite if the opposite were true.
 */
describe('step 112.2 landed: the KV write path can be told not to store a hint', () => {
  const REPO = join(HERE, '..', '..', '..')
  const SECRETS_STORE = join(REPO, 'packages', 'core', 'src', 'secrets', 'store.ts')
  const KV_STORE = join(REPO, 'packages', 'core', 'src', 'kv', 'store.ts')
  const IPC = join(REPO, 'packages', 'session', 'src', 'runner', 'ipc.ts')
  const PLUGIN_ROUTES = join(REPO, 'packages', 'core', 'src', 'api', 'plugins.ts')

  /** Reading the core's source is the whole mechanism; a missing file must fail loudly, never skip. */
  async function coreSource(path: string): Promise<string> {
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`this guard reads the core's own source and could not find ${path} — if the file MOVED, move this test with it; do not delete it`)
    return await file.text()
  }

  /** Does `KvSetOptions` carry the `hint` flag step 112.2 added? */
  function hasHintOption(source: string): boolean {
    const start = source.indexOf('export interface KvSetOptions')
    if (start === -1) throw new Error("`KvSetOptions` is no longer declared in packages/core/src/kv/store.ts — this guard's anchor moved")
    const body = source.slice(start, source.indexOf('\n}', start))
    return /^\s*hint\??\s*:/m.test(body)
  }

  test('control 1 — the leak the option exists for is real: `secretHint` still returns the first seven and the last four characters', async () => {
    const source = await coreSource(SECRETS_STORE)
    expect(source).toContain('export function secretHint(plaintext: string): string')
    expect(source).toContain('plaintext.slice(0, 7)')
    expect(source).toContain('plaintext.slice(-4)')
    // `secretHint` is deliberately UNCHANGED by 112.2 — the fix is not to
    // weaken the hint (an API key with a public prefix still wants one), it is
    // to let a caller storing a credential decline it. And `shared.ts`'s
    // reimplementation still agrees, so the measurement below is of the real
    // algorithm rather than of a guess about it.
    expect(secretHintLeak('sk-ant-api03-abcdefgh7Xq2')).toBe('sk-ant-…7Xq2')
    expect(secretHintLeak('short')).toBe('••••')
  })

  test('control 2 — the detector reads a synthetic `KvSetOptions` both ways round', () => {
    const fixed = 'export interface KvSetOptions {\n  secret?: boolean\n  hint?: boolean\n  ttlSec?: number\n}'
    expect(hasHintOption(fixed)).toBe(true)
    // Still the control that matters most: if the core change were reverted,
    // this detector would say so rather than keep passing on a stale match.
    const unfixed = 'export interface KvSetOptions {\n  secret?: boolean\n  ttlSec?: number\n}'
    expect(hasHintOption(unfixed)).toBe(false)
  })

  test('THE CLAIM — `hint: false` exists, and the store honours it at the one place the hint is computed', async () => {
    const source = await coreSource(KV_STORE)
    expect(hasHintOption(source)).toBe(true)
    // `secretHint` is no longer called unconditionally for every secret write:
    // it is guarded by the option, whose default is `true`.
    expect(source).not.toContain('const hint = secret ? secretHint(')
    expect(source).toMatch(/const wantsHint = opts\?\.hint \?\? true/)
    expect(source).toMatch(/const hint = secret && wantsHint \? secretHint\(/)
  })

  test('and it reaches the store through every door a caller can knock on', async () => {
    // The wire shape a job/plugin child sends over IPC…
    expect(await coreSource(IPC)).toMatch(/hint: z\.boolean\(\)\.optional\(\)/)
    // …and the operator-facing HTTP body, `PUT /:name/data/entry`. Both
    // optional, both meaning `true` when absent, so nothing written before
    // 112.2 changed behaviour.
    const routes = await coreSource(PLUGIN_ROUTES)
    expect(routes).toMatch(/hint: z\.boolean\(\)\.optional\(\)/)
    expect(routes).toContain('const opts = { secret: body.secret, hint: body.hint, ttlSec: body.ttlSec }')
  })

  test('what a stored credential would leak WITHOUT the option, measured rather than asserted', async () => {
    // Why the object shape stays even now the hint can be declined: `hint` is
    // per write, not per key (`KvSetOptions.hint`), so a single write that
    // forgets it falls back to hinting — and what it would hint is the
    // difference between two characters and eleven. The store hints the JSON
    // when the value is not a string. Measured against the real farm on
    // 2026-08-17: writing `{"password":"Sup3r…"}` with `secret: true` produced
    // `hint: '{"passw…rd"}'`.
    const password = 'Sup3rSecretUpstreamPassword'
    const asObject = secretHintLeak({ password })
    const asString = secretHintLeak(password)
    expect(asObject).toBe('{"passw…rd"}')
    expect(asString).toBe('Sup3rSe…word')
    // The object form leaks the tail of the password and the string form leaks
    // both ends of it. `hint: false` leaks neither, and the object shape is the
    // belt to that pair of braces.
    expect(asString).toContain(password.slice(0, 7))
    expect(asObject).not.toContain(password.slice(0, 7))
    void (await coreSource(SECRETS_STORE))
  })

  test('the pack now writes a credential, on the key the supervisor reads, through the flag 112.2 added', async () => {
    const supervisor = await Bun.file(join(HERE, 'service', 'supervisor.ts')).text()
    const catalogue = await readUi('parts/catalogue.tsx')
    // The supervisor READS it, in-process, where a plaintext secret is allowed
    // to be — `ctx.storage.global.getRaw` decrypts, and there is no path from
    // there to a browser.
    expect(supervisor).toContain('proxySecretKeyFor')
    expect(proxySecretKeyFor('x')).toBe('proxy-secret:x')
    // …and the screen WRITES it, through `plugin.data`, with the option that
    // keeps the hint column null.
    expect(catalogue).toMatch(/data\/entry[\s\S]{0,400}proxySecretKeyFor/)
    expect(catalogue).toContain('secret: true, hint: false')
    /**
     * The two prefixes stay disjoint, which is what keeps the credential off
     * the catalogue's own list — a property of the strings, not of a filter
     * anyone has to remember. The screen's THIRD read asks for the other prefix
     * on purpose, to learn which records have a password; `list()` never
     * decrypts, so that read can only ever return keys.
     */
    expect(PROXY_SECRET_KEY_PREFIX.startsWith(PROXY_KEY_PREFIX)).toBe(false)
    expect(catalogue).toContain('PROXY_SECRET_KEY_PREFIX')
    expect(catalogue).not.toMatch(/secrets\.get\(|\.password\b[\s\S]{0,40}textContent/)
  })

  test('deleting a record deletes its credential too, so no orphan is inherited', async () => {
    /**
     * `proxy-secret:<id>` is not in the catalogue's own prefix listing, so an
     * orphan is invisible — and the derived key makes inheriting one plausible
     * rather than theoretical: delete "SOAX Japan", add another, and the second
     * derives `proxy:soax-japan` again and would pick up the first one's
     * password without anybody choosing it.
     */
    const catalogue = await readUi('parts/catalogue.tsx')
    const remove = catalogue.slice(catalogue.indexOf('async function remove('), catalogue.indexOf('const forceState'))
    expect(remove).toContain('deleteEntry(row.key)')
    expect(remove).toContain('deleteEntry(proxySecretKeyFor(row.id))')
  })
})

/**
 * Plan 117 step 117.11 — criterion 12: the pack stays generic (§0.1, §3.3,
 * §3.9). No string in `src` names a vendor, a network technology, or a
 * physical address — the owner's own correction is that a farm-specific
 * detail belongs in the operator's own log of one site's setup, never in
 * first-party code.
 *
 * **The three forbidden words are assembled from fragments below, and
 * deliberately never written whole anywhere in this file.** The criterion
 * this test proves is a literal, case-insensitive grep over every file in
 * `src` — including this one — so a comment that spelled a word out in full
 * would fail the very check it exists to run, which is exactly the defect
 * this test is for.
 */
describe('criterion 12 — nothing about any particular network (§0.1, §3.3)', () => {
  const FORBIDDEN_WORDS = [['mikro', 'tik'].join(''), ['vl', 'an'].join(''), ['mo', 'dem'].join('')]
  const FORBIDDEN_PATTERN = new RegExp(FORBIDDEN_WORDS.join('|'), 'i')

  async function walk(dir: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) files.push(...(await walk(full)))
      else files.push(full)
    }
    return files
  }

  test('the equivalent of `grep -ri` over the three forbidden words returns nothing, anywhere in src', async () => {
    const files = await walk(join(HERE))
    const hits: { file: string; line: number; text: string }[] = []
    for (const file of files) {
      const text = await Bun.file(file).text()
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (FORBIDDEN_PATTERN.test(lines[i] ?? '')) hits.push({ file, line: i + 1, text: (lines[i] ?? '').trim() })
      }
    }
    expect(hits).toEqual([])
  })

  test('control — the detector actually catches the words it is looking for', () => {
    // The two controls plan 109 step 109.5 asks of an absence claim: the
    // negative case above, and this positive one proving the detector would
    // fire on the words it is supposed to catch, in every case variation.
    for (const word of FORBIDDEN_WORDS) {
      expect(FORBIDDEN_PATTERN.test(`a line mentioning ${word} somewhere in it`)).toBe(true)
      expect(FORBIDDEN_PATTERN.test(`a line mentioning ${word.toUpperCase()} somewhere in it`)).toBe(true)
    }
    expect(FORBIDDEN_PATTERN.test('a line about ordinary networking, nothing vendor-specific')).toBe(false)
  })
})

/**
 * Plan 117 step 117.11 — criterion 10: a record that has not passed a probe
 * reads `unverified` on the screen, and no string in the catalogue's status
 * column can read `ok`, `routed`, `verified`, or `success` for such a record —
 * "in the spirit of plan 51's own criterion 8" (the task's own words), which
 * is exactly the standing rule `PROXY_PROBE_STATE_LABELS`'s own doc comment
 * already names.
 */
describe('criterion 10 — a record with no passed probe is never worded as anything but unverified', () => {
  test('the three words the state can ever be, and none of them is a forbidden one', async () => {
    const { PROXY_PROBE_STATE_LABELS, PROXY_PROBE_STATES } = await import('./shared')
    expect([...PROXY_PROBE_STATES].sort()).toEqual(['confirmed', 'skip', 'unverified'])
    for (const word of Object.values(PROXY_PROBE_STATE_LABELS)) {
      expect(word).not.toMatch(/\b(ok|routed|verified|success)\b/i)
    }
  })

  test('control — the same check WOULD fire on any of the four forbidden words, so the assertion above is not vacuous', () => {
    for (const forbidden of ['ok', 'routed', 'verified', 'success', 'OK', 'Verified']) {
      expect(`Status: ${forbidden}`).toMatch(/\b(ok|routed|verified|success)\b/i)
    }
  })

  test('ProbeCell — the catalogue’s own Egress column — renders ONLY PROXY_PROBE_STATE_LABELS[state], never a word of its own', async () => {
    const catalogue = await readUi('parts/catalogue.tsx')
    const start = catalogue.indexOf('function ProbeCell(')
    expect(start).toBeGreaterThan(-1)
    const body = catalogue.slice(start, catalogue.indexOf('\n}\n', start))
    // The one line that decides the badge's word — anchored, so a rewrite
    // that hard-codes a state word instead of reading the shared vocabulary
    // fails here rather than merely by coincidence not containing "ok".
    expect(body).toContain('PROXY_PROBE_STATE_LABELS[state]')
    expect(body).not.toMatch(/\b(ok|routed|verified|success)\b/i)
    // `probe.ok` itself is read only to decide the STATE (via `proxyProbeState`,
    // called once, above this component) — this component never branches on
    // it directly for its own wording.
    expect(body).not.toMatch(/probe\.ok/)
  })

  test('a record that has never been probed at all is `unverified`, not merely "not yet confirmed" worded some other way', async () => {
    const { proxyProbeState } = await import('./shared')
    expect(proxyProbeState(null)).toBe('unverified')
  })
})
