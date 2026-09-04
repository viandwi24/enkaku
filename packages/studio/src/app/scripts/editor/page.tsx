'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { ScriptListItemSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState, LoadingRows, Button, describeApiError } from '@enkaku/ui'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { WorkflowBuilder } from '@/components/workflow/WorkflowBuilder'
import { docToDraft, emptyDraft, type WorkflowDocDraft } from '@/components/workflow/model'
import type { ScriptOption } from '@/components/workflow/ScriptPicker'
import { fetchAllPages, fetchWorkflow } from '@/lib/api'

/**
 * The workflow editor screen (plan 210 §4.9, moved to `/scripts/editor` by
 * plan 217 §4.8). `/scripts/editor` with no `?name=` starts blank;
 * `/scripts/editor?name=X` loads the workflow's document as the starting
 * draft — a workflow has no version any more, so there is no "start from
 * version" picker. Studio is a static export (`output: 'export'`), so this
 * is a search-param page, not a dynamic route segment.
 *
 * The editor's own internals (`WorkflowBuilder`, `NodeCard`,
 * `WorkflowCanvas`, `ScriptPicker`) are reused whole, per MVP 15 §2
 * ("the workflow editor is undesigned; the handoff only draws the card
 * list") — this file only moves the route and repoints `/workflows` links.
 */
function WorkflowEditorView() {
  const params = useSearchParams()
  const name = params.get('name')
  const router = useRouter()

  const [scripts, setScripts] = useState<ScriptOption[] | null>(null)
  const [scriptsError, setScriptsError] = useState<string | null>(null)
  const [initialDraft, setInitialDraft] = useState<WorkflowDocDraft | null>(null)
  const [docError, setDocError] = useState<string | null>(null)

  useEffect(() => {
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((rows) =>
        setScripts(
          rows.map((r) => ({ id: r.id, name: r.name, version: r.plugin.version, paramsSchema: r.paramsSchema as JsonSchemaNode | null })),
        ),
      )
      .catch((e) => setScriptsError(describeApiError(e)))
  }, [])

  useEffect(() => {
    if (!name) {
      setInitialDraft(emptyDraft())
      setDocError(null)
      return
    }
    setInitialDraft(null)
    setDocError(null)
    void fetchWorkflow(name)
      .then((w) => setInitialDraft(docToDraft(w.doc)))
      .catch((e) => setDocError(describeApiError(e)))
  }, [name])

  const backAction = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/scripts?tab=workflows">
        <ArrowLeft className="size-4" aria-hidden />
        All workflows
      </Link>
    </Button>
  )

  if (scriptsError) {
    return (
      <div className="px-5 py-4">
        <ErrorState message={scriptsError} />
      </div>
    )
  }

  return (
    <>
      <PageHeader title={name ?? 'New workflow'} description="A pipeline of scripts on one device" actions={backAction} />

      {docError ? (
        <div className="px-5 py-4">
          <ErrorState message={docError} />
        </div>
      ) : !scripts || !initialDraft ? (
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      ) : (
        <WorkflowBuilder
          key={name ?? 'new'}
          initialDraft={initialDraft}
          scripts={scripts}
          mode={name ? 'update' : 'create'}
          onSaved={() => router.push('/scripts?tab=workflows')}
        />
      )}
    </>
  )
}

export default function WorkflowEditorPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      }
    >
      <WorkflowEditorView />
    </Suspense>
  )
}
