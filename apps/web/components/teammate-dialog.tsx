'use client'
// A teammate's settings in a dialog over the page the member is on (lib/teammate-dialog.ts): its
// profile, what it may reach, what it is up to and its limits. Its threads are where the sidebar
// takes you (components/thread-panel.tsx). The form for a new teammate opens in it too.
import { modelLabel } from '@brigade/contracts'
import { Archive } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { TeammateAccess } from '@/components/teammate-access'
import { TeammateForm } from '@/components/teammate-form'
import { TeammateTitle } from '@/components/teammate-title'
import { TeammateCaps, TeammateStatus, useTeammateTimeline } from '@/components/teammate-oversight'
import { useThreadPanel } from '@/components/thread-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, harnessLabel, type Teammate } from '@/lib/api'
import {
  closeTeammate,
  hostTeammate,
  NEW_TEAMMATE,
  TEAMMATE_CREATED,
  openTeammate,
  setTeammateTab,
  showTeammate,
  teammateAddress,
  useTeammateDialog,
  type TeammateTab,
} from '@/lib/teammate-dialog'

/**
 * The dialog, mounted once in the dashboard. A plain click on a link to a teammate's address
 * (/app/teammates/<id>) anywhere in the app opens it here instead of going there.
 */
export function TeammateDialog() {
  const shown = useTeammateDialog()
  const { teammates } = useDashboard()
  const creating = shown?.id === NEW_TEAMMATE
  const teammate = shown && !creating && teammates.find((t) => t.id === shown.id)
  useEffect(() => hostTeammate(), [])
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return
      const link = (e.target as Element | null)?.closest?.('a[href]')
      if (!link || link.getAttribute('target') === '_blank') return
      const at = teammateAddress(link.getAttribute('href') ?? '')
      if (!at || !openTeammate(at.id, at.tab)) return
      e.preventDefault()
      e.stopPropagation()
    }
    // Before the links' own handlers (Next's Link), which would go to the address.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return (
    <Dialog open={!!shown} onOpenChange={(open) => !open && closeTeammate()}>
      <DialogContent className="flex max-h-[min(52rem,calc(100svh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">
          {creating
            ? 'New AI teammate'
            : teammate
              ? `${teammate.name}’s settings`
              : 'Teammate settings'}
        </DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-8 md:px-8">
          {creating ? (
            <NewTeammate />
          ) : (
            shown && (
              <TeammateSettings
                key={shown.id}
                id={shown.id}
                tab={shown.tab}
                onTab={setTeammateTab}
                onArchived={closeTeammate}
              />
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The form for a new teammate. Once made, the dialog closes on a new thread with it, where it
 * speaks first (components/first-meeting.tsx), and the sidebar narrows its threads to it.
 */
function NewTeammate() {
  const { reloadTeammates } = useDashboard()
  const { openTeammate } = useThreadPanel()
  return (
    <div className="flex flex-col gap-7">
      <h1 className="text-3xl font-extrabold tracking-tight">New AI teammate</h1>
      <TeammateForm
        submitLabel="Create teammate"
        onSubmit={async (input) => {
          const teammate = await api<Teammate>('/teammates', { body: input })
          // In the list first: the thread panel picks it from there.
          await reloadTeammates()
          closeTeammate()
          openTeammate(teammate.id)
          window.dispatchEvent(new CustomEvent(TEAMMATE_CREATED, { detail: teammate.id }))
        }}
      />
    </div>
  )
}

/**
 * A teammate's address loaded on its own (a new tab, an email, a page that goes there): its
 * settings open over Today.
 */
export function TeammateAddress() {
  const router = useRouter()
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    showTeammate(location.pathname + location.search)
    router.replace('/app')
  }, [router])
  return null
}

/** A teammate's settings: who it is, what it may reach and spend, and what it is up to. */
export function TeammateSettings({
  id,
  tab: asked,
  onTab,
  onArchived,
}: {
  id: string
  tab: TeammateTab | null
  onTab: (tab: TeammateTab) => void
  onArchived: () => void
}) {
  const { me, teammates, reloadTeammates } = useDashboard()
  const teammate = teammates.find((t) => t.id === id)
  const oversight = useTeammateTimeline(id)

  // Profile is for admins only.
  const tabs: TeammateTab[] = isAdmin(me)
    ? ['profile', 'access', 'activity', 'limits']
    : ['access', 'activity', 'limits']
  const tab = asked && tabs.includes(asked) ? asked : tabs[0]!

  if (!teammate) return <p className="text-sm text-muted-foreground">Loading…</p>

  async function archive() {
    if (!confirm(`Archive ${teammate!.name}? Its threads stay in the run log.`)) return
    await api(`/teammates/${id}`, { method: 'DELETE' })
    await reloadTeammates()
    onArchived()
  }

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-center gap-4">
        <TeammateAvatar teammate={teammate} className="size-16 text-2xl" />
        <div className="flex flex-[1_1_16rem] flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <h1 className="text-3xl font-extrabold tracking-tight">{teammate.name}</h1>
            <TeammateTitle title={teammate.title} />
            <Badge
              className={
                teammate.harness === 'codex'
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-primary/15 text-primary'
              }
            >
              {harnessLabel(teammate.harness)} · {modelLabel(teammate.harness, teammate.model)}
            </Badge>
          </div>
          {!isAdmin(me) && teammate.instructions && (
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">
              {teammate.instructions}
            </p>
          )}
        </div>
      </header>
      <Tabs value={tab} onValueChange={(next) => onTab(next as TeammateTab)} className="gap-5">
        <TabsList variant="line" className="border-b w-full justify-start rounded-none">
          {isAdmin(me) && (
            <TabsTrigger value="profile" className="flex-none">
              Profile
            </TabsTrigger>
          )}
          <TabsTrigger value="access" className="flex-none">
            Access
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-none">
            Activity
          </TabsTrigger>
          <TabsTrigger value="limits" className="flex-none">
            Limits
          </TabsTrigger>
        </TabsList>

        <div>
          {isAdmin(me) && (
            // Kept mounted so unsaved edits survive a look at another tab.
            <TabsContent value="profile" forceMount className="data-[state=inactive]:hidden">
              <TeammateForm
                initial={teammate}
                submitLabel="Save"
                onSubmit={async (input) => {
                  await api(`/teammates/${id}`, { method: 'PATCH', body: input })
                  await reloadTeammates()
                }}
                footer={
                  teammate.kind !== 'chief' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-ml-2 text-destructive-text hover:text-destructive-text"
                      onClick={archive}
                    >
                      <Archive aria-hidden />
                      Archive
                    </Button>
                  )
                }
              />
            </TabsContent>
          )}

          <TabsContent value="access">
            <TeammateAccess
              teammate={teammate}
              editable={isAdmin(me)}
              onPolicyChange={() => void reloadTeammates()}
            />
          </TabsContent>

          <TabsContent value="activity">
            <TeammateStatus {...oversight} />
          </TabsContent>

          <TabsContent value="limits">
            <TeammateCaps
              teammate={teammate}
              usage={oversight.timeline.data?.usage}
              editable={isAdmin(me)}
              onSaved={() => {
                void reloadTeammates()
                oversight.refresh()
              }}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
