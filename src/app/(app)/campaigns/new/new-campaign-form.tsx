'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select } from '@/components/ui/select'
import { createCampaign, startGeneration } from '../actions'

interface Props {
  lists: { id: string; name: string; contactCount: number }[]
  templates: { id: string; name: string }[]
}

export function NewCampaignForm({ lists, templates }: Props) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [listId, setListId] = useState(lists[0]?.id ?? '')
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [generateNow, setGenerateNow] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selectedList = lists.find((l) => l.id === listId)
  const blocked = !name.trim() || !listId || !templateId

  function submit() {
    setError(null)
    startTransition(async () => {
      const created = await createCampaign({ name, listId, templateId })
      if (!created.ok) {
        setError(created.error)
        return
      }
      if (generateNow) {
        const started = await startGeneration(created.data.id)
        if (!started.ok) {
          setError(started.error)
          // The campaign exists; the user can retry generation from its page.
          router.push(`/campaigns/${created.data.id}`)
          return
        }
      }
      router.push(`/campaigns/${created.data.id}`)
    })
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      {error && (
        <div
          role="alert"
          className="border-danger/30 bg-danger/10 text-danger mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New campaign</CardTitle>
          <CardDescription>
            A campaign pairs one contact list with one template. Generation runs in the background,
            so a large list is not bounded by this page staying open.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Campaign name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q3 outreach"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="list">Contact list</Label>
            <Select id="list" value={listId} onChange={(e) => setListId(e.target.value)}>
              {lists.length === 0 && <option value="">No lists — import a CSV first</option>}
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.contactCount} contacts)
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template">Template</Label>
            <Select
              id="template"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templates.length === 0 && <option value="">No templates — write one first</option>}
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={generateNow}
              onChange={(e) => setGenerateNow(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Start generating immediately</span>
              <span className="text-ink-muted block text-xs">
                Queues the work for the background worker. Nothing is sent — every email lands in
                review first.
              </span>
            </span>
          </label>

          {selectedList && selectedList.contactCount === 0 && (
            <p className="text-warning text-sm">That list has no contacts.</p>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex justify-end">
        <Button onClick={submit} disabled={pending || blocked}>
          {pending ? <Loader2 className="animate-spin" /> : <Check />}
          {generateNow ? 'Create and generate' : 'Create campaign'}
        </Button>
      </div>
    </div>
  )
}
