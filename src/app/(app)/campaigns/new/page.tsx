import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getCampaignOptions } from '../actions'
import { NewCampaignForm } from './new-campaign-form'

export const metadata: Metadata = { title: 'New campaign' }

export default async function NewCampaignPage() {
  const { lists, templates } = await getCampaignOptions()

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href="/campaigns"
          className="text-ink-muted hover:text-ink flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Campaigns
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="text-sm font-semibold tracking-tight">New</h1>
      </header>
      <main className="flex-1 p-6">
        <NewCampaignForm lists={lists} templates={templates} />
      </main>
    </>
  )
}
