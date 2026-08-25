import { redirect } from 'next/navigation'

export default function SettingsPage() {
  // AI is the only settings section so far; Gmail and compliance arrive in
  // phases 6 and 7.
  redirect('/settings/ai')
}
