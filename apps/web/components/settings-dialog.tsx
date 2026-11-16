'use client'
// Settings, as a dialog over the page the member is on: its sections in groups beside it, with a
// search over them, and the section on the right, scrolling on its own. Opened from the member's
// menu, ⌘, or a link to a section's address (lib/settings-dialog.ts); Esc or ✕ closes it, back on
// the page as it was. On a phone it takes the whole screen, its sections in a row above.
import {
  BookOpenText,
  Building2,
  ChartColumn,
  CreditCard,
  KeyRound,
  Monitor,
  Plug,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Bell,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { CloseButton } from '@/components/close-button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  clickSettings,
  closeSettings,
  openSettings,
  searchSettings,
  settingsAddress,
  settingsHref,
  SETTINGS_SECTIONS,
  useSettings,
  type SettingsSection,
} from '@/lib/settings-dialog'
import { cn } from '@/lib/utils'

const ICONS: Record<SettingsSection, LucideIcon> = {
  preferences: SlidersHorizontal,
  notifications: Bell,
  accounts: UserRound,
  workspace: Building2,
  members: Users,
  computers: Monitor,
  usage: ChartColumn,
  billing: CreditCard,
  connections: Plug,
  skills: BookOpenText,
  vault: KeyRound,
  security: ShieldCheck,
}

// Each section's code loads as it first opens, not with every page of the app.
const SECTIONS: Record<SettingsSection, ComponentType> = {
  preferences: dynamic(() => import('@/components/settings/preferences')),
  notifications: dynamic(() => import('@/components/settings/notifications')),
  accounts: dynamic(() => import('@/components/settings/accounts')),
  workspace: dynamic(() => import('@/components/settings/workspace')),
  members: dynamic(() => import('@/components/settings/members')),
  computers: dynamic(() => import('@/components/settings/computers')),
  usage: dynamic(() => import('@/components/settings/usage')),
  billing: dynamic(() => import('@/components/settings/billing')),
  connections: dynamic(() => import('@/components/settings/connections')),
  skills: dynamic(() => import('@/components/settings/skills')),
  vault: dynamic(() => import('@/components/settings/vault')),
  security: dynamic(() => import('@/components/settings/security')),
}

const GROUPS = [...new Set(SETTINGS_SECTIONS.map((s) => s.group))]

export function SettingsDialog() {
  const shown = useSettings()
  // While it fades out, the section it showed stays.
  const [last, setLast] = useState(shown)
  if (shown && shown !== last) setLast(shown)
  const section = (shown ?? last)?.section ?? SETTINGS_SECTIONS[0].section
  const Section = SECTIONS[section]
  const [query, setQuery] = useState('')
  useCloseOnNavigation(!!shown)

  return (
    <Dialog open={!!shown} onOpenChange={(open) => !open && closeSettings()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Esc empties the search first.
        onEscapeKeyDown={(e) => {
          if (query && document.activeElement?.closest('[data-settings-search]')) {
            e.preventDefault()
            setQuery('')
          }
        }}
        className={cn(
          'flex gap-0 overflow-hidden p-0',
          // A phone: the whole screen, the sections in a row above.
          'h-dvh max-w-none flex-col rounded-none border-0 sm:max-w-none',
          'md:h-[min(90dvh,52rem)] md:max-w-[calc(100%-4rem)] md:flex-row md:rounded-xl md:border lg:max-w-6xl',
        )}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SettingsNav section={section} query={query} onQuery={setQuery} />
        {/* Its own scroll, back at the top for each section. */}
        <div key={section} className="relative min-w-0 flex-1 overflow-y-auto">
          {/* Room on the right for ✕, above a section's own buttons. */}
          <div className="px-5 pt-5 pb-12 md:pt-8 md:pr-16 md:pl-10">
            <Section />
          </div>
        </div>
        <CloseButton
          label="Close settings"
          title="Close (Esc)"
          onClick={closeSettings}
          className="absolute top-3 right-3 z-10 max-md:top-2.5 max-md:right-2.5"
        />
      </DialogContent>
    </Dialog>
  )
}

/** The sections in their groups, under a search over them: a row on a phone. */
function SettingsNav({
  section,
  query,
  onQuery: setQuery,
}: {
  section: SettingsSection
  query: string
  onQuery: (query: string) => void
}) {
  const search = useRef<HTMLInputElement>(null)
  const found = searchSettings(query)

  // `/` goes to the search, unless the member is typing somewhere.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const at = document.activeElement
      if (
        at instanceof HTMLInputElement ||
        at instanceof HTMLTextAreaElement ||
        at instanceof HTMLSelectElement ||
        (at instanceof HTMLElement && at.isContentEditable)
      )
        return
      e.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <nav
      aria-label="Settings"
      className="flex shrink-0 flex-col border-b bg-sidebar max-md:pr-14 md:w-60 md:border-r md:border-b-0"
    >
      <div className="hidden p-3 pb-2 md:block">
        <label
          data-settings-search
          className="flex h-9 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm focus-within:border-ring"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter opens the first found.
              if (e.key === 'Enter' && found[0]) {
                e.preventDefault()
                openSettings(settingsHref(found[0].section))
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          {!query && (
            <kbd className="rounded border px-1 font-mono text-[0.6875rem] text-muted-foreground">
              /
            </kbd>
          )}
        </label>
      </div>
      <div className="flex gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] md:flex-1 md:flex-col md:gap-4 md:overflow-y-auto md:px-3 md:pt-1 md:pb-3">
        {GROUPS.map((group) => {
          const items = found.filter((s) => s.group === group)
          if (!items.length) return null
          return (
            <div key={group} className="contents md:block">
              <p className="mb-1 hidden px-2.5 text-xs text-muted-foreground md:block">{group}</p>
              <ul className="contents md:flex md:flex-col md:gap-0.5">
                {items.map((s) => {
                  const Icon = ICONS[s.section]
                  const href = settingsHref(s.section)
                  const active = s.section === section
                  return (
                    <li key={s.section}>
                      <a
                        href={href}
                        onClick={(e) => clickSettings(e, href)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0',
                          active
                            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                        )}
                      >
                        <Icon aria-hidden />
                        {s.label}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
        {!found.length && (
          <p className="px-2.5 py-1.5 text-sm text-muted-foreground">No setting found.</p>
        )}
      </div>
    </nav>
  )
}

/**
 * Settings close once the app moves to another page (a thread or a page a section links to):
 * not on leaving a section's own address, which opened them over Today (SettingsAddress).
 */
function useCloseOnNavigation(open: boolean) {
  const pathname = usePathname()
  const seen = useRef(pathname)
  useEffect(() => {
    const was = seen.current
    seen.current = pathname
    if (!open || was === pathname || settingsAddress(was)) return
    closeSettings()
  }, [pathname, open])
}

/**
 * A section's address loaded on its own (a new tab, a provider's or Stripe's redirect, Brigade.app's
 * menu, an email): Settings open on it, over Today, with what its address had after `?`.
 */
export function SettingsAddress() {
  const router = useRouter()
  useEffect(() => {
    openSettings(location.pathname + location.search)
    router.replace('/app')
  }, [router])
  return null
}
