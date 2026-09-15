'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { normalizeAdbCommand } from '@enkaku/protocol'

/**
 * The adb command box's memory: what this browser ran recently, and the
 * commands an operator saved by name (owner, 2026-09-15).
 *
 * BOTH live in this browser's `localStorage`, and that is a decision, not a
 * shortcut:
 *
 *  - The history is a per-viewer convenience by nature — it is what YOU
 *    typed, and another operator's last command in your Up-arrow would be
 *    noise at best.
 *  - Saved shortcuts would be better shared across the farm. The one
 *    generic server store the core has, `/api/kv`, is gated on `kv.manage`,
 *    which is ADMIN-only (`auth/acl.ts`): an operator — the person who
 *    actually runs adb commands all day — could neither read nor save one.
 *    Widening that gate to store UI shortcuts would weaken the boundary
 *    around plugin secrets for a convenience, so shortcuts stay per browser
 *    until the farm has a store an operator may write. Until then they do
 *    not follow an operator to another machine, and the dialog says so.
 *
 * Every read goes through a Zod parse inside a try/catch: private browsing
 * throws on storage access, and a corrupt or hand-edited value degrades to
 * an empty list rather than throwing into a render.
 *
 * Entries are stored NORMALISED (`normalizeAdbCommand`), so `adb shell ls`
 * and `ls` are one history row — they are one command.
 */

const HISTORY_KEY = 'enkaku:adb-command-history'
const SHORTCUTS_KEY = 'enkaku:adb-command-shortcuts'
export const ADB_HISTORY_MAX = 30
const SHORTCUTS_MAX = 50

const HistorySchema = z.array(z.string().min(1).max(4096)).max(ADB_HISTORY_MAX)
const ShortcutSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  cmd: z.string().min(1).max(4096),
})
const ShortcutsSchema = z.array(ShortcutSchema).max(SHORTCUTS_MAX)
export type AdbShortcut = z.infer<typeof ShortcutSchema>

export interface AdbCommandMemory {
  /** Newest first, de-duplicated. */
  history: string[]
  shortcuts: AdbShortcut[]
}

function read<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage disabled or full — the command still ran; it is only not remembered.
  }
}

function snapshot(): AdbCommandMemory {
  return { history: read(HISTORY_KEY, HistorySchema, []), shortcuts: read(SHORTCUTS_KEY, ShortcutsSchema, []) }
}

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}

/** The stored form of a command, or null when it is not one (`normalizeAdbCommand`'s refusals). */
function canonical(cmd: string): string | null {
  const n = normalizeAdbCommand(cmd)
  return n.ok ? n.cmd : null
}

/** Moves `cmd` to the top of the history. */
export function recordAdbCommand(cmd: string): void {
  const c = canonical(cmd)
  if (!c) return
  const prev = read(HISTORY_KEY, HistorySchema, [])
  write(HISTORY_KEY, [c, ...prev.filter((h) => h !== c)].slice(0, ADB_HISTORY_MAX))
  emit()
}

export function forgetAdbCommand(cmd: string): void {
  write(HISTORY_KEY, read(HISTORY_KEY, HistorySchema, []).filter((h) => h !== cmd))
  emit()
}

export function clearAdbHistory(): void {
  write(HISTORY_KEY, [])
  emit()
}

/** Saves `cmd` under `name`. A command already saved is renamed rather than saved twice. */
export function saveAdbShortcut(name: string, cmd: string): void {
  const c = canonical(cmd)
  const n = name.trim().slice(0, 80)
  if (!c || !n) return
  const prev = read(SHORTCUTS_KEY, ShortcutsSchema, [])
  const existing = prev.find((s) => s.cmd === c)
  const next = existing
    ? prev.map((s) => (s.id === existing.id ? { ...s, name: n } : s))
    : [...prev, { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: n, cmd: c }].slice(-SHORTCUTS_MAX)
  write(SHORTCUTS_KEY, next)
  emit()
}

export function renameAdbShortcut(id: string, name: string): void {
  const n = name.trim().slice(0, 80)
  if (!n) return
  write(SHORTCUTS_KEY, read(SHORTCUTS_KEY, ShortcutsSchema, []).map((s) => (s.id === id ? { ...s, name: n } : s)))
  emit()
}

export function deleteAdbShortcut(id: string): void {
  write(SHORTCUTS_KEY, read(SHORTCUTS_KEY, ShortcutsSchema, []).filter((s) => s.id !== id))
  emit()
}

/** The live memory. Re-reads on every change in this tab, and on a `storage` event from another tab. */
export function useAdbCommandMemory(): AdbCommandMemory {
  const [memory, setMemory] = useState<AdbCommandMemory>({ history: [], shortcuts: [] })
  useEffect(() => {
    const update = () => setMemory(snapshot())
    update()
    listeners.add(update)
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY || e.key === SHORTCUTS_KEY) update()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(update)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return memory
}
