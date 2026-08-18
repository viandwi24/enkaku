import type { ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { sleep } from './human'
import { centerOf, flatten } from './tree'
import { ACK_SELECTORS, DENY_SELECTORS } from './dialogs'

/**
 * The modal REGISTER (plan 113 §3.4, §4.2) — what replaces `dialogs.ts`'s two closed allow-lists
 * for the post-video flow. `dialogs.ts`'s reasoning is kept verbatim and is not weakened here: a
 * closed list that only ever taps a label it explicitly recognises is the entire safety property,
 * and this file's `GRANT_TERMS`/`OTHER_NEVER_TERMS`/`assertNeverList` is that same rule promoted
 * from a comment to a guard (§3.4 item 3).
 *
 * What changed is the assumption underneath `dialogs.ts`: that clearing a dialog always means
 * refusing it. E6 (the hardware walk, plan 113 §0.2) found a dialog that must be ALLOWED — the
 * media-access permission — and a deny-everything sweep does not fail loudly there; it makes the
 * gallery unreachable and lets the run fail later, somewhere else, for a reason that looks
 * unrelated. So an entry here names its IDENTITY once and then a small set of POSSIBLE actions,
 * and the caller (a member's own policy map, e.g. `UPLOAD_MODAL_POLICIES`) says which one it wants
 * for its flow — denying the camera is right while uploading a file and would be wrong while
 * recording one.
 */

export type ModalPolicy = 'allow' | 'deny' | 'ack' | 'ignore' | 'abort'

export interface ModalEntry {
  /** Stable, referenced by `sweepModals`'s returned `cleared` list and by a caller's policy map. */
  id: string
  /**
   * How this dialog is RECOGNISED — never how it is dismissed. `id` and `textIncludes` combine
   * with AND when both are set (needed for `sys.camera`/`sys.microphone`/`sys.media`, which all
   * render `permission_message` at the exact same id and are distinguished only by what that one
   * node's text says). `textIncludes` alone is an OR across the array: the message CONTAINS any
   * one of the listed substrings. That reading is deliberate for `tt.notice`, whose whole point is
   * "any of several equivalent acknowledgement labels" (see its entry below) — and it is looser
   * than strictly necessary for `tt.discard-draft`'s two-button pair, where either label alone
   * would already be a safe, distinctive match (neither string is used anywhere else in the app's
   * exit-editor flow). A stricter "all of textIncludes must be present" rule would fit
   * `tt.discard-draft` more tightly but cannot express `tt.notice` at all, and `tt.notice` is the
   * entry this design exists to cover — see the note on `actions` below.
   */
  match: { id?: string; textIncludes?: string[] }
  /**
   * What each policy taps. A policy absent here cannot be chosen for this entry — `sys.media` has
   * no `deny` key at all, so a caller that mistakenly asked for one gets `E_MODAL_UNHANDLED` from
   * `sweepModals` rather than a silent no-op or a wrong tap. This mirrors why
   * `permission_allow_selected_button` is never named anywhere in this file (§4.2): limited access
   * opens a per-item picker that no unattended run can maintain, so `allow` for `sys.media` names
   * ONLY `permission_allow_all_button`.
   */
  actions: Partial<Record<'allow' | 'deny' | 'ack', Selector>>
  /** Where this was confirmed, so a future reader knows what it is worth. */
  seen: { device: string; app: string; locale: string; at: string }
}

const SEEN_POST = { device: 'moto g06 power (ZP2222RMBS)', app: 'com.ss.android.ugc.trill', locale: 'id-ID', at: '2026-08-18' }

const SEEN = {
  device: 'moto g06 power (ZP2222RMBS)',
  app: 'com.ss.android.ugc.trill',
  locale: 'id-ID',
  at: '2026-08-17',
} as const

/**
 * Every android system id this register's actions tap, mapped to the label it was confirmed to
 * carry on hardware (plan 113 §0.2, the two `permissioncontroller` fixtures). Ids, not text, are
 * what `actions` names — ids survive an app update and a locale change; text does not (E10). This
 * map exists ONLY so `assertNeverList` can judge an id-based action by the label it is known to
 * mean, without the register itself ever tapping text directly for a system dialog.
 */
const KNOWN_ID_LABELS: Record<string, string> = {
  'com.android.permissioncontroller:id/permission_allow_all_button': 'Izinkan semua',
  'com.android.permissioncontroller:id/permission_allow_selected_button': 'Izinkan akses terbatas',
  'com.android.permissioncontroller:id/permission_deny_button': 'Jangan izinkan',
}

/**
 * The two `ACK_SELECTORS` labels `tt.notice` does NOT reuse — see that entry's own comment for why
 * (found by the fixture-driven test suite, plan 113 §5 step 113.1's testing pass): both also label
 * an ordinary close icon on TikTok's own camera-wall screen, confirmed present in five of the eight
 * checked-in fixtures because that screen's subtree stays mounted underneath every later one.
 */
const GENERIC_CLOSE_LABELS = ['Tutup', 'Close']

/**
 * The register, as walked (plan 113 §4.2). Six entries, three of them system `permissioncontroller`
 * dialogs sharing one id (`permission_message`) and distinguished only by its text, two of them
 * TikTok's own with no id at all (E10), and `tt.notice` reusing `dialogs.ts`'s `ACK_SELECTORS`
 * (imported, not copied) rather than re-litigating which labels count as a safe acknowledgement.
 */
export const TIKTOK_MODALS: ModalEntry[] = [
  {
    id: 'sys.camera',
    match: {
      id: 'com.android.permissioncontroller:id/permission_message',
      textIncludes: ['mengambil gambar dan merekam video'],
    },
    // No `allow`/`ack` — this plan denies the camera outright (§2 Non-goals), so nothing here can
    // ever grant it, structurally, no matter what a caller's policy map says.
    actions: { deny: { id: 'com.android.permissioncontroller:id/permission_deny_button' } },
    seen: SEEN,
  },
  {
    id: 'sys.microphone',
    match: {
      id: 'com.android.permissioncontroller:id/permission_message',
      textIncludes: ['merekam audio'],
    },
    actions: { deny: { id: 'com.android.permissioncontroller:id/permission_deny_button' } },
    seen: SEEN,
  },
  {
    id: 'sys.media',
    match: {
      id: 'com.android.permissioncontroller:id/permission_message',
      textIncludes: ['mengakses foto dan video'],
    },
    // E6: this one MUST be allowed, and specifically "allow all" — `permission_allow_selected_button`
    // ("Izinkan akses terbatas") opens a per-item picker TikTok would then be limited to, which no
    // unattended run can maintain. It is named in the module comment above and nowhere else in this
    // file, on purpose.
    actions: { allow: { id: 'com.android.permissioncontroller:id/permission_allow_all_button' } },
    seen: SEEN,
  },
  {
    id: 'tt.camera-wall',
    // TikTok's own record/camera landing screen, not a true modal — E8: the gallery button
    // underneath (`upload_hot_area`) stays live and clickable while this text is showing. There is
    // nothing to tap FOR this entry; a caller's policy is expected to be `ignore` so `sweepModals`
    // notes it and lets the screen machine (plan 113 §4.3, a later step) reach past it.
    match: { textIncludes: ['mengakses kamera dan mikrofon Anda', 'access your camera and microphone'] },
    actions: {},
    seen: SEEN,
  },
  {
    id: 'tt.widget-prompt',
    // Observed 2026-08-18, on the FIRST successful real post: the instant TikTok accepts the upload
    // and returns to the feed, it offers to add a "Kamera TikTok" 1x1 home-screen widget. It is a
    // true blocking sheet over the feed, it appears only on the post path (which is why the
    // 2026-08-17 walk — stopped at the Post button — never saw it), and it is squarely the kind of
    // thing this register exists for: harmless, unrelated to the task, and fatal to an unattended
    // run that has no answer for it. `deny` declines; nothing here ever adds a widget.
    match: { textIncludes: ['Sentuh lama widget', 'Kamera TikTok', 'Touch and hold the widget', 'TikTok Camera'] },
    actions: { deny: { text: 'Tidak, terima kasih' } },
    seen: SEEN_POST,
  },
  {
    id: 'tt.contacts',
    // Observed 2026-08-18 on the profile screen, immediately after the post-verification step opened
    // it. TikTok's OWN contacts pitch, not the Android permission dialog (`dialogs.ts` already says
    // the two are different and that `permissioncontroller` ids never match this one). "Buka
    // pengaturan" would leave TikTok entirely for the system settings app — a place no automated run
    // can find its way back from — so the only answer this entry offers is the refusal.
    match: { textIncludes: ['izinkan akses ke kontak', 'allow access to your contacts', 'access to your contacts'] },
    actions: { deny: { text: 'Jangan izinkan' } },
    seen: SEEN_POST,
  },
  {
    id: 'tt.discard-draft',
    // E14: raised when leaving the editor. Two buttons, always shown together, no id (E10) — a
    // "text pair" per §4.2. `deny` maps to "Buang" (abandon the draft, a refusal to keep it) and
    // `ack` maps to "Simpan draf" (acknowledge and keep it for later); neither reading is dictated
    // by the plan's own wording ("caller's" — §4.2's table leaves the choice open), so this is a
    // judgment call made here and worth a caller double-checking before relying on it.
    match: { textIncludes: ['Buang', 'Simpan draf'] },
    actions: { deny: { text: 'Buang' }, ack: { text: 'Simpan draf' } },
    seen: SEEN,
  },
  {
    id: 'tt.notice',
    // No stable id (E10, TikTok's own). Identity reuses `dialogs.ts`'s ACK_SELECTORS wholesale —
    // the same closed, hardware-curated list `clearBlockingDialog` already trusts — so ANY notice
    // variant it recognises is recognised here too, not just the one hardware-confirmed instance
    // ("Item Virtual dan pembaruan Kebijakan Reward", button "Mengerti"). `actions.ack` names that
    // one confirmed label as the PREFERRED tap target; `resolveActionTarget` below falls back to
    // whichever ACK_SELECTORS label is actually on screen when the preferred one is not, which is
    // the only way one fixed `Selector` can stand in for a family of equivalent buttons.
    //
    // `GENERIC_CLOSE_LABELS` is excluded from that reuse (found by the fixture-driven test suite,
    // plan 113 §5 step 113.1's testing pass, 2026-08-18): "Tutup"/"Close" ALSO label an ordinary
    // "X" close icon on TikTok's own camera-wall screen (`qgf`, `desc: 'Tutup'`, `clickable: true`)
    // — confirmed present, via that node, in FIVE of the eight checked-in fixtures
    // (screen-camera-wall/editor/exit-modal/picker/preview.json), because the camera-wall subtree
    // stays mounted underneath every later screen (the same fact `screens.ts`'s own `detectScreen`
    // comment documents for `video_record_new_scene_root`). Left in `ACK_SELECTORS` unchanged
    // (`clearBlockingDialog` only ever runs as a last-resort fallback after an anchor wait already
    // failed, a much narrower context) but excluded HERE, because `sweepModals` calls `matchModals`
    // unconditionally on every dump: without this exclusion, `tt.notice` "matched" on nearly every
    // real screen this flow walks, and — with `UPLOAD_MODAL_POLICIES['tt.notice'] === 'ack'` and no
    // "Mengerti" node present to prefer — `resolveActionTarget`'s fallback would have tapped that
    // close icon on a screen with no notice showing at all.
    match: {
      textIncludes: ACK_SELECTORS.filter((s): s is { text: string } => 'text' in s)
        .map((s) => s.text)
        .filter((t) => !GENERIC_CLOSE_LABELS.includes(t)),
    },
    actions: { ack: { text: 'Mengerti' } },
    seen: SEEN,
  },
]

/**
 * The upload flow's own choice for each register entry (plan 113 §4.2's "upload policy" column).
 * `tt.discard-draft` is mapped to `abort` here rather than either of its two possible actions:
 * `post-video`'s six-screen walk (§4.3) never intentionally triggers this dialog (no BACK fallback,
 * per §4.2's last paragraph and `dialogs.ts`'s own reasoning for `switch-account`), so seeing it
 * appear mid-run means something already went wrong — the safe response is to stop and say so, not
 * to guess whether the operator wanted the draft kept or thrown away.
 */
export const UPLOAD_MODAL_POLICIES: Record<string, ModalPolicy> = {
  'sys.camera': 'deny',
  'sys.microphone': 'deny',
  'sys.media': 'allow',
  'tt.camera-wall': 'ignore',
  'tt.discard-draft': 'abort',
  'tt.notice': 'ack',
  // Both observed on the 2026-08-18 posting run, both AFTER the Post tap — which is exactly why the
  // 2026-08-17 walk never met them, and why an unattended run that only knew the pre-post modals
  // would have stalled on the very first screen it reached after succeeding.
  'tt.widget-prompt': 'deny',
  'tt.contacts': 'deny',
}

/** `com.app:id/name` or a bare short id — the same rule `matches()` (`@enkaku/protocol`) and `tree.ts`'s `rowsById` use, kept in step with them. */
function nodeMatchesId(node: UiNode, id: string): boolean {
  return node.resourceId === id || node.resourceId.endsWith(`:id/${id}`)
}

/** Prefers `text`, falls back to `desc` — some of this register's nodes (the discard-draft buttons) may carry either. */
function nodeText(node: UiNode): string {
  return node.text || node.desc
}

function matchesIdentity(node: UiNode, match: ModalEntry['match']): boolean {
  if (match.id === undefined && match.textIncludes === undefined) return false
  if (match.id !== undefined && !nodeMatchesId(node, match.id)) return false
  if (match.textIncludes !== undefined) {
    const t = nodeText(node)
    if (!t || !match.textIncludes.some((s) => t.includes(s))) return false
  }
  return true
}

/** True when `sel` describes exactly this node — the same three-way test `matches()` (`@enkaku/protocol`) does, reimplemented locally because that function is not re-exported from the package root. */
function selectorMatchesNode(node: UiNode, sel: Selector): boolean {
  if ('id' in sel) return nodeMatchesId(node, sel.id)
  if ('desc' in sel) return node.desc.trim() === sel.desc.trim()
  if ('text' in sel) return node.text.trim() === sel.text.trim()
  return false // { point } never identifies an EXISTING node — it synthesises one, which is not what a lookup here wants.
}

/**
 * Every register entry whose identity is present somewhere in `root` — depth-first over the whole
 * dumped tree, once. Callers that only need "is anything here" call this directly; `sweepModals`
 * also needs the identity node itself to resolve an action, which `resolveActionTarget` below does
 * with its own walk rather than widening this function's return type.
 */
export function matchModals(root: UiNode, register: ModalEntry[] = TIKTOK_MODALS): ModalEntry[] {
  const nodes = flatten(root)
  return register.filter((entry) => nodes.some((n) => matchesIdentity(n, entry.match)))
}

/**
 * The tap target for `entry`'s `policy`, drawn from the SAME dump `sweepModals` already has —
 * never a fresh `find()`, so a round costs exactly one `dump()` (§3.5's whole point, and §4.3's
 * "sweep modals before each act" only holds together if this stays cheap).
 *
 * Tries the entry's declared action selector first (correct for every entry where the action button
 * is a DIFFERENT node than the one that identified the dialog — `sys.*`'s buttons versus its
 * `permission_message`, `tt.discard-draft`'s two buttons versus their own text). Falls back to
 * whichever node actually satisfied `match.textIncludes` when the declared selector is not present
 * on screen — the case `tt.notice` exists for: its button IS the identifying text, and which of
 * ACK_SELECTORS' several labels is showing varies by notice.
 */
function resolveActionTarget(nodes: UiNode[], entry: ModalEntry, policy: 'allow' | 'deny' | 'ack'): UiNode | null {
  const sel = entry.actions[policy]
  if (sel) {
    const direct = nodes.find((n) => selectorMatchesNode(n, sel))
    if (direct) return direct
  }
  // Locale fallback, and the reason it reuses `dialogs.ts`'s own lists rather than inventing a
  // second vocabulary: every label in this register was read off an id-ID device, the only locale
  // this pack has ever run on. A farm's phones do not all share a language — an SKU sourced in
  // another market arrives in another one — and a `deny` that can only spell "Jangan izinkan" fails
  // there with a message about a missing node rather than about a missing translation.
  //
  // `DENY_SELECTORS` and `ACK_SELECTORS` already carry both the Indonesian and the English
  // spellings, and `assertNeverList` already governs what may appear in them, so borrowing them here
  // widens the locale coverage without widening what this file is allowed to tap.
  const localeFallback = policy === 'deny' ? DENY_SELECTORS : policy === 'ack' ? ACK_SELECTORS : []
  for (const candidate of localeFallback) {
    const hit = nodes.find((n) => n.clickable && selectorMatchesNode(n, candidate))
    if (hit) return hit
  }

  if (entry.match.textIncludes) {
    const fallback = nodes.find((n) => n.clickable && matchesIdentity(n, entry.match))
    if (fallback) return fallback
  }
  return null
}

/**
 * Grant-shaped words are refused ONLY for `allow`/`ack` — an entry's `deny` label routinely
 * CONTAINS one of them as a negation ("Jangan izinkan" = "do not allow"), and that is the label a
 * refusal is SUPPOSED to carry. Checking `deny` labels against this set would make every correct
 * deny button an error.
 */
const GRANT_TERMS = ['izinkan', 'allow']

/**
 * Refused for every policy, `deny` included — a deny action should never end up pointed at a label
 * that follows, buys, subscribes, or accepts terms, negated or not. Lifted from `dialogs.ts`'s own
 * `ACK_SELECTORS` comment, plus the English equivalents that comment names but does not enumerate.
 */
const OTHER_NEVER_TERMS = ['ikuti', 'follow', 'beli', 'berlangganan', 'setuju', 'agree', 'subscribe', 'buy']

/** `{id}` resolves through `KNOWN_ID_LABELS`; `{text}`/`{desc}` carry their own label; `{point}` has none to judge. */
function resolveLabel(sel: Selector): string | null {
  if ('text' in sel) return sel.text
  if ('desc' in sel) return sel.desc
  if ('id' in sel) return KNOWN_ID_LABELS[sel.id] ?? null
  return null
}

/**
 * The safety guard (plan 113 §3.4 item 3, §6 criterion 5) — `dialogs.ts`'s closed-list reasoning
 * promoted from a comment to something a test can call. Throws if any entry anywhere in `register`
 * taps a label that grants beyond the permission it names, buys, subscribes, follows, or accepts
 * terms. `sys.media`'s `allow` → "Izinkan semua" is the ONE deliberate exception (E6: the whole
 * point of that entry IS to grant media access) — carved out by id AND policy, not by label alone,
 * so no OTHER entry can reuse the same label to sneak past this guard.
 */
export function assertNeverList(register: ModalEntry[]): void {
  for (const entry of register) {
    for (const policy of ['allow', 'deny', 'ack'] as const) {
      const sel = entry.actions[policy]
      if (!sel) continue
      const label = resolveLabel(sel)
      if (label === null) continue
      if (entry.id === 'sys.media' && policy === 'allow' && label === 'Izinkan semua') continue
      const lower = label.toLowerCase()
      const terms = policy === 'deny' ? OTHER_NEVER_TERMS : [...GRANT_TERMS, ...OTHER_NEVER_TERMS]
      const hit = terms.find((term) => lower.includes(term))
      if (hit) {
        throw Object.assign(
          new Error(`modal register entry "${entry.id}" (${policy}) taps "${label}", which contains the forbidden term "${hit}"`),
          { code: 'E_MODAL_NEVER_LIST' },
        )
      }
    }
  }
}

/**
 * Clears blocking modals in a loop, bounded by `maxRounds` (default 4) — permission dialogs arrive
 * QUEUED (E5: denying camera returned straight into the microphone prompt), so a one-shot sweep
 * clears one and walks into the next rather than finishing the job.
 *
 * One `dump()` per round, spent on `matchModals` against the WHOLE register, then:
 *  - nothing matched → the sweep is done; return.
 *  - a matched entry has no policy in `policies` → screenshot, `E_MODAL_UNHANDLED`. This is the
 *    register saying "I know what this is" while the caller never said what to do about it — never
 *    guessed at.
 *  - a matched entry's policy is `abort` → screenshot, `E_MODAL_UNHANDLED`. An explicit refusal to
 *    act, not a silent skip.
 *  - a matched entry's policy is `ignore` → recorded in the result, and does NOT by itself end the
 *    round in failure; if nothing else in this round needs a tap, the sweep returns successfully
 *    (an `ignore`-only round means nothing is actually blocking — `tt.camera-wall` per E8 — and
 *    re-dumping would not change that).
 *  - otherwise the matched entry has an actionable policy (`allow`/`deny`/`ack`): ONE is acted on
 *    per round (E5's queueing means tapping can reveal the next dialog, which a stale tree would
 *    never show), then the loop sleeps and re-dumps.
 *
 * Rounds exhausted without the tree ever going quiet → screenshot, `E_MODAL_STUCK`.
 *
 * **No BACK fallback** (§4.2's last paragraph, and `dialogs.ts`'s own reasoning for
 * `switch-account`): the post-video walk is forward, multi-screen; BACK would undo the very step
 * this member just took rather than recover anything.
 */
export async function sweepModals(
  ctx: ScriptContext<unknown>,
  policies: Record<string, ModalPolicy>,
  opts?: { maxRounds?: number },
): Promise<{ cleared: string[] }> {
  const maxRounds = opts?.maxRounds ?? 4
  const cleared: string[] = []
  const record = (id: string) => {
    if (!cleared.includes(id)) cleared.push(id)
  }

  for (let round = 0; round < maxRounds; round++) {
    const tree = await ctx.device.dump()
    const nodes = flatten(tree)
    const matched = matchModals(tree) // one source of truth for identity — see matchModals above
    if (matched.length === 0) return { cleared }

    const actionable: { entry: ModalEntry; policy: 'allow' | 'deny' | 'ack' }[] = []
    for (const entry of matched) {
      const policy = policies[entry.id]
      if (policy === undefined || policy === 'abort') {
        await ctx.artifact.screenshot(`modal-unhandled-${entry.id}`)
        throw Object.assign(
          new Error(
            policy === undefined
              ? `"${entry.id}" matched the register but the caller declared no policy for it`
              : `"${entry.id}" matched with policy "abort" — refusing to guess at a tap`,
          ),
          { code: 'E_MODAL_UNHANDLED' },
        )
      }
      if (policy === 'ignore') {
        record(entry.id)
        continue
      }
      actionable.push({ entry, policy })
    }

    if (actionable.length === 0) return { cleared } // only ignorable entries matched — nothing left to clear

    const { entry, policy } = actionable[0] as { entry: ModalEntry; policy: 'allow' | 'deny' | 'ack' }
    const target = resolveActionTarget(nodes, entry, policy)
    if (!target) {
      await ctx.artifact.screenshot(`modal-unhandled-${entry.id}`)
      throw Object.assign(
        new Error(`"${entry.id}" matched with policy "${policy}" but no on-screen node satisfied its "${policy}" action`),
        { code: 'E_MODAL_UNHANDLED' },
      )
    }
    await ctx.device.tap({ point: centerOf(target.bounds) })
    record(entry.id)
    ctx.log.info(`sweepModals: ${policy} "${entry.id}"`, { round })
    await sleep(800)
  }

  await ctx.artifact.screenshot('modal-sweep-stuck')
  throw Object.assign(new Error(`modal sweep did not settle within ${maxRounds} round(s)`), { code: 'E_MODAL_STUCK' })
}
