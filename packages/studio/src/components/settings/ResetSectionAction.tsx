'use client'

import { ResetSettingsResponseSchema, type FarmSettings } from '@enkaku/protocol'
import { Button, ConfirmDialog, api, useAction } from '@enkaku/ui'

/**
 * **Restore defaults** — put one Settings section back to what this build
 * ships, and show what that would change before it happens.
 *
 * ## Why a farm needs this at all
 *
 * `farm_settings` is one JSON row, written out IN FULL on a farm's first boot
 * (`createFarmSettingsStore`). Every key is stored explicitly, including the
 * ones nobody ever touched, so there is no "unset" state to fall through to
 * the schema. A default ADDED in a later release reaches an existing farm —
 * the schema fills a key the row lacks. A default CHANGED does not: the old
 * value is sitting in the row, and it wins, forever. Before this button an
 * operator tuning a farm had no way to say "give me the new numbers" short of
 * deleting the database (owner, 2026-09-06).
 *
 * ## Why the preview is not decoration
 *
 * The defaults live in the binary and the stored values live in the database,
 * so only the server holds both — which is why `GET /api/settings` now sends
 * `defaults` alongside `settings`. Without the diff this control would be a
 * leap of faith: an operator would press "restore defaults" with no way to
 * know whether it moves three fields or twenty, and a settings page that
 * changes things you did not see change is how people stop trusting a
 * settings page.
 *
 * A section already matching its defaults says so and offers nothing to
 * press, rather than a button whose only outcome is a no-op.
 *
 * ## Scope
 *
 * `POST /api/settings/reset` reaches the `farm_settings` row and nothing else
 * — not a device, group, job, run, script, user, token or credential. That is
 * a property of the route (its only dependency is the settings store), not a
 * promise made here, but it is the thing an operator is really asking when
 * they hesitate over a button with "reset" on it, so this dialog answers it
 * in words too.
 */

interface Change {
  /** Dotted path below the section, e.g. `capture.wallQuality`. */
  path: string
  from: unknown
  to: unknown
}

/**
 * Leaf-by-leaf diff of the stored section against the default one.
 *
 * Arrays and nulls are compared whole rather than walked: an operator reading
 * "networks: 3 entries → 0 entries" is better served than by twelve rows of
 * `networks.1.cidr`, and a per-element diff invites the reader to think
 * elements are reset individually. They are not — the section is replaced.
 */
function diffSection(from: unknown, to: unknown, prefix: string): Change[] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

  if (isPlainObject(from) && isPlainObject(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
    return keys.flatMap((key) => diffSection(from[key], to[key], prefix ? `${prefix}.${key}` : key))
  }
  return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ path: prefix, from, to }]
}

/** Short, readable, and never a bare `[object Object]` in front of somebody deciding whether to press a button. */
function show(value: unknown): string {
  if (value === undefined) return 'unset'
  if (value === null) return 'none'
  if (typeof value === 'string') return value === '' ? 'empty' : value
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`
  if (typeof value === 'object') return 'a group of values'
  return String(value)
}

export function ResetSectionAction({
  sectionId,
  sectionTitle,
  settings,
  defaults,
  onReset,
}: {
  /** A top-level `FarmSettingsSchema` key. Bespoke sections (Access, Toolchain, Virtual devices) have no schema key and never render this. */
  sectionId: string
  sectionTitle: string
  settings: FarmSettings
  defaults: FarmSettings
  onReset: (settings: FarmSettings) => void
}) {
  const { run, isPending } = useAction()
  const current = (settings as unknown as Record<string, unknown>)[sectionId]
  const fallback = (defaults as unknown as Record<string, unknown>)[sectionId]
  const changes = diffSection(current, fallback, '')

  if (changes.length === 0) {
    return <p className="text-meta text-faint-2">{sectionTitle} already matches this version&rsquo;s defaults.</p>
  }

  const reset = () =>
    run('reset', () => api('/api/settings/reset', ResetSettingsResponseSchema, { method: 'POST', json: { sections: [sectionId] } }), {
      success: `${sectionTitle} restored to defaults`,
      failure: `Could not restore ${sectionTitle}`,
      onSuccess: (b) => onReset(b.settings),
    })

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-row text-text">Restore defaults</p>
          <p className="mt-0.5 text-meta text-faint-2">
            {changes.length} {changes.length === 1 ? 'value differs' : 'values differ'} from what this version ships.
          </p>
        </div>
        <ConfirmDialog
          trigger={
            <Button variant="outline" className="h-7 shrink-0 text-[12px]" disabled={isPending('reset')}>
              Restore defaults
            </Button>
          }
          title={`Restore ${sectionTitle} to defaults?`}
          confirmLabel="Restore defaults"
          onConfirm={reset}
          description={
            <>
              <p>
                This changes only the <strong>{sectionTitle}</strong> settings. No device, group, job, run, script, user, token or stored
                credential is touched.
              </p>
              <ul className="mt-3 max-h-56 overflow-y-auto rounded-small border border-line">
                {changes.map((c) => (
                  <li key={c.path} className="flex items-baseline justify-between gap-3 border-b border-line px-2.5 py-1.5 last:border-b-0">
                    <span className="min-w-0 truncate font-mono text-meta text-faint">{c.path}</span>
                    <span className="shrink-0 text-meta">
                      <span className="text-faint-2 line-through">{show(c.from)}</span>
                      <span className="mx-1.5 text-faint-2">&rarr;</span>
                      <span className="text-text">{show(c.to)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          }
        />
      </div>
    </div>
  )
}
