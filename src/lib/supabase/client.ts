import { createBrowserClient } from '@supabase/ssr'
import { clientEnv } from '@/env'

/**
 * Browser-side Supabase client. Auth only.
 *
 * All data access goes through Drizzle on the server — PostgREST cannot
 * express `SELECT ... FOR UPDATE SKIP LOCKED`, which the job queue depends on,
 * and the review screen's joins get awkward fast through it.
 */
export function createClient() {
  return createBrowserClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
