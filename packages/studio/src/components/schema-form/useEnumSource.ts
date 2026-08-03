'use client'

import { useEffect, useState } from 'react'
import type { RegistryResponse } from '@enkaku/protocol'
import { coreBase } from '@/lib/ws'

export interface EnumOption {
  value: string
  label: string
  /** Selectable; false means it is listed but disabled. */
  available: boolean
  reason?: string
}

/**
 * Enriches dropdowns with data from `/api/registry`.
 *
 * The schema enum is already enough to build a correct dropdown. This adds a
 * second layer: readable display names ("ADB (USB)" rather than "adb-usb")
 * and a marker for engines that are not available yet, along with the reason
 * — so people can tell something exists but is not ready, instead of
 * assuming it is missing.
 *
 * If the registry cannot be fetched the dropdown still works from the plain
 * enum. The improvement does not depend on the most fragile part.
 */
let cache: RegistryResponse | null = null
let inflight: Promise<RegistryResponse | null> | null = null

export async function fetchRegistry(): Promise<RegistryResponse | null> {
  if (cache) return cache
  inflight ??= fetch(`${coreBase()}/api/registry`)
    .then((r) => (r.ok ? (r.json() as Promise<RegistryResponse>) : null))
    .then((r) => {
      cache = r
      return r
    })
    .catch(() => null)
  return inflight
}

const KEY_MAP: Record<string, keyof RegistryResponse> = {
  'registry.transports': 'transports',
  'registry.displays': 'displays',
  'registry.inputs': 'inputs',
  'registry.inspectors': 'inspectors',
  'registry.networks': 'networks',
}

export function useEnumOptions(enumValues: unknown[] | undefined, enumSource: string | undefined): EnumOption[] {
  const plain: EnumOption[] = (enumValues ?? []).map((v) => ({
    value: String(v),
    label: String(v),
    available: true,
  }))
  const [options, setOptions] = useState<EnumOption[]>(plain)

  useEffect(() => {
    if (!enumSource || !KEY_MAP[enumSource]) {
      setOptions(plain)
      return
    }
    let cancelled = false
    void fetchRegistry().then((registry) => {
      if (cancelled || !registry) return
      const entries = registry[KEY_MAP[enumSource]!] as Array<{
        id: string
        displayName: string
        available: boolean
        unavailableReason?: string
      }>
      setOptions(
        plain.map((o) => {
          const match = entries.find((e) => e.id === o.value)
          if (!match) return o
          return {
            value: o.value,
            label: match.displayName,
            available: match.available,
            ...(match.unavailableReason ? { reason: match.unavailableReason } : {}),
          }
        }),
      )
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enumSource, JSON.stringify(enumValues)])

  return options
}
