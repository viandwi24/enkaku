import { tool } from "ai";
import { z } from "zod";
import type { VFS } from "./vfs/types";

// Skills = folders with a SKILL.md (frontmatter: name, description) + supporting files, living in
// a VFS. They are a subsystem SEPARATE from the workspace: the agent discovers them via metadata
// in the prompt and reads them with DEDICATED tools (list_skills / read_skill) — never the
// workspace file tools. Drop a folder into the skills source and it loads dynamically; no code change.

export type Skill = { name: string; description: string; dir: string; file: string };

// Scan a (skills) VFS for */SKILL.md and read their frontmatter. Paths are relative to the skills
// source root (e.g. "smc-indicator/SKILL.md") — that's what read_skill expects.
export async function loadSkills(vfs: VFS): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const f of await vfs.list()) {
    if (!/(^|\/)SKILL\.md$/i.test(f.path)) continue;
    const content = await vfs.read(f.path);
    if (content == null) continue;
    const fm = parseFrontmatter(content);
    const dir = f.path.replace(/\/?SKILL\.md$/i, "") || f.path;
    skills.push({ name: fm.name ?? dir, description: fm.description ?? "", dir, file: f.path });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (!m?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// The "available skills" block to append to the system prompt (progressive disclosure level 1).
export function skillsSystemBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const list = skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
  return [
    "# Available skills",
    'Reusable playbooks. When a request matches one, call read_skill("<name>/SKILL.md") to open its',
    "methodology, then read_skill any files it references, and follow it. Skills are SEPARATE from",
    "your workspace — open them with read_skill / list_skills, never with read_file or write_file.",
    list,
  ].join("\n");
}

// Dedicated skill tools — SEPARATE from the workspace file tools. They read from the skills source
// (a VFS), never the workspace. Compose alongside createFileTools.
export function createSkillTools(vfs: VFS, skills: Skill[]) {
  return {
    list_skills: tool({
      description: "List available skills (name + description). Then call read_skill to open one.",
      inputSchema: z.object({}),
      execute: async () =>
        skills.length === 0 ? "No skills available." : skills.map((s) => `${s.name} — ${s.description}`).join("\n"),
    }),
    read_skill: tool({
      description: 'Read a skill file: its SKILL.md or a file it references, e.g. "smc-indicator/SKILL.md".',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => (await vfs.read(path)) ?? `Skill file '${path}' not found. Use list_skills.`,
    }),
  };
}

// Skill registry — the abstraction apps instantiate. Driver-agnostic: point it at ANY VFS (FsVFS
// folder now; JsonFileVFS / PostgresVFS later). The harness does NOT load skills itself — the
// consumer (e.g. cli-proto) creates the registry, picks the source, and wires the prompt block +
// skill tools into the agent.
export class SkillRegistry {
  constructor(private opts: { vfs: VFS }) {}
  get vfs(): VFS {
    return this.opts.vfs;
  }
  /** Scan the source for skills (re-call to pick up newly added folders). */
  load(): Promise<Skill[]> {
    return loadSkills(this.opts.vfs);
  }
  /** System-prompt block listing the loaded skills (metadata only). */
  systemBlock(skills: Skill[]): string {
    return skillsSystemBlock(skills);
  }
  /** Dedicated skill tools (list_skills / read_skill) bound to this source. */
  tools(skills: Skill[]) {
    return createSkillTools(this.opts.vfs, skills);
  }
}
