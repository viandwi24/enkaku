'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { normaliseTag } from '@enkaku/protocol'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { api, useAction } from '@/lib/actions'

interface TagSuggestion {
  tag: string
  count: number
}

/**
 * The tags field on a device's Settings tab (plan 19 §4.5): a token input
 * with suggestions from `GET /api/tags`, showing the normalised form as you
 * type so the transformation (plan 19 §3.4) is never a surprise.
 *
 * Each add/remove PUTs the whole set straight away — `PUT` replaces rather
 * than patches (plan 19 §4.3), so there is no separate "save" step to forget,
 * and the change is immediately visible in the picker and the list filter.
 */
export function TagEditor({ deviceId, tags }: { deviceId: string; tags: string[] }) {
  const [current, setCurrent] = useState(tags)
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const { run, isPending } = useAction()

  useEffect(() => setCurrent(tags), [tags])

  useEffect(() => {
    void api<{ tags: TagSuggestion[] }>('/api/tags')
      .then((b) => setSuggestions(b.tags))
      .catch(() => setSuggestions([]))
  }, [])

  const save = (next: string[]) =>
    run('tags', () => api<{ tags: string[] }>(`/api/devices/${deviceId}/tags`, { method: 'PUT', json: { tags: next } }), {
      failure: 'Could not save the tags',
      onSuccess: (b) => {
        setCurrent(b.tags)
        setDraft('')
      },
    })

  const addTag = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (current.includes(normaliseTag(trimmed))) {
      setDraft('')
      return
    }
    void save([...current, trimmed])
  }

  const removeTag = (tag: string) => void save(current.filter((t) => t !== tag))

  const busy = isPending('tags')
  const preview = draft.trim() ? normaliseTag(draft.trim()) : null
  const unusedSuggestions = suggestions.filter((s) => !current.includes(s.tag))

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {current.length === 0 && <span className="text-[12px] text-fg-muted">No tags yet.</span>}
        {current.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 py-0.5 pr-1">
            <span className="readout">{tag}</span>
            <button
              type="button"
              onClick={() => removeTag(tag)}
              disabled={busy}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 hover:bg-surface-3"
            >
              <X className="size-3" aria-hidden />
            </button>
          </Badge>
        ))}
      </div>

      <div className="max-w-sm space-y-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag(draft)
            }
          }}
          placeholder="Add a tag, e.g. pool:smoke"
          aria-label="Add a tag"
          disabled={busy}
          className="h-8 text-[12.5px]"
        />
        {preview && preview !== draft.trim() && (
          <p className="text-[11px] text-fg-subtle">
            Stored as <span className="readout">{preview}</span>
          </p>
        )}
      </div>

      {unusedSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unusedSuggestions.slice(0, 12).map((s) => (
            <button
              key={s.tag}
              type="button"
              onClick={() => addTag(s.tag)}
              disabled={busy}
              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted hover:border-line-strong"
            >
              <span className="readout">{s.tag}</span> <span className="text-fg-subtle">×{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
