import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * Native `<select>`.
 *
 * A custom listbox would need focus trapping, typeahead and ARIA wiring to
 * match what the platform already does correctly — and the column mapper has
 * one of these per CSV column, so keyboard behaviour matters more than looks.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'border-border bg-surface text-ink h-9 w-full rounded-lg border px-2.5 text-sm',
        'hover:border-border-strong transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'border-border bg-surface text-ink placeholder:text-ink-subtle h-9 w-full rounded-lg border px-3 text-sm',
        'hover:border-border-strong transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-ink text-sm font-medium', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'border-border bg-surface text-ink placeholder:text-ink-subtle w-full rounded-lg border px-3 py-2 text-sm',
        'hover:border-border-strong resize-none font-mono leading-relaxed transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
