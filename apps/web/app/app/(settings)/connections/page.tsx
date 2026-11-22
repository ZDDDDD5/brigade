'use client'
// Settings is a dialog: this section's address opens it over Today (components/settings-dialog.tsx).
// The sign-in tab's last page (?popup=1) stays a page of its own, which closes the tab.
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { SettingsAddress } from '@/components/settings-dialog'
import { SignedIn } from '@/components/settings/connections'

export default function AppsAddress() {
  return (
    <Suspense>
      <Address />
    </Suspense>
  )
}

function Address() {
  const params = useSearchParams()
  // Back from a provider in the sign-in tab: the page that opened it shows the account.
  if (params.get('popup'))
    return (
      <SignedIn
        connected={params.get('connected')}
        error={params.get('error')}
        desktop={params.get('desktop')}
      />
    )
  return <SettingsAddress />
}
