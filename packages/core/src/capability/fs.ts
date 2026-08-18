import { z } from 'zod'
import { EnkakuError } from '../util/errors'
import { pathWithinAnyPrefix } from '../workspace/path'
import { isTextContentType } from '../workspace/store'
import type { CapabilityContext } from './context'
import { defineCapability } from './types'

/**
 * `fs.list`, `.read`, `.write`, `.delete`, `.move` (plan 64 §4.2) — one-line
 * delegations to `ctx.workspace` (`../workspace/store.ts`), which is the
 * ONLY thing that ever touches the `workspace_files` table. Scope is
 * enforced HERE, not in the store: the store knows nothing about actors, and
 * `ctx.workspaceScope()` is the one place that changes once Plan 65 gives an
 * agent its own grant (§4.2's "scope checks against the caller's grant").
 *
 * `content` crosses the wire as a string always — UTF-8 text as-is, anything
 * else base64 (§3.3: "Text is stored UTF-8 and returned as a string;
 * anything else is base64 at the API edge and never rendered inline in
 * Studio"). The store itself only ever sees raw bytes.
 */

function encodeContent(content: string, contentType: string): Uint8Array {
  if (isTextContentType(contentType)) return new TextEncoder().encode(content)
  return new Uint8Array(Buffer.from(content, 'base64'))
}

function decodeContent(bytes: Uint8Array, contentType: string): string {
  if (isTextContentType(contentType)) return new TextDecoder().decode(bytes)
  return Buffer.from(bytes).toString('base64')
}

function assertInScope(path: string, prefixes: readonly string[], code: 'E_OUT_OF_SCOPE'): void {
  if (!pathWithinAnyPrefix(path, prefixes)) {
    throw new EnkakuError(code, `"${path}" is outside this caller's workspace scope`)
  }
}

/** `/skills/` (plan 77 §3.4, §4.4, criterion 11) — read-only to an AGENT regardless of its own
 * `workspaceScope().write`, so it cannot rewrite its own instructions mid-run. A HUMAN, calling
 * directly (never from inside a running agent — `ctx.currentRunId` is only ever non-null for an
 * agent's own tool call, `agent/harness/context.ts`), is unaffected: "a human edits skills through
 * Studio's workspace browser" (§3.4) uses this exact same `fs.write`/`.delete`/`.move` path with
 * `currentRunId === null`. */
export const SKILLS_PREFIX = '/skills/'

function assertWritable(ctx: CapabilityContext, path: string): void {
  assertInScope(path, ctx.workspaceScope().write, 'E_OUT_OF_SCOPE')
  if (ctx.currentRunId !== null && pathWithinAnyPrefix(path, [SKILLS_PREFIX])) {
    throw new EnkakuError('E_OUT_OF_SCOPE', `"${path}" is read-only to agents — skills are edited by a human through Studio, never by a running agent`)
  }
}

const MetaOutput = z.object({
  path: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  hash: z.string(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})

const ListEntry = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().nullable(),
  hash: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
})

export const fsList = defineCapability({
  id: 'fs.list',
  input: z.object({ prefix: z.string() }),
  output: z.object({ entries: z.array(ListEntry) }),
  permission: 'fs.read',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description:
    'List the immediate children (files and directories) of a workspace path prefix. Directories are synthesised from the paths beneath them — they never carry content, size, or hash. Call again with a returned directory\'s path to go one level deeper.',
  handler: (ctx, { prefix }) => {
    assertInScope(prefix === '/' ? '/' : prefix, ctx.workspaceScope().read, 'E_OUT_OF_SCOPE')
    return Promise.resolve({ entries: ctx.workspace.list(prefix) })
  },
})

export const fsRead = defineCapability({
  id: 'fs.read',
  input: z.object({ path: z.string() }),
  output: MetaOutput.extend({ content: z.string() }),
  permission: 'fs.read',
  lease: 'none',
  deadline: 5_000,
  effect: 'read',
  description:
    'Read one workspace file. Returns its content (UTF-8 text as a plain string; anything else base64) and its hash — keep the hash and pass it back as ifMatch on fs.write to overwrite this file safely.',
  handler: (ctx, { path }) => {
    assertInScope(path, ctx.workspaceScope().read, 'E_OUT_OF_SCOPE')
    const file = ctx.workspace.read(path)
    return Promise.resolve({ ...file, content: decodeContent(file.content, file.contentType) })
  },
})

export const fsWrite = defineCapability({
  id: 'fs.write',
  input: z.object({
    path: z.string(),
    content: z.string(),
    contentType: z.string().optional(),
    /** Required to overwrite an existing file; omit (or null) only when the file is brand new. */
    ifMatch: z.string().nullable().optional(),
  }),
  output: MetaOutput,
  permission: 'fs.write',
  lease: 'none',
  deadline: 10_000,
  effect: 'write',
  description:
    'Write a workspace file — creates it if the path is new, overwrites it if not. Overwriting REQUIRES ifMatch set to the hash fs.read last returned for this path; omitting it on an existing file fails with E_EXISTS, and a stale hash fails with E_STALE naming both the expected and current hash. Get a fresh hash with fs.read before retrying.',
  handler: (ctx, { path, content, contentType, ifMatch }) => {
    assertWritable(ctx, path)
    const type = contentType ?? 'text/plain'
    const actor = ctx.actor ? `user:${ctx.actor.id}` : null
    const meta = ctx.workspace.write(path, {
      content: encodeContent(content, type),
      contentType,
      ifMatch: ifMatch ?? null,
      actor,
    })
    return Promise.resolve(meta)
  },
})

export const fsDelete = defineCapability({
  id: 'fs.delete',
  input: z.object({ path: z.string(), ifMatch: z.string().nullable().optional() }),
  output: z.object({ ok: z.literal(true) }),
  permission: 'fs.write',
  lease: 'none',
  deadline: 5_000,
  effect: 'destructive',
  description:
    'Delete one workspace file. There is no recursive delete — a directory disappears only once every file inside it is gone. Optionally pass ifMatch to refuse the delete if the file changed since you last read it.',
  handler: (ctx, { path, ifMatch }) => {
    assertWritable(ctx, path)
    ctx.workspace.delete(path, { ifMatch: ifMatch ?? null })
    return Promise.resolve({ ok: true as const })
  },
})

export const fsMove = defineCapability({
  id: 'fs.move',
  input: z.object({ from: z.string(), to: z.string(), ifMatch: z.string() }),
  output: MetaOutput,
  permission: 'fs.write',
  lease: 'none',
  deadline: 5_000,
  effect: 'write',
  description:
    'Rename or relocate a workspace file. Requires ifMatch set to the source\'s current hash. Refuses with E_EXISTS if the destination already has a file — this never overwrites.',
  handler: (ctx, { from, to, ifMatch }) => {
    assertWritable(ctx, from)
    assertWritable(ctx, to)
    const actor = ctx.actor ? `user:${ctx.actor.id}` : null
    return Promise.resolve(ctx.workspace.move(from, to, { ifMatch, actor }))
  },
})

const GrepHitOutput = z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() })

export const fsGrep = defineCapability({
  id: 'fs.grep',
  input: z.object({ prefix: z.string(), pattern: z.string() }),
  output: z.object({ hits: z.array(GrepHitOutput), truncated: z.boolean() }),
  permission: 'fs.read',
  lease: 'none',
  deadline: 10_000,
  effect: 'read',
  description:
    'Search workspace file contents by regex under a path prefix. Returns path:line matches. Results are capped; "truncated" is true when more matches existed than were returned — narrow the prefix or pattern and search again rather than assuming the list is complete.',
  handler: (ctx, { prefix, pattern }) => {
    assertInScope(prefix === '/' ? '/' : prefix, ctx.workspaceScope().read, 'E_OUT_OF_SCOPE')
    return Promise.resolve(ctx.workspace.grep(prefix, pattern))
  },
})

export const FS_CAPABILITIES = [fsList, fsRead, fsWrite, fsDelete, fsMove, fsGrep]

/** Exported purely so callers (tests, and later Plan 65/66 code) can narrow
 * `CapabilityResult['output']` — `invoke()` itself is generic over `unknown`
 * since it takes an `AnyCoreCapability` with its I/O generics erased. */
export type FsFileMeta = z.infer<typeof MetaOutput>
