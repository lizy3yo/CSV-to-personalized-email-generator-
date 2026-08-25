import { redirect } from 'next/navigation'

export default function RootPage() {
  // proxy.ts sends unauthenticated visitors to /login.
  redirect('/campaigns')
}
