'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { ScriptListItemSchema, type WorkflowDoc } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState, LoadingRows, Button, describeApiError } from '@enkaku/ui'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { FlowEditor } from '@/components/flow/FlowEditor'
import type { ScriptOption } from '@/components/flow/ScriptPicker'
import { fetchAllPages, fetchWorkflow } from '@/lib/api'

/**
 * The workflow editor screen (plan 210 §4.9, moved to `/scripts/editor` by
 * plan 217 §4.8; the canvas becomes the editor of record by plan 305 —
 * `WorkflowBuilder`/the list view are gone, `FlowEditor` is the only
 * editor). `/scripts/editor` with no `?name=` starts blank;
 * `/scripts/editor?name=X` loads the workflow's document as the starting
 * document — a workflow has no version any more, so there is no "start from
 * version" picker. Studio is a static export (`output: 'export'`), so this
 * is a search-param page, not a dynamic route segment.
 */

const EMPTY_DOC: WorkflowDoc = {
  schema: 2,
  name: '',
  title: '',
  description: '',
  params: [],
  entry: 'start',
  nodes: [{ kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 } }],
  maxSteps: 50,
}

function WorkflowEditorView() {
  const params = useSearchParams()
  const name = params.get('name')
  const router = useRouter()

  const [scripts, setScripts] = useState<ScriptOption[] | null>(null)
  const [scriptsError, setScriptsError] = useState<string | null>(null)
  const [initialDoc, setInitialDoc] = useState<WorkflowDoc | null>(null)
  const [docError, setDocError] = useState<string | null>(null)

  useEffect(() => {
    void fetchAllPages('/api/scripts', undefined, ScriptListItemSchema)
      .then((rows) =>
        setScripts(rows.map((r) => ({ id: r.id, name: r.name, version: r.plugin.version, paramsSchema: r.paramsSchema as JsonSchemaNode | null }))),
      )
      .catch((e) => setScriptsError(describeApiError(e)))
  }, [])

  useEffect(() => {
    if (!name) {
      setInitialDoc(EMPTY_DOC)
      setDocError(null)
      return
    }
    setInitialDoc(null)
    setDocError(null)
    void fetchWorkflow(name)
      .then((w) => setInitialDoc(w.doc))
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
      ) : !scripts || !initialDoc ? (
        <div className="px-5 py-4">
          <LoadingRows rows={4} />
        </div>
      ) : (
        <FlowEditor
          key={name ?? 'new'}
          initialDoc={initialDoc}
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
