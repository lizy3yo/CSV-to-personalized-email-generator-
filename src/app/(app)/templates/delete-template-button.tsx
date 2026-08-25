'use client'

import { useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { deleteTemplate } from './actions'

export function DeleteTemplateButton({ templateId, name }: { templateId: string; name: string }) {
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${name}`}
        onClick={() => setConfirming(true)}
      >
        <Trash2 />
      </Button>
    )
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-ink-muted text-xs">Delete this template?</span>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteTemplate(templateId)
              if (!result.ok) {
                setError(result.error)
                setConfirming(false)
              }
            })
          }
        >
          {pending ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
