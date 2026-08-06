import { filesDelete, filesEdit, filesGrep, filesList, filesRead, filesTodoWrite, filesWrite } from '../../capability/file-tools'
import { fsDelete, fsGrep, fsList, fsMove, fsRead, fsWrite } from '../../capability/fs'
import { defineAgentPlugin } from './types'

/**
 * Plan 77 §3.6, §4.3 — `fs.*` PLUS the ported harness file tools (`files.*`). Two surfaces over the
 * SAME workspace, on purpose (plan 77 §3.3): `fs.*` is the simple CRUD Studio's own browser uses,
 * with explicit `ifMatch` compare-and-swap; `files.*` is the richer read-before-edit,
 * smart-replace-backed workflow a model is typically tuned to use well. Both are offered — an
 * agent picks whichever fits the edit it is making.
 */
export const workspacePlugin = defineAgentPlugin({
  id: 'workspace',
  title: 'Workspace',
  prompt: [
    '# Workspace',
    'You have a database-backed workspace, shared with the people operating this farm — not the',
    'real filesystem. Two tool families read and write it:',
    '',
    '- fs_list / fs_read / fs_write / fs_delete / fs_move / fs_grep — simple CRUD with an explicit',
    '  ifMatch hash for safe overwrites (fs_read returns the hash; pass it back to fs_write to avoid',
    '  clobbering a concurrent edit).',
    '- files_read / files_write / files_edit / files_delete / files_list / files_grep / files_todo —',
    '  read-before-edit: files_edit refuses if you have not files_read the file in this same',
    "  conversation, or if it changed since you did (it shows you the current content when that",
    '  happens). Prefer files_edit for small, targeted changes; prefer fs_write when replacing a',
    '  file wholesale. files_todo tracks a working checklist for a multi-step task — it never',
    '  touches a file.',
    '',
    'A write outside your granted scope is refused, never silently redirected. `/skills/` is',
    'readable but never writable by you — see the skills tools for that.',
  ].join('\n'),
  tools: () => [fsList, fsRead, fsWrite, fsDelete, fsMove, fsGrep, filesList, filesRead, filesWrite, filesEdit, filesDelete, filesGrep, filesTodoWrite],
})
