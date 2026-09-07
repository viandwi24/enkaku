'use client'

import type { WorkflowDoc, WorkflowNode } from '@enkaku/protocol'
import { Badge, Button, Input, Label, Textarea, cn } from '@enkaku/ui'
import { ParamsEditor } from './ParamsEditor'
import { HistoryPanel } from './HistoryPanel'
import type { UseHistoryResult } from './useHistory'

export type PanelTab = 'properties' | 'node' | 'runs'

/**
 * The editor's right-hand panel (CEO's redesign, 2026-09-07).
 *
 * It replaces a row of form fields that sat ABOVE the canvas and pushed it
 * down: name, identifier and step budget were page furniture on a screen
 * whose whole subject is the graph. Moving them beside it gives the canvas
 * the full height and puts every property in one place instead of two (a
 * header row plus a "More" disclosure).
 *
 * Three tabs, and the middle one is the reason this is a panel rather than a
 * sidebar: **Properties** is the document, **Node** is whatever is selected
 * on the canvas, **Runs** is what it has actually done. Selecting a node
 * switches to Node on its own — the panel follows the canvas rather than
 * making the author go and find the right tab.
 */
export function WorkflowPanel({
  doc,
  dispatch,
  tab,
  onTabChange,
  selectedNode,
  onOpenNode,
  onDuplicateNode,
  onRemoveNode,
  onPatchNode,
  findings,
  runStatus,
  pinnedRunId,
  onPickRun,
}: {
  doc: WorkflowDoc
  dispatch: UseHistoryResult['dispatch']
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  selectedNode: WorkflowNode | null
  onOpenNode: () => void
  onDuplicateNode: () => void
  onRemoveNode: () => void
  onPatchNode: (patch: Record<string, unknown>) => void
  findings: ReadonlyArray<{ severity: string; message: string }>
  /** The sentence under the title — "replaying a finished run · 5 steps", or null when the canvas is showing the document itself. */
  runStatus: string | null
  pinnedRunId: string | null
  onPickRun: (run: { jobId: string; runId: string } | null) => void
}) {
  return (
    <aside className="m-3 flex w-[316px] flex-none flex-col overflow-hidden rounded-card border border-border bg-panel shadow-panel-2">
      <header className="space-y-2 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-text">{doc.title || doc.name}</h2>
          <p className="readout truncate text-[12px] text-dim">{doc.name}</p>
        </div>
        {runStatus && (
          <div className="flex items-center gap-2 rounded-inner bg-muted px-2.5 py-1.5">
            <span className="size-[6px] flex-none rounded-pill bg-faint" aria-hidden />
            <span className="truncate text-[12px] text-dim">{runStatus}</span>
          </div>
        )}
      </header>

      <nav className="flex flex-none gap-1 px-3 pb-3" aria-label="Panel section">
        {(
          [
            ['properties', 'Properties'],
            ['node', 'Node'],
            ['runs', 'Runs'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onTabChange(key)}
            aria-current={tab === key ? 'true' : undefined}
            className={cn(
              'rounded-button px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === key ? 'bg-accent-soft text-accent' : 'text-dim hover:bg-muted hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        {tab === 'properties' && <PropertiesTab doc={doc} dispatch={dispatch} />}
        {tab === 'node' && (
          <NodeTab node={selectedNode} onOpenNode={onOpenNode} onDuplicate={onDuplicateNode} onRemove={onRemoveNode} onPatch={onPatchNode} />
        )}
        {tab === 'runs' && (
          <div className="flex h-full flex-col gap-4">
            {/*
              The warnings live here rather than above the canvas, where they
              used to push the graph down. The chip in the toolbar opens this
              tab, so the count and the list are one click apart.
            */}
            {findings.length > 0 && (
              <div className="space-y-1.5">
                <p className="rack-label">what this document reports</p>
                {findings.map((f, i) => (
                  <p
                    key={i}
                    data-testid="finding"
                    data-severity={f.severity}
                    className={cn(
                      'rounded-inner border px-2.5 py-1.5 text-[11.5px] leading-relaxed',
                      f.severity === 'error' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-warn/30 bg-warn-soft text-warn',
                    )}
                  >
                    {f.message}
                  </p>
                ))}
              </div>
            )}
            <div className="-mx-4 min-h-0 flex-1">
              <HistoryPanel workflowName={doc.name} selectedRunId={pinnedRunId} onSelect={onPickRun} />
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] font-medium text-text">{label}</Label>
      {children}
      {hint && <p className="text-[11.5px] leading-relaxed text-dim">{hint}</p>}
    </div>
  )
}

function PropertiesTab({ doc, dispatch }: { doc: WorkflowDoc; dispatch: UseHistoryResult['dispatch'] }) {
  return (
    <div className="space-y-4">
      <Field label="Name">
        <Input
          value={doc.title}
          onChange={(e) => dispatch({ t: 'set-meta', patch: { title: e.target.value } }, 'meta-title')}
          aria-label="Name"
        />
      </Field>

      {/*
        Shown, never edited. `name` is the identity the URL, the API path and
        every schedule pointing at this workflow use (spec §4.7): renaming it
        would break a schedule silently, which is exactly the edit a text
        input invites. It reads as a field because it is a fact worth seeing.
      */}
      <Field label="Identifier" hint="Used by the API and the job records.">
        <p
          className="readout flex h-9 items-center truncate rounded-input border border-border bg-muted px-3 text-[12.5px] text-dim"
          title={`${doc.name} — used by URLs, the API and schedules`}
        >
          {doc.name}
        </p>
      </Field>

      <Field label="Description">
        <Textarea
          className="min-h-20"
          value={doc.description}
          onChange={(e) => dispatch({ t: 'set-meta', patch: { description: e.target.value } }, 'meta-description')}
          aria-label="Description"
        />
      </Field>

      <Field label="Step budget" hint="The run stops once this many steps have executed.">
        <Input
          type="number"
          min={1}
          max={500}
          value={doc.maxSteps}
          onChange={(e) => dispatch({ t: 'set-meta', patch: { maxSteps: Math.max(1, Math.min(500, e.target.valueAsNumber || 1)) } }, 'meta-maxSteps')}
          aria-label="Maximum node executions"
        />
      </Field>

      <div className="space-y-2 border-t border-line pt-4">
        <p className="rack-label">workflow parameters</p>
        <ParamsEditor params={doc.params} onChange={(params) => dispatch({ t: 'set-meta', patch: { params } })} />
      </div>
    </div>
  )
}

function NodeTab({
  node,
  onOpenNode,
  onDuplicate,
  onRemove,
  onPatch,
}: {
  node: WorkflowNode | null
  onOpenNode: () => void
  onDuplicate: () => void
  onRemove: () => void
  onPatch: (patch: Record<string, unknown>) => void
}) {
  if (!node) {
    return <p className="text-[12.5px] leading-relaxed text-dim">Select a node on the canvas to see what it holds.</p>
  }
  const script = node.kind === 'script' ? node.script : null
  const pinned = script ? !script.endsWith('@latest') : false
  return (
    <div className="space-y-4">
      <Field label="Label">
        <Input value={node.title ?? ''} onChange={(e) => onPatch({ title: e.target.value })} aria-label="Node label" />
      </Field>

      <Field label="Identifier">
        <p className="readout flex h-9 items-center truncate rounded-input border border-border bg-muted px-3 text-[12.5px] text-dim">{node.id}</p>
      </Field>

      {script && (
        <Field label="Script">
          <div className="flex items-center gap-2">
            <p className="readout min-w-0 flex-1 truncate rounded-input border border-border bg-muted px-3 py-2 text-[12px] text-dim">{script}</p>
            {/*
              A pinned version is a promise that this node keeps running the
              same code; `@latest` is a promise that it follows the plugin.
              Which one is in force is the single most consequential thing
              about a script node and it was readable only by squinting at
              the end of the reference.
            */}
            <Badge variant={pinned ? 'outline' : 'default'}>{pinned ? 'pinned' : 'latest'}</Badge>
          </div>
        </Field>
      )}

      {node.kind === 'script' && (
        <Field label="Retries" hint="Overrides the script's own retry count. Empty uses the script's.">
          <Input
            type="number"
            min={0}
            max={10}
            value={node.retries ?? ''}
            placeholder="script default"
            onChange={(e) => onPatch({ retries: e.target.value === '' ? undefined : Math.max(0, Math.min(10, e.target.valueAsNumber || 0)) })}
            aria-label="Retries"
          />
        </Field>
      )}

      {node.kind === 'script' && (
        <Field label="On error" hint={node.onFailure ? undefined : 'Nothing is wired, so a failure here ends the run failed.'}>
          <p className="readout flex h-9 items-center truncate rounded-input border border-border bg-muted px-3 text-[12.5px] text-dim">
            {node.onFailure ?? 'end the run'}
          </p>
        </Field>
      )}

      {/*
        The full node editor is a wide sheet — parameters, bindings, mocks,
        pins. This tab holds what an author changes while looking at the
        graph, and hands over for the rest rather than being a second,
        smaller copy of an editor that already exists.
      */}
      <Button type="button" variant="outline" className="w-full" onClick={onOpenNode}>
        Open node editor
      </Button>

      <div className="flex gap-2 border-t border-line pt-4">
        <Button type="button" variant="outline" className="flex-1" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button type="button" variant="outline" className="flex-1 text-danger" onClick={onRemove}>
          Delete
        </Button>
      </div>
    </div>
  )
}
