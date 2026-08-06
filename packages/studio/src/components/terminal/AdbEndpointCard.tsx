'use client'

import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { AdbEndpointCreateResponseSchema, AdbEndpointResponseSchema, AdbEndpointStateSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { api, useAction } from '@/lib/actions'
import { useNow } from '@/lib/useNow'

/**
 * The lease-scoped adb endpoint (plan 27 §4.4) — beside the Terminal tab.
 * Shows the copyable `adb connect …` line, a live connection count, the
 * idle countdown, and a close button. Visible only to the lease holder,
 * only when the farm has the feature enabled (`shell.endpointEnabled`);
 * both facts are handed down from the device page, which already resolves
 * them the same way it does for the Terminal tab itself.
 */

/** Unix seconds `expiresAt` — when the endpoint closes itself with no connection (plan §3.4.5). Refreshed on every poll. */
type EndpointState = z.infer<typeof AdbEndpointStateSchema>

const POLL_MS = 5_000

export function AdbEndpointCard({
  deviceId,
  clientId,
  canOpen,
}: {
  deviceId: string
  /** The WS session id (`hello`'s `sessionId`) — the endpoint is lease-scoped, and this IS the lease holder's identity for it (plan §4.3). `null` before the WS `hello` arrives. */
  clientId: string | null
  /** Same server-authoritative fact the Terminal tab's input box reads (plan §3.4) — Studio hiding this card is a convenience, never the control. */
  canOpen: boolean
}) {
  const [endpoint, setEndpoint] = useState<EndpointState | null>(null)
  const [checked, setChecked] = useState(false)
  // `useAction` already reports failures via a toast (matching every other
  // action button in Studio) — no separate inline error banner needed.
  const { run, isPending } = useAction()
  const now = useNow()

  const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''

  // Discover an endpoint that already exists — e.g. this device page was
  // reloaded while one was open, or another tab of the same session opened
  // it a moment ago (plan §4.2: "one endpoint per device").
  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    void api(`/api/devices/${deviceId}/adb-endpoint${qs}`, AdbEndpointResponseSchema)
      .then((b) => {
        if (!cancelled) setEndpoint(b.endpoint)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecked(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, clientId])

  // Live connection count and idle countdown (plan §4.4) — polled rather than
  // pushed: plan 27 adds no WS message type for this, only the REST trio.
  useEffect(() => {
    if (!endpoint || !clientId) return
    const id = setInterval(() => {
      void api(`/api/devices/${deviceId}/adb-endpoint${qs}`, AdbEndpointResponseSchema)
        .then((b) => setEndpoint(b.endpoint))
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, clientId, endpoint !== null])

  // Still loading the initial check — not a permission gate, just not ready
  // yet, so rendering nothing briefly is fine here (unlike `!canOpen` below).
  if (!checked) return null

  // A gated panel renders its controls disabled, with one line saying why,
  // rather than vanishing (plan 42 §3.2, §4.2 — the same treatment as
  // `FilesPanel`, "and any panel with the same shape").
  const disabled = !canOpen

  const command = endpoint ? `adb connect ${endpoint.host}:${endpoint.port}` : null
  const idleInSec = endpoint ? Math.max(0, endpoint.expiresAt - Math.floor(now / 1000)) : null

  async function open(): Promise<void> {
    if (!clientId) return
    await run(
      'adb-endpoint-open',
      async () => {
        const result = await api(`/api/devices/${deviceId}/adb-endpoint`, AdbEndpointCreateResponseSchema, {
          json: { clientId },
        })
        setEndpoint({ host: result.host, port: result.port, connections: 0, openedAt: Math.floor(Date.now() / 1000), expiresAt: result.expiresAt })
      },
      { failure: 'Could not open the adb endpoint' },
    )
  }

  async function close(): Promise<void> {
    if (!clientId) return
    await run(
      'adb-endpoint-close',
      async () => {
        // `DELETE /:id/adb-endpoint` returns `{ ok: true }` (`packages/core/src/api/adb-endpoint.ts`) —
        // no envelope for that exists in `@enkaku/protocol` yet, and the plan is silent on this
        // call site (it only names the two GETs and the POST create), so this is a small ad-hoc
        // schema rather than a new export for a value nothing here reads.
        await api(`/api/devices/${deviceId}/adb-endpoint${qs}`, z.object({ ok: z.boolean() }), { method: 'DELETE' })
        setEndpoint(null)
      },
      { failure: 'Could not close the adb endpoint' },
    )
  }

  return (
    <div className="mb-4 rounded-lg border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13.5px] font-semibold tracking-tight">adb endpoint</h3>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-fg-muted">
            Grants whoever can reach this address full adb control of the device — install, push/pull, logcat, a
            debugger, exactly like a real <code className="readout">adbd</code>. It exists only for the life of
            your lease and closes automatically when you release control or after it sits idle.
          </p>
        </div>
        {endpoint ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void close()}
            disabled={disabled || isPending('adb-endpoint-close')}
          >
            {isPending('adb-endpoint-close') ? 'Closing…' : 'Close'}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void open()} disabled={disabled || isPending('adb-endpoint-open') || !clientId}>
            {isPending('adb-endpoint-open') ? 'Opening…' : 'Open endpoint'}
          </Button>
        )}
      </div>

      {disabled && (
        <p className="mt-3 text-[11.5px] text-fg-subtle">Take control of this device to open an adb endpoint.</p>
      )}

      {command && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <code className="readout rounded-md border bg-surface-2 px-2.5 py-1.5 text-[12px]">{command}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(command)}
              aria-label="Copy adb connect command"
            >
              <Copy className="size-3.5" aria-hidden />
            </Button>
          </div>
          <span className="text-[11.5px] text-fg-subtle">
            {endpoint?.connections ?? 0} connection{endpoint?.connections === 1 ? '' : 's'}
          </span>
          {endpoint && endpoint.connections === 0 && idleInSec !== null && (
            <span className="text-[11.5px] text-fg-subtle">closes in {idleInSec}s if unused</span>
          )}
        </div>
      )}
    </div>
  )
}
