import type { ScriptContext } from '@enkaku/sdk'
import type { Selector, UiNode } from '@enkaku/protocol'
import { sleep } from './human'
import { centerOf, flatten } from './tree'
import { ACK_SELECTORS, DENY_SELECTORS } from './dialogs'
import { TIKTOK_INTERRUPTIONS, closeNear } from './interruptions'

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
  match: {
    id?: string
    textIncludes?: string[]
    /**
     * The node's whole label (trimmed, case-insensitive) is one of these — for an entry whose
     * identity IS a short button label (`tt.notice`). A substring match on "OK" or "Skip" matched
     * any text on screen that contained it, the caption being typed included (1.34.0).
     */
    textEquals?: string[]
    /**
     * The entry does NOT match while any node's text contains one of these — for a pair of dialogs that
     * share a button label ("Simpan draf" is on both the exit-editor dialog and the resume-edit banner).
     */
    notWith?: string[]
    /** The identifying node must be drawn on screen, not kept in the tree off to the side. */
    onScreen?: boolean
  }
  /**
   * When set, a match is never answered and `sweepModals` throws THIS code, whatever the caller's
   * policy — for a sheet an operator must see and act on by hand (`tt.security-check`), so `finish`
   * can recognise it and leave it on screen instead of a generic `E_MODAL_UNHANDLED`.
   */
  abortCode?: string
  /** The operator-facing sentence thrown with `abortCode`. */
  abortMessage?: string
  /**
   * Only the declared action's own node is ever tapped — no locale fallback, no identity fallback (1.36.0).
   * For an entry whose buttons sit side by side with another answer that must never be taken by accident:
   * `tt.resume-edit`'s "Edit" beside "Simpan draf". A banner whose declared label is not on screen is
   * `E_MODAL_UNHANDLED`, never a guess.
   */
  exactActionOnly?: boolean
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
  /** The action target is the close control NEAREST the identifying text (`interruptions.ts` `closeNear`), for a sheet whose close carries a generic label. */
  closeNearIdentity?: boolean
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
    // No `allow`/`ack` here: this entry only ever answers a dialog the reader can SEE, and on
    // Android 14+ it cannot see this one at all. Since 1.30.0 the camera is granted before launch
    // instead (`gesture.ts`'s `answerPermissionsBeforeLaunch`, the owner's call after the
    // production fleet stalled on it), so on a current phone this dialog never appears; the entry
    // stays for an older Android whose dialog is readable.
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
    id: 'tt.security-check',
    // Observed 2026-09-11 on the owner's moto, right after a real Post tap on an account that had
    // just been sent the same video twice: a bottom sheet over the feed reading "Mari kita lakukan
    // pemeriksaan keamanan dengan cepat", offering "Lanjut" and a close icon. It covered the bottom
    // nav, so the post confirmation could not open the profile and reported `unverified`.
    //
    // `actions: {}` — nothing here is ever tapped, and that is the decision, not a gap. "Lanjut"
    // leads into TikTok's own verification, which is the account owner's to complete and never an
    // unattended run's; and quietly closing a platform's security check on every phone of a farm is
    // exactly the kind of evasion this register must not automate. The upload policy is `abort`, so
    // a run that meets it stops and says so by name, and the operator handles that account by hand.
    //
    // `abortCode` (1.34.0): met mid-walk, this used to surface as a generic `E_MODAL_UNHANDLED`, and
    // `finish` then pressed BACK and force-stopped TikTok — dismissing the very sheet the operator
    // needed to see. It now always raises `E_SECURITY_CHECK`, which `finish` leaves on screen.
    match: { textIncludes: ['pemeriksaan keamanan', 'security check'] },
    actions: {},
    abortCode: 'E_SECURITY_CHECK',
    abortMessage:
      'TikTok is asking this account for a security check ("pemeriksaan keamanan"). The run did not touch it and left it on screen. Complete it on the phone, check the profile for the video, then re-run.',
    seen: { device: 'moto g06 power (ZP2222RMBS)', app: 'com.ss.android.ugc.trill', locale: 'id-ID', at: '2026-09-11' },
  },
  {
    id: 'tt.phone-prompt',
    // Observed 2026-09-14 on the production SM-A075F fleet, over the For You feed, in id-ID and en: the "Tambah nomor
    // telepon" / "Add phone" sheet. Identity is `interruptions.ts`'s, so the warm-ups and this register cannot
    // disagree about what the sheet is. `deny` closes it with the sheet's own close — never "Lanjutkan", never a
    // number typed.
    match: { textIncludes: [...(TIKTOK_INTERRUPTIONS.find((i) => i.id === 'tt.phone-prompt')?.identity ?? [])] },
    actions: { deny: { desc: 'Tutup' } },
    closeNearIdentity: true,
    seen: { device: 'Samsung SM-A075F', app: 'com.ss.android.ugc.trill', locale: 'id-ID, en', at: '2026-09-14' },
  },
  {
    id: 'tt.resume-edit',
    // A banner over the For You feed, "Lanjut mengedit postingan ini?" with "Simpan draf" and "Edit", when an
    // unfinished post was left in the editor (seen on the owner's moto, 2026-09-14, after a dry run backed out;
    // `screen-feed-resume-edit-banner.json`). No production bundle carries it, so which Samsung build raises it is
    // not known — only that a force-stop with an unposted edit open leaves one behind for the next launch.
    //
    // 1.34.2 answered "Simpan draf". 1.35.0 answered "Edit" and then expected the editor's "Buang" exit dialog —
    // which, MEASURED on the owner's moto (Android 15, id-ID, 2026-09-15), never comes: "Edit" opens the editor,
    // one BACK returns straight to the feed with no dialog, and TikTok keeps the edit as a draft by itself (an
    // exported Samsung run with ids like `oju` showed the same). So 1.35.0 stopped on every run once a leftover
    // edit existed.
    //
    // 1.36.0, the owner's decision: the farm clears ALL drafts on the account before posting (`post-video.ts`'s
    // `clearDrafts`). The banner is answered "Simpan draf" again — the leftover becomes a draft, and the same run
    // deletes it. That is the ONE draft-keeping answer `assertNeverList` and `resolveActionTarget` allow, carved
    // out by this id, this policy and this exact label (`RESUME_EDIT_DRAFT_ANSWER`). `exactActionOnly`: if the
    // label is not on screen (another locale), nothing else on the banner is tapped for it — "Edit" least of all.
    match: { textIncludes: ['Lanjut mengedit postingan ini', 'Continue editing this post'], onScreen: true },
    actions: { ack: { text: 'Simpan draf' } },
    exactActionOnly: true,
    seen: { device: 'moto g06 power (ZP2222RMBS)', app: 'com.ss.android.ugc.trill', locale: 'id-ID', at: '2026-09-14' },
  },
  {
    id: 'tt.discard-draft',
    // E14: raised when leaving the editor. Two buttons, always shown together, no id (E10) — a
    // "text pair" per §4.2. `deny` maps to "Buang" (abandon the draft, a refusal to keep it) and
    // `ack` maps to "Simpan draf" (acknowledge and keep it for later); neither reading is dictated
    // by the plan's own wording ("caller's" — §4.2's table leaves the choice open), so this is a
    // judgment call made here and worth a caller double-checking before relying on it.
    // Not while the resume-edit banner is up: it carries the same "Simpan draf" button (1.34.2).
    //
    // 1.35.0: `deny` → "Buang" is the ONLY answer. The `ack` → "Simpan draf" this entry used to offer is gone —
    // the owner does not want a run to leave drafts on an account — and `keepsDraft` stops any fallback from
    // reaching that button either. Which build shows this dialog is known only from these dumps: the moto (E14,
    // `screen-exit-modal.json`) and the Samsung build with ids like `upu`/`t6b` (production bundle 04fe3367
    // ui/00063: BACK from the editor raised "Buang" [102,246][356,284] / "Simpan draf") show it; the Samsung
    // build with ids like `oju`/`tc0` (bundle 4063f322 ui/00063 → 00065) went from the editor straight to the
    // profile on BACK, with no dialog at all.
    match: { textIncludes: ['Buang', 'Simpan draf'], notWith: ['Lanjut mengedit postingan ini', 'Continue editing this post'] },
    actions: { deny: { text: 'Buang' } },
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
    //
    // `textEquals`, not `textIncludes` (1.34.0): a caption such as "Oke banget #fyp" CONTAINS "Oke",
    // so the caption field itself read as a notice, its EditText was tapped as the "button", and the
    // post screen failed with `E_MODAL_STUCK` before Post. A notice's button carries the label and
    // nothing else.
    match: {
      textEquals: ACK_SELECTORS.filter((s): s is { text: string } => 'text' in s)
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
  // "Simpan draf" (1.36.0): the leftover edit becomes a draft, which `post-video.ts`'s `clearDrafts` deletes.
  'tt.resume-edit': 'ack',
  'tt.notice': 'ack',
  // Both observed on the 2026-08-18 posting run, both AFTER the Post tap — which is exactly why the
  // 2026-08-17 walk never met them, and why an unattended run that only knew the pre-post modals
  // would have stalled on the very first screen it reached after succeeding.
  'tt.widget-prompt': 'deny',
  'tt.contacts': 'deny',
  'tt.phone-prompt': 'deny',
  // Never answered by a run — see the entry. `abort` is what turns it into a named stop.
  'tt.security-check': 'abort',
}

/** `com.app:id/name` or a bare short id — the same rule `matches()` (`@enkaku/protocol`) and `tree.ts`'s `rowsById` use, kept in step with them. */
function nodeMatchesId(node: UiNode, id: string): boolean {
  return node.resourceId === id || node.resourceId.endsWith(`:id/${id}`)
}

/** Prefers `text`, falls back to `desc` — some of this register's nodes (the discard-draft buttons) may carry either. */
function nodeText(node: UiNode): string {
  return node.text || node.desc
}

/**
 * A text field — what the run is typing into, never a dialog. Its text is whatever the operator's
 * caption says, so it must never identify a modal or be tapped as one's button (1.34.0). The farm's
 * tree carries no `editable` flag, so the class is the signal.
 */
export function isEditableNode(node: Pick<UiNode, 'className'>): boolean {
  return /EditText|AutoCompleteTextView/.test(node.className)
}

function matchesIdentity(node: UiNode, match: ModalEntry['match']): boolean {
  if (match.id === undefined && match.textIncludes === undefined && match.textEquals === undefined) return false
  if (match.id !== undefined && !nodeMatchesId(node, match.id)) return false
  if (match.textIncludes !== undefined || match.textEquals !== undefined) {
    if (isEditableNode(node)) return false
    const t = nodeText(node)
    if (!t) return false
    if (match.textIncludes !== undefined && !match.textIncludes.some((s) => t.includes(s))) return false
    if (match.textEquals !== undefined) {
      const label = t.trim().toLowerCase()
      if (!match.textEquals.some((s) => label === s.trim().toLowerCase())) return false
    }
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
  return register.filter(
    (entry) =>
      nodes.some((n) => matchesIdentity(n, entry.match) && (!(entry.closeNearIdentity || entry.match.onScreen) || drawnOnScreen(n, root))) &&
      !(entry.match.notWith ?? []).some((s) => nodes.some((n) => !isEditableNode(n) && nodeText(n).includes(s))),
  )
}

/**
 * A node with a real size, inside the screen the root spans (1.34.1). Required of the identity of every
 * `closeNearIdentity` entry: that answer taps whichever close sits NEAR the identifying text, so an
 * identity kept in the tree off to the side — TikTok keeps pages mounted there — would aim at some
 * other close that happens to be near where the sheet is not. The root's own width is used only when it
 * has one; a root reported as 0,0,0,0 has been seen in this pack's fixtures.
 */
function drawnOnScreen(node: UiNode, root: UiNode): boolean {
  const b = node.bounds
  if (b.right <= b.left || b.bottom <= b.top || b.left < 0 || b.top < 0) return false
  const width = root.bounds.right
  return width <= 0 || b.left < width
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
  if (entry.closeNearIdentity && policy === 'deny') {
    const root = nodes[0]
    const anchor = root ? nodes.find((n) => matchesIdentity(n, entry.match) && drawnOnScreen(n, root)) : undefined
    if (anchor && root) {
      const close = closeNear(root, anchor)
      return close && !keepsDraft(close) ? close : null
    }
  }
  // Every lookup below reads only nodes that do not keep a draft (1.35.0) — see `keepsDraft`. The one exception
  // is `tt.resume-edit`'s declared "Simpan draf" (1.36.0, `RESUME_EDIT_DRAFT_ANSWER`), for its direct lookup only,
  // and only a node drawn on screen that is not a text field.
  const candidates = nodes.filter((n) => !keepsDraft(n))
  const sel = entry.actions[policy]
  if (sel) {
    const root = nodes[0]
    const pool = isResumeEditDraftAnswer(entry.id, policy, sel)
      ? nodes.filter((n) => !isEditableNode(n) && root !== undefined && drawnOnScreen(n, root))
      : candidates
    const direct = pool.find((n) => selectorMatchesNode(n, sel))
    if (direct) return direct
  }
  if (entry.exactActionOnly) return null
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
    const hit = candidates.find((n) => n.clickable && !isEditableNode(n) && selectorMatchesNode(n, candidate))
    if (hit) return hit
  }

  // The identity fallback is the one that could reach "Simpan draf": that label is part of
  // `tt.discard-draft`'s identity, so a `deny` whose "Buang" was not readable would have tapped it.
  if (entry.match.textIncludes || entry.match.textEquals) {
    const fallback = candidates.find((n) => n.clickable && matchesIdentity(n, entry.match))
    if (fallback) return fallback
  }
  return null
}

/**
 * Labels that keep the unfinished post: "Simpan draf" (the exit dialog and the resume-edit banner) and
 * "Draf" (the post screen's own button). "draf" also covers "draft"/"drafts".
 */
const DRAFT_TERMS = ['draf']

/**
 * True when tapping `node` would keep a draft (1.35.0). The owner does not want a failed run's back-out to
 * leave drafts on an account, so nothing the register resolves — a declared action, the locale fallback or
 * the identity fallback — is ever such a node, and `assertNeverList` refuses one as a declared answer. The
 * single exception is `RESUME_EDIT_DRAFT_ANSWER` (1.36.0).
 */
export function keepsDraft(node: Pick<UiNode, 'text' | 'desc'>): boolean {
  const label = `${node.text} ${node.desc}`.toLowerCase()
  return DRAFT_TERMS.some((t) => label.includes(t))
}

/**
 * The ONE draft-keeping answer the register may give (1.36.0): `tt.resume-edit`, policy `ack`, label exactly
 * "Simpan draf". The owner's decision (2026-09-15) is that the farm deletes all drafts on the account before
 * posting (`post-video.ts`'s `clearDrafts`), so keeping the leftover edit as a draft is safe — and it is the
 * only answer that works, because the "Edit" → BACK → "Buang" walk 1.35.0 relied on was measured to raise no
 * "Buang" dialog at all. Carved out by id AND policy AND label, so no other entry, policy or spelling can
 * reuse it; the abandon walk (`ABANDON_MODAL_POLICIES`) never asks for it.
 */
export const RESUME_EDIT_DRAFT_ANSWER = { entryId: 'tt.resume-edit', policy: 'ack', label: 'Simpan draf' } as const

function isResumeEditDraftAnswer(entryId: string, policy: 'allow' | 'deny' | 'ack', sel: Selector): boolean {
  return entryId === RESUME_EDIT_DRAFT_ANSWER.entryId && policy === RESUME_EDIT_DRAFT_ANSWER.policy && 'text' in sel && sel.text === RESUME_EDIT_DRAFT_ANSWER.label
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
const OTHER_NEVER_TERMS = ['ikuti', 'follow', 'beli', 'berlangganan', 'setuju', 'agree', 'subscribe', 'buy', 'lanjut', 'continue']

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
      // A draft-keeping label is refused for every policy (1.35.0): see `keepsDraft`. Waived for exactly one answer,
      // the owner's decision (1.36.0): `tt.resume-edit` → `ack` → "Simpan draf" (`RESUME_EDIT_DRAFT_ANSWER`), because
      // the run deletes every draft before posting. Only the draft term is waived; every other term still applies.
      const draftTerms = isResumeEditDraftAnswer(entry.id, policy, sel) ? [] : DRAFT_TERMS
      const terms = policy === 'deny' ? [...OTHER_NEVER_TERMS, ...draftTerms] : [...GRANT_TERMS, ...OTHER_NEVER_TERMS, ...draftTerms]
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

    // An entry the operator must handle by hand is raised by its own code before anything else in
    // this round — never tapped, never folded into a generic "unhandled" (1.34.0).
    const handOff = matched.find((e) => e.abortCode !== undefined)
    if (handOff) {
      await ctx.artifact.screenshot(`modal-${handOff.id}`)
      throw Object.assign(new Error(handOff.abortMessage ?? `"${handOff.id}" is on screen and is never answered by a run`), { code: handOff.abortCode })
    }

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
