import { Button, Input, Label, Switch } from '@enkaku/ui'
import type { ProxyFailoverConfig, ProxyUpstream } from '../../shared'
import { UpstreamFieldGroup } from './upstream-fields'

/**
 * The backup-upstreams editor (plan 121 §1, §4.5, step 121.6) — an ordered,
 * addable/removable/reorderable list of `ProxyUpstream` rows a record fails
 * over to, each drawn through `UpstreamFieldGroup` (the same component the
 * primary upstream editor in `catalogue.tsx` now calls, per this step's own
 * "extract, don't duplicate" instruction), plus the two `ProxyFailoverConfig`
 * fields (`failureThreshold`, `autoFailback`).
 *
 * A fresh row starts as `socks5` — the same default `BLANK`'s own primary
 * upstream uses in `catalogue.tsx` — since a backup is at least as likely to
 * be a third-party rotating proxy (SOAX, the plan's own named example) as
 * another local egress.
 */

const BLANK_FALLBACK_UPSTREAM: ProxyUpstream = { proto: 'socks5', host: '', port: 0, username: '', bindAddress: '', resolveThroughEgress: true }

/**
 * The three things this editor mutates together, as one value — reordering a
 * row has to move its typed-but-unsaved password with it (a password typed
 * for backup #2 must not silently attach itself to whatever backup ends up
 * at position #2 afterwards), so a single `onChange` keeps the three in step
 * rather than three independent setters that could race or drift.
 */
export interface BackupUpstreamsState {
  upstreams: ProxyUpstream[]
  /** Per-slot (1..n) password as typed. Absent (or empty) means "leave the stored one alone" — mirrors the primary's own `password` field on `Draft`. */
  passwords: Record<number, string>
  /** Per-slot "remove the saved password" flags — mirrors `Draft.clearPassword`. */
  clearPasswords: Record<number, boolean>
}

export interface BackupUpstreamsEditorProps {
  value: BackupUpstreamsState
  onChange: (next: BackupUpstreamsState) => void
  failover: ProxyFailoverConfig
  onFailoverChange: (next: ProxyFailoverConfig) => void
  /** Whether a credential row already exists for backup slot `slot` (1..n) — `false` for every slot on a record that has never been saved. */
  hasStoredPassword: (slot: number) => boolean
}

/** Slot `a`'s and slot `b`'s entries in one per-slot map, swapped — used by `move()` so a typed password follows its row. */
function swapSlot<T>(map: Record<number, T>, a: number, b: number): Record<number, T> {
  const next = { ...map }
  const va = next[a]
  const vb = next[b]
  if (vb === undefined) delete next[a]
  else next[a] = vb
  if (va === undefined) delete next[b]
  else next[b] = va
  return next
}

export function BackupUpstreamsEditor({ value, onChange, failover, onFailoverChange, hasStoredPassword }: BackupUpstreamsEditorProps) {
  const { upstreams, passwords, clearPasswords } = value

  function add(): void {
    onChange({ ...value, upstreams: [...upstreams, { ...BLANK_FALLBACK_UPSTREAM }] })
  }

  function remove(index: number): void {
    const removedSlot = index + 1
    const nextUpstreams = upstreams.filter((_, i) => i !== index)
    // Every slot ABOVE the removed one shifts down by one — its typed
    // password and clear-flag move with it, or a password typed for backup
    // #3 would silently land on whatever becomes backup #2 once #2 is gone.
    let nextPasswords: Record<number, string> = {}
    let nextClear: Record<number, boolean> = {}
    for (let oldSlot = 1; oldSlot <= upstreams.length; oldSlot += 1) {
      if (oldSlot === removedSlot) continue
      const newSlot = oldSlot > removedSlot ? oldSlot - 1 : oldSlot
      if (passwords[oldSlot] !== undefined) nextPasswords[newSlot] = passwords[oldSlot] as string
      if (clearPasswords[oldSlot] !== undefined) nextClear[newSlot] = clearPasswords[oldSlot] as boolean
    }
    onChange({ upstreams: nextUpstreams, passwords: nextPasswords, clearPasswords: nextClear })
  }

  function move(index: number, dir: -1 | 1): void {
    const target = index + dir
    if (target < 0 || target >= upstreams.length) return
    const nextUpstreams = [...upstreams]
    const a = nextUpstreams[index]
    const b = nextUpstreams[target]
    if (!a || !b) return
    nextUpstreams[index] = b
    nextUpstreams[target] = a
    const slotA = index + 1
    const slotB = target + 1
    onChange({
      upstreams: nextUpstreams,
      passwords: swapSlot(passwords, slotA, slotB),
      clearPasswords: swapSlot(clearPasswords, slotA, slotB),
    })
  }

  function updateUpstream(index: number, next: ProxyUpstream): void {
    const nextUpstreams = [...upstreams]
    nextUpstreams[index] = next
    onChange({ ...value, upstreams: nextUpstreams })
  }

  /** Mirrors the primary field's own handler in `catalogue.tsx`: typing a password always clears any pending "remove it" flag for the same slot. */
  function updatePassword(slot: number, next: string): void {
    onChange({ ...value, passwords: { ...passwords, [slot]: next }, clearPasswords: { ...clearPasswords, [slot]: false } })
  }

  /** Mirrors the primary field's own handler: setting "remove" also empties the typed field, so the two can never disagree about what will be saved. */
  function updateClearPassword(slot: number, next: boolean): void {
    onChange({ ...value, clearPasswords: { ...clearPasswords, [slot]: next }, passwords: next ? { ...passwords, [slot]: '' } : passwords })
  }

  return (
    <div className="space-y-3 rounded-md border border-border px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">Backup upstreams</p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
            Tried in order when the primary upstream above fails a sustained streak of dials AND a confirmation probe through it also fails — a flaky
            target site never burns through these on its own. Another local egress, or a third-party rotating proxy such as SOAX, in the same shapes as
            the primary above.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={add}>
          Add backup
        </Button>
      </div>

      {upstreams.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-fg-muted">No backups configured — this record only ever uses its primary upstream.</p>
      ) : (
        <div className="space-y-3">
          {upstreams.map((upstream, index) => {
            const slot = index + 1
            return (
              // `index` as the key: rows are only ever appended, removed, or
              // swapped with a neighbour here, never reshuffled arbitrarily,
              // so this is the row's own stable position, not a fabricated id.
              <div key={index} className="space-y-2 rounded-md border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12.5px] font-medium">Backup #{slot}</p>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move backup ${slot} up`}>
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={index === upstreams.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move backup ${slot} down`}
                    >
                      Down
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(index)}>
                      Remove
                    </Button>
                  </div>
                </div>
                <UpstreamFieldGroup
                  idPrefix={`pm-fallback-${index}`}
                  upstream={upstream}
                  onChange={(next) => updateUpstream(index, next)}
                  password={passwords[slot] ?? ''}
                  onPasswordChange={(next) => updatePassword(slot, next)}
                  hasStoredPassword={hasStoredPassword(slot)}
                  clearPassword={clearPasswords[slot] ?? false}
                  onClearPasswordChange={(next) => updateClearPassword(slot, next)}
                />
              </div>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2 border-t border-border pt-3">
        <Label htmlFor="pm-failure-threshold" className="text-[13px] font-normal">
          Failure threshold
        </Label>
        <Input
          id="pm-failure-threshold"
          type="number"
          min={1}
          value={failover.failureThreshold}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10)
            onFailoverChange({ ...failover, failureThreshold: Number.isInteger(next) && next >= 1 ? next : 1 })
          }}
          className="readout"
        />
      </div>
      {/* No upper bound on the input (plan 121 §9 Q2 — the owner runs a
          large, varied fleet and a blanket ceiling would be guessing at a
          number nobody asked for). `min={1}` is the schema's own floor
          (`ProxyFailoverSchema.failureThreshold`), not an added opinion. */}
      <p className="text-[11.5px] leading-relaxed text-fg-muted">
        Consecutive dial failures against whichever upstream is active before a confirmation probe runs and, if it also fails, a switch happens.
      </p>

      <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div className="min-w-0">
          <Label htmlFor="pm-auto-failback" className="text-[13px] font-normal">
            Auto failback
          </Label>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
            When the primary is confirmed healthy again by a background probe, switch back to it automatically. Off leaves only the manual “Reset to
            primary” action on the row.
          </p>
        </div>
        <Switch id="pm-auto-failback" checked={failover.autoFailback} onCheckedChange={(next) => onFailoverChange({ ...failover, autoFailback: next })} />
      </div>
    </div>
  )
}
