import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@enkaku/ui'
import { CREDENTIAL_NOT_STORED, PASSWORD_ABSENT_HINT, PASSWORD_SAVED_HINT, PROXY_KIND_LABELS, PROXY_KINDS, type ProxyKind, type ProxyUpstream } from '../../shared'

/**
 * The per-kind upstream field group (plan 121 §4.5, step 121.6) — the
 * `direct`/`socks5`/`http`/`https` field switch that used to live only
 * inline in `catalogue.tsx`'s primary-upstream editor (proto select,
 * host/port/username/password, and the `bindAddress`/`resolveThroughEgress`
 * pair for `direct`), extracted so the new backup-upstreams editor
 * (`backup-upstreams.tsx`) can render each fallback row through the SAME
 * component instead of a second, drifting copy of this switch.
 *
 * **This is a behaviour-preserving extraction, traced line by line against
 * `catalogue.tsx`'s `ProxyDialog` before this step (roughly its former lines
 * 1293–1456) — every field, every handler, every conditional is unchanged.**
 * What moved is only the level of indirection: the primary editor now calls
 * this component with `local.upstream`/`setLocal` closures instead of
 * writing the JSX inline, and passes its own `password`/`clearPassword`
 * state (which lives on `Draft`, not on `ProxyUpstream` — a record's password
 * is never part of the upstream shape, `shared.ts`'s own `ProxyUpstream`
 * doc says why) through the props below rather than through closed-over
 * `local` state directly.
 *
 * `password`/`onPasswordChange`/`hasStoredPassword`/`clearPassword`/
 * `onClearPasswordChange` are props rather than read off `upstream` for the
 * same reason: `ProxyUpstream` carries no password field (plan 112 §3.6),
 * whether this group is drawing the primary or a fallback slot. The CALLER
 * decides which stored credential (`proxySecretKeyFor`, or
 * `proxySecretSlotKeyFor` for a fallback, plan 121 §4.1/step 121.4) the
 * `hasStoredPassword` flag and the eventual write are about — this component
 * only draws the fields and reports what was typed.
 */
export interface UpstreamFieldGroupProps {
  /** Unique per-instance id fragment, so two rows on one page (a fallback list) never collide on `id`/`htmlFor`. */
  idPrefix: string
  upstream: ProxyUpstream
  onChange: (next: ProxyUpstream) => void
  /** The password AS TYPED — never prefilled from storage; there is no read path that could (plan 112 F11). Empty means "leave the stored one alone". */
  password: string
  onPasswordChange: (next: string) => void
  /** Whether a credential row already exists for the slot this group is about — the primary's, or one fallback's own slotted key. */
  hasStoredPassword: boolean
  clearPassword: boolean
  onClearPasswordChange: (next: boolean) => void
}

export function UpstreamFieldGroup({ idPrefix, upstream, onChange, password, onPasswordChange, hasStoredPassword, clearPassword, onClearPasswordChange }: UpstreamFieldGroupProps) {
  return (
    <>
      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-2">
        <Label htmlFor={`${idPrefix}-kind`} className="text-[13px] font-normal">
          Upstream type
        </Label>
        <Select value={upstream.proto} onValueChange={(v) => onChange({ ...upstream, proto: v as ProxyKind })}>
          <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROXY_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {PROXY_KIND_LABELS[kind]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/*
          §3.1 point 2 and this step's own item 1: `direct` names no remote
          party at all, so its fields replace host/port/username/password
          rather than sitting beside them shown-and-ignored — the exact trap
          `describeDirectUpstream` (`service/upstream.ts`) was written to
          avoid describing.
        */}
        {upstream.proto === 'direct' ? (
          <>
            <Label htmlFor={`${idPrefix}-bind-address`} className="text-[13px] font-normal">
              Bind address
            </Label>
            <Input
              id={`${idPrefix}-bind-address`}
              value={upstream.bindAddress}
              onChange={(e) => onChange({ ...upstream, bindAddress: e.target.value })}
              placeholder="Empty = this host's default route"
              className="readout"
            />
          </>
        ) : (
          <>
            <Label htmlFor={`${idPrefix}-host`} className="text-[13px] font-normal">
              Upstream host
            </Label>
            <Input
              id={`${idPrefix}-host`}
              value={upstream.host}
              onChange={(e) => onChange({ ...upstream, host: e.target.value })}
              placeholder="10.4.0.9"
              className="readout"
            />

            <Label htmlFor={`${idPrefix}-port`} className="text-[13px] font-normal">
              Upstream port
            </Label>
            <Input
              id={`${idPrefix}-port`}
              type="number"
              min={1}
              max={65535}
              value={upstream.port || ''}
              onChange={(e) => onChange({ ...upstream, port: Number.parseInt(e.target.value, 10) || 0 })}
              className="readout"
            />

            <Label htmlFor={`${idPrefix}-username`} className="text-[13px] font-normal">
              Upstream user
            </Label>
            <Input
              id={`${idPrefix}-username`}
              value={upstream.username}
              onChange={(e) => onChange({ ...upstream, username: e.target.value })}
              placeholder="Leave empty if the upstream needs no account"
              className="readout"
            />

            {/*
              The password field, unblocked by step 112.2.

              `type="password"` so it is masked in the box, and
              `autoComplete="new-password"` so a browser does not helpfully
              offer somebody's saved site login into a proxy credential. It is
              EMPTY on edit even when one is stored, and the hint beside it
              says which of *keep* and *there is none* the emptiness means —
              there is no read path that could prefill it (`list()` never
              decrypts), and a placeholder implying otherwise would be exactly
              the wording rule `docs/design.md` sets out.
            */}
            <Label htmlFor={`${idPrefix}-password`} className="text-[13px] font-normal">
              Upstream password
            </Label>
            <Input
              id={`${idPrefix}-password`}
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={hasStoredPassword ? 'Saved — type to replace it' : 'Leave empty if the upstream needs no password'}
              autoComplete="new-password"
              spellCheck={false}
            />
          </>
        )}
      </div>

      {upstream.proto === 'direct' ? (
        <p className="text-[11.5px] leading-relaxed text-fg-muted">
          Binds the outgoing connection to one of this host's own addresses — `net.connect`'s own <span className="readout">localAddress</span> and
          nothing more. Empty means dial out however this host normally would, which is a plain local bridge and needs no proxy account at all. What a
          bind address maps to physically — a NIC, a route, a link — is set up on this host outside this screen; the plugin only checks the address
          exists, it never adds one.
        </p>
      ) : null}

      {/*
        Meaningless with an empty bind address (§3.4), so it is not offered
        then — an operator cannot toggle a setting that would do nothing.
      */}
      {upstream.proto === 'direct' && upstream.bindAddress.trim().length > 0 ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
          <div className="min-w-0">
            <Label htmlFor={`${idPrefix}-resolve-through-egress`} className="text-[13px] font-normal">
              Resolve names through this address
            </Label>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-muted">
              On: a hostname is looked up through the bind address's own path before connecting, so the lookup leaves the same way the connection does.
              Off: this host's ordinary resolver answers it instead — a different path than the packets, and worth knowing which one this record uses. A
              lookup that fails through the bind address is reported, never silently retried through the host's default resolver.
            </p>
          </div>
          <Switch
            id={`${idPrefix}-resolve-through-egress`}
            checked={upstream.resolveThroughEgress}
            onCheckedChange={(next) => onChange({ ...upstream, resolveThroughEgress: next })}
          />
        </div>
      ) : null}

      {upstream.proto === 'direct' ? null : (
        <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
          <p className="text-[11.5px] leading-relaxed text-fg-muted">{hasStoredPassword ? PASSWORD_SAVED_HINT : PASSWORD_ABSENT_HINT}</p>
          {hasStoredPassword ? (
            clearPassword ? (
              <p className="text-[11.5px] leading-relaxed text-destructive">
                The saved password will be deleted when you save.{' '}
                <Button variant="ghost" size="sm" className="h-5 px-1 text-[11.5px]" onClick={() => onClearPasswordChange(false)}>
                  Keep it instead
                </Button>
              </p>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1 text-[11.5px] text-fg-muted"
                disabled={password.length > 0}
                title={password.length > 0 ? 'Clear the field above first — typing in it replaces the saved password rather than removing it.' : undefined}
                onClick={() => onClearPasswordChange(true)}
              >
                Remove the saved password
              </Button>
            )
          ) : null}
          {/* Declared in `shared.ts`, narrowed by step 112.2 rather than
              deleted: what is stored, that it is never shown back, and what
              the farm's secret box does and does not claim. */}
          <p className="text-[11.5px] leading-relaxed text-fg-muted">{CREDENTIAL_NOT_STORED}</p>
        </div>
      )}
    </>
  )
}
