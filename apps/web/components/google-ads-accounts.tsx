'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { api, useApi, type Connection, type GoogleAdsCustomer } from '@/lib/api'

/** 1234567890 as Google Ads shows it. */
const dashed = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3')

/** The Google Ads accounts a connection's teammates reach, as a line under its row. */
export function GoogleAdsPicked({
  connection,
  onPick,
}: {
  connection: Connection
  /** Open the picker; absent for someone who cannot change it. */
  onPick?: () => void
}) {
  const picked = connection.settings?.customers ?? []
  if (picked.length)
    return (
      <p className="line-clamp-2 text-xs text-muted-foreground">
        Ads accounts: {picked.map((c) => c.name ?? dashed(c.id)).join(', ')}
      </p>
    )
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">Teammates reach no Ads account until one is picked.</span>
      {onPick && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={onPick}>
          Pick accounts
        </Button>
      )}
    </div>
  )
}

/**
 * Pick the Google Ads accounts teammates reach through a Google sign-in: every account it reaches,
 * directly or through a manager account. Manager accounts hold no campaigns, so they are not picked.
 */
export function GoogleAdsAccounts({
  connection,
  reload,
  onDone,
}: {
  connection: Connection
  reload: () => Promise<unknown>
  onDone: () => void
}) {
  const list = useApi<{
    customers: GoogleAdsCustomer[]
    failed: { id: string; error: string }[]
    picked: string[]
  }>(`/connections/${connection.id}/google-ads/customers`)
  const [picked, setPicked] = useState<Set<string>>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (list.data && !picked) setPicked(new Set(list.data.picked))
  }, [list.data, picked])

  if (list.error) return <p className="text-sm text-destructive-text">{list.error.message}</p>
  if (!list.data || !picked) return <p className="text-sm text-muted-foreground">Loading…</p>
  const choosable = list.data.customers.filter((c) => !c.manager)

  async function save() {
    setSaving(true)
    setError(undefined)
    try {
      await api(`/connections/${connection.id}/google-ads/customers`, {
        method: 'PUT',
        body: { ids: [...picked!] },
      })
      await reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col divide-y rounded-lg border bg-card">
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Teammates read and change only the accounts picked here. Each change still asks first, as
          its teammate&apos;s access says.
        </p>
        {choosable.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            This Google account reaches no Google Ads account with campaigns.
          </p>
        )}
        {choosable.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <Checkbox
              checked={picked.has(c.id)}
              disabled={!picked.has(c.id) && c.status !== undefined && c.status !== 'ENABLED'}
              onCheckedChange={(on) => {
                const next = new Set(picked)
                if (on) next.add(c.id)
                else next.delete(c.id)
                setPicked(next)
              }}
            />
            <span className="min-w-0 flex-1 truncate">{c.name ?? dashed(c.id)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {dashed(c.id)}
              {c.managerName ? ` · via ${c.managerName}` : ''}
              {c.status && c.status !== 'ENABLED' ? ` · ${c.status.toLowerCase()}` : ''}
            </span>
          </label>
        ))}
        {list.data.failed.map((f) => (
          <p key={f.id} className="px-3 py-2 text-xs text-muted-foreground">
            {dashed(f.id)} could not be read: {f.error}
          </p>
        ))}
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
