'use client'
// A teammate's first meeting with the member: before its first thread, it speaks first. A
// greeting, a few jobs to start with or one written in Something else (sent at once as the
// thread's first message), and what helps it work (Apps, its role). Written here, from its
// name and role: no model runs for it, and no thread exists until the member sends something.
// Chief in a workspace with no team yet asks for one thing instead, the person's website or
// repository (or a line on what they build), which its first reply turns into a first job done
// and a proposed team: where onboarding ends (app/onboarding/page.tsx).
import { chiefFirstMessage } from '@brigade/contracts'
import { ArrowUp, Plug, SlidersHorizontal } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { openConnectApps } from '@/components/connect-apps'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import type { Teammate } from '@/lib/api'
import { cn } from '@/lib/utils'

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

/** What Chief says first in a workspace with no team yet: one thing to send, no questions. */
const SETUP_GREETING = (name: string) =>
  `Hi! I’m ${name}. I run your team. Send me your website or repo: I’ll read it, do a first small job for you, and suggest who should be on your team.`

/** Chief's third choice before there is a team: one click, nothing to write. */
const STARTER_TEAM = 'Just suggest a starter team'

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

/** A row of the card: its letter, then what it holds. Rounded like the card, not a pill. */
const ROW =
  'flex w-full items-center gap-3 rounded-[12px] px-2 py-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

function Letter({ children }: { children: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-background/70 text-xs font-medium text-muted-foreground"
    >
      {children}
    </span>
  )
}

export function FirstMeeting({
  teammate,
  onSend,
}: {
  teammate: Teammate
  /**
   * A job picked, or one written in Something else: sent at once as the thread's first message.
   * Why it could not be, when it could not.
   */
  onSend: (text: string) => string | undefined
}) {
  const { me, teammates } = useDashboard()
  // Chief before there is a team: the setup thread starts from the person's website.
  const setup = teammate.kind === 'chief' && !teammates.some((t) => t.kind !== 'chief')
  const { greeting, jobs } = firstWords(teammate)
  const [problem, setProblem] = useState<string>()
  const send = (text: string) =>
    setProblem(onSend(setup ? chiefFirstMessage(text, me.onboardingAnswers) : text))

  return (
    // Two bubbles in a row from the teammate read as one group, as Midnight draws them: round
    // corners outside, small ones where they meet, a few pixels apart.
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <TeammateAvatar teammate={teammate} className="size-7 shrink-0" />
        <p className="rounded-[1.3rem] rounded-bl-[0.45rem] bg-muted px-4 py-2.5 text-sm">
          {setup ? SETUP_GREETING(teammate.name) : greeting}
        </p>
      </div>
      <div className="ml-9 flex flex-col gap-0.5 rounded-[1.3rem] rounded-tl-[0.45rem] bg-muted p-2">
        <p className="px-2 pt-1.5 pb-2 text-sm font-semibold">
          {setup ? 'Where can I look?' : 'What should we start with?'}
        </p>
        {setup ? (
          <>
            <WriteRow
              letter="A"
              placeholder="yoursite.com or github.com/you/app"
              label="Your website or repository"
              onSend={send}
            />
            <WriteRow
              letter="B"
              placeholder="No site yet? Tell me what you’re building"
              label="What you are building"
              onSend={send}
            />
            {/* Nothing to write: a starter team from what onboarding's questions kept. */}
            <button
              type="button"
              onClick={() => send(STARTER_TEAM)}
              className={cn(ROW, 'hover:bg-background/50')}
            >
              <Letter>C</Letter>
              {STARTER_TEAM}
            </button>
          </>
        ) : (
          <>
            {jobs.map((job, i) => (
              <button
                key={job}
                type="button"
                onClick={() => send(job)}
                className={cn(ROW, 'hover:bg-background/50')}
              >
                <Letter>{LETTERS[i]!}</Letter>
                {job}
              </button>
            ))}
            <WriteRow
              letter={LETTERS[jobs.length]!}
              placeholder="Something else"
              label="Something else"
              onSend={send}
            />
          </>
        )}
      </div>
      {problem && <p className="mt-1.5 ml-9 px-1 text-sm text-destructive-text">{problem}</p>}
      <div className="mt-2 ml-9 flex flex-wrap gap-2">
        <Chip onClick={openConnectApps}>
          <Plug aria-hidden />
          Connect apps
        </Chip>
        {/* Its role and instructions, where an owner or admin shapes what it does. Not while
            Chief sets up the team: one thing to do there. */}
        {isAdmin(me) && !setup && (
          <Chip href={`/app/teammates/${teammate.id}`}>
            <SlidersHorizontal aria-hidden />
            Shape {teammate.name}’s role
          </Chip>
        )}
      </div>
    </div>
  )
}

/** A row written in: sent as a job is, with its arrow once something is written. */
function WriteRow({
  letter,
  placeholder,
  label,
  onSend,
}: {
  letter: string
  placeholder: string
  label: string
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  return (
    <form
      className={cn(ROW, 'py-1.5 focus-within:bg-background/50 hover:bg-background/50')}
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) onSend(text.trim())
      }}
    >
      <Letter>{letter}</Letter>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      {text.trim() && (
        <button
          type="submit"
          aria-label="Send"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      )}
    </form>
  )
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium outline-none hover:bg-muted/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5 [&_svg]:text-muted-foreground'

function Chip({
  onClick,
  href,
  children,
}: {
  onClick?: () => void
  href?: string
  children: React.ReactNode
}) {
  if (href)
    return (
      <Link href={href} className={CHIP}>
        {children}
      </Link>
    )
  return (
    <button type="button" onClick={onClick} className={CHIP}>
      {children}
    </button>
  )
}
