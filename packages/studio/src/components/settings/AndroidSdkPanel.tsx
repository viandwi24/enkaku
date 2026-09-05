'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AndroidSdkStatus } from '@enkaku/protocol'
import { Badge, Button, Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, cn } from '@enkaku/ui'
import { fetchAndroidSdk, fetchSdkInstallLog, installAndroidSdk } from '@/lib/api'
import { toast } from 'sonner'

const API_LEVELS = [36, 35, 34, 33, 31, 30] as const

/**
 * Settings → Virtual devices → the Android SDK.
 *
 * What it is for: telling an operator what the host is missing BEFORE they
 * create a virtual device and watch it fail two minutes in. Every line here
 * is read off the host's own disk.
 *
 * What it deliberately is not: a downloader. `core/src/vm/sdk.ts` states the
 * rule — "Enkaku never downloads it (a system image is 1.5-3 GB and is
 * covered by the Android SDK Terms)" — and the button below respects it by
 * running the operator's OWN `sdkmanager`. Enkaku supplies the button and the
 * progress; never the bytes, and never the consent.
 *
 * There is no directory field, and that is the design rather than an
 * omission. A browser cannot pick a folder on a server, so a "choose a
 * directory" control is really a free-text path the core obeys — an
 * authenticated operator telling it to write gigabytes anywhere it can reach,
 * over the network in server mode. Two destinations, both chosen here, close
 * that without costing anyone anything real.
 */
export function AndroidSdkPanel() {
  const [sdk, setSdk] = useState<AndroidSdkStatus | null>(null)
  const [target, setTarget] = useState<'detected' | 'managed'>('detected')
  const [apiLevel, setApiLevel] = useState<number>(35)
  const [withImage, setWithImage] = useState(true)
  const [accepted, setAccepted] = useState(false)
  const [installId, setInstallId] = useState<string | null>(null)
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const refresh = useCallback(() => {
    void fetchAndroidSdk()
      .then(setSdk)
      .catch(() => setSdk(null))
  }, [])
  useEffect(refresh, [refresh])

  // Poll the log while an install runs. `sdkmanager` prints a progress line
  // per percent on a big image, so this is the cheapest honest way to show
  // that something is happening.
  useEffect(() => {
    if (!installId) return
    let disposed = false
    const tick = () =>
      void fetchSdkInstallLog(installId)
        .then((l) => {
          if (disposed) return
          setLines(l.lines)
          if (l.done) {
            setRunning(false)
            setInstallId(null)
            refresh()
            if (l.error) toast.error(l.error)
            else toast.success('Android SDK packages installed.')
          }
        })
        .catch(() => undefined)
    tick()
    const timer = setInterval(tick, 1500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [installId, refresh])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [lines])

  const start = async () => {
    setRunning(true)
    setLines([])
    try {
      const id = await installAndroidSdk({
        target,
        packages: sdk?.emulator ? [] : ['emulator'],
        ...(withImage ? { systemImage: { apiLevel, variant: 'google_apis' as const, abi: navigator.userAgent.includes('Intel') ? ('x86_64' as const) : ('arm64-v8a' as const) } } : {}),
        acceptLicenses: accepted,
      })
      setInstallId(id)
    } catch (err) {
      setRunning(false)
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (!sdk) return <div className="px-[14px] py-3 text-body text-dim">Reading the host’s Android SDK…</div>

  const canInstall = sdk.sdkmanager && accepted && !running && (!sdk.emulator || withImage)

  return (
    <div className="space-y-3 px-[14px] py-3">
      <div className="space-y-1.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <Row label="SDK root" value={sdk.root ?? 'not found'} note={sdk.root ? `found by: ${SOURCE_LABEL[sdk.source]}` : undefined} bad={!sdk.root} />
        <Row label="emulator" value={sdk.emulator ? 'installed' : 'missing'} bad={!sdk.emulator} />
        <Row label="sdkmanager" value={sdk.sdkmanager ? 'installed' : 'missing'} bad={!sdk.sdkmanager} />
        <Row label="platforms" value={sdk.platforms.join(', ') || 'none'} bad={sdk.platforms.length === 0} />
        <Row label="system images" value={sdk.systemImages.length === 0 ? 'none' : `${sdk.systemImages.length} installed`} bad={sdk.systemImages.length === 0} />
      </div>

      {sdk.remedy && <p className="rounded-inner border border-warn/30 bg-warn-soft px-3 py-2 text-body text-warn">{sdk.remedy}</p>}

      <div className="space-y-2.5 rounded-inner border border-line bg-panel-2 px-3 py-2.5">
        <p className="text-label text-faint">INSTALL PACKAGES</p>
        <p className="text-body text-dim">
          Runs this host’s own <span className="font-mono">sdkmanager</span>. Enkaku does not download the Android SDK — a system image is 1.5–3 GB and is covered by the Android SDK Terms.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-body text-dim">Install into</Label>
          <Select value={target} onValueChange={(v) => setTarget(v as 'detected' | 'managed')}>
            <SelectTrigger className="h-8 w-[320px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="detected">{sdk.root ?? 'the detected SDK'}</SelectItem>
              <SelectItem value="managed">{sdk.managedRoot} (this farm’s own)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <label className="flex items-center gap-2 text-body text-text">
          <Checkbox checked={withImage} onCheckedChange={(v) => setWithImage(v === true)} />
          Also install a system image for
          <Select value={String(apiLevel)} onValueChange={(v) => setApiLevel(Number(v))}>
            <SelectTrigger className="h-7 w-[130px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {API_LEVELS.map((a) => (
                <SelectItem key={a} value={String(a)}>
                  API {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {/* The licence is shown, not hidden behind the button. Accepting one
            on an operator's behalf is a legal act, not a convenience. */}
        <label className="flex items-start gap-2 text-body text-text">
          <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} className="mt-[2px]" />
          <span>
            I accept the{' '}
            <a href="https://developer.android.com/studio/terms" target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              Android SDK Terms and Conditions
            </a>{' '}
            for the packages installed by this action.
          </span>
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!canInstall} onClick={() => void start()}>
            {running ? <Spinner className="size-3.5" /> : null}
            {running ? 'Installing…' : 'Install'}
          </Button>
          {!sdk.sdkmanager && <span className="text-meta text-faint">sdkmanager is missing, so nothing can be installed from here yet.</span>}
        </div>

        {lines.length > 0 && (
          <pre ref={logRef} className="max-h-[180px] overflow-auto rounded-inner border border-line bg-panel px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-dim">
            {lines.join('\n')}
          </pre>
        )}
      </div>
    </div>
  )
}

const SOURCE_LABEL: Record<AndroidSdkStatus['source'], string> = {
  override: 'ENKAKU_ANDROID_SDK_PATH',
  env: 'ANDROID_SDK_ROOT / ANDROID_HOME',
  default: 'the per-OS default location',
  missing: 'nothing',
}

function Row({ label, value, note, bad }: { label: string; value: string; note?: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-body">
      <span className="w-[110px] flex-none text-faint">{label}</span>
      <span className={cn('min-w-0 flex-1 font-mono text-[11.5px] break-all', bad ? 'text-warn' : 'text-text')}>{value}</span>
      {note && <Badge variant="outline">{note}</Badge>}
    </div>
  )
}
