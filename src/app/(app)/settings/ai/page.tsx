import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { aiCredentials } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { getUsageSummary } from '../actions'
import { AiSettings } from './ai-settings'

export const metadata: Metadata = { title: 'AI settings' }

export default async function AiSettingsPage() {
  const user = await requireUser()

  const [credential, usage] = await Promise.all([
    db.query.aiCredentials.findFirst({ where: eq(aiCredentials.userId, user.id) }),
    getUsageSummary(),
  ])

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Settings / AI</h1>
      </header>
      <main className="flex-1 p-6">
        <AiSettings
          usage={usage}
          credential={
            credential
              ? {
                  keyLast4: credential.keyLast4,
                  defaultModel: credential.defaultModel,
                  usePromptCaching: credential.usePromptCaching,
                  useBatchApi: credential.useBatchApi,
                  lastValidatedAt: credential.lastValidatedAt,
                }
              : null
          }
        />
      </main>
    </>
  )
}
