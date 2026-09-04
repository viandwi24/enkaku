'use client'

import { Popover, PopoverContent, PopoverTrigger } from '@enkaku/ui'
import { useAuth } from '@/lib/auth'
import { useShellState } from '@/lib/shell-state'

/**
 * `rz@studio` → `RZ`, the handoff's own example. Two initials across the first
 * separator in the local part, else its first two letters.
 */
export function initialsFor(email: string | null): string {
  const local = (email ?? '').split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  const first = parts[0] ?? ''
  const second = parts[1] ?? ''
  const raw = second ? `${first[0] ?? ''}${second[0] ?? ''}` : local.slice(0, 2)
  return raw.toUpperCase() || '?'
}

/**
 * The 30x30 avatar chip (design handoff: `border-radius: 999px`,
 * `background: var(--avatar-bg)`, `color: var(--avatar-fg)`, 11px/600) and
 * the only place a person's identity appears in the shell.
 *
 * Local mode has no session at all: the core injects an implicit admin for
 * every request on a loopback bind (`AuthGate`'s own note), so there is no
 * email to draw initials from. The chip is still drawn, because the handoff's
 * rail always has one, and it says the true thing: this core asks nobody who
 * they are.
 */
export function AvatarMenu() {
  const { user, authMode, logout } = useAuth()
  const { version, mode } = useShellState()
  // A single nullable var, not a separate boolean: `authMode !== 'server' ||
  // !user` (the plan's own §4.6 code block) computes a `boolean` that
  // TypeScript cannot use to narrow `user` back to non-null in a LATER
  // ternary — `serverUser` IS the narrowable value, so `serverUser ? X :
  // Y` below type-checks without an `as`-cast (plan 200 §2.6: fix the
  // block's own error rather than restructuring around it).
  const serverUser = authMode === 'server' ? user : null
  const initials = serverUser ? initialsFor(serverUser.email) : 'LA'
  const label = serverUser ? serverUser.email : 'Local admin'

  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="mt-[6px] flex size-[30px] shrink-0 select-none items-center justify-center rounded-pill bg-avatar-bg text-[11px] font-semibold text-avatar-fg"
      >
        {initials}
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-64">
        <p className="text-row font-medium text-text">{label}</p>
        <p className="mt-0.5 text-meta text-faint">
          {serverUser ? serverUser.role : 'Local mode: no sign-in. Anyone who can reach this core is an admin.'}
        </p>
        <p className="mt-3 font-mono text-tip text-faint-2">
          {version ? `v${version}` : 'version unknown'} · {mode}
        </p>
        {serverUser && (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-3 w-full rounded-button px-[10px] py-[9px] text-left text-row text-text hover:bg-muted"
          >
            Sign out
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
