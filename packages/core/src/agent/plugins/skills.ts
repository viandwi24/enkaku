import { skillsList, skillsRead } from '../../capability/skills'
import { defineAgentPlugin } from './types'

/**
 * Plan 77 §3.6, §3.4 — `skills.list`/`.read`. The prompt is deliberately GENERIC (never the live
 * catalogue): baking today's skill names into a static prompt section would make the "prompt is a
 * static string" requirement (criterion 9) fight the whole point of skills being addable with no
 * code change — a new skill would not appear until every agent's prompt was hand-edited. Instead
 * the agent discovers what exists by calling skills_list itself, which is what the tool is for.
 */
export const skillsPlugin = defineAgentPlugin({
  id: 'skills',
  title: 'Skills',
  prompt: [
    '# Skills',
    'Reusable playbooks may be available. Call skills_list to see what exists, then skills_read to',
    'open one (e.g. skills_read("checkout/SKILL.md")) before following it. Skills are reference',
    'material, separate from your workspace — open them with skills_list/skills_read, never with',
    'fs_read or files_read, and never attempt to write to them (they are maintained by a human).',
  ].join('\n'),
  tools: () => [skillsList, skillsRead],
})
