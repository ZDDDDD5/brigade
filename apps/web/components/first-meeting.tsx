'use client'
// A teammate's first meeting with the member: before its first thread, it speaks first. A
// greeting, a few jobs to start with (a pick sends it as the thread's first message), and what
// helps it work (Apps, and Brigade Cloud for a workspace without it). Written here, from its
// name and role: no model runs for it, and no thread exists until the member sends something.
import type { BillingResponse } from '@brigade/contracts'
import { Cloud, Plug } from 'lucide-react'
import { useState } from 'react'
import { openConnectApps } from '@/components/connect-apps'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { subscribeToCloud, useApi, type Teammate } from '@/lib/api'

/** Jobs to start with, by what the teammate's role says it does; the first match wins. */
const BY_ROLE: { match: RegExp; jobs: string[] }[] = [
  {
    match: /engineer|develop|code|coding|software|programm|devops|\bqa\b/i,
    jobs: ['Fix a bug in my app', 'Review my latest pull request', 'Build a small feature'],
  },
  {
    match: /support|customer|help ?desk|success/i,
    jobs: ['Answer my support inbox', 'Draft replies to open tickets', 'Write a help article'],
  },
  {
    match: /seo|search engine/i,
    jobs: [
      'Audit my site’s SEO',
      'Find keywords I should rank for',
      'Write an article for my blog',
    ],
  },
  {
    match: /market|growth|social|content|brand|copy|writer/i,
    jobs: ['Write a post about my product', 'Plan this week’s content', 'Look at my site’s copy'],
  },
  {
    match: /sales|outreach|lead|prospect|business dev/i,
    jobs: ['Find 10 leads for my product', 'Draft a cold email', 'Follow up with my leads'],
  },
  {
    match: /design|ui|ux/i,
    jobs: ['Design a landing page', 'Review my app’s screens', 'Make a mockup of an idea'],
  },
  {
    match: /research|analy|data/i,
    jobs: [
      'Research my competitors',
      'Dig into a question for me',
      'Summarize what’s new in my field',
    ],
  },
]

const GENERIC = [
  'Tell me what you can do for me',
  'Look at my website and suggest work',
  'Research something for me',
]

const CHIEF = ['Set up my team', 'Look at my website and suggest what to hand off', 'Plan my week']

/** What the teammate says first, and the jobs it offers. */
export function firstWords(teammate: Pick<Teammate, 'name' | 'title' | 'kind' | 'instructions'>) {
  if (teammate.kind === 'chief')
    return {
      greeting: `Hi! I’m ${teammate.name}. I run your team: tell me what you’re working on and I’ll hand it to the right teammate, or set one up.`,
      jobs: CHIEF,
    }
  const role = teammate.title.trim()
  return {
    greeting: `Hi! I’m ${teammate.name}${role ? `, your ${role.toLowerCase()}` : ''}. Hand me one real job and I’ll get it done.`,
    jobs: BY_ROLE.find((r) => r.match.test(`${role} ${teammate.instructions}`))?.jobs ?? GENERIC,
  }
}

const LETTERS = 'ABCD'

export function FirstMeeting({
  teammate,
  onPick,
  onSomethingElse,
}: {
  teammate: Teammate
  /** A job picked: sent as the thread's first message. */
  onPick: (text: string) => void
  /** Something else: the member writes their own. */
  onSomethingElse: () => void
}) {
  const { me } = useDashboard()
  const billing = useApi<BillingResponse>('/billing')
  const [busy, setBusy] = useState(false)
  const { greeting, jobs } = firstWords(teammate)
  // Cloud only where it is offered and not had, to whoever may subscribe.
  const offerCloud = isAdmin(me) && billing.data?.enabled && !billing.data.plan?.active

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-end gap-2">
        <TeammateAvatar teammate={teammate} className="size-7 shrink-0" />
        <p className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">{greeting}</p>
      </div>
      <div className="ml-9 flex flex-col gap-1 rounded-2xl bg-muted p-3">
        <p className="px-1 pb-1 text-sm font-semibold">What should we start with?</p>
        {[...jobs, 'Something else'].map((job, i) => {
          const other = i === jobs.length
          return (
            <button
              key={job}
              type="button"
              onClick={() => (other ? onSomethingElse() : onPick(job))}
              className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 text-left text-sm outline-none hover:bg-background/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-[11px] text-muted-foreground"
              >
                {LETTERS[i]}
              </span>
              <span className={other ? 'text-muted-foreground' : undefined}>{job}</span>
            </button>
          )
        })}
      </div>
      <div className="ml-9 flex flex-wrap gap-2">
        <Chip onClick={openConnectApps}>
          <Plug aria-hidden />
          Connect apps
        </Chip>
        {offerCloud && (
          <Chip
            disabled={busy}
            onClick={() => {
              setBusy(true)
              subscribeToCloud('billing', 'starter')
                .catch(() => undefined)
                .finally(() => setBusy(false))
            }}
          >
            <Cloud aria-hidden />
            Keep {teammate.name} working · Cloud
          </Chip>
        )}
      </div>
    </div>
  )
}

function Chip({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium outline-none hover:bg-muted/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:text-muted-foreground"
    >
      {children}
    </button>
  )
}
