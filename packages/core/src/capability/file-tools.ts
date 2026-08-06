import { executeTool, newSession } from '@enkaku/harness'
import { z } from 'zod'
import { EnkakuVFS } from '../agent/harness/enkaku-vfs'
import type { CapabilityContext } from './context'
import { SKILLS_PREFIX } from './fs'
import { defineCapability } from './types'

/**
 * The harness's own file tools (`packages/harness/src/tools/file-tools.ts`) become capabilities
 * here, bodies unchanged (plan 77 §3.3): `executeTool` — the ported dispatcher, imported straight
 * from `@enkaku/harness`, never copy-pasted — is called with an `EnkakuVFS` bound to the caller's
 * own workspace scope and the run's `fileToolsSession` (`capability/context.ts`), so the "read
 * before edit" / smart-replace cascade behaves exactly as upstream, while every call still crosses
 * `invoke()` (permission, audit, scope) exactly like every other capability (criterion 6).
 *
 * These are a SEPARATE tool surface from Plan 64's `fs.*` (`capability/fs.ts`) — not a replacement.
 * `fs.*` is the simple CRUD Studio's browser uses; `files.*` is the richer, session-tracked,
 * smart-replace-backed workflow the harness's own file tools give a model. The `workspace` plugin
 * (`agent/plugins/workspace.ts`) offers both.
 *
 * `executeTool` always returns a plain string (upstream's own design: "errors as strings so the
 * model self-corrects" — `file-tools.ts`'s own comment) — every capability here shares one output
 * shape, `{ result: string }`.
 */

const Output = z.object({ result: z.string() })

function vfsFor(ctx: CapabilityContext): EnkakuVFS {
  const actor = ctx.actor ? (ctx.currentRunId ? `agent:${ctx.actor.id}` : `user:${ctx.actor.id}`) : null
  // `/skills/` is read-only to a running agent regardless of its configured write scope — the SAME
  // hard rule `capability/fs.ts`'s `assertWritable` enforces for `fs.write`/`.delete`/`.move` (plan
  // 77 §3.4, §4.4, criterion 11). A human/REST/MCP caller (`currentRunId === null`) is unaffected.
  const writeExcludePrefixes = ctx.currentRunId !== null ? [SKILLS_PREFIX] : []
  return new EnkakuVFS(ctx.workspace, ctx.workspaceScope(), { actor, writeExcludePrefixes })
}

function sessionFor(ctx: CapabilityContext) {
  return ctx.fileToolsSession ?? newSession()
}

export const filesList = defineCapability({
  id: 'files.list',
  input: z.object({}),
  output: Output,
  permission: 'fs.read',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description: 'List all files in the workspace (path, size, version).',
  handler: async (ctx) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'list_files', {}) }),
})

export const filesRead = defineCapability({
  id: 'files.read',
  input: z.object({ path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
  output: Output,
  permission: 'fs.read',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description: 'Read a file. Optional offset (1-based line) + limit to read only a slice. Read before editing with files.edit.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'read_file', input) }),
})

export const filesWrite = defineCapability({
  id: 'files.write',
  input: z.object({ path: z.string(), content: z.string() }),
  output: Output,
  permission: 'fs.write',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description: 'Write/overwrite a file. For small changes prefer files.edit.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'write_file', input) }),
})

export const filesEdit = defineCapability({
  id: 'files.edit',
  input: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  output: Output,
  permission: 'fs.write',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description: 'Edit a file via string replacement. Rejected if the file changed since you last read it, or if old_string is not unique. Prefer this for edits.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'edit_file', input) }),
})

export const filesDelete = defineCapability({
  id: 'files.delete',
  input: z.object({ path: z.string() }),
  output: Output,
  permission: 'fs.write',
  lease: 'none',
  deadline: 5_000,
  effect: 'destructive',
  description: 'Delete a file from the workspace.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'delete_file', input) }),
})

export const filesGrep = defineCapability({
  id: 'files.grep',
  input: z.object({ pattern: z.string() }),
  output: Output,
  permission: 'fs.read',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description: 'Search file contents by regex. Returns path:line matches, capped to the first 50.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'grep', input) }),
})

export const filesTodoWrite = defineCapability({
  id: 'files.todo',
  input: z.object({ todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })) }),
  output: Output,
  permission: 'fs.read',
  lease: 'none',
  deadline: 5_000,
  effect: 'read', // touches no file — a scratch checklist held in the same per-run session as read-before-edit state
  description: 'Write/update the plan checklist; call at the start of a complex task and update statuses as you go.',
  handler: async (ctx, input) => ({ result: await executeTool(vfsFor(ctx), sessionFor(ctx), 'todo_write', input) }),
})

export const FILE_TOOLS_CAPABILITIES = [filesList, filesRead, filesWrite, filesEdit, filesDelete, filesGrep, filesTodoWrite]
