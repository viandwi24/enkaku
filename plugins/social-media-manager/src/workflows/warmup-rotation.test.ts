import { describe, expect, test } from 'bun:test'
import { WORKFLOW_LIMITS, WorkflowDocSchema, checkWorkflow } from '@enkaku/protocol'
import { warmupRotation } from './warmup-rotation'

/*
  The warm-up rotation had no test at all until 0.46.0, and it is the one document
  on this farm that eighty phones run unattended every day. Nothing here asserts
  taste — every check below is a way this document can be WRONG in a way no
  operator would see until a day's warm-ups had already been skipped:

  - a shuffle naming a member that does not exist runs fewer activities than its
    title claims, silently;
  - a node count over `WORKFLOW_LIMITS.maxNodes` is refused by the farm on
    publish, so the whole rotation stops being dispatchable at once;
  - a malformed script ref fails per-phone at run time, not at publish.

  `checkWorkflow` is the farm's OWN checker (`@enkaku/protocol`), not a second
  opinion written here — a document this passes is one the farm accepts.
*/

const doc = WorkflowDocSchema.parse(warmupRotation)

/** Every shuffle in the document, with the members it names. */
function shuffles(): { id: string; members: readonly string[] }[] {
  return doc.nodes
    .filter((n): n is Extract<typeof n, { kind: 'shuffle' }> => n.kind === 'shuffle')
    .map((n) => ({ id: n.id, members: n.members }))
}

describe('smm/warmup-rotation — the document itself', () => {
  test('parses through the farm\'s own schema', () => {
    expect(doc.name).toBe('warmup-rotation')
    expect(doc.entry).toBe('start')
  })

  /**
   * The limit that decided 0.46.0's shape: the four activities wired in that
   * version joined EXISTING shuffles as members (one node each) rather than
   * becoming new styles (a case, a shuffle and its members each), because the
   * document was already at 39 of 50.
   */
  test('stays under the node limit, with the headroom named', () => {
    expect(doc.nodes.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.maxNodes)
    expect({ nodes: doc.nodes.length, limit: WORKFLOW_LIMITS.maxNodes }).toEqual({ nodes: 43, limit: 50 })
  })

  test('every shuffle member names a node that exists', () => {
    const ids = new Set(doc.nodes.map((n) => n.id))
    const missing = shuffles().flatMap((s) => s.members.filter((m) => !ids.has(m)).map((m) => `${s.id} -> ${m}`))
    expect(missing).toEqual([])
  })

  test('every script node carries a well-formed ref', () => {
    const refs = doc.nodes.flatMap((n) => (n.kind === 'script' ? [n.script] : []))
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.filter((r) => !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@(?:latest|\d+\.\d+\.\d+)$/.test(r))).toEqual([])
  })

  /**
   * The checker with no resolved scripts: `E_WORKFLOW_SCRIPT_UNRESOLVED` is
   * expected for every script node (this test resolves none) and
   * `W_WORKFLOW_LATEST_REF` is a warning this document takes deliberately — its
   * own header explains why the refs are `@latest`. Anything ELSE at `error`
   * severity is a real defect in the document.
   */
  test('the farm\'s checker finds nothing wrong beyond unresolved refs', () => {
    const findings = checkWorkflow(doc, new Map())
    const errors = findings.filter((f) => f.severity === 'error' && f.code !== 'E_WORKFLOW_SCRIPT_UNRESOLVED')
    expect(errors.map((f) => `${f.path}: ${f.code}`)).toEqual([])
  })
})

describe('smm/warmup-rotation — what each platform actually runs (0.46.0)', () => {
  /** Every script ref a phone can reach, whichever style it draws. */
  const refs = new Set(doc.nodes.flatMap((n) => (n.kind === 'script' ? [n.script] : [])))

  /**
   * The four members that existed in their packs, were maintained there, and
   * had never once been dispatched by a warm-up before 0.46.0. This test is the
   * reason the gap cannot reopen quietly.
   */
  test('the activities wired in 0.46.0 and still proven are reachable', () => {
    expect(refs.has('tiktok/shop-browse@latest')).toBe(true)
    expect(refs.has('youtube/search-channel@latest')).toBe(true)
  })

  /**
   * Withdrawn in 0.48.0 after both failed on the owner's moto g06 (2026-09-17),
   * on a phone that was awake and idle:
   *
   * - `tiktok/live-browse` never found its own submit control
   *   (`id:"tv_search_textview"`), and that id appears in no fixture in its
   *   pack — a selector nobody has observed, which `platforms.ts` names as the
   *   thing that fails silently on the one run that mattered;
   * - `youtube/scroll-live` fails whenever the query has no LIVE rows, which a
   *   trading niche routinely does not — correct for a member asked to open a
   *   live stream, wrong for a warm-up that must not spend its budget failing.
   *
   * `continueOnMemberFailure` means neither ended a run, but both burned a
   * member and a share of the session on every draw that reached them. They go
   * back in when they pass on hardware, not before.
   */
  test('the two members proven to fail on hardware are NOT wired', () => {
    expect(refs.has('tiktok/live-browse@latest')).toBe(false)
    expect(refs.has('youtube/scroll-live@latest')).toBe(false)
  })

  /*
    0.49.0 — the gap that made this rotation lopsided.

    TikTok reaches `notification-activity` and Instagram reaches
    `check-activity` and `check-profile`, while YouTube reached neither: it
    could search, scroll, watch and download, but never once looked at its own
    notifications or account page. Both members existed in the pack from
    youtube@0.41.0 and simply were not wired here — which is the failure mode
    this whole test file exists for, an activity that is maintained and never
    dispatched.
  */
  test('YouTube reaches its notifications and its profile, like the other two platforms do', () => {
    expect(refs.has('youtube/check-notifications@latest')).toBe(true)
    expect(refs.has('youtube/check-profile@latest')).toBe(true)
  })

  test('every platform in the rotation looks at its own notifications', () => {
    expect(refs.has('tiktok/notification-activity@latest')).toBe(true)
    expect(refs.has('instagram/check-activity@latest')).toBe(true)
    expect(refs.has('youtube/check-notifications@latest')).toBe(true)
  })

  test('all three platforms are still reachable, and only those three', () => {
    const packs = [...refs].map((r) => r.split('/')[0])
    expect([...new Set(packs)].sort()).toEqual(['instagram', 'tiktok', 'youtube'])
  })

  /**
   * A style's title is what an operator reads to decide whether a fleet is
   * warm. `tt-c` was titled "search + inbox + videos" while running search,
   * NOTIFICATIONS and videos — this pack has no TikTok inbox member at all, so
   * the title promised an activity that never ran.
   */
  test('no shuffle title names an activity the pack cannot run', () => {
    const titles = doc.nodes.filter((n) => n.kind === 'shuffle').map((n) => n.title ?? '')
    expect(titles.filter((t) => /inbox/i.test(t) && t.startsWith('TikTok'))).toEqual([])
  })
})
