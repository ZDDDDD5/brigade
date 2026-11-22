'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { api, useApi, type Connection, type MetaAdAccount } from '@/lib/api'

/** The Meta ad accounts a connection's teammates reach, as a line under its row. */
export function MetaAdsPicked({
  connection,
  onPick,
}: {
  connection: Connection
  /** Open the picker; absent for someone who cannot change it. */
  onPick?: () => void
}) {
  const picked = connection.settings?.accounts ?? []
  if (picked.length)
    return (
      <p className="line-clamp-2 text-xs text-muted-foreground">
        Ad accounts: {picked.map((a) => a.name ?? a.id).join(', ')}
      </p>
    )
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">Teammates reach no ad account until one is picked.</span>
      {onPick && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={onPick}>
          Pick accounts
        </Button>
      )}
    </div>
  )
}

/**
 * Pick the Meta ad accounts teammates reach through a Facebook sign-in: its own, and those of the
 * businesses it works in.
 */
export function MetaAdAccounts({
  connection,
  reload,
  onDone,
}: {
  connection: Connection
  reload: () => Promise<unknown>
  onDone: () => void
}) {
  const list = useApi<{ accounts: MetaAdAccount[]; picked: string[] }>(
    `/connections/${connection.id}/meta-ads/accounts`,
  )
  const [picked, setPicked] = useState<Set<string>>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (list.data && !picked) setPicked(new Set(list.data.picked))
  }, [list.data, picked])

  if (list.error) return <p className="text-sm text-destructive-text">{list.error.message}</p>
  if (!list.data || !picked) return <p className="text-sm text-muted-foreground">Loading…</p>
  const { accounts } = list.data

  async function save() {
    setSaving(true)
    setError(undefined)
    try {
      await api(`/connections/${connection.id}/meta-ads/accounts`, {
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
          Teammates read and change only the ad accounts picked here. Each change still asks first,
          as its teammate&apos;s access says.
        </p>
        {accounts.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            This Facebook account reaches no ad account.
          </p>
        )}
        {accounts.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <Checkbox
              checked={picked.has(a.id)}
              onCheckedChange={(on) => {
                const next = new Set(picked)
                if (on) next.add(a.id)
                else next.delete(a.id)
                setPicked(next)
              }}
            />
            <span className="min-w-0 flex-1 truncate">{a.name ?? a.id}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {a.id.replace(/^act_/, '')}
              {a.business ? ` · ${a.business}` : ''}
              {a.status && a.status !== 'ACTIVE'
                ? ` · ${a.status.toLowerCase().replaceAll('_', ' ')}`
                : ''}
            </span>
          </label>
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
