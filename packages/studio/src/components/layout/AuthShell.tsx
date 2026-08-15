import type { ReactNode } from 'react'

/**
 * The frame both `/login` and `/setup` render inside — deliberately NOT
 * `AppShell` (no sidebar, no device/job counts, nothing that assumes a
 * session already exists). Centered card on the same graphite background as
 * the rest of Studio (`docs/design.md`'s "instrument panel, not a SaaS
 * dashboard"), so the first two screens a new user ever sees still look like
 * the product rather than a generic auth template.
 */
export function AuthShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="grid size-7 place-items-center rounded bg-accent text-[12px] font-bold text-accent-fg">E</span>
          <span className="text-[15px] font-semibold tracking-tight">Enkaku</span>
        </div>
        <div className="rounded-xl border bg-surface p-6 shadow-sm">
          <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">{description}</p>
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  )
}
