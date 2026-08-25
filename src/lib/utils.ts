import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes, resolving conflicts in favour of the last one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
