'use client'

import { Database, Globe, KeyRound, Lock } from 'lucide-react'
import { Details, Raw } from '@/components/email-cards'
import { useApi, type Credential, type CredentialKind } from '@/lib/api'

const KIND: Record<CredentialKind, { label: string; icon: typeof Globe }> = {
  website: { label: 'Website login', icon: Globe },
  database: { label: 'Database', icon: Database },
  api_key: { label: 'API key', icon: KeyRound },
  other: { label: 'Secret', icon: Lock },
}

/** The credential asked for, as people know it: its name and kind, the why under it. */
export function CredentialAskPreview({
  credentialId,
  purpose,
  input,
}: {
  credentialId: string
  purpose?: string
  input: unknown
}) {
  const credentials = useApi<Credential[]>('/credentials')
  const credential = credentials.data?.find((c) => c.id === credentialId)
  const kind = credential ? KIND[credential.kind] : undefined
  const Icon = kind?.icon ?? KeyRound
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted px-3 py-2.5">
        <span className="flex size-8 flex-none items-center justify-center rounded-md bg-background">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {credential?.name ?? (credentials.data ? 'A credential from the vault' : ' ')}
          </span>
          {kind && <span className="text-xs text-muted-foreground">{kind.label}</span>}
        </div>
      </div>
      {purpose && <p className="text-sm text-muted-foreground">{purpose}</p>}
      <Details label="Raw arguments">
        <Raw value={input} />
      </Details>
    </div>
  )
}
