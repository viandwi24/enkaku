'use client'

import { useState, type FormEvent } from 'react'
import { AuthShell } from '@/components/layout/AuthShell'
import { Button, Input, Label } from '@enkaku/ui'
import { AuthApiError, describeAuthError, setupAdmin, useAuth } from '@/lib/auth'

const MIN_PASSWORD_LENGTH = 8

/**
 * First-admin bootstrap (`POST /api/auth/setup`) — `AuthGate` only ever
 * routes here when `setupNeeded` is true (no admin exists yet), and this
 * endpoint closes permanently the instant it succeeds once. The password
 * length check happens here, client-side, before the request ever leaves the
 * tab — the core's own `min 8` check lives one layer below the request
 * validation and (as of this writing) can answer in Indonesian on that path,
 * so staying under the limit is how this screen avoids ever surfacing it.
 */
function SetupForm() {
  const { refresh } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit = email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await setupAdmin(email.trim(), password)
      await refresh()
      // On success `refresh()` flips the shared state and `AuthGate` sends
      // this tab on to wherever `?next=` (or `/`) points.
    } catch (err) {
      setError(
        err instanceof AuthApiError
          ? describeAuthError(err.code, err.message)
          : 'Could not reach the core. Check your connection and try again.',
      )
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="setup-email" className="text-[13px] font-normal">
          Email
        </Label>
        <Input
          id="setup-email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-password" className="text-[13px] font-normal">
          Password
        </Label>
        <Input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <p className={tooShort ? 'text-[11.5px] text-led-danger' : 'text-[11.5px] text-fg-subtle'}>
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-confirm" className="text-[13px] font-normal">
          Confirm password
        </Label>
        <Input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
        {mismatch && <p className="text-[11.5px] text-led-danger">Passwords do not match.</p>}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">
          {error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {busy ? 'Creating account…' : 'Create admin account'}
      </Button>
    </form>
  )
}

export default function SetupPage() {
  return (
    <AuthShell
      title="Create the first admin account"
      description="This runs once, for whoever sets this farm up. After this, the setup page closes for good and everyone signs in normally."
    >
      <SetupForm />
    </AuthShell>
  )
}
