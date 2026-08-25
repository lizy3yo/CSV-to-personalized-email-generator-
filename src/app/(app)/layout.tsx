import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FileSpreadsheet, LayoutList, Settings, ShieldBan, Mail } from 'lucide-react'
import { getCurrentUser } from '@/lib/supabase/server'
import { signOut } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'

const NAV = [
  { href: '/campaigns', label: 'Campaigns', icon: LayoutList },
  { href: '/contacts', label: 'Contacts', icon: FileSpreadsheet },
  { href: '/templates', label: 'Templates', icon: Mail },
  { href: '/suppressions', label: 'Suppressions', icon: ShieldBan },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  // proxy.ts already gates this route; the check here is defence in depth so a
  // matcher change can never silently expose the authenticated area.
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  return (
    <div className="flex min-h-dvh">
      <aside className="border-border bg-surface hidden w-60 shrink-0 flex-col border-r md:flex">
        <div className="border-border flex h-14 items-center gap-2 border-b px-5">
          <span className="text-sm font-semibold tracking-tight">CSV → Email</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="text-ink-muted hover:bg-surface-muted hover:text-ink flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="border-border border-t p-3">
          <p className="text-ink-subtle truncate px-3 pb-2 text-xs" title={user.email ?? ''}>
            {user.email}
          </p>
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}
