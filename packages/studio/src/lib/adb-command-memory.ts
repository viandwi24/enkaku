'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AdbShortcutResponseSchema, AdbShortcutsResponseSchema, normalizeAdbCommand, type AdbShortcut } from '@enkaku/protocol'
import { api } from '@enkaku/ui'

/**
 * The adb command box's memory: what this browser ran recently, and the
 * commands the FARM saved by name.
 *
 * The two halves live in different places, and that split is the decision:
 *
 *  - The history is a per-viewer convenience by nature — it is what YOU
 *    typed, and another operator's last command in your Up-arrow would be
 *    noise at best. It stays in this browser's `localStorage`.
 *  - Shortcuts are the farm's own vocabulary ("Clear Chrome", "Wi-Fi off"):
 *    written once, run by everyone, from any machine. They live in the core
 *    (`/api/adb/shortcuts`, table `adb_shortcuts`).
 *
 * Until 2026-09-16 both were in `localStorage`, and this file argued the
 * second one down: the only server store the core had was `/api/kv`, gated on
 * the admin-only `kv.manage`, so an operator — the person who runs adb
 * commands all day — could neither read nor save one, and widening that gate
 * would have weakened the boundary around plugin secrets for a convenience.
 * The owner's answer was that the STORE was wrong, not the feature. The
 * shortcuts endpoint is gated on `canUseShell` instead: whoever may run an
 * adb command may save one under a name, and nobody else can.
 *
 * Every localStorage read goes through a Zod parse inside a try/catch:
 * private browsing throws on storage access, and a corrupt or hand-edited
 * value degrades to an empty list rather than throwing into a render.
 *
 * History entries are stored NORMALISED (`normalizeAdbCommand`), so
 * `adb shell ls` and `ls` are one row — they are one command. The server
 * normalises shortcuts the same way, with the same function.
 */

const HISTORY_KEY = 'enkaku:adb-command-history'
export const ADB_HISTORY_MAX = 30

const HistorySchema = z.array(z.string().min(1).max(4096)).max(ADB_HISTORY_MAX)

export type { AdbShortcut }

export interface AdbCommandMemory {
  /** Newest first, de-duplicated. This browser's own. */
  history: string[]
  /** The farm's, in the order the core gives them. */
  shortcuts: AdbShortcut[]
  /** False until the first fetch of the shortcut list has answered — so an empty list is not drawn as "none yet" before it is known. */
  shortcutsLoaded: boolean
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

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}

/** The stored form of a command, or null when it is not one (`normalizeAdbCommand`'s refusals). */
function canonical(cmd: string): string | null {
  const n = normalizeAdbCommand(cmd)
  return n.ok ? n.cmd : null
}

// ---------------------------------------------------------------------------
// History — this browser's
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shortcuts — the farm's
// ---------------------------------------------------------------------------

/**
 * One module-level copy of the list, shared by every surface that draws it —
 * the command dialog, and the "Adb shortcuts" run of the device action list
 * in all three of its surfaces (`lib/device-actions.ts`).
 *
 * Shared rather than fetched per component because the action list is drawn
 * on every right-click: a fetch per menu would put a request on the wire for
 * a list that changes a few times a month. It is refreshed on every mutation
 * this tab makes, and re-read when a new subscriber appears after the cached
 * copy has gone stale (`STALE_MS`) — another operator's new shortcut reaches
 * this tab the next time a menu opens, which is soon enough for a list nobody
 * is watching.
 */
let shortcuts: AdbShortcut[] = []
let loaded = false
let fetchedAt = 0
let inFlight: Promise<void> | null = null
const STALE_MS = 30_000

async function load(force: boolean): Promise<void> {
  if (!force && Date.now() - fetchedAt < STALE_MS) return
  if (inFlight) return inFlight
  inFlight = api('/api/adb/shortcuts', AdbShortcutsResponseSchema)
    .then((res) => {
      shortcuts = res.shortcuts
      loaded = true
      fetchedAt = Date.now()
      emit()
    })
    .catch(() => {
      // A farm that refuses or cannot answer leaves the list as it was: the
      // command box still works, and the shortcuts run simply draws nothing.
      loaded = true
      fetchedAt = Date.now()
      emit()
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Re-read the farm's list now, whatever the cache thinks. */
export function refreshAdbShortcuts(): Promise<void> {
  return load(true)
}

/**
 * Saves `cmd` under `name`. A command already saved is renamed rather than
 * saved twice — the core enforces that, and the unique index behind it.
 *
 * Resolves with the error message when the farm refused (no permission, or a
 * command the normaliser will not take), and with `null` on success, so a
 * caller can say so without inventing its own wording.
 */
export async function saveAdbShortcut(name: string, cmd: string): Promise<string | null> {
  const c = canonical(cmd)
  const n = name.trim().slice(0, 80)
  if (!c || !n) return 'a shortcut needs a name and a valid command'
  return mutate(() => api('/api/adb/shortcuts', AdbShortcutResponseSchema, { json: { name: n, cmd: c } }))
}

export async function renameAdbShortcut(id: string, name: string): Promise<string | null> {
  const n = name.trim().slice(0, 80)
  if (!n) return 'a shortcut needs a name'
  return mutate(() => api(`/api/adb/shortcuts/${encodeURIComponent(id)}`, AdbShortcutResponseSchema, { method: 'PATCH', json: { name: n } }))
}

export async function deleteAdbShortcut(id: string): Promise<string | null> {
  return mutate(() => api(`/api/adb/shortcuts/${encodeURIComponent(id)}`, z.void(), { method: 'DELETE' }))
}

async function mutate(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call()
    await load(true)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The live memory. Re-reads on every change in this tab, and on a `storage` event from another tab. */
export function useAdbCommandMemory(): AdbCommandMemory {
  const [memory, setMemory] = useState<AdbCommandMemory>({ history: [], shortcuts, shortcutsLoaded: loaded })
  useEffect(() => {
    const update = () => setMemory({ history: read(HISTORY_KEY, HistorySchema, []), shortcuts, shortcutsLoaded: loaded })
    update()
    listeners.add(update)
    void load(false)
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY) update()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(update)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return memory
}

/** Just the farm's shortcuts, for a surface that has no use for the history (the device action list). */
export function useAdbShortcuts(): AdbShortcut[] {
  return useAdbCommandMemory().shortcuts
}
