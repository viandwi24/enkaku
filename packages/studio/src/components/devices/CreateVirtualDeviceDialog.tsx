'use client'

import { useState } from 'react'
import type { VmRecord, VmSpec } from '@enkaku/protocol'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@enkaku/ui'
import { createVm } from '@/lib/api'

const API_LEVELS = [36, 35] as const
const VARIANTS = [
  { value: 'google_apis', label: 'google_apis (rootable)' },
  { value: 'google_apis_playstore', label: 'google_apis_playstore' },
] as const

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * The Create virtual device dialog (plan 403 §4.3) — modelled on
 * `ScanNetworkDialog.tsx`: five controls over `VmSpecSchema`
 * (`@enkaku/protocol`), everything defaulted except the name. ABI is
 * deliberately not a control — the core derives it from `process.arch`
 * (plan 401 §3.5) — asking an operator to choose `arm64-v8a` vs `x86_64` is
 * asking them to get it wrong.
 *
 * On submit the dialog closes as soon as the AVD exists (`creating →
 * stopped`, plan 402 §11) — it does not wait for a boot, because creating
 * an AVD never starts one (plan 400 D5: cold-booted, on request).
 */
export function CreateVirtualDeviceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (vm: VmRecord) => void
}) {
  const [name, setName] = useState('')
  const [apiLevel, setApiLevel] = useState<number>(36)
  const [variant, setVariant] = useState<VmSpec['variant']>('google_apis')
  const [memoryMb, setMemoryMb] = useState(2048)
  const [deviceProfile, setDeviceProfile] = useState('pixel_7')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const nameError = name.length > 0 && !NAME_PATTERN.test(name) ? 'Only letters, digits, dot, underscore and hyphen.' : null
  const memoryError = memoryMb < 1536 || memoryMb > 8192 ? 'Between 1536 and 8192 MB.' : null
  const canSubmit = name.length > 0 && !nameError && !memoryError && !creating

  const reset = () => {
    setName('')
    setApiLevel(36)
    setVariant('google_apis')
    setMemoryMb(2048)
    setDeviceProfile('pixel_7')
    setError(null)
  }

  const submit = async () => {
    if (!canSubmit) return
    setCreating(true)
    setError(null)
    try {
      const vm = await createVm({ name, apiLevel, variant, memoryMb, deviceProfile })
      onCreated(vm)
      onOpenChange(false)
      reset()
    } catch (err) {
      // `E_ANDROID_SDK_MISSING` (plan 400 D3, 503) carries the exact
      // `sdkmanager` install command in its message. Rendered verbatim below
      // rather than through a toast — truncating it to "SDK not found" would
      // throw away the whole point of the error (plan 403 §4.3).
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create virtual device</DialogTitle>
          <DialogDescription>
            An Android Emulator instance, cold-booted headless. This creates the AVD only — starting it is a separate
            step, and a cold boot takes 30–90 seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="vm-name" className="text-body font-normal">Name</Label>
            <Input
              id="vm-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="test-device-1"
              aria-invalid={!!nameError}
            />
            {nameError && <p className="text-meta text-led-danger">{nameError}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vm-api" className="text-body font-normal">API level</Label>
              <Select value={String(apiLevel)} onValueChange={(v) => setApiLevel(Number(v))}>
                <SelectTrigger id="vm-api" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {API_LEVELS.map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      API {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="vm-variant" className="text-body font-normal">Variant</Label>
              <Select value={variant} onValueChange={(v) => setVariant(v as VmSpec['variant'])}>
                <SelectTrigger id="vm-variant" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VARIANTS.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {variant === 'google_apis_playstore' && (
                <p className="text-meta text-faint">This variant cannot be rooted (adb root is refused).</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vm-memory" className="text-body font-normal">RAM (MB)</Label>
              <Input
                id="vm-memory"
                type="number"
                min={1536}
                max={8192}
                step={256}
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                aria-invalid={!!memoryError}
              />
              {memoryError ? (
                <p className="text-meta text-led-danger">{memoryError}</p>
              ) : (
                <p className="text-meta text-faint">API 37+ phone profiles require at least 4096 MB.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="vm-profile" className="text-body font-normal">Device profile</Label>
              <Input id="vm-profile" value={deviceProfile} onChange={(e) => setDeviceProfile(e.target.value)} mono />
              <p className="text-meta text-faint">`avdmanager list device` on the host lists valid ids.</p>
            </div>
          </div>

          {error && (
            <div className="rounded-inner border border-danger/30 bg-danger-soft px-3 py-2.5">
              <p className="text-meta font-medium text-text">Could not create the virtual device</p>
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-meta text-text-3">{error}</pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
