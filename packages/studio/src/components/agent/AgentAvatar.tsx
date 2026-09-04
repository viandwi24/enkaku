import { RobotIcon, cn } from '@enkaku/ui'

/**
 * An agent's identity, rendered small and consistently everywhere one
 * appears (plan 69 §3.5 — "a holder of the shape `agent-run:<id>` renders as
 * an agent"): its own colour if it set one, its initial, falling back to a
 * generic bot glyph. Never a bare id.
 */
export function AgentAvatar({ name, colour, size = 'md' }: { name: string; colour?: string | null; size?: 'sm' | 'md' }) {
  const dims = size === 'sm' ? 'size-4 text-[9px]' : 'size-5 text-[10px]'
  const initial = name.trim().slice(0, 1).toUpperCase()
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', dims)}
      style={{ backgroundColor: colour ?? 'var(--color-fg-subtle)' }}
      aria-hidden
    >
      {initial || <RobotIcon className="size-3" />}
    </span>
  )
}
