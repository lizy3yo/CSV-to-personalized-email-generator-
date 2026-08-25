import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'

/**
 * The signed-in user, or a redirect to /login.
 *
 * Every Server Action calls this first. proxy.ts already gates page routes,
 * but Server Actions are POST endpoints reachable directly — a matcher change
 * or a crafted request must never reach one unauthenticated.
 */
export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

/** Throwing variant, for actions that return a result object rather than redirect. */
export async function requireUserId(): Promise<string> {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not signed in')
  return user.id
}
