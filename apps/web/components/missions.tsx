'use client'
// Missions (docs/missions.md), behind the `missions` feature: ongoing work a member delegated to
// a teammate. Missions shows one row per mission (its objective and number, what waits on the
// member, what comes next, what went out last); This week, the agenda across missions: routines'
// runs, wake-ups, planned actions and the drafts to approve before their deadline.
// The API computes both (GET /missions, GET /missions/week).
import type {
  MissionAgendaItem,
  MissionNumber,
  MissionOutput,
  MissionRow,
  MissionWeek,
} from '@brigade/contracts'
import { AlarmClock, CalendarClock, ChevronRight, ExternalLink, Send, Stamp } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { TeammateAvatar, timeAgo } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { shortWakeTime } from '@/components/wakeup-icon'
import { api, useApi } from '@/lib/api'
import { cn } from '@/lib/utils'

/** What changes a mission: its threads, tickets and routines. */
const LIVE = ['thread.updated', 'tickets.updated', 'schedule.updated'] as const

type View = 'missions' | 'week'
const VIEWS: { value: View; label: string }[] = [
  { value: 'missions', label: 'Missions' },
  { value: 'week', label: 'This week' },
]

const number = (value: number, unit: string | null) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}`

/** The number's trend over the last 30 days, with its target as a dashed line. */
function Trend({ series, target }: { series: MissionNumber['series']; target: number | null }) {
  const values = series.map((p) => p.value)
  if (values.length < 2) return null
  const all = target !== null ? [...values, target] : values
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const w = 96
  const h = 28
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4)
  const line = values.map((v, i) => `${(i / (values.length - 1)) * w},${y(v)}`).join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-7 w-24 shrink-0 overflow-visible text-primary"
      aria-label={`Last 30 days: ${values.join(', ')}`}
      role="img"
    >
      {target !== null && (
        <line
          x1={0}
          x2={w}
          y1={y(target)}
          y2={y(target)}
          className="stroke-muted-foreground/50"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function NumberBlock({ n }: { n: MissionNumber }) {
  const latest = n.series.at(-1)
  const first = n.series[0]
  const delta = latest && first && n.series.length > 1 ? latest.value - first.value : null
  return (
    <div className="flex shrink-0 items-center gap-3">
      <Trend series={n.series} target={n.target} />
      <div className="flex flex-col items-end text-right">
        <span className="text-lg leading-tight font-semibold tabular-nums">
          {latest ? number(latest.value, n.unit) : '—'}
        </span>
        <span className="text-xs text-muted-foreground">
          {n.label}
          {delta !== null && delta !== 0 && (
            <span className={delta > 0 ? 'text-success' : 'text-destructive-text'}>
              {' '}
              {delta > 0 ? '+' : ''}
              {number(delta, null)}
            </span>
          )}
          {n.target !== null && <> · target {number(n.target, n.unit)}</>}
        </span>
        {/* Whose word it is: Brigade's measurement, or the teammate's reading. */}
        <span className="text-[11px] text-muted-foreground/80">
          {n.source === 'goal' ? 'Measured by Brigade' : 'As the teammate read it'}
          {latest && <> · {timeAgo(latest.at)}</>}
        </span>
      </div>
    </div>
  )
}

const metricsText = (m: MissionOutput['metrics']) =>
  Object.entries(m)
    .map(([k, v]) => `${number(v, null)} ${k}`)
    .join(' · ')

function OutputLine({ output }: { output: MissionOutput }) {
  const metrics = metricsText(output.metrics)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        <span className="text-muted-foreground">{output.channel} · </span>
        {output.url ? (
          <a
            href={output.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
            title={output.summary}
          >
            {output.summary}
          </a>
        ) : (
          output.summary
        )}
        <span className="text-muted-foreground">
          {' '}
          · {timeAgo(output.at)}
          {metrics && <> · {metrics}</>}
        </span>
      </span>
      {output.url && <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
    </span>
  )
}

/** A draft to approve before its deadline: its text, Approve and Decline, from the ticket. */
function Approval({
  ticketId,
  title,
  draft,
  approveBy,
  threadId,
  onDone,
}: {
  ticketId: string
  title: string
  draft: string | null | undefined
  approveBy: string | null
  threadId: string | null
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (approved: boolean) => {
    setPending(true)
    setError(undefined)
    try {
      await api(`/tickets/${ticketId}/resolve`, { body: { approved } })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 text-left"
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
            aria-hidden
          />
          <span className="truncate">
            Approve &ldquo;{title}&rdquo;
            {approveBy && (
              <span className="text-muted-foreground"> before {shortWakeTime(approveBy)}</span>
            )}
          </span>
        </button>
        <span className="ml-auto flex shrink-0 gap-1.5">
          <Button size="sm" disabled={pending} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void decide(false)}>
            Decline
          </Button>
        </span>
      </div>
      {open && draft && (
        <p className="ml-5 rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {draft}
        </p>
      )}
      {open && threadId && (
        <Link
          href={`/app/threads/${threadId}`}
          className="ml-5 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open its thread to ask for changes
        </Link>
      )}
      {error && <span className="ml-5 text-xs text-destructive-text">{error}</span>}
    </div>
  )
}

const KIND_ICON: Record<MissionAgendaItem['kind'], typeof CalendarClock> = {
  routine: CalendarClock,
  wakeup: AlarmClock,
  action: Send,
  approval: Stamp,
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 text-sm">
      <span className="w-16 shrink-0 text-xs leading-5 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  )
}

function MissionCard({ mission, onChanged }: { mission: MissionRow; onChanged: () => void }) {
  const [outputs, setOutputs] = useState(false)
  const approvals = mission.needs.filter((n) => n.reason === 'approval' && n.ticketId)
  const needs = mission.needs.filter((n) => !(n.reason === 'approval' && n.ticketId))
  const next = mission.next
  const NextIcon = next ? KIND_ICON[next.kind] : null
  return (
    <li className="flex flex-col gap-3 border-t px-4 py-4 first:border-t-0">
      <div className="flex items-start gap-3">
        <TeammateAvatar teammate={mission.teammate} className="mt-0.5 size-7" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{mission.title}</span>
          <span className="line-clamp-2 text-sm text-muted-foreground">{mission.objective}</span>
          <span className="truncate text-xs text-muted-foreground">
            {mission.teammate.name}
            {mission.threads.length > 0 && (
              <>
                {' · '}
                <Link href={`/app/threads/${mission.threads[0]!.id}`} className="hover:underline">
                  {mission.threads.length === 1
                    ? mission.threads[0]!.title
                    : `${mission.threads.length} threads`}
                </Link>
              </>
            )}
            {mission.routines.length > 0 && (
              <>
                {' · '}
                <Link href="/app/routines" className="hover:underline">
                  {mission.routines.length} {mission.routines.length === 1 ? 'routine' : 'routines'}
                </Link>
              </>
            )}
          </span>
        </div>
        {mission.number && <NumberBlock n={mission.number} />}
      </div>

      <div className="flex flex-col gap-2 sm:ml-10">
        {(approvals.length > 0 || needs.length > 0) && (
          <Line label="Needs you">
            {approvals.map((a) => (
              <Approval
                key={a.ticketId}
                ticketId={a.ticketId!}
                title={a.title}
                draft={a.draft}
                approveBy={a.at ?? null}
                threadId={a.threadId}
                onDone={onChanged}
              />
            ))}
            {needs.map((n, i) => (
              <span key={`${n.threadId}-${i}`} className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                {n.threadId ? (
                  <Link href={`/app/threads/${n.threadId}`} className="truncate hover:underline">
                    {n.title}
                  </Link>
                ) : (
                  <span className="truncate">{n.title}</span>
                )}
              </span>
            ))}
          </Line>
        )}
        <Line label="Next">
          {next && NextIcon ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <NextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 tabular-nums">{shortWakeTime(next.at)}</span>
              <span className="truncate text-muted-foreground">{next.title}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Nothing planned</span>
          )}
        </Line>
        <Line label="Last">
          {mission.last?.kind === 'output' ? (
            <OutputLine output={mission.last.output} />
          ) : mission.last?.kind === 'run' ? (
            <Link
              href={`/app/threads/${mission.last.threadId}`}
              className="line-clamp-2 hover:underline"
            >
              {mission.last.summary ?? 'A routine ran'}
              <span className="text-muted-foreground"> · {timeAgo(mission.last.at)}</span>
            </Link>
          ) : (
            <span className="text-muted-foreground">Nothing went out yet</span>
          )}
          {mission.outputs.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setOutputs((o) => !o)}
                aria-expanded={outputs}
                className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
              >
                {outputs ? 'Fewer' : `${mission.outputs.length - 1} more`}
                <ChevronRight
                  className={cn('size-3 transition-transform', outputs && 'rotate-90')}
                  aria-hidden
                />
              </button>
              {outputs && mission.outputs.slice(1).map((o) => <OutputLine key={o.id} output={o} />)}
            </>
          )}
        </Line>
      </div>
    </li>
  )
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The start of the member's day, in their browser's timezone. */
function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function dayLabel(date: Date, today: Date) {
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - today.getTime()) /
      86_400_000,
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`
}

const clock = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

function AgendaRow({
  item,
  mission,
  onChanged,
}: {
  item: MissionAgendaItem
  mission: string | undefined
  onChanged: () => void
}) {
  const Icon = KIND_ICON[item.kind]
  const past = new Date(item.at).getTime() < Date.now()
  const done =
    item.status === 'fired' ||
    item.status === 'declined' ||
    item.status === 'expired' ||
    (past && item.kind !== 'approval')
  const caption = [
    mission,
    item.teammate?.name,
    item.kind === 'action' && item.status === 'awaiting_approval' ? 'waits for approval' : null,
    item.status === 'declined' ? 'declined' : null,
    item.status === 'expired' ? 'not approved in time' : null,
  ].filter(Boolean)
  return (
    <li className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0">
      <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
        {clock(item.at)}
      </span>
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          item.kind === 'approval' ? 'text-warning' : 'text-muted-foreground',
        )}
        aria-hidden
      />
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', done && 'opacity-60')}>
        {item.kind === 'approval' && item.ticketId ? (
          <Approval
            ticketId={item.ticketId}
            title={item.title}
            draft={item.draft}
            approveBy={null}
            threadId={item.threadId}
            onDone={onChanged}
          />
        ) : item.threadId ? (
          <Link href={`/app/threads/${item.threadId}`} className="truncate hover:underline">
            {item.title}
          </Link>
        ) : (
          <span className="truncate">{item.title}</span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {item.kind === 'approval' ? 'Deadline to approve · ' : ''}
          {caption.join(' · ')}
        </span>
      </div>
    </li>
  )
}

function WeekView({ week, onChanged }: { week: MissionWeek; onChanged: () => void }) {
  const titles = new Map(week.missions.map((m) => [m.id, m.title]))
  const days = useMemo(() => {
    const today = startOfToday()
    const groups: { key: string; label: string; items: MissionAgendaItem[] }[] = []
    for (const item of week.items) {
      const date = new Date(item.at)
      const key = date.toDateString()
      const last = groups.at(-1)
      if (last?.key === key) last.items.push(item)
      else groups.push({ key, label: dayLabel(date, today), items: [item] })
    }
    return groups
  }, [week.items])
  if (!days.length)
    return (
      <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing planned this week. Routines, wake-ups and actions your teammates plan for their
        missions show here.
      </p>
    )
  return (
    <>
      {days.map((day) => (
        <section key={day.key} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {day.label}
          </h2>
          <ul className="rounded-xl border bg-card">
            {day.items.map((item) => (
              <AgendaRow
                key={item.key}
                item={item}
                mission={titles.size > 1 ? titles.get(item.missionId) : undefined}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/** The Missions page. */
export function MissionsPage() {
  const [view, setView] = useState<View>('missions')
  const from = useMemo(() => startOfToday().toISOString(), [])
  const missions = useApi<{ missions: MissionRow[] }>('/missions', LIVE)
  const week = useApi<MissionWeek>(`/missions/week?from=${encodeURIComponent(from)}`, LIVE)
  const reload = () => {
    void missions.reload()
    void week.reload()
  }
  const list = missions.data?.missions ?? []
  const error = missions.error ?? week.error

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-extrabold tracking-tight">Missions</h1>
        <p className="max-w-prose text-muted-foreground">
          Ongoing work you delegated: where each mission stands, what comes next and what waits on
          you, without opening its threads.
        </p>
      </header>

      {list.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Missions view"
          className="-mb-2 flex w-fit gap-0.5 rounded-full bg-secondary p-[3px]"
        >
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => setView(v.value)}
              className={cn(
                'flex h-7 items-center rounded-full px-3 text-[13px] font-medium text-muted-foreground',
                view === v.value && 'bg-card font-semibold text-foreground shadow-xs',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {!missions.data ? (
        <Skeleton className="h-32 w-full" />
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No missions yet. A mission gathers the threads and routines of ongoing work a teammate
          owns, such as growing an account, with its plan and what went out.
        </p>
      ) : view === 'week' ? (
        week.data ? (
          <WeekView week={week.data} onChanged={reload} />
        ) : (
          <Skeleton className="h-32 w-full" />
        )
      ) : (
        <ul className="rounded-xl border bg-card">
          {list.map((m) => (
            <MissionCard key={m.id} mission={m} onChanged={reload} />
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-destructive-text">{error.message}</p>}
    </div>
  )
}
