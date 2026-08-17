'use client'

import { useRef, useState, type ReactNode } from 'react'
import { PluginActivateResponseSchema, PluginStageResponseSchema, type PluginRow, type VerifyReport } from '@enkaku/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { api, useAction } from '@/lib/actions'

/**
 * Install a plugin from Studio (plan 108 §0.2 P1, §3.10, §5 step 108.9).
 *
 * `POST /api/plugins` has existed since plan 82 and nothing in Studio ever
 * called it: a plugin could only arrive through the CLI or as an embedded
 * pack. This is that call.
 *
 * It is deliberately TWO steps, because the server's own pipeline is two
 * steps and flattening them would misreport what happened. Publishing
 * stages the bundle and verifies it in one request; **activation is
 * separate and explicit** (plan 82 §3.9: nothing about publishing should
 * ever change what is currently live). So:
 *
 * 1. name + version + the bundle → `POST /api/plugins`.
 * 2. the verify report, rendered in place:
 *    - failed → the code and the message VERBATIM, never summarised, the
 *      same rule the Plugins table itself follows. The version stays in the
 *      list as `failed` so the error is findable afterwards too.
 *    - passed → the consent step §3.10 asks for: the plugin's title, its
 *      description, and every script it declares, shown BEFORE the operator
 *      activates it. A success toast alone would be exactly the "you have
 *      installed something, we will not say what" this step exists to avoid.
 */

/** The server's own `StageBody.version` regex (`packages/core/src/api/plugins.ts`) — checked here so a typo is a field hint, not a 400. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/

interface StageResult {
  plugin: PluginRow | null
  verify?: VerifyReport
}

export function InstallPluginDialog({ trigger, onInstalled }: { trigger: ReactNode; onInstalled: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [bundle, setBundle] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [result, setResult] = useState<StageResult | null>(null)
  /** Whether anything was written server-side while this dialog was open — the list behind it is stale either way, pass or fail. */
  const changedRef = useRef(false)
  const { run, isPending } = useAction()

  const reset = () => {
    setName('')
    setVersion('')
    setBundle('')
    setFileName(null)
    setFileError(null)
    setResult(null)
  }

  const close = () => {
    setOpen(false)
    if (changedRef.current) {
      changedRef.current = false
      onInstalled()
    }
    reset()
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true)
      return
    }
    close()
  }

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    setFileError(null)
    try {
      const text = await file.text()
      setBundle(text)
      setFileName(file.name)
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e))
    }
  }

  const versionOk = VERSION_RE.test(version.trim())
  const canPublish = name.trim().length > 0 && versionOk && bundle.trim().length > 0

  const publish = () =>
    run(
      'publish',
      () =>
        api('/api/plugins', PluginStageResponseSchema, {
          method: 'POST',
          json: { name: name.trim(), version: version.trim(), bundle },
        }),
      {
        failure: 'Could not install this plugin',
        onSuccess: (r) => {
          changedRef.current = true
          setResult(r)
        },
      },
    )

  const activate = (pluginId: string) =>
    run('activate', () => api(`/api/plugins/${encodeURIComponent(pluginId)}/activate`, PluginActivateResponseSchema, { method: 'POST' }), {
      success: `${name.trim()}@${version.trim()} activated`,
      failure: 'Could not activate this plugin',
      onSuccess: () => {
        changedRef.current = true
        close()
      },
    })

  const verify = result?.verify
  const stagedId = result?.plugin?.id ?? null
  const failed = result !== null && (verify?.ok === false || result.plugin?.status === 'failed')
  const declared = verify?.scripts ?? result?.plugin?.manifest?.scripts ?? []
  const title = result?.plugin?.title?.trim() || verify?.title?.trim() || name.trim()
  const description = result?.plugin?.description?.trim() || verify?.description?.trim() || null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{result === null ? 'Install a plugin' : failed ? `${name.trim()}@${version.trim()} did not verify` : `Activate ${title}?`}</DialogTitle>
          <DialogDescription asChild>
            <div className="text-[13px] leading-relaxed text-fg-muted">
              {result === null
                ? 'A plugin is one bundle with many scripts inside it. It is verified in a separate process first, and nothing it declares runs until you activate it on the next step.'
                : failed
                  ? 'Nothing was activated. The version is kept in the list as failed so this error stays findable.'
                  : 'It is published but not live yet. This is what it will register:'}
            </div>
          </DialogDescription>
        </DialogHeader>

        {result === null ? (
          <div className="space-y-3.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="plugin-name">Name</Label>
                <Input
                  id="plugin-name"
                  className="readout"
                  placeholder="tiktok"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-[11.5px] text-fg-muted">
                  The identifier, not a human title — it is the KV namespace and half of every <span className="readout">plugin/script@version</span>{' '}
                  reference.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="plugin-version">Version</Label>
                <Input
                  id="plugin-version"
                  className="readout"
                  placeholder="1.0.0"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  aria-invalid={version.length > 0 && !versionOk}
                />
                <p className={version.length > 0 && !versionOk ? 'text-[11.5px] text-led-danger' : 'text-[11.5px] text-fg-muted'}>
                  {version.length > 0 && !versionOk ? 'Three numbers, e.g. 1.0.0 — a suffix like 1.0.0-beta.1 is allowed.' : 'Three numbers, e.g. 1.0.0.'}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="plugin-file">Bundle</Label>
              <input
                id="plugin-file"
                type="file"
                accept=".mjs,.js,text/javascript"
                className="block w-full text-[12.5px] text-fg-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-2.5 file:py-1 file:text-[12.5px] file:text-fg"
                onChange={(e) => void pickFile(e.target.files?.[0])}
              />
              {fileName && (
                <p className="text-[11.5px] text-fg-muted">
                  Read <span className="readout">{fileName}</span> — {bundle.length.toLocaleString()} characters.
                </p>
              )}
              {fileError && <p className="text-[11.5px] text-led-danger">{fileError}</p>}
              <Textarea
                aria-label="Bundle text"
                className="readout max-h-48 min-h-24 text-[11.5px]"
                placeholder="…or paste the built .mjs bundle here"
                value={bundle}
                onChange={(e) => {
                  setBundle(e.target.value)
                  setFileName(null)
                }}
              />
            </div>
          </div>
        ) : failed ? (
          <div className="rounded-md border border-led-danger/30 bg-led-danger/5 px-3 py-2.5">
            <p className="readout text-[11.5px] text-led-danger">{verify?.errorCode ?? result.plugin?.verifyErrorCode ?? 'E_PLUGIN_VERIFY_FAILED'}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-led-danger">
              {verify?.error ?? result.plugin?.verifyError ?? 'The verification process reported no message.'}
            </p>
            {declared.length > 0 && (
              <p className="mt-1.5 text-[11.5px] text-fg-muted">
                {declared.length} script{declared.length === 1 ? '' : 's'} declared ({declared.map((s) => s.id).join(', ')}) — none registered.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border bg-surface-2 px-3 py-2.5">
              <div className="font-medium">{title}</div>
              <div className="readout mt-0.5 text-[11.5px] text-fg-muted">
                {name.trim()}@{version.trim()}
              </div>
              {description ? (
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</p>
              ) : (
                <p className="mt-1.5 text-[12.5px] text-fg-subtle">This plugin describes itself with nothing — it published no description.</p>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-fg-muted">
                {declared.length} script{declared.length === 1 ? '' : 's'} become runnable
              </p>
              {declared.length === 0 ? (
                <p className="text-[12.5px] text-fg-subtle">It declares no scripts at all — activating it registers nothing.</p>
              ) : (
                <ul className="space-y-1">
                  {declared.map((s) => (
                    <li key={s.id} className="readout rounded border bg-surface px-2.5 py-1 text-[11.5px]">
                      {name.trim()}/{s.id}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-[12px] text-fg-muted">
              Activating replaces whichever version of <span className="readout">{name.trim()}</span> is live now. It never touches a job already
              running.
            </p>
          </div>
        )}

        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="outline" onClick={close} disabled={isPending('publish')}>
                Cancel
              </Button>
              <Button
                onClick={() => void publish()}
                disabled={!canPublish || isPending('publish')}
                title={canPublish ? undefined : 'A name, a version like 1.0.0, and a bundle are all required'}
              >
                {isPending('publish') ? 'Verifying…' : 'Publish and verify'}
              </Button>
            </>
          ) : failed ? (
            <>
              <Button variant="outline" onClick={() => setResult(null)}>
                Try another bundle
              </Button>
              <Button onClick={close}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={isPending('activate')}>
                Not now
              </Button>
              {stagedId ? (
                <Button onClick={() => void activate(stagedId)} disabled={isPending('activate')}>
                  {isPending('activate') ? 'Activating…' : 'Activate'}
                </Button>
              ) : (
                <span className="self-center text-[12px] text-fg-muted">
                  The farm did not return the stored version, so it cannot be activated from here — activate it from the row in the list.
                </span>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
