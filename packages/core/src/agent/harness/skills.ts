import type { VFS } from '@enkaku/harness'
import type { WorkspaceStore } from '../../workspace/store'
import { EnkakuVFS } from './enkaku-vfs'

/**
 * Skills live under `/skills/` in the workspace, discovered from a VFS by the harness's own
 * `loadSkills`/`SkillRegistry` (`packages/harness/src/skills.ts`, ported verbatim — nothing in
 * `packages/harness/src` is edited here). This module is the one place that builds the VFS those
 * functions run against: a driver rooted at `/skills` (paths come back relative, e.g.
 * `"checkout/SKILL.md"`, matching upstream's own convention and the fixed instructional text
 * `skillsSystemBlock` emits) with an EMPTY write scope, so even a direct `.write()` call on this
 * instance refuses on its own — belt and suspenders alongside `capability/fs.ts`'s
 * `currentRunId`-gated exclusion, which is what actually stops a running agent's `fs.write` (plan
 * 77 §3.4, §4.4).
 *
 * A human edits skills through Studio's workspace browser, i.e. through the ordinary `fs.write`
 * capability at `/skills/...` — never through this module, which exists only for the READ side
 * (`skills.list`/`skills.read`, `capability/skills.ts`).
 */
export const SKILLS_ROOT = '/skills'

export function createSkillsVfs(store: WorkspaceStore): VFS {
  return new EnkakuVFS(store, { read: [`${SKILLS_ROOT}/`], write: [] }, { root: SKILLS_ROOT })
}
