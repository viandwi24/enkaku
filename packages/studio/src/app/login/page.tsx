'use client'

import { useState, type FormEvent } from 'react'
import { AuthShell } from '@/components/layout/AuthShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthApiError, describeAuthError, login, useAuth } from '@/lib/auth'

/**
 * Email + password → session cookie (`POST /api/auth/login`). Only ever
 * rendered in server auth mode — `AuthGate` never routes a local-mode tab
 * here, and redirects an already-authenticated one straight past it.
 *
 * Where "continue to where they were going" happens: nowhere in this file.
 * `AuthGate`'s own redirect effect reads `?next=` and sends the tab there
 * the instant `refresh()` below flips the shared auth state to
 * authenticated — one place decides the destination, not two.
 */
function LoginForm() {
  const { refresh } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !email || !password) return
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password)
      await refresh()
      // On success `refresh()` flips the shared state and `AuthGate` takes
      // over from here — no navigation call belongs in this component.
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
        <Label htmlFor="login-email" className="text-[13px] font-normal">
          Email
        </Label>
        <Input
          id="login-email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password" className="text-[13px] font-normal">
          Password
        </Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-led-danger/40 bg-led-danger/5 p-3 text-[12.5px] text-led-danger">
          {error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <AuthShell title="Sign in" description="Enter the email and password an admin gave you for this farm.">
      <LoginForm />
    </AuthShell>
  )
}
