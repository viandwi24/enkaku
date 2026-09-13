'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { ScriptListItem, WorkflowDoc, WorkflowFinding } from '@enkaku/protocol'
import { Button, cn } from '@enkaku/ui'
import { slugifyWorkflowName } from '@/components/scripts/NewWorkflowDialog'
import { listWorkflows, saveWorkflow, validateWorkflow, WorkflowPublishError, type WorkflowInfo } from '@/lib/api'
import { FlowCanvas } from './FlowCanvas'

const noop = (): void => undefined

const TITLE_MAX = 80
const COPY_SUFFIX = ' (copy)'

function titleWithCopySuffix(title: string): string {
  const base = title || 'Untitled'
  const max = TITLE_MAX - COPY_SUFFIX.length
  return (base.length > max ? base.slice(0, max) : base) + COPY_SUFFIX
}

/** The part of a plugin workflow's name after its `<plugin>/` prefix. */
function unprefixedName(name: string): string {
  const at = name.indexOf('/')
  return at === -1 ? name : name.slice(at + 1)
}

async function pickFreeName(base: string): Promise<string> {
  const existing = await listWorkflows()
  const names = new Set(existing.map((w) => w.name))
  if (!names.has(base)) return base
  let candidate = `${base}-copy`
  let n = 2
  while (names.has(candidate)) {
    candidate = `${base}-copy-${n}`
    n += 1
  }
  return candidate
}

function duplicateDoc(source: WorkflowDoc, name: string): WorkflowDoc {
  const copy = JSON.parse(JSON.stringify(source)) as WorkflowDoc
  copy.name = name
  copy.title = titleWithCopySuffix(source.title)
  return copy
}

/**
 * The read-only view of a plugin-provided workflow (plan 315). A plugin
 * workflow updates when the plugin does, so it is never opened in
 * `FlowEditor` — this renders the same canvas the editor uses
 * (`FlowCanvas`, `readOnly`, the same no-op handlers `WorkflowSteps.tsx`
 * uses for its replay canvas) plus the findings `validateWorkflow` would
 * show in the editor's own Validate button, since a plugin workflow can
 * reference another plugin's scripts that are not installed on this farm.
 */
export function PluginWorkflowView({ workflow, scripts }: { workflow: WorkflowInfo; scripts: ScriptListItem[] }) {
  const router = useRouter()
  const [findings, setFindings] = useState<WorkflowFinding[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFindings(null)
    void validateWorkflow(workflow.doc)
      .then((f) => {
        if (!cancelled) setFindings(f)
      })
      .catch(() => {
        if (!cancelled) setFindings([])
      })
    return () => {
      cancelled = true
    }
  }, [workflow.doc])

  const installedScriptNames = new Set(scripts.map((s) => s.name))
  const notInstalledScriptRefs = new Set<string>()
  for (const n of workflow.doc.nodes) {
    if (n.kind !== 'script' || !n.script) continue
    const at = n.script.lastIndexOf('@')
    const name = at > 0 ? n.script.slice(0, at) : n.script
    if (!installedScriptNames.has(name)) notInstalledScriptRefs.add(n.script)
  }

  async function duplicate(): Promise<void> {
    setBusy(true)
    try {
      const base = slugifyWorkflowName(unprefixedName(workflow.name))
      const name = await pickFreeName(base)
      const doc = duplicateDoc(workflow.doc, name)
      await saveWorkflow(doc, 'create')
      router.push(`/scripts/editor?name=${encodeURIComponent(name)}`)
    } catch (e) {
      const message =
        e instanceof WorkflowPublishError && e.findings.length > 0 ? e.findings.map((f) => f.message).join('; ') : e instanceof Error ? e.message : String(e)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-row font-semibold text-text">{workflow.doc.title || workflow.name}</h1>
          <p className="readout text-[11.5px] text-faint">{workflow.name}</p>
          <p className="max-w-xl text-[11.5px] text-dim">
            Provided by the {workflow.pluginName} plugin. It updates when that plugin does, so it can&apos;t be edited here — duplicate it to make your
            own version.
          </p>
        </div>
        <Button onClick={() => void duplicate()} disabled={busy}>
          {busy ? 'Duplicating…' : 'Duplicate to edit'}
        </Button>
      </div>

      {/*
        Errors are always open; warnings fold behind one line. Measured on
        `smm/warmup-rotation` (2026-09-14): sixteen warnings and no error pushed
        the canvas — the thing an operator opens this page to review — below the
        fold, while none of the sixteen stops the workflow running. An error
        does stop it (a script another plugin was meant to provide, not
        installed here), so an error is never folded.
      */}
      {findings && findings.some((f) => f.severity === 'error') && (
        <div className="space-y-1.5">
          <p className="rack-label">what stops this workflow running</p>
          {findings
            .filter((f) => f.severity === 'error')
            .map((f, i) => (
              <p key={i} className="rounded-inner border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-[11.5px] leading-relaxed text-danger">
                {f.message}
              </p>
            ))}
        </div>
      )}
      {findings && findings.some((f) => f.severity !== 'error') && (
        <details className="group">
          <summary className="cursor-pointer text-[11.5px] text-warn select-none">
            {findings.filter((f) => f.severity !== 'error').length} warning{findings.filter((f) => f.severity !== 'error').length === 1 ? '' : 's'} — none of
            them stop it running
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {findings
              .filter((f) => f.severity !== 'error')
              .map((f, i) => (
                <p key={i} className={cn('rounded-inner border border-warn/30 bg-warn-soft px-2.5 py-1.5 text-[11.5px] leading-relaxed text-warn')}>
                  {f.message}
                </p>
              ))}
          </div>
        </details>
      )}

      <div className="min-h-0 flex-1">
        <FlowCanvas
          doc={workflow.doc}
          findings={findings ?? []}
          selectedIds={new Set()}
          notInstalledScriptRefs={notInstalledScriptRefs}
          pinnedIds={new Set()}
          readOnly
          onSelectionChange={noop}
          onNodesMoved={noop}
          onEdgeChange={noop}
          onEdgesRemoved={noop}
          onNodesRemoved={noop}
          onInsertOnEdge={noop}
          onConnectToEmpty={noop}
        />
      </div>
    </div>
  )
}
