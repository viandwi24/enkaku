export interface DeviceFileEntry {
  name: string
  kind: 'dir' | 'file'
  /** Bytes, or null when `ls` printed something unparseable. */
  size: number | null
  /** `YYYY-MM-DD HH:MM` as toybox prints it, or null. */
  modified: string | null
}

/**
 * Splits on the `@@enkaku-df@@` marker: `ls -lA` above, one `df -k` line
 * below (plan 215 §3.2 D9, §4.12).
 */
export function parseFilesOutput(stdout: string): { entries: DeviceFileEntry[]; freePct: number | null } {
  const [lsPart = '', dfPart = ''] = stdout.split('@@enkaku-df@@')
  const entries: DeviceFileEntry[] = []

  for (const line of lsPart.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (/^total\s+\d+/.test(trimmed)) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 8) continue
    const mode = parts[0]!
    const nameChunks = parts.slice(7)
    let name = nameChunks.join(' ')
    let kind: 'dir' | 'file' = mode.startsWith('d') ? 'dir' : 'file'
    if (mode.startsWith('l')) {
      const arrowIdx = name.indexOf(' -> ')
      if (arrowIdx !== -1) {
        const target = name.slice(arrowIdx + 4)
        name = name.slice(0, arrowIdx)
        kind = target.endsWith('/') ? 'dir' : 'file'
      }
    }
    const size = /^\d+$/.test(parts[4] ?? '') ? Number(parts[4]) : null
    const modified = parts[5] && parts[6] ? `${parts[5]} ${parts[6]}` : null
    entries.push({ name, kind, size, modified })
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })

  const dfLine = dfPart.trim().split('\n').find((l) => l.trim().length > 0)
  const fields = dfLine?.trim().split(/\s+/) ?? []
  const usedField = fields[4]
  const used = usedField ? Number(usedField.replace('%', '')) : NaN
  const freePct = Number.isFinite(used) ? 100 - used : null

  return { entries, freePct }
}
