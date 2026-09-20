#!/usr/bin/env bun
/**
 * Every warm-up activity's params, against what its script actually declares.
 *
 * ## The two failures this catches, both silent
 *
 * - **A param the script does not declare** is refused at dispatch, and the
 *   error names the plugin rather than the line that sent it. `likes()` was
 *   once spread onto `tiktok/keyword-videos`, which declares
 *   `keywordBoostFactor` and not `likeProbability`; every TikTok phone drawn
 *   into two of the three styles would have failed on a validation error.
 * - **A param the script declares and nobody sends** is worse, because there is
 *   no error at all. Eight of the nine styles left `commentProbability` at the
 *   script's own default for two versions, so a session's keywords tilted what
 *   a phone LIKED and never what it opened and read — the feature worked, did
 *   half of what it promised, and nothing anywhere could say so.
 *
 * Neither is reachable by running a phone: the first needs every style drawn,
 * the second needs somebody to compare two files. So it is a gate, and it runs
 * in seconds.
 *
 * Exit 1 on a param that would be refused, or on one of the BEHAVIOUR params
 * below going unsent where the script accepts it. Anything else is reported
 * and passes — a script param a warm-up has no opinion about is not a bug.
 */
import ig from '../plugins/instagram-automation-pack/src/index'
import tt from '../plugins/tiktok-automation-pack/src/index'
import yt from '../plugins/youtube-automation-pack/src/index'
import { WARMUP_STYLES } from '../plugins/social-media-manager/src/warmup-catalog'

/** The params that carry the operator's intent. Declared and unsent is a bug, not a preference. */
const BEHAVIOUR = ['keywords', 'likeProbability', 'commentProbability', 'keywordBoostFactor'] as const

const packs: Record<string, { scripts?: ReadonlyArray<{ id: string; params?: unknown }> }> = { instagram: ig, tiktok: tt, youtube: yt }

function declaredParams(ref: string): string[] | null {
  const [pack, rest] = ref.split('/')
  const id = (rest ?? '').split('@')[0]
  const script = packs[pack ?? '']?.scripts?.find((entry) => entry.id === id)
  if (!script) return null
  const shape = (script.params as { shape?: Record<string, unknown> } | undefined)?.shape
  return shape ? Object.keys(shape) : []
}

/* A middling draw: every helper returns real numbers, and `keyword()` has something to pick. */
const draw = { keywords: ['trading', 'forex'], amount: 1, like: { chance: 0.1, commentChance: 0.05, keywordBoost: 3 }, random: () => 0.5 }

let bad = 0
for (const style of WARMUP_STYLES) {
  for (const item of style.activities) {
    const sent = Object.keys(item.params(draw as never))
    const declared = declaredParams(item.script)
    if (declared === null) {
      console.error(`✗ ${item.id}: no such script — ${item.script}`)
      bad += 1
      continue
    }
    const refused = sent.filter((name) => !declared.includes(name))
    if (refused.length > 0) {
      console.error(`✗ ${item.id} (${item.script}): sends ${refused.join(', ')}, which the script does not declare — every dispatch of it would be refused`)
      bad += 1
    }
    const unsent = BEHAVIOUR.filter((name) => declared.includes(name as string) && !sent.includes(name as string))
    if (unsent.length > 0) {
      console.error(`✗ ${item.id} (${item.script}): the script accepts ${unsent.join(', ')} and this activity never sends it — the operator's setting would silently do nothing here`)
      bad += 1
    }
  }
}

const total = WARMUP_STYLES.reduce((sum, style) => sum + style.activities.length, 0)
if (bad > 0) {
  console.error(`\ncheck-warmup-params: ${bad} problem(s) across ${total} activities`)
  process.exit(1)
}
console.log(`check-warmup-params: ${total} activities, every param declared and every behaviour setting sent`)
