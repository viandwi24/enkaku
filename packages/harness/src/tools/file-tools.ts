import { tool } from "ai";
import { z } from "zod";
import { hashContent, shortHash, type VFS } from "../vfs/types";
import { smartReplace } from "./smart-replace";

// §2 — file tools, bound to a VFS driver. The tool interface to the agent is identical
// regardless of driver (memory / json / fs / postgres). Tools RETURN errors as strings so
// the model self-corrects. allowedExtensions is configurable per app (undefined = allow all).

export type Session = { lastRead: Map<string, string> }; // §14.B — content hash last read per file
export type FileToolsOptions = {
  allowedExtensions?: string[];
  readonlyPrefixes?: string[];
  /** Writable-but-undeletable gate: content stays editable, but delete_file is rejected. */
  isUndeletable?: (path: string) => boolean | Promise<boolean>;
};

function isReadonly(path: string, prefixes?: string[]): boolean {
  return (prefixes ?? []).some((p) => path === p || path.startsWith(p + "/"));
}

export function newSession(): Session {
  return { lastRead: new Map() };
}

function extGate(allowed?: string[]): { ok: (p: string) => boolean; list: string } {
  if (!allowed || allowed.length === 0) return { ok: () => true, list: "(all)" };
  const re = new RegExp(`\\.(${allowed.join("|")})$`, "i");
  return { ok: (p) => re.test(p), list: allowed.map((e) => `.${e}`).join(", ") };
}

const schemas = {
  list_files: z.object({}),
  read_file: z.object({ path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  edit_file: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  delete_file: z.object({ path: z.string() }),
  grep: z.object({ pattern: z.string() }),
  todo_write: z.object({
    todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
  }),
} as const;

const descriptions: Record<keyof typeof schemas, string> = {
  list_files: "List all files in the workspace (path, size, version).",
  read_file: "Read a file. Optional offset (1-based line) + limit to read only a slice. Read before editing.",
  write_file: "Write/overwrite a file. For small changes prefer edit_file.",
  edit_file: "Edit via str-replace. Rejected if the file changed since you last read it. Prefer this for edits.",
  delete_file: "Delete a file from the workspace.",
  grep: "Search file contents by regex. Returns path:line matches.",
  todo_write: "Write/update the plan checklist; call at the start of a complex task and update statuses as you go.",
};

const ERROR_PREFIXES = ["REJECTED", "File '", "Read '", "STALE:", "old_string ", "Version conflict", "Unknown tool"];
export function looksLikeError(result: string): boolean {
  return ERROR_PREFIXES.some((p) => result.startsWith(p));
}

export async function executeTool(
  vfs: VFS,
  session: Session,
  name: string,
  input: unknown,
  opts?: FileToolsOptions,
): Promise<string> {
  const gate = extGate(opts?.allowedExtensions);
  switch (name) {
    case "list_files": {
      const files = await vfs.list();
      if (files.length === 0) return "Workspace is empty.";
      return files.map((f) => `${f.path} (${f.size}b)`).join("\n");
    }
    case "read_file": {
      const { path, offset, limit } = schemas.read_file.parse(input);
      const entry = await vfs.stat(path);
      if (!entry) return `File '${path}' does not exist.`;
      session.lastRead.set(path, entry.version);
      let content = entry.content;
      if (offset || limit) {
        const lines = content.split("\n");
        const start = (offset ?? 1) - 1;
        content = lines.slice(start, limit ? start + limit : undefined).join("\n");
      }
      return content === "" ? "(empty file)" : content;
    }
    case "write_file": {
      const { path, content } = schemas.write_file.parse(input);
      if (isReadonly(path, opts?.readonlyPrefixes)) return `REJECTED: '${path}' is read-only.`;
      if (!gate.ok(path)) return `REJECTED: unsupported extension for '${path}'. Allowed: ${gate.list}.`;
      const version = await vfs.write(path, content);
      session.lastRead.set(path, version);
      return `OK. Wrote ${path} (${content.length} bytes, v${shortHash(version)}).`;
    }
    case "edit_file": {
      const { path, old_string, new_string } = schemas.edit_file.parse(input);
      if (isReadonly(path, opts?.readonlyPrefixes)) return `REJECTED: '${path}' is read-only (skill files can't be edited).`;
      const entry = await vfs.stat(path);
      if (!entry) return `File '${path}' does not exist. Use write_file.`;
      const seen = session.lastRead.get(path);
      if (seen === undefined) return `Read '${path}' first before editing (read-before-edit).`;
      if (seen !== entry.version) {
        session.lastRead.set(path, entry.version);
        return `STALE: '${path}' changed (v${shortHash(seen)}->v${shortHash(entry.version)}). Current content below — retry the edit with an old_string copied EXACTLY from it:\n----\n${entry.content}\n----`;
      }
      const occ = entry.content.split(old_string).length - 1;
      const next = smartReplace(entry.content, old_string, new_string);
      if (next === null) {
        if (occ > 1)
          return `old_string appears ${occ}x in ${path} (NOT UNIQUE) — rejected to avoid editing the wrong place. Add surrounding context so it matches exactly one location, or edit each occurrence separately. File content:\n----\n${entry.content}\n----`;
        return `old_string not found in ${path}. Copy the exact text to change from the content below:\n----\n${entry.content}\n----`;
      }
      const ok = await vfs.writeIfVersion(path, next, entry.version);
      if (!ok) return `Version conflict on ${path}; it just changed. Read it again.`;
      const newVersion = hashContent(next);
      session.lastRead.set(path, newVersion);
      return `OK, applied 1 edit to ${path} (v${shortHash(entry.version)}->v${shortHash(newVersion)}).`;
    }
    case "delete_file": {
      const { path } = schemas.delete_file.parse(input);
      if (isReadonly(path, opts?.readonlyPrefixes)) return `REJECTED: '${path}' is read-only.`;
      if (opts?.isUndeletable && (await opts.isUndeletable(path)))
        return `REJECTED: '${path}' is protected — delete the strategy from the Strategy panel instead`;
      if (!(await vfs.exists(path))) return `File '${path}' does not exist.`;
      await vfs.delete(path);
      session.lastRead.delete(path);
      return `OK. Deleted ${path}.`;
    }
    case "grep": {
      const { pattern } = schemas.grep.parse(input);
      const hits = await vfs.grep(pattern);
      if (hits.length === 0) return `No matches for /${pattern}/.`;
      return hits.slice(0, 50).map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
    }
    case "todo_write": {
      const { todos } = schemas.todo_write.parse(input);
      const done = todos.filter((t) => t.status === "completed").length;
      const lines = todos
        .map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`)
        .join("\n");
      return `Plan updated (${done}/${todos.length} done).\n${lines}`;
    }
    default:
      return `Unknown tool '${name}'.`;
  }
}

// Tools WITH execute (for the streaming auto-loop).
export function createFileTools(vfs: VFS, session: Session, opts?: FileToolsOptions) {
  const run = (name: keyof typeof schemas) => (input: unknown) => executeTool(vfs, session, name, input, opts);
  return {
    list_files: tool({ description: descriptions.list_files, inputSchema: schemas.list_files, execute: run("list_files") }),
    read_file: tool({ description: descriptions.read_file, inputSchema: schemas.read_file, execute: run("read_file") }),
    write_file: tool({ description: descriptions.write_file, inputSchema: schemas.write_file, execute: run("write_file") }),
    edit_file: tool({ description: descriptions.edit_file, inputSchema: schemas.edit_file, execute: run("edit_file") }),
    delete_file: tool({ description: descriptions.delete_file, inputSchema: schemas.delete_file, execute: run("delete_file") }),
    grep: tool({ description: descriptions.grep, inputSchema: schemas.grep, execute: run("grep") }),
    todo_write: tool({ description: descriptions.todo_write, inputSchema: schemas.todo_write, execute: run("todo_write") }),
  };
}

// Schema-only tools (for the §7 resilient manual loop — we run side-effects ourselves).
export function toolSchemas() {
  return {
    list_files: tool({ description: descriptions.list_files, inputSchema: schemas.list_files }),
    read_file: tool({ description: descriptions.read_file, inputSchema: schemas.read_file }),
    write_file: tool({ description: descriptions.write_file, inputSchema: schemas.write_file }),
    edit_file: tool({ description: descriptions.edit_file, inputSchema: schemas.edit_file }),
    delete_file: tool({ description: descriptions.delete_file, inputSchema: schemas.delete_file }),
    grep: tool({ description: descriptions.grep, inputSchema: schemas.grep }),
    todo_write: tool({ description: descriptions.todo_write, inputSchema: schemas.todo_write }),
  };
}

export type FileTools = ReturnType<typeof createFileTools>;
