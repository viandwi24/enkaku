'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { ScriptListItemSchema, ScriptResponseSchema } from '@enkaku/protocol'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState, LoadingRows, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, api, describeApiError } from '@enkaku/ui'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { WorkflowBuilder } from '@/components/workflow/WorkflowBuilder'
import { bumpPatchVersion, docToDraft, emptyDraft, type WorkflowDocDraft } from '@/components/workflow/model'
import type { ScriptOption } from '@/components/workflow/ScriptPicker'
import { fetchAllPages, fetchWorkflowVersions, type WorkflowVersionOption } from '@/lib/api'

/**
 * The editor screen (plan 99 §3.9, §4.11, §5 step 99.9). `/workflows/editor`
 * with no `?name=` starts blank; `/workflows/editor?name=X` loads the newest
 * published version of `X` as the starting draft — the "start from version"
 * picker `GET /api/workflows/:name/versions` exists for (§4.9). Studio is a
 * static export (`output: 'export'`, CLAUDE.md), so this is a search-param
 * page, not a dynamic route segment — the same reason the device page is
 * `/device?id=...` rather than `/device/[id]`.
 */
function WorkflowEditorView() {
  const params = useSearchParams()
  const name = params.get('name')
  const router = useRouter()

  const [scripts, setScripts] = useState<ScriptOption[] | null>(null)
  const [scriptsError, setScriptsError] = useState<string | null>(null)
  const [versions, setVersions] = useState<WorkflowVersionOption[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [initialDraft, setInitialDraft] = useState<WorkflowDocDraft | null>(null)
  const [docError, setDocError] = useState<string | null>(null)

  useEffect(() => {
    void fetchAllPages('/api/scripts', { kind: 'script' }, ScriptListItemSchema)
      .then((rows) =>
        setScripts(
          // `paramsSchema` is `@enkaku/protocol`'s plain-index-signature `JsonSchemaNode`;
          // this cast to Studio's own (more specific) type is the same reconciliation
          // `RunScriptDialog.tsx` documents for the identical two-parallel-type situation —
          // not a bypass of validation, `ScriptListItemSchema.safeParse` already ran above.
          rows.map((r) => ({ id: r.id, name: r.name, version: r.version, enabled: r.enabled, paramsSchema: r.paramsSchema as JsonSchemaNode | null })),
        ),
      )
      .catch((e) => setScriptsError(describeApiError(e)))
  }, [])

  const loadVersion = (versionId: string, versionList: WorkflowVersionOption[]) => {
    setSelectedVersionId(versionId)
    setInitialDraft(null)
    setDocError(null)
    void api(`/api/scripts/${versionId}`, ScriptResponseSchema)
      .then((b) => {
        const doc = b.script.workflow
        if (!doc) {
          setDocError('That script is not a workflow.')
          return
        }
        const newest = versionList[0]
        setInitialDraft(docToDraft(doc, versionId === newest?.id ? bumpPatchVersion(doc.version) : doc.version))
      })
      .catch((e) => setDocError(describeApiError(e)))
  }

  useEffect(() => {
    if (!name) {
      setInitialDraft(emptyDraft())
      setVersions([])
      setSelectedVersionId(null)
      return
    }
    setInitialDraft(null)
    setDocError(null)
    void fetchWorkflowVersions(name)
      .then((items) => {
        setVersions(items)
        const newest = items[0]
        if (!newest) {
          setDocError(`No published version of "${name}" was found.`)
          return
        }
        loadVersion(newest.id, items)
      })
      .catch((e) => setDocError(describeApiError(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  const backAction = (
    <Button asChild variant="ghost" size="sm">
      <Link href="/workflows">
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
      <PageHeader
        title={name ?? 'New workflow'}
        description="A pipeline of scripts on one device, under one lease"
        actions={backAction}
        meta={
          name && versions.length > 1 ? (
            <Select value={selectedVersionId ?? ''} onValueChange={(id) => loadVersion(id, versions)}>
              <SelectTrigger className="readout h-8 w-40 text-[12px]" aria-label="Start from version">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v, i) => (
                  <SelectItem key={v.id} value={v.id} className="readout">
                    start from {v.version}
                    {i === 0 ? ' · latest' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

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
          key={selectedVersionId ?? 'new'}
          initialDraft={initialDraft}
          scripts={scripts}
          onPublished={() => router.push('/workflows')}
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
