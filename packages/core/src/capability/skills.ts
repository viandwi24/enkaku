import { loadSkills } from '@enkaku/harness'
import { z } from 'zod'
import { createSkillsVfs } from '../agent/harness/skills'
import { defineCapability } from './types'

/**
 * `skills.list` / `skills.read` (plan 77 §3.4, §4.4) — DEDICATED tools, separate from the `fs.*`/
 * `files.*` workspace capabilities, exactly as upstream's `skills.ts` design requires: a skill is
 * reference material an agent CONSULTS, not part of the workspace it edits. Both read through
 * `createSkillsVfs` (`agent/harness/skills.ts`), which is scoped to `/skills/` and never anything
 * else. Neither capability can write — that gate lives on `fs.write`/`files.write`/`files.edit`
 * themselves (`capability/fs.ts`'s `SKILLS_PREFIX` check), since an agent must never be able to
 * rewrite its own instructions mid-run (plan 77 §3.4, criterion 11).
 */

export const skillsList = defineCapability({
  id: 'skills.list',
  input: z.object({}),
  output: z.object({ result: z.string() }),
  permission: 'fs.read',
  deadline: 5_000,
  effect: 'read',
  description: 'List available skills (name + description). Then call skills.read to open one before following it.',
  handler: async (ctx) => {
    const skills = await loadSkills(createSkillsVfs(ctx.workspace))
    return { result: skills.length === 0 ? 'No skills available.' : skills.map((s) => `${s.name} — ${s.description}`).join('\n') }
  },
})

export const skillsRead = defineCapability({
  id: 'skills.read',
  input: z.object({ path: z.string() }),
  output: z.object({ result: z.string() }),
  permission: 'fs.read',
  deadline: 5_000,
  effect: 'read',
  description: 'Read a skill file: its SKILL.md or a file it references, e.g. "checkout/SKILL.md". Skills are separate from your workspace — never write to them.',
  handler: async (ctx, { path }) => {
    const content = await createSkillsVfs(ctx.workspace).read(path)
    return { result: content ?? `Skill file '${path}' not found. Use skills.list.` }
  },
})

export const SKILLS_CAPABILITIES = [skillsList, skillsRead]
